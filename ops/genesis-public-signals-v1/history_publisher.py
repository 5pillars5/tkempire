#!/usr/bin/env python3
"""Independent, fail-closed, read-only Genesis PAPER closed-history publisher.

Not installed or authorized by committing this file. Requires private, root-only
HMAC key, fresh Genesis paper health, explicit publication gate and authenticated
reverse proxy before a public request can succeed. Never serves a raw ledger.
"""
from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit, parse_qs
from urllib.request import Request, urlopen

ROOT = Path("/root/tkempire/data")
LEDGER = ROOT / "genesis/trade_lifecycle_ledger.json"
KEY = Path("/var/lib/tkempire-genesis-signals-staging/signal-id-hmac.key")
HEALTH = "http://127.0.0.1:5000/health"
HOST, PORT = "127.0.0.1", 5098
MAX_BYTES, MAX_EVENTS, PAGE_SIZE = 5_000_000, 20000, 50
ASSET = re.compile(r"^[A-Z0-9]{2,15}$")
PAGE = re.compile(r"^[1-9][0-9]{0,3}$")


class Blocked(Exception):
    pass


def require(test, name):
    if not test:
        raise Blocked(name)


def secure_read(path, maximum, mode=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and
                0 <= before.st_size <= maximum, "UNSAFE_FILE")
        if mode is not None:
            require(stat.S_IMODE(before.st_mode) == mode, "UNSAFE_PERMISSIONS")
        with os.fdopen(os.dup(fd), "rb") as stream:
            raw = stream.read(maximum + 1)
        after = os.fstat(fd)
        require(len(raw) <= maximum and before.st_size == after.st_size and
                before.st_mtime_ns == after.st_mtime_ns, "UNSTABLE_FILE")
        return raw
    finally:
        os.close(fd)


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        d = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return d.astimezone(timezone.utc) if d.tzinfo is not None else None
    except (ValueError, OverflowError, TypeError):
        return None


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def valid_price(v):
    return type(v) in (int, float) and math.isfinite(v) and 0 < v <= 1e9


def valid_pnl(v):
    return type(v) in (int, float) and math.isfinite(v) and abs(v) <= 1e9


def matched(opening, closing, now):
    if not (opening.get("coin") == closing.get("coin") and
            opening.get("direction") == closing.get("direction") and
            closing.get("direction") in ("BUY", "SELL")):
        return False
    entry = opening.get("entry_price")
    if not (valid_price(entry) and valid_price(closing.get("entry_price")) and
            valid_price(closing.get("exit_price")) and valid_pnl(closing.get("pnl"))):
        return False
    if abs(entry-closing["entry_price"]) > max(1e-8, abs(entry)*1e-5):
        return False
    a, b = timestamp(opening.get("opened_at")), timestamp(closing.get("opened_at"))
    c = timestamp(closing.get("closed_at"))
    if not a or not b or not c or abs((a-b).total_seconds()) > 300 or c < b or c > now:
        return False
    result = closing.get("result")
    pnl = closing["pnl"]
    return (result in ("WIN", "LOSS", "BREAKEVEN") and
            (pnl > 0 and result == "WIN" or
             pnl < 0 and result == "LOSS" or
             pnl == 0 and result == "BREAKEVEN"))


