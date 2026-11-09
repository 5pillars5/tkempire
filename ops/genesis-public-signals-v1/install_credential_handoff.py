#!/usr/bin/env python3
"""Install isolated systemd LoadCredential handoff to the DISABLED Genesis reader.

Safety:
- Does not enable/publicly publish signals or change Nginx, UFW, Genesis.
- Requires pinned existing systemd unit, app, and root-only snapshot hashes.
- Uses a new staging-unit-only drop-in and separately pinned credential reader.
- Snapshots original unit before change; rolls back staging unit on failure.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import http.client as http_client
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen

UNIT_NAME = "genesis-public-signals-staging.service"
UNIT_PATH = Path("/etc/systemd/system") / UNIT_NAME
UNIT_SHA256 = "8a85b580609f2118c5967c22ac46d1903294b184acabc390274afe027e2cdb2e"
APP_DIR = Path("/usr/local/lib/tkempire-genesis-public-signals")
ORIGINAL_APP = APP_DIR / "publisher.py"
ORIGINAL_APP_SHA256 = "4ed81f93c11891310eab4ad8093adf26cae2ffdab676839eea666bf79fd23d4c"
READER_FILE = APP_DIR / "credential_reader.py"
READER_REF = "eb48c649ffaebf65fee25fa9152c6a4a461f9c64"
READER_BLOB = "d2f682caf536b63d4a17b25b27c211c4ce5bb519"
READER_URL = ("https://raw.githubusercontent.com/5pillars5/tkempire/" +
              READER_REF + "/ops/genesis-public-signals-v1/credential_reader.py")
SNAPSHOT_DIR = Path("/var/lib/tkempire-genesis-signals-staging")
SNAPSHOT = SNAPSHOT_DIR / "unapproved-projection.json"
SNAPSHOT_SHA256 = "1057e962c986cfdf69a6b8281dd08882765b9e22550e546d6bd0df6593ca3efe"
OVERRIDE_DIR = Path("/etc/systemd/system/genesis-public-signals-staging.service.d")
OVERRIDE = OVERRIDE_DIR / "20-private-snapshot.conf"
NGINX_CONFIG = Path("/etc/nginx/sites-available/tkempire-genesis-api-stage")
NGINX_SHA256 = "4dc8cf49978287d86fe1c46b06c213afe0ebd419df0fe92cd5df0fd00c6bdfb5"
BACKUP_ROOT = Path("/root/tkempire/backups/security")

OVERRIDE_CONTENT = """# Genesis read-only credential handoff (staging; publication disabled).
[Service]
ExecStart=
ExecStart=/usr/bin/python3 -B /usr/local/lib/tkempire-genesis-public-signals/credential_reader.py
LoadCredential=genesis-signal-snapshot:/var/lib/tkempire-genesis-signals-staging/unapproved-projection.json
"""


def run(*argv, timeout=20):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def git_blob(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


def fetch_reader():
    req = Request(READER_URL, headers={"User-Agent": "TK-Empire-Private-Credential-Staging"})
    with urlopen(req, timeout=12) as response:
        code = response.read(100001)
    require(len(code) <= 100000, "READER_TOO_LARGE")
    require(git_blob(code) == READER_BLOB, "READER_GIT_BLOB_MISMATCH")
    ast.parse(code.decode("utf8"))
    return code


def probe(port, path, method="GET", host="127.0.0.1"):
    connection = http_client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request(method, path, headers={"Host": host})
        response = connection.getresponse()
        data = response.read(4096)
        return response.status, data
    finally:
        connection.close()


def port_bindings():
    result = run("ss", "-H", "-lnt")
    require(result.returncode == 0, "SOCKET_INVENTORY_FAILED")
    return [
        row.split()[3] for row in result.stdout.splitlines()
        if len(row.split()) >= 4 and row.split()[3].rsplit(":", 1)[-1] == "5097"
    ]


def check_disabled_route():
    status, raw = probe(5097, "/signals")
    require(status == 503, "PUBLISHER_NOT_DISABLED")
    payload = json.loads(raw)
    require(payload.get("status") == "publication_disabled" and payload.get("signals") == [],
            "PUBLISHER_MAY_EXPOSE_DATA")


def verify_services():
    for name in ("tkempire.service", "nginx.service", UNIT_NAME):
        require(run("systemctl", "is-active", "--quiet", name).returncode == 0,
                "REQUIRED_SERVICE_NOT_ACTIVE")
    require(run("nginx", "-t").returncode == 0, "NGINX_CONFIG_INVALID")
    require(run("systemctl", "is-enabled", UNIT_NAME).stdout.strip() == "disabled",
            "STAGING_UNIT_ENABLED_AT_BOOT")
    require(port_bindings() == ["127.0.0.1:5097"], "STAGING_BIND_NOT_LOOPBACK")
    check_disabled_route()
    require(probe(5097, "/private")[0] == 404, "UNEXPECTED_PRIVATE_ROUTE")
    require(probe(5097, "/signals", "POST")[0] == 405, "POST_NOT_REJECTED")
    require(probe(5000, "/health")[0] == 200, "GENESIS_LOCAL_HEALTH_FAILED")
    require(probe(80, "/health", host="143.244.155.109")[0] == 404,
            "PORT80_DEFAULT_PROXY_REGRESSION")
    require(sha256(NGINX_CONFIG.read_bytes()) == NGINX_SHA256,
            "NGINX_CONFIG_HASH_CHANGED")


def preflight():
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    require(UNIT_PATH.is_file() and not UNIT_PATH.is_symlink(), "UNIT_PATH_UNEXPECTED")
    require(sha256(UNIT_PATH.read_bytes()) == UNIT_SHA256, "UNIT_CHANGED_SINCE_AUDIT")
    require(ORIGINAL_APP.is_file() and not ORIGINAL_APP.is_symlink(), "PUBLISHER_PATH_UNEXPECTED")
    require(sha256(ORIGINAL_APP.read_bytes()) == ORIGINAL_APP_SHA256,
            "CURRENT_PUBLISHER_HASH_MISMATCH")
    require(APP_DIR.is_dir() and not APP_DIR.is_symlink(), "APP_DIR_UNEXPECTED")
    require(not READER_FILE.exists() and not READER_FILE.is_symlink(), "READER_ALREADY_PRESENT")
    require(not OVERRIDE_DIR.exists() and not OVERRIDE_DIR.is_symlink(),
            "DROPIN_DIRECTORY_ALREADY_PRESENT")
    require(SNAPSHOT_DIR.is_dir() and not SNAPSHOT_DIR.is_symlink(),
            "SNAPSHOT_DIR_INVALID")
    require(SNAPSHOT.is_file() and not SNAPSHOT.is_symlink(), "SNAPSHOT_INVALID")
    dstat, fstat = SNAPSHOT_DIR.stat(), SNAPSHOT.stat()
    require(dstat.st_uid == 0 and fstat.st_uid == 0
            and stat.S_IMODE(dstat.st_mode) == 0o700
            and stat.S_IMODE(fstat.st_mode) == 0o600,
            "SNAPSHOT_PERMISSIONS_CHANGED")
    require(sha256(SNAPSHOT.read_bytes()) == SNAPSHOT_SHA256,
            "SNAPSHOT_HASH_CHANGED")
    unit = run("systemctl", "cat", UNIT_NAME)
    require(unit.returncode == 0, "UNIT_CONFIG_UNAVAILABLE")
    require(not re.search(
        r"(?m)^[ \t]*(?:LoadCredential|LoadCredentialEncrypted|SetCredential|SetCredentialEncrypted)[ \t]*=",
        unit.stdout
    ), "UNIT_HAS_EXISTING_CREDENTIAL_DIRECTIVES")
    require("DynamicUser=yes" in unit.stdout
            and "ProtectHome=yes" in unit.stdout
            and "GENESIS_SIGNALS_PUBLISH_ENABLED=false" in unit.stdout,
            "STAGING_SAFETY_FLAGS_CHANGED")
    verify_services()
    print("HANDOFF_PREFLIGHT=PASS", flush=True)


def write_exclusive(path, content, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as writer:
        writer.write(content)
        writer.flush()
        os.fsync(writer.fileno())
    os.chmod(path, mode)


def verify_credential_handoff():
    verify_services()
    unit = run("systemctl", "cat", UNIT_NAME)
    require(unit.returncode == 0, "UNIT_READBACK_FAILED")
    exact = "LoadCredential=genesis-signal-snapshot:" + str(SNAPSHOT)
    require(unit.stdout.count(exact) == 1, "CREDENTIAL_DIRECTIVE_NOT_UNIQUE")
    require(unit.stdout.count(
        "ExecStart=/usr/bin/python3 -B " + str(READER_FILE)) == 1,
        "READER_EXECSTART_UNVERIFIED")
    require("ExecStart=\n" in unit.stdout, "ORIGINAL_EXECSTART_NOT_CLEARED")
    manager = run("systemctl", "show", UNIT_NAME, "-p", "NeedDaemonReload")
    require("NeedDaemonReload=no" in manager.stdout, "SYSTEMD_DAEMON_RELOAD_PENDING")
    since = run("journalctl", "-u", UNIT_NAME, "-n", "150", "-o", "cat", "--no-pager")
    require(since.returncode == 0, "SERVICE_START_LOG_UNAVAILABLE")
    require("CREDENTIAL_SNAPSHOT_LOAD=PASS" in since.stdout, "READER_CREDENTIAL_LOAD_NOT_PROVEN")
    require("PUBLICATION_ENABLED=NO" in since.stdout, "READER_PUBLICATION_GATE_NOT_PROVEN")
    require("SNAPSHOT_SCOPE=STAGING_NOT_APPROVED" in since.stdout,
            "READER_STAGING_SCOPE_NOT_PROVEN")


def install(code):
    preflight()
    require(git_blob(code) == READER_BLOB, "READER_HASH_CHANGED")
    backup_dir = Path(tempfile.mkdtemp(prefix="genesis-credential-handoff-", dir=BACKUP_ROOT))
    backup_dir.chmod(0o700)
    backup = backup_dir / "original.service"
    shutil.copy2(UNIT_PATH, backup)
    backup.chmod(0o600)
    require(sha256(backup.read_bytes()) == UNIT_SHA256, "UNIT_BACKUP_MISMATCH")
    print("BACKUP_PATH=" + str(backup), flush=True)
    print("BACKUP_SHA256=" + sha256(backup.read_bytes()), flush=True)

    reader_created = dropin_created = restart_attempted = False
    try:
        write_exclusive(READER_FILE, code, 0o644)
        reader_created = True
        require(git_blob(READER_FILE.read_bytes()) == READER_BLOB, "INSTALLED_READER_HASH_MISMATCH")
        OVERRIDE_DIR.mkdir(mode=0o755)
        dropin_created = True
        write_exclusive(OVERRIDE, OVERRIDE_CONTENT.encode("utf8"), 0o644)
        require(run("systemctl", "daemon-reload").returncode == 0, "DAEMON_RELOAD_FAILED")
        restart_attempted = True
        require(run("systemctl", "restart", UNIT_NAME).returncode == 0,
                "READER_RESTART_FAILED")
        verified = False
        for _ in range(20):
            try:
                verify_credential_handoff()
                verified = True
                break
            except (RuntimeError, ConnectionError, OSError, TimeoutError, json.JSONDecodeError):
                time.sleep(0.3)
        require(verified, "READER_ISOLATION_NOT_VERIFIED")
        require(sha256(UNIT_PATH.read_bytes()) == UNIT_SHA256, "BASE_UNIT_UNEXPECTEDLY_CHANGED")
        require(sha256(SNAPSHOT.read_bytes()) == SNAPSHOT_SHA256,
                "SOURCE_SNAPSHOT_UNEXPECTEDLY_CHANGED")
        print("INSTALLED_READER_SHA256=" + sha256(READER_FILE.read_bytes()))
        print("UNIT_DROPIN_PATH=" + str(OVERRIDE))
        print("CREDENTIAL_SOURCE_READBACK=PASS")
        print("SANITISED_SNAPSHOT_HANDOFF=PASS")
        print("SOURCE_SNAPSHOT_PERMISSIONS=UNCHANGED")
        print("STAGING_SERVICE=ACTIVE_DISABLED_AT_BOOT")
        print("LISTEN_ADDRESS=127.0.0.1:5097")
        print("LOCAL_SIGNAL_HTTP=503")
        print("HTTP_SIGNAL_ROWS=NONE")
        print("NGINX_CONFIG_MODIFIED=NO")
        print("TRADING_CONFIG_MODIFIED=NO")
        print("PUBLICATION_ENABLED=NO")
        print("CREDENTIAL_HANDOFF_INSTALL=PASS")
    except Exception as exc:
        print("CREDENTIAL_HANDOFF_INSTALL=FAIL")
        if dropin_created:
            OVERRIDE.unlink(missing_ok=True)
            try:
                OVERRIDE_DIR.rmdir()
            except OSError:
                pass
        reload_ok = run("systemctl", "daemon-reload").returncode == 0
        restart_ok = run("systemctl", "restart", UNIT_NAME).returncode == 0 if reload_ok else False
        if reader_created:
            READER_FILE.unlink(missing_ok=True)
        print("ROLLBACK_RELOAD_OK=" + str(reload_ok))
        print("ROLLBACK_RESTART_OK=" + str(restart_ok))
        try:
            require(reload_ok and restart_ok, "ROLLBACK_RESTART_FAILED")
            verify_services()
            require(sha256(UNIT_PATH.read_bytes()) == UNIT_SHA256, "BASE_UNIT_CHANGED")
            print("ROLLBACK_VERIFIED=PASS")
        except Exception:
            print("ROLLBACK_VERIFIED=FAIL")
        print("ERROR_TYPE=" + type(exc).__name__)
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--preflight", action="store_true")
    group.add_argument("--install", action="store_true")
    args = parser.parse_args()
    require(BACKUP_ROOT.is_dir(), "BACKUP_ROOT_MISSING")
    code = fetch_reader()
    print("PINNED_READER_BLOB_MATCH=PASS", flush=True)
    print("PINNED_READER_SHA256=" + sha256(code), flush=True)
    if args.preflight:
        preflight()
        print("FILES_MODIFIED=NONE")
    else:
        install(code)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("CREDENTIAL_HANDOFF=BLOCKED")
        print("ERROR_TYPE=" + type(exc).__name__)
        raise SystemExit(1)
