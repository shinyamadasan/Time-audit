import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ObsidianSyncError,
  createObsidianSyncTarget,
  verifyObsidianVaultIdentity,
  planObsidianSync,
  applyObsidianSync,
  formatObsidianSyncPreview,
  evaluateProductionAuthorization,
  prepareObsidianRollbackArtifact,
  verifyObsidianRollbackReceipt,
  OBSIDIAN_SYNC_OPERATIONS,
  OBSIDIAN_SYNC_SCHEMA_VERSION,
  OBSIDIAN_PRODUCTION_SYNC_ENABLED,
  OBSIDIAN_SENTINEL_RELATIVE_PATH,
  OBSIDIAN_MANIFEST_RELATIVE_PATH,
  OBSIDIAN_SYSTEM_README_RELATIVE_PATH
} from './obsidian-life-ledger-sync.js';
import { OBSIDIAN_LIFE_LEDGER_SENTINEL } from './obsidian-life-ledger-renderer.js';
import { serializeLifeLedgerSnapshot, createLifeLedgerSnapshotFromEvents } from './life-ledger-transport.js';
import { runLifeLedgerObsidianSync, loadRollbackReceiptFromDisk } from './scripts/sync-life-ledger-to-obsidian.mjs';

const OP = OBSIDIAN_SYNC_OPERATIONS;
const DENIED_ONEDRIVE_VAULT_ROOT = 'C:\\Users\\Admin\\OneDrive\\2nd Brain';
const DENIED_STALE_DESKTOP_VAULT_ROOT = 'C:\\Users\\Admin\\Desktop\\2nd Brain';
const DENIED_TEST_VAULT_ROOT = 'C:\\Users\\Admin\\Desktop\\Second-Brain-Test-Vault';
const DAILY_2026_08_30 = 'Life Ledger/Daily/2026-08-30.md';
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function focusEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '10101010-1010-4010-8010-101010101010',
    sourceApp: 'chronasense',
    sourceEntityId: 'focus-entry-1',
    type: 'focus_session_completed',
    occurredAt: '2026-08-30T16:00:00.000Z',
    recordedAt: '2026-08-30T16:00:00.000Z',
    revisedAt: null,
    sourceTimezone: 'America/Phoenix',
    payload: {
      activity: 'Synthetic focus',
      startedAt: '2026-08-30T15:35:00.000Z',
      endedAt: '2026-08-30T16:00:00.000Z',
      durationMinutes: 25,
      additiveForTimeTotals: false,
      source: { focusEntryId: 'focus-entry-1' }
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.focus_outcome',
      adapterVersion: 'test-v1',
      observedAt: '2026-08-30T16:00:00.000Z',
      captureMethod: 'pomodoro',
      evidence: ['synthetic.focus:1']
    },
    confidence: { score: 1, basis: 'source-recorded' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

// A second event on 2026-08-31, so a later apply has a genuine new CREATE + manifest UPDATE.
function focusEventDay2() {
  return focusEvent({
    eventId: '20202020-2020-4020-8020-202020202020',
    sourceEntityId: 'focus-entry-2',
    occurredAt: '2026-08-31T16:00:00.000Z',
    recordedAt: '2026-08-31T16:00:00.000Z',
    payload: { ...focusEvent().payload, startedAt: '2026-08-31T15:35:00.000Z', endedAt: '2026-08-31T16:00:00.000Z', source: { focusEntryId: 'focus-entry-2' } },
    provenance: { ...focusEvent().provenance, evidence: ['synthetic.focus:2'] }
  });
}

async function withTempVault(fn, { obsidian = true, testVaultMarker = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronasense-obsidian-sync-'));
  try {
    if (obsidian) await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
    if (testVaultMarker) await fs.writeFile(path.join(root, 'TEST-VAULT.md'), 'test vault\n', 'utf8');
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// A pass-through fs adapter with selective overrides, so tests can inject failures without
// re-implementing the whole filesystem.
function proxyFs(overrides = {}) {
  const calls = { writeFile: 0, rename: 0, unlink: 0, mkdir: 0 };
  const base = {
    async mkdir(...a) { calls.mkdir++; return fs.mkdir(...a); },
    readFile: (...a) => fs.readFile(...a),
    stat: (...a) => fs.stat(...a),
    lstat: (...a) => fs.lstat(...a),
    realpath: (...a) => fs.realpath(...a),
    readdir: (...a) => fs.readdir(...a),
    async writeFile(...a) { calls.writeFile++; return fs.writeFile(...a); },
    async rename(...a) { calls.rename++; return fs.rename(...a); },
    async unlink(...a) { calls.unlink++; return fs.unlink(...a); }
  };
  return { adapter: { ...base, ...overrides(base, calls) }, calls };
}

function testTarget(vaultPath, overrides = {}) {
  return createObsidianSyncTarget({ vaultPath, mode: 'test', allowApply: true, ...overrides });
}
function prodTarget(vaultPath, overrides = {}) {
  return createObsidianSyncTarget({ vaultPath, mode: 'production', allowApply: true, ...overrides });
}
async function firstApply(vault, events = [focusEvent()]) {
  const target = testTarget(vault);
  const plan = await planObsidianSync(target, events);
  return applyObsidianSync(plan, { mode: 'test', apply: true });
}
function readVault(vault, rel) {
  return fs.readFile(path.join(vault, ...rel.split('/')), 'utf8');
}
async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}

// ===========================================================================
// Target model
// ===========================================================================

test('createObsidianSyncTarget rejects unknown mode / non-Life-Ledger root / empty vaultPath, and freezes', () => {
  assert.throws(() => createObsidianSyncTarget({ vaultPath: 'C:\\x', mode: 'staging' }), e => e.code === 'invalid_target');
  assert.throws(() => createObsidianSyncTarget({ vaultPath: 'C:\\x', mode: 'test', managedRoot: 'Elsewhere' }), e => e.code === 'invalid_target');
  assert.throws(() => createObsidianSyncTarget({ vaultPath: '  ', mode: 'test' }), e => e.code === 'invalid_target');
  const t = createObsidianSyncTarget({ vaultPath: 'C:\\x', mode: 'test' });
  assert.equal(t.allowApply, false);
  assert.throws(() => { t.mode = 'production'; }, TypeError);
});

// ===========================================================================
// Vault identity / denied roots
// ===========================================================================

test('test mode denies the stale Desktop vault and the real OneDrive vault before touching disk', async () => {
  for (const denied of [DENIED_STALE_DESKTOP_VAULT_ROOT, DENIED_ONEDRIVE_VAULT_ROOT]) {
    const id = await verifyObsidianVaultIdentity(testTarget(denied));
    assert.equal(id.ok, false);
    assert.equal(id.reason, 'denied_vault_root');
  }
});
test('production mode denies the stale Desktop vault and the test vault even with a matching expected path', async () => {
  for (const denied of [DENIED_STALE_DESKTOP_VAULT_ROOT, DENIED_TEST_VAULT_ROOT]) {
    const id = await verifyObsidianVaultIdentity(prodTarget(denied), { expectedCanonicalVaultPath: denied });
    assert.equal(id.ok, false);
    assert.equal(id.reason, 'denied_vault_root');
  }
});
test('production mode requires an exact canonical-path match and never auto-discovers', async () => (
  withTempVault(async vault => {
    assert.equal((await verifyObsidianVaultIdentity(prodTarget(vault))).reason, 'missing_expected_canonical_path');
    assert.equal((await verifyObsidianVaultIdentity(prodTarget(vault), { expectedCanonicalVaultPath: `${vault}\\..\\x` })).reason, 'canonical_path_mismatch');
    assert.equal((await verifyObsidianVaultIdentity(prodTarget(vault), { expectedCanonicalVaultPath: vault })).ok, true);
  })
));
test('identity check rejects a vault path inside a known repo root and reports missing paths without throwing', async () => {
  await withTempVault(async vault => {
    assert.equal((await verifyObsidianVaultIdentity(testTarget(vault), { knownRepoRoots: [vault] })).reason, 'inside_known_repo_root');
  });
  assert.equal((await verifyObsidianVaultIdentity(testTarget('C:\\Nope\\Xyz\\Vault'))).reason, 'vault_missing');
});
test('identity check surfaces .obsidian presence as a soft signal, never a hard block', async () => {
  await withTempVault(async vault => assert.equal((await verifyObsidianVaultIdentity(testTarget(vault))).signals.hasObsidianDir, true));
  await withTempVault(async vault => {
    const id = await verifyObsidianVaultIdentity(testTarget(vault));
    assert.equal(id.ok, true);
    assert.equal(id.signals.hasObsidianDir, false);
  }, { obsidian: false });
});

// ===========================================================================
// Ownership chaos — review tests A-I
// ===========================================================================

test('A: valid sentinel + NO manifest -> BLOCK (missing_manifest_baseline)', async () => (
  withTempVault(async vault => {
    await firstApply(vault);
    await fs.rm(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH));
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockState, 'invalid_sentinel');
    assert.equal(plan.blockReason, 'missing_manifest_baseline');
    assert.equal(plan.operations.length, 1);
    assert.equal(plan.operations[0].op, OP.BLOCKED);
  })
));
test('B: manifest deleted from a previously owned root -> BLOCK, no generated file may UPDATE', async () => (
  withTempVault(async vault => {
    await firstApply(vault);
    await fs.rm(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH));
    const plan = await planObsidianSync(testTarget(vault), [focusEvent({ payload: { ...focusEvent().payload, activity: 'changed' } })]);
    assert.equal(plan.blocked, true);
    assert.ok(!plan.operations.some(op => op.op === OP.UPDATE));
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }), e => e.code === 'plan_blocked');
  })
));
test('C: legacy v1 sentinel without a manifest hash -> BLOCK (legacy_sentinel_migration_required)', async () => (
  withTempVault(async vault => {
    await fs.mkdir(path.join(vault, 'Life Ledger', 'System'), { recursive: true });
    await fs.writeFile(
      path.join(vault, OBSIDIAN_SENTINEL_RELATIVE_PATH),
      `${OBSIDIAN_LIFE_LEDGER_SENTINEL}\n---\nowner: chronasense-life-ledger\nschemaVersion: 1\nmanagedRoot: Life Ledger\n---\n`,
      'utf8'
    );
    await fs.writeFile(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH), '{"schemaVersion":1,"owner":"chronasense-life-ledger","managedRoot":"Life Ledger","files":[]}\n', 'utf8');
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockReason, 'legacy_sentinel_migration_required');
  })
));
test('D: hand-written note at a generated path with only a bare marker -> CONFLICT, human content preserved', async () => (
  withTempVault(async vault => {
    await firstApply(vault, [focusEvent()]);
    // A second day whose Daily file a human created by hand, marker present, never in the manifest.
    const humanText = `${OBSIDIAN_LIFE_LEDGER_SENTINEL}\n\n# My hand notes for the 31st\n`;
    await fs.writeFile(path.join(vault, 'Life Ledger', 'Daily', '2026-08-31.md'), humanText, 'utf8');
    const plan = await planObsidianSync(testTarget(vault), [focusEvent(), focusEventDay2()]);
    const op = plan.operations.find(o => o.relativePath === 'Life Ledger/Daily/2026-08-31.md');
    assert.equal(op.op, OP.CONFLICT);
    assert.equal(op.reason, 'missing_manifest_baseline');
    assert.equal(plan.blocked, true);
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }), e => e.code === 'plan_blocked');
    assert.equal(await readVault(vault, 'Life Ledger/Daily/2026-08-31.md'), humanText);
  })
));
test('E: manifest bytes modified -> sentinel manifestSha256 mismatch -> BLOCK', async () => (
  withTempVault(async vault => {
    await firstApply(vault);
    await fs.appendFile(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH), '\n', 'utf8');
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockReason, 'manifest_integrity_mismatch');
  })
));
test('F: manifest entry edited to match a human-modified file, but the sentinel still binds the old manifest -> BLOCK', async () => (
  withTempVault(async vault => {
    await firstApply(vault);
    const dailyAbs = path.join(vault, ...DAILY_2026_08_30.split('/'));
    const hacked = `${await fs.readFile(dailyAbs, 'utf8')}\nattacker note\n`;
    await fs.writeFile(dailyAbs, hacked, 'utf8');
    // Rewrite the manifest so its entry for the Daily file matches the hacked hash.
    const manifest = JSON.parse(await fs.readFile(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH), 'utf8'));
    for (const f of manifest.files) if (f.relativePath === DAILY_2026_08_30) f.sha256 = sha256(hacked);
    await fs.writeFile(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockReason, 'manifest_integrity_mismatch'); // sentinel still binds the ORIGINAL manifest bytes
  })
));
test('G: partial FIRST run (content+manifest written, sentinel fails) -> next plan BLOCKS, never auto-adopts', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const plan = await planObsidianSync(target, [focusEvent()]);
    // writeFile order: Daily.tmp, README.tmp, manifest.tmp, sentinel.tmp -> fail the 4th.
    const { adapter } = proxyFs((_b, calls) => ({
      async writeFile(p, c, e) {
        calls.writeFile++;
        if (calls.writeFile === 4) throw Object.assign(new Error('sentinel write failed'), { code: 'EIO' });
        return fs.writeFile(p, c, e);
      }
    }));
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }, { fs: adapter }), e => e.code === 'partial_apply_failure');
    assert.equal(await exists(path.join(vault, OBSIDIAN_SENTINEL_RELATIVE_PATH)), false);
    const next = await planObsidianSync(target, [focusEvent()]);
    assert.equal(next.blocked, true);
    assert.equal(next.blockState, 'unmanaged_conflict');
    assert.equal(next.blockReason, 'sentinel_missing');
  })
));
test('H: partial LATER sync (new manifest written, final sentinel fails) -> next plan BLOCKS on integrity mismatch', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    const plan2 = await planObsidianSync(target, [focusEvent(), focusEventDay2()]);
    // writeFile order for plan2: newDaily.tmp, manifest.tmp, sentinel.tmp -> fail the 3rd.
    const { adapter } = proxyFs((_b, calls) => ({
      async writeFile(p, c, e) {
        calls.writeFile++;
        if (calls.writeFile === 3) throw Object.assign(new Error('sentinel write failed'), { code: 'EIO' });
        return fs.writeFile(p, c, e);
      }
    }));
    await assert.rejects(() => applyObsidianSync(plan2, { mode: 'test', apply: true }, { fs: adapter }), e => e.code === 'partial_apply_failure');
    const next = await planObsidianSync(target, [focusEvent(), focusEventDay2()]);
    assert.equal(next.blocked, true);
    assert.equal(next.blockReason, 'manifest_integrity_mismatch');
  })
));
test('I: sentinel changed independently (even just appended prose) -> BLOCK (sentinel_content_mismatch)', async () => (
  withTempVault(async vault => {
    await firstApply(vault);
    const sPath = path.join(vault, ...OBSIDIAN_SENTINEL_RELATIVE_PATH.split('/'));
    await fs.writeFile(sPath, `${await fs.readFile(sPath, 'utf8')}\nsomeone appended this\n`, 'utf8');
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockReason, 'sentinel_content_mismatch');
  })
));

