#!/usr/bin/env python3
"""Fail-closed Genesis PAPER snapshot refresh + staging-credential reload.

No public feed, no trading orders, no changes to Genesis or Nginx.
Reads private data through the pinned projector/refresh code; writes only
the root-only staging snapshot and one bounded predecessor file.
Restarts ONLY genesis-public-signals-staging.service when fresh output passes.
"""
from __future__ import annotations

from collections import defaultdict
import fcntl
import hashlib
import http.client as http_client
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time

APP_DIR = Path("/usr/local/lib/tkempire-genesis-public-signals")
REFRESH_LIB = APP_DIR / "refresh_snapshot.py"
REFRESH_LIB_BLOB = "b387245af0f55df43b9e45f5aec9deec094c1889"
READER = APP_DIR / "credential_reader.py"
READER_SHA256 = "65443d7242692083e7a06a2713ed55177bc3c79bbdda9975de355867bc47401b"
GENESIS_SERVICE = "tkempire.service"
NGINX_SERVICE = "nginx.service"
STAGING_SERVICE = "genesis-public-signals-staging.service"
STAGING_DIR = Path("/var/lib/tkempire-genesis-signals-staging")
SNAPSHOT = STAGING_DIR / "unapproved-projection.json"
PREVIOUS = STAGING_DIR / ".previous-unapproved-projection.json"
KEY = STAGING_DIR / "signal-id-hmac.key"
LOCK = STAGING_DIR / "refresh.lock"
NGINX = Path("/etc/nginx/sites-available/tkempire-genesis-api-stage")
NGINX_SHA256 = "4dc8cf49978287d86fe1c46b06c213afe0ebd419df0fe92cd5df0fd00c6bdfb5"
UNIT = Path("/etc/systemd/system/genesis-public-signals-staging.service")
UNIT_SHA256 = "8a85b580609f2118c5967c22ac46d1903294b184acabc390274afe027e2cdb2e"
DROPIN = Path("/etc/systemd/system/genesis-public-signals-staging.service.d/20-private-snapshot.conf")
CRED_DIRECTIVE = "LoadCredential=genesis-signal-snapshot:/var/lib/tkempire-genesis-signals-staging/unapproved-projection.json"
READER_EXEC = "ExecStart=/usr/bin/python3 -B /usr/local/lib/tkempire-genesis-public-signals/credential_reader.py"


class GuardError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise GuardError(code)


def run(*argv, timeout=20):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def load_refresh_lib():
    require(REFRESH_LIB.is_file() and not REFRESH_LIB.is_symlink(),
            "REFRESH_SOURCE_NOT_FOUND")
    source = REFRESH_LIB.read_bytes()
    require(blob(source) == REFRESH_LIB_BLOB, "REFRESH_SOURCE_HASH_MISMATCH")
    spec = importlib.util.spec_from_file_location("pinned_refresh", REFRESH_LIB)
    require(spec is not None and spec.loader is not None, "REFRESH_IMPORT_UNAVAILABLE")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def probe(port, path, method="GET"):
    conn = http_client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        conn.request(method, path, headers={"Host": "127.0.0.1"})
        r = conn.getresponse()
        return r.status, r.read(4096)
    finally:
        conn.close()


def disabled():
    status, raw = probe(5097, "/signals")
    require(status == 503, "SIGNALS_NOT_DISABLED")
    require(json.loads(raw) == {
        "schema_version": 1, "status": "publication_disabled", "signals": []
    }, "DISABLED_RESPONSE_MISMATCH")
    require(probe(5097, "/other")[0] == 404, "UNKNOWN_ROUTE_EXPOSED")
    require(probe(5097, "/signals", "POST")[0] == 405, "POST_NOT_REJECTED")


def baseline():
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    require(sha256(NGINX.read_bytes()) == NGINX_SHA256,
            "NGINX_CONFIGURATION_CHANGED")
    require(sha256(UNIT.read_bytes()) == UNIT_SHA256,
            "STAGING_UNIT_CHANGED")
    require(sha256(READER.read_bytes()) == READER_SHA256,
            "READER_CODE_CHANGED")
    require(DROPIN.is_file() and not DROPIN.is_symlink(),
            "CREDENTIAL_OVERRIDE_MISSING")
    config = run("systemctl", "cat", STAGING_SERVICE)
    require(config.returncode == 0
            and config.stdout.count(CRED_DIRECTIVE) == 1
            and config.stdout.count(READER_EXEC) == 1,
            "CREDENTIAL_READER_CONFIGURATION_CHANGED")
    for service in (GENESIS_SERVICE, NGINX_SERVICE, STAGING_SERVICE):
        require(run("systemctl", "is-active", "--quiet", service).returncode == 0,
                "SERVICE_NOT_ACTIVE")
    require(run("systemctl", "is-enabled", STAGING_SERVICE).stdout.strip() == "disabled",
            "STAGING_UNIT_BOOT_ENABLED")
    require(probe(5000, "/health")[0] == 200, "GENESIS_HEALTH_FAILED")
    disabled()


