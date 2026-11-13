#!/usr/bin/env python3
"""Guarded, rollback-capable Genesis Signals refresh baseline repair.

Run on the original VPS as root. This never changes Nginx, trading,
permissions, testnet service, network credentials, or website code.
It verifies a byte-exact, bounded addition against an immutable backup
before changing one SHA-256 pin in the read-only refresh service.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

OLD = "80476654fcd02bc91b5bd067f07ea6253b99a7028a15a9f2d1b28c7533fa8c57"
NEW = "dc815ba064e0eb041fd6ac5d1a20349a41b08cec99f77c56152413dbe351dda4"
BACKUP = Path("/var/backups/tkempire/genesis-auto-monitor-v1/nginx")
NGINX = Path("/etc/nginx/sites-available/tkempire-genesis-api-stage")
READER = Path("/usr/local/lib/tkempire-genesis-public-signals/refresh_cycle_release.py")
BACKUP_DIR = Path("/root/tkempire/backups/security")
SERVICE = "genesis-private-signal-refresh.service"
MARKER_START = "# BEGIN TKEMPIRE GENESIS AUTO MONITOR V1"
MARKER_END = "# END TKEMPIRE GENESIS AUTO MONITOR V1"
EXPECTED_BLOCK = (
    MARKER_START,
    "# Install as a location inside the existing TLS server for api.tkempire.io.",
    "# The publisher itself is loopback-only; nginx supplies HTTPS and auth.",
    "location = /internal/genesis/auto-monitor {",
    "limit_except GET { deny all; }",
    'auth_basic "TK Empire Private Genesis";',
    "auth_basic_user_file /etc/nginx/tkempire-genesis-auto-monitor.htpasswd;",
    "proxy_pass http://127.0.0.1:5099/monitor;",
    "proxy_pass_request_body off;",
    "proxy_pass_request_headers off;",
    "proxy_set_header Host 127.0.0.1;",
    "proxy_connect_timeout 2s;",
    "proxy_read_timeout 3s;",
    "proxy_send_timeout 3s;",
    "proxy_cache off;",
    'add_header Cache-Control "no-store" always;',
    'add_header X-Content-Type-Options "nosniff" always;',
    "}",
    MARKER_END,
)
RX = re.compile(
    rb"(?m)^# BEGIN TKEMPIRE GENESIS AUTO MONITOR V1\r?\n"
    rb".*?^# END TKEMPIRE GENESIS AUTO MONITOR V1\r?\n",
    re.DOTALL | re.MULTILINE,
)
PIN = 'NGINX_SHA256 = "' + OLD + '"'
PIN_NEW = 'NGINX_SHA256 = "' + NEW + '"'


class Block(Exception):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise Block(message)


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def validated_diff(backup: bytes, current: bytes, old_sha: str = OLD, new_sha: str = NEW) -> None:
    """Accept ONLY the reviewed one-block addition. All other byte changes fail closed."""
    require(sha(backup) == old_sha, "TRUSTED_BACKUP_HASH_MISMATCH")
    require(sha(current) == new_sha, "CURRENT_NGINX_HASH_CHANGED")
    hits = list(RX.finditer(current))
    require(len(hits) == 1, "MONITOR_BLOCK_MISSING_OR_DUPLICATE")
    match = hits[0]
    actual_lines = tuple(line.decode("utf8").strip() for line in match.group().splitlines())
    require(actual_lines == EXPECTED_BLOCK, "MONITOR_BLOCK_NOT_APPROVED")
    require(current[:match.start()] + current[match.end():] == backup,
            "UNAPPROVED_NGINX_DIFF")
    require(current.count(b"location = /internal/genesis/auto-monitor {") == 1,
            "MONITOR_ROUTE_DUPLICATE")
    print("NGINX_BASELINE_DIFF=ONE_APPROVED_MONITOR_BLOCK")


def run(*argv: str, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout)


def guarded_file(path: Path, *, root: bool = True) -> bytes:
    require(path.is_file() and not path.is_symlink(), "NOT_REGULAR:" + path.name)
    st = path.stat()
    require(stat.S_ISREG(st.st_mode), "NOT_REGULAR:" + path.name)
    if root:
        require(st.st_uid == 0, "NOT_ROOT_OWNED:" + path.name)
    return path.read_bytes()


def http_status(path: str, method: str = "GET") -> int:
    # Connect to the loopback Nginx listener, but retain SNI and TLS verification.
    argv = ("curl", "-sS", "--noproxy", "*", "--max-time", "7",
            "--connect-timeout", "3", "--max-redirs", "0",
            "--resolve", "api.tkempire.io:443:127.0.0.1",
            "-o", "/dev/null", "-w", "%{http_code}", "-X", method,
            "https://api.tkempire.io/internal/genesis/" + path)
    r = run(*argv, timeout=10)
    require(r.returncode == 0 and r.stdout.strip().isdigit(),
            "TLS_LOOPBACK_PROBE_FAILED:" + path)
    return int(r.stdout.strip())


def preflight() -> tuple[bytes, bytes]:
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    base = guarded_file(BACKUP)
    current = guarded_file(NGINX)
    validated_diff(base, current)
    reader = guarded_file(READER)
    content = reader.decode("utf8")
    require(content.count(PIN) == 1 and content.count(PIN_NEW) == 0,
            "READER_PIN_UNEXPECTED")
    require('require(sha256(NGINX.read_bytes()) == NGINX_SHA256' in content,
            "FAIL_CLOSED_GUARD_MISSING")
    require('NGINX = Path("/etc/nginx/sites-available/tkempire-genesis-api-stage")' in content,
            "READER_NGINX_PATH_CHANGED")
    compile(content.replace(PIN, PIN_NEW), str(READER), "exec")
    require(run("nginx", "-t").returncode == 0, "NGINX_TEST_FAILED")
    for unit in ("nginx.service", "tkempire.service",
                 "genesis-public-signals-staging.service"):
        require(run("systemctl", "is-active", "--quiet", unit).returncode == 0,
                "SERVICE_NOT_ACTIVE:" + unit)
    for path in ("health", "status", "history", "signals", "auto-monitor"):
        status = http_status(path)
        require(status == 401, "ANONYMOUS_GATEWAY_NOT_401:" + path)
    require(http_status("auto-monitor", "POST") in (401, 403, 405),
            "MONITOR_WRITE_METHOD_NOT_DENIED")
    pwd = Path("/etc/nginx/tkempire-genesis-auto-monitor.htpasswd")
    require(pwd.is_file() and not pwd.is_symlink(), "MONITOR_AUTH_FILE_UNSAFE")
    require(pwd.stat().st_uid == 0, "MONITOR_AUTH_FILE_OWNER_UNSAFE")
    print("NGINX_TEST=PASS")
    print("ANONYMOUS_AUTH=PASS")
    print("MONITOR_WRITE_METHOD_DENIED=PASS")
    print("READER_SHA_PIN_ONLY_CHANGE=PASS")
    return reader, content.replace(PIN, PIN_NEW).encode("utf8")


def atomic_replace(data: bytes, mode: int) -> None:
    tmp = None
    try:
        fd, name = tempfile.mkstemp(prefix=".refresh-pin.", dir=str(READER.parent))
        tmp = Path(name)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chown(tmp, 0, 0)
        os.chmod(tmp, mode)
        os.replace(tmp, READER)
        tmp = None
        folder_fd = os.open(READER.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(folder_fd)
        finally:
            os.close(folder_fd)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def local_feed() -> tuple[int, dict]:
    try:
        with urlopen(Request("http://127.0.0.1:5097/signals",
                             headers={"Accept": "application/json"}), timeout=5) as r:
            data = r.read(60001)
            status = r.status
    except HTTPError as e:
        data = e.read(60001)
        status = e.code
    require(len(data) <= 60000, "FEED_OVERSIZED")
    obj = json.loads(data)
    require(isinstance(obj, dict), "FEED_MALFORMED")
    return status, obj


def approved_feed() -> None:
    # Do not read or print signal records; verify only source contract and freshness.
    for attempt in range(6):
        try:
            status, obj = local_feed()
            t = obj.get("generated_at")
            age = time.time() - datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() if isinstance(t, str) else 1e9
            require(status == 200 and obj.get("schema_version") == 1
                    and obj.get("source") == "GENESIS_PUBLIC_SIGNAL_PROJECTION"
                    and obj.get("publication_scope") == "PUBLIC_APPROVED"
                    and obj.get("execution_authority") == "none"
                    and obj.get("engine") == {"mode": "paper", "running": True}
                    and obj.get("position_verification") == "verified"
                    and isinstance(obj.get("signals"), list) and len(obj["signals"]) <= 50
                    and -30 <= age <= 120, "APPROVED_FEED_NOT_VERIFIED")
            print("LOCAL_SIGNAL_FEED_HTTP=200")
            print("PUBLICATION=APPROVED_READ_ONLY")
            print("SIGNAL_COUNT=" + str(len(obj["signals"])))
            return
        except (Block, ValueError, OSError, KeyError):
            if attempt == 5:
                raise Block("SIGNAL_FEED_READBACK_FAILED")
            time.sleep(0.5)


def repair() -> None:
    old, new = preflight()
    st = READER.stat()
    require(sha(guarded_file(NGINX)) == NEW, "NGINX_DRIFT_BEFORE_COMMIT")
    require(guarded_file(READER) == old, "READER_DRIFT_BEFORE_COMMIT")
    require(BACKUP_DIR.is_dir() and not BACKUP_DIR.is_symlink()
            and BACKUP_DIR.stat().st_uid == 0, "SECURE_BACKUP_DIR_UNAVAILABLE")
    backup_name = BACKUP_DIR / ("genesis-signals-refresh-pin-" +
                               datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".py")
    fd = os.open(backup_name, os.O_CREAT | os.O_EXCL | os.O_WRONLY |
                 os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(old)
        f.flush()
        os.fsync(f.fileno())
    require(backup_name.read_bytes() == old, "BACKUP_READBACK_FAILED")
    print("READER_BACKUP_SAVED=YES")
    mode = stat.S_IMODE(st.st_mode)
    patched = False
    try:
        atomic_replace(new, mode)
        patched = True
        require(guarded_file(READER) == new, "READER_PATCH_READBACK_FAILED")
        require(sha(guarded_file(NGINX)) == NEW, "NGINX_DRIFT_DURING_COMMIT")
        result = run("systemctl", "start", SERVICE, timeout=45)
        require(result.returncode == 0, "REFRESH_SERVICE_START_FAILED")
        approved_feed()
        print("REFRESH_PIN_REPAIR=PASS")
        print("TRADING_OR_NGINX_CHANGED=NO")
    except Exception:
        if patched:
            atomic_replace(old, mode)
            print("READER_PIN_ROLLED_BACK=YES")
        print("REFRESH_PIN_REPAIR=BLOCKED")
        raise


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--check", action="store_true")
    p.add_argument("--apply", action="store_true")
    a = p.parse_args()
    require(a.check != a.apply, "SELECT_CHECK_OR_APPLY")
    if a.apply:
        repair()
    else:
        preflight()
        print("PREFLIGHT=PASS")
        print("NO_CHANGES_MADE=YES")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("REPAIR_ERROR_CLASS=" + type(e).__name__)
        if isinstance(e, Block):
            print("REPAIR_BLOCKER=" + str(e))
        sys.exit(1)
