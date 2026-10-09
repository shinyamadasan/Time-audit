// One typed tool call -> one signed Action API query. The backend owns every domain decision.
const SERVICE = 'chronasense-plugin-worker-v1';
const SIGNING_VERSION = 'chronasense-worker-auth-v1';
const PATH = '/v1/query';
const MAX_RESPONSE_BYTES = 64 * 1024;
const encoder = new TextEncoder();

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

export async function queryActionApi(env, { subject, scopes, kind, parameters }, deps = {}) {
  const { url, keyId, secret } = configuration(env);
  if (typeof subject !== 'string' || !/^[\x21-\x2b\x2d-\x7e]{1,256}$/.test(subject)) throw new Error('Owner subject is invalid.');
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'chronasense:read') throw new Error('Read scope is required.');
  const cryptoImpl = deps.cryptoImpl || globalThis.crypto;
  const requestId = (deps.randomUUID || (() => cryptoImpl.randomUUID()))();
  const timestamp = Math.floor((deps.now || Date.now)() / 1000);
  const body = JSON.stringify({ contractVersion: 1, requestId, kind, parameters });
  const digest = hex(await cryptoImpl.subtle.digest('SHA-256', encoder.encode(body)));
  const message = [SIGNING_VERSION, keyId, SERVICE, 'POST', PATH, String(timestamp), requestId,
    subject, scopes.join(','), digest].join('\n');
  const keyBytes = Uint8Array.from(secret.match(/../g), pair => parseInt(pair, 16));
  const key = await cryptoImpl.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = hex(await cryptoImpl.subtle.sign('HMAC', key, encoder.encode(message)));
  const response = await (deps.fetchImpl || fetch)(url, { method: 'POST', headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'x-chronasense-service': SERVICE,
    'x-chronasense-key-id': keyId,
    'x-chronasense-request-id': requestId,
    'x-chronasense-timestamp': String(timestamp),
    'x-chronasense-subject': subject,
    'x-chronasense-scopes': scopes.join(','),
    'x-chronasense-signature': signature,
  }, body, signal: AbortSignal.timeout(10000) });
  const bytes = await boundedBody(response);
  let answer;
  try { answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Action API response is invalid.'); }
  if (answer?.contractVersion !== 1 || answer.requestId !== requestId) throw new Error('Action API response does not match the request.');
  if (response.status === 200 && answer.kind === kind && answer.result && answer.authority) return answer;
  if (response.status !== 200 && answer.error?.code && typeof answer.error.message === 'string') {
    const error = new Error(answer.error.message);
    error.code = answer.error.code;
    throw error;
  }
  throw new Error('Action API response is incompatible.');
}
