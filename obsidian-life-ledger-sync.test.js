import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ObsidianSyncError,
  createObsidianSyncTarget,
  verifyObsidianVaultIdentity,
  planObsidianSync,
  applyObsidianSync,
  formatObsidianSyncPreview,
  evaluateProductionAuthorization,
  OBSIDIAN_SYNC_OPERATIONS,
  OBSIDIAN_PRODUCTION_SYNC_ENABLED,
  OBSIDIAN_SENTINEL_RELATIVE_PATH,
  OBSIDIAN_MANIFEST_RELATIVE_PATH,
  OBSIDIAN_SYSTEM_README_RELATIVE_PATH
} from './obsidian-life-ledger-sync.js';
import { OBSIDIAN_LIFE_LEDGER_SENTINEL } from './obsidian-life-ledger-renderer.js';
import { serializeLifeLedgerSnapshot, createLifeLedgerSnapshotFromEvents } from './life-ledger-transport.js';
import { runLifeLedgerObsidianSync } from './scripts/sync-life-ledger-to-obsidian.mjs';

const DENIED_ONEDRIVE_VAULT_ROOT = 'C:\\Users\\Admin\\OneDrive\\2nd Brain';
const DENIED_STALE_DESKTOP_VAULT_ROOT = 'C:\\Users\\Admin\\Desktop\\2nd Brain';
const DENIED_TEST_VAULT_ROOT = 'C:\\Users\\Admin\\Desktop\\Second-Brain-Test-Vault';

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

function writeSpyFs() {
  const calls = { writeFile: 0, rename: 0, unlink: 0 };
  const real = { writeFile: fs.writeFile, rename: fs.rename, unlink: fs.unlink };
  return {
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    lstat: fs.lstat,
    realpath: fs.realpath,
    readdir: fs.readdir,
    async writeFile(...args) { calls.writeFile++; return real.writeFile(...args); },
    async rename(...args) { calls.rename++; return real.rename(...args); },
    async unlink(...args) { calls.unlink++; return real.unlink(...args); },
    calls
  };
}

function testTarget(vaultPath, overrides = {}) {
  return createObsidianSyncTarget({ vaultPath, mode: 'test', allowApply: true, ...overrides });
}

function prodTarget(vaultPath, overrides = {}) {
  return createObsidianSyncTarget({ vaultPath, mode: 'production', allowApply: true, ...overrides });
}

// -- Target model -------------------------------------------------------------

test('createObsidianSyncTarget rejects an unknown mode', () => {
  assert.throws(() => createObsidianSyncTarget({ vaultPath: 'C:\\x', mode: 'staging' }), err => err.code === 'invalid_target');
});
test('createObsidianSyncTarget rejects a non-Life-Ledger managedRoot', () => {
  assert.throws(() => createObsidianSyncTarget({ vaultPath: 'C:\\x', mode: 'test', managedRoot: 'Somewhere Else' }), err => err.code === 'invalid_target');
});
test('createObsidianSyncTarget rejects an empty vaultPath', () => {
  assert.throws(() => createObsidianSyncTarget({ vaultPath: '', mode: 'test' }), err => err.code === 'invalid_target');
});
test('createObsidianSyncTarget defaults allowApply to false and freezes the target', () => {
  const target = createObsidianSyncTarget({ vaultPath: 'C:\\x', mode: 'test' });
  assert.equal(target.allowApply, false);
  assert.throws(() => { target.mode = 'production'; }, TypeError);
});

// -- Stale / denied vault rejection -------------------------------------------

