// TASK-018 Gate B production PREFLIGHT. Strictly read-only: gcloud describe/list/get-iam-policy, RTDB rules and one
// settings field via REST GET, Identity Toolkit config GET, secret METADATA only. Never prints env or secret values.
// Fails closed: any missing fact, probe error or mismatch => FAIL.
//   node release/task-018/prod-preflight.mjs --phase <before-identities|before-b1|before-b2> --repo <git repo> --sha <candidate>
//        --artifact <disposable deploy dir> [--report out.json]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION } from '../../staging/task-018/guard.mjs';

const OPERATOR = process.env.CHRONASENSE_PROD_OPERATOR || '';
if (!OPERATOR) throw new Error('Set CHRONASENSE_PROD_OPERATOR to the owner Google account (never committed; this repo is public).');

export const EXPECTED = Object.freeze({
  projectId: PRODUCTION.projectId, projectNumber: '548433155531', region: 'asia-southeast1',
  rtdbUrl: `https://${PRODUCTION.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app`,
  webApiKey: PRODUCTION.apiKey,
  runtimeSA: `chronasense-completion@${PRODUCTION.projectId}.iam.gserviceaccount.com`,
  buildSA: `chronasense-build@${PRODUCTION.projectId}.iam.gserviceaccount.com`,
  customRole: `projects/${PRODUCTION.projectId}/roles/chronasenseCompletionRuntime`,
  customRolePermissions: ['firebaseauth.users.get', 'firebasedatabase.instances.get', 'firebasedatabase.instances.update'],
  buildRoles: ['roles/artifactregistry.writer', 'roles/cloudbuild.builds.builder', 'roles/logging.logWriter', 'roles/storage.objectViewer'],
  baselineFunctions: ['chronasenseActionApi'], completionFunction: 'chronasenseCompletionApi',
  // Reviewed release candidate (PR #7) and the live Action API revision observed read-only on 2026-10-16.
  candidateSha: '08e9371be7c56961a0c074e1041962adef4eac0c', actionApiRevision: 'chronasenseactionapi-00007-mon',
  // Operator identity comes from the environment and is never committed: this repository is public.
  // Export CHRONASENSE_PROD_OPERATOR=<owner Google account> before running any phase.
  operatorAccount: OPERATOR,
  ownerUser: `user:${OPERATOR}`,
  // Baseline Editor holders observed read-only on 2026-10-16; any change is a FAIL until re-baselined by the owner.
  editorBaseline: ['serviceAccount:548433155531-compute@developer.gserviceaccount.com', 'serviceAccount:548433155531@cloudservices.gserviceaccount.com',
    `serviceAccount:${PRODUCTION.projectId}@appspot.gserviceaccount.com`],
  stagingMarkers: ['chronasense-staging', '275857688303'],
  secretName: 'CHRONASENSE_WORKER_HMAC_KEYS',
  envKeys: ['CHRONASENSE_COMPLETION_SERVICE_ACCOUNT', 'CHRONASENSE_FIREBASE_WEB_API_KEY', 'CHRONASENSE_OWNER_FIREBASE_UID', 'CHRONASENSE_OWNER_SUBJECT', 'CHRONASENSE_RTDB_URL'],
  rulesDelta: 'rooms.$roomId.taskCompletionResolutions',
});
// before-identities: nothing created yet. before-b1: identities created, rules not yet deployed.
// before-b2: identities + rules deployed, backend not yet created. After B2 the runbook's manual verifications apply.
const PHASES = new Set(['before-identities', 'before-b1', 'before-b2']);

