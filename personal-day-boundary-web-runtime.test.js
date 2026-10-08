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
// Brain Dump is its own generation inside the same import map (Production UX Correction V1 FIX FIRST):
// its modules are pinned to the Brain Dump entry token, not the governed release. Everything else in
// the map is the governed group.
const isBrainDump = file => /^brain-dump-[a-z-]+\.js$/.test(file);
const GROUP = Object.keys(importMap).map(k => k.replace('./', '')).filter(file => !isBrainDump(file));
const BRAIN_DUMP_GROUP = Object.keys(importMap).map(k => k.replace('./', '')).filter(isBrainDump);
const moduleEntries = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"?]+)(?:\?v=([^"]+))?"/g)]
  .map(m => ({ file: m[1].replace(/^\.\//, ''), version: m[2] || '' }));
const governedModule = /^(?:personal-day-boundary-|operational-plan-|plan-authority\.js$|plan-item-origin\.js$|plan-fence-sync\.js$|planning-continuity-ui\.js$|stale-plan-recovery-model\.js$|calendar-plan-(?:model|repository|sync|live)\.js$|commitments-(?:repository|sync)\.js$|coarse-life-evidence-(?:repository|sync|ui)\.js$|learning-plan-repository\.js$|capability-career-repository\.js$|daily-routines-repository\.js$)/;

test('the import map precedes every module script, and pins EVERY group module to the one release token', () => {
  assert.ok(html.indexOf('<script type="importmap">') > -1);
  assert.ok(html.indexOf('<script type="importmap">') < html.indexOf('<script type="module"'), 'an import map must come before any module script');
  for (const [key, target] of Object.entries(importMap).filter(([key]) => GROUP.includes(key.replace('./', '')))) {
    assert.equal(target, `${key}?v=${release}`, `${key} must map to itself with the release token`);
    assert.ok(existsSync(path.join(HERE, key)), `${key} must exist`);
  }
  for (const required of ['personal-day-boundary-model', 'personal-day-boundary-repository', 'personal-day-boundary-sync', 'personal-day-boundary-live', 'operational-plan-model', 'operational-plan-repository', 'operational-plan-sync', 'plan-authority',
    'commitments-repository', 'commitments-sync', 'coarse-life-evidence-repository', 'coarse-life-evidence-sync', 'coarse-life-evidence-ui',
    'learning-plan-repository', 'capability-career-repository', 'daily-routines-repository',
    'stale-plan-recovery-model', 'calendar-plan-model', 'calendar-plan-repository', 'calendar-plan-sync', 'calendar-plan-live', 'plan-item-origin', 'plan-fence-sync']) {
    assert.ok(GROUP.includes(`${required}.js`), `${required}.js must be in the pinned group`);
  }
});

test('every entry tag for the group, and storage.js, carries the SAME release token as the map and the meta', () => {
  for (const file of ['personal-day-boundary-live.js', 'personal-day-boundary-ui.js', 'operational-plan-ui.js', 'storage.js', 'commitments-sync.js', 'coarse-life-evidence-sync.js', 'coarse-life-evidence-ui.js',
    'learning-plan-ui.js', 'capability-career-ui.js', 'daily-routines-ui.js', 'calendar-plan-ui.js', 'planning-continuity-ui.js']) {
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
// Remaining Remote Cross-Account Isolation V1 changed storage.js (account-scoped entries/settings/plans),
// so the whole group moved to a new generation with it. Focus Redemption Account Isolation V1 changes
// storage.js again (account-scoped focus redemptions), so the whole group moves to a new generation
// once more: an old cached storage.js beside new modules (or the reverse) must never be one page load.
// Device-Local Account Isolation V1 changes storage.js (account-scoped reviews/weeklyReviews) and scopes the
// Learning Plan / Capability-Career / Daily Routine repositories, which join the group: another new generation.
// Its FIX FIRST changes storage.js (full sign-out teardown) and index.html again, so it gets its own generation
// ('-fix1', which deliberately does not contain the retired '-v1' token as a substring).
// Calendar Day + Extended My Day V1 adds plan-by-deadline-model.js / -repository.js / -sync.js to the pinned
// group (plan-authority.js now side-effect-imports the sync bridge) and changes plan-authority.js itself
// (planningDeadlineStreak) and index.html (calendar-date-primary My Day labels, date-break divider, carryover
// section) — all group members, so the whole group moves to a new generation with them. Its FIX FIRST
// changes plan-authority.js again (the current()/previous() target-chain correction, completeCarryoverItem)
// and index.html (the carryover completion action, the Settings off-day dateKey fix), plan-by-deadline-model.js
// (revision-owned timezone, equal-authority conflict detection) and plan-by-deadline-repository.js
// (deadlineConflict()) — another new generation, its own '-fix1' token per the existing convention.
// Calendar-Native Plan Identity V1 adds the calendar-plan model / repository / sync / live modules to the
// pinned group (plan-authority.js side-effect-imports the live wiring), changes plan-authority.js, storage.js
// (calendar + Plan-by deadline listener lifecycle) and index.html — all group members, so the whole group moves
// to a new generation again.
// Its final release-closure fix brings the changed planning-continuity entry and stale-recovery import under
// that same generation, so fix2 is retired and the complete browser path moves to fix3.
// Timer / Away Account Isolation V1 changes storage.js again, so every governed URL moves together.
// Its Break ownership FIX FIRST changes storage.js and index.html again, so it gets its own generation.
// Brain Dump + Eisenhower V1's FIX FIRST wires BrainDumpSync into storage.js's runtime lifecycle
// (startSync/.info-connected/teardownRoomListeners), so storage.js changes again and the whole
// governed group moves with it — an old cached storage.js beside new group modules (or the reverse)
// must never be one page load. brain-dump-*.js itself stays OUTSIDE this governed group: nothing in
// the group imports it, so it never moves this token.
// Brain Dump Production UX Correction V1's FIX FIRST found that leaving Brain Dump's INTERNAL imports
// bare broke a fresh brain-dump-sync/-ui against an old cached brain-dump-model ("does not provide an
// export named 'promotedTo'"). So every brain-dump-*.js module is now in the import map too, as its OWN
// generation (BRAIN_DUMP_RELEASE below), pinned to the token its two entry tags carry. The governed
// token is unchanged by it.
// Its architecture fix #5 (the Brain Dump promotion fence, DECISIONS #32) changes governed modules
// (plan-authority.js, the calendar/operational sync + repositories + live wirings, storage.js) and adds
// plan-item-origin.js to the group, so the whole group moves to a new generation.
// Location-Bound Brain Dump Promotion Fence V1 (DECISIONS #33) replaces the array-indexed fence: a fenced item now
// lives at a stable keyed child (plan-fence-sync.js, a new governed module), and plan-item-origin.js,
// plan-authority.js, the calendar/operational sync + repositories + live wirings, planning-continuity-ui.js and
// storage.js all change, so the whole governed group moves to a new generation. The candidate token it replaces
// was published on a candidate branch, so it is retired like a shipped one.
// Intelligence adds a read-context bridge and account-reset seam; retire the prior governed URL.
const CURRENT_RELEASE = '20261007-intelligence-v1';
const BRAIN_DUMP_RELEASE = '20261005-brain-dump-location-bound-fence-v1';
// Brain Dump entry tokens that were published (on main or a candidate branch) and must never be reused.
// (Its round-1 entries also used '20261002-brain-dump-eisenhower-v1-fix1', which is still the governed
// token, so it is checked as "not the Brain Dump token" instead of "absent from index.html".)
const PREVIOUS_BRAIN_DUMP_RELEASES = ['20261001-brain-dump-eisenhower-v1', '20261002-brain-dump-eisenhower-v1-fix2', '20261002-brain-dump-eisenhower-v1-fix3', '20261003-brain-dump-production-ux-v1', '20261003-brain-dump-production-ux-fix1', '20261003-brain-dump-production-ux-fix2', '20261003-brain-dump-production-ux-fix3', '20261003-brain-dump-production-ux-fix4'];

test('Brain Dump is ONE coherent generation: every brain-dump-*.js module any Brain Dump entry reaches is import-mapped to the entry tags\' token', () => {
  const entries = moduleEntries.filter(entry => isBrainDump(entry.file));
  assert.deepEqual(entries.map(entry => entry.file).sort(), ['brain-dump-sync.js', 'brain-dump-ui.js']);
  for (const entry of entries) assert.equal(entry.version, BRAIN_DUMP_RELEASE, `${entry.file} entry tag`);
  assert.ok(!PREVIOUS_BRAIN_DUMP_RELEASES.includes(BRAIN_DUMP_RELEASE));
  for (const old of PREVIOUS_BRAIN_DUMP_RELEASES) assert.ok(!html.includes(`?v=${old}"`), `index.html still references ${old}`);
  assert.notEqual(BRAIN_DUMP_RELEASE, release, 'Brain Dump moves independently of the governed token');
  assert.notEqual(BRAIN_DUMP_RELEASE, '20261002-brain-dump-eisenhower-v1-fix1', 'a retired Brain Dump token');

  // Crawl the real Brain Dump graph from its entries: EVERY brain-dump-*.js module it imports must be
  // mapped to the one Brain Dump URL. A bare, unmapped one is the mixed-cache link failure.
  const seen = new Set();
  const crawl = file => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const target = spec.replace('./', '');
      if (isBrainDump(target)) crawl(target);
    }
  };
  entries.forEach(entry => crawl(entry.file));
  for (const file of ['brain-dump-model.js', 'brain-dump-repository.js', 'brain-dump-promotion.js']) assert.ok(seen.has(file), `the crawl reached ${file}`);
  for (const file of seen) {
    assert.equal(importMap[`./${file}`], `./${file}?v=${BRAIN_DUMP_RELEASE}`, `${file} must resolve through the Brain Dump generation`);
  }
  assert.deepEqual([...BRAIN_DUMP_GROUP].sort(), [...seen].sort(), 'the map pins exactly the Brain Dump graph');
});

test('no Brain Dump module pins its own ?v= import, and no governed module imports Brain Dump', () => {
  for (const file of BRAIN_DUMP_GROUP) assert.ok(!/from\s*['"]\.\/[^'"]*\?v=/.test(read(file)), `${file} must import through the map, never with its own ?v=`);
  for (const file of GROUP) {
    if (!existsSync(path.join(HERE, file))) continue;
    assert.ok(!importsOf(file).some(spec => isBrainDump(spec.replace('./', ''))), `${file} (governed) must not import Brain Dump`);
  }
});
// '20260924-cross-store-account-isolation-v1' was never deployed (review candidate only), but it was
// published on the candidate branch, so it is retired like a shipped token.
const PREVIOUS_RELEASES = ['20261005-location-bound-fence-v1', '20260921-pdb-web-sync-v1', '20260922-pdb-wire-format-v1', '20260923-pdb-legacy-recovery-v2', '20260924-operational-plan-account-isolation-v1', '20260924-cross-store-account-isolation-v1', '20260924-cross-store-account-isolation-fix1', '20260924-remaining-remote-account-isolation-v1', '20260924-focus-redemption-account-isolation-v1', '20260925-device-local-account-isolation-v1', '20260926-device-local-account-isolation-fix1', '20260927-calendar-day-extended-my-day-v1', '20260927-calendar-day-extended-my-day-fix1', '20260927-calendar-native-plan-identity-v1', '20260927-calendar-native-activation-safety-fix1', '20260928-calendar-native-activation-safety-fix2', '20260928-calendar-native-activation-safety-fix3', '20260930-timer-away-account-isolation-v1', '20261001-daily-plan-ux-v2-time-ranges-extended-my-day1', '20261002-brain-dump-eisenhower-v1-fix1', '20261003-brain-dump-promotion-fence-v1'];

test('the release is a NEW generation: never a previously shipped token, and no URL is left on an old one', () => {
  assert.equal(release, CURRENT_RELEASE);
  assert.ok(!PREVIOUS_RELEASES.includes(release));
  for (const old of PREVIOUS_RELEASES) assert.ok(!html.includes(old), `index.html still references ${old}`);
  // Operational Plan Account Isolation V1 changed these; each must resolve to a URL no old browser cache holds.
  for (const file of ['operational-plan-repository.js', 'operational-plan-sync.js', 'personal-day-boundary-live.js', 'plan-authority.js']) {
    assert.equal(importMap[`./${file}`], `./${file}?v=${CURRENT_RELEASE}`);
  }
  // Cross-Store Account Isolation V1 changed these (room-scoped caches + owner-guarded bridges). A page
  // that loaded a new scoped repository beside an old unscoped sync bridge (or the reverse) would re-open
  // the leak, so they are pinned to the one release like everything else.
  for (const file of ['commitments-repository.js', 'commitments-sync.js', 'coarse-life-evidence-repository.js', 'coarse-life-evidence-sync.js', 'coarse-life-evidence-ui.js']) {
    assert.equal(importMap[`./${file}`], `./${file}?v=${CURRENT_RELEASE}`);
  }
  // Both sync bridges are entry tags AND import targets: each must be the ONE same URL (one instance, one singleton).
  for (const file of ['commitments-sync.js', 'coarse-life-evidence-sync.js', 'coarse-life-evidence-ui.js']) {
    const tags = [...html.matchAll(new RegExp(`src="${file.replace('.', '\\.')}\\?v=([^"]+)"`, 'g'))];
    assert.equal(tags.length, 1, `${file} has exactly one entry tag`);
    assert.equal(`./${file}?v=${tags[0][1]}`, importMap[`./${file}`]);
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
      if (/\.js$/.test(target) && GROUP.includes(target) === false && /(personal-day-boundary|operational-plan|plan-authority|plan-item-origin|plan-fence-sync|calendar-plan-(model|repository|sync|live)|commitments-(repository|sync)|coarse-life-evidence-(repository|sync|ui)|learning-plan-repository|capability-career-repository|daily-routines-repository)/.test(target)) uncovered.push(`${file} -> ${target}`);
      crawl(target);
    }
  };
  runtime.forEach(crawl);
  assert.deepEqual(uncovered, [], 'a bare import of a Personal Day / plan module that the map does not pin would re-open the mixed-generation window');
  assert.ok(seen.has('personal-day-boundary-sync.js') && seen.has('personal-day-boundary-repository.js') && seen.has('plan-authority.js'), 'the crawl really reached the group');
  assert.ok(seen.has('commitments-repository.js') && seen.has('coarse-life-evidence-repository.js'), 'the crawl reached both scoped repositories');
  assert.ok(seen.has('learning-plan-repository.js') && seen.has('capability-career-repository.js') && seen.has('daily-routines-repository.js'), 'the crawl reached the device-local scoped repositories');
});

test('every governed module reached from the real browser graph resolves through the active generation', () => {
  const seen = new Set();
  const imported = new Set();
  const crawl = file => {
    if (seen.has(file) || !existsSync(path.join(HERE, file))) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const target = spec.replace('./', '');
      imported.add(target);
      crawl(target);
    }
  };
  moduleEntries.map(entry => entry.file).forEach(crawl);

  assert.ok(seen.has('planning-continuity-ui.js') && seen.has('stale-plan-recovery-model.js'), 'the real graph must reach the changed recovery entry and model');
  for (const file of [...seen].filter(name => governedModule.test(name))) {
    const entries = moduleEntries.filter(entry => entry.file === file);
    for (const entry of entries) assert.equal(entry.version, release, file + ' entry must carry the active release');
    if (imported.has(file)) assert.equal(importMap['./' + file], './' + file + '?v=' + release, file + ' import must resolve through the active release map');
  }
});

test('no runtime module imports a group module with its own ?v= (that would create a second instance of it)', () => {
  const offenders = [];
  for (const file of new Set([...GROUP, 'planning-continuity-ui.js', 'plan-tomorrow-ui.js', 'tomorrow-view-ui.js', 'commitments-model.js', 'operational-plan-ui.js', 'coarse-life-evidence-ui.js', 'coarse-life-evidence-model.js'])) {
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