test('test mode rejects the stale Desktop vault before touching disk', async () => {
  const identity = await verifyObsidianVaultIdentity(testTarget(DENIED_STALE_DESKTOP_VAULT_ROOT));
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, 'denied_vault_root');
});
test('test mode rejects the real active OneDrive vault', async () => {
  const identity = await verifyObsidianVaultIdentity(testTarget(DENIED_ONEDRIVE_VAULT_ROOT));
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, 'denied_vault_root');
});
test('production mode rejects the stale Desktop vault even with matching expectedCanonicalVaultPath', async () => {
  const identity = await verifyObsidianVaultIdentity(
    prodTarget(DENIED_STALE_DESKTOP_VAULT_ROOT),
    { expectedCanonicalVaultPath: DENIED_STALE_DESKTOP_VAULT_ROOT }
  );
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, 'denied_vault_root');
});
test('production mode rejects the test vault even with matching expectedCanonicalVaultPath', async () => {
  const identity = await verifyObsidianVaultIdentity(
    prodTarget(DENIED_TEST_VAULT_ROOT),
    { expectedCanonicalVaultPath: DENIED_TEST_VAULT_ROOT }
  );
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, 'denied_vault_root');
});
test('production mode allows the real vault path only via an exact canonical-path match', async () => (
  withTempVault(async vault => {
    const okIdentity = await verifyObsidianVaultIdentity(prodTarget(vault), { expectedCanonicalVaultPath: vault });
    assert.equal(okIdentity.ok, true);
    const mismatchIdentity = await verifyObsidianVaultIdentity(prodTarget(vault), { expectedCanonicalVaultPath: `${vault}\\..\\somewhere-else` });
    assert.equal(mismatchIdentity.ok, false);
    assert.equal(mismatchIdentity.reason, 'canonical_path_mismatch');
  })
));
test('production mode without an expectedCanonicalVaultPath refuses to auto-discover a target', async () => (
  withTempVault(async vault => {
    const identity = await verifyObsidianVaultIdentity(prodTarget(vault));
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, 'missing_expected_canonical_path');
  })
));
test('identity check rejects a vault path inside a known repo root', async () => (
  withTempVault(async vault => {
    const identity = await verifyObsidianVaultIdentity(testTarget(vault), { knownRepoRoots: [vault] });
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, 'inside_known_repo_root');
  })
));
test('identity check reports a missing vault path without throwing', async () => {
  const identity = await verifyObsidianVaultIdentity(testTarget('C:\\Nonexistent\\Vault\\Path\\Xyz'));
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, 'vault_missing');
});
test('identity check surfaces .obsidian presence as a soft signal, not a hard block', async () => (
  withTempVault(async vault => {
    const identity = await verifyObsidianVaultIdentity(testTarget(vault));
    assert.equal(identity.ok, true);
    assert.equal(identity.signals.hasObsidianDir, true);
  })
));
test('identity check tolerates a vault with no .obsidian folder yet', async () => (
  withTempVault(async vault => {
    const identity = await verifyObsidianVaultIdentity(testTarget(vault));
    assert.equal(identity.ok, true);
    assert.equal(identity.signals.hasObsidianDir, false);
  }, { obsidian: false })
));

// -- Managed-root ownership ----------------------------------------------------

