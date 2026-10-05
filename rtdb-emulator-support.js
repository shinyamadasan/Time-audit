// rtdb-emulator-support.js
//
// Test-only (never loaded by index.html). Boots the REAL Firebase Realtime Database
// emulator jar and hands out isolated namespaces loaded with a rules document, driven over
// REST with unsigned emulator auth tokens (`?auth=`), the emulator's own testing contract.
// Shared by the rules matrix, the mutation tests and the two-SDK ordering test, so they all
// speak to the same emulator the same way.
//
// Needs Java and the cached emulator jar (firebase-tools' cache, or
// FIREBASE_DATABASE_EMULATOR_JAR). It FAILS (never silently skips) when either is missing:
// a fence that was not exercised is not proven.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

export const JAR = process.env.FIREBASE_DATABASE_EMULATOR_JAR
  || path.join(os.homedir(), '.cache', 'firebase', 'emulators', 'firebase-database-emulator-v4.11.2.jar');

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
/** An unsigned JWT the emulator accepts as `auth` (uid becomes auth.uid inside the rules). */
export const token = uid => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: uid, user_id: uid, uid, iat: 1, exp: 9999999999, aud: 'demo', iss: 'https://securetoken.google.com/demo', auth_time: 1, firebase: { sign_in_provider: 'custom' } })}.`;
export const ALICE = token('alice');
export const MALLORY = token('mallory');
export const ROOM = 'rooms/uid_alice';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

/** @returns {Promise<{base:string, port:number, stop:()=>void, fresh:(rules:string|object)=>Promise<object>}>} */
export async function startEmulator() {
  assert.ok(existsSync(JAR), `the RTDB emulator jar is required (looked for ${JAR}); set FIREBASE_DATABASE_EMULATOR_JAR`);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const emulator = spawn('java', ['-jar', JAR, '--port', String(port)], { stdio: 'ignore' });
  emulator.on('error', err => { throw new Error(`java could not start the emulator: ${err.message}`); });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { up = (await fetch(`${base}/.json?ns=boot`)).ok; } catch { /* not up yet */ }
    if (!up) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!up) { emulator.kill(); throw new Error('the RTDB emulator did not come up'); }
  let ns = 0;

  /** A fresh, isolated namespace loaded with `rules` (the REAL firebase.rules.json by default). */
  async function fresh(rules) {
    const name = `fence${++ns}x${Date.now()}`;
    const body = typeof rules === 'string' ? rules : JSON.stringify(rules);
    const loaded = await fetch(`${base}/.settings/rules.json?ns=${name}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body });
    assert.equal(loaded.status, 200, `rules load: ${await loaded.text()}`);
    const call = (method, at, value, auth) => fetch(`${base}/${at}.json?ns=${name}${auth ? `&auth=${auth}` : ''}`, {
      method, headers: auth ? undefined : { Authorization: 'Bearer owner' }, body: value === undefined ? undefined : JSON.stringify(value),
    });
    return {
      name,
      /** As the room owner (or `as`): true iff the server ALLOWED the write. */
      async write(at, value, as = ALICE) { return (await call('PUT', at, value, as)).status === 200; },
      /** A multi-path update (PATCH) as the owner: true iff allowed. */
      async patch(at, value, as = ALICE) { return (await call('PATCH', at, value, as)).status === 200; },
      /** Seeds data as an admin (bypassing rules), to set up the starting state. */
      async seed(at, value) { const r = await call('PUT', at, value, null); assert.equal(r.status, 200, `seed ${at}: ${await r.text()}`); },
      async read(at) { const r = await call('GET', at, undefined, null); return r.json(); },
    };
  }
  return { base, port, stop: () => emulator.kill(), fresh };
}
