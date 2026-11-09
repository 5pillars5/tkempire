#!/usr/bin/env python3
"""Sealed, disabled Genesis Signals reader for systemd LoadCredential staging.

The sole input is an allowlisted, UNAPPROVED, pre-sanitized systemd credential.
This program NEVER accesses /root/tkempire, never emits signal rows, and never
enables publishing, even if a publication environment variable is set.
A separate reviewed release is required to change those invariants.
"""
from __future__ import annotations

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import stat

HOST = "127.0.0.1"
PORT = 5097
CREDENTIAL_NAME = "genesis-signal-snapshot"
MAX_BYTES = 60_000
SOURCE = "GENESIS_PUBLIC_SIGNAL_PROJECTION"
ROOT_KEYS = {
    "schema_version", "source", "publication_scope", "execution_authority",
    "generated_at", "engine", "position_verification", "signals",
}
ITEM_KEYS = {
    "id", "asset", "side", "stage", "observed_at", "confidence",
    "trigger", "stop_loss", "target", "reason_code", "position_evidence",
}
REQUIRED_ITEM_KEYS = {"id", "asset", "side", "stage", "observed_at", "reason_code"}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
HEX_ID = re.compile(r"^[a-f0-9]{32}$")
ASSET = re.compile(r"^[A-Z0-9]{2,15}$")


class InvalidCredential(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise InvalidCredential(reason)


def timestamp(value):
    require(isinstance(value, str) and ISO.fullmatch(value), "timestamp_format")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise InvalidCredential("timestamp_invalid") from exc
    return stamp.astimezone(timezone.utc)


def optional_number(value, *, minimum, maximum, exclusive_min=False):
    if value is None:
        return
    require(type(value) in (float, int) and math.isfinite(value), "number_invalid")
    require((value > minimum if exclusive_min else value >= minimum)
            and value <= maximum, "number_out_of_range")


def validate(payload):
    """Inspect exact types/allowlists. Never return or log record contents."""
    require(isinstance(payload, dict) and set(payload) == ROOT_KEYS, "root_schema")
    require(type(payload["schema_version"]) is int and payload["schema_version"] == 1,
            "schema_version")
    require(payload["source"] == SOURCE, "source_invalid")
    require(payload["publication_scope"] == "STAGING_NOT_APPROVED", "scope_not_staging")
    require(payload["execution_authority"] == "none", "execution_authority")
    require(payload["engine"] == {"mode": "paper", "running": True}, "engine_not_paper")
    require(payload["position_verification"] == "verified", "position_unverified")
    generated = timestamp(payload["generated_at"])
    require(generated <= datetime.now(timezone.utc).replace(microsecond=999999)
            or (generated - datetime.now(timezone.utc)).total_seconds() <= 30,
            "generated_in_future")
    rows = payload["signals"]
    require(isinstance(rows, list) and len(rows) <= 50, "signals_unbounded")
    seen = set()
    paper_open = 0
    for row in rows:
        require(isinstance(row, dict), "signal_not_object")
        require(set(row).issubset(ITEM_KEYS) and REQUIRED_ITEM_KEYS.issubset(row),
                "signal_fields")
        require(isinstance(row["id"], str) and HEX_ID.fullmatch(row["id"]),
                "signal_id_invalid")
        require(row["id"] not in seen, "signal_id_duplicate")
        seen.add(row["id"])
        require(isinstance(row["asset"], str) and ASSET.fullmatch(row["asset"]),
                "asset_invalid")
        require(row["side"] in {"BUY", "SELL"}, "side_invalid")
        require(row["stage"] in {"QUALIFIED", "PAPER_OPEN"}, "stage_invalid")
        timestamp(row["observed_at"])
        require(row["reason_code"] == "CHECKS_PASSED", "reason_invalid")
        optional_number(row.get("confidence"), minimum=0, maximum=100)
        for name in ("trigger", "stop_loss", "target"):
            optional_number(row.get(name), minimum=0, maximum=1e9, exclusive_min=True)
        if row["stage"] == "PAPER_OPEN":
            require(row.get("position_evidence") == "CANONICAL_PAPER_LEDGER",
                    "position_evidence")
            paper_open += 1
        else:
            require("position_evidence" not in row, "unexpected_position_evidence")
    return {"signal_count": len(rows), "paper_open": paper_open}


def credential_path():
    parent = os.environ.get("CREDENTIALS_DIRECTORY", "")
    require(parent.startswith("/") and "\x00" not in parent, "credential_directory_absent")
    return Path(parent) / CREDENTIAL_NAME


def read_credential(path):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= MAX_BYTES,
                "credential_file_invalid")
        with os.fdopen(os.dup(fd), "rb") as stream:
            raw = stream.read(MAX_BYTES + 1)
        after = os.fstat(fd)
        require(len(raw) <= MAX_BYTES and before.st_size == after.st_size
                and before.st_mtime_ns == after.st_mtime_ns, "credential_changed")
    finally:
        os.close(fd)
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, ValueError) as exc:
        raise InvalidCredential("credential_json_invalid") from exc
    return validate(payload)


class DisabledHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send_json(self, code, status):
        body = json.dumps({"schema_version": 1, "status": status, "signals": []},
                          separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/signals":
            # Intentional hard stop: staging NEVER releases the credential.
            self.send_json(503, "publication_disabled")
        else:
            self.send_json(404, "not_found")

    def do_POST(self):
        self.send_json(405, "method_not_allowed")

    do_PUT = do_PATCH = do_DELETE = do_POST


def main():
    # Never trust an env-only feature flag as public-release authorization.
    require(os.environ.get("GENESIS_SIGNALS_PUBLISH_ENABLED") != "true",
            "unsafe_publication_environment")
    numbers = read_credential(credential_path())
    print("CREDENTIAL_SNAPSHOT_LOAD=PASS", flush=True)
    print("SNAPSHOT_SCOPE=STAGING_NOT_APPROVED", flush=True)
    print("SANITISED_SIGNAL_COUNT=" + str(numbers["signal_count"]), flush=True)
    print("VERIFIED_PAPER_OPEN=" + str(numbers["paper_open"]), flush=True)
    print("PUBLICATION_ENABLED=NO", flush=True)
    server = ThreadingHTTPServer((HOST, PORT), DisabledHandler)
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("CREDENTIAL_SNAPSHOT_LOAD=BLOCKED", flush=True)
        print("ERROR_CLASS=" + type(exc).__name__, flush=True)
        raise SystemExit(1)
