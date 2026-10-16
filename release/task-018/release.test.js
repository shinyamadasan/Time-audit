// Offline proofs for TASK-018 Gate B tooling: preflight evaluation (fail-closed), artifact immutability and the
// alert-policy definitions. No network, no cloud.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPECTED as E, evaluatePreflight, inspectArtifact, parseEnv, ruleDiff } from './prod-preflight.mjs';

const SECRETISH = 'owner-subject-SENTINEL-77';
const live = { rules: { '.read': false, '.write': false, rooms: { $roomId: { '.read': 'auth != null' } } } };
const candidate = structuredClone(live); candidate.rules.rooms.$roomId.taskCompletionResolutions = { '.write': false };
function goodFacts() {
  const envValues = { CHRONASENSE_COMPLETION_SERVICE_ACCOUNT: E.runtimeSA, CHRONASENSE_FIREBASE_WEB_API_KEY: E.webApiKey,
    CHRONASENSE_OWNER_FIREBASE_UID: 'ownerUid123', CHRONASENSE_OWNER_SUBJECT: SECRETISH, CHRONASENSE_RTDB_URL: E.rtdbUrl };
  return {
    errors: [],
    target: { account: E.operatorAccount, firebasercAbsent: true },
    project: { projectId: E.projectId, projectNumber: E.projectNumber, lifecycleState: 'ACTIVE' },
    functions: [{ name: 'chronasenseActionApi', state: 'ACTIVE', runtime: 'nodejs22', revision: E.actionApiRevision }],
    iam: { bindings: [{ role: 'roles/owner', members: [E.ownerUser] }, { role: 'roles/editor', members: [...E.editorBaseline] }] },
    serviceAccounts: [], customRoles: [], saPolicies: {},
    rules: { live: structuredClone(live), candidate: structuredClone(candidate) },
    auth: { subtype: 'FIREBASE_AUTH', googleEnabled: true, emailEnabled: false, anonymousEnabled: false, phoneEnabled: false, authorizedDomains: ['localhost', 'shinyamadasan.github.io', 'x.firebaseapp.com'] },
    env: { values: envValues }, actionApiEnv: { ...envValues, FUNCTION_TARGET: 'x' },
    secret: { name: E.secretName, enabledVersions: 1 },
    artifact: { sha: E.candidateSha, tracked: 10, missing: [], mismatched: [], unexpected: [], stagingHits: 0, stagingFiles: [], insideGitRepo: false },
    owner: { timezone: 'Asia/Manila' },
  };
}
const failed = result => result.checks.filter(c => !c.ok).map(c => c.name);

test('preflight passes only on the exact expected production state, and never echoes env values', () => {
  const ok = evaluatePreflight(goodFacts(), 'before-identities');
  assert.equal(ok.pass, true, JSON.stringify(failed(ok)));
  assert.equal(ok.sha, E.candidateSha, 'the report records the exact candidate SHA');
  assert.equal(JSON.stringify(ok).includes(SECRETISH), false);
  assert.equal(JSON.stringify(ok).includes('ownerUid123'), false);
});

