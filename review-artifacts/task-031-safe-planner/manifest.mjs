import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files=['brain-dump-model.js','brain-dump-sync.js','brain-dump-ui.js','plan-tomorrow-ui.js','plan-tomorrow.css',
  'index.html','scripts/firebase-rules-builder.mjs','firebase.rules.json','functions/shared/brain-dump-model.js',
  'brain-dump-model.test.js','brain-dump-sync.test.js','brain-dump-promotion.test.js','firebase-rules.test.js',
  'firebase-rules-emulator.test.js','firebase-rules-mutation.test.js','tests/daily-command-center.spec.js',
  'tests/daily-reconciliation.spec.js','tests/plan-time-range.spec.js','tests/plan-tomorrow-ui.spec.js',
  'tests/planning-continuity.spec.js','tests/planning-continuity-fixes.spec.js'];
const images=fs.readdirSync(path.join(here,'screenshots')).filter(file=>file.endsWith('.png'));
const source=Object.fromEntries(files.map(file=>[file,sha(path.join(root,file))]));
const screenshot=Object.fromEntries(images.map(file=>[file,sha(path.join(here,'screenshots',file))]));
const manifest={baseline:'17608cdd19900290843d0a86d29bddb5139d5c44',designReference:'07411dd',branch:'task-031-safe-planner',
  data:'Actual local application render; synthetic fixed-clock Asia/Manila 18:00 Personal Day; Firebase browser stub, never production',
  source,screenshot,contactSheet:sha(path.join(here,'integrated-review.png'))};
fs.writeFileSync(path.join(here,'SOURCE_MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Bound ${files.length} source/test files and ${images.length} application screenshots with SHA-256`);
