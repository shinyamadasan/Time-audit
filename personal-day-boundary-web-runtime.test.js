// personal-day-boundary-web-runtime.test.js
//
// Two deployed-web failure classes that left a real phone at "Off" while the desktop was on, both
// reproduced against the deployed Pages build with a stubbed Firebase:
//
//  1. UNKNOWN RENDERED AS OFF. An account whose snapshot held revisions the device could not apply (an
//     unmergeable history), or whose room listener was cancelled before answering, looked exactly like an
//     account that never enabled the boundary. Both are now distinct states — never "Off".
//  2. MIXED MODULE GENERATIONS. Entry scripts carried ?v=, but the modules they import (sync, repository,
//     live via ui/plan-authority, ...) were bare URLs cached independently, so one page could run new sync
//     code against an old repository (link error: PlanAuthority never loads) or old wiring against a new
//     storage.js (permanent Off). index.html now pins the whole group to ONE release token via an import map.
//
// Nothing here touches Firebase, the network, or production data.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPersonalDayBoundaryLiveWiring } from './personal-day-boundary-live.js';
import { createPersonalDayBoundaryRepository } from './personal-day-boundary-repository.js';
import { createPersonalDayBoundarySyncBridge, DAY_BOUNDARY_REVISIONS_REMOTE_PATH } from './personal-day-boundary-sync.js';
import { createOperationalPlanRepository } from './operational-plan-repository.js';
import { legacyBoundaryRevision, proposeBoundaryRevision } from './personal-day-boundary-model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANILA = 'Asia/Manila';
const ROOM = 'uid_web-runtime';
const T_0800 = Date.parse('2026-09-16T08:00:00+08:00');
const T_2100 = Date.parse('2026-09-16T21:00:00+08:00');

const memory = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), _map: map };
};

/** A room whose `on` records BOTH callbacks (success, error) so a test can deliver either. */
function makeRoom(remote = null) {
  const calls = [];
  const ref = {
    child() { return ref; },
    on(_event, success, error) { calls.push({ success, error }); },
    off() {},
    transaction() { return Promise.resolve({ committed: false }); },
  };
  return {
    ref, calls,
    answer(index, value) { calls[index].success({ val: () => value }); },
    fail(index, err = { code: 'PERMISSION_DENIED' }) { calls[index].error(err); },
    initial: remote,
  };
}

function makeDevice({ room }) {
  const auth = { room: ROOM };
  const events = { faults: 0, hydrations: 0 };
  const repository = createPersonalDayBoundaryRepository({ storage: memory(), idGenerator: () => `rev-${Math.random()}`, getOwner: () => auth.room });
  const boundarySync = createPersonalDayBoundarySyncBridge({
    repository,
    getRoomRef: () => (auth.room ? room.ref : null),
    getRoomId: () => auth.room,
    onSyncFault: () => { events.faults++; },
    onHydrated: () => { events.hydrations++; },
  });
  const live = createPersonalDayBoundaryLiveWiring({
    boundaryRepository: repository,
    planRepository: createOperationalPlanRepository({ storage: memory() }),
    boundarySync, planSync: null,
    now: () => T_2100, fallbackTimezone: () => MANILA,
  });
  return { repository, boundarySync, live, events, auth };
}

const history = () => {
  const anchor = legacyBoundaryRevision(MANILA);
  const { revision } = proposeBoundaryRevision([anchor], { id: 'pc-18-00', boundaryTime: '18:00', timezone: MANILA }, T_0800);
  return { anchor, revision, map: { [anchor.id]: anchor, [revision.id]: revision } };
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. unknown is not "Off"
// ═══════════════════════════════════════════════════════════════════════════

test('an account whose snapshot holds only an UNAPPLIABLE history (no anchor) is not "off": it is unapplied, blocked, and reported', () => {
  const { revision } = history();
  const room = makeRoom();
  const device = makeDevice({ room });
  device.live.attachLiveDays();
  room.answer(0, { [revision.id]: revision }); // a custom revision with no anchor anywhere

  const state = device.live.boundaryState();
  assert.equal(state.status, 'absent', 'nothing was applied locally');
  assert.equal(state.sync, 'synced', 'the account DID answer');
  assert.equal(state.remote.unapplied, true, '...but its answer could not be applied, so the account is not known to be off');
  assert.equal(state.remote.remoteCount, 1);
  assert.equal(device.live.previewProposal({ boundaryTime: '18:00', timezone: MANILA }).reason, 'sync-unapplied');
  assert.throws(() => device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }), /could not be loaded or applied/);
  assert.equal(device.repository.listAllRaw().length, 0, 'the refused save minted no competing anchor');
});

