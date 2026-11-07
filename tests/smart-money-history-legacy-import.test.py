import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

PATH=Path(__file__).resolve().parents[1]/"ops/smart-money-history-v1/export-legacy-sqlite.py"
spec=importlib.util.spec_from_file_location("smartmoney_legacy_import",PATH)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class LegacyArchiveTest(unittest.TestCase):
    def test_import_readonly_unchanged_source_and_readback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            db=root/"legacy.sqlite3";output=root/"export"/"legacy.json"
            with sqlite3.connect(db) as conn:
                conn.execute("CREATE TABLE signals(id TEXT PRIMARY KEY,first_seen_at TEXT,observed_at TEXT,signal_type TEXT,amount_usdc REAL,payload_json TEXT)")
                conn.execute("CREATE TABLE scans(id INTEGER PRIMARY KEY)")
                conn.execute("INSERT INTO scans VALUES (1)")
                signal={"id":"a"*24,"execution_authority":"none","signal_mode":"OBSERVATION_ONLY","paper_trade":False,
                        "condition_id":"0x"+"b"*64,"token_id":"12345",
                        "market":"Outcome example","outcome":"Yes","side":"BUY","representative_price":.4,
                        "wallets":["0x"+"c"*40]}
                conn.execute("INSERT INTO signals VALUES(?,?,?,?,?,?)",
                   (signal["id"],"2026-11-06T20:00:00Z","2026-11-06T19:59:50Z","SMART_MONEY_BUY",200,json.dumps(signal)))
            before=db.read_bytes()
            doc=m.export(db,output)
            self.assertEqual(db.read_bytes(),before)
            self.assertEqual(doc["signal_rows"],1)
            self.assertEqual(doc["scan_rows"],1)
            self.assertEqual(doc["records"][0]["id"],"a"*24)
            self.assertEqual(doc["records"][0]["token_id"],"12345")
            self.assertEqual(doc["records"][0]["condition_id"],"0x"+"b"*64)
            self.assertTrue(doc["source_read_only"])
            self.assertFalse(doc["automatic_github_ingest"])
            self.assertFalse(doc["flow_history_backfilled"])
            self.assertEqual(json.loads(output.read_text())["signal_rows"],1)
            self.assertEqual(output.stat().st_mode & 0o777,0o600)
            with self.assertRaises(FileExistsError):
                m.export(db,output)
    def test_trading_authority_in_source_blocked(self):
        with self.assertRaises(ValueError):
            m.norm("a"*24,"2026-11-06T20:00:00Z","2026-11-06T20:00:00Z","SMART_MONEY_BUY",100,
                   {"id":"a"*24,"execution_authority":"trade","signal_mode":"OBSERVATION_ONLY","paper_trade":False})

if __name__=="__main__":
    unittest.main()
