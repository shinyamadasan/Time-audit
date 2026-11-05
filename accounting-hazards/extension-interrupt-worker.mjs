// Real worker-process killpoints around the actual background producer, no network.
import fs from 'node:fs';
const [file, mode, uid] = process.argv.slice(2), start = 1000000, end = 1600000;
Date.now = () => mode === 'recover' ? end + 86400000 : end;
let store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
  uid, authToken: 'fixture', lastHeartbeat: end - 120000,
  activeTab: { ownerUid: uid, domain: 'github.com', url: 'https://github.com/local', title: 'Synthetic', startedAt: start, sessionId: start },
};
const persist = () => fs.writeFileSync(file, JSON.stringify(store)); persist();
let focus;
globalThis.chrome = {
  storage: { local: {
    async get(keys) { return Object.fromEntries((keys || Object.keys(store)).filter(k => Object.hasOwn(store, k)).map(k => [k, structuredClone(store[k])])); },
    async set(values) {
      if (mode === 'storage-failure' && Object.keys(values).some(k => k.startsWith('ta3-extension-writes-v1:'))) throw Error('simulated quota');
      Object.assign(store, structuredClone(values)); persist();
      if (mode === 'after-enqueue' && Object.keys(values).some(k => k.startsWith('ta3-extension-writes-v1:'))) process.exit(17);
      if (mode === 'after-merge' && Object.keys(values).some(k => k.startsWith('ta3-extension-merge:'))) process.exit(17);
    },
    async remove(keys) {
      if (mode === 'before-active-removal' && keys === 'activeTab') process.exit(17);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; persist();
    },
  } },
  runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
  tabs: { query(_options, callback) { callback([]); }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener(callback) { focus = callback; } } },
  idle: { setDetectionInterval() {}, onStateChanged: { addListener() {} } },
  alarms: { create() {}, onAlarm: { addListener() {} } }, notifications: { onButtonClicked: { addListener() {} } },
};
globalThis.fetch = async url => { if (!String(url).includes('/settings/timezone.json')) throw Error('Unexpected external request'); return { json: async () => null }; };
await import('../browser-extension/background.js');
await new Promise(resolve => setTimeout(resolve, 30));
if (mode !== 'recover') { focus(-1); await new Promise(resolve => setTimeout(resolve, 30)); }
persist();
