// Extract unchanged source functions; execute only in a detached synthetic frame, never app state.
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {copy} from '../stale-contract/contract.js';
const root = new URL('../', import.meta.url);
const index = fs.readFileSync(new URL('index.html', root), 'utf8');
const storage = fs.readFileSync(new URL('storage.js', root), 'utf8');
const extract = (source, name) => {
  const value = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  if (!value) throw new Error(`Actual source function missing: ${name}`);
  return value;
};
export const functions = Object.fromEntries(['cloneUndoValue', 'sameUndoId', 'rememberUndoAction',
  'rememberCreatedUndo', 'rememberRestoreEntriesUndo', 'tombstoneUndoEntries', 'restoreUndoEntries',
  'tombstoneUndoRedemptions', 'undoLastAction', '_doQuickSave'].map(name => [name, extract(index, name)]));
functions.syncTimerState = extract(storage, 'syncTimerState');
export const hashes = Object.fromEntries(Object.entries(functions).map(([name, source]) =>
  [name, createHash('sha256').update(source).digest('hex')]));

export function project(frame, kind, now, {activity = 'New task', energy = 'deep'} = {}) {
  const source = copy(frame), original = copy(frame), trace = [], publications = [];
  class Clock extends Date {static now() {return now;}}
  const noop = () => {};
  const context = {
    Date: Clock, console, structuredClone, navigator: {userAgent: 'Synthetic Desktop'},
    entries: source.entries, focusRedemptions: source.focusRedemptions ?? [], lastUndoAction: source.undo,
    running: source.timer.running, currentTask: source.timer.lastTask,
    taskStartTime: source.timer.taskStartTime, blockStartTime: source.timer.blockStartTime,
    trackingStartedAt: source.timer.trackingStartedAt, timerStartedAt: source.timer.startedAt,
    _timerStateOwner: source.owner, _localStateOwner: source.owner, roomCode: source.owner,
    timerOwnerDeviceId: source.timer.ownerDeviceId, syncedDeviceId: source.device,
    totalSecs: 1800, remaining: 1680, _restoredTimerSync: null, _todayRenderKey: null,
    lastTaskForRepeat: source.timer.lastTask, quickLogBusy: false,
    snoozeTimer: null, followupNotifTimer: null, LocalNotifications: null,
    clearTimeout: noop, stopAlertLoop: noop, learnWastePattern: noop, validateEntry: noop,
    canonicalizeActivityInput: value => value, getBucket: entry => entry.energy,
    // Date/category presentation are fixed fixture dependencies, not a reimplementation of time math.
    toDateKey: () => '2026-10-28', fmtDur: value => String(value),
    invalidateTimerRecovery: noop, showUndoToast: noop, showLogFeedback: noop, checkReviewPrompt: noop, checkBudget: noop,
    document: {getElementById: () => ({classList: {remove: noop}})},
    timerStateOwnedByCurrentAccount: () => source.owner === source.timer.ownerRoom,
    timerStateOwnerRoom: () => source.owner,
    ownedRoomRef: () => ({update(value) {publications.push(copy(value.timer)); trace.push('proposed-timer'); return Promise.resolve();}}),
    rememberTimerSyncStamp: noop, updateTimerSyncDetail: noop,
    persist: () => trace.push('proposed-persist'), syncEntries: () => trace.push('proposed-entries'),
    syncFocusRedemptions: () => trace.push('proposed-redemptions'),
    scheduleRenderToday: noop, renderWeek: noop, renderWeekTable: noop, showToast: noop,
  };
  const seam = storage.match(/^const SEAM_TOLERANCE_MS\s*=[^\r\n]+$/m)?.[0];
  if (!seam) throw new Error('Actual seam tolerance required');
  vm.createContext(context);
  vm.runInContext(seam + '\n' + Object.values(functions).join('\n'), context);
  if (kind === 'undo') vm.runInContext('undoLastAction()', context);
  else if (kind === 'save') {context.input = {activity, energy}; vm.runInContext('_doQuickSave(input.activity, input.energy)', context);}
  else throw new Error('Unsupported engine operation');
  return {original, frame: {...source, entries: copy(context.entries), undo: copy(context.lastUndoAction), focusRedemptions: copy(context.focusRedemptions)},
    timer: publications.at(-1) ?? copy(source.timer), trace};
}