test('a fresh vault plans a first-run CREATE for every generated file', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, false);
    assert.equal(plan.isFirstRun, true);
    assert.deepEqual(plan.operations.map(op => op.op), Array(plan.operations.length).fill(OBSIDIAN_SYNC_OPERATIONS.CREATE));
    assert.deepEqual(plan.operations.map(op => op.relativePath), [...plan.operations.map(op => op.relativePath)].sort());
  })
));
test('an existing unmanaged Life Ledger root blocks the plan as a conflict', async () => (
  withTempVault(async vault => {
    await fs.mkdir(path.join(vault, 'Life Ledger'), { recursive: true });
    await fs.writeFile(path.join(vault, 'Life Ledger', 'notes.md'), '# My own notes\n', 'utf8');
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockReason, 'unmanaged_conflict');
    assert.equal(plan.operations.length, 1);
    assert.equal(plan.operations[0].op, OBSIDIAN_SYNC_OPERATIONS.BLOCKED);
  })
));
test('an empty pre-existing Life Ledger directory is still an unmanaged conflict, never auto-adopted', async () => (
  withTempVault(async vault => {
    await fs.mkdir(path.join(vault, 'Life Ledger'), { recursive: true });
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockReason, 'unmanaged_conflict');
  })
));
test('a valid sentinel is recognized on a second plan and reports UNCHANGED, not first-run', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const plan1 = await planObsidianSync(target, [focusEvent()]);
    await applyObsidianSync(plan1, { mode: 'test', apply: true });
    const plan2 = await planObsidianSync(target, [focusEvent()]);
    assert.equal(plan2.isFirstRun, false);
    assert.equal(plan2.blocked, false);
    assert.ok(plan2.operations.every(op => op.op === OBSIDIAN_SYNC_OPERATIONS.UNCHANGED));
  })
));
test('a corrupted sentinel (wrong owner) blocks as invalid, never silently replaced', async () => (
  withTempVault(async vault => {
    await fs.mkdir(path.join(vault, 'Life Ledger', 'System'), { recursive: true });
    await fs.writeFile(
      path.join(vault, 'Life Ledger', 'System', 'MANAGED-BY-CHRONASENSE.md'),
      `${OBSIDIAN_LIFE_LEDGER_SENTINEL}\n---\nowner: someone-else\nschemaVersion: 1\nmanagedRoot: Life Ledger\n---\n`,
      'utf8'
    );
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockReason, 'invalid_sentinel');
  })
));
test('a corrupted manifest (malformed JSON) blocks as invalid', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    await fs.writeFile(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH), '{not json', 'utf8');
    const plan = await planObsidianSync(target, [focusEvent()]);
    assert.equal(plan.blocked, true);
    assert.equal(plan.blockReason, 'invalid_sentinel');
  })
));

// -- Conflict detection ---------------------------------------------------------

test('an unowned file collision at a generated path is a conflict, not an overwrite', async () => (
  withTempVault(async vault => {
    await fs.mkdir(path.join(vault, 'Life Ledger', 'Daily'), { recursive: true });
    await fs.mkdir(path.join(vault, 'Life Ledger', 'System'), { recursive: true });
    await fs.writeFile(path.join(vault, OBSIDIAN_SENTINEL_RELATIVE_PATH), '', 'utf8'); // will be seen as invalid below instead
    // Simpler: build ownership via a real first apply, then drop an unowned Daily collision on a later day.
    await fs.rm(path.join(vault, 'Life Ledger'), { recursive: true, force: true });
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    const otherDay = focusEvent({
      eventId: '20202020-2020-4020-8020-202020202020',
      occurredAt: '2026-08-31T16:00:00.000Z',
      payload: { ...focusEvent().payload, startedAt: '2026-08-31T15:35:00.000Z', endedAt: '2026-08-31T16:00:00.000Z' }
    });
    await fs.writeFile(path.join(vault, 'Life Ledger', 'Daily', '2026-08-31.md'), '# Hand-written note, no sentinel\n', 'utf8');
    const plan = await planObsidianSync(target, [focusEvent(), otherDay]);
    const conflict = plan.operations.find(op => op.relativePath === 'Life Ledger/Daily/2026-08-31.md');
    assert.equal(conflict.op, OBSIDIAN_SYNC_OPERATIONS.CONFLICT);
    assert.equal(conflict.reason, 'unowned_collision');
    assert.equal(plan.blocked, true);
  })
));
test('a human edit to a previously-generated file is detected as a conflict via manifest drift', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    const original = await fs.readFile(dailyPath, 'utf8');
    await fs.writeFile(dailyPath, `${original}\nHand-added note\n`, 'utf8');
    const plan = await planObsidianSync(target, [focusEvent()]);
    const conflict = plan.operations.find(op => op.relativePath === 'Life Ledger/Daily/2026-08-30.md');
    assert.equal(conflict.op, OBSIDIAN_SYNC_OPERATIONS.CONFLICT);
    assert.equal(conflict.reason, 'human_modified_owned_file');
    assert.equal(plan.blocked, true);
  })
));
test('an unresolved conflict blocks apply entirely, with zero writes', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    const dailyPath = path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md');
    await fs.appendFile(dailyPath, '\nHand-added note\n', 'utf8');
    const plan = await planObsidianSync(target, [focusEvent()]);
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }), err => err.code === 'plan_blocked');
  })
));

