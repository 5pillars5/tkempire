#!/usr/bin/env python3
"""Install a DISABLED loopback-only staging listener for Genesis PAPER signals.

This installer never enables publishing, Nginx routes, Vercel flags, trading,
or systemd boot-time startup. It installs the SHA-256-verified publisher from
the previously staged VPS file, as a confined dynamic (non-root) user.
The confined service deliberately CANNOT access private Genesis trade files;
data access and signal publication require a separately reviewed stage.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time

SOURCE = Path("/root/tkempire/research/genesis_public_signals_staging/publisher.py")
SOURCE_SHA256 = "4ed81f93c11891310eab4ad8093adf26cae2ffdab676839eea666bf79fd23d4c"
APP_DIR = Path("/usr/local/lib/tkempire-genesis-public-signals")
APP = APP_DIR / "publisher.py"
UNIT_NAME = "genesis-public-signals-staging.service"
UNIT_PATH = Path("/etc/systemd/system") / UNIT_NAME
PORT = 5097
UNIT = """[Unit]
Description=Genesis PAPER signal publisher - DISABLED loopback staging
After=network.target
ConditionPathIsRegular=/usr/local/lib/tkempire-genesis-public-signals/publisher.py

[Service]
Type=simple
DynamicUser=yes
User=genesis-signal-shadow
WorkingDirectory=/
ExecStart=/usr/bin/python3 -B /usr/local/lib/tkempire-genesis-public-signals/publisher.py
Environment=GENESIS_SIGNALS_PUBLISH_ENABLED=false
Environment=PYTHONDONTWRITEBYTECODE=1
Restart=no
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectKernelLogs=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
IPAddressDeny=any
IPAddressAllow=localhost
MemoryMax=128M
TasksMax=16
UMask=0077

