// node --test scripts/task-gating.test.js
//
// Execution-gating contract for the AI Dev OS task tooling (DECISIONS #35, owner-direct governance):
//
//   GOV-001  a task with an unresolved `depends-on:` must not start through the MANUAL builder
//            (tools/Run-Codex-Build.ps1) -- the same dependency rule /go has always used.
//   GOV-002  a `source: owner-direct` task must not be executed by UNATTENDED runs (/go, /build);
//            it stays available to a manual run once its dependencies are merged.
//
// These run the REAL scripts (tools/Run-Codex-Build.ps1, tools/Dispatch-Commands.ps1 -DryRun, and the
// shared tools/Task-Gating.ps1) against throwaway fixture repos -- the real repo is never touched,
// no engine (codex/claude) is ever started, and nothing is pushed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOLS = path.join(REPO, 'tools');
const IS_WIN = process.platform === 'win32';

// Windows PowerShell 5.1 is the lowest common denominator the tools target, so it is the primary
// shell when present; pwsh runs a smoke subset. A machine with neither is a hard failure, not a skip.
function hasShell(cmd) {
  const r = spawnSync(cmd, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
const SHELLS = [IS_WIN ? 'powershell' : null, 'pwsh'].filter(Boolean).filter(hasShell);
const PRIMARY = SHELLS[0];

test('a PowerShell is available to run the tooling tests', () => {
  assert.ok(PRIMARY, 'neither powershell nor pwsh found -- tools/ gating tests cannot run');
});

// ---------------------------------------------------------------------------------- fixtures

function task({ id, title = 'Fixture task', status = 'codex', source, deps = 'none', priority = 'P2', prose = '' }) {
  const lines = [`### ${id} - ${title}`, `status: ${status}`, 'owner: codex'];
  if (source !== undefined) lines.push(`source: ${source}`);
  lines.push(`priority: ${priority}`, `depends-on: ${deps}`, 'files: app.js', '', 'context:', `  ${prose || 'fixture'}`, '', '---', '');
  return lines.join('\n');
}
const tasksFile = (...tasks) => `# Tasks\n\n${tasks.join('\n')}\n<!-- TASK TEMPLATE -- ignored -->\n`;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const cleanups = [];
test.after(() => { for (const d of cleanups) rmSync(d, { recursive: true, force: true }); });

// merged: task branches merged into main; unmerged: task branches with an extra commit, not merged.
function makeRepo({ tasks, merged = [], unmerged = [], withDispatcher = false, command = null }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-gating-'));
  cleanups.push(root);
  mkdirSync(path.join(root, 'tools'));
  for (const f of ['Run-Codex-Build.ps1', 'Task-Gating.ps1', ...(withDispatcher ? ['Dispatch-Commands.ps1'] : [])]) {
    copyFileSync(path.join(TOOLS, f), path.join(root, 'tools', f));
  }
  writeFileSync(path.join(root, 'TASKS.md'), tasks);
  writeFileSync(path.join(root, '.gitignore'), 'claude-session.log\n.last-phase-result.txt\nautomation.lock\n');
  if (withDispatcher) {
    writeFileSync(path.join(root, 'run-claude.ps1'), '$AUTOMATION_ENABLED = $true\n');
    mkdirSync(path.join(root, 'captures', 'commands'), { recursive: true });
    writeFileSync(path.join(root, 'captures', 'commands', 'c1.md'), `id: c1\ncommand: ${command}\nstatus: new\n`);
  }
  const bin = path.join(root, '..', path.basename(root) + '-bin');
  mkdirSync(bin);
  cleanups.push(bin);
  if (IS_WIN) writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nexit /b 0\r\n');
  else { writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(bin, 'codex'), 0o755); }

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  for (const b of merged) git(root, 'branch', b);
  for (const b of unmerged) {
    git(root, 'checkout', '-q', '-b', b);
    writeFileSync(path.join(root, `${b}.txt`), 'work');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `${b} work`);
    git(root, 'checkout', '-q', 'main');
  }
  return { root, bin };
}

