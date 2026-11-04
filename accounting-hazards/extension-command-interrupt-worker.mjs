// Separate process, actual outbox/REST transport and loopback RTDB. Each exit is unrecoverable in this process.
import fs from 'node:fs';
import { createPendingWrites, createExtensionTransport } from '../browser-extension/pending-writes.js';
import { token } from '../rtdb-emulator-support.js';
const [file, mode, uid, databaseURL] = process.argv.slice(2);
if (new URL(databaseURL).hostname !== '127.0.0.1') throw Error('Loopback only');
const end = 1600000, values = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
Date.now = () => end + (mode === 'recover' ? 86400000 : 0);
const persist = () => fs.writeFileSync(file, JSON.stringify(values));
const stop = point => {
  if (mode !== point) return;
  values.__interrupted = point; persist();
  process.kill(process.pid, 'SIGKILL');
};
const storage = {
  async get(key) { return values[key] ?? null; },
  async keys(prefix) { return Object.keys(values).filter(key => key.startsWith(prefix)); },
  async remove(key) { delete values[key]; persist(); stop('after-intake-removal'); },
  async set(key, raw) {
    values[key] = raw; persist();
    if (key.startsWith('ta3-extension-capture-v1:')) stop('after-capture');
    if (!key.startsWith('ta3-extension-writes-v1:')) return;
    const state = JSON.parse(raw), op = state.queue[0];
    if (op?.phase === 'captured') stop('after-import');
    if (op?.phase === 'intent' && !op.etag) stop('after-seal');
    if (op?.phase === 'intent' && op.etag) stop('after-etag');
    if (op?.phase === 'pending') stop('after-pending');
    if (state.history.some(item => item.phase === 'accepted')) stop('after-accepted-save');
  },
};
const context = { uid, owner: `uid_${uid}`, device: 'proof-device', generation: 1 };
const actual = createExtensionTransport({ databaseURL, identity: () => context, getToken: async () => token(uid),
  fetchImpl: async (url, options) => {
    if (new URL(url).hostname !== '127.0.0.1') throw Error('Loopback only');
    const response = await fetch(url, options);
    if (options.method === 'PUT') {
      values.__writes = [...(values.__writes || []), { bytes: options.body, etag: options.headers['If-Match'] }]; persist();
      if (response.status === 200) stop('after-server-commit');
    }
    return response;
  } });
const queue = createPendingWrites({ storage, transport: { ...actual, enforcesPhysicalIdentity: true }, identity: () => context,
  randomId: () => 'extension_original' });
if (mode !== 'recover') await queue.enqueue(uid, { id: 1000000, tsStart: 1000000, ts: end, updatedAt: end,
  blockIntervalMin: 10, date: '2026-10-28', activity: 'Original interval', energy: 'deep', source: 'browser-extension' });
const result = await queue.drain(uid);
if (result.phase !== 'accepted') throw Error(JSON.stringify(result));
persist();
