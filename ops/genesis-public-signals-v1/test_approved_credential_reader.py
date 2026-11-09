#!/usr/bin/env python3
"""Release-only read-only credential projection tests (no VPS access)."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
from io import BytesIO
from unittest import TestCase, main
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "genesis_credential_release", Path(__file__).with_name("credential_reader.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

def fixture():
    return {
        "schema_version":1,"source":"GENESIS_PUBLIC_SIGNAL_PROJECTION",
        "publication_scope":"STAGING_NOT_APPROVED",
        "execution_authority":"none",
        "generated_at":datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00","Z"),
        "engine":{"mode":"paper","running":True},
        "position_verification":"verified",
        "signals":[
            {"id":"b"*32,"asset":"BNB","side":"BUY","stage":"PAPER_OPEN",
             "observed_at":"2026-11-09T12:00:00Z",
             "reason_code":"CHECKS_PASSED",
             "position_evidence":"CANONICAL_PAPER_LEDGER",
             "confidence":65.2,"trigger":900,"stop_loss":890,"target":930},
            {"id":"c"*32,"asset":"SOL","side":"SELL","stage":"QUALIFIED",
             "observed_at":"2026-11-09T12:00:00Z",
             "reason_code":"CHECKS_PASSED"}
        ]
    }


class ApprovedReaderTests(TestCase):
    def test_valid_paper_projection_has_no_execution_authority(self):
        obj = json.loads(r.release_projection(fixture()))
        self.assertEqual(obj["publication_scope"], "PUBLIC_APPROVED")
        self.assertEqual(obj["execution_authority"], "none")
        self.assertEqual(len(obj["signals"]), 2)
        self.assertEqual(obj["signals"][0]["position_evidence"], "CANONICAL_PAPER_LEDGER")

    def test_stale_feed_fail_closed(self):
        f=fixture()
        f["generated_at"]=(datetime.now(timezone.utc)-timedelta(minutes=3)).isoformat(timespec="seconds").replace("+00:00","Z")
        with self.assertRaises(r.InvalidCredential):
            r.release_projection(f)

    def test_unknown_fields_fail_closed(self):
        f=fixture()
        f["signals"][0]["private_fingerprint"]="secret"
        with self.assertRaises(r.InvalidCredential):
            r.release_projection(f)

    def test_live_engine_fail_closed(self):
        f=fixture()
        f["engine"]["mode"]="live"
        with self.assertRaises(r.InvalidCredential):
            r.release_projection(f)

    def test_unverified_paper_position_fail_closed(self):
        f=fixture()
        del f["signals"][0]["position_evidence"]
        with self.assertRaises(r.InvalidCredential):
            r.release_projection(f)

    def test_public_scope_not_accepted_as_credential(self):
        f=fixture()
        f["publication_scope"]="PUBLIC_APPROVED"
        with self.assertRaises(r.InvalidCredential):
            r.release_projection(f)

    def test_feature_release_requires_two_gates(self):
        source=Path(__file__).with_name("credential_reader.py").read_text()
        self.assertIn("--public-readonly",source)
        self.assertIn("GENESIS_SIGNALS_PUBLICATION_APPROVED",source)
        self.assertIn("GENESIS_SIGNALS_PUBLISH_ENABLED",source)
        self.assertNotIn("tkempire.service",source)

    def test_disabled_handler_still_refuses_content(self):
        handler=object.__new__(r.DisabledHandler)
        handler.path="/signals"
        handler.wfile=BytesIO()
        handler.send_response=lambda *x: setattr(handler,"code",x[0])
        handler.send_header=lambda *a: None
        handler.end_headers=lambda: None
        handler.do_GET()
        self.assertEqual(handler.code,503)
        self.assertEqual(json.loads(handler.wfile.getvalue())["signals"],[])


if __name__ == "__main__":
    main()
