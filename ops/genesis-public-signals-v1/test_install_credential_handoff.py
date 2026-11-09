#!/usr/bin/env python3
"""Offline safety and rollback checks for Genesis credential handoff."""
import importlib.util
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location(
    "credential_handoff_installer", Path(__file__).with_name("install_credential_handoff.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class CredentialHandoffTests(TestCase):
    def test_dropin_is_not_publication(self):
        unit = mod.OVERRIDE_CONTENT
        self.assertIn("[Service]", unit)
        self.assertIn("ExecStart=\n", unit)
        self.assertIn("credential_reader.py", unit)
        self.assertIn("LoadCredential=genesis-signal-snapshot:/var/lib/tkempire-genesis-signals-staging/unapproved-projection.json", unit)
        self.assertNotIn("GENESIS_SIGNALS_PUBLISH_ENABLED=true", unit)
        self.assertNotIn("Environment=GENESIS_SIGNALS_PUBLISH_ENABLED=true", unit)

    def test_source_is_pinned(self):
        self.assertEqual(len(mod.READER_BLOB), 40)
        self.assertEqual(len(mod.SNAPSHOT_SHA256), 64)
        self.assertEqual(len(mod.UNIT_SHA256), 64)
        self.assertEqual(len(mod.NGINX_SHA256), 64)
        self.assertEqual(mod.READER_REF, "eb48c649ffaebf65fee25fa9152c6a4a461f9c64")

    def test_boundaries_are_local_and_staging_only(self):
        self.assertEqual(mod.UNIT_NAME, "genesis-public-signals-staging.service")
        self.assertEqual(mod.OVERRIDE.name, "20-private-snapshot.conf")
        self.assertEqual(mod.SNAPSHOT_DIR.as_posix(), "/var/lib/tkempire-genesis-signals-staging")

    def test_disabled_route_rejects_nonempty_signal_records(self):
        with patch.object(mod, "probe", return_value=(
            503, b'{"status":"publication_disabled","signals":[{"id":"secret"}]}'
        )):
            with self.assertRaises(RuntimeError):
                mod.check_disabled_route()

    def test_disabled_route_requires_503(self):
        with patch.object(mod, "probe", return_value=(
            200, b'{"status":"ok","signals":[]}'
        )):
            with self.assertRaises(RuntimeError):
                mod.check_disabled_route()

    def test_good_legacy_disabled_route_in_preflight(self):
        with patch.object(mod, "probe", return_value=(
            503, b'{"status":"publication_disabled"}'
        )):
            mod.check_disabled_route()

    def test_strict_disabled_route_after_install(self):
        with patch.object(mod, "probe", return_value=(
            503, b'{"schema_version":1,"status":"publication_disabled","signals":[]}'
        )):
            mod.check_disabled_route(post_install=True)

    def test_post_install_rejects_legacy_schema(self):
        with patch.object(mod, "probe", return_value=(
            503, b'{"status":"publication_disabled"}'
        )):
            with self.assertRaises(RuntimeError):
                mod.check_disabled_route(post_install=True)

    def test_preflight_rejects_extra_fields(self):
        with patch.object(mod, "probe", return_value=(
            503, b'{"status":"publication_disabled","signals":[]}'
        )):
            with self.assertRaises(RuntimeError):
                mod.check_disabled_route()


if __name__ == "__main__":
    main()