test('an authoritatively EMPTY account is still genuinely off (not unapplied), and a partly-bad remote that yields a usable history is not unapplied', () => {
  const empty = makeRoom();
  const a = makeDevice({ room: empty });
  a.live.attachLiveDays();
  empty.answer(0, null);
  assert.equal(a.live.boundaryState().remote.unapplied, false);
  assert.equal(a.live.boundaryState().sync, 'synced');
  assert.doesNotThrow(() => a.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }));

  const { map } = history();
  const partly = makeRoom();
  const b = makeDevice({ room: partly });
  b.live.attachLiveDays();
  partly.answer(0, { ...map, junk: { id: 'junk', boundaryTime: '99:99', timezone: MANILA, effectiveFromInstant: 5 } });
  const state = b.live.boundaryState();
  assert.equal(state.status, 'custom', 'the valid part was applied');
  assert.equal(state.active.boundaryTime, '18:00', 'the valid history governs (18:00 has been active since 18:00)');
  assert.equal(state.remote.unapplied, false);
  assert.equal(state.remote.rejectedCount, 1, 'the rejected entry is counted, not hidden');
});

test('a cancelled/denied room listener is an ERROR state — not "checking" forever and not "off" — and a later answer clears it', () => {
  const room = makeRoom();
  const device = makeDevice({ room });
  device.live.attachLiveDays();
  assert.equal(device.boundarySync.syncState(), 'pending');

  room.fail(0, { code: 'PERMISSION_DENIED' });
  assert.equal(device.boundarySync.syncState(), 'error');
  assert.equal(device.live.boundaryState().sync, 'error');
  assert.equal(device.events.faults, 1, 'the UI is told to repaint');
  assert.equal(device.live.previewProposal({ boundaryTime: '18:00', timezone: MANILA }).reason, 'sync-error');
  assert.throws(() => device.live.proposeBoundary({ boundaryTime: '18:00', timezone: MANILA }), /could not be loaded or applied/);
  assert.equal(device.boundarySync.diagnostics().listenerErrorCode, 'PERMISSION_DENIED');

  room.answer(0, history().map); // the account does answer eventually
  assert.equal(device.boundarySync.syncState(), 'synced');
  assert.equal(device.boundarySync.diagnostics().listenerError, false);
  assert.equal(device.live.boundaryState().status, 'custom');
});

test('a listener error AFTER hydration, or from a superseded listener, is ignored (a working device is never knocked into error)', () => {
  const room = makeRoom();
  const device = makeDevice({ room });
  device.live.attachLiveDays();
  room.answer(0, history().map);
  room.fail(0);
  assert.equal(device.boundarySync.syncState(), 'synced', 'already hydrated: an error cannot un-hydrate it');
  assert.equal(device.events.faults, 0);

  // A direct account switch replaces the listener; the old one's late error must not poison the new room.
  const other = makeRoom();
  const d2 = makeDevice({ room: other });
  d2.live.attachLiveDays();
  d2.auth.room = 'uid_other';
  d2.live.attachLiveDays(); // re-binds (a second .on on the same fake room)
  other.fail(0);
  assert.notEqual(d2.boundarySync.syncState(), 'error');
});