function ps(shell, repo, script, flags = []) {
  const r = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo.root, 'tools', script), ...flags], {
    cwd: repo.root,
    encoding: 'utf8',
    env: { ...process.env, PATH: repo.bin + path.delimiter + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],   // never let a script wait on stdin
    timeout: 90000,
  });
  assert.ifError(r.error);
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// Run the manual/unattended builder in -DryRun (no engine is ever started) and prove it left the repo
// untouched: refusals never edit TASKS.md or switch branches.
function build(shell, repo, flags = []) {
  const before = readFileSync(path.join(repo.root, 'TASKS.md'), 'utf8');
  const r = ps(shell, repo, 'Run-Codex-Build.ps1', ['-DryRun', ...flags]);
  assert.equal(readFileSync(path.join(repo.root, 'TASKS.md'), 'utf8'), before, 'TASKS.md must never be edited by a gate');
  assert.equal(git(repo.root, 'status', '--porcelain').trim(), '', 'fixture repo must stay clean');
  assert.equal(git(repo.root, 'branch', '--show-current').trim(), 'main', 'must not leave main');
  return r;
}
const WOULD_BUILD = /\[DRY RUN\] would checkout\/create (task-\d+)/;

// ---------------------------------------------------------------------- GOV-001: dependencies (manual)

test('GOV-001: no depends-on -> eligible', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-010', source: 'BQ-001' })) });
  const r = build(PRIMARY, repo);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, WOULD_BUILD);
});

test('GOV-001: resolved dependency (task branch merged into main) -> eligible', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-011', source: 'BQ-001', deps: 'TASK-004' })), merged: ['task-004'] });
  const r = build(PRIMARY, repo);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would checkout\/create task-011/);
});

test('GOV-001: unresolved dependency -> refused with task id, blocker id and its status; no engine, no edit', () => {
  const repo = makeRepo({ tasks: tasksFile(
    task({ id: 'TASK-004', status: 'review', source: 'BQ-001' }),
    task({ id: 'TASK-005', source: 'BQ-002', deps: 'TASK-004' })) });
  const r = build(PRIMARY, repo);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /TASK-005/);
  assert.match(r.out, /TASK-004 \(status: review; branch 'task-004' is not merged into main\)/);
  assert.doesNotMatch(r.out, WOULD_BUILD);
});

test('GOV-001: a dependency branch that exists but is NOT merged still blocks', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-012', source: 'BQ-001', deps: 'TASK-004' })), unmerged: ['task-004'] });
  const r = build(PRIMARY, repo);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /TASK-004/);
});

test('GOV-001: several dependencies, one unresolved -> blocked, naming only the unresolved one', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-013', source: 'BQ-001', deps: 'TASK-004, TASK-006' })), merged: ['task-004'] });
  const r = build(PRIMARY, repo);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /TASK-006/);
  assert.doesNotMatch(r.out, /TASK-004 \(/);
});

test('GOV-001: unknown dependency (not in TASKS.md, no branch) fails closed', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-014', source: 'BQ-001', deps: 'TASK-099' })) });
  const r = build(PRIMARY, repo);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /TASK-099 \(not found in TASKS\.md/);
});

test('GOV-001: unparseable words beside a real dependency do not hide it (existing tokenizer: only TASK-<n> tokens count)', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-015', source: 'BQ-001', deps: 'TASK-004 (see notes)' })) });
  const r = build(PRIMARY, repo);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /TASK-004/);
});

test('GOV-001: the block follows the task-004 ref, not the dependency\'s lifecycle status (review, approved)', () => {
  for (const status of ['review', 'approved']) {
    const tasks = tasksFile(
      task({ id: 'TASK-004', status, source: 'BQ-001' }),
      task({ id: 'TASK-005', source: 'owner-direct', deps: 'TASK-004', priority: 'P1' }));
    const blocked = build(PRIMARY, makeRepo({ tasks }));                       // task-004 NOT merged
    assert.equal(blocked.code, 2, `${status}: ${blocked.out}`);
    assert.match(blocked.out, new RegExp(`TASK-004 \\(status: ${status}; branch 'task-004' is not merged into main\\)`), status);
    const released = build(PRIMARY, makeRepo({ tasks, merged: ['task-004'] })); // merged ref releases it
    assert.equal(released.code, 0, `${status} + merged: ${released.out}`);
    assert.match(released.out, /would checkout\/create task-005/);
  }
});