def project(events, key, raw_ledger, page=1, now=None):
    now = now or datetime.now(timezone.utc)
    require(type(page) is int and 1 <= page <= 400, "INVALID_PAGE")
    require(isinstance(events, list) and len(events) <= MAX_EVENTS, "INVALID_EVENTS")
    require(isinstance(key, bytes) and len(key) == 32, "INVALID_HMAC_KEY")

    opened, closes = defaultdict(list), defaultdict(list)
    total_closed = 0
    for row in events:
        if not isinstance(row, dict):
            continue
        kind = row.get("event_type")
        if kind not in ("OPENED", "CLOSED_RECORDED"):
            continue
        if kind == "CLOSED_RECORDED":
            total_closed += 1
        trade_key = row.get("trade_key")
        if not isinstance(trade_key, str) or not 4 <= len(trade_key) <= 256:
            continue
        (opened if kind == "OPENED" else closes)[trade_key].append(row)

    verified = []
    for trade_key, group in closes.items():
        beginning = opened.get(trade_key, ())
        if len(group) != 1 or len(beginning) != 1:
            continue
        a, b = beginning[0], group[0]
        if not matched(a, b, now):
            continue
        symbol = a.get("coin")
        if not isinstance(symbol, str) or not ASSET.fullmatch(symbol):
            continue
        start, end = timestamp(a["opened_at"]), timestamp(b["closed_at"])
        if not start or not end or end < start:
            continue
        public_id = hmac.new(
            key, ("genesis-paper-close-v1|" + trade_key).encode(),
            hashlib.sha256).hexdigest()[:32]
        verified.append({
            "id": public_id, "asset": symbol, "side": a["direction"],
            "stage": "PAPER_CLOSED",
            "observed_at": iso(start), "closed_at": iso(end),
            "trigger": a["entry_price"], "exit_price": b["exit_price"],
            "realized_pnl": b["pnl"], "pnl_unit": "LEDGER_UNIT_UNVERIFIED",
            "result": b["result"], "close_reason": "OTHER",
            "position_evidence": "CANONICAL_PAPER_LEDGER",
            "close_evidence": "CANONICAL_CLOSED_PAPER_LEDGER",
        })
    verified.sort(key=lambda v: (v["closed_at"], v["observed_at"], v["id"]), reverse=True)
    require(len({v["id"] for v in verified}) == len(verified), "DUPLICATE_PUBLIC_ID")
    # A private-keyed revision detects mid-pagination ledger mutations without
    # revealing the raw ledger digest or canonical trade identities.
    revision = hmac.new(key, b"genesis-history-v1|" + hashlib.sha256(raw_ledger).digest(),
                        hashlib.sha256).hexdigest()
    offset = (page-1)*PAGE_SIZE
    rows = verified[offset:offset+PAGE_SIZE]
    return {
        "schema_version": 1, "source": "GENESIS_VERIFIED_PAPER_HISTORY_V1",
        "publication_scope": "PUBLIC_APPROVED", "execution_authority": "none",
        "generated_at": iso(now), "engine": {"mode":"paper", "running":True},
        "pnl_unit": "LEDGER_UNIT_UNVERIFIED", "revision":revision,
        "page":page, "page_size":PAGE_SIZE,
        "verified_count":len(verified), "excluded_count":total_closed-len(verified),
        "total_closed_count":total_closed, "has_more":page*PAGE_SIZE<len(verified),
        "closed_trades":rows,
    }


def fresh_health(now):
    request = Request(HEALTH, headers={"Accept":"application/json"}, method="GET")
    with urlopen(request, timeout=2) as response:
        require(response.status == 200, "HEALTH_UNAVAILABLE")
        raw = response.read(65537)
    require(len(raw) <= 65536, "HEALTH_OVERSIZED")
    health = json.loads(raw)
    engine = health.get("engine") if isinstance(health, dict) else None
    when = timestamp(health.get("served_at")) if isinstance(health, dict) else None
    require(isinstance(engine, dict) and engine.get("mode") == "paper" and
            engine.get("running") is True and when is not None and
            -30 <= (now-when).total_seconds() <= 120, "HEALTH_NOT_VERIFIED")


def snapshot(page):
    now = datetime.now(timezone.utc)
    fresh_health(now)
    key = secure_read(KEY, 32, mode=0o600)
    require(len(key) == 32, "BAD_HMAC_KEY")
    raw = secure_read(LEDGER, MAX_BYTES)
    return project(json.loads(raw), key, raw, page=page, now=now)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code, data):
        raw = json.dumps(data, separators=(",", ":"), allow_nan=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if os.environ.get("GENESIS_HISTORY_PUBLISH_ENABLED") != "true":
            return self.reply(503, {"status":"publication_disabled"})
        target = urlsplit(self.path)
        if target.path != "/history":
            return self.reply(404, {"status":"not_found"})
        args = parse_qs(target.query)
        if set(args) != {"page"} or len(args["page"]) != 1 or not PAGE.fullmatch(args["page"][0]):
            return self.reply(400, {"status":"invalid_page"})
        page = int(args["page"][0])
        if page > 400:
            return self.reply(400, {"status":"invalid_page"})
        try:
            result = snapshot(page)
            require(len(json.dumps(result).encode()) <= 65536, "HISTORY_TOO_LARGE")
            return self.reply(200, result)
        except Exception:
            return self.reply(503, {"status":"history_unverified"})

    def do_POST(self):
        self.reply(405, {"status":"method_not_allowed"})

    do_PUT = do_PATCH = do_DELETE = do_POST


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
