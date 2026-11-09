#!/usr/bin/env python3
"""Offline tests of read-only signal projection; never uses VPS or real credentials."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("publisher.py")
spec = importlib.util.spec_from_file_location("genesis_signal_publisher", SCRIPT)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

NOW = datetime(2026, 11, 9, 12, 15, tzinfo=timezone.utc)

def ts(delta=0):
    return (NOW + timedelta(seconds=delta)).isoformat().replace("+00:00", "Z")

class PublicSignalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "genesis").mkdir()
        self.active = [{
            "coin": "SOL", "action": "BUY", "entry": 102.5, "opened_at": ts(-40),
            "admission_fingerprint": "fp-verified-001", "score": 73.5, "stop": 99,
            "tp1": 110, "private_thought": "never publish", "account": 91234
        }]
        self.canonical = {
            "canonical-private-id": {
                "last_seen_at": ts(-20), "signature": "private-signature",
                "record": {
                    "coin": "SOL", "direction": "BUY", "entry_price": 102.5,
                    "opened_at": ts(-40), "classification": "ACTIVE",
                    "sources": ["private-ledger"]
                }
            }
        }
        self.admission = {"records": [{
            "fingerprint": "fp-verified-001", "canonical_pair": "SOL/USDC",
            "side": "BUY", "entry": 102.5, "stop": 99, "tp1": 110,
            "source_timestamp": ts(-60), "approved_at": ts(-60)
        }]}
        self.ledger = [
            {"coin": "SOL", "direction": "BUY", "entry_price": 102.5,
             "opened_at": ts(-40), "event_type": "OPENED", "trade_key": "private-trade-key"}
        ]
        self.write()

    def write(self):
        fixtures = {
            "signal_admission_state.json": self.admission,
            "active_trades.json": self.active,
            "genesis/trade_lifecycle_state.json": {"canonical_active": self.canonical},
            "genesis/trade_lifecycle_ledger.json": self.ledger
        }
        for name, obj in fixtures.items():
            (self.root / name).write_text(json.dumps(obj), encoding="utf8")

    def project(self, health=None):
        h = health or {"engine": {"mode": "paper", "running": True},
                       "served_at": ts(-2)}
        return publisher.project(self.root, h, b"a" * 48, now=NOW)

    def test_one_to_one_with_canonical_and_opened_ledger(self):
        result = self.project()
        self.assertEqual(result["position_verification"], "verified")
        self.assertEqual(result["signals"][0]["stage"], "PAPER_OPEN")
        self.assertEqual(result["signals"][0]["position_evidence"], "CANONICAL_PAPER_LEDGER")
        self.assertEqual(result["signals"][0]["confidence"], 73.5)
        raw = json.dumps(result)
        for forbidden in ["fp-verified-001", "private-signature", "private-trade-key",
                          "never publish", "private-ledger", "91234"]:
            self.assertNotIn(forbidden, raw)

    def test_missing_canonical_match_never_creates_open_position(self):
        self.active[0]["entry"] = 500
        self.write()
        result = self.project()
        self.assertEqual(result["position_verification"], "unverified")
        self.assertEqual(result["signals"][0]["stage"], "QUALIFIED")

    def test_ambiguous_two_to_one_mapping_downgrades_every_position(self):
        self.active.append(dict(self.active[0]))
        self.write()
        result = self.project()
        self.assertEqual(result["position_verification"], "unverified")
        self.assertTrue(all(s["stage"] != "PAPER_OPEN" for s in result["signals"]))

    def test_closed_event_disallows_open_position(self):
        self.ledger.append({"event_type": "CLOSED_RECORDED", "trade_key": "private-trade-key"})
        self.write()
        result = self.project()
        self.assertEqual(result["signals"][0]["stage"], "QUALIFIED")
        self.assertEqual(result["position_verification"], "unverified")

    def test_stale_last_seen_disallows_position(self):
        self.canonical["canonical-private-id"]["last_seen_at"] = ts(-3600)
        self.write()
        result = self.project()
        self.assertEqual(result["signals"][0]["stage"], "QUALIFIED")
        self.assertEqual(result["position_verification"], "unverified")

    def test_stale_health_blocks_entire_projection(self):
        with self.assertRaises(publisher.Unverified):
            self.project({"engine": {"mode": "paper", "running": True},
                          "served_at": ts(-3600)})

    def test_nonpaper_health_blocks_entire_projection(self):
        with self.assertRaises(publisher.Unverified):
            self.project({"engine": {"mode": "live", "running": True},
                          "served_at": ts(-2)})

    def test_duplicate_admission_identity_fails_closed(self):
        self.admission["records"].append(dict(self.admission["records"][0]))
        self.write()
        with self.assertRaises(publisher.Unverified):
            self.project()

    def test_symlink_is_rejected(self):
        orig = self.root / "active_trades.json"
        dup = self.root / "actual.json"
        orig.rename(dup)
        orig.symlink_to(dup)
        with self.assertRaises(OSError):
            self.project()

    def test_deterministic_opaque_public_ids(self):
        a = self.project()["signals"][0]["id"]
        b = self.project()["signals"][0]["id"]
        self.assertEqual(a, b)
        self.assertNotEqual(a, "fp-verified-001")
        self.assertEqual(len(a), 32)

    def test_read_only_files_unchanged(self):
        paths = list(self.root.rglob("*.json"))
        before = {str(p): p.read_bytes() for p in paths}
        self.project()
        after = {str(p): p.read_bytes() for p in paths}
        self.assertEqual(before, after)

if __name__ == "__main__":
    unittest.main()
