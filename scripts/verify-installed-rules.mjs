#!/usr/bin/env node
// scripts/verify-installed-rules.mjs
//
// TASK-039 cutover tooling (contract "Corrected cutover order", steps 5 and 7). Never run by the app.
//   precheck  the rules file about to be installed hashes to the pinned capability hash (Stage B only)
//   verify    reads the INSTALLED rules back with an admin credential, compares them with the expected
//             stage file as canonical JSON, then runs the shipped capability proof plus legacy and
//             cross-account deny checks with one disposable account.
// The behavioural proof alone cannot tell the paired rules from a weaker set that passes the same
// three samples; the read-back comparison is the check that can. Exit code 0 only when every check
// passes. Credentials come from the environment and are never printed.
//
//   node scripts/verify-installed-rules.mjs precheck --rules firebase.rules.json
//   node scripts/verify-installed-rules.mjs verify --stage A|B --database-url <url> --probe-uid <uid>
//     env CHRONASENSE_RULES_ADMIN_BEARER  admin bearer for /.settings/rules.json (emulator: "owner")
//     env CHRONASENSE_PROBE_ID_TOKEN      ID token of the disposable probe account

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const sandbox = vm.createContext({ setTimeout, clearTimeout, AbortController, URL, crypto: globalThis.crypto, console });
for (const file of ['time-ack.js', 'accounting-command.js', 'accounting-capability.js'])
  vm.runInContext(readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
const { TimeAckCore, AccountingCommand, AccountingCapability } = sandbox;
export const PINNED_SHA256 = AccountingCapability.CAPABILITY.rulesSha256;

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const canonicalHash = rules => sha256(JSON.stringify(canonical(typeof rules === 'string' ? JSON.parse(rules) : rules)));

/** Stage A is the paired rules minus the cancellation sink, so every gate is live and clients stay unproven. */
export function stageRules(stage, pairedText) {
  const rules = JSON.parse(pairedText);
  if (stage === 'A') delete rules.rules.rooms.$roomId.timeAckCancellations;
  else if (stage !== 'B') throw Error(`Unknown stage ${stage}`);
  return rules;
}

export function precheck(text) {
  const actual = sha256(text);
  return { ok: actual === PINNED_SHA256, fileSha256: actual, pinnedSha256: PINNED_SHA256 };
}

function endpoint(databaseURL, at, auth) {
  const url = new URL(databaseURL);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${at}.json`;
  if (auth) url.searchParams.set('auth', auth);
  return url.toString();
}

/** Reads the installed rules. RTDB returns the stored source; it is compared as canonical JSON. */
export async function readInstalledRules({ databaseURL, adminBearer, fetchImpl = fetch }) {
  const response = await fetchImpl(endpoint(databaseURL, '.settings/rules'), { headers: { Authorization: `Bearer ${adminBearer}` }, cache: 'no-store' });
  const text = await response.text();
  if (response.status !== 200) throw Error(`Rules read-back refused (${response.status})`);
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  } catch { throw Error('Installed rules are not plain JSON (comments or other source); compare them by hand'); }
}

/** The shipped proof plus deny checks, all inside the disposable account (and one write to a room it does not own). */
export async function behaviour({ databaseURL, probeUid, probeToken, fetchImpl = fetch }) {
  const owner = `uid_${probeUid}`;
  const rest = () => TimeAckCore.createRestTransport({ databaseURL, getIdToken: async () => probeToken, fetchImpl });
  const transport = AccountingCapability.createTransport({ rest, coordinator: AccountingCommand });
  await transport.inspect(owner).catch(() => {});
  const write = async (at, value) => (await fetchImpl(endpoint(databaseURL, at, probeToken),
    { method: 'PUT', body: JSON.stringify(value), cache: 'no-store' })).status;
  // A well-formed legacy entry (key matches id) with no fence, so only the accounting gate can refuse it.
  const legacy = { id: 1, ts: 2000, tsStart: 1000, activity: 'rules verifier', updatedAt: 2000 };
  const statuses = {
    legacyEntry: await write(`rooms/${owner}/entries/e_1`, legacy),
    legacyTimer: await write(`rooms/${owner}/timer`, { running: false, stopped: true, updatedAt: 2000 }),
    otherAccount: await write(`rooms/uid_${probeUid}-other/timeAckCancellations/rules_verifier`, true),
    ownRead: (await fetchImpl(endpoint(databaseURL, `rooms/${owner}/timeAckCancellations`, probeToken), { cache: 'no-store' })).status,
  };
  const denied = status => status === 401 || status === 403;
  return { capability: transport.state(owner), legacyDenied: denied(statuses.legacyEntry) && denied(statuses.legacyTimer),
    otherAccountDenied: denied(statuses.otherAccount), ownReadAllowed: statuses.ownRead === 200, statuses };
}

/** Exact read-back plus behaviour for one stage. `ok` only when every check holds. */
export async function verify({ stage, databaseURL, adminBearer, probeUid, probeToken, pairedText, fetchImpl = fetch }) {
  const expected = stageRules(stage, pairedText);
  let installed;
  try { installed = await readInstalledRules({ databaseURL, adminBearer, fetchImpl }); }
  catch (error) { return { stage, ok: false, error: error.message }; }
  const result = { stage, expectedCanonicalSha256: canonicalHash(expected), installedCanonicalSha256: canonicalHash(installed),
    pairedFileSha256: sha256(pairedText) };
  result.exactMatch = result.expectedCanonicalSha256 === result.installedCanonicalSha256;
  result.pairedFilePinned = result.pairedFileSha256 === PINNED_SHA256;
  result.behaviour = await behaviour({ databaseURL, probeUid, probeToken, fetchImpl });
  const wantCapability = stage === 'B' ? 'proven' : 'incompatible';
  result.ok = result.exactMatch && result.pairedFilePinned && result.behaviour.capability === wantCapability
    && result.behaviour.legacyDenied && result.behaviour.otherAccountDenied && result.behaviour.ownReadAllowed;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
  const rulesFile = path.resolve(option('--rules') || path.join(root, 'firebase.rules.json'));
  const pairedText = readFileSync(rulesFile, 'utf8');
  let result;
  if (args[0] === 'precheck') result = precheck(pairedText);
  else if (args[0] === 'verify') {
    const adminBearer = process.env.CHRONASENSE_RULES_ADMIN_BEARER, probeToken = process.env.CHRONASENSE_PROBE_ID_TOKEN;
    if (!adminBearer || !probeToken || !option('--database-url') || !option('--probe-uid') || !option('--stage'))
      throw Error('verify needs --stage, --database-url, --probe-uid and both credential environment variables');
    result = await verify({ stage: option('--stage'), databaseURL: option('--database-url'), adminBearer,
      probeUid: option('--probe-uid'), probeToken, pairedText });
  } else throw Error('Usage: verify-installed-rules.mjs precheck|verify ...');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
