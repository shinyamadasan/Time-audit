import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {token} from '../rtdb-emulator-support.js';
import {copy} from '../stale-contract/contract.js';
import {accountingRules, initialize, createLifecycle} from './lifecycle.js';
export const start = 1793203200000, saved = start + 600000, now = saved + 120000;
export const counter = revision => ({v: 1, baseExists: revision !== 1, baseRevision: revision - 1, revision});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chronasense-time-ack-'));
let sequence = 0;
// Isolated, durable fixture adapter. Production browser persistence is deliberately not integrated.
export class DiskEnvelope {
  constructor() {this.file = path.join(temp, `envelope-${++sequence}.json`); this.failBefore = false; this.failAfter = false;}
  read() {return fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : null;}
  write(raw) {
    if (this.failBefore) {this.failBefore = false; throw new Error('quota/storage failure fixture');}
    const temporary = this.file + '.tmp', handle = fs.openSync(temporary, 'w');
    try {fs.writeFileSync(handle, raw); fs.fsyncSync(handle);} finally {fs.closeSync(handle);}
    fs.renameSync(temporary, this.file);
    if (this.failAfter) {this.failAfter = false; throw new Error('interruption after durable local commit');}
  }
}
export function cleanup() {
  if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('chronasense-time-ack-')) throw new Error('Unexpected fixture directory');
  for (const name of fs.readdirSync(temp)) {if (!/^envelope-\d+\.json(?:\.tmp)?$/.test(name)) throw new Error('Unexpected fixture file'); fs.unlinkSync(path.join(temp, name));}
  fs.rmdirSync(temp);
}
export function frameFor(uid) {
  const owner = `uid_${uid}`;
  return {owner, device: 'device-a', session: 'ordinary-session-a', generation: 0,
    timer: {running: true, ownerRoom: owner, ownerDeviceId: 'device-a', taskStartTime: saved,
      blockStartTime: saved, trackingStartedAt: start, startedAt: saved, lastTask: 'Work', updatedAt: saved},
    entries: [{id: 1213, tsStart: start, ts: saved, blockIntervalMin: 10, date: '2026-10-28',
      activity: 'Work', energy: 'deep', updatedAt: saved, _csWrite: counter(1),
      note: 'Original full note', metadata: {source: 'historical fixture', text: '資料 😀', tags: ['keep']}},
    {id: 1200, tsStart: start - 7200000, ts: start - 3600000, blockIntervalMin: 60,
      date: '2026-10-28', activity: 'Historical time', energy: 'deep', updatedAt: start - 3600000, custom: {original: true}},
    {id: 1201, tsStart: start - 3600000, ts: start - 1800000, deleted: true, updatedAt: start - 1800000}],
    focusRedemptions: [], undo: {type: 'created', label: 'save', entryIds: [1213], timerCursor: {
      ownerRoom: owner, deviceId: 'device-a', savedThrough: saved, taskStart: start, blockStart: start,
      task: 'Work', trackingStart: start}}};
}
const room = owner => `rooms/${owner}`;
export function transportFor(emulator, world) {
  const result = {writes: 0, reads: 0, beforeWrite: null, afterWrite: null, offline: false, loseReply: false, writeUid: null};
  result.read = async (owner, paths) => {
    result.reads++;
    if (result.offline) throw new Error('offline before authoritative read');
    const response = await fetch(`${emulator.base}/${room(owner)}.json?ns=${world.name}&auth=${token(owner.slice(4))}`);
    if (response.status !== 200) throw new Error(`authoritative read refused ${response.status}`);
    const body = await response.json();
    return Object.fromEntries(paths.map(key => [key, key.split('/').reduce((value, part) => value?.[part], body) ?? null]));
  };
  result.patch = async (owner, patch) => {
    result.writes++;
    if (result.offline) throw new Error('offline before write');
    if (result.beforeWrite) await result.beforeWrite(patch);
    const response = await fetch(`${emulator.base}/${room(owner)}.json?ns=${world.name}&auth=${token(result.writeUid || owner.slice(4))}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    });
    const answer = {status: response.status, body: await response.json()};
    if (result.afterWrite) await result.afterWrite(answer, patch);
    if (result.loseReply) throw new Error('response lost after server processed write');
    return answer;
  };
  return result;
}
export async function setup(emulator, uid = 'alice', frame = frameFor(uid), rules = accountingRules()) {
  const world = await emulator.fresh(rules), store = new DiskEnvelope();
  await world.seed(room(frame.owner), {timer: frame.timer, entries: Object.fromEntries(frame.entries.map(entry => [`e_${entry.id}`, entry]))});
  initialize(store, frame);
  const active = {owner: frame.owner, device: frame.device, session: frame.session};
  const transport = transportFor(emulator, world);
  const open = () => createLifecycle({store, owner: frame.owner, active: () => active, transport});
  return {world, store, frame: copy(frame), active, transport, open, lifecycle: open(), path: room(frame.owner)};
}