// ===========================================================================
// File baseline rules — review tests J-M
// ===========================================================================

test('J: trusted baseline == disk, generated content differs -> UPDATE allowed', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    const plan = await planObsidianSync(target, [focusEvent({ payload: { ...focusEvent().payload, activity: 'Renamed focus' } })]);
    const op = plan.operations.find(o => o.relativePath === DAILY_2026_08_30);
    assert.equal(op.op, OP.UPDATE);
    assert.equal(op.reason, 'content_drift');
    assert.equal(plan.blocked, false);
    await applyObsidianSync(plan, { mode: 'test', apply: true });
    assert.ok((await readVault(vault, DAILY_2026_08_30)).includes('Renamed focus'));
  })
));
test('K: trusted baseline != disk (human edit) -> human_modified_owned_file CONFLICT, never overwritten', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    const dailyAbs = path.join(vault, ...DAILY_2026_08_30.split('/'));
    const edited = `${await fs.readFile(dailyAbs, 'utf8')}\n## human section\n`;
    await fs.writeFile(dailyAbs, edited, 'utf8');
    const plan = await planObsidianSync(target, [focusEvent({ payload: { ...focusEvent().payload, activity: 'x' } })]);
    const op = plan.operations.find(o => o.relativePath === DAILY_2026_08_30);
    assert.equal(op.op, OP.CONFLICT);
    assert.equal(op.reason, 'human_modified_owned_file');
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }), e => e.code === 'plan_blocked');
    assert.equal(await fs.readFile(dailyAbs, 'utf8'), edited);
  })
));
test('L: existing differing generated-path file with no baseline entry -> missing_manifest_baseline CONFLICT', async () => (
  withTempVault(async vault => {
    await firstApply(vault, [focusEvent()]);
    await fs.writeFile(path.join(vault, 'Life Ledger', 'Daily', '2026-08-31.md'), `${OBSIDIAN_LIFE_LEDGER_SENTINEL}\ndiffers\n`, 'utf8');
    const plan = await planObsidianSync(testTarget(vault), [focusEvent(), focusEventDay2()]);
    const op = plan.operations.find(o => o.relativePath === 'Life Ledger/Daily/2026-08-31.md');
    assert.equal(op.op, OP.CONFLICT);
    assert.equal(op.reason, 'missing_manifest_baseline');
  })
));
test('M: existing generated file byte-identical to desired content, no baseline -> UNCHANGED (no mutation), baseline established on apply', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    // Get the exact generated bytes for the Daily file from a throwaway plan.
    const probe = await planObsidianSync(target, [focusEvent()]);
    const dailyBytes = probe.operations.find(o => o.relativePath === DAILY_2026_08_30).content;
    await applyObsidianSync(probe, { mode: 'test', apply: true });
    // Wipe manifest+sentinel so the root is no longer "owned" but the identical Daily file stays.
    await fs.rm(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH));
    await fs.rm(path.join(vault, OBSIDIAN_SENTINEL_RELATIVE_PATH));
    assert.equal(await readVault(vault, DAILY_2026_08_30), dailyBytes);
    const plan = await planObsidianSync(target, [focusEvent()]);
    // Root is unowned (sentinel gone) -> whole plan blocks. This is the fail-closed choice.
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockState, 'unmanaged_conflict');
  })
));