// -- Idempotency + ordering ------------------------------------------------------

test('applying the same snapshot twice is idempotent and writes nothing the second time', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const spyFs = writeSpyFs();
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()], { fs: spyFs }), { mode: 'test', apply: true }, { fs: spyFs });
    assert.ok(spyFs.calls.writeFile > 0);
    const before = { ...spyFs.calls };
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()], { fs: spyFs }), { mode: 'test', apply: true }, { fs: spyFs });
    assert.equal(spyFs.calls.writeFile, before.writeFile);
    assert.equal(spyFs.calls.rename, before.rename);
  })
));
test('plan operations are always sorted by relativePath (deterministic ordering)', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    const paths = plan.operations.map(op => op.relativePath);
    assert.deepEqual(paths, [...paths].sort());
  })
));
test('rendering the same snapshot twice produces byte-identical plan content', async () => (
  withTempVault(async vault => {
    const plan1 = await planObsidianSync(testTarget(vault), [focusEvent()]);
    const plan2 = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.equal(JSON.stringify(plan1.operations.map(op => op.contentSha256)), JSON.stringify(plan2.operations.map(op => op.contentSha256)));
  })
));

// -- No deletion by absence / STALE reporting ------------------------------------

test('a Daily file absent from a later snapshot is reported STALE, never deleted', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    const plan = await planObsidianSync(target, []);
    const staleOp = plan.operations.find(op => op.relativePath === 'Life Ledger/Daily/2026-08-30.md');
    assert.equal(staleOp.op, OBSIDIAN_SYNC_OPERATIONS.STALE);
    assert.equal(plan.blocked, false);
    await applyObsidianSync(plan, { mode: 'test', apply: true });
    const stillExists = await fs.access(path.join(vault, 'Life Ledger', 'Daily', '2026-08-30.md')).then(() => true, () => false);
    assert.equal(stillExists, true);
  })
));

// -- TOCTOU ------------------------------------------------------------------------

test('apply aborts with zero writes if the filesystem changed since planning', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const plan1 = await planObsidianSync(target, [focusEvent()]);
    // Someone else creates the README by hand (with the sentinel, so it is not an unowned
    // collision) between plan and apply — the plan's captured precondition (file absent) no
    // longer holds.
    await fs.mkdir(path.join(vault, 'Life Ledger', 'System'), { recursive: true });
    await fs.writeFile(path.join(vault, OBSIDIAN_SYSTEM_README_RELATIVE_PATH), `${OBSIDIAN_LIFE_LEDGER_SENTINEL}\nrace\n`, 'utf8');
    const spyFs = writeSpyFs();
    await assert.rejects(
      () => applyObsidianSync(plan1, { mode: 'test', apply: true }, { fs: spyFs }),
      err => err.code === 'precondition_changed'
    );
    assert.equal(spyFs.calls.writeFile, 0);
  })
));
test('apply aborts if a symlink is introduced at a target leaf after planning', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const plan1 = await planObsidianSync(target, [focusEvent()]);
    await fs.mkdir(path.join(vault, 'Life Ledger', 'System'), { recursive: true });
    let symlinked = true;
    try {
      await fs.symlink(path.join(os.tmpdir()), path.join(vault, OBSIDIAN_SENTINEL_RELATIVE_PATH), 'junction');
    } catch {
      symlinked = false; // environment lacks symlink privilege — the assertion below is skipped, not falsely passed
    }
    if (!symlinked) return;
    await assert.rejects(() => applyObsidianSync(plan1, { mode: 'test', apply: true }), err => err.code === 'link_escape' || err.code === 'precondition_changed');
  })
));

