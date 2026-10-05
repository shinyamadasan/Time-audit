// brain-dump-fence-harness.js
//
// Test-only (never loaded by index.html). A "fenced world" for the Brain Dump
// promotion-fence suites: ONE rules-enforcing, wire-faithful database (Brain Dump
// AND calendar plans, the REAL firebase.rules.json) shared by any number of
// devices, each with its OWN real Plan Authority (calendar-native) and its OWN
// local caches. Plan writes are local-first, exactly like production, so "the
// item was written on this device but never pushed" is a real state here.
//
// Each device's plan sync and Brain Dump sync can go offline independently, and a
// device can "crash" (stop reacting), which is how the crash-point tests are built.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import targaryen from 'targaryen';

import { createPlanAuthority } from './plan-authority.js';
import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { createOperationalPlanSyncBridge } from './operational-plan-sync.js';
import { createPersonalDayBoundarySyncBridge } from './personal-day-boundary-sync.js';
import { createCalendarPlanRepository } from './calendar-plan-repository.js';
import { createCalendarPlanSyncBridge } from './calendar-plan-sync.js';
import { createCalendarPlanLiveWiring } from './calendar-plan-live.js';
import { memoryStorage } from './calendar-plan-test-support.js';
import { createBrainDumpRepository } from './brain-dump-repository.js';
import { createBrainDumpSyncBridge } from './brain-dump-sync.js';
import { normalizeCapture } from './brain-dump-model.js';
import { settleOutstandingClaim } from './brain-dump-promotion.js';
import { partitionOutboundItemsWith } from './plan-item-origin.js';
import { rulesEnforcingDatabase } from './brain-dump-test-support.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES = JSON.parse(readFileSync(path.join(HERE, 'firebase.rules.json'), 'utf8'));
export const UID = 'alice_uid';
export const ROOM = `uid_${UID}`;
export const MANILA = 'Asia/Manila';
export const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
export const calId = dateKey => `cal1:${dateKey}`;
export const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

let seq = 0;

export function makeWorld({ now = at('2026-10-03', '09:00') } = {}) {
  const clock = { now };
  const db = rulesEnforcingDatabase({ targaryen, rules: RULES, uid: UID });
  const devices = [];
  return { clock, db, devices, makeDevice: options => { const device = makeDevice({ db, clock, ...options }); devices.push(device); return device; } };
}