// ===========================================================================
// Manifest identity / allowlist — review tests N-Q
// ===========================================================================

async function ownedVaultWithManifestFiles(vault, files) {
  await firstApply(vault);
  const manifestContent = `${JSON.stringify({ schemaVersion: OBSIDIAN_SYNC_SCHEMA_VERSION, owner: 'chronasense-life-ledger', managedRoot: 'Life Ledger', files }, null, 2)}\n`;
  await fs.writeFile(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH), manifestContent, 'utf8');
  // Re-bind the sentinel to the new manifest bytes so we test the manifest allowlist, not the binding.
  const sPath = path.join(vault, ...OBSIDIAN_SENTINEL_RELATIVE_PATH.split('/'));
  const rebound = (await fs.readFile(sPath, 'utf8')).replace(/manifestSha256: [0-9a-f]{64}/, `manifestSha256: ${sha256(manifestContent)}`);
  await fs.writeFile(sPath, rebound, 'utf8');
}

test('N: case-only duplicate manifest entries -> manifest rejected -> BLOCK', async () => (
  withTempVault(async vault => {
    await ownedVaultWithManifestFiles(vault, [
      { relativePath: 'Life Ledger/System/README.md', sha256: 'a'.repeat(64) },
      { relativePath: 'Life Ledger/System/readme.md', sha256: 'b'.repeat(64) }
    ]);
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockState, 'invalid_sentinel');
  })
));
test('O: slash-vs-backslash duplicate manifest entry -> manifest rejected -> BLOCK', async () => (
  withTempVault(async vault => {
    await ownedVaultWithManifestFiles(vault, [
      { relativePath: 'Life Ledger/System/README.md', sha256: 'a'.repeat(64) },
      { relativePath: 'Life Ledger\\System\\README.md', sha256: 'b'.repeat(64) }
    ]);
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
  })
));
test('P: manifest lists an unknown (non-generated) path -> rejected -> BLOCK', async () => (
  withTempVault(async vault => {
    await ownedVaultWithManifestFiles(vault, [{ relativePath: 'Life Ledger/System/secrets.md', sha256: 'a'.repeat(64) }]);
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockReason, 'manifest_unknown_path');
  })
));
test('Q: manifest lists an absolute or traversal path -> rejected -> BLOCK', async () => {
  await withTempVault(async vault => {
    await ownedVaultWithManifestFiles(vault, [{ relativePath: 'C:\\Windows\\System32\\evil.md', sha256: 'a'.repeat(64) }]);
    assert.equal((await planObsidianSync(testTarget(vault), [focusEvent()])).blocked, true);
  });
  await withTempVault(async vault => {
    await ownedVaultWithManifestFiles(vault, [{ relativePath: 'Life Ledger/../../escape.md', sha256: 'a'.repeat(64) }]);
    assert.equal((await planObsidianSync(testTarget(vault), [focusEvent()])).blocked, true);
  });
});

