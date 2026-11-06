#!/usr/bin/env bash
# TK Empire Smart Money Monitor v1 - isolated public-data collector.
# This installer creates only new /opt and systemd files. It does not touch
# Genesis services, risk controls, execution, or the milestone registry.
set -euo pipefail
umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "INSTALL=BLOCKED REASON=root_required"
  exit 2
fi

APP=/opt/tkempire-smartmoney-v1
UNIT=tkempire-smart-money-v1.service
TIMER=tkempire-smart-money-v1.timer
SERVICE_FILE="/etc/systemd/system/$UNIT"
TIMER_FILE="/etc/systemd/system/$TIMER"
CFG=/root/tkempire/data/execution_config.json
REG=/root/tkempire/data/genesis/milestones
SOURCE=https://www.tkempire.io/api/smart-money-signals

for item in "$APP" "$SERVICE_FILE" "$TIMER_FILE"; do
  if [[ -e "$item" ]]; then
    echo "INSTALL=BLOCKED REASON=already_exists PATH=$item"
    exit 3
  fi
done

systemctl is-active --quiet tkempire.service || {
  echo "INSTALL=BLOCKED REASON=genesis_not_active"
  exit 4
}
BEFORE_PID=$(systemctl show tkempire.service --value -p MainPID)
BEFORE_CFG=$(sha256sum "$CFG" | awk '{print $1}')
BEFORE_LATEST=$(sha256sum "$REG/LATEST.json" | awk '{print $1}')
BEFORE_HISTORY=$(sha256sum "$REG/milestone_history.jsonl" | awk '{print $1}')

python3 -B - "$BEFORE_PID" <<'PY_GATE'
import json
import hashlib
import sys
from pathlib import Path

pid = sys.argv[1]
root = Path('/root/tkempire')
config = json.loads((root/'data/execution_config.json').read_text())
assert config.get('mode') == 'paper', 'PAPER gate not verified'
assert config.get('maintenance_mode') is True, 'Maintenance mode not active'
assert config.get('live_trading_enabled') is False, 'Live trading not disabled'

env = {}
for token in (Path('/proc')/pid/'environ').read_bytes().split(b'\0'):
    if b'=' in token:
        k,v = token.split(b'=', 1)
        env[k.decode(errors='replace')] = v.decode(errors='replace')
assert env.get('GENESIS_TESTNET_AUTO') == '0', 'Testnet auto gate not disabled'
assert env.get('GENESIS_SHADOW_EVIDENCE_ENABLED') == '0', 'Shadow evidence gate not disabled'

base = root/'data/genesis/milestones'
latest_path = base/'LATEST.json'
record = json.loads(latest_path.read_text())
history = [json.loads(x) for x in (base/'milestone_history.jsonl').read_text().splitlines() if x.strip()]
assert history, 'Empty history'
def rid(o):
    if not isinstance(o, dict):
        return None
    d={str(k).lower(): v for k,v in o.items()}
    for key in ('record_id','milestone_id','checkpoint_id','id'):
        if isinstance(d.get(key),str) and d[key]:return d[key]
    for key in ('record','checkpoint','milestone','latest'):
        v=rid(d.get(key))
        if v:return v
    return None
latest_id = rid(record)
assert latest_id and rid(history[-1]) == latest_id, 'History/latest mismatch'
assert latest_id in (base/'LATEST.md').read_text(), 'Markdown/latest mismatch'
record_file=base/'records'/(latest_id+'.json')
assert record_file.is_file(), 'Checkpoint file missing'
assert hashlib.sha256(record_file.read_bytes()).digest() == hashlib.sha256(latest_path.read_bytes()).digest(), 'Checkpoint hash mismatch'
print('GATE_PREFLIGHT=PASS')
print('LATEST_VERIFIED_CHECKPOINT='+latest_id)
PY_GATE

# Confirm VPS egress and schema before writing service files.
python3 -B - <<'PY_PREFLIGHT'
import json
import urllib.request
from urllib.parse import urlparse

url='https://www.tkempire.io/api/smart-money-signals'
req=urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'TK-Empire-ReadOnly-Collector/1.0'})
with urllib.request.urlopen(req, timeout=18) as response:
    assert response.status == 200, 'Public upstream HTTP not 200'
    assert urlparse(response.geturl()).hostname == 'www.tkempire.io', 'Unexpected redirect target'
    raw=response.read(700001)
    assert len(raw)<=700000, 'Public upstream response too large'
data=json.loads(raw)
assert data.get('status') in ('ok','degraded'), 'Feed unavailable'
assert data.get('execution_enabled') is False, 'Execution flag mismatch'
assert data.get('genesis_execution_authority') == 'none', 'Authority flag mismatch'
assert isinstance(data.get('signals'),list), 'Signals schema mismatch'
print('PUBLIC_SOURCE_PREFLIGHT=PASS')
print('PUBLIC_WALLETS='+str(data.get('monitored_wallets')))
print('PUBLIC_OBSERVATIONS='+str(len(data['signals'])))
PY_PREFLIGHT

