#!/usr/bin/env python3
"""Safely install a PILOT systemd private Genesis snapshot refresh timer.

This is intentionally NOT a public feed release:
- NO trading engine changes, Nginx edits, public routes, or public flags
- Requires hashes and isolated reader to match an audited baseline
- Installs new timer/service units without altering any existing units
- Runs one bounded *private* refresh via systemd and checks its result
- Starts timer but does not enable it on boot; require separate verification
- A private root-only backup of both snapshot and HMAC key is retained
"""
from __future__ import annotations

import argparse
import hashlib
import http.client as http_client
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

SERVICE_NAME = "genesis-private-signal-refresh.service"
TIMER_NAME = "genesis-private-signal-refresh.timer"
SYSTEMD_DIR = Path("/etc/systemd/system")
SERVICE_FILE = SYSTEMD_DIR / SERVICE_NAME
TIMER_FILE = SYSTEMD_DIR / TIMER_NAME
STAGING_UNIT = "genesis-public-signals-staging.service"
APP_DIR = Path("/usr/local/lib/tkempire-genesis-public-signals")
CYCLE = APP_DIR / "refresh_cycle.py"
CYCLE_SHA256 = "d6d9f0701efa749c3d4ee575ea843a9f7a2b557e4cb2f989f5ae9c610c961d9c"
REFRESH_LIB = APP_DIR / "refresh_snapshot.py"
REFRESH_LIB_SHA256 = "8a5a8417ff5988e378a543ee53d7f41b7aa7d7d03260bb30b075009c1a2b75b6"
READER = APP_DIR / "credential_reader.py"
READER_SHA256 = "65443d7242692083e7a06a2713ed55177bc3c79bbdda9975de355867bc47401b"
STAGING_DIR = Path("/var/lib/tkempire-genesis-signals-staging")
SNAPSHOT = STAGING_DIR / "unapproved-projection.json"
SNAPSHOT_SHA256 = "c9c79bf6f9d781390c7030deac767ade2cfceb56b4f0300f6192c5972ab86549"
KEY_FILE = STAGING_DIR / "signal-id-hmac.key"
NGINX = Path("/etc/nginx/sites-available/tkempire-genesis-api-stage")
NGINX_SHA256 = "4dc8cf49978287d86fe1c46b06c213afe0ebd419df0fe92cd5df0fd00c6bdfb5"
BACKUP_ROOT = Path("/root/tkempire/backups/security")
DROPIN = Path("/etc/systemd/system/genesis-public-signals-staging.service.d/20-private-snapshot.conf")

SERVICE_SOURCE = """[Unit]
Description=Genesis PAPER private signals snapshot refresh (never public)
After=tkempire.service
ConditionPathIsRegular=/usr/local/lib/tkempire-genesis-public-signals/refresh_cycle.py

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/
ExecStart=/usr/bin/python3 -B /usr/local/lib/tkempire-genesis-public-signals/refresh_cycle.py
Environment=PYTHONDONTWRITEBYTECODE=1
TimeoutStartSec=45s
NoNewPrivileges=yes
UMask=0077
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/tkempire-genesis-signals-staging
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectKernelLogs=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
"""

TIMER_SOURCE = """[Unit]
Description=Pilot timer for private Genesis PAPER signal snapshots (no public release)

[Timer]
Unit=genesis-private-signal-refresh.service
OnActiveSec=30s
OnUnitActiveSec=60s
AccuracySec=2s
RandomizedDelaySec=0
Persistent=false

[Install]
WantedBy=timers.target
"""


class GuardError(Exception):
    pass


def require(value, label):
    if not value:
        raise GuardError(label)


def run(*args, timeout=20):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_ok(path, expected, *, mode=None):
    require(path.is_file() and not path.is_symlink(), "EXPECTED_FILE_MISSING")
    st = path.stat()
    require(st.st_uid == 0 and stat.S_ISREG(st.st_mode), "FILE_NOT_ROOT_OWNED")
    if mode is not None:
        require(stat.S_IMODE(st.st_mode) == mode, "FILE_MODE_UNSAFE")
    require(digest(path.read_bytes()) == expected, "FILE_HASH_CHANGED")


def local_request(port, path):
    conn = http_client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        conn.request("GET", path)
        res = conn.getresponse()
        return res.status, res.read(4096)
    finally:
        conn.close()


def protected():
    status, raw = local_request(5097, "/signals")
    require(status == 503, "PUBLICATION_NOT_DISABLED")
    require(json.loads(raw) == {
        "schema_version": 1, "status": "publication_disabled", "signals": []
    }, "PUBLICATION_RESPONSE_UNSAFE")
    require(local_request(5000, "/health")[0] == 200, "GENESIS_HEALTH_UNAVAILABLE")