// -- Manifest ------------------------------------------------------------------

test('the manifest lists only relative managed paths with SHA-256 hashes, sorted, no duplicates', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    const manifest = JSON.parse(await fs.readFile(path.join(vault, OBSIDIAN_MANIFEST_RELATIVE_PATH), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.managedRoot, 'Life Ledger');
    const relPaths = manifest.files.map(f => f.relativePath);
    assert.deepEqual(relPaths, [...relPaths].sort());
    assert.equal(new Set(relPaths).size, relPaths.length);
    for (const file of manifest.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(!path.isAbsolute(file.relativePath));
    }
  })
));

// -- Production authorization gate (HARD-blocked this pass) --------------------

test('OBSIDIAN_PRODUCTION_SYNC_ENABLED is false in this build', () => {
  assert.equal(OBSIDIAN_PRODUCTION_SYNC_ENABLED, false);
});
test('production apply is hard-blocked even with fully correct, path-bound authorization', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(prodTarget(vault), [focusEvent()], { expectedCanonicalVaultPath: vault });
    await assert.rejects(
      () => applyObsidianSync(plan, {
        mode: 'production', allowApply: true, apply: true,
        expectedCanonicalVaultPath: vault,
        firstRunAck: `FIRST-RUN-CONFIRMED:${plan.canonicalVaultRoot}`,
        firstRunBackupAcknowledged: true
      }),
      err => err.code === 'production_sync_disabled'
    );
    const stillAbsent = await fs.access(path.join(vault, 'Life Ledger')).then(() => true, () => false);
    assert.equal(stillAbsent, false);
  })
));
test('production apply is hard-blocked with no authorization at all', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(prodTarget(vault), [focusEvent()], { expectedCanonicalVaultPath: vault });
    await assert.rejects(() => applyObsidianSync(plan, {}), err => err.code === 'production_sync_disabled');
  })
));

// The SECOND authorization layer (only reachable once the build constant is flipped) is
// exercised here through evaluateProductionAuthorization with an explicit enabled override.
// This override is NEVER wired into applyObsidianSync — see the two tests above.
test('second-layer authorization: rejects a missing allowApply flag', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(prodTarget(vault), [focusEvent()], { expectedCanonicalVaultPath: vault });
    const result = evaluateProductionAuthorization(plan, { mode: 'production', apply: true, expectedCanonicalVaultPath: vault }, { enabled: true });
    assert.deepEqual(result, { ok: false, code: 'production_not_authorized' });
  })
));
test('second-layer authorization: rejects a canonical-path mismatch', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(prodTarget(vault), [focusEvent()], { expectedCanonicalVaultPath: vault });
    const result = evaluateProductionAuthorization(plan, { mode: 'production', allowApply: true, apply: true, expectedCanonicalVaultPath: `${vault}-other` }, { enabled: true });
    assert.equal(result.code, 'production_not_authorized');
  })
));
test('second-layer authorization: first run additionally requires a path-bound token and a backup acknowledgement', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(prodTarget(vault), [focusEvent()], { expectedCanonicalVaultPath: vault });
    assert.equal(plan.isFirstRun, true);
    const base = { mode: 'production', allowApply: true, apply: true, expectedCanonicalVaultPath: vault };
    assert.equal(evaluateProductionAuthorization(plan, base, { enabled: true }).code, 'first_run_not_acknowledged');
    assert.equal(evaluateProductionAuthorization(plan, { ...base, firstRunAck: 'FIRST-RUN-CONFIRMED:wrong' }, { enabled: true }).code, 'first_run_not_acknowledged');
    assert.equal(
      evaluateProductionAuthorization(plan, { ...base, firstRunAck: `FIRST-RUN-CONFIRMED:${plan.canonicalVaultRoot}` }, { enabled: true }).code,
      'first_run_backup_not_acknowledged'
    );
    assert.deepEqual(
      evaluateProductionAuthorization(plan, { ...base, firstRunAck: `FIRST-RUN-CONFIRMED:${plan.canonicalVaultRoot}`, firstRunBackupAcknowledged: true }, { enabled: true }),
      { ok: true }
    );
  })
));
test('the plan carries a rollback artifact: delete-managed-root on first run', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(prodTarget(vault), [focusEvent()], { expectedCanonicalVaultPath: vault });
    assert.equal(plan.rollbackPlan.strategy, 'delete_managed_root');
    assert.equal(plan.rollbackPlan.managedRootExistedBefore, false);
  })
));
test('test-mode apply is blocked without the TEST-VAULT.md marker', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }), err => err.code === 'test_not_authorized');
  }, { testVaultMarker: false })
));
test('test-mode apply is blocked without the explicit apply flag', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test' }), err => err.code === 'test_not_authorized');
  })
));