// ===========================================================================
// TOCTOU — review tests R-T
// ===========================================================================

test('R: an UNCHANGED file that changes between plan and apply -> precondition_changed, zero writes', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    // Plan a change to day-2 only; day-1 (2026-08-30) is UNCHANGED in this plan.
    const plan = await planObsidianSync(target, [focusEvent(), focusEventDay2()]);
    assert.equal(plan.operations.find(o => o.relativePath === DAILY_2026_08_30).op, OP.UNCHANGED);
    // A human edits the UNCHANGED day-1 file after planning.
    const d1 = path.join(vault, ...DAILY_2026_08_30.split('/'));
    await fs.writeFile(d1, `${await fs.readFile(d1, 'utf8')}\nlate edit\n`, 'utf8');
    const { adapter, calls } = proxyFs(() => ({}));
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }, { fs: adapter }), e => e.code === 'precondition_changed');
    assert.equal(calls.writeFile, 0);
    assert.equal(calls.rename, 0);
  })
));
test('S: a junction inserted at a managed parent between plan and apply is caught, with zero content written', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const plan = await planObsidianSync(target, [focusEvent()]);
    // Probe symlink privilege; skip cleanly if unavailable rather than false-pass.
    const linkProbe = path.join(vault, '.linkprobe');
    let privileged = true;
    try {
      await fs.symlink(os.tmpdir(), linkProbe, 'junction');
      await fs.rm(linkProbe, { recursive: true, force: true });
    } catch {
      privileged = false;
    }
    if (!privileged) return;
    // Between plan and apply, someone replaces Life Ledger/System with a junction out of the vault.
    await fs.mkdir(path.join(vault, 'Life Ledger'), { recursive: true });
    await fs.symlink(os.tmpdir(), path.join(vault, 'Life Ledger', 'System'), 'junction');
    const { adapter, calls } = proxyFs(() => ({}));
    await assert.rejects(
      () => applyObsidianSync(plan, { mode: 'test', apply: true }, { fs: adapter }),
      e => e.code === 'link_escape' || e.code === 'path_escape'
    );
    assert.equal(calls.writeFile, 0);
  })
));
test('T: a plan whose operation content no longer hashes to contentSha256 -> invalid_plan_content, zero further writes', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const plan = await planObsidianSync(target, [focusEvent()]);
    // Rebuild a tampered plan: same shape, but one op's content is swapped without fixing the hash.
    const ops = plan.operations.map(op => (
      op.relativePath === OBSIDIAN_SYSTEM_README_RELATIVE_PATH ? { ...op, content: `${op.content}\ntampered\n` } : op
    ));
    const tampered = Object.freeze({ ...plan, operations: Object.freeze(ops.map(o => Object.freeze(o))) });
    const { adapter } = proxyFs(() => ({}));
    await assert.rejects(() => applyObsidianSync(tampered, { mode: 'test', apply: true }, { fs: adapter }), e => e.code === 'invalid_plan_content');
  })
));

// ===========================================================================
// Apply order / phases
// ===========================================================================

test('apply writes content first, then manifest, then sentinel LAST (explicit phases, not filename sort)', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const plan = await planObsidianSync(target, [focusEvent()]);
    const renamedInOrder = [];
    const { adapter } = proxyFs((_b, calls) => ({
      async rename(from, to) {
        calls.rename++;
        renamedInOrder.push(String(to).replace(vault, '').replace(/\\/g, '/').replace(/^\//, ''));
        return fs.rename(from, to);
      }
    }));
    await applyObsidianSync(plan, { mode: 'test', apply: true }, { fs: adapter });
    const manifestIdx = renamedInOrder.indexOf(OBSIDIAN_MANIFEST_RELATIVE_PATH);
    const sentinelIdx = renamedInOrder.indexOf(OBSIDIAN_SENTINEL_RELATIVE_PATH);
    const contentIdxs = renamedInOrder
      .map((p, i) => (p === DAILY_2026_08_30 || p === OBSIDIAN_SYSTEM_README_RELATIVE_PATH ? i : -1))
      .filter(i => i >= 0);
    assert.ok(contentIdxs.every(i => i < manifestIdx), 'all content before manifest');
    assert.ok(manifestIdx < sentinelIdx, 'manifest before sentinel');
    assert.equal(sentinelIdx, renamedInOrder.length - 1, 'sentinel is last');
  })
));
test('plan operations carry an explicit phase (content 0, manifest 1, sentinel 2)', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.operations.find(o => o.relativePath === OBSIDIAN_MANIFEST_RELATIVE_PATH).phase, 1);
    assert.equal(plan.operations.find(o => o.relativePath === OBSIDIAN_SENTINEL_RELATIVE_PATH).phase, 2);
    assert.equal(plan.operations.find(o => o.relativePath === DAILY_2026_08_30).phase, 0);
  })
));

