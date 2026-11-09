#!/usr/bin/env python3
"""Genesis Signals: one-time PRIVATE sanitised snapshot, not a publisher.

Reads private Genesis files through the already tested, pinned projector.
Writes only allowlisted signal fields to a root-only staging directory.
No scheduler, Nginx route change, public reader permissions or publication.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile

PINNED_SOURCE = Path("/root/tkempire/research/genesis_public_signals_staging/publisher.py")
SOURCE_SHA256 = "4ed81f93c11891310eab4ad8093adf26cae2ffdab676839eea666bf79fd23d4c"
PRIVATE_DIR = Path("/var/lib/tkempire-genesis-signals-staging")
PRIVATE_FILE = PRIVATE_DIR / "unapproved-projection.json"
MAX_BYTES = 60_000
ROOT_FIELDS = {
    "schema_version", "source", "publication_scope", "execution_authority",
    "generated_at", "engine", "position_verification", "signals"
}
SIGNAL_FIELDS = {
    "id", "asset", "side", "stage", "observed_at", "confidence",
    "trigger", "stop_loss", "target", "reason_code", "position_evidence"
}
STAGES = {"QUALIFIED", "PAPER_OPEN"}
REASONS = {"CHECKS_PASSED"}
ISO = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$")
ASSET = re.compile(r"^[A-Z0-9]{2,15}$")
ID = re.compile(r"^[a-f0-9]{32}$")


class UnsafeSnapshot(Exception):
    pass


def require(ok, code):
    if not ok:
        raise UnsafeSnapshot(code)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def pinned_projector(path=PINNED_SOURCE):
    require(path.is_file() and not path.is_symlink(), "PROJECTOR_NOT_REGULAR")
    data = path.read_bytes()
    require(sha256(data) == SOURCE_SHA256, "PROJECTOR_SHA_MISMATCH")
    spec = importlib.util.spec_from_file_location("pinned_genesis_projector", str(path))
    require(spec and spec.loader, "PROJECTOR_LOAD_UNAVAILABLE")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def utc_time(value, now):
    require(isinstance(value, str) and ISO.fullmatch(value), "INVALID_TIMESTAMP")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise UnsafeSnapshot("INVALID_TIMESTAMP") from exc
    age = (now - parsed.astimezone(timezone.utc)).total_seconds()
    require(-30 <= age <= 90 * 86400, "TIMESTAMP_OUT_OF_RANGE")
    return value


def numeric(value, *, low, high):
    if value is None:
        return None
    require(type(value) in (float, int) and math.isfinite(value), "UNSAFE_NUMBER")
    require(low <= value <= high, "NUMBER_OUT_OF_RANGE")
    return value


def sanitise(projection, now):
    """Only fixed keys and safe types survive; no source path or private ID."""
    require(isinstance(projection, dict), "PROJECTION_NOT_OBJECT")
    require(set(projection) == ROOT_FIELDS, "PROJECTION_ROOT_FIELDS_UNEXPECTED")
    require(projection["schema_version"] == 1, "BAD_SCHEMA_VERSION")
    require(projection["source"] == "GENESIS_PUBLIC_SIGNAL_PROJECTION", "BAD_SOURCE")
    require(projection["publication_scope"] == "PUBLIC_APPROVED", "BAD_SOURCE_SCOPE")
    require(projection["execution_authority"] == "none", "EXECUTION_AUTHORITY_UNSAFE")
    require(projection["position_verification"] == "verified", "POSITION_UNVERIFIED")
    generated_at = utc_time(projection["generated_at"], now)
    generated_age = (now - datetime.fromisoformat(generated_at.replace("Z","+00:00"))).total_seconds()
    require(generated_age <= 120, "GENERATED_AT_STALE")
    require(projection["engine"] == {"mode": "paper", "running": True}, "ENGINE_NOT_PAPER")
    rows = projection["signals"]
    require(isinstance(rows, list) and len(rows) <= 50, "UNSAFE_SIGNAL_COUNT")
    seen = set()
    result_rows = []
    for item in rows:
        require(isinstance(item, dict) and set(item).issubset(SIGNAL_FIELDS),
                "UNSAFE_SIGNAL_FIELDS")
        require({"id","asset","side","stage","observed_at","reason_code"}.issubset(item),
                "SIGNAL_REQUIRED_FIELDS_MISSING")
        require(isinstance(item["id"], str) and ID.fullmatch(item["id"]), "BAD_SIGNAL_ID")
        require(item["id"] not in seen, "DUPLICATE_SIGNAL_ID")
        seen.add(item["id"])
        require(isinstance(item["asset"], str) and ASSET.fullmatch(item["asset"]),
                "BAD_ASSET")
        require(item["side"] in {"BUY", "SELL"}, "BAD_SIDE")
        require(item["stage"] in STAGES, "BAD_STAGE")
        utc_time(item["observed_at"], now)
        require(item["reason_code"] in REASONS, "UNEXPECTED_REASON")
        if item["stage"] == "PAPER_OPEN":
            require(item.get("position_evidence") == "CANONICAL_PAPER_LEDGER",
                    "PAPER_POSITION_UNVERIFIED")
        else:
            require("position_evidence" not in item, "UNEXPECTED_POSITION_EVIDENCE")
        numeric(item.get("confidence"), low=0, high=100)
        for field in ("trigger", "stop_loss", "target"):
            numeric(item.get(field), low=0, high=1e9)
        # Explicit projection; do not serialize source objects.
        result_rows.append({key: item[key] for key in sorted(item)})
    output = {
        "schema_version": 1,
        "source": "GENESIS_PUBLIC_SIGNAL_PROJECTION",
        "publication_scope": "STAGING_NOT_APPROVED",
        "execution_authority": "none",
        "generated_at": generated_at,
        "engine": {"mode": "paper", "running": True},
        "position_verification": "verified",
        "signals": result_rows,
    }
    raw = (json.dumps(output, sort_keys=True, separators=(",", ":"), allow_nan=False)
           + "\n").encode("utf-8")
    require(len(raw) <= MAX_BYTES, "PROJECTION_TOO_LARGE")
    return raw


def private_stage(raw):
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    require(not PRIVATE_DIR.exists(), "STAGING_PATH_ALREADY_EXISTS")
    PRIVATE_DIR.mkdir(mode=0o700)
    try:
        os.chmod(PRIVATE_DIR, 0o700)
        fd = os.open(PRIVATE_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb") as writer:
                writer.write(raw)
                writer.flush()
                os.fsync(writer.fileno())
        except Exception:
            PRIVATE_FILE.unlink(missing_ok=True)
            raise
        os.chmod(PRIVATE_FILE, 0o600)
        st = PRIVATE_FILE.stat()
        require(stat.S_ISREG(st.st_mode) and st.st_uid == 0
                and stat.S_IMODE(st.st_mode) == 0o600, "UNSAFE_STAGED_PERMISSIONS")
        require(PRIVATE_FILE.read_bytes() == raw, "SNAPSHOT_READBACK_MISMATCH")
        print("PRIVATE_SNAPSHOT_PATH=" + str(PRIVATE_FILE))
        print("PRIVATE_SNAPSHOT_SHA256=" + sha256(raw))
        print("PRIVATE_DIR_MODE=0700")
        print("PRIVATE_FILE_MODE=0600")
        print("STAGED_SNAPSHOT_READBACK=PASS")
    except Exception:
        PRIVATE_FILE.unlink(missing_ok=True)
        PRIVATE_DIR.rmdir()
        raise


def main():
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true")
    action.add_argument("--stage-private", action="store_true")
    args = parser.parse_args()

    if args.stage_private:
        require(os.geteuid() == 0, "ROOT_REQUIRED")
        require(not PRIVATE_DIR.exists(), "STAGING_PATH_ALREADY_EXISTS")

    module = pinned_projector()
    now = datetime.now(timezone.utc)
    # Ephemeral key for UNAPPROVED staging; no stable identifier is released.
    # A separate reviewed mechanism is required before production publication.
    output = module.project(module.ROOT, module.health(), os.urandom(32), now=now)
    raw = sanitise(output, now)
    public_fields = json.loads(raw)
    print("SANITISED_PROJECTION=PASS")
    print("SIGNAL_COUNT=" + str(len(public_fields["signals"])))
    print("VERIFIED_PAPER_OPEN=" + str(sum(
        s["stage"] == "PAPER_OPEN" for s in public_fields["signals"]
    )))
    print("STAGING_PUBLICATION_SCOPE=STAGING_NOT_APPROVED")
    print("TRADING_CONFIG_MODIFIED=NO")
    if args.check:
        print("FILES_MODIFIED=NONE")
        return
    private_stage(raw)
    print("PUBLIC_DATA_ACCESS=NOT_GRANTED")
    print("NGINX_CONFIG_MODIFIED=NO")
    print("STAGING_EXPORT=PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("STAGING_EXPORT=BLOCKED")
        print("ERROR_CLASS=" + type(exc).__name__)
        raise SystemExit(1)