[Install]
WantedBy=multi-user.target
"""


class SafetyError(Exception):
    pass


def cmd(*argv, timeout=20):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def require(condition, message):
    if not condition:
        raise SafetyError(message)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def http(port, path, method="GET", host="127.0.0.1"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        conn.request(method, path, headers={"Host": host})
        response = conn.getresponse()
        payload = response.read(4096)
        return response.status, payload
    finally:
        conn.close()


def sockets(port):
    result = cmd("ss", "-H", "-lnt")
    require(result.returncode == 0, "SOCKET_INVENTORY_UNAVAILABLE")
    return [
        line.split()[3] for line in result.stdout.splitlines()
        if len(line.split()) >= 4 and
        line.split()[3].rsplit(":", 1)[-1] == str(port)
    ]


def preflight():
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    require(SOURCE.is_file() and not SOURCE.is_symlink(), "SOURCE_MISSING_OR_SYMLINK")
    require(sha256(SOURCE.read_bytes()) == SOURCE_SHA256, "STAGED_PUBLISHER_SHA256_MISMATCH")
    require(not APP_DIR.exists(), "APPLICATION_DIRECTORY_ALREADY_EXISTS")
    require(not UNIT_PATH.exists(), "UNIT_ALREADY_EXISTS")
    require(cmd("systemctl", "cat", UNIT_NAME).returncode != 0,
            "UNIT_ALREADY_REGISTERED")
    require(not sockets(PORT), "PORT_5097_ALREADY_IN_USE")
    require(cmd("nginx", "-t").returncode == 0, "NGINX_CONFIG_INVALID")
    for service in ("tkempire.service", "nginx.service"):
        require(cmd("systemctl", "is-active", "--quiet", service).returncode == 0,
                "REQUIRED_SERVICE_NOT_RUNNING")
    require(http(80, "/health", host="143.244.155.109")[0] == 404,
            "PORT_80_DEFAULT_GUARD_NOT_VERIFIED")
    require(http(5000, "/health")[0] == 200,
            "LOOPBACK_API_UNAVAILABLE")


def write_exclusive(path, raw, mode):
    # No stale service-file replacement; intended for fresh staging only.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(path, mode)


def install():
    preflight()
    print("PREFLIGHT=PASS")
    print("STAGED_SHA256=" + SOURCE_SHA256)

    app_created = unit_created = start_attempted = False
    try:
        APP_DIR.mkdir(mode=0o755)
        app_created = True
        write_exclusive(APP, SOURCE.read_bytes(), 0o644)
        require(sha256(APP.read_bytes()) == SOURCE_SHA256, "INSTALLED_SHA256_MISMATCH")

        write_exclusive(UNIT_PATH, UNIT.encode("utf-8"), 0o644)
        unit_created = True
        require(cmd("systemctl", "daemon-reload").returncode == 0,
                "SYSTEMD_RELOAD_FAILED")

        start_attempted = True
        require(cmd("systemctl", "start", UNIT_NAME).returncode == 0,
                "STAGING_SERVICE_FAILED_TO_START")

        successful = False
        for attempt in range(20):
            try:
                status, payload = http(PORT, "/signals")
                if status == 503:
                    data = json.loads(payload)
                    if data.get("status") == "publication_disabled":
                        successful = True
                        break
            except (OSError, ValueError):
                pass
            time.sleep(0.25)
        require(successful, "DISABLED_ROUTE_NOT_VERIFIED")
        require(http(PORT, "/other")[0] == 404, "NONEXISTENT_ROUTE_NOT_404")
        require(http(PORT, "/signals", "POST")[0] == 405,
                "MUTATION_METHOD_NOT_BLOCKED")
        require(sockets(PORT) == ["127.0.0.1:5097"],
                "LISTENER_NOT_EXCLUSIVELY_LOOPBACK")
        require(cmd("systemctl", "is-active", "--quiet", UNIT_NAME).returncode == 0,
                "STAGING_SERVICE_INACTIVE")
        enabled = cmd("systemctl", "is-enabled", UNIT_NAME)
        require(enabled.stdout.strip() == "disabled",
                "STAGING_SERVICE_UNEXPECTED_BOOT_ENABLEMENT")
        for service in ("tkempire.service", "nginx.service"):
            require(cmd("systemctl", "is-active", "--quiet", service).returncode == 0,
                    "PRODUCTION_SERVICE_NOT_HEALTHY")
        require(http(5000, "/health")[0] == 200,
                "LOCAL_GENESIS_API_NO_LONGER_RESPONDING")
        require(http(80, "/health", host="143.244.155.109")[0] == 404,
                "PORT80_GUARD_REGRESSION")

        print("INSTALLED_CODE_SHA256=" + sha256(APP.read_bytes()))
        print("SYSTEMD_STAGING_SERVICE=ACTIVE")
        print("SYSTEMD_BOOT_ENABLED=NO")
        print("SERVICE_USER=DYNAMIC_NON_ROOT")
        print("LISTEN_ADDRESS=127.0.0.1:5097")
        print("GET_SIGNALS_HTTP=503")
        print("GET_OTHER_HTTP=404")
        print("POST_SIGNALS_HTTP=405")
        print("PUBLISHER_DATA_ACCESS=NOT_GRANTED")
        print("PUBLICATION_ENABLED=NO")
        print("NGINX_CONFIG_MODIFIED=NO")
        print("TRADING_CONFIG_MODIFIED=NO")
        print("DISABLED_LOOPBACK_STAGING=PASS")
    except Exception:
        if start_attempted:
            cmd("systemctl", "stop", UNIT_NAME)
        if unit_created:
            UNIT_PATH.unlink(missing_ok=True)
            cmd("systemctl", "daemon-reload")
        if app_created:
            APP.unlink(missing_ok=True)
            try:
                APP_DIR.rmdir()
            except OSError:
                pass
        print("DISABLED_LOOPBACK_STAGING=FAIL_ROLLBACK_ATTEMPTED")
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    require(args.install != args.preflight, "CHOOSE_EXACTLY_ONE_MODE")
    if args.preflight:
        preflight()
        print("PREFLIGHT=PASS")
        print("FILES_MODIFIED=NONE")
    else:
        install()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Do not print filesystem paths, environment variables, or private data.
        print("INSTALL_RESULT=BLOCKED_OR_FAILED")
        print("ERROR_CLASS=" + type(exc).__name__)
        raise SystemExit(1)
