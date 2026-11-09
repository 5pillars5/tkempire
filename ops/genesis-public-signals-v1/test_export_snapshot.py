#!/usr/bin/env python3
"""Offline tests of the unapproved, private, allowlisted Genesis projection."""
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location(
    "genesis_export_snapshot", Path(__file__).with_name("export_snapshot.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

NOW = datetime(2026, 11, 9, 14, 0, tzinfo=timezone.utc)
SAMPLE = {
    "schema_version": 1,
    "source": "GENESIS_PUBLIC_SIGNAL_PROJECTION",
    "publication_scope": "PUBLIC_APPROVED",
    "execution_authority": "none",
    "generated_at": "2026-11-09T14:00:00Z",
    "engine": {"mode": "paper", "running": True},
    "position_verification": "verified",
    "signals": [
        {
            "id": "f" * 32, "asset": "SOL", "side": "BUY",
            "stage": "PAPER_OPEN", "observed_at": "2026-11-09T13:59:00Z",
            "confidence": 65.5, "trigger": 110.25, "stop_loss": 105.5,
            "target": 120.5, "reason_code": "CHECKS_PASSED",
            "position_evidence": "CANONICAL_PAPER_LEDGER"
        }
    ]
}


class ExportTests(unittest.TestCase):
    def projected(self, data=None):
        return json.loads(module.sanitise(data or SAMPLE, NOW))

    def test_unapproved_scope_always(self):
        output = self.projected()
        self.assertEqual(output["publication_scope"], "STAGING_NOT_APPROVED")
        self.assertEqual(len(output["signals"]), 1)
        self.assertEqual(output["signals"][0]["stage"], "PAPER_OPEN")

    def test_reject_private_leak_fields(self):
        raw = dict(SAMPLE)
        raw["api_token"] = "SECRET"
        with self.assertRaises(module.UnsafeSnapshot):
            self.projected(raw)

    def test_reject_signal_private_leak_fields(self):
        raw = json.loads(json.dumps(SAMPLE))
        raw["signals"][0]["admission_fingerprint"] = "SECRET"
        with self.assertRaises(module.UnsafeSnapshot):
            self.projected(raw)

    def test_reject_unverified_positions(self):
        raw = dict(SAMPLE, position_verification="unverified")
        with self.assertRaises(module.UnsafeSnapshot):
            self.projected(raw)

    def test_reject_nonpaper(self):
        raw = dict(SAMPLE, engine={"mode": "live", "running": True})
        with self.assertRaises(module.UnsafeSnapshot):
            self.projected(raw)

    def test_reject_position_without_evidence(self):
        raw = json.loads(json.dumps(SAMPLE))
        del raw["signals"][0]["position_evidence"]
        with self.assertRaises(module.UnsafeSnapshot):
            self.projected(raw)

    def test_reject_untrusted_price(self):
        raw = json.loads(json.dumps(SAMPLE))
        raw["signals"][0]["trigger"] = "100"
        with self.assertRaises(module.UnsafeSnapshot):
            self.projected(raw)

    def test_reject_duplicate_identifiers(self):
        raw = json.loads(json.dumps(SAMPLE))
        raw["signals"].append(raw["signals"][0].copy())
        with self.assertRaises(module.UnsafeSnapshot):
            self.projected(raw)

    def test_reject_wrong_source_scope(self):
        raw = dict(SAMPLE, publication_scope="UNAPPROVED")
        with self.assertRaises(module.UnsafeSnapshot):
            self.projected(raw)

    def test_reject_stale_output(self):
        raw = dict(SAMPLE, generated_at="2026-11-09T13:45:00Z")
        with self.assertRaises(module.UnsafeSnapshot):
            self.projected(raw)

    def test_never_enable_public_reader(self):
        self.assertEqual(module.PRIVATE_DIR.as_posix(), "/var/lib/tkempire-genesis-signals-staging")
        self.assertEqual(module.PRIVATE_FILE.name, "unapproved-projection.json")
        self.assertEqual(module.MAX_BYTES, 60_000)

if __name__ == "__main__":
    unittest.main()
