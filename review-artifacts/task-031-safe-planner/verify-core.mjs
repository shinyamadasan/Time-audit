import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
const base='17608cdd19900290843d0a86d29bddb5139d5c44';
const before=file=>execFileSync('git',['show',`${base}:${file}`],{cwd:root,maxBuffer:8*1024*1024});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const normalized=value=>value.toString('utf8').replaceAll('\r\n','\n');
const files=['daily-command-center.js','daily-command-center.css','storage.js','focus-mode.js','insights.js',
  'brain-dump-repository.js','brain-dump-promotion.js','plan-authority.js','plan-tomorrow-model.js',
  'personal-day-boundary-model.js','personal-day-boundary-repository.js','personal-day-boundary-sync.js','personal-day-boundary-live.js',
  'calendar-plan-model.js','calendar-plan-repository.js','calendar-plan-sync.js','calendar-plan-live.js',
  'daily-routines-model.js','daily-routines-repository.js'];
const results={base,unchanged:Object.fromEntries(files.map(file=>[file,sha(normalized(before(file)))===sha(normalized(fs.readFileSync(path.join(root,file))))]))};
const index=normalized(fs.readFileSync(path.join(root,'index.html')))
  .replaceAll('20261026-task031-safe-planner-v1','20261025-task028-command-center-v1')
  .replaceAll('20261026-task031-source-guard-v1','20261021-task016-promotion-reliability-v1');
results.indexOnlyRuntimeGenerationChanged=index===normalized(before('index.html'));
if(Object.values(results.unchanged).some(value=>!value)||!results.indexOnlyRuntimeGenerationChanged)throw Error('Unexpected protected application change');
fs.writeFileSync(path.join(here,'INVARIANTS.json'),JSON.stringify(results,null,2)+'\n');
console.log(`PASS: ${files.length} protected domain/presentation files unchanged; index differs only by runtime generations`);