STAGE=$(mktemp -d /tmp/tkempire-smartmoney-stage.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

cat >"$STAGE/collector.py" <<'PY_COLLECTOR'
#!/usr/bin/env python3
"""Standalone public-only Polymarket signal archiver. No trade execution."""
import datetime as dt
import json
import re
import sqlite3
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

SOURCE = 'https://www.tkempire.io/api/smart-money-signals'
DB = Path('/var/lib/tkempire-smartmoney-v1/signals.sqlite3')
TYPES = {
    'SMART_MONEY_BUY','SMART_MONEY_SELL','WHALE_CONSENSUS',
    'UNUSUAL_ACTIVITY','POSSIBLE_WALLET_REVERSAL'
}

def parse_utc(value):
    if not isinstance(value, str):
        raise ValueError('invalid_time')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('missing_timezone')
    return parsed.astimezone(dt.timezone.utc)

def scan():
    request = urllib.request.Request(SOURCE, headers={
        'Accept':'application/json',
        'User-Agent':'TK-Empire-ReadOnly-Collector/1.0'
    })
    with urllib.request.urlopen(request, timeout=18) as response:
        if response.status != 200:
            raise ValueError('upstream_http_not_200')
        if urlparse(response.geturl()).hostname != 'www.tkempire.io':
            raise ValueError('untrusted_redirect')
        raw = response.read(700001)
    if len(raw) > 700000:
        raise ValueError('upstream_response_too_large')
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError('response_not_object')
    if data.get('status') not in ('ok','degraded'):
        raise ValueError('source_unavailable')
    if data.get('execution_enabled') is not False or data.get('genesis_execution_authority') != 'none':
        raise ValueError('unexpected_execution_authority')

    now = dt.datetime.now(dt.timezone.utc)
    generated = parse_utc(data.get('generated_at'))
    age = (now - generated).total_seconds()
    if age < -90 or age > 240:
        raise ValueError('feed_stale_or_future')
    signals = data.get('signals')
    if not isinstance(signals, list) or len(signals) > 100:
        raise ValueError('invalid_signal_batch')

    valid = []
    for s in signals:
        if not isinstance(s, dict):
            raise ValueError('invalid_signal')
        sid = s.get('id')
        if not isinstance(sid, str) or not re.fullmatch(r'[a-f0-9]{24}', sid):
            raise ValueError('invalid_signal_id')
        if s.get('type') not in TYPES:
            raise ValueError('invalid_signal_type')
        if s.get('execution_authority') != 'none' or s.get('signal_mode') != 'OBSERVATION_ONLY':
            raise ValueError('signal_not_readonly')
        if s.get('paper_trade') is not False:
            raise ValueError('unexpected_paper_trade')
        observed = parse_utc(s.get('observed_at')).isoformat()
        if not isinstance(s.get('market'), str):
            raise ValueError('invalid_market')
        amount = s.get('amount_usdc')
        if not isinstance(amount, (int,float)) or isinstance(amount,bool) or not 0 <= amount <= 1e12:
            raise ValueError('invalid_amount')
        valid.append((
            sid, now.isoformat(), observed, s['type'], s['market'][:190],
            str(s.get('outcome',''))[:90], str(s.get('side',''))[:12],
            float(amount), json.dumps(s, separators=(',',':'))
        ))

    DB.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB, timeout=15) as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA busy_timeout=15000')
        conn.execute('CREATE TABLE IF NOT EXISTS signals '
                     '(id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL, observed_at TEXT NOT NULL, '
                     'signal_type TEXT NOT NULL, market TEXT NOT NULL, outcome TEXT NOT NULL, '
                     'side TEXT NOT NULL, amount_usdc REAL NOT NULL, payload_json TEXT NOT NULL)')
        conn.execute('CREATE TABLE IF NOT EXISTS scans '
                     '(id INTEGER PRIMARY KEY AUTOINCREMENT, scanned_at TEXT NOT NULL, '
                     'source_generated_at TEXT NOT NULL, feed_status TEXT NOT NULL, '
                     'monitored_wallets INTEGER, trades_scanned INTEGER, '
                     'signals_returned INTEGER NOT NULL, new_signals INTEGER NOT NULL, '
                     'failed_wallet_feeds INTEGER)')
        inserted = 0
        for entry in valid:
            cursor = conn.execute('INSERT OR IGNORE INTO signals VALUES (?,?,?,?,?,?,?,?,?)', entry)
            inserted += cursor.rowcount
        conn.execute('INSERT INTO scans '
                     '(scanned_at,source_generated_at,feed_status,monitored_wallets,'
                     'trades_scanned,signals_returned,new_signals,failed_wallet_feeds) '
                     'VALUES (?,?,?,?,?,?,?,?)',
                     (now.isoformat(),generated.isoformat(),data['status'],
                      data.get('monitored_wallets'),data.get('trades_scanned'),
                      len(valid),inserted,data.get('failed_wallets')))
        # Retain 90 days of publicly observed data.
        cutoff = (now-dt.timedelta(days=90)).isoformat()
        conn.execute('DELETE FROM signals WHERE observed_at < ?', (cutoff,))
        conn.execute('DELETE FROM scans WHERE scanned_at < ?', (cutoff,))
        count=conn.execute('SELECT count(*) FROM signals').fetchone()[0]
    print('PERSISTENT_SCAN=PASS'
          f' source_status={data["status"]} wallets={data.get("monitored_wallets")}'
          f' returned={len(valid)} new={inserted} stored={count}'
          f' generated_at={generated.isoformat()}')
