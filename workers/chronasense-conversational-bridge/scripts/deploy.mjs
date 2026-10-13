// workers/chronasense-conversational-bridge/scripts/deploy.mjs
//
// The ONE reviewed way to deploy this Worker (TASK-012 deployment safety; CHANGELOG TASK-011 rollout incident).
// A plain `wrangler deploy` deletes every plaintext var not declared in wrangler.jsonc, and `--keep-vars` alone did
// not preserve the externally managed ones during the TASK-011 rollout: /authorize broke. This wrapper makes the
// five environment-specific plaintext bindings an explicit, validated input of EVERY deploy:
//
//   - they come from an untracked local JSON file (default `.deploy-vars.json`, gitignored; never committed, never
//     printed) holding exactly REQUIRED_PLAINTEXT_BINDINGS, each shape-checked like the Worker itself checks it;
//   - the secret (CHRONASENSE_WORKER_HMAC_KEY_HEX) must NOT be in that file: it stays a Cloudflare secret, and
//     `wrangler deploy` keeps secrets;
//   - each value is passed as `--var NAME:value`, so the new version always carries all five (no reliance on
//     `--keep-vars`, no production value in source);
//   - without `--confirm` it is a dry run that prints the plan with every value redacted and runs nothing.
//
// Usage (from this directory):
//   node scripts/deploy.mjs [--vars <file>]              # validate + print the redacted plan
//   node scripts/deploy.mjs [--vars <file>] --dry-run    # also `wrangler deploy --dry-run` (compile only)
//   node scripts/deploy.mjs [--vars <file>] --confirm    # deploy (owner-authorized production action)
// After a real deploy, verify the bindings in the new version (dashboard or `wrangler versions view`) and /authorize.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUIRED_PLAINTEXT_BINDINGS = Object.freeze([
  'ACCESS_TEAM_DOMAIN', 'ACCESS_POLICY_AUD', 'CHRONASENSE_OWNER_SUBJECT', 'CHRONASENSE_ACTION_API_URL', 'CHRONASENSE_WORKER_HMAC_KEY_ID',
]);
/** Kept as Cloudflare secrets; refused in the vars file so a secret can never become a plaintext var. */
export const SECRET_BINDINGS = Object.freeze(['CHRONASENSE_WORKER_HMAC_KEY_HEX']);

const httpsOrigin = value => { try { const url = new URL(value); return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password && value === url.origin; } catch { return false; } };
const SHAPES = Object.freeze({
  ACCESS_TEAM_DOMAIN: httpsOrigin,
  ACCESS_POLICY_AUD: value => /^[A-Za-z0-9_-]{8,128}$/.test(value),
  CHRONASENSE_OWNER_SUBJECT: value => /^[\x21-\x2b\x2d-\x7e]{1,256}$/.test(value),
  CHRONASENSE_ACTION_API_URL: value => { try { const url = new URL(value); return url.protocol === 'https:' && url.pathname === '/v1/query' && !url.search && !url.hash && !url.username && !url.password; } catch { return false; } },
  CHRONASENSE_WORKER_HMAC_KEY_ID: value => /^[A-Za-z0-9_-]{1,64}$/.test(value),
});

/** @returns {string[]} every problem with the vars object (names only, never values); empty means deployable. */
export function bindingProblems(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return ['the vars file must be a JSON object'];
  const problems = [];
  for (const name of Object.keys(vars)) {
    if (SECRET_BINDINGS.includes(name)) problems.push(`${name} is a secret: keep it in Cloudflare secrets, not in the vars file`);
    else if (!REQUIRED_PLAINTEXT_BINDINGS.includes(name)) problems.push(`unexpected binding ${name}`);
  }
  for (const name of REQUIRED_PLAINTEXT_BINDINGS) {
    if (!Object.hasOwn(vars, name)) problems.push(`missing required binding ${name}`);
    else if (typeof vars[name] !== 'string' || vars[name] !== vars[name].trim() || !SHAPES[name](vars[name])) problems.push(`invalid value for ${name}`);
  }
  return problems;
}

/** The exact wrangler argv: every required binding passed explicitly; never --keep-vars. */
export function wranglerArgs(vars, { dryRun = false } = {}) {
  const problems = bindingProblems(vars);
  if (problems.length) throw new Error(`Refusing to deploy: ${problems.join('; ')}`);
  return ['deploy', ...REQUIRED_PLAINTEXT_BINDINGS.flatMap(name => ['--var', `${name}:${vars[name]}`]), ...(dryRun ? ['--dry-run', '--outdir', '.wrangler-dist'] : [])];
}

/** The plan as printed: names kept, every value redacted. */
export const redacted = args => args.map(arg => (/^[A-Z_]+:/.test(arg) ? `${arg.slice(0, arg.indexOf(':'))}:<redacted>` : arg));

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const flag = name => argv.includes(name);
  const varsAt = argv.includes('--vars') ? argv[argv.indexOf('--vars') + 1] : path.join(here, '..', '.deploy-vars.json');
  let vars;
  try { vars = JSON.parse(readFileSync(varsAt, 'utf8')); }
  catch { console.error(`Refusing to deploy: cannot read the vars file (${path.basename(varsAt)}). See README "Deployment".`); return 2; }
  let args;
  try { args = wranglerArgs(vars, { dryRun: !flag('--confirm') && flag('--dry-run') }); }
  catch (error) { console.error(error.message); return 2; }
  console.log(`wrangler ${redacted(args).join(' ')}`);
  if (!flag('--confirm') && !flag('--dry-run')) { console.log('Plan only. Add --dry-run to compile, or --confirm to deploy.'); return 0; }
  // Wrangler's own entry point under this Node, never through a shell: a value is one argv element, never re-parsed.
  const wrangler = path.join(here, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: path.join(here, '..'), stdio: 'inherit' });
  if (result.status === 0 && flag('--confirm')) console.log('Deployed. Now verify all five bindings on the new version and that /authorize renders.');
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