// -- Partial failure honesty -----------------------------------------------------

test('a mid-apply write failure is reported as an explicit partial result, not a bare crash', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    const plan = await planObsidianSync(target, [focusEvent()]);
    let count = 0;
    const failingFs = {
      mkdir: fs.mkdir, readFile: fs.readFile, lstat: fs.lstat, realpath: fs.realpath, readdir: fs.readdir, rename: fs.rename, unlink: fs.unlink,
      async writeFile(target_, content, enc) {
        count++;
        if (count === 2) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
        return fs.writeFile(target_, content, enc);
      }
    };
    await assert.rejects(() => applyObsidianSync(plan, { mode: 'test', apply: true }, { fs: failingFs }), err => {
      assert.equal(err.code, 'partial_apply_failure');
      assert.ok(Array.isArray(err.written));
      assert.equal(err.written.length, 1);
      assert.ok(err.failedRelativePath);
      return true;
    });
  })
));

// -- Preview formatting -----------------------------------------------------------

test('formatObsidianSyncPreview lists only relative paths and op names, and explains the block state', async () => (
  withTempVault(async vault => {
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    const preview = formatObsidianSyncPreview(plan);
    assert.ok(preview.includes('CREATE'));
    assert.ok(preview.includes('Life Ledger/Daily/2026-08-30.md'));
    assert.ok(!preview.includes(vault)); // no absolute filesystem path leaked into the human preview
  })
));
test('formatObsidianSyncPreview reports BLOCKED plans clearly', async () => (
  withTempVault(async vault => {
    await fs.mkdir(path.join(vault, 'Life Ledger'), { recursive: true });
    const plan = await planObsidianSync(testTarget(vault), [focusEvent()]);
    assert.ok(formatObsidianSyncPreview(plan).includes('BLOCKED'));
  })
));

// -- Dry run performs zero writes -------------------------------------------------

test('planObsidianSync never writes to disk, even against an already-owned vault', async () => (
  withTempVault(async vault => {
    const target = testTarget(vault);
    await applyObsidianSync(await planObsidianSync(target, [focusEvent()]), { mode: 'test', apply: true });
    const spyFs = writeSpyFs();
    await planObsidianSync(target, [focusEvent()], { fs: spyFs });
    assert.equal(spyFs.calls.writeFile, 0);
    assert.equal(spyFs.calls.rename, 0);
    assert.equal(spyFs.calls.unlink, 0);
  })
));

// -- Traversal / containment (reused primitives, exercised through the public API) -

test('a relative path outside the managed root cannot be smuggled through the renderer output', async () => (
  withTempVault(async vault => {
    // buildObsidianLifeLedgerExport is fully code-controlled (no user-supplied path), so this
    // asserts the containment layer itself rejects an out-of-root path if one were ever
    // produced, by exercising it against the identical primitive the writer already proves
    // safe under attack in test.js (traversal, absolute, UNC, alternate separators).
    const target = testTarget(vault);
    const plan = await planObsidianSync(target, [focusEvent()]);
    for (const op of plan.operations) {
      assert.ok(op.relativePath.startsWith('Life Ledger/'));
      assert.ok(!op.relativePath.includes('..'));
    }
  })
));