// ===========================================================================
// Sentinel <-> manifest binding
// ===========================================================================

test('a fresh apply writes a schema-v2 sentinel whose manifestSha256 equals the manifest bytes; manifest lists only content files', async () => (
  withTempVault(async vault => {
    await firstApply(vault, [focusEvent(), focusEventDay2()]);
    const sentinel = await readVault(vault, OBSIDIAN_SENTINEL_RELATIVE_PATH);
    const manifestBytes = await readVault(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH);
    assert.ok(sentinel.includes(`schemaVersion: ${OBSIDIAN_SYNC_SCHEMA_VERSION}`));
    assert.ok(sentinel.includes(`manifestSha256: ${sha256(manifestBytes)}`));
    const manifest = JSON.parse(manifestBytes);
    const listed = manifest.files.map(f => f.relativePath).sort();
    assert.deepEqual(listed, ['Life Ledger/Daily/2026-08-30.md', 'Life Ledger/Daily/2026-08-31.md', 'Life Ledger/System/README.md']);
    for (const f of manifest.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  })
));
test('second plan on a cleanly-owned vault is fully UNCHANGED (idempotent, no timestamp churn)', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const { adapter, calls } = proxyFs(() => ({}));
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()], { fs: adapter }), { mode: 'test', apply: true }, { fs: adapter });
    const before = calls.writeFile;
    const plan2 = await planObsidianSync(target, [focusEvent()], { fs: adapter });
    assert.ok(plan2.operations.every(op => op.op === OP.UNCHANGED));
    await applyObsidianSync(plan2, { mode: 'test', apply: true }, { fs: adapter });
    assert.equal(calls.writeFile, before);
  })
));
test('deterministic plan: same snapshot twice -> identical fingerprint and identical content hashes', async () => (
  withTempVault(async vault => {
    const p1 = await planObsidianSync(testTarget(vault), [focusEvent()]);
    const p2 = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(p1.planFingerprint, p2.planFingerprint);
    assert.deepEqual(p1.operations.map(o => o.contentSha256), p2.operations.map(o => o.contentSha256));
  })
));

// ===========================================================================
// No deletion by absence
// ===========================================================================

test('a Daily file absent from a later snapshot is STALE, retained in the new manifest, never deleted', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent(), focusEventDay2()]), { mode: 'test', apply: true });
    const plan = await planObsidianSync(target, [focusEvent()]); // day-2 events gone
    const staleOp = plan.operations.find(o => o.relativePath === 'Life Ledger/Daily/2026-08-31.md');
    assert.equal(staleOp.op, OP.STALE);
    assert.equal(plan.blocked, false);
    await applyObsidianSync(plan, { mode: 'test', apply: true });
    assert.equal(await exists(path.join(vault, 'Life Ledger', 'Daily', '2026-08-31.md')), true);
    // still owned next run
    const plan3 = await planObsidianSync(target, [focusEvent()]);
    assert.ok(plan3.operations.every(op => op.op === OP.UNCHANGED || op.op === OP.STALE));
    assert.equal(plan3.blocked, false);
  })
));

// ===========================================================================
// Windows path hardening (Fix 12)
// ===========================================================================

test('manifest entries with a colon, trailing dot/space, or reserved device name are rejected', async () => {
  for (const bad of ['Life Ledger/Daily/2026-08-30.md:stream', 'Life Ledger/Daily/2026-08-30.md ', 'Life Ledger/System/CON.md', 'Life Ledger/Daily/trailingdot.']) {
    await withTempVault(async vault => {
      await ownedVaultWithManifestFiles(vault, [{ relativePath: bad, sha256: 'a'.repeat(64) }]);
      assert.equal((await planObsidianSync(testTarget(vault), [focusEvent()])).blocked, true, `expected block for ${bad}`);
    });
  }
});

// ===========================================================================
// Rollback artifact (Fix 11)
// ===========================================================================

test('prepareObsidianRollbackArtifact refuses a backupRoot inside the vault', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(prodTarget(vault), [focusEvent()], { expectedCanonicalVaultPath: vault });
    await assert.rejects(
      () => prepareObsidianRollbackArtifact({ target: prodTarget(vault), plan, backupRoot: path.join(vault, 'backup') }),
      e => e.code === 'backup_root_inside_vault'
    );
  })
));
test('first-run rollback receipt proves the absent pre-state, binds to target+plan, and rejects tampering', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const target = prodTarget(vault);
      const plan = await planObsidianSync(target, [focusEvent()], { expectedCanonicalVaultPath: vault });
      const receipt = await prepareObsidianRollbackArtifact({ target, plan, backupRoot });
      assert.equal(receipt.managedRootExistedBefore, false);
      assert.equal(await verifyObsidianRollbackReceipt(receipt, { target, plan }), true);
      // tampered fingerprint / wrong vault / wrong plan all fail
      assert.equal(await verifyObsidianRollbackReceipt({ ...receipt, planFingerprint: 'x' }, { target, plan }), false);
      assert.equal(await verifyObsidianRollbackReceipt({ ...receipt, canonicalVaultRoot: 'C:\\other' }, { target, plan }), false);
      // a receipt file edited on disk fails
      await fs.appendFile(receipt.receiptPath, ' ', 'utf8');
      assert.equal(await verifyObsidianRollbackReceipt(receipt, { target, plan }), false);
    })
  ))
));
test('first-run receipt becomes invalid once the managed root exists (pre-state no longer holds)', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const target = prodTarget(vault);
      const plan = await planObsidianSync(target, [focusEvent()], { expectedCanonicalVaultPath: vault });
      const receipt = await prepareObsidianRollbackArtifact({ target, plan, backupRoot });
      await firstApply(vault); // managed root now exists
      assert.equal(await verifyObsidianRollbackReceipt(receipt, { target, plan }), false);
    })
  ))
));
test('existing-root rollback artifact copies ONLY the managed subtree, verifies bytes, and invalidates on mutation', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const target = prodTarget(vault);
      await applyObsidianSync(await planObsidianSync(testTarget(vault), [focusEvent()]), { mode: 'test', apply: true });
      // an unrelated file OUTSIDE Life Ledger must not be copied
      await fs.writeFile(path.join(vault, 'unrelated-note.md'), 'private\n', 'utf8');
      const plan = await planObsidianSync(target, [focusEvent()], { expectedCanonicalVaultPath: vault });
      assert.equal(plan.isFirstRun, false);
      const receipt = await prepareObsidianRollbackArtifact({ target, plan, backupRoot });
      assert.equal(await exists(path.join(backupRoot, 'backup', 'Life Ledger', 'System', 'manifest.json')), true);
      assert.equal(await exists(path.join(backupRoot, 'backup', 'unrelated-note.md')), false);
      assert.equal(await verifyObsidianRollbackReceipt(receipt, { target, plan }), true);
      // mutate a backed-up byte -> receipt invalid
      await fs.appendFile(path.join(backupRoot, 'backup', 'Life Ledger', 'System', 'manifest.json'), ' ', 'utf8');
      assert.equal(await verifyObsidianRollbackReceipt(receipt, { target, plan }), false);
    })
  ))
));
test('prepareObsidianRollbackArtifact never silently overwrites an existing artifact', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const target = prodTarget(vault);
      const plan = await planObsidianSync(target, [focusEvent()], { expectedCanonicalVaultPath: vault });
      await prepareObsidianRollbackArtifact({ target, plan, backupRoot });
      await assert.rejects(() => prepareObsidianRollbackArtifact({ target, plan, backupRoot }), e => e.code === 'backup_artifact_exists');
    })
  ))
));

