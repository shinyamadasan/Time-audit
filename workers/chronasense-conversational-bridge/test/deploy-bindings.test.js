// Deployment binding gate (TASK-012; CHANGELOG TASK-011 rollout incident): a Worker deploy can no longer silently
// drop the externally managed plaintext bindings. The required list is pinned to what the source actually reads,
// every deploy passes all of them explicitly (never --keep-vars), secrets are refused as plaintext, and the local
// vars file can never be committed or printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OPTIONAL_PLAINTEXT_BINDINGS, REQUIRED_PLAINTEXT_BINDINGS, SECRET_BINDINGS, bindingProblems, redacted, wranglerArgs } from '../scripts/deploy.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALID = Object.freeze({
  ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_POLICY_AUD: 'aud0123456789abcdef',
  CHRONASENSE_OWNER_SUBJECT: 'sub-&-|-"quoted"', CHRONASENSE_ACTION_API_URL: 'https://fn.example.test/v1/query', CHRONASENSE_WORKER_HMAC_KEY_ID: 'key-1',
});

test('the required + optional lists are exactly the env names the Worker source reads, minus secrets and platform bindings', () => {
  const read = new Set();
  for (const file of readdirSync(path.join(ROOT, 'src'))) {
    const source = readFileSync(path.join(ROOT, 'src', file), 'utf8');
    for (const [, name] of source.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) read.add(name);
    for (const [, name] of source.matchAll(/configuredValue\(env, '([A-Z][A-Z0-9_]+)'\)/g)) read.add(name);
  }
  const platform = ['OAUTH_PROVIDER', 'OAUTH_KV'];
  assert.deepEqual([...read].filter(name => !platform.includes(name) && !SECRET_BINDINGS.includes(name)).sort(),
    [...REQUIRED_PLAINTEXT_BINDINGS, ...OPTIONAL_PLAINTEXT_BINDINGS].sort());
});

test('TASK-029: the optional second subject is passed only when present, validated, distinct from the owner and redacted', () => {
  assert.deepEqual(OPTIONAL_PLAINTEXT_BINDINGS, ['CHRONASENSE_SECOND_SUBJECT']);
  assert.ok(!wranglerArgs(VALID).some(arg => arg.startsWith('CHRONASENSE_SECOND_SUBJECT:')), 'absent -> not passed (deploy removes it: owner only)');
  const withSecond = { ...VALID, CHRONASENSE_SECOND_SUBJECT: 'second-sub-1' };
  assert.deepEqual(bindingProblems(withSecond), []);
  const args = wranglerArgs(withSecond);
  assert.ok(args.includes('CHRONASENSE_SECOND_SUBJECT:second-sub-1'));
  assert.equal(args.filter(arg => arg === '--var').length, REQUIRED_PLAINTEXT_BINDINGS.length + 1);
  assert.ok(!redacted(args).join(' ').includes('second-sub-1'));
  for (const [value, problem] of [['', /invalid value for CHRONASENSE_SECOND_SUBJECT/], [' second ', /invalid value/],
    ['a,b', /invalid value/], [VALID.CHRONASENSE_OWNER_SUBJECT, /must differ/]]) {
    assert.match(bindingProblems({ ...VALID, CHRONASENSE_SECOND_SUBJECT: value }).join('; '), problem);
    assert.throws(() => wranglerArgs({ ...VALID, CHRONASENSE_SECOND_SUBJECT: value }), /Refusing to deploy/);
  }
});

test('every deploy passes all five bindings explicitly and never relies on --keep-vars', () => {
  const args = wranglerArgs(VALID);
  assert.equal(args[0], 'deploy');
  assert.ok(!args.includes('--keep-vars'));
  for (const name of REQUIRED_PLAINTEXT_BINDINGS) assert.ok(args.includes(`${name}:${VALID[name]}`), name);
  assert.equal(args.filter(arg => arg === '--var').length, REQUIRED_PLAINTEXT_BINDINGS.length);
  assert.deepEqual(wranglerArgs(VALID, { dryRun: true }).slice(-3), ['--dry-run', '--outdir', '.wrangler-dist']);
});

test('the gate refuses a missing, empty, padded, malformed, unexpected or secret binding (names only, never values)', () => {
  assert.deepEqual(bindingProblems(VALID), []);
  const cases = [
    [{ ...VALID, ACCESS_TEAM_DOMAIN: undefined }, /missing required binding ACCESS_TEAM_DOMAIN/],
    [{ ...VALID, ACCESS_POLICY_AUD: '' }, /invalid value for ACCESS_POLICY_AUD/],
    [{ ...VALID, CHRONASENSE_OWNER_SUBJECT: ' sub ' }, /invalid value for CHRONASENSE_OWNER_SUBJECT/],
    [{ ...VALID, CHRONASENSE_ACTION_API_URL: 'https://fn.example.test/v1/command' }, /invalid value for CHRONASENSE_ACTION_API_URL/],
    [{ ...VALID, CHRONASENSE_ACTION_API_URL: 'http://fn.example.test/v1/query' }, /invalid value/],
    [{ ...VALID, ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/path' }, /invalid value for ACCESS_TEAM_DOMAIN/],
    [{ ...VALID, CHRONASENSE_WORKER_HMAC_KEY_ID: 'key 1' }, /invalid value/],
    [{ ...VALID, CHRONASENSE_WORKER_HMAC_KEY_HEX: 'ab'.repeat(32) }, /is a secret/],
    [{ ...VALID, EXTRA: 'x' }, /unexpected binding EXTRA/],
    [[], /JSON object/],
  ];
  for (const [vars, problem] of cases) {
    const clean = Array.isArray(vars) ? vars : Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== undefined));
    assert.match(bindingProblems(clean).join('; '), problem);
    assert.throws(() => wranglerArgs(clean), /Refusing to deploy/);
  }
  assert.ok(!bindingProblems({ ...VALID, CHRONASENSE_OWNER_SUBJECT: ' secret-subject ' }).join().includes('secret-subject'), 'a value is never echoed');
});

test('the printed plan redacts every value; the vars file is gitignored and only a placeholder example is tracked', () => {
  const printed = redacted(wranglerArgs(VALID)).join(' ');
  for (const value of Object.values(VALID)) assert.ok(!printed.includes(value), 'value redacted');
  for (const name of REQUIRED_PLAINTEXT_BINDINGS) assert.ok(printed.includes(`${name}:<redacted>`));
  assert.match(readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.deploy-vars\.json$/m);
  const ignored = execFileSync('git', ['check-ignore', '.deploy-vars.json'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(ignored, '.deploy-vars.json');
  const example = JSON.parse(readFileSync(path.join(ROOT, 'deploy-vars.example.json'), 'utf8'));
  assert.deepEqual(bindingProblems(example), [], 'the example documents the exact contract');
  assert.ok(Object.values(example).every(value => /example|replace-with/.test(value)), 'placeholders only, no production value');
});
