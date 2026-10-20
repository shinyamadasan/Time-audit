// Exercise the real held runner in disposable repositories; no project remote is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = readFileSync(path.join(ROOT, 'tools/Run-Merge.ps1'), 'utf8');
const CONTAINMENT = readFileSync(path.join(ROOT, 'tools/Merge-TestProcess.cs'), 'utf8');
const WINDOWS = process.platform === 'win32';
const SHELLS = (WINDOWS ? ['powershell', 'pwsh'] : ['pwsh']).filter(shell =>
  spawnSync(shell, ['-NoProfile', '-Command', 'exit 0']).status === 0);
const fixtures = [];

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test.after(() => {
  for (const root of fixtures) {
    // Fixtures self-expire even against a broken runner. Never kill by a recycled PID.
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('merge-runner-output-'));
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(mode, { approved = true, timeoutMs = 6000, fault = '' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-runner-output-'));
  fixtures.push(root);
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const bin = path.join(root, 'bin');
  mkdirSync(repo); mkdirSync(bin); mkdirSync(path.join(repo, 'tools'));
  // Accelerate only the test deadline; fault injection changes disposable source copies only.
  assert.equal(RUNNER.split('WaitForExit(10 * 60 * 1000)').length, 2);
  assert.equal(RUNNER.split('::Run($root, 10 * 60 * 1000)').length, 2);
  writeFileSync(path.join(repo, 'tools/Run-Merge.ps1'), RUNNER
    .replace('WaitForExit(10 * 60 * 1000)', `WaitForExit(${timeoutMs})`)
    .replace('::Run($root, 10 * 60 * 1000)', `::Run($root, ${timeoutMs})`));
  let helper = CONTAINMENT;
  if (fault) {
    const call = fault === 'cleanup' ? 'TerminateJobObject(job, 1)' : 'AssignProcessToJobObject(job, process.Process)';
    assert.equal(helper.split(`Check(${call},`).length, 2);
    helper = helper.replace(`Check(${call},`, 'Check(false,');
  }
  writeFileSync(path.join(repo, 'tools/Merge-TestProcess.cs'), helper);
  writeFileSync(path.join(repo, 'TASKS.md'), `### TASK-099 - Output fixture\nstatus: ${approved ? 'approved' : 'review'}\n`);
  writeFileSync(path.join(repo, '.gitignore'), 'claude-session.log\n.last-phase-result.txt\n');
  const childScript = path.join(root, 'child.cjs');
  writeFileSync(childScript, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(root, 'child.pid'))}, String(process.pid));
if (${JSON.stringify(mode)} === 'orphan') {
  // Self-expire even against the broken runner; this reproduction cannot leak indefinitely.
  setTimeout(() => {
    try { process.kill(Number(process.argv[2]), 0); }
    catch { fs.writeFileSync(${JSON.stringify(path.join(root, 'parent-exited-child-alive'))}, 'yes'); }
  }, 500);
  setTimeout(() => process.exit(0), 12000);
} else setTimeout(() => process.exit(0), 12000);
`);
  const npmScript = path.join(root, 'npm.cjs');
  writeFileSync(npmScript, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(root, 'npm-ran'))}, 'yes');
fs.writeFileSync(${JSON.stringify(path.join(root, 'npm.pid'))}, String(process.pid));
if (['timeout', 'orphan'].includes(${JSON.stringify(mode)})) {
  require('node:child_process').spawn(process.execPath, [${JSON.stringify(childScript)}, String(process.pid)], { stdio: 'inherit' });
  if (${JSON.stringify(mode)} === 'orphan') {
    const ready = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(path.join(root, 'child.pid'))})) {
        clearInterval(ready);
        fs.unlinkSync(${JSON.stringify(path.join(root, 'npm.pid'))});
        process.exit(0);
      }
    }, 10);
  } else setTimeout(() => process.exit(0), 12000);
} else {
  fs.writeSync(1, 'STDOUT-BEGIN\\n' + 'o'.repeat(${mode === 'large' ? 524288 : 16}) + '\\nSTDOUT-END\\n');
  fs.writeSync(2, 'STDERR-BEGIN\\n' + 'e'.repeat(${mode === 'large' ? 524288 : 16}) + '\\nSTDERR-END\\n');
  process.exit(${mode === 'failure' ? 23 : 0});
}
`);
  if (WINDOWS && mode === 'orphan') {
    const psChild = path.join(root, 'orphan.ps1');
    const psQuote = value => `'${value.replaceAll("'", "''")}'`;
    writeFileSync(psChild, `
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText(${psQuote(path.join(root, 'child.pid'))}, [string]$PID)
$parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
[Console]::WriteLine('ORPHAN-STREAM-OPEN')
[IO.File]::WriteAllText(${psQuote(path.join(root, 'child.ready'))}, 'yes')
Start-Sleep -Milliseconds 500
if (-not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) {
  [IO.File]::WriteAllText(${psQuote(path.join(root, 'parent-exited-child-alive'))}, 'yes')
}
Start-Sleep -Seconds 12
`);
    const readyScript = path.join(root, 'wait-ready.cjs');
    writeFileSync(readyScript, `
const fs = require('node:fs');
const deadline = setTimeout(() => process.exit(24), 4000);
const poll = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(path.join(root, 'child.ready'))})) {
    clearTimeout(deadline); clearInterval(poll);
  }
}, 10);
`);
    writeFileSync(path.join(bin, 'npm.cmd'), `@echo off\r\nstart "" /b powershell -NoProfile -File "${psChild}"\r\n"${process.execPath}" "${readyScript}"\r\nexit /b %errorlevel%\r\n`);
  } else if (WINDOWS) writeFileSync(path.join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${npmScript}"\r\nexit /b %errorlevel%\r\n`);
  else {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(npmScript)}\n`);
    chmodSync(path.join(bin, 'npm'), 0o755);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'fixture baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  git(root, 'init', '--bare', '-q', remote); git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'task-099');
  writeFileSync(path.join(repo, 'candidate.txt'), 'fixture change');
  git(repo, 'add', 'candidate.txt'); git(repo, 'commit', '-q', '-m', 'fixture candidate');
  return { root, repo, bin, remote, baseline };
}

function run(shell, f) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = f.bin + path.delimiter + process.env.PATH;
  const result = spawnSync(shell, ['-NoProfile', '-File', path.join(f.repo, 'tools/Run-Merge.ps1'), '-TaskId', 'TASK-099', '-Confirm'], {
    cwd: f.repo, env, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024
  });
  assert.ifError(result.error);
  return { code: result.status, text: result.stdout + result.stderr };
}

test('supported PowerShell is available and the runner stays ASCII', () => {
  assert.ok(SHELLS.length, 'PowerShell is required; this suite must not silently skip');
  if (WINDOWS) assert.equal(SHELLS.length, 2, 'Windows coverage requires both PowerShell 5.1 and 7');
  assert.match(RUNNER, /^[\x00-\x7f]*$/);
});

for (const shell of SHELLS) {
  test(`${shell}: large stdout AND stderr complete, are captured, and success uses the real held merge path`, () => {
    const f = fixture('large');
    const result = run(shell, f);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /MERGED: TASK-099/);
    const log = readFileSync(path.join(f.repo, 'claude-session.log'), 'utf8');
    assert.ok(log.includes('o'.repeat(524288) + '\nSTDOUT-END'));
    assert.ok(log.includes('e'.repeat(524288) + '\nSTDERR-END'));
    assert.match(readFileSync(path.join(f.repo, 'TASKS.md'), 'utf8'), /status: done/);
    assert.equal(git(f.repo, 'rev-parse', 'main'), git(f.remote, 'rev-parse', 'main'));
    assert.notEqual(git(f.repo, 'rev-parse', 'main'), f.baseline);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
  });

  test(`${shell}: nonzero exit refuses, retains diagnostics, and never advances main`, () => {
    const f = fixture('failure');
    const result = run(shell, f);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /npm test FAILED.*exit 23/);
    const log = readFileSync(path.join(f.repo, 'claude-session.log'), 'utf8');
    assert.match(log, /STDOUT-END/); assert.match(log, /STDERR-END/);
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.baseline);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseline);
    assert.match(readFileSync(path.join(f.repo, 'TASKS.md'), 'utf8'), /status: approved/);
  });

  test(`${shell}: timeout refuses, cleans up the descendant process, and never advances main`, async () => {
    const f = fixture('timeout');
    const result = run(shell, f);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /npm test timed out/);
    const childPid = Number(readFileSync(path.join(f.root, 'child.pid'), 'utf8'));
    for (let attempt = 0; attempt < 30 && alive(childPid); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(alive(childPid), false, `descendant ${childPid} survived timeout`);
    const npmPid = Number(readFileSync(path.join(f.root, 'npm.pid'), 'utf8'));
    assert.equal(alive(npmPid), false, `npm process ${npmPid} survived timeout`);
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.baseline);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseline);
    assert.match(readFileSync(path.join(f.repo, 'TASKS.md'), 'utf8'), /status: approved/);
  });

  test(`${shell}: missing approval still refuses before running npm`, () => {
    const f = fixture('large', { approved: false });
    const result = run(shell, f);
    assert.equal(result.code, 2, result.text);
    assert.match(result.text, /only lands HELD/);
    assert.equal(existsSync(path.join(f.root, 'npm-ran')), false);
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.baseline);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseline);
  });

  test(`${shell}: parent exits zero but descendant holds output handles; containment must refuse within its bound`, { skip: !WINDOWS && 'Windows containment; non-Windows path is unchanged' }, () => {
    const f = fixture('orphan');
    const started = Date.now();
    const result = run(shell, f);
    const elapsedMs = Date.now() - started;
    assert.equal(existsSync(path.join(f.root, 'parent-exited-child-alive')), true,
      'the fixture must observe its parent exited while the child remains alive');
    assert.equal(result.code, 1, `must refuse, not merge after waiting ${elapsedMs}ms: ${result.text}`);
    assert.match(result.text, /MERGE BLOCKED.*output\/process tree incomplete/i);
    assert.ok(elapsedMs < 12000, `drain exceeded bounded fixture budget: ${elapsedMs}ms`);
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.baseline);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseline);
    const childPid = Number(readFileSync(path.join(f.root, 'child.pid'), 'utf8'));
    assert.equal(alive(childPid), false, 'orphaned stream holder must be cleaned up');
  });

  test(`${shell}: descendant cleanup failure refuses and kill-on-close contains the fixture`, { skip: !WINDOWS && 'Windows Job Object fault injection' }, async () => {
    const f = fixture('orphan', { fault: 'cleanup' });
    const started = Date.now();
    const result = run(shell, f);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /cleanup failure/);
    assert.doesNotMatch(result.text, /MERGED:/);
    assert.ok(Date.now() - started < 12000);
    assert.equal(existsSync(path.join(f.root, 'parent-exited-child-alive')), true);
    const childPid = Number(readFileSync(path.join(f.root, 'child.pid'), 'utf8'));
    for (let i = 0; i < 30 && alive(childPid); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(alive(childPid), false, 'kill-on-close must terminate the owned descendant');
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.baseline);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseline);
  });

  test(`${shell}: failed launch-time assignment refuses before npm executes`, { skip: !WINDOWS && 'Windows Job Object fault injection' }, () => {
    const f = fixture('large', { fault: 'assignment' });
    const result = run(shell, f);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /assign suspended npm to job/);
    assert.doesNotMatch(result.text, /MERGED:/);
    assert.equal(existsSync(path.join(f.root, 'npm-ran')), false);
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.baseline);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseline);
  });
}
