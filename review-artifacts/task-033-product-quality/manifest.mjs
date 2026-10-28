import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources=['index.html','daily-command-center.css','daily-command-center.js','plan-tomorrow.css','plan-tomorrow-ui.js','scripts/runtime-mirror.mjs','tests/daily-command-center.spec.js','assets/fonts/InterVariable.woff2','assets/fonts/OFL.txt'];
const screenshots={};
for(const phase of ['before','after'])for(const file of fs.readdirSync(path.join(here,phase)).filter(file=>file.endsWith('.png')))screenshots[`${phase}/${file}`]=sha(path.join(here,phase,file));
const data={baseline:'d7e01d0054eed45f59dbf350c273342be125a6b6',branch:'task-033-product-quality',sourceHashes:Object.fromEntries(sources.map(file=>[file,sha(path.join(root,file))])),screenshots,
  method:'Actual locally served application; fixed synthetic clock/data, Asia/Manila 18:00 Personal Day, Firebase stub, Chromium. Before serves protected d7e01d0; after serves final isolated visual candidate. No generated mockups.',
  limits:'Desktop/laptop/phone/tablet/keyboard-height and 200%-equivalent CSS viewport simulation. Physical mobile keyboards, native 200% browser zoom and real-device feel require owner checks.'};
fs.writeFileSync(path.join(here,'SOURCE_MANIFEST.json'),JSON.stringify(data,null,2)+'\n');
console.log(`Recorded ${sources.length} source and ${Object.keys(screenshots).length} screenshot hashes`);
