#!/usr/bin/env python3
"""Strictly read-only, value-free Genesis PAPER closing ledger reconciliation.

No ledger values, trade identifiers, monetary amounts, addresses, raw event
records, passwords, or strategy content are emitted. Returns aggregate
counts, schema readiness, and SHA-256 only. Zero state mutations.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import argparse
import hashlib
import hmac
import json
import math
import re
import os
from pathlib import Path
import stat

LEDGER = Path("/root/tkempire/data/genesis/trade_lifecycle_ledger.json")
MAX_BYTES = 5_000_000
ALLOWED_RESULTS = {"WIN", "LOSS", "BREAKEVEN"}
ACCOUNTING_KEYS = {
    "pnl_unit", "pnl_units", "fee", "fees", "funding", "net_pnl",
    "gross_pnl", "quantity", "qty", "size", "units", "exit_reason",
    "close_reason", "reason", "net_realized_pnl", "gross_realized_pnl"
}

def is_price(v):
    return type(v) in (int, float) and math.isfinite(v) and 0 < v <= 1e9

def is_pnl(v):
    return type(v) in (int, float) and math.isfinite(v) and abs(v) <= 1e9

def parse_time(v):
    if not isinstance(v, str):
        return None
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
        return d.astimezone(timezone.utc) if d.tzinfo else None
    except (ValueError, OverflowError, TypeError):
        return None

def valid_key(row):
    key = row.get("trade_key")
    return key if isinstance(key, str) and 4 <= len(key) <= 256 else None

def safe_result(row):
    value = row.get("result")
    return value.strip().upper() if isinstance(value, str) else "OTHER"

def matched(open_event, close_event, now):
    if open_event.get("coin") != close_event.get("coin"):
        return False
    if open_event.get("direction") != close_event.get("direction"):
        return False
    if close_event.get("direction") not in ("BUY", "SELL"):
        return False
    entry_a = open_event.get("entry_price")
    entry_b = close_event.get("entry_price")
    exit_price = close_event.get("exit_price")
    pnl = close_event.get("pnl")
    if not (is_price(entry_a) and is_price(entry_b)
            and is_price(exit_price) and is_pnl(pnl)):
        return False
    if abs(entry_a - entry_b) > max(1e-8, abs(entry_a) * 1e-5):
        return False
    a = parse_time(open_event.get("opened_at"))
    b = parse_time(close_event.get("opened_at"))
    c = parse_time(close_event.get("closed_at"))
    if not a or not b or not c:
        return False
    if abs((a-b).total_seconds()) > 300:
        return False
    if c < b or (c-now).total_seconds() > 30:
        return False
    label = safe_result(close_event)
    if label not in ALLOWED_RESULTS:
        return False
    if (pnl > 0 and label != "WIN"
            or pnl < 0 and label != "LOSS"
            or pnl == 0 and label != "BREAKEVEN"):
        return False
    return True

def summarize(events, now=None):
    now = now or datetime.now(timezone.utc)
    if not isinstance(events, list) or len(events) > 20000:
        raise ValueError("ledger_schema")
    opens = [x for x in events if isinstance(x, dict)
             and x.get("event_type") == "OPENED"]
    closes = [x for x in events if isinstance(x, dict)
              and x.get("event_type") == "CLOSED_RECORDED"]
    opening_groups, closing_groups = defaultdict(list), defaultdict(list)
    for row in opens:
        key = valid_key(row)
        if key:
            opening_groups[key].append(row)
    for row in closes:
        key = valid_key(row)
        if key:
            closing_groups[key].append(row)
    results = Counter()
    sign_inconsistencies = 0
    missing_accounting = 0
    matched_valid = 0
    matched_recent = 0
    unmatched_groups = 0
    invalid_fields = 0
    ambiguous_close_groups = 0
    unit_markers = set()
    for row in closes:
        results[safe_result(row) if safe_result(row) in ALLOWED_RESULTS else "OTHER"] += 1
        details = row.get("details")
        if isinstance(details, dict):
            unit_markers.update(k for k in details if k in ACCOUNTING_KEYS)
        unit_markers.update(k for k in row if k in ACCOUNTING_KEYS)
        pnl=row.get("pnl")
        if not is_pnl(pnl):
            missing_accounting+=1
        elif safe_result(row) in ALLOWED_RESULTS and (
            (pnl > 0 and safe_result(row) != "WIN") or
            (pnl < 0 and safe_result(row) != "LOSS") or
            (pnl == 0 and safe_result(row) != "BREAKEVEN")):
            sign_inconsistencies+=1
    for key, group in closing_groups.items():
        if len(group) != 1:
            ambiguous_close_groups += 1
            continue
        matches=opening_groups.get(key,[])
        if len(matches) != 1:
            unmatched_groups+=1
            continue
        o,c=matches[0],group[0]
        if not matched(o,c,now):
            invalid_fields+=1
            continue
        matched_valid += 1
        when=parse_time(c["closed_at"])
        if 0 <= (now-when).total_seconds() <= 90*86400:
            matched_recent+=1
    return {
        "TOTAL_LEDGER_EVENTS": len(events),
        "OPEN_EVENT_COUNT":len(opens),
        "CLOSE_EVENT_COUNT":len(closes),
        "UNIQUE_OPEN_TRADE_KEYS":len(opening_groups),
        "UNIQUE_CLOSE_TRADE_KEYS":len(closing_groups),
        "DUPLICATE_OPEN_KEY_GROUPS":sum(len(v)>1 for v in opening_groups.values()),
        "DUPLICATE_CLOSE_KEY_GROUPS":ambiguous_close_groups,
        "CLOSED_WITHOUT_UNIQUE_OPEN":unmatched_groups,
        "CLOSE_DETAILS_MISMATCH_OR_INVALID":invalid_fields,
        "ELIGIBLE_ONE_TO_ONE_CLOSED_RESULTS":matched_valid,
        "ELIGIBLE_RECENT_90D_CLOSED_RESULTS":matched_recent,
        "CLOSE_RESULT_WIN":results["WIN"],
        "CLOSE_RESULT_LOSS":results["LOSS"],
        "CLOSE_RESULT_BREAKEVEN":results["BREAKEVEN"],
        "CLOSE_RESULT_OTHER":results["OTHER"],
        "P_AND_L_MISSING_OR_NONFINITE":missing_accounting,
        "P_AND_L_RESULT_SIGN_MISMATCH":sign_inconsistencies,
        "ACCOUNTING_FIELD_NAMES_PRESENT":",".join(sorted(unit_markers)) or "NONE",
    }

def load(path=LEDGER):
    if path.is_symlink():
        raise ValueError("symlink_ledger")
    fd = os.open(path, os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
    try:
        initial=os.fstat(fd)
        if (not stat.S_ISREG(initial.st_mode) or initial.st_size > MAX_BYTES):
            raise ValueError("file_invalid")
        with os.fdopen(os.dup(fd), "rb") as stream:
            raw=stream.read(MAX_BYTES+1)
        final=os.fstat(fd)
        if (len(raw)>MAX_BYTES or initial.st_size!=final.st_size
                or initial.st_mtime_ns!=final.st_mtime_ns):
            raise ValueError("ledger_changed_during_read")
    finally:
        os.close(fd)
    return json.loads(raw), hashlib.sha256(raw).hexdigest()

# A separate, explicitly unapproved PAPER_CLOSED projection. The live Genesis
# website/publisher is untouched until an independent VPS readback approves it.
PRIVATE_ID_KEY = Path("/var/lib/tkempire-genesis-signals-staging/signal-id-hmac.key")
MAX_CLOSED_ROWS = 50
MAX_PROJECTED_BYTES = 60000
RECENT_SECONDS = 90 * 86400
SYMBOL = re.compile(r"^[A-Z0-9]{2,15}$")
OPAQUE_ID = re.compile(r"^[a-f0-9]{32}$")
PROJECTED_FIELDS = {
    "id", "asset", "side", "stage", "observed_at", "trigger",
    "stop_loss", "target", "confidence", "reason_code", "position_evidence",
    "close_evidence", "closed_at", "exit_price", "realized_pnl", "pnl_unit",
    "result", "close_reason",
}
ROOT_FIELDS = {
    "schema_version", "source", "publication_scope", "execution_authority",
    "generated_at", "closed_trades",
}


def read_private_id_key(path=PRIVATE_ID_KEY):
    """Root-owned 0600 key, opened read-only without following symlinks."""
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        first = os.fstat(fd)
        if not (stat.S_ISREG(first.st_mode) and first.st_uid == 0
                and stat.S_IMODE(first.st_mode) == 0o600 and first.st_size == 32):
            raise ValueError("invalid_private_hmac_key")
        with os.fdopen(os.dup(fd), "rb") as stream:
            raw = stream.read(33)
        second = os.fstat(fd)
        if len(raw) != 32 or (first.st_mtime_ns != second.st_mtime_ns
                             or first.st_size != second.st_size):
            raise ValueError("private_key_changed")
        return raw
    finally:
        os.close(fd)


def utc_text(value):
    value = value.astimezone(timezone.utc)
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


def eligible_close_rows(events, now):
    """Yield only distinct one-to-one canonical open+close matches."""
    if not isinstance(events, list) or len(events) > 20000:
        raise ValueError("ledger_schema")
    opened, closed = defaultdict(list), defaultdict(list)
    for row in events:
        if not isinstance(row, dict):
            continue
        key = valid_key(row)
        if not key:
            continue
        if row.get("event_type") == "OPENED":
            opened[key].append(row)
        elif row.get("event_type") == "CLOSED_RECORDED":
            closed[key].append(row)
    for key, closing in closed.items():
        start = opened.get(key, ())
        if len(start) != 1 or len(closing) != 1:
            continue
        opening, finish = start[0], closing[0]
        if not matched(opening, finish, now):
            continue
        asset = opening.get("coin")
        if not isinstance(asset, str) or not SYMBOL.fullmatch(asset):
            continue
        started = parse_time(opening["opened_at"])
        ended = parse_time(finish["closed_at"])
        if not started or not ended or started > ended:
            continue
        # The public API's observed_at retention is 90 days. Retain the same
        # boundary here, rather than manipulating the original open timestamp.
        if not (0 <= (now-started).total_seconds() <= RECENT_SECONDS and
                0 <= (now-ended).total_seconds() <= RECENT_SECONDS):
            continue
        # Check the original recorded outcome against the signed P&L. Do not
        # infer it from an exit price; no currency/fees are asserted.
        label = safe_result(finish)
        if label not in ALLOWED_RESULTS:
            continue
        yield key, opening, finish, started, ended, label


def project_verified_closes(events, id_key, now=None, limit=MAX_CLOSED_ROWS):
    """Sanitized, bounded, stable HMAC PAPER_CLOSED records; no file writes.

    Records are STAGING_ONLY, with an explicitly unknown ledger P&L unit.
    This is not authorized for publication solely by creating the projection.
    """
    now = now or datetime.now(timezone.utc)
    if not isinstance(id_key, bytes) or len(id_key) != 32:
        raise ValueError("private_key_invalid")
    if not isinstance(limit, int) or not 1 <= limit <= MAX_CLOSED_ROWS:
        raise ValueError("projection_limit")
    matches = list(eligible_close_rows(events, now))
    matches.sort(key=lambda entry: (entry[4], entry[3]), reverse=True)
    rows, seen = [], set()
    for key, opening, closing, started, ended, result in matches[:limit]:
        identifier = hmac.new(id_key,
                              ("genesis-paper-close-v1|" + key).encode("utf-8"),
                              hashlib.sha256).hexdigest()[:32]
        if identifier in seen:
            raise ValueError("duplicate_public_id")
        seen.add(identifier)
        row = {
            "id": identifier,
            "asset": opening["coin"],
            "side": opening["direction"],
            "stage": "PAPER_CLOSED",
            "observed_at": utc_text(started),
            "trigger": opening["entry_price"],
            "stop_loss": None,
            "target": None,
            "confidence": None,
            "reason_code": "CHECKS_PASSED",
            "position_evidence": "CANONICAL_PAPER_LEDGER",
            "close_evidence": "CANONICAL_CLOSED_PAPER_LEDGER",
            "closed_at": utc_text(ended),
            "exit_price": closing["exit_price"],
            "realized_pnl": closing["pnl"],
            "pnl_unit": "LEDGER_UNIT_UNVERIFIED",
            "result": result,
            "close_reason": "OTHER",
        }
        rows.append(row)
    projection = {
        "schema_version": 1,
        "source": "GENESIS_VERIFIED_CLOSED_PAPER_PROJECTION",
        "publication_scope": "PRIVATE_DRY_RUN_ONLY",
        "execution_authority": "none",
        "generated_at": utc_text(now),
        "closed_trades": rows,
    }
    verify_projected_closes(projection, now)
    return projection


def verify_projected_closes(projection, now):
    if not (isinstance(projection, dict)
            and set(projection) == ROOT_FIELDS
            and projection["schema_version"] == 1
            and projection["source"] == "GENESIS_VERIFIED_CLOSED_PAPER_PROJECTION"
            and projection["publication_scope"] == "PRIVATE_DRY_RUN_ONLY"
            and projection["execution_authority"] == "none"):
        raise ValueError("projection_schema")
    stamp = parse_time(projection["generated_at"])
    if not stamp or abs((now-stamp).total_seconds()) > 30:
        raise ValueError("projection_timestamp")
    rows = projection["closed_trades"]
    if not isinstance(rows, list) or len(rows) > MAX_CLOSED_ROWS:
        raise ValueError("projection_unbounded")
    previous = None
    used = set()
    for row in rows:
        if not (isinstance(row, dict) and set(row) == PROJECTED_FIELDS
                and row["stage"] == "PAPER_CLOSED"
                and row["position_evidence"] == "CANONICAL_PAPER_LEDGER"
                and row["close_evidence"] == "CANONICAL_CLOSED_PAPER_LEDGER"
                and row["reason_code"] == "CHECKS_PASSED"
                and row["pnl_unit"] == "LEDGER_UNIT_UNVERIFIED"
                and row["close_reason"] == "OTHER"):
            raise ValueError("projection_row_schema")
        identifier = row["id"]
        if not isinstance(identifier, str) or not OPAQUE_ID.fullmatch(identifier):
            raise ValueError("projection_id")
        if identifier in used:
            raise ValueError("projection_duplicate")
        used.add(identifier)
        if not (isinstance(row["asset"], str) and SYMBOL.fullmatch(row["asset"])
                and row["side"] in ("BUY", "SELL")
                and row["stop_loss"] is None and row["target"] is None
                and row["confidence"] is None):
            raise ValueError("projection_asset_or_private_data")
        a, b = parse_time(row["observed_at"]), parse_time(row["closed_at"])
        if not a or not b or not a <= b or not 0 <= (now-b).total_seconds() <= RECENT_SECONDS:
            raise ValueError("projection_time")
        if (previous is not None and b > previous):
            raise ValueError("projection_order")
        previous = b
        if not (is_price(row["trigger"]) and is_price(row["exit_price"])
                and is_pnl(row["realized_pnl"])
                and row["result"] in ALLOWED_RESULTS):
            raise ValueError("projection_numeric")
        value = row["realized_pnl"]
        if (value > 0 and row["result"] != "WIN"
                or value < 0 and row["result"] != "LOSS"
                or value == 0 and row["result"] != "BREAKEVEN"):
            raise ValueError("projection_result_mismatch")
    raw = json.dumps(projection, separators=(",", ":"), sort_keys=True,
                     allow_nan=False).encode("utf-8")
    if len(raw) > MAX_PROJECTED_BYTES:
        raise ValueError("projection_size")
    # Readback in memory; never produce a file or log raw rows.
    if json.loads(raw) != projection:
        raise ValueError("projection_readback")
    for forbidden in (b"trade_key", b"event_id", b"empire_trade_id",
                      b"admission_fingerprint", b"private_signature",
                      b"wallet_address"):
        if forbidden in raw:
            raise ValueError("private_field_detected")
    return hashlib.sha256(raw).hexdigest()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--verify-projection", action="store_true",
                        help="In-memory closed-trade projection test, no file writes")
    args=parser.parse_args()
    events, digest=load()
    counts=summarize(events)
    print("=== GENESIS PAPER CLOSE RECONCILIATION ===")
    print("LEDGER_SHA256="+digest)
    for key, value in counts.items():
        print(str(key)+"="+str(value))
    if args.verify_projection:
        print("=== VERIFIED CLOSED PROJECTION DRY RUN ===")
        key=read_private_id_key()
        now=datetime.now(timezone.utc)
        result=project_verified_closes(events,key,now=now)
        digest=verify_projected_closes(result,now)
        print("PROJECTED_CLOSED_ROWS="+str(len(result["closed_trades"])))
        print("PROJECTION_SCHEMA=PASS")
        print("HMAC_OPAQUE_IDS=PASS")
        print("UNKNOWN_PNL_UNIT_LABELED=PASS")
        print("PROJECTION_READBACK=PASS")
        print("PROJECTION_SHA256="+digest)
        print("PROJECTION_SCOPE=PRIVATE_DRY_RUN_ONLY")
        print("PUBLIC_FEED_MODIFIED=NO")
    print("DATA_VALUES_PRINTED=NONE")
    print("FILES_MODIFIED=NONE")
    print("TRADING_CONFIGURATION_MODIFIED=NO")
    print("PUBLICATION_MODIFIED=NO")

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("RECONCILIATION=BLOCKED")
        print("ERROR_CLASS="+type(exc).__name__)
        raise SystemExit(1)