test('the bridge diagnostics are content-free: counts and booleans only — no revision id, timezone or room identity', () => {
  const { map, revision } = history();
  const room = makeRoom();
  const device = makeDevice({ room });
  device.live.attachLiveDays();
  room.answer(0, map);
  const diag = device.boundarySync.diagnostics();
  const text = JSON.stringify(diag);
  assert.equal(diag.remoteRevisionCount, 2);
  assert.equal(diag.hydrated, true);
  assert.equal(diag.cacheOwnerMatchesRoom, true);
  assert.ok(!text.includes(revision.id) && !text.includes(ROOM) && !text.includes(MANILA), 'nothing identifying leaks');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. one release, one module generation (static check of index.html)
// ═══════════════════════════════════════════════════════════════════════════

const read = name => readFileSync(path.join(HERE, name), 'utf8');
const html = read('index.html');
const importMap = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
const release = /<meta name="pdb-release" content="([^"]+)">/.exec(html)[1];
const importsOf = file => [...read(file).matchAll(/^\s*(?:import|export)\s[^;'"]*?from\s*['"](\.\/[^'"]+)['"]|^\s*import\s*['"](\.\/[^'"]+)['"]/gm)].map(m => m[1] || m[2]);
const GROUP = Object.keys(importMap).map(k => k.replace('./', ''));

test('the import map precedes every module script, and pins EVERY group module to the one release token', () => {
  assert.ok(html.indexOf('<script type="importmap">') > -1);
  assert.ok(html.indexOf('<script type="importmap">') < html.indexOf('<script type="module"'), 'an import map must come before any module script');
  for (const [key, target] of Object.entries(importMap)) {
    assert.equal(target, `${key}?v=${release}`, `${key} must map to itself with the release token`);
    assert.ok(existsSync(path.join(HERE, key)), `${key} must exist`);
  }
  for (const required of ['personal-day-boundary-model', 'personal-day-boundary-repository', 'personal-day-boundary-sync', 'personal-day-boundary-live', 'operational-plan-model', 'operational-plan-repository', 'operational-plan-sync', 'plan-authority']) {
    assert.ok(GROUP.includes(`${required}.js`), `${required}.js must be in the pinned group`);
  }
});

test('every entry tag for the group, and storage.js, carries the SAME release token as the map and the meta', () => {
  for (const file of ['personal-day-boundary-live.js', 'personal-day-boundary-ui.js', 'operational-plan-ui.js', 'storage.js']) {
    const tag = new RegExp(`src="${file.replace('.', '\\.')}\\?v=([^"]+)"`).exec(html);
    assert.ok(tag, `${file} has a versioned tag`);
    assert.equal(tag[1], release, `${file} must carry the release token`);
  }
  assert.match(html, new RegExp(`import\\('\\./personal-day-boundary-diagnostics\\.js\\?v=${release}'\\)`));
});

// Every token the pinned group has shipped under. A browser that cached a module at one of those URLs
// must never be served CHANGED code at the same URL, so a new generation never reuses one and leaves
// nothing behind on one. Limitation: this cannot detect on its own that a group module changed (that
// needs git history, which would make the test brittle) — whoever changes a group module or storage.js
// bumps CURRENT_RELEASE and appends the old token here, and this test makes that step explicit.
const CURRENT_RELEASE = '20260924-operational-plan-account-isolation-v1';
const PREVIOUS_RELEASES = ['20260921-pdb-web-sync-v1', '20260922-pdb-wire-format-v1', '20260923-pdb-legacy-recovery-v2'];

test('the release is a NEW generation: never a previously shipped token, and no URL is left on an old one', () => {
  assert.equal(release, CURRENT_RELEASE);
  assert.ok(!PREVIOUS_RELEASES.includes(release));
  for (const old of PREVIOUS_RELEASES) assert.ok(!html.includes(old), `index.html still references ${old}`);
  // Operational Plan Account Isolation V1 changed these; each must resolve to a URL no old browser cache holds.
  for (const file of ['operational-plan-repository.js', 'operational-plan-sync.js', 'personal-day-boundary-live.js', 'plan-authority.js']) {
    assert.equal(importMap[`./${file}`], `./${file}?v=${CURRENT_RELEASE}`);
  }
  // The live wiring is both an entry tag and an import target: both must be the ONE same URL (one instance).
  const liveTags = [...html.matchAll(/src="personal-day-boundary-live\.js\?v=([^"]+)"/g)];
  assert.equal(liveTags.length, 1);
  assert.equal(`./personal-day-boundary-live.js?v=${liveTags[0][1]}`, importMap['./personal-day-boundary-live.js']);
});

test('every import of a group module, from any runtime module, is covered by the map — none can resolve to an unversioned URL', () => {
  const runtime = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"?]+)/g)].map(m => m[1]);
  const seen = new Set();
  const uncovered = [];
  const crawl = file => {
    if (seen.has(file) || !existsSync(path.join(HERE, file))) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const target = spec.replace('./', '');
      if (/\.js$/.test(target) && GROUP.includes(target) === false && /(personal-day-boundary|operational-plan|plan-authority)/.test(target)) uncovered.push(`${file} -> ${target}`);
      crawl(target);
    }
  };
  runtime.forEach(crawl);
  assert.deepEqual(uncovered, [], 'a bare import of a Personal Day / plan module that the map does not pin would re-open the mixed-generation window');
  assert.ok(seen.has('personal-day-boundary-sync.js') && seen.has('personal-day-boundary-repository.js') && seen.has('plan-authority.js'), 'the crawl really reached the group');
});