// ===========================================================================
// Production authorization — hard-blocked this pass
// ===========================================================================

test('OBSIDIAN_PRODUCTION_SYNC_ENABLED is false and schema version is 2', () => {
  assert.equal(OBSIDIAN_PRODUCTION_SYNC_ENABLED, false);
  assert.equal(OBSIDIAN_SYNC_SCHEMA_VERSION, 2);
});
test('production apply is hard-blocked via applyObsidianSync even with a perfect authorization + valid receipt', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const target = prodTarget(vault);
      const plan = await planObsidianSync(target, [focusEvent()], { expectedCanonicalVaultPath: vault });
      const receipt = await prepareObsidianRollbackArtifact({ target, plan, backupRoot });
      await assert.rejects(
        () => applyObsidianSync(plan, {
          mode: 'production', allowApply: true, apply: true,
          expectedCanonicalVaultPath: vault,
          firstRunAck: `FIRST-RUN-CONFIRMED:${plan.canonicalVaultRoot}`,
          rollbackReceipt: receipt
        }),
        e => e.code === 'production_sync_disabled'
      );
      assert.equal(await exists(path.join(vault, 'Life Ledger')), false);
    })
  ))
));
test('evaluateProductionAuthorization (enabled override): requires a verified rollback receipt, then the first-run token', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(prodTarget(vault), [focusEvent()], { expectedCanonicalVaultPath: vault });
    const base = { mode: 'production', allowApply: true, apply: true, expectedCanonicalVaultPath: vault };
    assert.equal(evaluateProductionAuthorization(plan, base, { enabled: true }).code, 'rollback_receipt_unverified');
    assert.equal(evaluateProductionAuthorization(plan, base, { enabled: true, rollbackReceiptValid: true }).code, 'first_run_not_acknowledged');
    assert.deepEqual(
      evaluateProductionAuthorization(plan, { ...base, firstRunAck: `FIRST-RUN-CONFIRMED:${plan.canonicalVaultRoot}` }, { enabled: true, rollbackReceiptValid: true }),
      { ok: true }
    );
    // still disabled by default
    assert.equal(evaluateProductionAuthorization(plan, base).code, 'production_sync_disabled');
  })
));
test('test-mode apply still requires the TEST-VAULT.md marker and an explicit apply flag', async () => {
  await withTempVault(async vault => {
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }), e => e.code === 'test_not_authorized');
  }, { testVaultMarker: false });
  await withTempVault(async vault => {
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test' }), e => e.code === 'test_not_authorized');
  });
});

// ===========================================================================
// Partial-failure honesty
// ===========================================================================

test('a mid-apply write failure reports an explicit partial result naming what was written', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    const { adapter } = proxyFs((_b, calls) => ({
      async writeFile(p, c, e) {
        calls.writeFile++;
        if (calls.writeFile === 2) throw Object.assign(new Error('boom'), { code: 'EIO' });
        return fs.writeFile(p, c, e);
      }
    }));
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }, { fs: adapter }), e => {
      assert.equal(e.code, 'partial_apply_failure');
      assert.ok(Array.isArray(e.written) && e.written.length === 1);
      assert.ok(e.failedRelativePath);
      return true;
    });
  })
));

// ===========================================================================
// Preview
// ===========================================================================

test('formatObsidianSyncPreview never leaks an absolute path and names the block reason', async () => {
  await withTempVault(async vault => {
    const preview = formatObsidianSyncPreview(await planObsidianSync(testTarget(vault), [focusEvent()]));
    assert.ok(preview.includes('CREATE'));
    assert.ok(!preview.includes(vault));
  });
  await withTempVault(async vault => {
    await fs.mkdir(path.join(vault, 'Life Ledger'), { recursive: true });
    const preview = formatObsidianSyncPreview(await planObsidianSync(testTarget(vault), [focusEvent()]));
    assert.ok(preview.includes('BLOCKED'));
    assert.ok(preview.includes('sentinel_missing'));
  });
});

// ===========================================================================
// Dry run
// ===========================================================================

test('planObsidianSync never writes, even against an already-owned vault', async () => (
  withTempVault(async vault => {
    await firstApply(vault);
    const { adapter, calls } = proxyFs(() => ({}));
    await planObsidianSync(testTarget(vault), [focusEvent()], { fs: adapter });
    assert.equal(calls.writeFile, 0);
    assert.equal(calls.rename, 0);
    assert.equal(calls.unlink, 0);
  })
));

// ===========================================================================
// CLI
// ===========================================================================

async function withTempSnapshotFile(events, fn) {
  return withTempDir('chronasense-obsidian-sync-cli-', async root => {
    const filePath = path.join(root, 'snapshot.json');
    await fs.writeFile(filePath, serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents(events)), 'utf8');
    return fn(filePath, root);
  });
}