def assert_root_dir(path, mode):
    require(path.is_dir() and not path.is_symlink(), "PRIVATE_DIR_INVALID")
    info = path.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == mode,
            "PRIVATE_DIR_PERMISSIONS")


def check_config():
    for item, hash_value in (
        (CYCLE, CYCLE_SHA256),
        (REFRESH_LIB, REFRESH_LIB_SHA256),
        (READER, READER_SHA256),
        (NGINX, NGINX_SHA256),
    ):
        file_ok(item, hash_value)
    assert_root_dir(STAGING_DIR, 0o700)
    file_ok(SNAPSHOT, SNAPSHOT_SHA256, mode=0o600)
    require(KEY_FILE.is_file() and not KEY_FILE.is_symlink(), "ID_KEY_NOT_PRESENT")
    key_info = KEY_FILE.stat()
    require(key_info.st_uid == 0 and stat.S_IMODE(key_info.st_mode) == 0o600
            and key_info.st_size == 32, "ID_KEY_UNSAFE")
    require(DROPIN.is_file() and not DROPIN.is_symlink(), "PRIVATE_READER_DROPIN_MISSING")
    # The reader must run in the credential-only configuration.
    cfg = run("systemctl", "cat", STAGING_UNIT)
    require(cfg.returncode == 0
            and cfg.stdout.count(
                "LoadCredential=genesis-signal-snapshot:/var/lib/tkempire-genesis-signals-staging/unapproved-projection.json"
            ) == 1
            and cfg.stdout.count(
                "ExecStart=/usr/bin/python3 -B /usr/local/lib/tkempire-genesis-public-signals/credential_reader.py"
            ) == 1, "CREDENTIAL_READER_UNIT_CHANGED")


def service_health():
    for item in ("tkempire.service", "nginx.service", STAGING_UNIT):
        require(run("systemctl", "is-active", "--quiet", item).returncode == 0,
                "REQUIRED_SERVICE_INACTIVE")
    require(run("nginx", "-t").returncode == 0, "NGINX_SYNTAX_INVALID")
    require(run("systemctl", "is-enabled", STAGING_UNIT).stdout.strip() == "disabled",
            "STAGING_READER_AUTOSTART_UNEXPECTED")
    protected()


def preflight():
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    require(not SERVICE_FILE.exists() and not SERVICE_FILE.is_symlink()
            and not TIMER_FILE.exists() and not TIMER_FILE.is_symlink(),
            "REFRESH_TIMER_ALREADY_INSTALLED")
    require(run("systemctl", "cat", SERVICE_NAME).returncode != 0,
            "REFRESH_SERVICE_ALREADY_REGISTERED")
    require(run("systemctl", "cat", TIMER_NAME).returncode != 0,
            "REFRESH_TIMER_ALREADY_REGISTERED")
    require(BACKUP_ROOT.is_dir() and not BACKUP_ROOT.is_symlink(),
            "BACKUP_ROOT_INVALID")
    bst = BACKUP_ROOT.stat()
    require(bst.st_uid == 0 and not (stat.S_IMODE(bst.st_mode) & 0o022),
            "BACKUP_ROOT_WRITABLE_BY_OTHERS")
    check_config()
    service_health()
    print("PRIVATE_TIMER_PREFLIGHT=PASS", flush=True)


