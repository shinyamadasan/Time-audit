import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const workspace=path.resolve(here,'../../../..');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const protectedTrees={};
for(const name of['task-028','task-030-planning-prototype','task-031']){
  const root=path.join(workspace,'.worktrees',name);
  const files=git(root,'ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean);
  protectedTrees[name]={commit:git(root,'rev-parse','HEAD'),status:git(root,'status','--porcelain'),files:Object.fromEntries(files.map(file=>[file,hash(path.join(root,file))]))};
}
function walk(root){return fs.readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(root,entry.name)):[path.join(root,entry.name)]);}
const artifacts=path.join(workspace,'review-artifacts/daily-command-center-v1');
const current={trees:protectedTrees,originalReviewArtifacts:Object.fromEntries(walk(artifacts).map(file=>[path.relative(artifacts,file).replaceAll('\\','/'),hash(file)]))};
const baseline=path.join(here,'PROTECTED_BASELINES.json');
if(process.argv.includes('--record')){
  if(fs.existsSync(baseline))throw new Error('Refusing to replace protected baseline snapshot');
  fs.writeFileSync(baseline,JSON.stringify(current,null,2)+'\n');
}else if(JSON.stringify(current)!==JSON.stringify(JSON.parse(fs.readFileSync(baseline))))throw new Error('Protected original files or state changed; do not overwrite them');
console.log('PASS: original TASK-028, TASK-030, audit TASK-031 and review artifacts match protected snapshot');
