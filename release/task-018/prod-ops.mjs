// TASK-018 Gate B operator helpers for project time-audit-3c3da. Exact, repeatable, never print values or tokens.
//   node release/task-018/prod-ops.mjs env --artifact <dir>              READ-ONLY: write functions/.env.<project> from the LIVE Action API config
//   node release/task-018/prod-ops.mjs snapshot --out <dir>              READ-ONLY: IAM, secret IAM, Action API, rules, artifact-policy baselines
//   node release/task-018/prod-ops.mjs patch-build-sa --confirm-production  MUTATING (Gate B step 3c only): set the build identity
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED } from './prod-preflight.mjs';

const P = EXPECTED.projectId, REGION = EXPECTED.region;
const FUNCTION = `projects/${P}/locations/${REGION}/functions/${EXPECTED.completionFunction}`;
export const BUILD_SA_RESOURCE = `projects/${P}/serviceAccounts/${EXPECTED.buildSA}`;
const sh = { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32', timeout: 120000 };
const gcloud = args => execFileSync('gcloud', [...args, `--project=${P}`], sh);
const token = () => execFileSync('gcloud', ['auth', 'print-access-token'], sh).trim();
// curl config on stdin keeps the token out of argv; `extra` adds request/data lines for the single PATCH.
const curl = (url, extra = '') => execFileSync('curl', ['-s', '-f', '--max-time', '60', '-K', '-'], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 90000,
  stdio: ['pipe', 'pipe', 'inherit'], input: `header = "Authorization: Bearer ${token()}"\nheader = "x-goog-user-project: ${P}"\n${extra}url = "${url}"\n` });

/** Exact argument contract; the mutating command requires the literal confirmation flag. */
export function parseOpsArgs(argv) {
  const [command, ...rest] = argv, opt = name => rest[rest.indexOf(name) + 1];
  if (command === 'env' && rest.includes('--artifact')) return { command, artifact: opt('--artifact') };
  if (command === 'snapshot' && rest.includes('--out')) return { command, out: opt('--out') };
  if (command === 'patch-build-sa' && rest.length === 1 && rest[0] === '--confirm-production') return { command };
  throw new Error('usage: env --artifact <dir> | snapshot --out <dir> | patch-build-sa --confirm-production');
}

function writeEnv(artifact) {
  const file = join(artifact, 'functions', `.env.${P}`);
  if (existsSync(file)) throw new Error(`${file} exists; refusing to overwrite`);
  const live = JSON.parse(gcloud(['functions', 'describe', 'chronasenseActionApi', `--region=${REGION}`, '--format=json'])).serviceConfig.environmentVariables;
  const values = { CHRONASENSE_OWNER_SUBJECT: live.CHRONASENSE_OWNER_SUBJECT, CHRONASENSE_OWNER_FIREBASE_UID: live.CHRONASENSE_OWNER_FIREBASE_UID,
    CHRONASENSE_FIREBASE_WEB_API_KEY: live.CHRONASENSE_FIREBASE_WEB_API_KEY, CHRONASENSE_RTDB_URL: live.CHRONASENSE_RTDB_URL,
    CHRONASENSE_COMPLETION_SERVICE_ACCOUNT: EXPECTED.runtimeSA };
  if (Object.values(values).some(v => typeof v !== 'string' || !v)) throw new Error('live Action API config incomplete; refusing');
  writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  console.log(`wrote ${file} with keys ${Object.keys(values).join(', ')} (values not printed)`);
}

function snapshot(out) {
  mkdirSync(out, { recursive: true });
  const at = new Date().toISOString().replace(/[:.]/g, '-'), files = {
    [`iam-${at}.json`]: () => gcloud(['projects', 'get-iam-policy', P, '--format=json']),
    [`secret-iam-${at}.json`]: () => gcloud(['secrets', 'get-iam-policy', EXPECTED.secretName, '--format=json']),
    [`action-api-${at}.json`]: () => JSON.stringify((({ state, updateTime, serviceConfig, buildConfig }) => ({ state, updateTime,
      revision: serviceConfig?.revision, runtimeSA: serviceConfig?.serviceAccountEmail, build: buildConfig?.build, buildSA: buildConfig?.serviceAccount }))(
      JSON.parse(gcloud(['functions', 'describe', 'chronasenseActionApi', `--region=${REGION}`, '--format=json']))), null, 2),
    [`rules-${at}.json`]: () => curl(`${EXPECTED.rtdbUrl}/.settings/rules.json`),
    [`artifact-policy-${at}.json`]: () => gcloud(['artifacts', 'repositories', 'describe', 'gcf-artifacts', `--location=${REGION}`, '--format=json']),
  };
  for (const [name, read] of Object.entries(files)) {
    const data = read(); writeFileSync(join(out, name), data);
    console.log(`${name}  sha256 ${createHash('sha256').update(data).digest('hex').slice(0, 16)}`);
  }
}

function patchBuildServiceAccount() {
  const op = JSON.parse(curl(`https://cloudfunctions.googleapis.com/v2/${FUNCTION}?updateMask=buildConfig.serviceAccount`,
    `request = "PATCH"\nheader = "content-type: application/json"\ndata = "{\\"buildConfig\\":{\\"serviceAccount\\":\\"${BUILD_SA_RESOURCE}\\"}}"\n`));
  console.log(`operation ${op.name}`);
  for (let i = 0; i < 60; i++) {
    const state = JSON.parse(curl(`https://cloudfunctions.googleapis.com/v2/${op.name}`));
    if (state.done) {
      if (state.error) throw new Error(`build-identity switch FAILED: ${state.error.code}`);
      const fn = JSON.parse(gcloud(['functions', 'describe', EXPECTED.completionFunction, `--region=${REGION}`, '--format=json']));
      const ok = fn.buildConfig?.serviceAccount === BUILD_SA_RESOURCE && fn.serviceConfig?.serviceAccountEmail === EXPECTED.runtimeSA && fn.state === 'ACTIVE';
      console.log(`done: state ${fn.state}, build SA ${fn.buildConfig?.serviceAccount}, runtime SA ${fn.serviceConfig?.serviceAccountEmail}`);
      if (!ok) throw new Error('post-switch verification FAILED');
      return;
    }
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},15000)']);
  }
  throw new Error('operation did not finish within 15 minutes; check it before proceeding');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseOpsArgs(process.argv.slice(2));
  if (args.command === 'env') writeEnv(args.artifact);
  else if (args.command === 'snapshot') snapshot(args.out);
  else patchBuildServiceAccount();
}
