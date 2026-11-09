#!/usr/bin/env python3
"""Refresh a ROOT-ONLY, UNAPPROVED Genesis PAPER snapshot with stable opaque IDs.

This script does not restart any service, install timers, expose endpoints,
change trading gates, or allow public publication. It uses a 32-byte private
random HMAC key persisted once in the private 0700 staging directory. Snapshot
replacement is atomic, fsynced, backed up and locked. The running systemd
credential reader will retain its prior snapshot until separately restarted.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from datetime import datetime, timezone

PROJECTOR = Path("/root/tkempire/research/genesis_public_signals_staging/publisher.py")
PROJECTOR_SHA256 = "4ed81f93c11891310eab4ad8093adf26cae2ffdab676839eea666bf79fd23d4c"
STAGING_DIR = Path("/var/lib/tkempire-genesis-signals-staging")
SNAPSHOT = STAGING_DIR / "unapproved-projection.json"
KEY_FILE = STAGING_DIR / "signal-id-hmac.key"
LOCK_FILE = STAGING_DIR / "refresh.lock"
BACKUP_ROOT = Path("/root/tkempire/backups/security")
MAX_OUTPUT_BYTES = 60000
PROJECTION_KEYS = {
    "schema_version", "source", "publication_scope", "execution_authority",
    "generated_at", "engine", "position_verification", "signals"
}
SIGNAL_KEYS = {
    "id", "asset", "side", "stage", "observed_at", "confidence", "trigger",
    "stop_loss", "target", "reason_code", "position_evidence"
}
REQUIRED_SIGNAL_KEYS = {"id", "asset", "side", "stage", "observed_at", "reason_code"}
HEX_ID = re.compile(r"^[a-f0-9]{32}$")
ASSET = re.compile(r"^[A-Z0-9]{2,15}$")
ISO = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$")


class UnsafeRefresh(Exception):
    pass


def require(ok, code):
    if not ok:
        raise UnsafeRefresh(code)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def verify_regular_root(path, *, mode=None, max_size=None):
    require(path.is_file() and not path.is_symlink(), "SOURCE_NOT_REGULAR")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == 0, "SOURCE_NOT_ROOT_OWNED")
        if mode is not None:
            require(stat.S_IMODE(st.st_mode) == mode, "SOURCE_MODE_CHANGED")
        if max_size is not None:
            require(st.st_size <= max_size, "SOURCE_TOO_LARGE")
        with os.fdopen(os.dup(fd), "rb") as stream:
            raw = stream.read((max_size or 1_000_000) + 1)
        st2 = os.fstat(fd)
        require(st.st_size == st2.st_size and st.st_mtime_ns == st2.st_mtime_ns,
                "SOURCE_CHANGED_WHILE_READING")
        return raw
    finally:
        os.close(fd)


def verify_root_dir(path, mode):
    require(path.is_dir() and not path.is_symlink(), "PRIVATE_DIR_MISSING")
    st = path.stat()
    require(st.st_uid == 0 and stat.S_IMODE(st.st_mode) == mode, "PRIVATE_DIR_UNSAFE")


def iso_time(value, now, *, max_age):
    require(isinstance(value, str) and ISO.fullmatch(value), "INVALID_TIMESTAMP")
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise UnsafeRefresh("INVALID_TIMESTAMP") from exc
    age = (now - timestamp.astimezone(timezone.utc)).total_seconds()
    require(-30 <= age <= max_age, "TIMESTAMP_OUT_OF_RANGE")
    return value


def optional_price(value, *, is_confidence=False):
    if value is None:
        return
    require(type(value) in (int, float), "INVALID_NUMERIC_TYPE")
    from math import isfinite
    require(isfinite(value), "NONFINITE_VALUE")
    if is_confidence:
        require(0 <= value <= 100, "CONFIDENCE_OUT_OF_RANGE")
    else:
        require(0 < value <= 1e9, "PRICE_OUT_OF_RANGE")


def scrub(projection, now):
    require(isinstance(projection, dict) and set(projection) == PROJECTION_KEYS,
            "UNEXPECTED_PROJECTION_FIELDS")
    require(type(projection["schema_version"]) is int
            and projection["schema_version"] == 1, "SCHEMA_VERSION_INVALID")
    require(projection["source"] == "GENESIS_PUBLIC_SIGNAL_PROJECTION", "SOURCE_INVALID")
    require(projection["publication_scope"] == "PUBLIC_APPROVED", "SOURCE_SCOPE_INVALID")
    require(projection["execution_authority"] == "none", "EXECUTION_AUTHORITY_UNSAFE")
    require(projection["engine"] == {"mode": "paper", "running": True}, "NOT_PAPER")
    require(projection["position_verification"] == "verified", "POSITION_UNVERIFIED")
    iso_time(projection["generated_at"], now, max_age=120)
    rows = projection["signals"]
    require(isinstance(rows, list) and len(rows) <= 50, "SIGNAL_COUNT_UNSAFE")
    identifiers, cleaned = set(), []
    for row in rows:
        require(isinstance(row, dict)
                and REQUIRED_SIGNAL_KEYS.issubset(row)
                and set(row).issubset(SIGNAL_KEYS), "UNSAFE_SIGNAL_FIELD")
        require(isinstance(row["id"], str) and HEX_ID.fullmatch(row["id"]),
                "OPAQUE_ID_INVALID")
        require(row["id"] not in identifiers, "OPAQUE_ID_REPEATED")
        identifiers.add(row["id"])
        require(isinstance(row["asset"], str) and ASSET.fullmatch(row["asset"]),
                "ASSET_INVALID")
        require(row["side"] in ("BUY", "SELL"), "SIDE_INVALID")
        require(row["stage"] in ("QUALIFIED", "PAPER_OPEN"), "STAGE_INVALID")
        iso_time(row["observed_at"], now, max_age=90 * 86400)
        require(row["reason_code"] == "CHECKS_PASSED", "REASON_INVALID")
        optional_price(row.get("confidence"), is_confidence=True)
        for label in ("trigger", "stop_loss", "target"):
            optional_price(row.get(label))
        if row["stage"] == "PAPER_OPEN":
            require(row.get("position_evidence") == "CANONICAL_PAPER_LEDGER",
                    "POSITION_EVIDENCE_MISSING")
        else:
            require("position_evidence" not in row, "UNEXPECTED_POSITION_EVIDENCE")
        cleaned.append({key: row[key] for key in sorted(row)})
    safe = {
        "schema_version": 1,
        "source": "GENESIS_PUBLIC_SIGNAL_PROJECTION",
        "publication_scope": "STAGING_NOT_APPROVED",
        "execution_authority": "none",
        "generated_at": projection["generated_at"],
        "engine": {"mode": "paper", "running": True},
        "position_verification": "verified",
        "signals": cleaned,
    }
    raw = (json.dumps(safe, sort_keys=True, separators=(",", ":"), allow_nan=False)
           + "\n").encode()
    require(len(raw) <= MAX_OUTPUT_BYTES, "SNAPSHOT_TOO_LARGE")
    return raw


def load_projector(path=PROJECTOR):
    data = verify_regular_root(path, max_size=100000)
    require(sha256(data) == PROJECTOR_SHA256, "PROJECTOR_HASH_CHANGED")
    spec = importlib.util.spec_from_file_location("genesis_pinned_projector", path)
    require(spec and spec.loader, "PROJECTOR_IMPORT_FAILED")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def private_key(path, *, create=False):
    if path.exists() or path.is_symlink():
        data = verify_regular_root(path, mode=0o600, max_size=32)
        require(len(data) == 32, "INVALID_PRIVATE_ID_KEY_LENGTH")
        return data, False
    require(create, "STABLE_ID_KEY_NOT_YET_INITIALIZED")
    # Random secret is NEVER printed; stable across subsequent refreshes.
    key = os.urandom(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(key)
        stream.flush()
        os.fsync(stream.fileno())
    require(verify_regular_root(path, mode=0o600, max_size=32) == key,
            "PRIVATE_KEY_READBACK_FAILED")
    return key, True


def project_snapshot(key, *, now=None):
    now = now or datetime.now(timezone.utc)
    module = load_projector()
    return scrub(module.project(module.ROOT, module.health(), key, now=now), now)


def atomic_replacement(target, raw):
    fd, temp = tempfile.mkstemp(prefix=".unapproved-refresh-", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, target)
        dfd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def backup_current(snapshot_data):
    require(BACKUP_ROOT.is_dir() and not BACKUP_ROOT.is_symlink(),
            "BACKUP_ROOT_UNAVAILABLE")
    output_dir = Path(tempfile.mkdtemp(prefix="genesis-signal-snapshot-", dir=BACKUP_ROOT))
    output_dir.chmod(0o700)
    backup = output_dir / "unapproved-projection.json"
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(snapshot_data)
        stream.flush()
        os.fsync(stream.fileno())
    require(verify_regular_root(backup, mode=0o600, max_size=MAX_OUTPUT_BYTES)
            == snapshot_data, "SNAPSHOT_BACKUP_FAILED")
    print("BACKUP_PATH=" + str(backup), flush=True)
    print("BACKUP_SHA256=" + sha256(snapshot_data), flush=True)
    return backup


def refresh():
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    verify_root_dir(STAGING_DIR, 0o700)
    prior = verify_regular_root(SNAPSHOT, mode=0o600, max_size=MAX_OUTPUT_BYTES)
    # Block a concurrent refresh. Neither lock nor key is readable to non-root.
    fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        key, created = private_key(KEY_FILE, create=True)
        raw = project_snapshot(key)
        if created:
            # Verify stable identity deterministically against the same source.
            second = project_snapshot(key)
            first_ids = [(x["id"], x["asset"], x["side"])
                         for x in json.loads(raw)["signals"]]
            second_ids = [(x["id"], x["asset"], x["side"])
                          for x in json.loads(second)["signals"]]
            require(first_ids == second_ids, "IDENTIFIER_STABILITY_FAILED")
        backup_current(prior)
        atomic_replacement(SNAPSHOT, raw)
        require(verify_regular_root(SNAPSHOT, mode=0o600, max_size=MAX_OUTPUT_BYTES)
                == raw, "SNAPSHOT_READBACK_FAILED")
        safe = json.loads(raw)
        print("STABLE_ID_KEY=ROOT_ONLY")
        print("STABLE_ID_CHECK=PASS")
        print("NEW_SNAPSHOT_SHA256=" + sha256(raw))
        print("SIGNAL_COUNT=" + str(len(safe["signals"])))
        print("VERIFIED_PAPER_OPEN=" + str(sum(
            row["stage"] == "PAPER_OPEN" for row in safe["signals"]
        )))
        print("SNAPSHOT_SCOPE=STAGING_NOT_APPROVED")
        print("SNAPSHOT_READBACK=PASS")
        print("RUNNING_SERVICE_RESTARTED=NO")
        print("NGINX_CONFIG_MODIFIED=NO")
        print("TRADING_CONFIG_MODIFIED=NO")
        print("PUBLICATION_ENABLED=NO")
        print("PRIVATE_REFRESH=PASS")
    finally:
        os.close(fd)


def check():
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    verify_root_dir(STAGING_DIR, 0o700)
    prior = verify_regular_root(SNAPSHOT, mode=0o600, max_size=MAX_OUTPUT_BYTES)
    if KEY_FILE.exists() or KEY_FILE.is_symlink():
        key, _ = private_key(KEY_FILE)
        print("STABLE_ID_KEY=EXISTS", flush=True)
    else:
        key = os.urandom(32)
        print("STABLE_ID_KEY=NOT_INITIALIZED", flush=True)
    raw = project_snapshot(key)
    safe = json.loads(raw)
    print("PRIVATE_REFRESH_PREFLIGHT=PASS")
    print("EXISTING_SNAPSHOT_SHA256=" + sha256(prior))
    print("SANITISED_SIGNALS=" + str(len(safe["signals"])))
    print("VERIFIED_PAPER_OPEN=" + str(sum(
        row["stage"] == "PAPER_OPEN" for row in safe["signals"]
    )))
    print("FILES_MODIFIED=NONE")


def main():
    parser = argparse.ArgumentParser()
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--check", action="store_true")
    choice.add_argument("--refresh-private", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
    else:
        refresh()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("PRIVATE_REFRESH=BLOCKED")
        print("ERROR_TYPE=" + type(exc).__name__)
        if isinstance(exc, UnsafeRefresh):
            print("ERROR_CODE=" + str(exc))
        raise SystemExit(1)