test('GOV-001: TASK-005-like owner-direct task with an unresolved dependency is blocked on the MANUAL path', () => {
  const repo = makeRepo({ tasks: tasksFile(
    task({ id: 'TASK-004', status: 'review', source: 'BQ-001' }),
    task({ id: 'TASK-005', source: 'owner-direct', deps: 'TASK-004', priority: 'P1' })) });
  const r = build(PRIMARY, repo);                 // no -Unattended == manual
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /TASK-005.*unresolved dependency.*TASK-004/);
});

test('GOV-001: the gate stops -- it does not silently build a later, unrelated task instead', () => {
  const repo = makeRepo({ tasks: tasksFile(
    task({ id: 'TASK-005', source: 'BQ-001', deps: 'TASK-004' }),
    task({ id: 'TASK-006', source: 'BQ-002' })) });
  const r = build(PRIMARY, repo);
  assert.equal(r.code, 2, r.out);
  assert.doesNotMatch(r.out, /task-006/);
});

// ------------------------------------------------------------- GOV-002: owner-direct (unattended)

test('GOV-002: BUILD_QUEUE-derived codex task stays eligible for unattended runs', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-020', source: 'BQ-001' })) });
  const r = build(PRIMARY, repo, ['-Unattended']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would checkout\/create task-020/);
});

test('GOV-002: owner-direct codex task is refused when unattended', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-021', source: 'owner-direct' })) });
  const r = build(PRIMARY, repo, ['-Unattended']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /TASK-021.*owner-direct.*interactive\/manual only/);
  assert.doesNotMatch(r.out, WOULD_BUILD);
});

test('GOV-002: owner-direct with dependencies resolved AND top priority is still refused when unattended', () => {
  const repo = makeRepo({ tasks: tasksFile(
    task({ id: 'TASK-022', source: 'owner-direct', deps: 'TASK-004', priority: 'P1' }),
    task({ id: 'TASK-023', source: 'BQ-001', priority: 'P3' })), merged: ['task-004'] });
  const r = build(PRIMARY, repo, ['-Unattended']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /TASK-022.*owner-direct/);
  assert.doesNotMatch(r.out, /task-023/);          // no silent skip to a different task
});

test('GOV-002: the same owner-direct task, deps resolved, is runnable MANUALLY', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-024', source: 'owner-direct', deps: 'TASK-004', priority: 'P1' })), merged: ['task-004'] });
  const r = build(PRIMARY, repo);                 // manual: no -Unattended
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would checkout\/create task-024/);
});

test('GOV-002: prose mentioning owner-direct does not misclassify a BQ task', () => {
  const repo = makeRepo({ tasks: tasksFile(task({
    id: 'TASK-025', title: 'About owner-direct tasks', source: 'BQ-001',
    prose: 'source: owner-direct is only mentioned here as indented prose; this task came from BUILD_QUEUE.' })) });
  const r = build(PRIMARY, repo, ['-Unattended']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would checkout\/create task-025/);
});

test('GOV-002: missing or free-text source is NOT owner-direct (existing safe behaviour)', () => {
  for (const source of [undefined, '', 'ported from the owner-direct work in another repo', 'owner-directed-ish? no']) {
    const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-026', source })) });
    const r = build(PRIMARY, repo, ['-Unattended']);
    assert.equal(r.code, 0, `source=${JSON.stringify(source)}: ${r.out}`);
  }
});

test('GOV-002: owner-direct recognized from the parsed field regardless of case/suffix', () => {
  for (const source of ['Owner-Direct', 'owner-direct 2026-10-06', 'owner-direct (owner message, 2026-10-06)']) {
    const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-027', source })) });
    const r = build(PRIMARY, repo, ['-Unattended']);
    assert.equal(r.code, 2, `source=${source}: ${r.out}`);
  }
});

