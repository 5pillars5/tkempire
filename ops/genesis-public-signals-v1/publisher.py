#!/usr/bin/env python3
"""Read-only, loopback-only Genesis PAPER signal projection.

NOT an installer. Defaults to disabled. Does not change trade state or send orders.
The separate authenticated Nginx /internal/genesis/signals route MUST be reviewed
before it is enabled; a Vercel publication feature gate is also required.
"""
from __future__ import annotations

import argparse
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
from urllib.request import Request, urlopen

ROOT = Path("/root/tkempire/data")
HEALTH_URL = "http://127.0.0.1:5000/health"
HOST, PORT = "127.0.0.1", 5097
MAX_BYTES = 2_000_000
MAX_OUTPUT_BYTES = 60_000
COIN_RE = re.compile(r"^[A-Z0-9]{2,15}$")
PAIR_RE = re.compile(r"^([A-Z0-9]{2,15})/[A-Z0-9]{2,12}$")
ALLOWED_SIDES = {"BUY", "SELL"}


class Unverified(Exception):
    pass


def iso(value, *, now=None, max_age=None):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        try:
            value = datetime.fromtimestamp(
                value / 1000 if value > 10_000_000_000 else value, timezone.utc
            )
        except (ValueError, OverflowError, OSError):
            return None
    elif isinstance(value, str):
        try:
            # Naive source times are ambiguous; never silently assign UTC.
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime) or value.tzinfo is None:
        return None
    value = value.astimezone(timezone.utc)
    if now is not None:
        age = (now - value).total_seconds()
        if age < -30 or (max_age is not None and age > max_age):
            return None
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def price(value):
    return (round(value, 8) if type(value) in (int, float)
            and math.isfinite(value) and 0 < value <= 1e9 else None)


def score(value):
    return (round(value, 2) if type(value) in (int, float)
            and math.isfinite(value) and 0 <= value <= 100 else None)


def read_json(root, relative):
    path = root / relative
    # Explicitly disallow symlink inputs and suspicious files.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES:
            raise Unverified("invalid_source_file")
        with os.fdopen(os.dup(fd), "rb") as reader:
            raw = reader.read(MAX_BYTES + 1)
        after = os.fstat(fd)
        if (len(raw) > MAX_BYTES or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns):
            raise Unverified("source_changed_during_read")
        return json.loads(raw)
    finally:
        os.close(fd)


def close_price(a, b):
    a, b = price(a), price(b)
    return a is not None and b is not None and abs(a-b) <= max(1e-8, abs(a)*1e-5)


def same_trade(a, c):
    if not isinstance(a, dict) or not isinstance(c, dict):
        return False
    if str(a.get("coin", "")).upper() != str(c.get("coin", "")).upper():
        return False
    if str(a.get("action", "")).upper() != str(c.get("direction", "")).upper():
        return False
    if not close_price(a.get("entry"), c.get("entry_price")):
        return False
    x, y = iso(a.get("opened_at")), iso(c.get("opened_at"))
    return bool(x and y and abs((datetime.fromisoformat(x.replace("Z","+00:00")) -
                              datetime.fromisoformat(y.replace("Z","+00:00"))).total_seconds()) <= 300)


def eligible_health(health, now):
    if not isinstance(health, dict) or not isinstance(health.get("engine"), dict):
        raise Unverified("health_unavailable")
    engine = health["engine"]
    if str(engine.get("mode", "")).lower() != "paper" or engine.get("running") is not True:
        raise Unverified("paper_engine_not_running")
    if not iso(health.get("served_at"), now=now, max_age=120):
        raise Unverified("health_stale")