def exclusive(path, contents, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as file:
        file.write(contents)
        file.flush()
        os.fsync(file.fileno())
    os.chmod(path, mode)


def backup():
    folder = Path(tempfile.mkdtemp(prefix="genesis-private-timer-", dir=BACKUP_ROOT))
    folder.chmod(0o700)
    for source, name in ((SNAPSHOT, "snapshot.json"), (KEY_FILE, "hmac-key.bin")):
        raw = source.read_bytes()
        destination = folder / name
        exclusive(destination, raw, 0o600)
        require(destination.read_bytes() == raw, "BACKUP_READBACK_MISMATCH")
    print("BACKUP_DIRECTORY=" + str(folder), flush=True)
    print("BACKUP_SNAPSHOT_SHA256=" + digest((folder / "snapshot.json").read_bytes()),
          flush=True)
    print("PRIVATE_KEY_BACKUP=VERIFIED_0600", flush=True)
    return folder


def unit_proof():
    active = run("systemctl", "is-active", "--quiet", TIMER_NAME)
    require(active.returncode == 0, "PILOT_TIMER_INACTIVE")
    enabled = run("systemctl", "is-enabled", TIMER_NAME)
    require(enabled.stdout.strip() == "disabled", "TIMER_ALREADY_ENABLED_AT_BOOT")
    state = run("systemctl", "show", SERVICE_NAME, "-p", "Result", "-p", "ExecMainStatus")
    require("Result=success" in state.stdout and "ExecMainStatus=0" in state.stdout,
            "ISOLATED_CYCLE_RESULT_UNVERIFIED")
    recent = run("journalctl", "-u", SERVICE_NAME, "-n", "80", "-o", "cat", "--no-pager")
    require(recent.returncode == 0 and
            "REFRESH_CYCLE=PASS" in recent.stdout and
            "DISABLED_HTTP_503=PASS" in recent.stdout,
            "ISOLATED_CYCLE_JOURNAL_UNVERIFIED")
    check_config_after()
    service_health()


def check_config_after():
    # Snapshot is expected to change, every OTHER deployment/source hash is fixed.
    for item, hash_value in ((CYCLE, CYCLE_SHA256), (REFRESH_LIB, REFRESH_LIB_SHA256),
                             (READER, READER_SHA256), (NGINX, NGINX_SHA256)):
        file_ok(item, hash_value)
    assert_root_dir(STAGING_DIR, 0o700)
    new = SNAPSHOT.read_bytes()
    require(SNAPSHOT.is_file() and not SNAPSHOT.is_symlink(), "NEW_SNAPSHOT_INVALID")
    require(SNAPSHOT.stat().st_uid == 0 and
            stat.S_IMODE(SNAPSHOT.stat().st_mode) == 0o600,
            "NEW_SNAPSHOT_PERMISSIONS_CHANGED")
    payload = json.loads(new)
    require(payload["publication_scope"] == "STAGING_NOT_APPROVED"
            and payload["execution_authority"] == "none"
            and payload["position_verification"] == "verified",
            "NEW_SNAPSHOT_SCOPE_UNSAFE")


def install():
    preflight()
    backup()
    created_service = created_timer = timer_started = False
    try:
        exclusive(SERVICE_FILE, SERVICE_SOURCE.encode(), 0o644)
        created_service = True
        exclusive(TIMER_FILE, TIMER_SOURCE.encode(), 0o644)
        created_timer = True
        require(run("systemd-analyze", "verify", SERVICE_FILE, TIMER_FILE,
                    timeout=20).returncode == 0, "SYSTEMD_UNIT_SYNTAX_FAIL")
        require(run("systemctl", "daemon-reload").returncode == 0,
                "DAEMON_RELOAD_FAILED")
        print("SYSTEMD_PRIVATE_UNITS_INSTALLED=PASS", flush=True)
        # One real run inside its confinement is required before starting a timer.
        result = run("systemctl", "start", SERVICE_NAME, timeout=60)
        require(result.returncode == 0, "SYSTEMD_ISOLATED_CYCLE_FAILED")
        print("SYSTEMD_ISOLATED_CYCLE=PASS", flush=True)
        require(run("systemctl", "start", TIMER_NAME).returncode == 0,
                "PILOT_TIMER_START_FAILED")
        timer_started = True
        unit_proof()
        print("PILOT_TIMER_ACTIVE=PASS")
        print("PILOT_TIMER_BOOT_ENABLED=NO")
        print("RECURRING_INTERVAL=60_SECONDS")
        print("PUBLICATION_ENABLED=NO")
        print("TRADING_CONFIG_MODIFIED=NO")
        print("NGINX_CONFIG_MODIFIED=NO")
        print("PILOT_PRIVATE_TIMER=PASS")
    except Exception as error:
        # Do not leave an unchecked timer active after any failure.
        run("systemctl", "stop", TIMER_NAME)
        if created_timer:
            TIMER_FILE.unlink(missing_ok=True)
        if created_service:
            SERVICE_FILE.unlink(missing_ok=True)
        daemon_ok = run("systemctl", "daemon-reload").returncode == 0
        print("PILOT_PRIVATE_TIMER=BLOCKED")
        print("ROLLBACK_TIMER_STOP_ATTEMPTED=YES")
        print("ROLLBACK_DAEMON_RELOAD=" + ("PASS" if daemon_ok else "FAIL"))
        print("ERROR_TYPE=" + type(error).__name__)
        if isinstance(error, GuardError):
            print("ERROR_CODE=" + str(error))
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--preflight", action="store_true")
    group.add_argument("--install-pilot", action="store_true")
    args = parser.parse_args()
    if args.preflight:
        preflight()
        print("FILES_MODIFIED=NONE")
    else:
        install()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("PRIVATE_TIMER=BLOCKED")
        print("ERROR_TYPE=" + type(exc).__name__)
        if isinstance(exc, GuardError):
            print("ERROR_CODE=" + str(exc))
        raise SystemExit(1)
