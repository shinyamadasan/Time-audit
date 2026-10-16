// TASK-018 disposable staging frontend: copy of the reviewed www/ closure with ONLY the public Firebase config replaced,
// written OUTSIDE the repository, then statically proven free of production data-plane identifiers.
//   node staging/task-018/frontend.mjs build  --config <staging-config.json> --out <dir outside repo>
//   node staging/task-018/frontend.mjs verify --config <staging-config.json> --out <dir>
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStagingConfig, PRODUCTION, StagingGuardError } from './guard.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PROD_CONFIG = `const firebaseConfig = {
  apiKey: "${PRODUCTION.apiKey}",
  authDomain: "${PRODUCTION.projectId}.firebaseapp.com",
  databaseURL: "https://${PRODUCTION.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "${PRODUCTION.projectId}"
};`;
const refuse = message => { throw new StagingGuardError(message); };
const files = dir => readdirSync(dir).flatMap(name => {
  const at = join(dir, name);
  return statSync(at).isDirectory() ? files(at) : [at];
});
const sha = data => createHash('sha256').update(data).digest('hex');

export function stagingConfigBlock(config) {
  return `const firebaseConfig = {
  apiKey: ${JSON.stringify(config.apiKey)},
  authDomain: ${JSON.stringify(config.authDomain)},
  databaseURL: ${JSON.stringify(config.databaseURL)},
  projectId: ${JSON.stringify(config.projectId)}
};`;
}

export function buildStagingFrontend({ config, out, source = join(REPO, 'www') }) {
  assertStagingConfig(config);
  const target = resolve(out), rel = relative(REPO, target);
  if (!rel.startsWith('..') && !rel.includes(':')) refuse('staging artifact must be written OUTSIDE the repository');
  if (existsSync(target) && readdirSync(target).length) refuse('output directory must be empty (disposable artifact)');
  const original = readFileSync(join(source, 'storage.js'), 'utf8'), eol = original.includes('\r\n') ? '\r\n' : '\n';
  const storage = original.replace(/\r\n/g, '\n');
  if (storage.split(PROD_CONFIG).length !== 2) refuse('expected exactly one production firebaseConfig block in www/storage.js');
  cpSync(source, target, { recursive: true });
  writeFileSync(join(target, 'storage.js'), storage.replace(PROD_CONFIG, stagingConfigBlock(config)).replace(/\n/g, eol));
  const manifest = Object.fromEntries(files(target).map(at => [relative(target, at).split(sep).join('/'), sha(readFileSync(at))]));
  writeFileSync(join(target, 'STAGING_MANIFEST.json'), JSON.stringify({ projectId: config.projectId, files: manifest }, null, 2));
  return verifyStagingFrontend({ config, out: target });
}

/** Static proof: no file references the production data plane; the only config is the staging one. */
export function verifyStagingFrontend({ config, out }) {
  const { endpoint } = assertStagingConfig(config);
  const report = { dataPlaneHits: [], staticHostRefs: [], configOk: false, endpoint, files: 0 };
  for (const at of files(resolve(out))) {
    report.files++;
    const text = readFileSync(at, 'utf8'), name = relative(out, at).split(sep).join('/');
    for (const marker of PRODUCTION.dataPlaneMarkers) if (text.includes(marker)) report.dataPlaneHits.push({ file: name, marker });
    for (const host of PRODUCTION.staticHosts) if (text.includes(host)) report.staticHostRefs.push(name);
  }
  const storage = readFileSync(join(out, 'storage.js'), 'utf8');
  report.configOk = storage.replace(/\r\n/g, '\n').includes(stagingConfigBlock(config)) && (storage.match(/const firebaseConfig = \{/g) || []).length === 1
    && storage.includes('https://asia-southeast1-${projectId}.cloudfunctions.net/chronasenseCompletionApi');
  report.ok = report.dataPlaneHits.length === 0 && report.configOk;
  if (!report.ok) throw Object.assign(new StagingGuardError('staging artifact is NOT isolated from production'), { report });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  const config = JSON.parse(readFileSync(arg('--config'), 'utf8'));
  const run = process.argv[2] === 'build' ? buildStagingFrontend : verifyStagingFrontend;
  console.log(JSON.stringify(run({ config, out: arg('--out') }), null, 2));
}