def project(root, health, id_key, now=None):
    now = now or datetime.now(timezone.utc)
    eligible_health(health, now)
    if not isinstance(id_key, bytes) or len(id_key) < 32:
        raise Unverified("missing_id_key")

    paths = [
        "signal_admission_state.json", "active_trades.json",
        "genesis/trade_lifecycle_state.json", "genesis/trade_lifecycle_ledger.json"
    ]
    before = {p: (root / p).stat().st_mtime_ns for p in paths}
    admission, active, lifecycle, ledger = [read_json(root, p) for p in paths]
    after = {p: (root / p).stat().st_mtime_ns for p in paths}
    if before != after:
        raise Unverified("inconsistent_source_snapshot")

    if not (isinstance(admission, dict) and isinstance(admission.get("records"), list)
            and len(admission["records"]) <= 10000
            and isinstance(active, list) and len(active) <= 100
            and isinstance(lifecycle, dict)
            and isinstance(lifecycle.get("canonical_active"), dict)
            and len(lifecycle["canonical_active"]) <= 100
            and isinstance(ledger, list) and len(ledger) <= 20000):
        raise Unverified("invalid_source_schema")

    by_fingerprint, signals = {}, {}
    for record in admission["records"]:
        if not isinstance(record, dict):
            continue
        fingerprint = record.get("fingerprint")
        pair = record.get("canonical_pair")
        side = str(record.get("side", "")).upper()
        if (not isinstance(fingerprint, str) or not 8 <= len(fingerprint) <= 256
                or not isinstance(pair, str) or not PAIR_RE.fullmatch(pair)
                or side not in ALLOWED_SIDES):
            continue
        observed = (iso(record.get("source_timestamp"), now=now, max_age=90*86400)
                    or iso(record.get("approved_at"), now=now, max_age=90*86400))
        if not observed:
            continue
        if fingerprint in by_fingerprint:
            # A duplicated admission identity is unsafe for position inference.
            raise Unverified("duplicate_admission_identity")
        public_id = hmac.new(id_key, ("genesis-public-v1|" + fingerprint).encode(),
                             hashlib.sha256).hexdigest()[:32]
        item = dict(
            id=public_id, asset=PAIR_RE.fullmatch(pair).group(1),
            side=side, stage="QUALIFIED", observed_at=observed,
            confidence=None, trigger=price(record.get("entry")),
            stop_loss=price(record.get("stop")), target=price(record.get("tp1")),
            reason_code="CHECKS_PASSED"
        )
        signals[public_id] = item
        by_fingerprint[fingerprint] = public_id

    canonical = list(lifecycle["canonical_active"].values())
    verified_positions = len(active) == len(canonical)
    updates = {}
    used_canonical, used_events = set(), set()

    for row in active:
        if not isinstance(row, dict):
            verified_positions = False
            break
        fid = row.get("admission_fingerprint")
        public_id = by_fingerprint.get(fid) if isinstance(fid, str) else None
        if not public_id:
            verified_positions = False
            break
        expected = signals[public_id]
        if str(row.get("coin", "")).upper() != expected["asset"] or str(
            row.get("action", "")).upper() != expected["side"]:
            verified_positions = False
            break
        candidates = []
        for j, wrapper in enumerate(canonical):
            if not isinstance(wrapper, dict):
                continue
            if (same_trade(row, wrapper.get("record"))
                    and iso(wrapper.get("last_seen_at"), now=now, max_age=120)):
                candidates.append(j)
        if len(candidates) != 1 or candidates[0] in used_canonical:
            verified_positions = False
            break
        events = [
            j for j, event in enumerate(ledger)
            if isinstance(event, dict) and event.get("event_type") == "OPENED"
            and same_trade(row, {
                "coin": event.get("coin"), "direction": event.get("direction"),
                "entry_price": event.get("entry_price"), "opened_at": event.get("opened_at")
            })
        ]
        if len(events) != 1 or events[0] in used_events:
            verified_positions = False
            break
        opened = ledger[events[0]]
        trade_key = opened.get("trade_key")
        if trade_key is not None and any(
            isinstance(event, dict) and event.get("event_type") == "CLOSED_RECORDED"
            and event.get("trade_key") == trade_key for event in ledger
        ):
            verified_positions = False
            break
        used_canonical.add(candidates[0])
        used_events.add(events[0])
        updated = dict(expected)
        updated.update(
            stage="PAPER_OPEN", position_evidence="CANONICAL_PAPER_LEDGER",
            confidence=score(row.get("score")),
            trigger=price(row.get("entry")) or expected["trigger"],
            stop_loss=price(row.get("stop")) or expected["stop_loss"],
            target=price(row.get("tp1")) or expected["target"]
        )
        updates[public_id] = updated

    if verified_positions and len(used_canonical) == len(canonical):
        signals.update(updates)
    else:
        verified_positions = False

    rows = sorted(signals.values(), key=lambda r: r["observed_at"], reverse=True)[:50]
    return {
        "schema_version": 1,
        "source": "GENESIS_PUBLIC_SIGNAL_PROJECTION",
        "publication_scope": "PUBLIC_APPROVED",
        "execution_authority": "none",
        "generated_at": iso(now),
        "engine": {"mode": "paper", "running": True},
        "position_verification": "verified" if verified_positions else "unverified",
        "signals": rows
    }


def health():
    request = Request(HEALTH_URL, headers={"Accept": "application/json"}, method="GET")
    with urlopen(request, timeout=2) as result:
        if result.status != 200:
            raise Unverified("health_endpoint_unavailable")
        payload = result.read(65_537)
        if len(payload) > 65_536:
            raise Unverified("health_payload_too_large")
    return json.loads(payload)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, body):
        raw = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path != "/signals":
            self.reply(404, {"status":"not_found"})
            return
        if os.environ.get("GENESIS_SIGNALS_PUBLISH_ENABLED") != "true":
            self.reply(503, {"status":"publication_disabled"})
            return
        try:
            key = os.environ.get("GENESIS_PUBLIC_SIGNAL_ID_KEY", "").encode()
            output = project(ROOT, health(), key)
            if len(json.dumps(output).encode()) > MAX_OUTPUT_BYTES:
                raise Unverified("projection_too_large")
            self.reply(200, output)
        except Exception:
            self.reply(503, {"status":"feed_not_verified"})

    def do_POST(self):
        self.reply(405, {"status":"method_not_allowed"})

    do_PUT = do_PATCH = do_DELETE = do_POST


def main():
    p = argparse.ArgumentParser(description="Genesis read-only public signal publisher")
    p.add_argument("--check", action="store_true", help="Read-only local diagnostics; never print trades")
    args = p.parse_args()
    if args.check:
        try:
            # Check does not require publication secrets and prints counts only.
            data = project(ROOT, health(), b"DRY_RUN_ONLY_" + b"x"*32)
            print("GENESIS_READONLY_PROJECTION=PASS")
            print("SIGNAL_COUNT=", len(data["signals"]))
            print("VERIFIED_PAPER_OPEN=", sum(
                x["stage"]=="PAPER_OPEN" for x in data["signals"]))
            print("POSITION_VERIFICATION=", data["position_verification"])
        except Exception:
            print("GENESIS_READONLY_PROJECTION=NOT_VERIFIED")
        print("FILES_MODIFIED=NONE")
        return
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
