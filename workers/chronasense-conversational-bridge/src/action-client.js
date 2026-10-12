// One typed tool call -> one signed Action API request. The backend owns every domain decision.
const SERVICE = 'chronasense-plugin-worker-v1';
const SIGNING_VERSION = 'chronasense-worker-auth-v1';
const PATH = '/v1/query';
const COMMAND_PATH = '/v1/command';
const MAX_RESPONSE_BYTES = 64 * 1024;
// The Function is capped at 120s. Leave 10s for its terminal response or network failure.
export const COMMAND_TIMEOUT_MS = 130_000;
const encoder = new TextEncoder();

function unknownCommandOutcome() {
  const error = new Error('The capture outcome is unknown; it may already be committed.');
  error.code = 'PENDING_UNKNOWN';
  return error;
}

const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

async function boundedBody(response) {
  const size = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) throw new Error('Action API response exceeds the contract limit.');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return bytes.subarray(0, length);
    if (length + value.length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Action API response exceeds the contract limit.');
    }
    bytes.set(value, length);
    length += value.length;
  }
}

function configuration(env) {
  const url = new URL(env.CHRONASENSE_ACTION_API_URL);
  if (url.protocol !== 'https:' || url.pathname !== PATH || url.search || url.hash || url.username || url.password) throw new Error('Action API URL is invalid.');
  const keyId = env.CHRONASENSE_WORKER_HMAC_KEY_ID;
  const secret = env.CHRONASENSE_WORKER_HMAC_KEY_HEX;
  if (typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId)
      || typeof secret !== 'string' || !/^(?:[0-9a-f]{2}){32,128}$/.test(secret)) throw new Error('Action API signing is not configured.');
  return { url: url.href, keyId, secret };
}

async function sendActionApi(env, { subject, scopes, kind, parameters, command }, deps = {}) {
  const { url, keyId, secret } = configuration(env);
  if (typeof subject !== 'string' || !/^[\x21-\x2b\x2d-\x7e]{1,256}$/.test(subject)) throw new Error('Owner subject is invalid.');
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope, index) =>
    !['chronasense:brain-dump.write', 'chronasense:read'].includes(scope) || (index > 0 && scopes[index - 1] >= scope))) throw new Error('Action scopes are invalid.');
  const path = command ? COMMAND_PATH : PATH;
  if (command ? !scopes.includes('chronasense:brain-dump.write') : !scopes.includes('chronasense:read')) throw new Error('The required action scope is missing.');
  const cryptoImpl = deps.cryptoImpl || globalThis.crypto;
  const requestId = (deps.randomUUID || (() => cryptoImpl.randomUUID()))();
  const timestamp = Math.floor((deps.now || Date.now)() / 1000);
  const body = JSON.stringify(command ? { ...command, requestId } : { contractVersion: 1, requestId, kind, parameters });
  const digest = hex(await cryptoImpl.subtle.digest('SHA-256', encoder.encode(body)));
  const message = [SIGNING_VERSION, keyId, SERVICE, 'POST', path, String(timestamp), requestId,
    subject, scopes.join(','), digest].join('\n');
  const keyBytes = Uint8Array.from(secret.match(/../g), pair => parseInt(pair, 16));
  const key = await cryptoImpl.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = hex(await cryptoImpl.subtle.sign('HMAC', key, encoder.encode(message)));
  const endpoint = command ? url.replace(/\/v1\/query$/, COMMAND_PATH) : url;
  let response;
  try { response = await (deps.fetchImpl || fetch)(endpoint, { method: 'POST', headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'x-chronasense-service': SERVICE,
    'x-chronasense-key-id': keyId,
    'x-chronasense-request-id': requestId,
    'x-chronasense-timestamp': String(timestamp),
    'x-chronasense-subject': subject,
    'x-chronasense-scopes': scopes.join(','),
    'x-chronasense-signature': signature,
  }, body, signal: AbortSignal.timeout(command ? COMMAND_TIMEOUT_MS : 10_000) }); }
  catch (error) {
    if (!command) throw error;
    throw unknownCommandOutcome();
  }
  let bytes;
  try { bytes = await boundedBody(response); }
  catch (error) {
    if (!command) throw error;
    throw unknownCommandOutcome();
  }
  let answer;
  try { answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch {
    if (command) throw unknownCommandOutcome();
    const error = new Error('Action API response is invalid.');
    throw error;
  }
  if (answer?.contractVersion !== 1 || answer.requestId !== requestId) {
    if (command) throw unknownCommandOutcome();
    const error = new Error('Action API response does not match the request.');
    throw error;
  }
  if (response.status === 200 && answer.kind === (command?.kind ?? kind) && answer.result && answer.authority) return answer;
  if (response.status !== 200 && answer.error?.code && typeof answer.error.message === 'string') {
    const error = new Error(answer.error.message);
    error.code = answer.error.code;
    throw error;
  }
  if (command) throw unknownCommandOutcome();
  throw new Error('Action API response is incompatible.');
}

export const queryActionApi = (env, input, deps) => sendActionApi(env, input, deps);
export const commandActionApi = (env, input, deps) => sendActionApi(env, { ...input, command: input.command }, deps);
