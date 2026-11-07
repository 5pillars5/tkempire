#!/usr/bin/env python3
"""Read-only, hash-verified export of the original VPS Smart Money SQLite monitor.

A consistent SQLite backup is made in a private temporary directory and verified
before sanitized records are exported.  The original database, WAL and service
are NEVER modified.  The raw backup is deleted and is NEVER uploaded.

Source DB and WAL SHA-256 hashes are compared before and after the backup.
A concurrent source change fails closed after bounded retries.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import time

DEFAULT_DB = Path("/var/lib/tkempire-smartmoney-v1/signals.sqlite3")
LEGACY = Path(__file__).with_name("export-legacy-sqlite.py")
UTC = dt.timezone.utc

def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def file_evidence(db):
    """Hash exactly the persistent SQLite DB and its WAL if present; exclude SHM."""
    evidence = {}
    for suffix, label in [("", "sqlite_db"), ("-wal", "sqlite_wal")]:
        p = Path(str(db) + suffix)
        if not p.exists():
            if label == "sqlite_db":
                raise RuntimeError("SOURCE_DATABASE_MISSING")
            evidence[label] = None
            continue
        if p.is_symlink() or not stat.S_ISREG(p.stat().st_mode):
            raise RuntimeError("UNSAFE_SOURCE_FILE_" + label)
        st = p.stat()
        evidence[label] = {
            "sha256": checksum(p), "bytes": st.st_size,
            "device": st.st_dev, "inode": st.st_ino
        }
    return evidence

def read_legacy_module():
    spec = importlib.util.spec_from_file_location("tkempire_legacy_sqlite_export", LEGACY)
    if not spec or not spec.loader:
        raise RuntimeError("LEGACY_EXPORTER_UNAVAILABLE")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def consistent_snapshot(db, directory, retries=3):
    """Use SQLite online backup to capture committed WAL state without halting writer."""
    for attempt in range(1, retries + 1):
        before = file_evidence(db)
        dest = directory / ("snapshot-" + str(attempt) + ".sqlite3")
        source = None
        copied = None
        try:
            source = sqlite3.connect(db.resolve().as_uri() + "?mode=ro",
                                     uri=True, timeout=15)
            source.execute("PRAGMA query_only = ON")
            source.execute("PRAGMA busy_timeout = 15000")
            copied = sqlite3.connect(dest, timeout=15)
            source.backup(copied, pages=256, sleep=0.02)
            copied.close()
            copied = None
            source.close()
            source = None
            after = file_evidence(db)
            if before != after:
                dest.unlink(missing_ok=True)
                if attempt < retries:
                    time.sleep(0.15 * attempt)
                    continue
                raise RuntimeError("SOURCE_CHANGED_DURING_BACKUP")
            frozen_sha = checksum(dest)
            with sqlite3.connect(dest) as snapshot:
                if snapshot.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("SNAPSHOT_INTEGRITY_FAILURE")
            if checksum(dest) != frozen_sha:
                raise RuntimeError("SNAPSHOT_HASH_CHANGED_DURING_READBACK")
            return dest, before, frozen_sha, attempt
        finally:
            if copied is not None:
                copied.close()
            if source is not None:
                source.close()
    raise RuntimeError("STABLE_SNAPSHOT_UNAVAILABLE")

def export(db, output, retries=3):
    if not db.is_file() or db.is_symlink():
        raise RuntimeError("INVALID_SOURCE_PATH")
    if output.exists() or output.is_symlink():
        raise FileExistsError(str(output))
    if output.resolve() == db.resolve():
        raise RuntimeError("OUTPUT_EQUALS_SOURCE")
    legacy = read_legacy_module()
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="smartmoney-vps-readonly-") as temp:
        snap, evidence, frozen_sha, attempts = consistent_snapshot(db, Path(temp), retries)
        with sqlite3.connect(snap.as_uri() + "?mode=ro", uri=True) as conn:
            conn.execute("PRAGMA query_only = ON")
            expected_cols = {"id", "first_seen_at", "observed_at", "signal_type", 
                             "market", "outcome", "side", "amount_usdc", "payload_json"}
            actual_cols = {row[1] for row in conn.execute("PRAGMA table_info(signals)")}
            if not expected_cols.issubset(actual_cols):
                raise RuntimeError("LEGACY_SCHEMA_MISMATCH")
            scans = conn.execute("SELECT COUNT(*) FROM scans").fetchone()[0]
            signals = conn.execute("SELECT COUNT(*) FROM signals").fetchone()[0]
            rows = conn.execute(
                "SELECT id,first_seen_at,observed_at,signal_type,amount_usdc,payload_json "
                "FROM signals ORDER BY first_seen_at,id").fetchall()
        if checksum(snap) != frozen_sha:
            raise RuntimeError("SNAPSHOT_SOURCE_SHA_MISMATCH")
        records = []
        first_seen_min = None
        first_seen_max = None
        for sid, first_seen, observed, kind, amount, payload in rows:
            obj = json.loads(payload)
            record = legacy.norm(sid, first_seen, observed, kind, amount, obj)
            seen = dt.datetime.fromisoformat(record["captured_at"].replace("Z", "+00:00"))
            observed_dt = dt.datetime.fromisoformat(record["observed_at"].replace("Z", "+00:00"))
            if seen < observed_dt - dt.timedelta(seconds=90):
                raise RuntimeError("FIRST_SEEN_BEFORE_OBSERVED_" + str(sid))
            if seen > dt.datetime.now(UTC) + dt.timedelta(seconds=90):
                raise RuntimeError("FUTURE_FIRST_SEEN_" + str(sid))
            first_seen_min = min(first_seen_min, seen) if first_seen_min else seen
            first_seen_max = max(first_seen_max, seen) if first_seen_max else seen
            record["legacy_first_seen_at"] = record["captured_at"]
            record["source"] = "VPS_SQLITE_MONITOR_V1_VERIFIED_EXPORT"
            records.append(record)
        if len(rows) != signals or len({r["id"] for r in records}) != signals:
            raise RuntimeError("ROW_COUNT_OR_STABLE_ID_MISMATCH")
        db_hashes = {key: {"sha256": v["sha256"], "bytes": v["bytes"]}
                     if v else None for key, v in evidence.items()}
        manifest = {
            "schema_version": 2,
            "origin": "VPS_SQLITE_MONITOR_V1",
            "exported_at": dt.datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "source_read_only": True,
            "source_database": str(db),
            "source_file_evidence": db_hashes,
            "source_hashes_stable_before_after": True,
            "source_consistent_snapshot_sha256": frozen_sha,
            "source_consistent_snapshot_integrity": "ok",
            "snapshot_retry_attempts": attempts,
            "signal_rows": signals, "scan_rows": scans,
            "oldest_first_seen_at": first_seen_min.isoformat().replace("+00:00", "Z") if first_seen_min else None,
            "newest_first_seen_at": first_seen_max.isoformat().replace("+00:00", "Z") if first_seen_max else None,
            "flow_history_backfilled": False,
            "github_import_performed": False
        }
        result = {**manifest, "records": records}
        content = (json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with output.open("xb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        output.chmod(0o600)
        out_hash = hashlib.sha256(content).hexdigest()
        if checksum(output) != out_hash:
            raise RuntimeError("EXPORT_READBACK_SHA_MISMATCH")
        replay = json.loads(output.read_bytes())
        if replay["signal_rows"] != signals or len(replay["records"]) != signals or \
            replay["source_consistent_snapshot_sha256"] != frozen_sha:
            raise RuntimeError("EXPORT_READBACK_COUNTS_MISMATCH")
        print("VPS_SQLITE_SOURCE_HASH_VERIFIED=PASS")
        print("SQLITE_SNAPSHOT_INTEGRITY=PASS")
        print("SOURCE_FILES_STABLE=PASS")
        print("STABLE_SIGNAL_IDS=PASS")
        print("FIRST_SEEN_TIMES=PASS")
        print("SOURCE_DB_SHA256=" + evidence["sqlite_db"]["sha256"])
        print("SOURCE_WAL_SHA256=" + (evidence["sqlite_wal"]["sha256"] if evidence["sqlite_wal"] else "ABSENT"))
        print("CONSISTENT_SNAPSHOT_SHA256=" + frozen_sha)
        print("SCAN_ROWS=" + str(scans))
        print("SIGNAL_ROWS=" + str(signals))
        print("EXPORT_PATH=" + str(output))
        print("EXPORT_SHA256=" + out_hash)
        print("EXPORT_READBACK=PASS")
        print("GITHUB_IMPORT=NOT_YET_PERFORMED")
        return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--retries", type=int, default=3, choices=range(1, 6))
    args = parser.parse_args()
    export(args.db, args.output, args.retries)
