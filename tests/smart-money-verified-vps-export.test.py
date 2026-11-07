import datetime as dt
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import importlib.util

ROOT=Path(__file__).resolve().parents[1]
PATH=ROOT/"ops/smart-money-history-v1/export-verified-vps-sqlite.py"
spec=importlib.util.spec_from_file_location("verified_vps_export",PATH)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class VerifiedVpsSQLiteExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.db=self.root/"original.sqlite3"
        self.output=self.root/"export"/"verified.json"
        now=dt.datetime.now(dt.timezone.utc)
        observed=(now-dt.timedelta(minutes=3)).isoformat().replace("+00:00","Z")
        first_seen=(now-dt.timedelta(minutes=2)).isoformat().replace("+00:00","Z")
        payload={"id":"a"*24,"execution_authority":"none","signal_mode":"OBSERVATION_ONLY","paper_trade":False,
          "condition_id":"0x"+"b"*64,"token_id":"12345","market":"Market evidence",
          "outcome":"Yes","side":"BUY","representative_price":0.37,
          "wallets":["0x"+"c"*40]}
        with sqlite3.connect(self.db) as conn:
            conn.execute("CREATE TABLE signals(id TEXT PRIMARY KEY,first_seen_at TEXT NOT NULL,observed_at TEXT NOT NULL,signal_type TEXT NOT NULL,market TEXT NOT NULL,outcome TEXT NOT NULL,side TEXT NOT NULL,amount_usdc REAL NOT NULL,payload_json TEXT NOT NULL)")
            conn.execute("CREATE TABLE scans(id INTEGER PRIMARY KEY)")
            conn.execute("INSERT INTO scans VALUES (1)")
            conn.execute("INSERT INTO signals VALUES(?,?,?,?,?,?,?,?,?)",
                (payload["id"],first_seen,observed,"SMART_MONEY_BUY","Market evidence","Yes","BUY",250,json.dumps(payload)))
    def test_preserves_db_and_hashes_and_reads_back_export(self):
        before=hashlib.sha256(self.db.read_bytes()).hexdigest()
        body=module.export(self.db,self.output,retries=2)
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(),before)
        self.assertEqual(body["source_file_evidence"]["sqlite_db"]["sha256"],before)
        self.assertEqual(body["source_consistent_snapshot_integrity"],"ok")
        self.assertEqual(body["signal_rows"],1)
        self.assertEqual(body["scan_rows"],1)
        self.assertTrue(body["source_hashes_stable_before_after"])
        self.assertEqual(body["records"][0]["id"],"a"*24)
        self.assertEqual(body["records"][0]["legacy_first_seen_at"],body["records"][0]["captured_at"])
        self.assertFalse(body["github_import_performed"])
        self.assertEqual(json.loads(self.output.read_text())["source_consistent_snapshot_sha256"],body["source_consistent_snapshot_sha256"])
        with self.assertRaises(FileExistsError):
            module.export(self.db,self.output,retries=1)
    def test_halts_on_invalid_trading_evidence(self):
        with sqlite3.connect(self.db) as conn:
            row=conn.execute("SELECT payload_json FROM signals").fetchone()[0]
            payload=json.loads(row)
            payload["execution_authority"]="execute"
            conn.execute("UPDATE signals SET payload_json=?",(json.dumps(payload),))
        with self.assertRaisesRegex(ValueError,"UNEXPECTED_TRADE_AUTHORITY"):
            module.export(self.db,self.output,retries=1)
        self.assertFalse(self.output.exists())
    def test_refuses_source_symlink(self):
        link=self.root/"link.sqlite3"
        link.symlink_to(self.db)
        with self.assertRaisesRegex(RuntimeError,"INVALID_SOURCE_PATH"):
            module.export(link,self.output)
        self.assertFalse(self.output.exists())
if __name__=="__main__":
    unittest.main()
