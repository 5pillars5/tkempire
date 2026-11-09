#!/usr/bin/env python3
"""Strictly read-only, value-free Genesis PAPER closing ledger reconciliation.

No ledger values, trade identifiers, monetary amounts, addresses, raw event
records, passwords, or strategy content are emitted. Returns aggregate
counts, schema readiness, and SHA-256 only. Zero state mutations.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
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

def main():
    events, digest=load()
    counts=summarize(events)
    print("=== GENESIS PAPER CLOSE RECONCILIATION ===")
    print("LEDGER_SHA256="+digest)
    for key, value in counts.items():
        print(str(key)+"="+str(value))
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