test('every mismatch or unknown state fails closed', () => {
  const cases = {
    'probe:no-errors': f => { f.errors = ['iam']; },
    'project:identity': f => { f.project.projectId = 'chronasense-staging-t018'; },
    'target:operator-and-no-firebaserc': f => { f.target.firebasercAbsent = false; },
    'functions:action-api-untouched': f => { f.functions[0].revision = 'chronasenseactionapi-00008-new'; },
    'artifact:pinned-candidate-sha': f => { f.artifact.sha = 'deadbeef'; },
    'functions:baseline': f => { f.functions.push({ name: 'chronasenseCompletionApi', state: 'ACTIVE', runtime: 'nodejs22' }); },
    'rules:phase-state': f => { f.rules.candidate.rules.rooms.$roomId['.write'] = true; },
    'rules:root-closed': f => { f.rules.live.rules['.write'] = true; f.rules.candidate.rules['.write'] = true; },
    'iam:single-owner': f => { f.iam.bindings[0].members.push('user:someone@example.org'); },
    'iam:editor-baseline-unchanged': f => { f.iam.bindings[1].members.push(`serviceAccount:${E.runtimeSA}`); },
    'iam:no-staging-principals': f => { f.iam.bindings.push({ role: 'roles/viewer', members: ['serviceAccount:x@chronasense-staging-t018.iam.gserviceaccount.com'] }); },
    'iam:no-public-project-bindings': f => { f.iam.bindings.push({ role: 'roles/viewer', members: ['allUsers'] }); },
    'identities:not-yet-created': f => { f.serviceAccounts.push(E.buildSA); },
    'auth:google-only': f => { f.auth.anonymousEnabled = true; },
    'auth:authorized-domains': f => { f.auth.authorizedDomains = ['shinyamadasan.github.io']; },
    'env:exact-keys': f => { f.env.values.EXTRA = '1'; },
    'env:completion-values': f => { f.env.values.CHRONASENSE_RTDB_URL = 'https://chronasense-staging-t018-default-rtdb.asia-southeast1.firebasedatabase.app'; },
    'env:action-api-params-match-live': f => { f.actionApiEnv.CHRONASENSE_OWNER_SUBJECT = 'different'; },
    'secret:available-metadata-only': f => { f.secret.enabledVersions = 0; },
    'artifact:matches-reviewed-sha': f => { f.artifact.mismatched = ['functions/index.js']; },
    'artifact:no-staging-config': f => { f.artifact.stagingHits = 1; },
    'artifact:outside-repo': f => { f.artifact.insideGitRepo = true; },
    'owner:account-timezone-present': f => { f.owner.timezone = null; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const facts = goodFacts(); mutate(facts);
    const result = evaluatePreflight(facts, 'before-identities');
    assert.equal(result.pass, false, name); assert.ok(failed(result).includes(name), `${name}: ${failed(result)}`);
  }
  for (const missing of ['project', 'iam', 'rules', 'auth', 'env', 'secret', 'artifact', 'owner', 'functions']) {
    const facts = goodFacts(); delete facts[missing];
    assert.equal(evaluatePreflight(facts, 'before-identities').pass, false, `missing ${missing}`);
  }
  assert.equal(evaluatePreflight(goodFacts(), 'after-everything').pass, false, 'unknown phase');
});

test('before-b1/b2 require exactly the planned identities, no impersonation, and the phase-correct rules state', () => {
  const f = goodFacts();
  f.target.account = E.operatorAccount;
  f.serviceAccounts = [E.runtimeSA, E.buildSA];
  f.customRoles = [{ name: E.customRole, includedPermissions: [...E.customRolePermissions] }];
  f.iam.bindings.push({ role: E.customRole, members: [`serviceAccount:${E.runtimeSA}`] },
    ...E.buildRoles.map(role => ({ role, members: [`serviceAccount:${E.buildSA}`] })));
  f.saPolicies = { [E.runtimeSA]: { etag: 'x' }, [E.buildSA]: { etag: 'y' } };
  assert.equal(evaluatePreflight(f, 'before-b1').pass, true, JSON.stringify(failed(evaluatePreflight(f, 'before-b1'))));
  assert.equal(evaluatePreflight(f, 'before-identities').pass, false);
  assert.ok(failed(evaluatePreflight(f, 'before-b2')).includes('rules:phase-state'), 'rules not yet deployed');
  const deployed = structuredClone(f); deployed.rules.live = structuredClone(deployed.rules.candidate);
  assert.equal(evaluatePreflight(deployed, 'before-b2').pass, true, JSON.stringify(failed(evaluatePreflight(deployed, 'before-b2'))));
  assert.ok(failed(evaluatePreflight(deployed, 'before-b1')).includes('rules:phase-state'), 'already deployed');
  const impersonable = structuredClone(f); impersonable.saPolicies[E.buildSA] = { bindings: [{ role: 'roles/iam.serviceAccountTokenCreator', members: ['user:x@y.z'] }] };
  assert.ok(failed(evaluatePreflight(impersonable, 'before-b1')).includes('identities:no-impersonation-bindings'));
  const unknownPolicy = structuredClone(f); delete unknownPolicy.saPolicies[E.runtimeSA];
  assert.ok(failed(evaluatePreflight(unknownPolicy, 'before-b1')).includes('identities:no-impersonation-bindings'));
  const extra = structuredClone(f); extra.iam.bindings.push({ role: 'roles/firebasedatabase.admin', members: [`serviceAccount:${E.runtimeSA}`] });
  assert.ok(failed(evaluatePreflight(extra, 'before-b1')).includes('identities:runtime-exactly-custom-role'));
  const broad = structuredClone(f); broad.customRoles[0].includedPermissions.push('iam.serviceAccounts.actAs');
  assert.ok(failed(evaluatePreflight(broad, 'before-b1')).includes('identities:custom-role-permissions'));
  const build = structuredClone(f); build.iam.bindings.find(b => b.role === 'roles/editor').members.push(`serviceAccount:${E.buildSA}`);
  assert.ok(failed(evaluatePreflight(build, 'before-b1')).includes('identities:build-exactly-planned-roles'));
});

test('rule diff and dotenv parsing', () => {
  assert.deepEqual(ruleDiff(live.rules, candidate.rules), ['rooms.$roomId.taskCompletionResolutions']);
  assert.deepEqual(ruleDiff(live.rules, live.rules), []);
  assert.deepEqual(parseEnv('A=1\r\n# c\nB = x=y\n'), { A: '1', B: 'x=y' });
});

test('artifact inspection is byte-exact against the reviewed commit and flags extras and staging config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chronasense-preflight-')), repo = join(dir, 'repo'), out = join(dir, 'out');
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' }).trim();
  try {
    mkdirSync(join(repo, 'functions'), { recursive: true });
    git('init', '-q'); git('config', 'user.email', 't@e.st'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'firebase.json'), '{}\n'); writeFileSync(join(repo, 'functions', 'index.js'), 'export {};\n');
    writeFileSync(join(repo, 'NOTES.md'), 'staging project chronasense-staging-t018 (docs only)\n');
    git('add', '.'); git('commit', '-qm', 'x'); const sha = git('rev-parse', 'HEAD');
    mkdirSync(out); execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', 'archive', sha, '-o', join(dir, 'a.tar')]);
    execFileSync('tar', ['-xf', 'a.tar', '-C', 'out'], { cwd: dir }); // relative: GNU tar reads "C:" as a host
    writeFileSync(join(out, 'functions', `.env.${E.projectId}`), 'K=v\n');
    const clean = inspectArtifact({ repo, sha, artifact: out });
    assert.deepEqual([clean.tracked, clean.missing.length, clean.mismatched.length, clean.unexpected.length, clean.stagingHits], [3, 0, 0, 0, 0], 'docs mentioning staging are not deploy inputs');
    writeFileSync(join(out, 'functions', 'index.js'), 'export {};\r\n');
    writeFileSync(join(out, 'functions', 'extra.js'), 'const p = "chronasense-staging-t018";\n');
    const dirty = inspectArtifact({ repo, sha, artifact: out });
    assert.deepEqual(dirty.mismatched, ['functions/index.js']); assert.deepEqual(dirty.unexpected, ['functions/extra.js']);
    assert.deepEqual(dirty.stagingFiles, ['functions/extra.js']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('alert policies: six reviewed conditions, completion service only, channel placeholder, privacy note', () => {
  const dir = new URL('./alerts/', import.meta.url);
  const files = readdirSync(dir).filter(f => /^0\d-.*\.json$/.test(f)).sort();
  assert.deepEqual(files, ['01-unconfirmed-write.json', '02-service-unavailable.json', '03-size-refusal.json', '04-contention.json', '05-latency.json', '06-http-5xx.json']);
  for (const file of files) {
    const policy = JSON.parse(readFileSync(new URL(file, dir), 'utf8')), text = JSON.stringify(policy);
    assert.deepEqual(policy.notificationChannels, ['NOTIFICATION_CHANNEL'], file);
    assert.equal(policy.conditions.length, 1, file);
    const condition = policy.conditions[0], filter = condition.conditionMatchedLog?.filter ?? condition.conditionThreshold.filter;
    assert.ok(/chronasensecompletionapi|logging\.googleapis\.com\/user\/completion_/.test(filter), `${file} scoped to completion`);
    assert.equal(/chronasenseActionApi|chronasenseactionapi/.test(text), false, `${file} must not target the Action API`);
    if (condition.conditionMatchedLog) assert.ok(policy.alertStrategy?.notificationRateLimit?.period, `${file} log alerts need a rate limit`);
    assert.equal(/@|uid_|ya29|AIza/.test(text), false, `${file} carries no identifiers`);
  }
  const channel = JSON.parse(readFileSync(new URL('channel-email.json', dir), 'utf8'));
  assert.equal(channel.labels.email_address, 'OWNER_EMAIL', 'no real address committed');
});

test('operator helper: exact argument contract; the mutating command needs the literal confirmation', async () => {
  const { parseOpsArgs, BUILD_SA_RESOURCE } = await import('./prod-ops.mjs');
  assert.deepEqual(parseOpsArgs(['env', '--artifact', 'D:/a']), { command: 'env', artifact: 'D:/a' });
  assert.deepEqual(parseOpsArgs(['snapshot', '--out', 'D:/s']), { command: 'snapshot', out: 'D:/s' });
  assert.deepEqual(parseOpsArgs(['patch-build-sa', '--confirm-production']), { command: 'patch-build-sa' });
  for (const bad of [['patch-build-sa'], ['patch-build-sa', '--confirm'], ['patch-build-sa', '--confirm-production', '--project', 'x'], ['deploy'], []]) {
    assert.throws(() => parseOpsArgs(bad), /usage/);
  }
  assert.equal(BUILD_SA_RESOURCE, `projects/${E.projectId}/serviceAccounts/${E.buildSA}`);
});
