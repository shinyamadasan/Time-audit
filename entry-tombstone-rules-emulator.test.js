import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALICE, MALLORY, ROOM, startEmulator } from './rtdb-emulator-support.js';

const RULES = readFileSync(new URL('./firebase.rules.json', import.meta.url), 'utf8');
const at = id => `${ROOM}/entries/${id}`;
const entry = (id, updatedAt = 1000) => ({ id, tsStart: 100, ts: 200, activity: 'Work', updatedAt });
const tombstone = (value, updatedAt = 2000) => ({ ...value, deleted: true, updatedAt });
const undo = (value, updatedAt = 3000) => ({ ...value, deleted: undefined, updatedAt, undoRestoredAt: updatedAt });

let emulator;
test.before(async () => { emulator = await startEmulator(); });
test.after(() => emulator?.stop());
const fresh = () => emulator.fresh(RULES);

test('owner creates normal and numeric-key entries, edits active entry, and writes canonical tombstones', async () => {
  const db = await fresh();
  const normal = entry('one');
  const numeric = entry(12345);
  assert.equal(await db.write(at('e_one'), normal), true);
  assert.equal(await db.write(at('12345'), numeric), true);
  assert.equal(await db.write(at('e_one'), { ...normal, activity: 'Edited', updatedAt: 1500 }), true);
  assert.equal(await db.write(at('e_one'), tombstone(normal)), true);
  assert.equal(await db.write(at('e_one'), tombstone(normal, 2100)), true);
  assert.equal((await db.read(at('e_one'))).deleted, true);
  assert.equal(await db.write(at('e_other'), entry('other'), MALLORY), false);
});

test('existing tombstone rejects ordinary resurrection, partial deleted removal, stale metadata, and physical deletion', async () => {
  const db = await fresh();
  const active = entry('one');
  const dead = tombstone(active);
  await db.seed(at('e_one'), dead);
  assert.equal(await db.write(at('e_one'), active), false);
  assert.equal(await db.write(at('e_one/deleted'), null), false);
  assert.equal(await db.patch(at('e_one'), { deleted: null }), false);
  assert.equal(await db.write(at('e_one'), tombstone(active, 1900)), false);
  assert.equal(await db.write(at('e_one'), null), false);
  assert.deepEqual(await db.read(at('e_one')), dead);
});

test('canonical newer undo is the only tombstone-to-active path', async () => {
  const db = await fresh();
  const active = entry('one');
  await db.seed(at('e_one'), tombstone(active));
  for (const invalid of [
    { ...active, updatedAt: 3000 },
    { ...active, updatedAt: 3000, undoRestoredAt: 2999 },
    { ...active, updatedAt: 2000, undoRestoredAt: 2000 },
    { ...active, updatedAt: 3000, undoRestoredAt: '3000' },
    { ...active, id: 'other', updatedAt: 3000, undoRestoredAt: 3000 },
  ]) assert.equal(await db.write(at('e_one'), invalid), false);
  assert.equal(await db.write(at('e_one'), undo(active)), true);
  assert.equal((await db.read(at('e_one'))).deleted, undefined);
});

test('no ancestor grant permits collection replacement or legacy Clear Today / Clear All deletion', async () => {
  const db = await fresh();
  const active = entry('one');
  const dead = tombstone(entry('two'));
  await db.seed(at('e_one'), active);
  await db.seed(at('e_two'), dead);
  assert.equal(await db.write(at('e_one'), null), false);
  assert.equal(await db.write(at('e_two'), null), false);
  assert.equal(await db.patch(ROOM, { 'entries/e_one': null }), false);
  assert.equal(await db.patch(ROOM, { entries: null }), false);
  assert.equal(await db.write(`${ROOM}/entries`, null), false);
  assert.equal(await db.write(`${ROOM}/entries`, { e_one: active }), false);
  assert.equal(await db.write(ROOM, { entries: {} }), false);
  assert.deepEqual(await db.read(`${ROOM}/entries`), { e_one: active, e_two: dead });
});

test('stale full-object syncEntries replay is rejected and another owner cannot affect the tombstone', async () => {
  const db = await fresh();
  const deviceB = entry('one');
  const deviceA = tombstone(deviceB, 2000);
  await db.seed(at('e_one'), deviceB);
  assert.equal(await db.write(at('e_one'), deviceA), true);
  assert.equal(await db.patch(ROOM, { 'entries/e_one': deviceB }), false);
  assert.equal(await db.write(at('e_one'), deviceB, MALLORY), false);
  assert.deepEqual(await db.read(at('e_one')), deviceA);
});

test('valid multipath sync and Clear Today / Clear All tombstone batches are atomic', async () => {
  const db = await fresh();
  const first = entry('one');
  const second = entry('two');
  const third = entry('three');
  assert.equal(await db.patch(ROOM, { 'entries/e_one': first, 'entries/e_two': second, 'entries/e_three': third }), true);
  const firstDead = tombstone(first);
  assert.equal(await db.patch(ROOM, { 'entries/e_one': firstDead }), true, 'Clear Today');
  const secondDead = tombstone(second);
  const thirdDead = tombstone(third);
  assert.equal(await db.patch(ROOM, { 'entries/e_two': secondDead, 'entries/e_three': thirdDead }), true, 'Clear All remaining active');
  assert.deepEqual(await db.read(at('e_three')), thirdDead);
  assert.equal(await db.patch(ROOM, {
    'entries/e_one': first,
    'entries/e_four': entry('four'),
    intention: 'unrelated valid write',
  }), false, 'one stale entry rejects the whole batch');
  assert.equal(await db.read(at('e_four')), null);
  assert.equal(await db.read(`${ROOM}/intention`), null);
  assert.deepEqual(await db.read(at('e_one')), firstDead);
  assert.equal(await db.patch(ROOM, {
    'entries/e_one': firstDead,
    'entries/e_two': secondDead,
    'entries/e_three': thirdDead,
    'entries/e_four': entry('four'),
  }), true, 'current syncEntries with valid entries remains usable');
});