// ---------- pure evaluation (tested offline) ----------
const canonical = value => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
/** Paths (dot-joined) where two rule trees differ. */
export function ruleDiff(a, b, path = []) {
  if (canonical(a) === canonical(b)) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return [path.join('.')];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => ruleDiff(a[k], b[k], [...path, k]));
}
const isZone = zone => { try { return typeof zone === 'string' && !!zone && !!new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { return false; } };
const membersOf = (policy, member) => (policy?.bindings || []).filter(b => b.members?.includes(member)).map(b => b.role).sort();

export function evaluatePreflight(facts, phase, E = EXPECTED) {
  const checks = [];
  const check = (name, fn, detail) => {
    let ok = false, info = detail;
    try { const out = fn(); ok = out === true || out?.ok === true; if (out && typeof out === 'object' && out.info !== undefined) info = out.info; } catch { ok = false; info = 'unknown state (fact missing or malformed)'; }
    checks.push({ name, ok, ...(info !== undefined ? { info } : {}) });
  };
  check('phase:known', () => PHASES.has(phase));
  check('probe:no-errors', () => ({ ok: Array.isArray(facts.errors) && facts.errors.length === 0, info: (facts.errors || ['unknown']).join(',') || 'none' }));
  // Project identity and target
  check('project:identity', () => facts.project.projectId === E.projectId && String(facts.project.projectNumber) === E.projectNumber && facts.project.lifecycleState === 'ACTIVE');
  check('target:operator-and-no-firebaserc', () => facts.target.account === E.operatorAccount && facts.target.firebasercAbsent === true);
  // Functions baseline
  check('functions:baseline', () => {
    const names = facts.functions.map(f => f.name).sort();
    return { ok: canonical(names) === canonical(E.baselineFunctions), info: names.join(',') };
  });
  check('functions:action-api-untouched', () => {
    const f = facts.functions.find(x => x.name === 'chronasenseActionApi');
    return { ok: f?.state === 'ACTIVE' && f.runtime === 'nodejs22' && f.revision === E.actionApiRevision, info: f?.revision };
  });
  // Rules: before B1 the candidate differs from live ONLY by the resolution write-deny; from before-b2 on, live == candidate.
  check('rules:phase-state', () => {
    const diff = ruleDiff(facts.rules.live?.rules, facts.rules.candidate?.rules);
    const node = facts.rules.candidate?.rules?.rooms?.$roomId?.taskCompletionResolutions;
    if (canonical(node) !== canonical({ '.write': false })) return { ok: false, info: 'candidate lacks the resolution deny' };
    const expectDeployed = phase === 'before-b2';
    return { ok: expectDeployed ? diff.length === 0 && facts.rules.live.rules !== undefined : diff.length === 1 && diff[0] === E.rulesDelta,
      info: `${expectDeployed ? 'expect live == candidate' : 'expect exactly the resolution deny pending'}; diff: ${diff.join(' | ') || 'none'}` };
  });
  check('rules:root-closed', () => facts.rules.live.rules['.write'] === false && facts.rules.live.rules['.read'] === false);
  // IAM
  check('iam:single-owner', () => canonical(facts.iam.bindings.filter(b => b.role === 'roles/owner').flatMap(b => b.members).sort()) === canonical([E.ownerUser]));
  check('iam:editor-baseline-unchanged', () => canonical(facts.iam.bindings.filter(b => b.role === 'roles/editor').flatMap(b => b.members).sort()) === canonical([...E.editorBaseline].sort()));
  check('iam:no-staging-principals', () => !E.stagingMarkers.some(m => JSON.stringify(facts.iam).includes(m)));
  check('iam:no-public-project-bindings', () => !JSON.stringify(facts.iam.bindings).match(/allUsers|allAuthenticatedUsers/));
  // Intended identities: absent before creation; afterwards exactly the planned grants.
  const runtimeMember = `serviceAccount:${E.runtimeSA}`, buildMember = `serviceAccount:${E.buildSA}`;
  if (phase === 'before-identities') {
    check('identities:not-yet-created', () => !facts.serviceAccounts.includes(E.runtimeSA) && !facts.serviceAccounts.includes(E.buildSA)
      && !facts.customRoles.some(r => r.name === E.customRole)
      && membersOf(facts.iam, runtimeMember).length === 0 && membersOf(facts.iam, buildMember).length === 0);
  } else {
    check('identities:runtime-exactly-custom-role', () => facts.serviceAccounts.includes(E.runtimeSA) && canonical(membersOf(facts.iam, runtimeMember)) === canonical([E.customRole]));
    check('identities:custom-role-permissions', () => canonical([...(facts.customRoles.find(r => r.name === E.customRole)?.includedPermissions || [])].sort()) === canonical(E.customRolePermissions));
    check('identities:build-exactly-planned-roles', () => facts.serviceAccounts.includes(E.buildSA) && canonical(membersOf(facts.iam, buildMember)) === canonical(E.buildRoles));
    // Nobody is granted impersonation on the new accounts (the Owner's own actAs comes from Owner, not a binding).
    check('identities:no-impersonation-bindings', () => [E.runtimeSA, E.buildSA].every(sa => Array.isArray(facts.saPolicies[sa]?.bindings ?? []) && (facts.saPolicies[sa].bindings ?? []).length === 0));
  }
  // Auth configuration for the canary and the shipped web client
  check('auth:google-only', () => facts.auth.subtype === 'FIREBASE_AUTH' && facts.auth.googleEnabled === true && facts.auth.emailEnabled === false
    && facts.auth.anonymousEnabled === false && facts.auth.phoneEnabled === false);
  check('auth:authorized-domains', () => ['localhost', 'shinyamadasan.github.io'].every(d => facts.auth.authorizedDomains.includes(d)));
  // Deploy environment (values compared, never reported)
  check('env:exact-keys', () => canonical(Object.keys(facts.env.values).sort()) === canonical(E.envKeys));
  check('env:completion-values', () => facts.env.values.CHRONASENSE_RTDB_URL === E.rtdbUrl && facts.env.values.CHRONASENSE_FIREBASE_WEB_API_KEY === E.webApiKey
    && facts.env.values.CHRONASENSE_COMPLETION_SERVICE_ACCOUNT === E.runtimeSA);
  check('env:action-api-params-match-live', () => ['CHRONASENSE_OWNER_SUBJECT', 'CHRONASENSE_OWNER_FIREBASE_UID', 'CHRONASENSE_RTDB_URL', 'CHRONASENSE_FIREBASE_WEB_API_KEY']
    .every(k => typeof facts.env.values[k] === 'string' && facts.env.values[k].length > 0 && facts.env.values[k] === facts.actionApiEnv[k]));
  check('secret:available-metadata-only', () => facts.secret.name === E.secretName && facts.secret.enabledVersions >= 1);
  // Artifact: immutable, reviewed SHA, no staging configuration
  check('artifact:pinned-candidate-sha', () => ({ ok: facts.artifact.sha === E.candidateSha, info: facts.artifact.sha }));
  check('artifact:matches-reviewed-sha', () => ({ ok: facts.artifact.mismatched.length === 0 && facts.artifact.missing.length === 0 && facts.artifact.unexpected.length === 0 && facts.artifact.tracked > 0,
    info: `${facts.artifact.tracked} tracked; missing ${facts.artifact.missing.length}, changed ${facts.artifact.mismatched.length}, unexpected ${facts.artifact.unexpected.length}` }));
  check('artifact:no-staging-config', () => ({ ok: facts.artifact.stagingHits === 0, info: facts.artifact.stagingFiles?.join(",") || "deploy inputs clean" }));
  check('artifact:outside-repo', () => facts.artifact.insideGitRepo === false);
  // Owner account timezone (presence/validity only)
  check('owner:account-timezone-present', () => isZone(facts.owner.timezone), 'settings.timezone must exist and be a valid IANA zone');
  const pass = checks.every(c => c.ok);
  return { phase, pass, sha: facts.artifact?.sha ?? null, at: facts.at ?? null, checks };
}

// ---------- read-only fact collection ----------
const gitBlob = data => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest('hex');
function walk(dir, root = dir) {
  return readdirSync(dir).flatMap(name => {
    const at = join(dir, name);
    if (name === 'node_modules' || name === '.git') return [];
    return statSync(at).isDirectory() ? walk(at, root) : [relative(root, at).split(sep).join('/')];
  });
}
export function inspectArtifact({ repo, sha, artifact }) {
  const tree = execFileSync('git', ['-C', repo, 'ls-tree', '-r', sha], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .trim().split('\n').map(line => { const [meta, path] = line.split('\t'); return { path, blob: meta.split(' ')[2] }; });
  const tracked = new Map(tree.map(t => [t.path, t.blob]));
  const allowedExtra = new Set([`functions/.env.${EXPECTED.projectId}`]);
  const present = walk(artifact);
  const missing = [...tracked.keys()].filter(p => !existsSync(join(artifact, p)));
  const mismatched = [...tracked].filter(([p, blob]) => existsSync(join(artifact, p)) && gitBlob(readFileSync(join(artifact, p))) !== blob).map(([p]) => p);
  const unexpected = present.filter(p => !tracked.has(p) && !allowedExtra.has(p));
  // Staging configuration matters only in what is DEPLOYED: functions source + dotenv, firebase.json, rules, predeploy
  // scripts. Docs (e.g. TEST_REPORT.md evidence notes) may name the staging project and are never deployed.
  const deployed = p => p.startsWith('functions/') || p.startsWith('scripts/') || p === 'firebase.json' || p === 'firebase.rules.json';
  const stagingFiles = present.filter(deployed).filter(p => EXPECTED.stagingMarkers.some(m => readFileSync(join(artifact, p)).toString('latin1').includes(m)));
  const stagingHits = stagingFiles.length;
  let insideGitRepo = false;
  for (let d = resolve(artifact); ; d = resolve(d, '..')) { if (existsSync(join(d, '.git'))) { insideGitRepo = true; break; } if (resolve(d, '..') === d) break; }
  return { sha, tracked: tracked.size, missing, mismatched, unexpected, stagingHits, stagingFiles, insideGitRepo };
}
export function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}
function collect({ repo, sha, artifact }) {
  const P = EXPECTED.projectId, errors = [], facts = { errors, at: new Date().toISOString() };
  const run = (name, fn) => { try { return fn(); } catch { errors.push(name); return undefined; } };
  // gcloud is a .cmd shim on Windows (needs a shell). Arguments are fixed literals, the fixed project ID, region and
  // secret name, planned SA emails, and custom-role IDs from API output (GCP restricts those to [A-Za-z0-9_.]).
  const sh = { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32', timeout: 120000 };
  const gcloud = args => JSON.parse(execFileSync('gcloud', [...args, `--project=${P}`, '--format=json'], sh));
  const token = run('token', () => execFileSync('gcloud', ['auth', 'print-access-token'], sh).trim());
  // Token and URL go to curl on stdin (-K -), never argv, so they are not visible in the process list. GET only.
  const rest = url => JSON.parse(execFileSync('curl', ['-s', '-f', '--max-time', '30', '-K', '-'], { encoding: 'utf8', maxBuffer: 64 << 20,
    input: `header = "Authorization: Bearer ${token}"\nheader = "x-goog-user-project: ${P}"\nurl = "${url}"\n`, stdio: ['pipe', 'pipe', 'ignore'], timeout: 60000 }));
  facts.target = { account: run('account', () => execFileSync('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], sh).trim()),
    firebasercAbsent: !existsSync(join(artifact, '.firebaserc')) };
  facts.project = run('project', () => gcloud(['projects', 'describe', P]));
  facts.functions = run('functions', () => gcloud(['functions', 'list']).map(f => ({ name: f.name.split('/').pop(), state: f.state, runtime: f.buildConfig?.runtime, revision: f.serviceConfig?.revision })));
  facts.iam = run('iam', () => gcloud(['projects', 'get-iam-policy', P]));
  facts.serviceAccounts = run('serviceAccounts', () => gcloud(['iam', 'service-accounts', 'list']).map(a => a.email));
  facts.saPolicies = Object.fromEntries([EXPECTED.runtimeSA, EXPECTED.buildSA].filter(sa => facts.serviceAccounts?.includes(sa))
    .map(sa => [sa, run(`saPolicy:${sa.split('@')[0]}`, () => gcloud(['iam', 'service-accounts', 'get-iam-policy', sa]))]));
  facts.customRoles = run('customRoles', () => gcloud(['iam', 'roles', 'list']).map(r => ({ name: r.name, includedPermissions: (run(`role:${r.name}`, () => gcloud(['iam', 'roles', 'describe', r.name.split('/').pop()])) || {}).includedPermissions })));
  facts.rules = { live: run('rules', () => rest(`${EXPECTED.rtdbUrl}/.settings/rules.json`)), candidate: run('candidateRules', () => JSON.parse(readFileSync(join(artifact, 'firebase.rules.json'), 'utf8'))) };
  facts.auth = run('auth', () => {
    const config = rest(`https://identitytoolkit.googleapis.com/admin/v2/projects/${P}/config`);
    const idps = rest(`https://identitytoolkit.googleapis.com/admin/v2/projects/${P}/defaultSupportedIdpConfigs`);
    return { subtype: config.subtype, emailEnabled: config.signIn?.email?.enabled === true, anonymousEnabled: config.signIn?.anonymous?.enabled === true,
      phoneEnabled: config.signIn?.phoneNumber?.enabled === true, authorizedDomains: config.authorizedDomains || [],
      googleEnabled: (idps.defaultSupportedIdpConfigs || []).some(i => i.name.endsWith('/google.com') && i.enabled) };
  });
  facts.env = run('env', () => ({ values: parseEnv(readFileSync(join(artifact, 'functions', `.env.${P}`), 'utf8')) }));
  facts.actionApiEnv = run('actionApiEnv', () => gcloud(['functions', 'describe', 'chronasenseActionApi', `--region=${EXPECTED.region}`]).serviceConfig.environmentVariables);
  facts.secret = run('secret', () => ({ name: gcloud(['secrets', 'describe', EXPECTED.secretName]).name.split('/').pop(),
    enabledVersions: gcloud(['secrets', 'versions', 'list', EXPECTED.secretName]).filter(v => v.state === 'ENABLED').length }));
  facts.artifact = run('artifact', () => inspectArtifact({ repo, sha, artifact }));
  facts.owner = run('ownerTimezone', () => {
    const uid = facts.env?.values?.CHRONASENSE_OWNER_FIREBASE_UID;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid || '')) throw new Error('owner uid');
    return { timezone: rest(`${EXPECTED.rtdbUrl}/rooms/uid_${uid}/settings/timezone.json`) };
  });
  return facts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  const result = evaluatePreflight(collect({ repo: arg('--repo'), sha: arg('--sha'), artifact: arg('--artifact') }), arg('--phase'));
  const lines = result.checks.map(c => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? `  (${c.info})` : ''}`);
  console.log(`${lines.join('\n')}\nPREFLIGHT ${result.pass ? 'PASS' : 'FAIL'} (${result.phase})`);
  if (process.argv.includes('--report')) writeFileSync(arg('--report'), JSON.stringify(result, null, 2));
  process.exitCode = result.pass ? 0 : 1;
}
