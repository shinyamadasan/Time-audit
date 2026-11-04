import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base = '9b0671ba8deca394170aeff84f12825341ff7b71';
const original = file => execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).replaceAll('\r\n', '\n');
const current = file => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const hash = source => createHash('sha256').update(source).digest('hex');
const actual = (source, name) => {
  const body = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(body, name); return body;
};
const files = ['storage.js', 'focus-mode.js', 'firebase.rules.json', 'scripts/firebase-rules-builder.mjs', 'browser-extension/background.js'];
const preservedFiles = Object.fromEntries(files.map(file => {
  assert.equal(current(file), original(file), `${file} must remain frozen`);
  return [file, hash(current(file))];
}));
const before = original('index.html'), after = current('index.html');
const functions = ['_doQuickSave', 'stopAndLog', 'switchTaskMidBlock', 'autoLogBlock', 'handleRecovery',
  'endBreak', 'startBreak', 'doPing', 'resetTimer', 'undoCursorTarget', 'tombstoneUndoEntries',
  'restoreUndoEntries', 'clipOverlapsForDisplay', 'mergeConsecutiveForDisplay', 'computeGaps',
  'restoreHeartbeatRecoveryForAccount', '_stopHeartbeat'];
const preservedFunctions = Object.fromEntries(functions.map(name => {
  assert.equal(actual(after, name), actual(before, name), `${name} calculations and guards changed`);
  return [name, hash(actual(after, name))];
}));
const calculation = source => actual(source, 'autoLogDueTemplates').split("  if (!settings.templates")[1].split('  if (!created.length)')[0];
assert.equal(calculation(after), calculation(before), 'scheduled occurrence calculation must remain verbatim');
const publication = actual(before, 'autoLogDueTemplates').split('  entries.unshift(...created);')[1];
assert.equal(actual(after, 'applyAutoTemplateEntries').split('  entries.unshift(...created);')[1], publication, 'scheduled publication tail must remain verbatim');
assert.equal(current('unknown-recovery-proof/baseline-time-ack.js'), original('time-ack.js'), 'preserved baseline lifecycle must be exact');
fs.writeFileSync('accounting-hazards/PRESERVATION.json', JSON.stringify({ base, preservedFiles, preservedFunctions,
  scheduledCalculation: 'verbatim', scheduledPublication: 'verbatim extracted helper', originalProofLifecycle: 'exact baseline' }, null, 2) + '\n');
console.log('PASS: frozen files, 17 original functions, scheduled calculation/publication and original proof lifecycle');
