#!/usr/bin/env python3
"""Write and verify the Genesis Smart Money V1 milestone, without trading changes."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

REG=Path('/root/tkempire/data/genesis/milestones')
BACKUPS=Path('/root/tkempire/backups/milestones')
CONFIG=Path('/root/tkempire/data/execution_config.json')
DB=Path('/var/lib/tkempire-smartmoney-v1/signals.sqlite3')
PREVIOUS='20261106T133116Z_genesis_profit_exit_repair_v1_observability_installed_verified'
SUFFIX='genesis_smart_money_monitor_v1_persistent_readonly_verified'
EXPECTED={
 '/opt/tkempire-smartmoney-v1/collector.py':'48b99da81cf5c29150997bfb9668cb04089d2b6073b3f920d76619a94f504e44',
 '/etc/systemd/system/tkempire-smart-money-v1.service':'71d9d408278fb748bf8b3aafe2cc89bab19cbd07155042568606ebeb58b726c0',
 '/etc/systemd/system/tkempire-smart-money-v1.timer':'c75d1e8cb6be6de3f9747a0c427c4e61d06aaa73367d5e4f27b60bd559d95256',
}
def now():return dt.datetime.now(dt.timezone.utc)
def iso(t):return t.isoformat().replace('+00:00','Z')
def hash_of(path_or_bytes):
    b=path_or_bytes.read_bytes() if isinstance(path_or_bytes,Path) else path_or_bytes
    return hashlib.sha256(b).hexdigest()
def require_file(p):
    if p.is_symlink() or not p.is_file() or not stat.S_ISREG(p.stat().st_mode):
        raise RuntimeError('missing_or_unsafe_file '+str(p))
    return p
def show(unit,key):
    r=subprocess.run(['systemctl','show',unit,'--value','-p',key],
                     capture_output=True,text=True,timeout=15)
    if r.returncode:raise RuntimeError('systemctl_show_failed '+unit+' '+key)
    return r.stdout.strip()
def health():
    if show('tkempire.service','ActiveState')!='active' or show('tkempire.service','SubState')!='running':
        raise RuntimeError('genesis_not_running')
    pid=show('tkempire.service','MainPID')
    if pid!='2217257' or show('tkempire.service','NRestarts')!='0':
        raise RuntimeError('genesis_pid_or_restart_changed')
    cfg=json.loads(require_file(CONFIG).read_text())
    if cfg.get('mode')!='paper' or cfg.get('maintenance_mode') is not True or cfg.get('live_trading_enabled') is not False:
        raise RuntimeError('genesis_paper_maintenance_gates_failed')
    env={}
    for x in (Path('/proc')/pid/'environ').read_bytes().split(b'\0'):
        if b'=' in x:
            k,v=x.split(b'=',1)
            if k in (b'GENESIS_TESTNET_AUTO',b'GENESIS_SHADOW_EVIDENCE_ENABLED'):
                env[k.decode()]=v.decode('ascii',errors='replace')
    if env.get('GENESIS_TESTNET_AUTO')!='0' or env.get('GENESIS_SHADOW_EVIDENCE_ENABLED')!='0':
        raise RuntimeError('genesis_execution_flags_not_disabled')
    if show('tkempire-smart-money-v1.timer','ActiveState')!='active' or show('tkempire-smart-money-v1.timer','UnitFileState')!='enabled':
        raise RuntimeError('smartmoney_timer_not_active_enabled')
    if show('tkempire-smart-money-v1.service','Result')!='success' or show('tkempire-smart-money-v1.service','ExecMainStatus')!='0':
        raise RuntimeError('smartmoney_last_service_result_failed')
    actual={}
    for f,expected in EXPECTED.items():
        actual[f]=hash_of(require_file(Path(f)))
        if actual[f]!=expected:raise RuntimeError('installed_hash_mismatch '+f)
    require_file(DB)
    with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True,timeout=15) as conn:
        if conn.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
            raise RuntimeError('sqlite_integrity_failure')
        scans=conn.execute('SELECT COUNT(*) FROM scans').fetchone()[0]
        unique=conn.execute('SELECT COUNT(*) FROM signals').fetchone()[0]
        last=conn.execute('SELECT scanned_at, feed_status, monitored_wallets, signals_returned FROM scans ORDER BY id DESC LIMIT 1').fetchone()
    if scans<9 or unique<63 or not last:raise RuntimeError('insufficient_recurring_scans')
    when=dt.datetime.fromisoformat(last[0].replace('Z','+00:00'))
    if when.tzinfo is None or not -90<=(now()-when).total_seconds()<=900:
        raise RuntimeError('latest_scan_stale_or_invalid')
    if last[1]!='ok' or not isinstance(last[2],int) or last[2]<1 or not isinstance(last[3],int) or last[3]<1:
        raise RuntimeError('collector_source_unhealthy')
    return {
      'genesis':{'pid':int(pid),'state':'active/running','restarts':0,
         'mode':'paper','maintenance_mode':True,'live_trading_enabled':False,
         'testnet_auto':'0','shadow_evidence':'0','execution_config_sha256':hash_of(CONFIG)},
      'monitor':{'timer':'enabled/active','service_result':'success','last_exit_code':0,
         'database_integrity':'ok','total_scans':scans,'unique_signals':unique,
         'latest_scan_utc':iso(when.astimezone(dt.timezone.utc)),
         'source_status':last[1],'monitored_wallets':last[2],'returned_signals':last[3]},
      'installed_sha256':actual,
    }
def load_registry(base):
    latest_path=require_file(base/'LATEST.json')
    md_path=require_file(base/'LATEST.md')
    hist_path=require_file(base/'milestone_history.jsonl')
    latest_bytes=latest_path.read_bytes()
    md_bytes=md_path.read_bytes()
    hist_bytes=hist_path.read_bytes()
    if not hist_bytes.endswith(b'\n'):raise RuntimeError('history_missing_newline')
    latest=json.loads(latest_bytes)
    entries=[json.loads(x) for x in hist_bytes.splitlines() if x.strip()]
    if not entries or latest!=entries[-1]:raise RuntimeError('latest_history_mismatch')
    rid=latest.get('record_id')
    if not isinstance(rid,str) or not rid:raise RuntimeError('invalid_record_id')
    record=require_file(base/'records'/(rid+'.json'))
    if record.read_bytes()!=latest_bytes:raise RuntimeError('record_latest_not_identical')
    if rid.encode() not in md_bytes:raise RuntimeError('markdown_latest_mismatch')
    if latest.get('schema_version')!='empire_milestone_record_v1':
        raise RuntimeError('unsupported_schema')
    for p in (latest_path,md_path,hist_path):
        if (p.stat().st_mode & 0o777)!=0o650:raise RuntimeError('registry_mode_changed '+p.name)
    return latest,entries,latest_bytes,md_bytes,hist_bytes
def writeall(fd,b):
    mv=memoryview(b)
    while mv:
        n=os.write(fd,mv)
        if n<=0:raise RuntimeError('short_write')
        mv=mv[n:]
def fsyncdir(path):
    fd=os.open(str(path),os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)
def publish(path,b):
    original=path.stat()
    fd,tmp=tempfile.mkstemp(prefix='.milestone-',dir=str(path.parent))
    try:
        os.fchmod(fd,stat.S_IMODE(original.st_mode))
        if os.geteuid()!=original.st_uid or os.getegid()!=original.st_gid:
            os.fchown(fd,original.st_uid,original.st_gid)
        writeall(fd,b)
        os.fsync(fd)
        os.close(fd)
        fd=-1
        os.replace(tmp,path)
        fsyncdir(path.parent)
    finally:
        if fd>=0:os.close(fd)
        if os.path.exists(tmp):os.unlink(tmp)
def make_record(prev,count,proof,backup,base):
    rid=now().strftime('%Y%m%dT%H%M%SZ')+'_'+SUFFIX
    return {
      'schema_version':'empire_milestone_record_v1',
      'record_id':rid,'created_at_utc':iso(now()),
      'checkpoint_status':prev.get('checkpoint_status','PASS'),
      'status':prev.get('status','VERIFIED'),
      'scope':'Genesis Smart Money Monitor V1 / isolated public-data observability',
      'objective':'Checkpoint verified, persistent, read-only Polymarket wallet observations',
      'predecessor_record_id':prev['record_id'],
      'predecessor_milestone':prev.get('exact_current_milestone',''),
      'predecessor_history_entries':count,
      'recovery_journals_recovered_before_write':[],
      'decisions_made':[
        'Maintain PAPER mode and maintenance; no testnet or mainnet execution',
        'Keep Smart Money collector isolated from Genesis and trading credentials',
        'Archive recurring scan proof with database integrity and SHA-256 readback',
      ],
      'evidence':{
        'runtime':proof['monitor'],
        'genesis':proof['genesis'],
        'installed_sha256':proof['installed_sha256'],
        'backup_directory':str(backup),
        'previous_record_sha256':hash_of(base/'LATEST.json'),
        'commands_executed':[
          'Operator SSH: SHA-verified monitor installer; initial failure diagnosed',
          'Operator SSH: permission repair; successful scan and timer enablement',
          'Operator SSH: 9+ recurring scans and SQLite integrity readback',
          'Operator SSH: registry-schema inspection and guarded checkpoint write',
        ],
        'files_created_or_modified':[
          str(base/'records'/(rid+'.json')),
          str(base/'LATEST.json'),
          str(base/'LATEST.md'),
          str(base/'milestone_history.jsonl'),
        ],
        'observability_note':'Public signals; not copy trading, validated profitability, or order execution',
      },
      'test_and_verification_results':{
        'runtime_service_health':'PASS','paper_mode':True,
        'maintenance_active':True,'execution_disabled':True,
        'timer_active_enabled':True,'automatic_rescans_verified':True,
        'scans':proof['monitor']['total_scans'],
        'unique_signals':proof['monitor']['unique_signals'],
        'sqlite_integrity':'ok','installed_hashes_match_baseline':True,
        'backup_hash_readback':True,
      },
      'production_decision':'READ_ONLY_MONITOR_OPERATIONAL; GENESIS_TRADING_UNCHANGED',
      'risks_unresolved_issues_and_pending_evidence':[
        'BNB natural exit monitoring under maintenance not independently proven',
        'DOT orphaned PAPER snapshot still requires reconciliation',
        'Polymarket leaderboard selection and 60-signal feed cap limit completeness',
        'Signal profitability, execution slippage and paper-outcome ledger unverified',
        'Telegram alerts and automated order execution not installed',
      ],
      'exact_current_milestone':'GENESIS_SMART_MONEY_MONITOR_V1_PERSISTENT_READONLY_VERIFIED',
      'exact_next_milestone':'GENESIS_SMART_MONEY_V1_SIGNAL_EVALUATION_AND_ALERT_DELIVERY',
      'exact_next_action':'Verify BNB natural exits separately; extend paper-outcome research and alert delivery without enabling trading',
    }
def markdown(rec,proof):
    m=proof['monitor']
    return ('# Genesis Smart Money Monitor V1 — verified\n\n'
       +'Record ID: '+rec['record_id']+'\n\n'
       +'Schema: empire_milestone_record_v1\n\n'
       +'Checkpoint: PASS — standalone persistent public-data collector\n\n'
       +'Created UTC: '+rec['created_at_utc']+'\n\n'
       +'## Verified evidence\n'
       +'- Genesis PAPER, maintenance and execution gates unchanged\n'
       +'- Genesis PID: '+str(proof['genesis']['pid'])+'; restarts: 0\n'
       +'- Monitor timer: enabled and active\n'
       +'- SQLite integrity: ok; scans: '+str(m['total_scans'])
       +'; unique signals: '+str(m['unique_signals'])+'\n'
       +'- Last scan: '+m['latest_scan_utc']+'\n'
       +'- Backup directory: '+rec['evidence']['backup_directory']+'\n\n'
       +'## Remaining risks\n'
       +'\n'.join('- '+r for r in rec['risks_unresolved_issues_and_pending_evidence'])
       +'\n\n## Exact next stage\n'+rec['exact_next_milestone']
       +'\n\n## Exact next action\n'+rec['exact_next_action']+'\n')
def checkpoint(base,backup_root,health_fn):
    path=require_file(base/'milestone_history.jsonl')
    fd=os.open(str(path),os.O_RDWR|os.O_APPEND|getattr(os,'O_NOFOLLOW',0))
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        old,entries,b_latest,b_md,b_hist=load_registry(base)
        if old['record_id'].endswith(SUFFIX):
            health_fn()
            print('MILESTONE_ALREADY_PRESENT='+old['record_id'])
            print('MILESTONE_CHECKPOINT=PASS')
            return old
        if old['record_id']!=PREVIOUS or len(entries)!=250:
            raise RuntimeError('unexpected_predecessor_abort')
        before=health_fn()
        print('PREFLIGHT=PASS SCANS='+str(before['monitor']['total_scans'])
              +' SIGNALS='+str(before['monitor']['unique_signals']))
        backup_root.mkdir(parents=True,exist_ok=True,mode=0o700)
        backup=backup_root/('smartmoney_v1_'+now().strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(mode=0o700)
        originals=[base/'LATEST.json',base/'LATEST.md',path,
                   base/'records'/(old['record_id']+'.json')]
        manifest={}
        for p in originals:
            dst=backup/p.name
            shutil.copy2(p,dst)
            if hash_of(p)!=hash_of(dst):raise RuntimeError('backup_readback_failed')
            manifest[p.name]=hash_of(dst)
        manifest_path=backup/'SHA256_MANIFEST.json'
        manifest_path.write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
        if json.loads(manifest_path.read_text())!=manifest:
            raise RuntimeError('backup_manifest_readback_failed')
        print('BACKUP_READBACK=PASS')
        print('BACKUP_DIRECTORY='+str(backup))
        rec=make_record(old,len(entries),before,backup,base)
        rid=rec['record_id']
        recpath=base/'records'/(rid+'.json')
        if recpath.exists():raise RuntimeError('record_id_collision')
        pretty=(json.dumps(rec,sort_keys=True,indent=2,ensure_ascii=False)+'\n').encode()
        line=(json.dumps(rec,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
        md=markdown(rec,before).encode()
        made=appended=updated_md=updated_latest=False
        try:
            st=(base/'records'/(old['record_id']+'.json')).stat()
            rfd=os.open(str(recpath),os.O_CREAT|os.O_EXCL|os.O_WRONLY,stat.S_IMODE(st.st_mode))
            try:
                os.fchmod(rfd,stat.S_IMODE(st.st_mode))
                writeall(rfd,pretty);os.fsync(rfd)
            finally:os.close(rfd)
            made=True;fsyncdir(recpath.parent)
            if path.read_bytes()!=b_hist:
                raise RuntimeError('concurrent_history_edit_detected')
            writeall(fd,line);os.fsync(fd);appended=True
            updated_md=True;publish(base/'LATEST.md',md)
            updated_latest=True;publish(base/'LATEST.json',pretty)
            got,allrows,got_b,got_md,got_history=load_registry(base)
            if (len(allrows)!=len(entries)+1 or got!=rec or
                allrows[-1]!=rec or got_b!=pretty or
                not got_history.endswith(line) or
                hash_of(recpath)!=hash_of(base/'LATEST.json')):
                raise RuntimeError('registry_readback_failed')
            after=health_fn()
            if (after['genesis']!=before['genesis'] or
                after['installed_sha256']!=before['installed_sha256'] or
                after['monitor']['total_scans']<before['monitor']['total_scans']):
                raise RuntimeError('runtime_changed_during_checkpoint')
            print('REGISTRY_READBACK=PASS')
            print('HISTORY_ROWS='+str(len(allrows)))
            print('LATEST_RECORD_ID='+rid)
            print('LATEST_SHA256='+hash_of(base/'LATEST.json'))
            print('HISTORY_SHA256='+hash_of(path))
            print('MARKDOWN_SHA256='+hash_of(base/'LATEST.md'))
            print('GENESIS_ISOLATION=PASS')
            print('MILESTONE_CHECKPOINT=PASS')
            return rec
        except Exception:
            rollback=True
            try:
                if updated_latest:
                    if (base/'LATEST.json').read_bytes()==pretty:publish(base/'LATEST.json',b_latest)
                    else:rollback=False
                if updated_md:
                    if (base/'LATEST.md').read_bytes()==md:publish(base/'LATEST.md',b_md)
                    else:rollback=False
                if appended:
                    if path.read_bytes()==b_hist+line:
                        os.ftruncate(fd,len(b_hist));os.fsync(fd)
                    else:rollback=False
                if made and rollback:
                    recpath.unlink();fsyncdir(recpath.parent)
            except Exception:
                rollback=False
            print('ROLLBACK='+('PASS' if rollback else 'MANUAL_RECOVERY_REQUIRED'))
            print('RECOVERY_BACKUP='+str(backup))
            raise
    finally:
        os.close(fd)
def main():
    a=argparse.ArgumentParser()
    a.add_argument('--write',action='store_true')
    args=a.parse_args()
    if os.geteuid()!=0:raise RuntimeError('root_required')
    if not args.write:
        proof=health()
        print('DRY_RUN=PASS')
        print('SCANS='+str(proof['monitor']['total_scans']))
        print('UNIQUE_SIGNALS='+str(proof['monitor']['unique_signals']))
        return
    checkpoint(REG,BACKUPS,health)
if __name__=='__main__':
    try:main()
    except Exception as e:
        print('MILESTONE_CHECKPOINT=NOT_YET_VERIFIED',file=sys.stderr)
        print('BLOCKER='+str(e),file=sys.stderr)
        sys.exit(1)
