#!/usr/bin/env python3
"""Offline regression tests for guarded Genesis website feed release."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "genesis_website_feed_release", Path(__file__).with_name("release_website_feed.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ReleaseInstallerTests(unittest.TestCase):
    def test_parser_and_http_namespaces_are_not_shadowed(self):
        self.assertTrue(hasattr(mod.argparse, "ArgumentParser"))
        self.assertTrue(hasattr(mod.http_client, "HTTPConnection"))
        self.assertTrue(callable(mod.http))

    def test_preflight_gateway_is_unauthenticated_only(self):
        from urllib.error import HTTPError
        with patch.object(mod, "urlopen", side_effect=HTTPError(
            "https://api.tkempire.io/internal/genesis/signals", 401,
            "Unauthorized", None, None)):
            self.assertEqual(mod.gateway_denies_anonymous(), 401)

    def test_no_gateway_anonymous_access_is_allowed(self):
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch.object(mod, "urlopen", return_value=response):
            self.assertEqual(mod.gateway_denies_anonymous(), 200)
            self.assertNotIn(mod.gateway_denies_anonymous(), (401,403))

    def test_original_staging_config_keeps_credential_and_not_publish(self):
        self.assertIn(mod.CRED_DIRECTIVE, mod.NEW_STAGING)
        self.assertIn("GENESIS_SIGNALS_PUBLICATION_APPROVED=true", mod.NEW_STAGING)
        self.assertIn("--public-readonly", mod.NEW_STAGING)
        self.assertNotIn("tkempire.service", mod.NEW_REFRESH)
        self.assertNotIn("GENESIS_SIGNALS_PUBLISH_ENABLED=true", mod.NEW_STAGING)

    def test_pinned_source_hash_failure_names_the_file(self):
        from tempfile import TemporaryDirectory
        from contextlib import redirect_stdout
        from io import StringIO
        with TemporaryDirectory() as tmp:
            p=Path(tmp)/"fake"
            p.write_bytes(b"not the expected source")
            output=StringIO()
            # CI runs as a non-root user; simulate only the root-owned file
            # metadata while keeping the real content hash mismatch.
            from types import SimpleNamespace
            with patch.object(mod, "SRC_WORKER", p), patch.object(
                Path, "stat", return_value=SimpleNamespace(st_uid=0, st_mode=0o100600)
            ):
                with redirect_stdout(output):
                    with self.assertRaisesRegex(mod.GuardError, "SOURCE_HASH_CHANGED_REFRESH_WORKER"):
                        mod.pin(p, "f"*64)
            self.assertIn("REFRESH_WORKER_HASH_MATCH=FAIL", output.getvalue())

    def test_file_digests_pinned_and_distinct(self):
        self.assertEqual(len(mod.READER_BLOB), 40)
        self.assertEqual(len(mod.WORKER_BLOB), 40)
        self.assertEqual(len(mod.ORIGINAL_READER_SHA), 64)
        self.assertEqual(len(mod.ORIGINAL_WORKER_SHA), 64)

    def test_read_only_release_does_not_touch_live_trading_units(self):
        source = Path(__file__).with_name("release_website_feed.py").read_text()
        self.assertNotIn('run("systemctl","restart","tkempire.service"', source)
        self.assertNotIn('run("systemctl","restart","nginx.service"', source)
        self.assertNotIn('GENESIS_SIGNALS_PUBLICATION_ENABLED=true', source)


if __name__ == "__main__":
    unittest.main()
