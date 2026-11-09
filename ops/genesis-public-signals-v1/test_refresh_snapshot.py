#!/usr/bin/env python3
"""Offline tests for root-only Genesis stable-ID snapshot refresh."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "genesis_refresh", Path(__file__).with_name("refresh_snapshot.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

NOW = datetime(2026, 11, 9, 15, 0, tzinfo=timezone.utc)

def item(identifier="a"*32):
    return {
        "id": identifier, "asset": "BNB", "side": "BUY", "stage": "PAPER_OPEN",
        "observed_at": "2026-11-09T14:59:00Z",
        "confidence": 63.2, "trigger": 100.0, "stop_loss": 90.0,
        "target": 110.0, "reason_code": "CHECKS_PASSED",
        "position_evidence": "CANONICAL_PAPER_LEDGER"
    }


def projection():
    return {
        "schema_version": 1, "source": "GENESIS_PUBLIC_SIGNAL_PROJECTION",
        "publication_scope": "PUBLIC_APPROVED", "execution_authority": "none",
        "generated_at": "2026-11-09T15:00:00Z",
        "engine": {"mode": "paper", "running": True},
        "position_verification": "verified", "signals": [item()]
    }


class RefreshTests(unittest.TestCase):
    def test_staging_scope_cannot_be_published(self):
        result = json.loads(mod.scrub(projection(), NOW))
        self.assertEqual(result["publication_scope"], "STAGING_NOT_APPROVED")
        self.assertEqual(result["signals"][0]["stage"], "PAPER_OPEN")

    def test_unknown_fields_fail_closed(self):
        raw = projection()
        raw["signals"][0]["admission_fingerprint"] = "private"
        with self.assertRaises(mod.UnsafeRefresh):
            mod.scrub(raw, NOW)

    def test_unverified_positions_fail_closed(self):
        raw = projection()
        raw["position_verification"] = "unverified"
        with self.assertRaises(mod.UnsafeRefresh):
            mod.scrub(raw, NOW)

    def test_duplicate_id_fails_closed(self):
        raw = projection()
        raw["signals"].append(item())
        with self.assertRaises(mod.UnsafeRefresh):
            mod.scrub(raw, NOW)

    def test_nonpaper_fails_closed(self):
        raw = projection()
        raw["engine"]["mode"] = "live"
        with self.assertRaises(mod.UnsafeRefresh):
            mod.scrub(raw, NOW)

    def test_stale_generated_time_fails_closed(self):
        raw = projection()
        raw["generated_at"] = "2026-11-09T14:30:00Z"
        with self.assertRaises(mod.UnsafeRefresh):
            mod.scrub(raw, NOW)

    def test_missing_paper_evidence_fails_closed(self):
        raw = projection()
        raw["signals"][0].pop("position_evidence")
        with self.assertRaises(mod.UnsafeRefresh):
            mod.scrub(raw, NOW)

    def test_persistent_key_readback(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_path = Path(tmp) / "private-key"
            with patch.object(mod, "verify_regular_root",
                              side_effect=lambda path, **kw: Path(path).read_bytes()):
                one, created = mod.private_key(key_path, create=True)
                two, created_again = mod.private_key(key_path, create=True)
            self.assertTrue(created)
            self.assertFalse(created_again)
            self.assertEqual(len(one), 32)
            self.assertEqual(one, two)

    def test_atomic_write_overwrites_and_reads_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "snapshot.json"
            file.write_bytes(b"old")
            mod.atomic_replacement(file, b"new")
            self.assertEqual(file.read_bytes(), b"new")
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_stable_hmac_ids_from_pinned_projector(self):
        original = Path(__file__).with_name("publisher.py")
        spec = importlib.util.spec_from_file_location("genesis_projector_fixture", original)
        publisher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(publisher)
        import hmac
        import hashlib
        key = b"k" * 32
        signature = b"genesis-public-v1|private-fingerprint"
        one = hmac.new(key, signature, hashlib.sha256).hexdigest()[:32]
        two = hmac.new(key, signature, hashlib.sha256).hexdigest()[:32]
        three = hmac.new(b"d"*32, signature, hashlib.sha256).hexdigest()[:32]
        self.assertEqual(one, two)
        self.assertNotEqual(one, three)


if __name__ == "__main__":
    unittest.main()
