// Preserve the original eight-case script/results. Redirect only its result-file write.
import fs from 'node:fs';
const out = new URL('../review-artifacts/task-039-time-ack/', import.meta.url);
fs.mkdirSync(out, {recursive: true});
const original = fs.writeFileSync;
fs.writeFileSync = (target, ...args) => {
  if (!String(target).endsWith('/UNDO_BOUNDARY_RESULTS.json')) throw new Error('Unexpected baseline proof output');
  return original(new URL('BASELINE_EIGHT_RESULTS.json', out), ...args);
};
try {await import('../review-artifacts/task-039-time-ack/baseline-exact/undo-boundary-proof.mjs');}
finally {fs.writeFileSync = original;}
