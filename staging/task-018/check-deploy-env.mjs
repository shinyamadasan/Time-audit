// Pre-deploy gate for the ONE deploy input outside the harness guard: functions/.env.<STAGING> in the disposable
// artifact. Refuses production markers, values not bound to the staging config, and artifacts inside a repo.
//   node staging/task-018/check-deploy-env.mjs --config STAGING_CONFIG.json --env D:\...\src\functions\.env.<STAGING>
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStagingConfig, PRODUCTION, StagingGuardError } from './guard.mjs';

const refuse = message => { throw new StagingGuardError(message); };

export function checkDeployEnv(config, envText, envPath) {
  const { databaseHost } = assertStagingConfig(config);
  if (PRODUCTION.dataPlaneMarkers.some(marker => envText.includes(marker))) refuse('deploy env references PRODUCTION');
  if (!envPath.endsWith(`.env.${config.projectId}`)) refuse('env file must be named .env.<staging projectId>');
  for (let dir = dirname(resolve(envPath)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(resolve(dir, '.git'))) refuse('deploy artifact must live outside any git repository');
  }
  const values = Object.fromEntries(envText.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
  const expected = {
    CHRONASENSE_RTDB_URL: `https://${databaseHost}`,
    CHRONASENSE_COMPLETION_SERVICE_ACCOUNT: `chronasense-completion@${config.projectId}.iam.gserviceaccount.com`,
    CHRONASENSE_FIREBASE_WEB_API_KEY: config.apiKey,
  };
  for (const [key, value] of Object.entries(expected)) if (values[key] !== value) refuse(`${key} is not the staging value`);
  for (const key of ['CHRONASENSE_OWNER_SUBJECT', 'CHRONASENSE_OWNER_FIREBASE_UID']) if (!values[key]) refuse(`${key} placeholder required by the shared entrypoint`);
  const allowed = new Set([...Object.keys(expected), 'CHRONASENSE_OWNER_SUBJECT', 'CHRONASENSE_OWNER_FIREBASE_UID']);
  const extra = Object.keys(values).filter(key => !allowed.has(key));
  if (extra.length) refuse(`unexpected deploy env keys: ${extra.length}`);
  return { ok: true, keys: Object.keys(values).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  console.log(JSON.stringify(checkDeployEnv(JSON.parse(readFileSync(arg('--config'), 'utf8')), readFileSync(arg('--env'), 'utf8'), arg('--env'))));
}
