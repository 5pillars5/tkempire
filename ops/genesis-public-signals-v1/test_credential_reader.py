#!/usr/bin/env python3
"""Offline tests for disabled credential-only signal reader."""
import importlib.util
from pathlib import Path
import json
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

script = Path(__file__).with_name("credential_reader.py")
spec = importlib.util.spec_from_file_location("credential_genesis", script)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def fixture():
    return {
        "schema_version": 1, "source": "GENESIS_PUBLIC_SIGNAL_PROJECTION",
        "publication_scope": "STAGING_NOT_APPROVED", "execution_authority": "none",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "engine": {"mode": "paper", "running": True}, "position_verification": "verified",
        "signals": [
            {"id": "b"*32, "asset": "SOL", "side": "SELL",
             "stage": "PAPER_OPEN", "observed_at": "2026-11-09T12:00:00Z",
             "confidence": 62.4, "trigger": 101.0, "stop_loss": 102.0,
             "target": 99.0, "reason_code": "CHECKS_PASSED",
             "position_evidence": "CANONICAL_PAPER_LEDGER"}
        ]
    }


class CredentialReaderTests(unittest.TestCase):
    def test_only_unapproved_input_accepted(self):
        self.assertEqual(mod.validate(fixture()), {"signal_count": 1, "paper_open": 1})

    def test_explicit_approved_scope_is_not_allowed_in_staging(self):
        data = fixture()
        data["publication_scope"] = "PUBLIC_APPROVED"
        with self.assertRaises(mod.InvalidCredential):
            mod.validate(data)

    def test_no_raw_strategy_keys_can_cross(self):
        data = fixture()
        data["signals"][0]["admission_fingerprint"] = "private-secret"
        with self.assertRaises(mod.InvalidCredential):
            mod.validate(data)

    def test_no_nonpaper_source(self):
        data = fixture()
        data["engine"]["mode"] = "live"
        with self.assertRaises(mod.InvalidCredential):
            mod.validate(data)

    def test_no_unverified_paper_position(self):
        data = fixture()
        del data["signals"][0]["position_evidence"]
        with self.assertRaises(mod.InvalidCredential):
            mod.validate(data)

    def test_no_duplicate_signal_ids(self):
        data = fixture()
        data["signals"].append(dict(data["signals"][0]))
        with self.assertRaises(mod.InvalidCredential):
            mod.validate(data)

    def test_credential_path_from_systemd_only(self):
        with patch.dict("os.environ", {"CREDENTIALS_DIRECTORY": "/run/credentials/a.service"}):
            self.assertEqual(str(mod.credential_path()),
                             "/run/credentials/a.service/genesis-signal-snapshot")

    def test_read_credential_works_and_does_not_mutate_file(self):
        raw = json.dumps(fixture()).encode()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data"
            path.write_bytes(raw)
            self.assertEqual(mod.read_credential(path)["paper_open"], 1)
            self.assertEqual(path.read_bytes(), raw)

    def test_enforces_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as folder:
            real = Path(folder) / "real"
            real.write_text(json.dumps(fixture()))
            alias = Path(folder) / "alias"
            alias.symlink_to(real)
            with self.assertRaises(OSError):
                mod.read_credential(alias)

    def test_http_always_disabled(self):
        # No credential contents may appear in any reply.
        from io import BytesIO
        instance = object.__new__(mod.DisabledHandler)
        instance.path = "/signals"
        instance.wfile = BytesIO()
        instance.send_response = lambda *a: setattr(instance, "code", a[0])
        instance.send_header = lambda *a: None
        instance.end_headers = lambda: None
        instance.do_GET()
        self.assertEqual(instance.code, 503)
        self.assertEqual(json.loads(instance.wfile.getvalue())["signals"], [])

    def test_unknown_route_returns_404(self):
        from io import BytesIO
        instance = object.__new__(mod.DisabledHandler)
        instance.path = "/private/raw"
        instance.wfile = BytesIO()
        instance.send_response = lambda *a: setattr(instance, "code", a[0])
        instance.send_header = lambda *a: None
        instance.end_headers = lambda: None
        instance.do_GET()
        self.assertEqual(instance.code, 404)


if __name__ == "__main__":
    unittest.main()
