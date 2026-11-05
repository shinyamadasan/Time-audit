import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base = '021d1eecb963d75fabd09735095e54c1fa6ff4b7';
const original = file => execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).replaceAll('\r\n', '\n');
const current = file => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const hash = source => createHash('sha256').update(source).digest('hex');
const files = ['index.html', 'storage.js', 'time-ack.js', 'focus-mode.js', 'focus-wallet.js', 'firebase.rules.json',
  'scripts/firebase-rules-builder.mjs', 'browser-extension/firebase-config.js', 'accounting-hazards/browser-adapter.js',
  'accounting-hazards/command-journal.js', 'unknown-recovery-proof/recovery.js', 'functions/src/completion-domain.js'];
const preservedFiles = Object.fromEntries(files.map(file => {
  assert.equal(current(file), original(file), `${file} changed outside the held boundary`); return [file, hash(current(file))];
}));
const calculation = source => {
  const body = source.match(/async function logSession\([^]*?\n\}/)[0];
  return body.slice(body.indexOf('  const site'), body.indexOf('  entry.originalLabel = entry.energy;') + '  entry.originalLabel = entry.energy;'.length)
    .replace(/  lastSessionByDomain\[domain\] = [^\n]*\n/, '').replace(/  chrome.storage.local.set\(\{ lastSessionByDomain \}\);\n/, '');
};
assert.equal(calculation(current('browser-extension/background.js')), calculation(original('browser-extension/background.js')),
  'extension merge arithmetic, entry fields and original timestamps must remain verbatim');
const fixture = current('accounting-hazards/baseline-extension-log-session.js.txt').split('\n').slice(1).join('\n').trimEnd();
assert.equal(fixture, original('browser-extension/background.js').match(/async function logSession\([^]*?\n\}/)[0], 'historical counterexample source drifted');
const evidence = { base, preservedFiles, extensionCalculation: hash(calculation(current('browser-extension/background.js'))),
  scope: 'Local partial checkpoint; app adapter remains unwired. Historical preservation.mjs applies to the earlier proof only.' };
fs.writeFileSync('accounting-hazards/PHYSICAL_PRESERVATION.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(`PASS: ${files.length} frozen sources, extension calculation and pinned historical fixture`);
