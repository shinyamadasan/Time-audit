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
    for (const name of ['npm.pid', 'child.pid']) {
      const pidFile = path.join(root, name);
      if (!existsSync(pidFile)) continue;
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (alive(pid)) {
        if (WINDOWS) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
        else process.kill(pid, 'SIGKILL');
      }
    }
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('merge-runner-output-'));
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(mode, { approved = true, timeoutMs = 6000 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-runner-output-'));
  fixtures.push(root);
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const bin = path.join(root, 'bin');
  mkdirSync(repo); mkdirSync(bin); mkdirSync(path.join(repo, 'tools'));
  // The only fixture substitution accelerates the existing ten-minute timeout.
  assert.equal(RUNNER.split('WaitForExit(10 * 60 * 1000)').length, 2);
  writeFileSync(path.join(repo, 'tools/Run-Merge.ps1'), RUNNER.replace('WaitForExit(10 * 60 * 1000)', `WaitForExit(${timeoutMs})`));
  writeFileSync(path.join(repo, 'TASKS.md'), `### TASK-099 - Output fixture\nstatus: ${approved ? 'approved' : 'review'}\n`);
  writeFileSync(path.join(repo, '.gitignore'), 'claude-session.log\n.last-phase-result.txt\n');
  const childScript = path.join(root, 'child.cjs');
  writeFileSync(childScript, `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'child.pid'))}, String(process.pid)); setInterval(() => {}, 1000);`);
  const npmScript = path.join(root, 'npm.cjs');
  writeFileSync(npmScript, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(root, 'npm-ran'))}, 'yes');
fs.writeFileSync(${JSON.stringify(path.join(root, 'npm.pid'))}, String(process.pid));
if (${JSON.stringify(mode)} === 'timeout') {
  require('node:child_process').spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'inherit' });
  setInterval(() => {}, 1000);
} else {
  fs.writeSync(1, 'STDOUT-BEGIN\\n' + 'o'.repeat(${mode === 'large' ? 524288 : 16}) + '\\nSTDOUT-END\\n');
  fs.writeSync(2, 'STDERR-BEGIN\\n' + 'e'.repeat(${mode === 'large' ? 524288 : 16}) + '\\nSTDERR-END\\n');
  process.exit(${mode === 'failure' ? 23 : 0});
}
`);
  if (WINDOWS) writeFileSync(path.join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${npmScript}"\r\nexit /b %errorlevel%\r\n`);
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
}
