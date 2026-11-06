#!/usr/bin/env python3
"""Isolated filesystem tests for checkpoint publication and safe abort."""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

SOURCE=Path(__file__).resolve().parents[1]/'ops/smart-money-monitor-v1/write_checkpoint.py'
spec=importlib.util.spec_from_file_location('smartmoney_checkpoint',SOURCE)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

PREV=m.PREVIOUS

def proof():
    return {
      'genesis':{'pid':2217257,'state':'active/running','restarts':0,'mode':'paper',
                 'maintenance_mode':True,'live_trading_enabled':False,
                 'testnet_auto':'0','shadow_evidence':'0','execution_config_sha256':'a'*64},
      'monitor':{'timer':'enabled/active','service_result':'success',
                 'last_exit_code':0,'database_integrity':'ok','total_scans':9,
                 'unique_signals':63,'latest_scan_utc':'2026-11-06T19:37:29Z',
                 'source_status':'ok','monitored_wallets':8,'returned_signals':60},
      'installed_sha256':{'collector':'b'*64},
    }
class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        root=Path(self.tmp.name)
        self.reg=root/'milestones'
        self.records=self.reg/'records'
        self.backup=root/'backups'
        self.records.mkdir(parents=True)
        prior={'schema_version':'empire_milestone_record_v1','record_id':PREV,
               'checkpoint_status':'PASS','status':'VERIFIED',
               'exact_current_milestone':'GENESIS_OBSERVABILITY_INSTALLED'}
        self.old=prior
        self.latest=(json.dumps(prior,sort_keys=True,indent=2)+'\n').encode()
        self.line=(json.dumps(prior,sort_keys=True,separators=(',',':'))+'\n').encode()
        files={
          self.reg/'LATEST.json':self.latest,
          self.reg/'LATEST.md':('# '+PREV+'\n').encode(),
          self.reg/'milestone_history.jsonl':self.line*250,
          self.records/(PREV+'.json'):self.latest,
        }
        for path,body in files.items():
            path.write_bytes(body)
            os.chmod(path,0o650)
        self.saved_reg=m.REG
        m.REG=self.reg
    def tearDown(self):
        m.REG=self.saved_reg
        self.tmp.cleanup()
    def test_write_readback_and_idempotence(self):
        created=m.checkpoint(self.reg,self.backup,proof)
        self.assertTrue(created['record_id'].endswith(m.SUFFIX))
        self.assertEqual(len((self.reg/'milestone_history.jsonl').read_text().splitlines()),251)
        latest,rows,b,md,h=m.load_registry(self.reg)
        self.assertEqual(latest,created)
        self.assertEqual(rows[-1],created)
        self.assertEqual(m.hash_of(self.reg/'LATEST.json'),m.hash_of(self.records/(created['record_id']+'.json')))
        self.assertTrue(md.find(created['record_id'].encode())>=0)
        backups=list(self.backup.iterdir())
        self.assertEqual(len(backups),1)
        manifest=json.loads((backups[0]/'SHA256_MANIFEST.json').read_text())
        for f,sha in manifest.items():
            self.assertEqual(m.hash_of(backups[0]/f),sha)
        m.checkpoint(self.reg,self.backup,proof)
        self.assertEqual(len((self.reg/'milestone_history.jsonl').read_text().splitlines()),251)
    def test_reject_changed_predecessor_without_write(self):
        latest=json.loads(self.latest)
        latest['record_id']='another_predecessor'
        new=(json.dumps(latest,sort_keys=True,indent=2)+'\n').encode()
        (self.reg/'LATEST.json').write_bytes(new)
        (self.records/(latest['record_id']+'.json')).write_bytes(new)
        (self.reg/'LATEST.md').write_text('# another_predecessor\n')
        (self.reg/'milestone_history.jsonl').write_bytes(
            (self.line*249)+(json.dumps(latest,sort_keys=True,separators=(',',':'))+'\n').encode())
        with self.assertRaisesRegex(RuntimeError,'unexpected_predecessor'):
            m.checkpoint(self.reg,self.backup,proof)
        self.assertEqual(len((self.reg/'milestone_history.jsonl').read_text().splitlines()),250)
        self.assertFalse(self.backup.exists())
    def test_refuse_corrupt_registry_without_write(self):
        (self.reg/'LATEST.md').write_text('incorrect record\n')
        with self.assertRaisesRegex(RuntimeError,'markdown_latest_mismatch'):
            m.checkpoint(self.reg,self.backup,proof)
        self.assertEqual(len((self.reg/'milestone_history.jsonl').read_text().splitlines()),250)
        self.assertFalse(self.backup.exists())
    def test_refuse_unhealthy_monitor_before_write(self):
        def bad():raise RuntimeError('monitor unhealthy')
        with self.assertRaisesRegex(RuntimeError,'monitor unhealthy'):
            m.checkpoint(self.reg,self.backup,bad)
        self.assertFalse(self.backup.exists())
    def test_record_schema_compatible(self):
        m.REG=self.reg
        b=self.backup/'example'
        rec=m.make_record(self.old,250,proof(),b,self.reg)
        expected=['schema_version','record_id','created_at_utc','checkpoint_status',
                  'status','objective','decisions_made','evidence','exact_current_milestone',
                  'exact_next_milestone','exact_next_action','risks_unresolved_issues_and_pending_evidence',
                  'predecessor_record_id','predecessor_milestone','predecessor_history_entries',
                  'production_decision','recovery_journals_recovered_before_write',
                  'scope','test_and_verification_results']
        self.assertTrue(set(expected).issubset(rec.keys()))
if __name__=='__main__':
    unittest.main()
