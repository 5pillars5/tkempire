#!/usr/bin/env python3
"""Offline tests for read-only, aggregate-only closed-ledger audit."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

source=Path(__file__).with_name("audit_closed_ledger.py")
spec=importlib.util.spec_from_file_location("genesis_closed_ledger_audit",source)
audit=importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
NOW=datetime(2026,11,9,18,0,tzinfo=timezone.utc)

def stamp(delta=0):
    return (NOW+timedelta(seconds=delta)).isoformat().replace("+00:00","Z")

def open_event(key="private-1"):
    return {"event_type":"OPENED","trade_key":key,"coin":"SOL","direction":"SELL",
            "entry_price":100.0,"opened_at":stamp(-200)}

def close_event(key="private-1",pnl=4.0,result="WIN"):
    return {"event_type":"CLOSED_RECORDED","trade_key":key,"coin":"SOL",
            "direction":"SELL","entry_price":100.0,"exit_price":96.0,
            "opened_at":stamp(-200),"closed_at":stamp(-80),
            "pnl":pnl,"result":result,"details":{}}

class ClosedAuditTests(unittest.TestCase):
    def test_one_to_one_verified_close(self):
        report=audit.summarize([open_event(),close_event()],now=NOW)
        self.assertEqual(report["ELIGIBLE_ONE_TO_ONE_CLOSED_RESULTS"],1)
        self.assertEqual(report["CLOSE_RESULT_WIN"],1)
        self.assertEqual(report["ELIGIBLE_RECENT_90D_CLOSED_RESULTS"],1)
        self.assertNotIn("private-1",str(report))

    def test_duplicate_closes_rejected_even_when_events_agree(self):
        report=audit.summarize([open_event(),close_event(),close_event()],now=NOW)
        self.assertEqual(report["DUPLICATE_CLOSE_KEY_GROUPS"],1)
        self.assertEqual(report["ELIGIBLE_ONE_TO_ONE_CLOSED_RESULTS"],0)

    def test_unmatched_or_duplicate_open_rejected(self):
        report=audit.summarize([close_event()],now=NOW)
        self.assertEqual(report["CLOSED_WITHOUT_UNIQUE_OPEN"],1)
        report=audit.summarize([open_event(),open_event(),close_event()],now=NOW)
        self.assertEqual(report["ELIGIBLE_ONE_TO_ONE_CLOSED_RESULTS"],0)

    def test_mismatched_entry_or_trade_direction_rejected(self):
        for key,val in [("entry_price",102),("direction","BUY"),("exit_price",None),
                        ("closed_at",stamp(200)),("opened_at",stamp(-501))]:
            changed=close_event()
            changed[key]=val
            report=audit.summarize([open_event(),changed],now=NOW)
            self.assertEqual(report["ELIGIBLE_ONE_TO_ONE_CLOSED_RESULTS"],0)

    def test_sign_mismatch_rejected(self):
        report=audit.summarize([open_event(),close_event(pnl=-1,result="WIN")],now=NOW)
        self.assertEqual(report["P_AND_L_RESULT_SIGN_MISMATCH"],1)
        self.assertEqual(report["ELIGIBLE_ONE_TO_ONE_CLOSED_RESULTS"],0)

    def test_missing_currency_units_are_not_inferred(self):
        report=audit.summarize([open_event(),close_event()],now=NOW)
        self.assertEqual(report["ACCOUNTING_FIELD_NAMES_PRESENT"],"NONE")

    def test_handles_safe_read_without_modification(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/"ledger.json"
            original=b'[{"event_type":"OPENED","trade_key":"private"}]'
            file.write_bytes(original)
            events,digest=audit.load(file)
            self.assertEqual(events[0]["trade_key"],"private")
            self.assertEqual(file.read_bytes(),original)
            self.assertEqual(len(digest),64)

    def test_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            d=Path(directory)
            underlying=d/"data.json"
            underlying.write_bytes(b"[]")
            link=d/"shortcut"
            link.symlink_to(underlying)
            with self.assertRaises(ValueError):
                audit.load(link)

if __name__=="__main__":
    unittest.main()