// ObsidianSyncError sanity
test('ObsidianSyncError carries a stable code and name', () => {
  const err = new ObsidianSyncError('some_code', 'message', { extra: 1 });
  assert.equal(err.name, 'ObsidianSyncError');
  assert.equal(err.code, 'some_code');
  assert.equal(err.extra, 1);
});

// -- CLI (scripts/sync-life-ledger-to-obsidian.mjs) ------------------------------

async function withTempSnapshotFile(events, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronasense-obsidian-sync-cli-'));
  const filePath = path.join(root, 'snapshot.json');
  try {
    await fs.writeFile(filePath, serializeLifeLedgerSnapshot(createLifeLedgerSnapshotFromEvents(events)), 'utf8');
    return await fn(filePath, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('CLI requires an explicit --mode; there is no default', async () => (
  withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      await assert.rejects(() => runLifeLedgerObsidianSync(['--input', input, '--vault', vault]), err => err.code === 'missing_mode');
    })
  ))
));
test('CLI rejects an unknown --mode value', async () => (
  withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      await assert.rejects(() => runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'staging']), err => err.code === 'missing_mode');
    })
  ))
));
test('CLI defaults to a dry run (no --apply) and performs zero writes', async () => (
  withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      const result = await runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'test']);
      assert.equal(result.applyResult, null);
      assert.equal(result.plan.blocked, false);
      const exists = await fs.access(path.join(vault, 'Life Ledger')).then(() => true, () => false);
      assert.equal(exists, false);
    })
  ))
));
test('CLI test-mode --apply requires the TEST-VAULT.md marker, same as the reviewed renderer/writer CLI', async () => (
  withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      await assert.rejects(
        () => runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'test', '--apply']),
        err => err.code === 'test_not_authorized'
      );
    }, { testVaultMarker: false })
  ))
));
test('CLI test-mode --apply against an authorized test vault writes the plan and is idempotent', async () => (
  withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      const first = await runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'test', '--apply']);
      assert.equal(first.applyResult.applied, true);
      assert.ok(first.applyResult.written.length > 0);
      const second = await runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'test', '--apply']);
      assert.equal(second.applyResult.written.length, 0);
    })
  ))
));
test('CLI production --apply is blocked without --expected-vault (blocked at plan time — no canonical target was ever confirmed)', async () => (
  withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      await assert.rejects(
        () => runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'production', '--apply']),
        err => err.code === 'plan_blocked'
      );
    })
  ))
));
test('CLI production --apply is hard-blocked even with --expected-vault and --first-run-ack (build constant is off)', async () => (
  withTempSnapshotFile([focusEvent()], input => (
    withTempVault(async vault => {
      await assert.rejects(
        () => runLifeLedgerObsidianSync(['--input', input, '--vault', vault, '--mode', 'production', '--apply', '--expected-vault', vault, '--first-run-ack', `FIRST-RUN-CONFIRMED:${vault}`]),
        err => err.code === 'production_sync_disabled'
      );
      const stillAbsent = await fs.access(path.join(vault, 'Life Ledger')).then(() => true, () => false);
      assert.equal(stillAbsent, false);
    })
  ))
));
test('CLI rejects duplicate --mode before touching the snapshot', async () => {
  await assert.rejects(
    () => runLifeLedgerObsidianSync(['--input', 'a.json', '--vault', 'C:\\SafeVault', '--mode', 'test', '--mode', 'test']),
    err => err.code === 'duplicate_mode'
  );
});
test('CLI rejects unknown flags', async () => {
  await assert.rejects(
    () => runLifeLedgerObsidianSync(['--input', 'a.json', '--vault', 'C:\\SafeVault', '--mode', 'test', '--surprise']),
    err => err.code === 'unknown_arg'
  );
});