test('CLI requires an explicit --mode and rejects unknown modes / duplicate flags / unknown flags', async () => {
  await assert.rejects(() => runLifeLedgerObsidianSync(['--input', 'a.json', '--vault', 'C:\\V']), e => e.code === 'missing_mode');
  await assert.rejects(() => runLifeLedgerObsidianSync(['--input', 'a.json', '--vault', 'C:\\V', '--mode', 'staging']), e => e.code === 'missing_mode');
  await assert.rejects(() => runLifeLedgerObsidianSync(['--input', 'a.json', '--vault', 'C:\\V', '--mode', 'test', '--mode', 'test']), e => e.code === 'duplicate_mode');
  await assert.rejects(() => runLifeLedgerObsidianSync(['--input', 'a.json', '--vault', 'C:\\V', '--mode', 'test', '--surprise']), e => e.code === 'unknown_arg');
});
test('CLI defaults to a dry run (no --apply) and performs zero writes', async () => (
  withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      const result = await runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'test']);
      assert.equal(result.applyResult, null);
      assert.equal(result.plan.blocked, false);
      assert.equal(await exists(path.join(vault, 'Life Ledger')), false);
    })
  ))
));
test('CLI test-mode --apply requires TEST-VAULT.md; with it, it writes and is idempotent', async () => {
  await withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      await assert.rejects(() => runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'test', '--apply']), e => e.code === 'test_not_authorized');
    }, { testVaultMarker: false })
  ));
  await withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      const first = await runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'test', '--apply']);
      assert.equal(first.applyResult.applied, true);
      assert.ok(first.applyResult.written.length > 0);
      const second = await runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'test', '--apply']);
      assert.equal(second.applyResult.written.length, 0);
    })
  ));
});
test('CLI production --apply is blocked at plan time without --expected-vault, and hard-blocked with every flag set', async () => {
  await withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      await assert.rejects(
        () => runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'production', '--apply']),
        e => e.code === 'plan_blocked'
      );
    })
  ));
  await withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      await assert.rejects(
        () => runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'production', '--apply', '--expected-vault', vault, '--first-run-ack', `FIRST-RUN-CONFIRMED:${vault}`]),
        e => e.code === 'production_sync_disabled'
      );
      assert.equal(await exists(path.join(vault, 'Life Ledger')), false);
    })
  ));
});

// ===========================================================================
// ObsidianSyncError sanity
// ===========================================================================

test('ObsidianSyncError carries a stable code and name', () => {
  const err = new ObsidianSyncError('some_code', 'message', { extra: 1 });
  assert.equal(err.name, 'ObsidianSyncError');
  assert.equal(err.code, 'some_code');
  assert.equal(err.extra, 1);
});

// ===========================================================================
// Phase 9B hardening — FIX 1: first-run receipt MUST bind backup === null
// ===========================================================================

async function firstRunReceipt(vault, backupRoot, events = [focusEvent()]) {
  const target = prodTarget(vault);
  const plan = await planObsidianSync(target, events, { expectedCanonicalVaultPath: vault });
  const receipt = await prepareObsidianRollbackArtifact({ target, plan, backupRoot });
  return { target, plan, receipt };
}

test('FIX 1 — first-run valid receipt with backup:null verifies true', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const { target, plan, receipt } = await firstRunReceipt(vault, backupRoot);
      assert.equal(receipt.managedRootExistedBefore, false);
      assert.equal(receipt.backup, null);
      assert.equal(await verifyObsidianRollbackReceipt(receipt, { target, plan }), true);
    })
  ))
));

test('FIX 1 — first-run receipt with backup:{...} verifies false', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const { target, plan, receipt } = await firstRunReceipt(vault, backupRoot);
      const tampered = { ...receipt, backup: { backupArtifactPath: 'C:\\x', files: [], backupManifestSha256: 'a'.repeat(64) } };
      assert.equal(await verifyObsidianRollbackReceipt(tampered, { target, plan }), false);
    })
  ))
));

test('FIX 1 — first-run receipt with backup:"anything" verifies false', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const { target, plan, receipt } = await firstRunReceipt(vault, backupRoot);
      assert.equal(await verifyObsidianRollbackReceipt({ ...receipt, backup: 'anything' }, { target, plan }), false);
      assert.equal(await verifyObsidianRollbackReceipt({ ...receipt, backup: undefined }, { target, plan }), false);
      assert.equal(await verifyObsidianRollbackReceipt({ ...receipt, backup: {} }, { target, plan }), false);
    })
  ))
));

test('FIX 1 — non-first-run receipt semantics unchanged (real backup verifies, backup:null rejects)', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const target = prodTarget(vault);
      await applyObsidianSync(await planObsidianSync(testTarget(vault), [focusEvent()]), { mode: 'test', apply: true });
      const plan = await planObsidianSync(target, [focusEvent()], { expectedCanonicalVaultPath: vault });
      assert.equal(plan.isFirstRun, false);
      const receipt = await prepareObsidianRollbackArtifact({ target, plan, backupRoot });
      assert.equal(receipt.managedRootExistedBefore, true);
      assert.ok(receipt.backup && typeof receipt.backup === 'object');
      assert.equal(await verifyObsidianRollbackReceipt(receipt, { target, plan }), true);
      // The first-run backup-null rule must NOT leak into the existing-root path.
      assert.equal(await verifyObsidianRollbackReceipt({ ...receipt, backup: null }, { target, plan }), false);
    })
  ))
));

test('FIX 1 — first-run managed root appears after the receipt -> verifies false', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const { target, plan, receipt } = await firstRunReceipt(vault, backupRoot);
      assert.equal(await verifyObsidianRollbackReceipt(receipt, { target, plan }), true);
      await firstApply(vault); // managed root now exists
      assert.equal(await verifyObsidianRollbackReceipt(receipt, { target, plan }), false);
    })
  ))
));

// ===========================================================================
// Phase 9B hardening — FIX 2: safe CLI rollback-receipt loading
// ===========================================================================

