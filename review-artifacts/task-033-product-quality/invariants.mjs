import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..'),workspace=path.resolve(root,'../..');
const base='d7e01d0054eed45f59dbf350c273342be125a6b6';
const git=(cwd,args)=>execFileSync('git',args,{cwd,maxBuffer:8*1024*1024}).toString('utf8').trim();
const before=file=>execFileSync('git',['show',`${base}:${file}`],{cwd:root,maxBuffer:8*1024*1024}).toString('utf8').replaceAll('\r\n','\n');
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const files=['storage.js','focus-mode.js','insights.js','brain-dump-model.js','brain-dump-repository.js','brain-dump-promotion.js','brain-dump-sync.js','brain-dump-ui.js',
  'scripts/firebase-rules-builder.mjs','firebase.rules.json','functions/shared/brain-dump-model.js','plan-authority.js','plan-item-origin.js','plan-fence-sync.js','plan-tomorrow-model.js',
  'personal-day-boundary-model.js','personal-day-boundary-repository.js','personal-day-boundary-sync.js','personal-day-boundary-live.js',
  'calendar-plan-model.js','calendar-plan-repository.js','calendar-plan-sync.js','calendar-plan-live.js','daily-routines-model.js','daily-routines-repository.js'];
const unchanged=Object.fromEntries(files.map(file=>[file,sha(before(file))===sha(fs.readFileSync(path.join(root,file),'utf8').replaceAll('\r\n','\n'))]));
let index=fs.readFileSync(path.join(root,'index.html'),'utf8').replaceAll('\r\n','\n');
index=index.replaceAll('20261026-task033-product-quality-v1','20261026-task031-safe-planner-v1')
  .replace('onclick="toggleHdrMenu()" aria-label="My Day options"','onclick="toggleHdrMenu()"')
  .replace('>Choose task</button>','>Choose something else</button>')
  .replace('      <div class="pt-title"','      <div class="pt-kicker">Preparation, not execution</div>\n      <div class="pt-title"')
  .replace('data-pt-mode="rescue">Quick plan','data-pt-mode="rescue">Rescue / minimum')
  .replace('data-pt-action="confirm">Save plan','data-pt-action="confirm">Tomorrow is ready')
  .replace("${active ? 'Now' : 'Up next'}","${active ? 'Current' : 'Up next'}")
  .replace(' · Planned time only</div>',' · no time logged by this check</div>');
const indexOnlyPresentationAndGeneration=index===before('index.html');
if(Object.values(unchanged).some(v=>!v)||!indexOnlyPresentationAndGeneration)throw Error('Unexpected domain or index behavior change');
execFileSync(process.execPath,[path.join(workspace,'.worktrees/task-031-safe-planner/review-artifacts/task-031-safe-planner/preservation.mjs')],{cwd:root});
const protectedRoot=path.join(workspace,'.worktrees/task-031-safe-planner');
const protectedCandidate={commit:git(protectedRoot,['rev-parse','HEAD']),status:git(protectedRoot,['status','--porcelain'])};
if(protectedCandidate.commit!==base || protectedCandidate.status)throw Error('Protected TASK-031 candidate changed');
fs.writeFileSync(path.join(here,'INVARIANTS.json'),JSON.stringify({base,unchanged,indexOnlyPresentationAndGeneration,protectedCandidate,original028030031AndReviewArtifacts:'match previously recorded protected snapshot'},null,2)+'\n');
console.log(`PASS: ${files.length} domain/rules files unchanged; index presentation only; original worktrees and evidence preserved`);