test('no runtime module imports a group module with its own ?v= (that would create a second instance of it)', () => {
  const offenders = [];
  for (const file of new Set([...GROUP, 'planning-continuity-ui.js', 'plan-tomorrow-ui.js', 'tomorrow-view-ui.js', 'commitments-model.js', 'operational-plan-ui.js'])) {
    if (existsSync(path.join(HERE, file)) && /from\s*['"]\.\/[^'"]*\?v=/.test(read(file))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('the diagnostics module is read-only: it never writes storage or Firebase and never reads the uid, a token or revision contents', () => {
  // Code only: the header comment DESCRIBES what is never shown, so comments are stripped first.
  const source = read('personal-day-boundary-diagnostics.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /localStorage\.(setItem|removeItem|clear)|sessionStorage|indexedDB|\.ref\(|\.database\(|\.transaction\(|\.set\(|\.update\(|signOut|getIdToken|accessToken|apiKey|\.uid\b|displayName|email/i);
  assert.match(source, /SHA-256/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Legacy Recovery V2 IS part of this candidate — it must never claim provenance
// ═══════════════════════════════════════════════════════════════════════════
//
// Unlike the wire-format-only candidate, this branch DOES ship Legacy Recovery — but on a
// provenance-aware model: structural compatibility is never treated as proof of ownership. The
// human owner's explicit attestation is the only provenance gate. This is a hard, source-level
// guarantee against language regressing back to implying the software has verified ownership.

test('no source or copy claims ownership/provenance was verified by the software itself', () => {
  const FORBIDDEN = [
    /provenSafe/,
    /ownershipVerified/,
    /\bsafe owner match\b/i,
    /\bownership verified\b/i,
    /belongs to you\b/i,
    /\byour old setting\b/i,
    /\bverified\b.{0,20}\bsafe\b/i,
  ];
  const candidates = [...GROUP, 'personal-day-boundary-recovery.js', 'personal-day-boundary-diagnostics.js', 'personal-day-boundary-ui.js', 'index.html'];
  const offenders = [];
  for (const file of candidates) {
    if (!existsSync(path.join(HERE, file))) continue;
    // Code/copy only: comments are stripped first, so a comment correctly NAMING a forbidden phrase
    // to explain why it is avoided (this file's own header, or personal-day-boundary-recovery.js's
    // own documentation of what it must never say) is not itself flagged as saying it.
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const pattern of FORBIDDEN) {
      if (pattern.test(source)) offenders.push(`${file} matches ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the import map and the pinned group carry the recovery entry, pinned to the same release token as everything else', () => {
  assert.ok('./personal-day-boundary-recovery.js' in importMap);
  assert.ok(GROUP.includes('personal-day-boundary-recovery.js'));
  assert.equal(importMap['./personal-day-boundary-recovery.js'], `./personal-day-boundary-recovery.js?v=${release}`);
});