def verify_reader(new_obj):
    # Reloaded systemd credential must have been read by THIS invocation.
    baseline()
    result = run("systemctl", "show", STAGING_SERVICE, "-p", "InvocationID", "--value")
    inv = result.stdout.strip()
    require(result.returncode == 0 and re.fullmatch(r"[a-fA-F0-9]{32}", inv),
            "INVOCATION_UNAVAILABLE")
    logs = run("journalctl", "_SYSTEMD_INVOCATION_ID=" + inv,
               "--no-pager", "-o", "cat", timeout=8)
    require(logs.returncode == 0, "READER_JOURNAL_UNAVAILABLE")
    expected = (
        "CREDENTIAL_SNAPSHOT_LOAD=PASS",
        "SNAPSHOT_SCOPE=STAGING_NOT_APPROVED",
        "SANITISED_SIGNAL_COUNT=" + str(len(new_obj["signals"])),
        "VERIFIED_PAPER_OPEN=" + str(sum(
            1 for x in new_obj["signals"] if x["stage"] == "PAPER_OPEN"
        )),
        "PUBLICATION_ENABLED=NO"
    )
    require(all(s in logs.stdout for s in expected), "CREDENTIAL_READBACK_MISMATCH")


def make_key(row):
    # Never rely on an asset/direction alone: multiple signals can share them.
    return (row["asset"], row["side"], row["observed_at"],
            row.get("trigger"), row.get("stop_loss"))


def stable_overlap(old, new):
    old_by_identity, new_by_identity = defaultdict(set), defaultdict(set)
    for item in old["signals"]:
        old_by_identity[make_key(item)].add(item["id"])
    for item in new["signals"]:
        new_by_identity[make_key(item)].add(item["id"])
    for key in old_by_identity.keys() & new_by_identity.keys():
        if len(old_by_identity[key]) == len(new_by_identity[key]) == 1:
            require(old_by_identity[key] == new_by_identity[key],
                    "STABLE_SIGNAL_ID_REGRESSION")


def refresh_once():
    base = load_refresh_lib()
    baseline()
    base.verify_root_dir(STAGING_DIR, 0o700)
    prior = base.verify_regular_root(SNAPSHOT, mode=0o600,
                                     max_size=base.MAX_OUTPUT_BYTES)
    before = json.loads(prior)
    require(before.get("publication_scope") == "STAGING_NOT_APPROVED",
            "OLD_SNAPSHOT_NOT_PRIVATE")
    fd = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        private_key, created = base.private_key(KEY, create=False)
        require(not created, "STABLE_KEY_WAS_NOT_INITIALIZED")
        data = base.project_snapshot(private_key)
        after = json.loads(data)
        stable_overlap(before, after)
        # A single private predecessor is retained, avoiding unbounded backups.
        if PREVIOUS.exists() or PREVIOUS.is_symlink():
            base.verify_regular_root(PREVIOUS, mode=0o600,
                                     max_size=base.MAX_OUTPUT_BYTES)
        base.atomic_replacement(PREVIOUS, prior)
        require(base.verify_regular_root(PREVIOUS, mode=0o600,
                                         max_size=base.MAX_OUTPUT_BYTES) == prior,
                "PREVIOUS_SNAPSHOT_READBACK_FAILED")
        replaced = False
        try:
            base.atomic_replacement(SNAPSHOT, data)
            replaced = True
            require(base.verify_regular_root(SNAPSHOT, mode=0o600,
                                             max_size=base.MAX_OUTPUT_BYTES) == data,
                    "NEW_SNAPSHOT_READBACK_FAILED")
            result = run("systemctl", "restart", STAGING_SERVICE, timeout=15)
            require(result.returncode == 0, "READER_RESTART_FAILED")
            valid = False
            for attempt in range(12):
                try:
                    verify_reader(after)
                    valid = True
                    break
                except (GuardError, OSError, ValueError):
                    time.sleep(0.25)
            require(valid, "READER_NOT_VERIFIED")
        except Exception:
            if replaced:
                base.atomic_replacement(SNAPSHOT, prior)
                verified = False
                for _ in range(12):
                    if run("systemctl", "restart", STAGING_SERVICE).returncode == 0:
                        try:
                            verify_reader(before)
                            verified = True
                            break
                        except (GuardError, OSError, ValueError):
                            pass
                    time.sleep(0.25)
                print("ROLLBACK_VERIFIED=" + ("PASS" if verified else "FAIL"),
                      flush=True)
            raise
        require(base.verify_regular_root(KEY, mode=0o600, max_size=32)
                == private_key, "PRIVATE_ID_KEY_CHANGED")
        require(base.verify_regular_root(SNAPSHOT, mode=0o600,
                                         max_size=base.MAX_OUTPUT_BYTES) == data,
                "SNAPSHOT_CHANGED_AFTER_READER_RELOAD")
        print("ROOT_ONLY_STABLE_IDENTIFIERS=PASS")
        print("SANITISED_SIGNAL_COUNT=" + str(len(after["signals"])))
        print("VERIFIED_PAPER_OPEN=" + str(sum(
            1 for row in after["signals"] if row["stage"] == "PAPER_OPEN"
        )))
        print("SNAPSHOT_SHA256=" + sha256(data))
        print("SNAPSHOT_READBACK=PASS")
        print("DISABLED_HTTP_503=PASS")
        print("PUBLICATION_ENABLED=NO")
        print("TRADING_CONFIG_MODIFIED=NO")
        print("NGINX_CONFIG_MODIFIED=NO")
        print("REFRESH_CYCLE=PASS")
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        refresh_once()
    except Exception as exc:
        print("REFRESH_CYCLE=FAIL_CLOSED")
        print("ERROR_CLASS=" + type(exc).__name__)
        if isinstance(exc, GuardError):
            print("ERROR_CODE=" + str(exc))
        raise SystemExit(1)