function makeDevice({ db, clock, name = `device-${++seq}`, listen = true }) {
  const state = { plansOnline: true, brainDumpOnline: true, crashed: false, guard: false };
  const room = () => ROOM;
  const roomRef = () => db.ref(`rooms/${ROOM}`);

  // ── this device's own real Plan Authority (calendar-native) ──
  const boundaryRepository = createPersonalDayBoundaryRepository({ storage: memoryStorage(), idGenerator: () => `rev-${name}-${++seq}`, getOwner: room });
  const planRepository = createOperationalPlanRepository({ storage: memoryStorage(), getOwner: room });
  const planSync = createOperationalPlanSyncBridge({ repository: planRepository, getRoomRef: () => null, getRoomId: room });
  const boundarySync = createPersonalDayBoundarySyncBridge({ repository: boundaryRepository, getRoomRef: () => null, getRoomId: room });
  const legacyPlans = {};
  const legacy = {
    record: k => legacyPlans[k] || null, rawItems: k => (legacyPlans[k]?.items || []).map(i => ({ ...i })),
    saveItems(k, items) { legacyPlans[k] = { ...(legacyPlans[k] || {}), items }; },
    confirm() { return { localSaved: true, syncPromise: Promise.resolve(false) }; },
    allPlans: () => legacyPlans, earliestPlanDate: () => null,
  };
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository, planRepository, planSync, boundarySync,
    legacyPlans: { readItems: k => legacy.rawItems(k), saveItems: (k, i) => legacy.saveItems(k, i) },
    now: () => clock.now, deviceId: () => name, fallbackTimezone: () => MANILA,
  });
  const calendarRepository = createCalendarPlanRepository({ storage: memoryStorage(), getOwner: room, getTimezone: () => MANILA, idGenerator: () => `ca1-${name}-${++seq}` });
  // This device's plan push consults THIS device's Brain Dump cache, as in production
  // (each browser has its own); a process-wide registry would let another simulated
  // device's knowledge guard this one's stale push and hide the server fence.
  let captureCache = null;
  const calendarSync = createCalendarPlanSyncBridge({
    repository: calendarRepository, getRoomRef: () => (state.plansOnline && !state.crashed ? roomRef() : null), getRoomId: room,
    partitionOutboundItems: items => partitionOutboundItemsWith(items, state.guard ? (captureId => captureCache?.read(captureId)) : null),
  });
  const calendar = createCalendarPlanLiveWiring({ repository: calendarRepository, sync: calendarSync, now: () => clock.now, deviceId: () => name, timezone: () => MANILA });
  calendar.attachLive();
  const planAuthority = createPlanAuthority({ live, legacy, calendar, now: () => clock.now, accountTimezone: () => MANILA });

  // ── this device's own Brain Dump, wired exactly like brain-dump-ui.js ──
  const repository = createBrainDumpRepository({ storage: memoryStorage(), getOwner: room, now: () => clock.now, deviceId: () => name });
  captureCache = repository;
  const settling = new Set();
  const outcomes = [];
  let bridge = null;
  const settle = id => {
    if (state.crashed || settling.has(id)) return Promise.resolve(null);
    settling.add(id);
    return settleOutstandingClaim({ repository, planAuthority, id, now: clock.now, deviceId: name, revokeClaim: bridge.revokeClaimRemote, resolveExpiredClaim: bridge.resolveExpiredClaimRemote })
      .then(outcome => { outcomes.push({ id, outcome }); if (outcome?.record && !state.crashed) bridge.syncCapture(id); return outcome; })
      .finally(() => settling.delete(id));
  };
  bridge = createBrainDumpSyncBridge({
    repository, getRoomRef: () => (state.brainDumpOnline && !state.crashed ? roomRef() : null), getRoomId: room, now: () => clock.now, deviceId: () => name,
    onRemoteChange: (id, record) => {
      const normalized = normalizeCapture(record);
      if (normalized?.promotionClaim && (normalized.status === 'triaged' || normalized.status === 'untriaged')) settle(id);
    },
  });
  if (listen) bridge.attach();

  const device = {
    name, state, clock, planAuthority, calendar, calendarRepository, calendarSync, repository, bridge, outcomes, settle,
    /** This device's guard view: the plan stores consult its own Brain Dump cache. */
    /** Turns on this device's own queue guard (its own Brain Dump cache). */
    useGuard() { state.guard = true; },
    /** brain-dump-ui.js's settleAllOutstandingClaims (run on every bind). */
    sweep() { return Promise.all(Object.keys(repository.listAllRaw()).filter(id => normalizeCapture(repository.read(id))?.promotionClaim).map(settle)); },
    recovered: () => outcomes.filter(o => o.outcome?.recovered).map(o => o.id),
    crash() { state.crashed = true; bridge.detach(); },
    /** A restarted process: same local storage, reconnects, re-attaches, sweeps. */
    async restart() { state.crashed = false; bridge.attach(); await flush(); await device.sweep(); await flush(); },
    async reconnectPlans() { state.plansOnline = true; device.useGuard(); await calendar.pushAllLocal?.(); await flush(); },
    activate() { planAuthority.activateCalendar(); },
    capture(text) {
      const id = repository.create({ text }).record.id;
      repository.triage(id, { important: true, urgent: false });
      return bridge.syncCapture(id).then(() => id);
    },
  };
  return device;
}

/** Items for `id` in a calendar plan, as the SERVER holds them: the fenced item at its stable keyed child
 *  (plan-item-origin.js) AND any un-fenced copy in the plan record's array, so a duplicate anywhere is seen. */
export function remoteItemsFor(db, dateKey, captureId) {
  const id = `bdp1|${captureId}`;
  const record = db.read(`rooms/${ROOM}/calendarPlans/${calId(dateKey)}`);
  const items = Array.isArray(record?.items) ? record.items : Object.values(record?.items || {});
  const fenced = db.read(`rooms/${ROOM}/calendarPlanFences/${calId(dateKey)}/${id}`);
  return [...items.filter(item => item?.id === id), ...(fenced ? [fenced] : [])];
}

export function remoteCapture(db, id) {
  return normalizeCapture(db.read(`rooms/${ROOM}/brainDump/${id}`));
}
