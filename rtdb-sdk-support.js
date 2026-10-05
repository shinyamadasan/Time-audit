// rtdb-sdk-support.js
//
// Test-only (never loaded by index.html). Real Firebase JS SDK connections (the compat build, exactly
// what index.html loads from the CDN, pinned to the same 10.12.2) against the REAL RTDB emulator
// (rtdb-emulator-support.js), each one an independent websocket with its own auth. Two of these are
// two devices; neither shares a cache or an event loop ordering with the other, which is what the
// write-first / revoke-first ordering proof needs and a REST-only test cannot give.

import firebase from 'firebase/compat/app';
import 'firebase/compat/database';
import { token } from './rtdb-emulator-support.js';

firebase.setLogLevel('silent'); // the SDK logs every rule denial; the tests assert them instead
let seq = 0;

/** @param {{port:number}} emulator @param {{name:string}} db an emulator.fresh() namespace @param {{uid?:string}} [options]
 *  @returns {{app:object, db:object, roomRef:(room?:string)=>object, ref:(path:string)=>object, offline:()=>void, online:()=>void, close:()=>Promise<void>}} */
export function connectSdk(emulator, db, { uid = 'alice' } = {}) {
  const app = firebase.initializeApp({ databaseURL: `http://127.0.0.1:${emulator.port}?ns=${db.name}`, projectId: 'demo-fence' }, `conn-${++seq}-${Date.now()}`);
  const database = app.database();
  database.useEmulator('127.0.0.1', emulator.port, { mockUserToken: token(uid) });
  return {
    app,
    db: database,
    ref: path => database.ref(path),
    roomRef: (room = `uid_${uid}`) => database.ref(`rooms/${room}`),
    offline: () => database.goOffline(),
    online: () => database.goOnline(),
    close: () => app.delete(),
  };
}