// ----------------------------------------------------- parser + real TASKS.md (shared helper)

function parseTable(shell, text) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-gating-parse-'));
  cleanups.push(dir);
  writeFileSync(path.join(dir, 'TASKS.md'), text);
  const driver = path.join(dir, 'driver.ps1');
  writeFileSync(driver, `$tasksFile = '${path.join(dir, 'TASKS.md')}'\n. '${path.join(TOOLS, 'Task-Gating.ps1')}'\nConvertTo-Json -InputObject @(Get-TaskTable) -Depth 4 -Compress\n`);
  const r = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('the recorded TASK-005 is parsed as owner-direct and depends on TASK-004; TASK-001..004 are not owner-direct', () => {
  const rows = parseTable(PRIMARY, readFileSync(path.join(REPO, 'TASKS.md'), 'utf8'));
  const by = Object.fromEntries(rows.map((r) => [r.Id, r]));
  assert.equal(by['TASK-005'].OwnerDirect, true);
  assert.deepEqual([].concat(by['TASK-005'].Deps), ['TASK-004']);
  assert.equal(by['TASK-005'].Status, 'codex');
  for (const id of ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004']) assert.equal(by[id].OwnerDirect, false, id);
  assert.equal(by['TASK-004'].Source, 'BQ-001');
});

test('a REAL (non-dry) refusal exits 2 and leaves the result the dispatcher relays, before any engine starts', () => {
  const repo = makeRepo({ tasks: tasksFile(task({ id: 'TASK-043', source: 'owner-direct' })) });
  const r = ps(PRIMARY, repo, 'Run-Codex-Build.ps1', ['-Unattended']);
  assert.equal(r.code, 2, r.out);
  const result = readFileSync(path.join(repo.root, '.last-phase-result.txt'), 'utf8');
  assert.match(result, /TASK-043.*owner-direct.*interactive\/manual only/);
  assert.equal(git(repo.root, 'branch', '--show-current').trim(), 'main');
  assert.equal(git(repo.root, 'branch', '--list', 'task-043').trim(), '', 'no task branch may be created for a refused task');
  assert.equal(git(repo.root, 'status', '--porcelain').trim(), '');
});

test('/go and the manual builder share one dependency rule (Test-DepsSatisfied == no unresolved ids)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-gating-deps-'));
  cleanups.push(dir);
  const driver = path.join(dir, 'driver.ps1');
  writeFileSync(driver, `. '${path.join(TOOLS, 'Task-Gating.ps1')}'
$none = [pscustomobject]@{ Deps = @() }
$two  = [pscustomobject]@{ Deps = @('TASK-004', 'TASK-006') }
@{
  none      = Test-DepsSatisfied -Task $none -MergedBranches @()
  allMerged = Test-DepsSatisfied -Task $two  -MergedBranches @('main', 'task-004', 'task-006')
  oneMissing = Test-DepsSatisfied -Task $two -MergedBranches @('task-004')
  unresolved = @(Get-UnresolvedDepIds -Task $two -MergedBranches @('task-004'))
} | ConvertTo-Json -Compress
`);
  const r = spawnSync(PRIMARY, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.none, true);
  assert.equal(v.allMerged, true);
  assert.equal(v.oneMissing, false);
  assert.deepEqual([].concat(v.unresolved), ['TASK-006']);
});

