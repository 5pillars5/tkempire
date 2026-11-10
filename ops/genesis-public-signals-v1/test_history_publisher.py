#!/usr/bin/env python3
"""Offline fixture-only tests of the independent Genesis closed-history projection."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import unittest

spec=importlib.util.spec_from_file_location("history",Path(__file__).with_name("history_publisher.py"))
history=importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
NOW=datetime(2026,11,9,20,0,tzinfo=timezone.utc)
KEY=b"t"*32

def stamp(offset):
    return (NOW+timedelta(seconds=offset)).isoformat().replace("+00:00","Z")

def pair(key,opened=-500,closed=-200):
    a={"event_type":"OPENED","trade_key":key,"coin":"SOL","direction":"SELL",
       "entry_price":100.0,"opened_at":stamp(opened)}
    b={"event_type":"CLOSED_RECORDED","trade_key":key,"coin":"SOL",
       "direction":"SELL","entry_price":100.0,"exit_price":96.0,
       "opened_at":stamp(opened),"closed_at":stamp(closed),
       "result":"WIN","pnl":4.0,
       "wallet":"PRIVATE_MASTER_WALLET","signal_fingerprint":"PRIVATE_FINGERPRINT"}
    return [a,b]

def project(events,page=1,key=KEY):
    return history.project(events,key,json.dumps(events).encode(),page=page,now=NOW)

class HistoryTests(unittest.TestCase):
    def test_complete_history_includes_trades_older_than_ninety_days(self):
        events=pair("keyold",-110*86400,-109*86400)+pair("keynew")
        result=project(events)
        self.assertEqual(result["verified_count"],2)
        self.assertEqual(result["excluded_count"],0)
        self.assertEqual(result["closed_trades"][1]["observed_at"],stamp(-110*86400))
        self.assertEqual(result["closed_trades"][1]["pnl_unit"],"LEDGER_UNIT_UNVERIFIED")
        self.assertNotIn("PRIVATE_MASTER_WALLET",json.dumps(result))
        self.assertNotIn("PRIVATE_FINGERPRINT",json.dumps(result))
        self.assertNotIn("keyold",json.dumps(result))

    def test_stable_paginated_results_count_and_revision(self):
        rows=[]
        for i in range(123):
            rows.extend(pair("key-"+str(i),-700+i*2,-300+i*2))
        first=project(rows,1)
        second=project(rows,2)
        last=project(rows,3)
        self.assertEqual((len(first["closed_trades"]),len(second["closed_trades"]),len(last["closed_trades"])),(50,50,23))
        self.assertEqual((first["has_more"],second["has_more"],last["has_more"]),(True,True,False))
        self.assertEqual(first["verified_count"],123)
        self.assertEqual(first["revision"],second["revision"])
        self.assertEqual(len({x["id"] for part in (first,second,last) for x in part["closed_trades"]}),123)
        self.assertNotEqual(first["revision"],project(rows,1,key=b"z"*32)["revision"])

    def test_unmatched_duplicates_and_accounting_mismatches_excluded(self):
        good=pair("valid")
        duplicate=pair("duplicated")+pair("duplicated")[1:]
        unmatched=[pair("orphan")[1]]
        wrong=pair("bad")
        wrong[1]["pnl"]=-4.0
        rows=good+duplicate+unmatched+wrong
        result=project(rows)
        self.assertEqual(result["total_closed_count"],5)
        self.assertEqual(result["verified_count"],1)
        self.assertEqual(result["excluded_count"],4)
        self.assertEqual(result["closed_trades"][0]["result"],"WIN")

    def test_fails_closed_for_invalid_page_or_key_and_future_close(self):
        with self.assertRaises(history.Blocked):
            project(pair("valid"),page=0)
        with self.assertRaises(history.Blocked):
            project(pair("valid"),key=b"x")
        future=pair("future")
        future[1]["closed_at"]=stamp(100)
        self.assertEqual(project(future)["verified_count"],0)

    def test_empty_history_is_valid_but_not_false_trade(self):
        result=project([])
        self.assertEqual(result["verified_count"],0)
        self.assertEqual(result["closed_trades"],[])
        self.assertEqual(result["excluded_count"],0)

if __name__=="__main__":
    unittest.main()
