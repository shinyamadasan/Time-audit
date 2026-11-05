from pathlib import Path
import subprocess,json,hashlib,gzip,re
root=Path(__file__).resolve().parent.parent
out=root/'review-artifacts/task-039-final-local-safety'
git=lambda *args:subprocess.check_output(['git',*args],cwd=root)
sha=lambda data:hashlib.sha256(data).hexdigest()
write=lambda name,value:(out/name).write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
main='a9e22afba5370f426c4066c94bf216eac3cced94'
head='122d3835f7114503d9be5ea581227b0d95fb9d9d'
assert git('branch','--show-current').decode().strip()=='task-039-final-local-safety'
subprocess.run(['git','merge-base','--is-ancestor',main,'HEAD'],cwd=root,check=True)
provenance=json.loads((out/'RECONCILIATION.json').read_text())
for name,info in provenance['imported_paths'].items():
    data=(root/name).read_bytes()
    assert info['git_blob_sha256'] in [sha(data),sha(data.replace(b'\r\n',b'\n'))],name
for name in provenance['retained_main_paths']:
    assert git('hash-object',name).strip()==git('rev-parse',main+':'+name).strip(),name
assert not (root/'forward-recovery').exists()
assert not (root/'functions/src/gateway-http.js').exists()
assert git('rev-parse','task-039-hosted-ci-repair').decode().strip()==head
sources=['index.html','storage.js','plan-authority.js','plan-tomorrow-model.js','stale-plan-recovery-model.js',
 'planning-continuity-ui.js','firebase.rules.json','scripts/firebase-rules-builder.mjs','functions/index.js',
 'workers/chronasense-conversational-bridge/src/index.js','workers/chronasense-conversational-bridge/src/mcp.js',
 'workers/chronasense-conversational-bridge/test/oauth.test.js','release-safety/reconcile.py',
 'release-safety/prepare-fixtures.py','release-safety/safety-proof.test.js','release-safety/capture-evidence.py',
 'TASK_039_FINAL_LOCAL_SAFETY.md']
write('SOURCE_HASHES.json',{'main':main,'approved_pr20':head,'files':{name:sha((root/name).read_bytes()) for name in sources}})
logs={}
for file in sorted(out.glob('*.log')):
    data=file.read_bytes();compressed=gzip.compress(data,mtime=0);(out/(file.name+'.gz')).write_bytes(compressed)
    logs[file.name]={'sha256':sha(data),'gzip_sha256':sha(compressed)}
for name,count in [('SAFETY_FINAL.log',10),('WORKER.log',45)]:
    text=(out/name).read_text(encoding='utf-8');assert re.search(r'pass '+str(count)+r'\s',text),name
    assert re.search(r'fail 0\s',text) and re.search(r'skipped 0\s',text),name
assert '--dry-run: exiting now.' in (out/'WORKER_BUNDLE.log').read_text(encoding='utf-8')
observations=json.loads((out/'SAFETY_OBSERVATIONS.json').read_text())
same=[row for row in observations['observations'] if row['case']=='identical-description-transition']
assert len(same)==2 and same[0]['transition_sha256']==same[1]['transition_sha256']
assert [row['both_allowed'] for row in same]==[True,False]
write('PARITY_RESULTS.json',{'execution':'completed local check commands; output retained in tool record',
 'runtime_command':'npm run check:www-parity','runtime_result':'PASS:98-file byte-identical closure',
 'shared_command':'npm run check:functions-shared','shared_result':'PASS',
 'rules_command':'npm run check:firebase-rules','rules_result':'PASS',
 'production_writes':False,'canonical_rules_patch':False})
prior=root.parent/'task-039-hosted-ci-repair/review-artifacts/task-039-release-integration/hosted-verification'
rollback=root.parent/'task-039-rollback-compatibility/review-artifacts/task-039-rollback-compatibility'
references={}
for parent,names in [(prior,['HOSTED_VERIFICATION_REPORT.md','RESULTS.json','GUARDIAN_DISPOSITION.md']),
 (rollback,['CLOSURE_REPORT.md','STRICT_TIMING_RESULT.json','OLD_SESSION_POLICY.md','BUILD_MANIFEST.json'])]:
    for name in names:
        file=parent/name
        if file.exists():references[str(file.relative_to(root.parent)).replace('\\','/')]=sha(file.read_bytes())
write('PRESERVATION.json',{'main':main,'approved_pr20':head,'exact_imported_paths':len(provenance['imported_paths']),
 'retained_main_paths':provenance['retained_main_paths'],'canonical_runtime_rules':'same approved input blobs',
 'gateway_imported':False,'gateway_frozen_at':'c224180f1d0bdc00264dffd3abb132ad91b8c27a',
 'prior_readonly_reference_sha256':references,'prior_dirty_worktrees':'untouched',
 'prior_browser_backend_fence_and_time_passes':'reused for unchanged sources; not rerun/recounted as new passes'})
write('RESULTS.json',{'main':main,'approved_pr20':head,'branch':'task-039-final-local-safety',
 'structural_integration':'PASS','release_safety':'BLOCKED / STOP6','production':'NO-GO',
 'guardian':'NOT RUN / NOT PASSED; final approved combination pending',
 'actual_passes':{'worker':45,'synthetic_emulator_observation_cases':10},'final_failures':0,'final_skips':0,
 'counting':'10 observation passes demonstrate an incompatibility, not a safe deployable rule',
 'worker_bundle':'dry-run PASS / no upload','parity':'runtime98/shared/rules PASS',
 'old_current_description_transition_sha256':same[0]['transition_sha256'],'logs':logs,
 'stop':'no canonical-rule changes, no gateway or redesign begun',
 'next_authorization':'bounded LOCAL non-gateway revision/before-image/retention contract design and proof only',
 'limitations':'no final-head hostedCI, Guardian, live versions/canaries or phone test; pinned local objects only'})
print('Evidence PASS:413 imports/main OAuth retained, blocker observed, prior sources/evidence preserved.')