test('the REAL recorded TASKS.md: TASK-005 is blocked manually until TASK-004 merges, and never runs unattended', () => {
  const real = readFileSync(path.join(REPO, 'TASKS.md'), 'utf8');
  const before = makeRepo({ tasks: real });                                   // TASK-004 not merged
  const m1 = build(PRIMARY, before);
  assert.equal(m1.code, 2, m1.out);
  // the dependency and the unmerged ref are the invariant; TASK-004's lifecycle status is incidental
  // (review -> approved -> done), so it is not pinned
  assert.match(m1.out, /TASK-005.*unresolved dependency.*TASK-004 \(status: [\w-]+; branch 'task-004' is not merged into main\)/);
  assert.equal(build(PRIMARY, before, ['-Unattended']).code, 2);              // owner-direct wins first
  const after = makeRepo({ tasks: real, merged: ['task-004'] });              // TASK-004 integrated
  const m2 = build(PRIMARY, after);
  assert.equal(m2.code, 0, m2.out);
  assert.match(m2.out, /would checkout\/create task-005/);
  const u2 = build(PRIMARY, after, ['-Unattended']);
  assert.equal(u2.code, 2, u2.out);                                           // /go still never runs it
  assert.match(u2.out, /TASK-005.*owner-direct/);
});

// ------------------------------------------------ dispatcher (/go, /build) -- Windows-only paths

const dispatch = IS_WIN ? test : test.skip;   // Dispatch-Commands.ps1 builds 'tools\\...' paths (Windows operator tool)

function dispatcher(repoOpts) {
  const repo = makeRepo({ ...repoOpts, withDispatcher: true });
  const r = ps(PRIMARY, repo, 'Dispatch-Commands.ps1', ['-DryRun']);
  assert.equal(git(repo.root, 'status', '--porcelain').trim(), '', 'dispatcher dry-run must leave the fixture clean');
  return r;
}

dispatch('dispatcher /go: a BQ-derived codex task is still built normally', () => {
  const r = dispatcher({ tasks: tasksFile(task({ id: 'TASK-030', source: 'BQ-001' })), command: 'go' });
  assert.match(r.out, /\[DRY RUN\] would build TASK-030/, r.out);
});

dispatch('dispatcher /go: an owner-direct first task is never built, never edited, and is reported', () => {
  const r = dispatcher({ tasks: tasksFile(task({ id: 'TASK-031', source: 'owner-direct', deps: 'TASK-004', priority: 'P1' }), task({ id: 'TASK-032', source: 'BQ-001', priority: 'P3' })), merged: ['task-004'], command: 'go' });
  assert.doesNotMatch(r.out, /would build/, r.out);
  assert.match(r.out, /TASK-031.*is owner-direct: interactive\/manual only/, r.out);
});

dispatch('dispatcher /go: an owner-direct task with an UNRESOLVED dependency is not auto-blocked either', () => {
  const r = dispatcher({ tasks: tasksFile(task({ id: 'TASK-033', source: 'owner-direct', deps: 'TASK-004' })), command: 'go' });
  assert.match(r.out, /TASK-033.*is owner-direct/, r.out);
  assert.doesNotMatch(r.out, /waiting on merge/, r.out);
});

dispatch('dispatcher /build: launches the builder unattended, so an owner-direct task is refused', () => {
  const r = dispatcher({ tasks: tasksFile(task({ id: 'TASK-034', source: 'owner-direct' })), command: 'build' });
  assert.match(r.out, /TASK-034.*owner-direct.*interactive\/manual only/, r.out);
  assert.doesNotMatch(r.out, WOULD_BUILD, r.out);
});

// ----------------------------------------------------------------- second shell: smoke subset

for (const shell of SHELLS.slice(1)) {
  test(`${shell}: smoke -- unresolved dep blocks, owner-direct unattended blocks, eligible task builds`, () => {
    const blocked = makeRepo({ tasks: tasksFile(task({ id: 'TASK-040', source: 'BQ-001', deps: 'TASK-004' })) });
    assert.equal(build(shell, blocked).code, 2);
    const od = makeRepo({ tasks: tasksFile(task({ id: 'TASK-041', source: 'owner-direct' })) });
    assert.equal(build(shell, od, ['-Unattended']).code, 2);
    assert.equal(build(shell, od).code, 0);
    const ok = makeRepo({ tasks: tasksFile(task({ id: 'TASK-042', source: 'BQ-001' })) });
    assert.match(build(shell, ok, ['-Unattended']).out, /would checkout\/create task-042/);
  });
}
