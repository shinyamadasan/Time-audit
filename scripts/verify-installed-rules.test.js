// Emulator proof of the cutover rules verifier and of every client/rules combination the staged cutover passes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { startEmulator, token } from '../rtdb-emulator-support.js';
import { behaviour, canonicalHash, precheck, readInstalledRules, stageRules, verify } from './verify-installed-rules.mjs';

const PAIRED = readFileSync(new URL('../firebase.rules.json', import.meta.url), 'utf8');
// What production serves today: the rules at f73edd4, main's tip before this release. Pinned so the test
// still means "today's live rules" after this candidate itself lands on main.
const LIVE = execFileSync('git', ['show', 'f73edd4:firebase.rules.json']).toString();
const PROBE = 'rules-verifier-probe', PROBE_TOKEN = token(PROBE);
let emulator;
test.before(async () => { emulator = await startEmulator(); });
test.after(() => emulator?.stop());

const install = async (ns, rules) => {
  const response = await fetch(`${emulator.base}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' },
    body: typeof rules === 'string' ? rules : JSON.stringify(rules) });
  assert.equal(response.status, 200);
};
const world = async rules => { const { name } = await emulator.fresh(rules); return { ns: name, databaseURL: `${emulator.base}?ns=${name}` }; };
const args = ({ databaseURL }) => ({ databaseURL, adminBearer: 'owner', probeUid: PROBE, probeToken: PROBE_TOKEN, pairedText: PAIRED });

test('precheck accepts only the pinned paired file', () => {
  assert.equal(precheck(PAIRED).ok, true);
  assert.equal(precheck(PAIRED.replace('"rules"', '"rules" ')).ok, false);
});

test('read-back returns exactly the installed rules', async () => {
  const w = await world(PAIRED);
  assert.equal(canonicalHash(await readInstalledRules({ databaseURL: w.databaseURL, adminBearer: 'owner' })), canonicalHash(PAIRED));
  // The emulator accepts any bearer here, so a refused admin credential can only be shown against production.
});

test('Stage A and Stage B each verify only when exactly installed', async () => {
  const w = await world(stageRules('A', PAIRED));
  const a = await verify({ stage: 'A', ...args(w) });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal((await verify({ stage: 'B', ...args(w) })).ok, false);
  await install(w.ns, PAIRED);
  const b = await verify({ stage: 'B', ...args(w) });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal((await verify({ stage: 'A', ...args(w) })).ok, false);
});

test('a weaker ruleset that passes the behavioural proof is caught only by the read-back', async () => {
  const weak = JSON.parse(PAIRED); weak.rules.rooms.$roomId.devices = { '.write': 'auth != null' };
  const w = await world(weak);
  const result = await verify({ stage: 'B', ...args(w) });
  assert.equal(result.behaviour.capability, 'proven');
  assert.equal(result.exactMatch, false);
  assert.equal(result.ok, false);
});

test('today\'s production rules fail verification for both stages', async () => {
  const w = await world(LIVE);
  for (const stage of ['A', 'B']) assert.equal((await verify({ stage, ...args(w) })).ok, false);
});

// Sampled smoke check of each step (fresh clients; the exact read-back is the real guarantee): the new
// client proves only under Stage B, and sampled unfenced legacy writes are refused once Stage A is installed.
test('staged cutover exposes no unsafe client/rules combination', async () => {
  const observed = {};
  for (const [name, rules] of [['live', LIVE], ['A', stageRules('A', PAIRED)], ['B', PAIRED]]) {
    const w = await world(rules);
    observed[name] = await behaviour({ databaseURL: w.databaseURL, probeUid: PROBE, probeToken: PROBE_TOKEN });
  }
  console.log(JSON.stringify(Object.fromEntries(Object.entries(observed).map(([k, v]) => [k, { capability: v.capability, legacyDenied: v.legacyDenied,
    otherAccountDenied: v.otherAccountDenied, statuses: v.statuses }]))));
  assert.notEqual(observed.live.capability, 'proven');   // before cutover: upgraded clients send nothing
  assert.equal(observed.live.legacyDenied, false);         // ...and old clients keep working as today
  assert.equal(observed.A.capability, 'incompatible');     // Stage A: new clients still quiesced
  assert.equal(observed.A.legacyDenied, true);             // ...and old writers already refused
  assert.equal(observed.B.capability, 'proven');           // Stage B: only new clients send
  assert.equal(observed.B.legacyDenied, true);
  for (const v of Object.values(observed)) assert.equal(v.otherAccountDenied, true);
});

// B back to A is not an instant freeze: a client that already proved under B keeps sending fenced writes for
// up to one proof lifetime (5 min), which is what the contract states. Any later proof is refused.
test('B back to A refuses every new proof; existing proofs end within one proof lifetime', async () => {
  const w = await world(PAIRED);
  assert.equal((await behaviour({ databaseURL: w.databaseURL, probeUid: PROBE, probeToken: PROBE_TOKEN })).capability, 'proven');
  await install(w.ns, stageRules('A', PAIRED));
  assert.equal((await behaviour({ databaseURL: w.databaseURL, probeUid: PROBE, probeToken: PROBE_TOKEN })).capability, 'incompatible');
});

test('the legacy entry probe is refused only by the accounting gate, not by its shape', async () => {
  const w = await world(LIVE);
  assert.equal((await behaviour({ databaseURL: w.databaseURL, probeUid: PROBE, probeToken: PROBE_TOKEN })).statuses.legacyEntry, 200);
});

test('non-JSON installed rules fail closed with a structured result', async () => {
  const fake = async () => ({ status: 200, text: async () => '{ /* comment */ "rules": {} }' });
  const result = await verify({ stage: 'B', databaseURL: 'http://127.0.0.1:1', adminBearer: 'x', probeUid: PROBE, probeToken: 'x', pairedText: PAIRED, fetchImpl: fake });
  assert.equal(result.ok, false); assert.match(result.error, /not plain JSON/);
});
