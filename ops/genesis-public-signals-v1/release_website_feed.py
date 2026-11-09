#!/usr/bin/env python3
"""One-shot, rollback-capable Genesis PAPER website feed release on VPS.

Switches only the credential-only read-only staging publisher and its private
refresh cycle. Preserves original binaries and original timer. Nginx, Genesis,
trade execution, API credentials, VPS firewall, and Vercel are untouched.

Public website release is a SEPARATE step after this boundary test.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
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
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT=Path("/usr/local/lib/tkempire-genesis-public-signals")
SRC_READER=ROOT/"credential_reader.py"
SRC_WORKER=ROOT/"refresh_cycle.py"
RELEASE_READER=ROOT/"credential_reader_release.py"
RELEASE_WORKER=ROOT/"refresh_cycle_release.py"
SNAPSHOT=Path("/var/lib/tkempire-genesis-signals-staging/unapproved-projection.json")
KEY=SNAPSHOT.parent/"signal-id-hmac.key"
STAGING="genesis-public-signals-staging.service"
REFRESH_SERVICE="genesis-private-signal-refresh.service"
REFRESH_TIMER="genesis-private-signal-refresh.timer"
STAGING_CONFIG=Path("/etc/systemd/system/genesis-public-signals-staging.service.d/20-private-snapshot.conf")
REFRESH_DROPIN_DIR=Path("/etc/systemd/system/genesis-private-signal-refresh.service.d")
REFRESH_DROPIN=REFRESH_DROPIN_DIR/"20-approved-reader.conf"
STAGING_BASE=Path("/etc/systemd/system/genesis-public-signals-staging.service")
NGINX=Path("/etc/nginx/sites-available/tkempire-genesis-api-stage")
BACKUP_ROOT=Path("/root/tkempire/backups/security")

STAGING_BASE_SHA="8a85b580609f2118c5967c22ac46d1903294b184acabc390274afe027e2cdb2e"
NGINX_SHA="4dc8cf49978287d86fe1c46b06c213afe0ebd419df0fe92cd5df0fd00c6bdfb5"
ORIGINAL_READER_SHA="65443d7242692083e7a06a2713ed55177bc3c79bbdda9975de355867bc47401b"
ORIGINAL_WORKER_SHA="d6d9f0701efa749c3d4ee575ea843a9f7a2b557e4cb2f989f5ae9c610c961d9c"
RELEASE_REF="2eca021353d3684e73d90e042ff71711320cae48"
READER_REF="efc863a0f153168924a3f22b171171de0a96d07d"
READER_BLOB="c3f03b49b62a9f53bab729c9768b9b84537fcb22"
WORKER_BLOB="147bee64f173fa13d8cea5f7d906d4980b1d7d4e"
CRED_DIRECTIVE="LoadCredential=genesis-signal-snapshot:/var/lib/tkempire-genesis-signals-staging/unapproved-projection.json"

NEW_STAGING = """# Explicit, reversible, approved read-only Genesis PAPER publishing.
[Service]
ExecStart=
ExecStart=/usr/bin/python3 -B /usr/local/lib/tkempire-genesis-public-signals/credential_reader_release.py --public-readonly
Environment=GENESIS_SIGNALS_PUBLICATION_APPROVED=true
LoadCredential=genesis-signal-snapshot:/var/lib/tkempire-genesis-signals-staging/unapproved-projection.json
"""
NEW_REFRESH = """# Keep original private timer, use release-aware refresh only.
[Service]
ExecStart=
ExecStart=/usr/bin/python3 -B /usr/local/lib/tkempire-genesis-public-signals/refresh_cycle_release.py
"""


class GuardError(Exception):
    pass


def need(value, code):
    if not value:
        raise GuardError(code)


def run(*args, timeout=20):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git_blob(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


def get_code(path, ref, expected_blob):
    url=("https://raw.githubusercontent.com/5pillars5/tkempire/" + ref
         + "/ops/genesis-public-signals-v1/" + path)
    with urlopen(Request(url, headers={"User-Agent":"TK-Empire-Verified-Release"}),
                 timeout=15) as resp:
        raw=resp.read(100001)
    need(len(raw)<=100000, "DOWNLOADED_SOURCE_TOO_LARGE")
    need(git_blob(raw)==expected_blob, "SOURCE_GIT_BLOB_MISMATCH")
    compile(raw, path, "exec")
    return raw


def pin(path, expected):
    """Identify the exact immutable file that blocks a release."""
    need(path.is_file() and not path.is_symlink(), "EXPECTED_FILE_MISSING")
    st=path.stat()
    need(st.st_uid==0 and stat.S_ISREG(st.st_mode), "SOURCE_OWNER_INVALID")
    actual=sha(path.read_bytes())
    label={str(SRC_READER): "GENESIS_READER",
           str(SRC_WORKER): "REFRESH_WORKER",
           str(STAGING_BASE): "STAGING_SERVICE",
           str(NGINX): "NGINX_GATEWAY"}.get(str(path), "OTHER_SOURCE")
    print(label+"_SOURCE_SHA256="+actual,flush=True)
    print(label+"_HASH_MATCH="+("PASS" if actual==expected else "FAIL"),flush=True)
    need(actual==expected, "SOURCE_HASH_CHANGED_"+label)


def service_ok(unit):
    return run("systemctl","is-active","--quiet",unit).returncode==0


def http(path="/signals", port=5097, method="GET"):
    conn=http_client.HTTPConnection("127.0.0.1",port,timeout=5)
    try:
        conn.request(method,path)
        resp=conn.getresponse()
        return resp.status,resp.read(65001)
    finally:
        conn.close()


def gateway_denies_anonymous():
    req=Request("https://api.tkempire.io/internal/genesis/signals",
                method="GET",headers={"Accept":"application/json"})
    try:
        with urlopen(req, timeout=6) as response:
            return response.status
    except HTTPError as exc:
        return exc.code


def snapshot_valid():
    need(SNAPSHOT.is_file() and not SNAPSHOT.is_symlink(),
         "SNAPSHOT_NOT_REGULAR")
    need(KEY.is_file() and not KEY.is_symlink(),
         "ID_KEY_NOT_REGULAR")
    st=SNAPSHOT.stat()
    kt=KEY.stat()
    need(st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o600,
         "SNAPSHOT_PERMISSIONS_UNSAFE")
    need(kt.st_uid==0 and stat.S_IMODE(kt.st_mode)==0o600 and kt.st_size==32,
         "ID_KEY_UNSAFE")
    obj=json.loads(SNAPSHOT.read_bytes())
    need(set(obj)=={
        "schema_version","source","publication_scope","execution_authority",
        "generated_at","engine","position_verification","signals"
    }, "SNAPSHOT_FIELDS_UNEXPECTED")
    need(obj["schema_version"]==1 and obj["source"]=="GENESIS_PUBLIC_SIGNAL_PROJECTION"
         and obj["publication_scope"]=="STAGING_NOT_APPROVED"
         and obj["execution_authority"]=="none"
         and obj["engine"]=={"mode":"paper","running":True}
         and obj["position_verification"]=="verified"
         and isinstance(obj["signals"],list) and len(obj["signals"])<=50,
         "SNAPSHOT_NOT_PAPER_VERIFIED")
    stamp=datetime.fromisoformat(obj["generated_at"].replace("Z","+00:00"))
    age=(datetime.now(timezone.utc)-stamp.astimezone(timezone.utc)).total_seconds()
    need(-30<=age<=120,"SNAPSHOT_STALE")
    return obj


def preflight():
    need(os.geteuid()==0,"ROOT_REQUIRED")
    need(ROOT.is_dir() and not ROOT.is_symlink(),"APP_DIR_INVALID")
    need(BACKUP_ROOT.is_dir() and not BACKUP_ROOT.is_symlink(),"BACKUP_DIR_INVALID")
    pin(SRC_READER,ORIGINAL_READER_SHA)
    pin(SRC_WORKER,ORIGINAL_WORKER_SHA)
    pin(STAGING_BASE,STAGING_BASE_SHA)
    pin(NGINX,NGINX_SHA)
    need(STAGING_CONFIG.is_file() and not STAGING_CONFIG.is_symlink(),
         "STAGING_DROPIN_MISSING")
    cfg=STAGING_CONFIG.read_text()
    need(cfg.count(CRED_DIRECTIVE)==1 and
         "ExecStart=/usr/bin/python3 -B /usr/local/lib/tkempire-genesis-public-signals/credential_reader.py" in cfg
         and "GENESIS_SIGNALS_PUBLICATION_APPROVED=true" not in cfg,
         "ORIGINAL_STAGING_CONFIGURATION_CHANGED")
    need(not RELEASE_READER.exists() and not RELEASE_READER.is_symlink()
         and not RELEASE_WORKER.exists() and not RELEASE_WORKER.is_symlink(),
         "RELEASE_BINARY_ALREADY_PRESENT")
    need(not REFRESH_DROPIN_DIR.exists() and not REFRESH_DROPIN_DIR.is_symlink(),
         "REFRESH_DROPIN_ALREADY_PRESENT")
    need(service_ok("tkempire.service") and service_ok("nginx.service")
         and service_ok(STAGING),"SERVICE_NOT_HEALTHY")
    need(service_ok(REFRESH_TIMER),"PILOT_TIMER_NOT_ACTIVE")
    need(run("systemctl","is-enabled",REFRESH_TIMER).stdout.strip()=="disabled",
         "UNEXPECTED_TIMER_BOOT_ENABLEMENT")
    need(run("systemctl","is-enabled",STAGING).stdout.strip()=="disabled",
         "UNEXPECTED_READER_BOOT_ENABLEMENT")
    code,data=http()
    need(code==503 and json.loads(data)=={
        "schema_version":1,"status":"publication_disabled","signals":[]
    }, "ORIGINAL_READER_NOT_DISABLED")
    need(gateway_denies_anonymous() in (401,403),
         "UPSTREAM_AUTH_NOT_ENFORCED")
    need(run("nginx","-t").returncode==0,"NGINX_SYNTAX_FAIL")
    snapshot_valid()
    print("WEBSITE_FEED_PREFLIGHT=PASS",flush=True)


def create_exclusive(path,raw,mode):
    fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,"wb") as writer:
        writer.write(raw)
        writer.flush()
        os.fsync(writer.fileno())
    os.chmod(path,mode)


def atomic_write(path,raw,mode):
    fd,tmp=tempfile.mkstemp(prefix=".release-",dir=str(path.parent))
    try:
        with os.fdopen(fd,"wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp,mode)
        os.replace(tmp,path)
        dfd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def proof():
    for unit in ("tkempire.service","nginx.service",STAGING,REFRESH_TIMER):
        need(service_ok(unit),"POST_RELEASE_SERVICE_FAILURE")
    need(gateway_denies_anonymous() in (401,403),
         "AUTH_BYPASS_DETECTED")
    status,data=http()
    need(status==200 and len(data)<=60000,"LOCAL_FEED_NOT_AVAILABLE")
    obj=json.loads(data)
    need(obj.get("publication_scope")=="PUBLIC_APPROVED"
         and obj.get("source")=="GENESIS_PUBLIC_SIGNAL_PROJECTION"
         and obj.get("execution_authority")=="none"
         and obj.get("position_verification")=="verified"
         and obj.get("engine")=={"mode":"paper","running":True}
         and isinstance(obj.get("signals"),list)
         and len(obj["signals"])<=50,
         "PUBLIC_PROJECTION_INVALID")
    need(http("/other")[0]==404 and http("/signals",method="POST")[0]==405,
         "READER_WRITE_METHOD_NOT_DENIED")
    need(run("nginx","-t").returncode==0,"NGINX_SYNTAX_FAIL")
    need(sha(SRC_READER.read_bytes())==ORIGINAL_READER_SHA and
         sha(SRC_WORKER.read_bytes())==ORIGINAL_WORKER_SHA and
         sha(NGINX.read_bytes())==NGINX_SHA,"PINNED_SOURCES_CHANGED")
    need(snapshot_valid()["publication_scope"]=="STAGING_NOT_APPROVED",
         "PRIVATE_SNAPSHOT_SCOPE_CHANGED")
    return obj


def install(reader_code,worker_code):
    preflight()
    timer_stopped=False
    stage_changed=False
    refresh_created=False
    reader_created=False
    worker_created=False
    old_cfg=STAGING_CONFIG.read_bytes()
    backup=None
    try:
        need(run("systemctl","stop",REFRESH_TIMER).returncode==0,
             "TIMER_PAUSE_FAILED")
        timer_stopped=True
        for _ in range(30):
            if not service_ok(REFRESH_SERVICE):
                break
            time.sleep(0.25)
        need(not service_ok(REFRESH_SERVICE),"REFRESH_STILL_IN_PROGRESS")
        # Refresh once through the existing and verified disabled path.
        need(run("systemctl","start",REFRESH_SERVICE,timeout=55).returncode==0,
             "ORIGINAL_PRIVATE_REFRESH_FAILED")
        obj=snapshot_valid()
        backup=Path(tempfile.mkdtemp(prefix="genesis-website-release-",
                                    dir=BACKUP_ROOT))
        backup.chmod(0o700)
        for source,name in ((STAGING_CONFIG,"old-staging.conf"),
                            (SNAPSHOT,"previous-snapshot.json")):
            raw=source.read_bytes()
            create_exclusive(backup/name,raw,0o600)
            need((backup/name).read_bytes()==raw,"BACKUP_READBACK_FAILED")
        print("BACKUP_DIR="+str(backup),flush=True)
        print("BACKUP_SNAPSHOT_SHA256="+sha((backup/"previous-snapshot.json").read_bytes()),
              flush=True)
        create_exclusive(RELEASE_READER,reader_code,0o644)
        reader_created=True
        create_exclusive(RELEASE_WORKER,worker_code,0o600)
        worker_created=True
        need(git_blob(RELEASE_READER.read_bytes())==READER_BLOB
             and git_blob(RELEASE_WORKER.read_bytes())==WORKER_BLOB,
             "RELEASE_CODE_READBACK_FAILED")
        REFRESH_DROPIN_DIR.mkdir(mode=0o755)
        refresh_created=True
        create_exclusive(REFRESH_DROPIN,NEW_REFRESH.encode(),0o644)
        atomic_write(STAGING_CONFIG,NEW_STAGING.encode(),0o644)
        stage_changed=True
        need(run("systemctl","daemon-reload").returncode==0,
             "DAEMON_RELOAD_FAILED")
        need(run("systemctl","restart",STAGING,timeout=20).returncode==0,
             "APPROVED_READER_START_FAILED")
        # Verify a complete private refresh using the new release-aware worker.
        need(run("systemctl","start",REFRESH_SERVICE,timeout=65).returncode==0,
             "APPROVED_REFRESH_CYCLE_FAILED")
        need(run("systemctl","start",REFRESH_TIMER).returncode==0,
             "TIMER_RESUME_FAILED")
        released=proof()
        print("LOCAL_SIGNALS_HTTP=200")
        print("ANONYMOUS_GATEWAY=401_OR_403")
        print("APPROVED_SIGNAL_COUNT="+str(len(released["signals"])))
        print("VERIFIED_PAPER_OPEN="+str(sum(
            x["stage"]=="PAPER_OPEN" for x in released["signals"]
        )))
        print("PRIVATE_SNAPSHOT_SCOPE=STAGING_NOT_APPROVED")
        print("TRADING_ENGINE_CONFIG_MODIFIED=NO")
        print("NGINX_CONFIG_MODIFIED=NO")
        print("PILOT_TIMER_ACTIVE=YES")
        print("READER_BOOT_ENABLED=NO")
        print("WEBSITE_VERCEL_PUBLICATION_ENABLED=NO")
        print("VPS_APPROVED_READONLY_FEED=PASS")
    except Exception as exc:
        print("WEBSITE_FEED_RELEASE=FAILED_ROLLBACK_ATTEMPTED",flush=True)
        run("systemctl","stop",REFRESH_TIMER)
        if stage_changed:
            atomic_write(STAGING_CONFIG,old_cfg,0o644)
        if refresh_created:
            REFRESH_DROPIN.unlink(missing_ok=True)
            REFRESH_DROPIN_DIR.rmdir()
        reload_ok=run("systemctl","daemon-reload").returncode==0
        stage_ok=run("systemctl","restart",STAGING).returncode==0 if reload_ok else False
        if reader_created:
            RELEASE_READER.unlink(missing_ok=True)
        if worker_created:
            RELEASE_WORKER.unlink(missing_ok=True)
        timer_ok=run("systemctl","start",REFRESH_TIMER).returncode==0
        print("ROLLBACK_READER_RESTART="+("PASS" if stage_ok else "FAIL"))
        print("ROLLBACK_TIMER_RESUME="+("PASS" if timer_ok else "FAIL"))
        print("ERROR_CLASS="+type(exc).__name__)
        if isinstance(exc,GuardError):
            print("ERROR_CODE="+str(exc))
        raise SystemExit(1)


def main():
    parser=argparse.ArgumentParser()
    g=parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--preflight",action="store_true")
    g.add_argument("--install",action="store_true")
    args=parser.parse_args()
    reader=get_code("credential_reader.py",READER_REF,READER_BLOB)
    worker=get_code("refresh_cycle_release.py",RELEASE_REF,WORKER_BLOB)
    print("RELEASE_SOURCES_PINNED=PASS",flush=True)
    if args.preflight:
        preflight()
        print("FILES_MODIFIED=NONE")
    else:
        install(reader,worker)


if __name__=="__main__":
    try:
        main()
    except Exception as exc:
        print("WEBSITE_FEED_RELEASE=BLOCKED")
        print("ERROR_CLASS="+type(exc).__name__)
        if isinstance(exc,GuardError):
            print("ERROR_CODE="+str(exc))
        raise SystemExit(1)