test('FIX 2 — loader reads real bytes, computes SHA-256, attaches receiptPath/receiptSha256, never mutates the file', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const { target, plan, receipt } = await firstRunReceipt(vault, backupRoot);
      const diskBefore = await fs.readFile(receipt.receiptPath);
      const persisted = JSON.parse(diskBefore.toString('utf8'));
      assert.equal('receiptPath' in persisted, false);
      assert.equal('receiptSha256' in persisted, false);

      const loaded = await loadRollbackReceiptFromDisk(receipt.receiptPath, fs);
      assert.equal(loaded.receiptPath, path.resolve(receipt.receiptPath));
      assert.equal(loaded.receiptSha256, sha256(diskBefore.toString('utf8')));
      assert.equal(loaded.receiptSha256, receipt.receiptSha256);
      assert.equal(loaded.planFingerprint, receipt.planFingerprint);

      const diskAfter = await fs.readFile(receipt.receiptPath);
      assert.ok(diskBefore.equals(diskAfter), 'receipt file bytes unchanged by the loader');

      assert.equal(await verifyObsidianRollbackReceipt(loaded, { target, plan }), true);
    })
  ))
));

test('FIX 2 — a receipt whose disk bytes change AFTER loading is rejected against the prior runtime metadata', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const { target, plan, receipt } = await firstRunReceipt(vault, backupRoot);
      const loaded = await loadRollbackReceiptFromDisk(receipt.receiptPath, fs);
      assert.equal(await verifyObsidianRollbackReceipt(loaded, { target, plan }), true);
      await fs.appendFile(receipt.receiptPath, ' ', 'utf8'); // one trailing byte
      assert.equal(await verifyObsidianRollbackReceipt(loaded, { target, plan }), false);
    })
  ))
));

test('FIX 2 — a modified receipt reloaded fresh still fails the semantic/plan binding', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const { target, plan, receipt } = await firstRunReceipt(vault, backupRoot);
      // Rewrite the receipt file with a bogus planFingerprint, then reload it so its
      // receiptSha256 matches the NEW disk bytes (the on-disk hash gate passes)...
      const body = JSON.parse(await fs.readFile(receipt.receiptPath, 'utf8'));
      body.planFingerprint = 'deadbeef'.repeat(8);
      await fs.writeFile(receipt.receiptPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      const reloaded = await loadRollbackReceiptFromDisk(receipt.receiptPath, fs);
      // ...but the plan-fingerprint binding still rejects it.
      assert.equal(await verifyObsidianRollbackReceipt(reloaded, { target, plan }), false);
    })
  ))
));

test('FIX 2 — loader fails closed on a missing receipt file', async () => {
  await assert.rejects(
    () => loadRollbackReceiptFromDisk(path.join(os.tmpdir(), 'definitely-not-here-9b.json'), fs),
    e => e.code === 'rollback_receipt_unreadable'
  );
});

test('FIX 2 — loader fails closed on invalid JSON and on non-object JSON', async () => (
  withTempDir('chronasense-obsidian-receipt-', async dir => {
    const bad = path.join(dir, 'bad.json');
    await fs.writeFile(bad, '{ not valid json ', 'utf8');
    await assert.rejects(() => loadRollbackReceiptFromDisk(bad, fs), e => e.code === 'rollback_receipt_invalid_json');
    const arr = path.join(dir, 'arr.json');
    await fs.writeFile(arr, '[1,2,3]', 'utf8');
    await assert.rejects(() => loadRollbackReceiptFromDisk(arr, fs), e => e.code === 'rollback_receipt_malformed');
  })
));

test('FIX 2 — loaded receipt with a planFingerprint mismatch fails closed in verification', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const { target, plan } = await firstRunReceipt(vault, backupRoot);
      const otherDir = path.join(backupRoot, 'other');
      await fs.mkdir(otherDir, { recursive: true });
      const rogue = path.join(otherDir, 'obsidian-rollback-receipt.json');
      await fs.writeFile(rogue, `${JSON.stringify({
        kind: 'obsidian-rollback-receipt', schemaVersion: OBSIDIAN_SYNC_SCHEMA_VERSION,
        canonicalVaultRoot: plan.canonicalVaultRoot, canonicalManagedRoot: plan.canonicalManagedRoot,
        managedRoot: 'Life Ledger', managedRootExistedBefore: false,
        planFingerprint: 'f'.repeat(64), backup: null
      }, null, 2)}\n`, 'utf8');
      const loaded = await loadRollbackReceiptFromDisk(rogue, fs);
      assert.equal(await verifyObsidianRollbackReceipt(loaded, { target, plan }), false);
    })
  ))
));

test('FIX 2 — loaded receipt with a canonical-vault mismatch fails closed in verification', async () => (
  withTempVault(async vault => (
    withTempDir('chronasense-obsidian-backup-', async backupRoot => {
      const { target, plan } = await firstRunReceipt(vault, backupRoot);
      const rogue = path.join(backupRoot, 'wrong-vault-receipt.json');
      await fs.writeFile(rogue, `${JSON.stringify({
        kind: 'obsidian-rollback-receipt', schemaVersion: OBSIDIAN_SYNC_SCHEMA_VERSION,
        canonicalVaultRoot: 'C:\\Users\\Admin\\Somewhere\\Else', canonicalManagedRoot: 'C:\\Users\\Admin\\Somewhere\\Else\\Life Ledger',
        managedRoot: 'Life Ledger', managedRootExistedBefore: false,
        planFingerprint: plan.planFingerprint, backup: null
      }, null, 2)}\n`, 'utf8');
      const loaded = await loadRollbackReceiptFromDisk(rogue, fs);
      assert.equal(await verifyObsidianRollbackReceipt(loaded, { target, plan }), false);
    })
  ))
));

test('FIX 2 — CLI production --apply with a real receipt path stays hard-blocked and never rewrites the receipt', async () => (
  withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => (
      withTempDir('chronasense-obsidian-backup-', async backupRoot => {
        const target = prodTarget(vault);
        const plan = await planObsidianSync(target, [focusEvent()], { expectedCanonicalVaultPath: vault });
        const receipt = await prepareObsidianRollbackArtifact({ target, plan, backupRoot });
        const before = await fs.readFile(receipt.receiptPath);
        await assert.rejects(
          () => runLifeLedgerObsidianSync([
            '--input', input, '--vault', vault, '--mode', 'production', '--apply',
            '--expected-vault', vault, '--first-run-ack', `FIRST-RUN-CONFIRMED:${vault}`,
            '--rollback-receipt', receipt.receiptPath
          ]),
          e => e.code === 'production_sync_disabled'
        );
        assert.ok(before.equals(await fs.readFile(receipt.receiptPath)), 'receipt file untouched by the CLI');
        assert.equal(await exists(path.join(vault, 'Life Ledger')), false);
      })
    ))
  ))
));