if __name__ == '__main__':
    scan()
PY_COLLECTOR

cat >"$STAGE/$UNIT" <<'SYSTEMD_SERVICE'
[Unit]
Description=TK Empire Smart Money V1 public read-only collector
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
DynamicUser=yes
StateDirectory=tkempire-smartmoney-v1
StateDirectoryMode=0700
ExecStart=/usr/bin/python3 -B /opt/tkempire-smartmoney-v1/collector.py
Environment=PYTHONUNBUFFERED=1
TimeoutStartSec=45s
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=yes
SystemCallArchitectures=native
UMask=0077
SYSTEMD_SERVICE

cat >"$STAGE/$TIMER" <<'SYSTEMD_TIMER'
[Unit]
Description=TK Empire Smart Money V1 public signal scan every minute

[Timer]
OnBootSec=60s
OnUnitInactiveSec=60s
AccuracySec=5s
Persistent=true
Unit=tkempire-smart-money-v1.service

[Install]
WantedBy=timers.target
SYSTEMD_TIMER

python3 -B - "$STAGE/collector.py" <<'PY_SYNTAX'
import ast,sys
from pathlib import Path
ast.parse(Path(sys.argv[1]).read_text())
print('COLLECTOR_SYNTAX=PASS')
PY_SYNTAX

mkdir -p "$APP"
install -o root -g root -m 0644 "$STAGE/collector.py" "$APP/collector.py"
install -o root -g root -m 0644 "$STAGE/$UNIT" "$SERVICE_FILE"
install -o root -g root -m 0644 "$STAGE/$TIMER" "$TIMER_FILE"

systemctl daemon-reload
systemctl start "$UNIT"
systemctl enable --now "$TIMER"
systemctl is-active --quiet "$TIMER"

AFTER_PID=$(systemctl show tkempire.service --value -p MainPID)
AFTER_CFG=$(sha256sum "$CFG" | awk '{print $1}')
AFTER_LATEST=$(sha256sum "$REG/LATEST.json" | awk '{print $1}')
AFTER_HISTORY=$(sha256sum "$REG/milestone_history.jsonl" | awk '{print $1}')

[[ "$BEFORE_PID" == "$AFTER_PID" ]] || { echo "GENESIS_PID_UNCHANGED=FAIL"; exit 10; }
[[ "$BEFORE_CFG" == "$AFTER_CFG" ]] || { echo "GENESIS_CONFIG_UNCHANGED=FAIL"; exit 11; }
[[ "$BEFORE_LATEST" == "$AFTER_LATEST" && "$BEFORE_HISTORY" == "$AFTER_HISTORY" ]] || {
  echo "GENESIS_REGISTRY_UNCHANGED=FAIL"; exit 12;
}

echo "=== INSTALLED SHA256 ==="
sha256sum "$APP/collector.py" "$SERVICE_FILE" "$TIMER_FILE"
echo "=== COLLECTOR SERVICE RESULT ==="
systemctl show "$UNIT" --no-pager -p ActiveState -p SubState -p Result -p ExecMainStatus
echo "=== COLLECTOR TIMER ==="
systemctl show "$TIMER" --no-pager -p ActiveState -p UnitFileState -p NextElapseUSecRealtime
echo "=== DATA READBACK ==="
python3 -B - <<'PY_READBACK'
import sqlite3
from pathlib import Path
db=Path('/var/lib/tkempire-smartmoney-v1/signals.sqlite3')
assert db.is_file(), 'No collector database'
with sqlite3.connect(db) as conn:
    scans=conn.execute('SELECT count(*) FROM scans').fetchone()[0]
    signals=conn.execute('SELECT count(*) FROM signals').fetchone()[0]
    latest=conn.execute('SELECT feed_status,new_signals,scanned_at FROM scans ORDER BY id DESC LIMIT 1').fetchone()
assert scans>=1, 'Collector scan not saved'
print('DB_READBACK=PASS','scans='+str(scans),'unique_signals='+str(signals),
      'latest_status='+str(latest[0]),'latest_new='+str(latest[1]),'latest_scan_at='+str(latest[2]))
PY_READBACK
echo "GENESIS_PID_UNCHANGED=PASS"
echo "GENESIS_CONFIG_UNCHANGED=PASS"
echo "GENESIS_REGISTRY_UNCHANGED=PASS"
echo "EXECUTION_AUTHORITY=NONE"
echo "INSTALL_STATUS=PASS_NEW_STANDALONE_READONLY_MONITOR"
echo "MILESTONE_CHECKPOINT=NOT_YET_WRITTEN_TO_VPS"
