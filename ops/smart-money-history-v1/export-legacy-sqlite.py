#!/usr/bin/env python3
"""Read-only export of existing Smart Money Monitor V1 SQLite evidence.

Does not create database tables, copy private credentials, update the monitored
database, call any live services, or claim GitHub import succeeded.
Writes a sanitized *local* export, for separate reviewed import to public GitHub.
"""
import argparse
import datetime as dt
import hashlib
import json
import re
import sqlite3
from pathlib import Path

DB_DEFAULT = "/var/lib/tkempire-smartmoney-v1/signals.sqlite3"
ADDR = re.compile(r"^0x[a-fA-F0-9]{40}$")
COND = re.compile(r"^0x[a-fA-F0-9]{64}$")
TOKEN = re.compile(r"^[0-9]+$")
SIGNAL = re.compile(r"^[a-fA-F0-9]{24}$")
def utc(t):
    if not isinstance(t, str):
        raise ValueError("INVALID_TIME")
    parsed = dt.datetime.fromisoformat(t.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("NAIVE_TIMESTAMP")
    return parsed.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
def norm(sid, first_seen, observed, kind, amount, raw):
    if not SIGNAL.fullmatch(sid):
        raise ValueError("INVALID_ID")
    if not isinstance(raw,dict) or raw.get("id") != sid:
        raise ValueError("PAYLOAD_ID_MISMATCH")
    if raw.get("execution_authority") != "none" or raw.get("signal_mode") != "OBSERVATION_ONLY" or raw.get("paper_trade") is not False:
        raise ValueError("UNEXPECTED_TRADE_AUTHORITY")
    condition = str(raw.get("condition_id") or "").lower()
    token = str(raw.get("token_id") or "")
    observed_at = utc(observed)
    captured_at = utc(first_seen)
    return {
        "id": sid.lower(),
        "source": "VPS_SQLITE_MONITOR_V1_UNPUBLISHED_EXPORT",
        "observed_at": observed_at,
        "captured_at": captured_at,
        "condition_id": condition if COND.fullmatch(condition) else None,
        "token_id": token if TOKEN.fullmatch(token) else None,
        "side": raw.get("side") if raw.get("side") in ("BUY", "SELL") else None,
        "title": str(raw.get("market") or "")[:190],
        "outcome": str(raw.get("outcome") or "")[:90],
        "type": kind,
        "amount_usdc": float(amount),
        "representative_price": raw.get("representative_price") if isinstance(raw.get("representative_price"),(int,float)) else None,
        "wallets": [a.lower() for a in raw.get("wallets",[]) if isinstance(a,str) and ADDR.fullmatch(a)][:8] if isinstance(raw.get("wallets"),list) else [],
        "source_payload_sha256": hashlib.sha256(json.dumps(raw,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    }

def export(db,out):
    if not db.is_file() or db.is_symlink():
        raise ValueError("DATABASE_FILE_MISSING_OR_SYMLINK")
    if out.resolve()==db.resolve():
        raise ValueError("OUTPUT_OVERWRITES_SOURCE")
    uri=db.resolve().as_uri()+"?mode=ro"
    records=[]
    with sqlite3.connect(uri,uri=True,timeout=15) as conn:
        conn.execute("PRAGMA query_only = ON")
        if conn.execute("PRAGMA integrity_check").fetchone()[0]!="ok":
            raise ValueError("SOURCE_DB_INTEGRITY_FAIL")
        columns={row[1] for row in conn.execute("PRAGMA table_info(signals)")}
        expected={"id","first_seen_at","observed_at","signal_type","amount_usdc","payload_json"}
        if not expected <= columns:
            raise ValueError("SOURCE_SCHEMA_CHANGED")
        for row in conn.execute("SELECT id,first_seen_at,observed_at,signal_type,amount_usdc,payload_json FROM signals ORDER BY observed_at,id"):
            sid,seen,when,kind,amount,payload=row
            records.append(norm(sid,seen,when,kind,amount,json.loads(payload)))
        scan_count=conn.execute("SELECT COUNT(*) FROM scans").fetchone()[0]
    ids=[r["id"] for r in records]
    if len(ids)!=len(set(ids)):
        raise ValueError("DUPLICATE_SOURCE_ID")
    body={"schema_version":1,"origin":"VPS_SQLITE_MONITOR_V1",
          "exported_at":dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00","Z"),
          "source_database":DB_DEFAULT,"source_read_only":True,
          "scan_rows":scan_count,"signal_rows":len(records),
          "flow_history_backfilled":False,
          "automatic_github_ingest":False,
          "records":records}
    content=(json.dumps(body,separators=(",",":"),sort_keys=True)+"\n").encode()
    out.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    with out.open("xb") as f:
        f.write(content)
        f.flush()
        import os
        os.fsync(f.fileno())
    out.chmod(0o600)
    digest=hashlib.sha256(content).hexdigest()
    reread=hashlib.sha256(out.read_bytes()).hexdigest()
    if digest!=reread:
        raise ValueError("EXPORT_READBACK_FAIL")
    print("LEGACY_MONITOR_EXPORT=PASS")
    print("SCAN_ROWS="+str(scan_count))
    print("SIGNAL_ROWS="+str(len(records)))
    print("EXPORT_PATH="+str(out))
    print("EXPORT_SHA256="+digest)
    print("EXPORT_READBACK=PASS")
    print("GITHUB_IMPORT=NOT_YET_PERFORMED")
    return body

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--db",type=Path,default=Path(DB_DEFAULT))
    p.add_argument("--output",type=Path,required=True)
    a=p.parse_args()
    export(a.db,a.output)
