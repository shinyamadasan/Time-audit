// Household My Day V1 — local authenticated test environment (test/preview only; never shipped).
//
//   ChronaSense : the REAL RTDB emulator loaded with the REAL firebase.rules.json. Each browser is
//                 an emulator-authenticated identity (unsigned emulator token), so the reciprocal
//                 partner rules are enforced exactly as in production.
//   Meal Prep   : the REAL Meal Prep Auth + Firestore emulators (project demo-meal-prep) running
//                 Meal Prep's own firestore.rules from the recovered Meal Prep checkout. The page
//                 signs in to Meal Prep Auth with email/password like the Meal Prep app does.
//
// Everything is loopback. The served page has a CSP that only allows loopback connections, the SDK
// is served locally, and no production configuration exists anywhere in this harness.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startEmulator, token} from '../rtdb-emulator-support.js';
import {computeClosure} from '../scripts/runtime-mirror.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = 'http://127.0.0.1';
export const MEAL = {project: 'demo-meal-prep', authPort: 9099, firestorePort: 8080, password: 'ourlife-local-1',
  dir: process.env.MEAL_PREP_TEST_HOSTING || ''};
export const PEOPLE = {
  me: {uid: 'cs-me', email: 'shin@household.test', displayName: 'Shin (demo)', tasks: [
    ['Write the project brief', '09:30', 'priority'], ['Review the budget', '', 'priority'], ['Call the bank', '14:00', 'priority'],
    ['Water the plants', '', 'task'], ['Book dentist appointment', '', 'task']]},
  alyssa: {uid: 'cs-alyssa', email: 'alyssa@household.test', displayName: 'Alyssa (demo)', tasks: [
    ['Pick up groceries', '17:00', 'priority'], ['Finish the presentation', '', 'priority'], ['Book the vet', '', 'priority'],
    ['Read a chapter', '', 'task'], ['Sort the laundry', '', 'task']], done: ['Book the vet']},
};

const localDate = (offsetDays = 0) => {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const FOOD = {
  me: () => ({updatedAt: new Date().toISOString(), version: 1, recipes: [], preparedFlavors: [], mealConsumptions: [],
    cookedMeals: [
      {id: 'm1', name: 'Chicken and rice', cookedDate: localDate(0), storage: 'fridge', fridgeLife: 4, freezerLife: 60, initialPortions: 4, portionsRemaining: 4},
      {id: 'm2', name: 'Lentil curry', cookedDate: localDate(-3), storage: 'fridge', fridgeLife: 4, freezerLife: 60, initialPortions: 3, portionsRemaining: 1},
      {id: 'm3', name: 'Vegetable soup', cookedDate: localDate(-2), storage: 'freezer', fridgeLife: 4, freezerLife: 60, initialPortions: 4, portionsRemaining: 2},
      {id: 'm4', name: 'Old pasta bake', cookedDate: localDate(-8), storage: 'fridge', fridgeLife: 4, freezerLife: 60, initialPortions: 4, portionsRemaining: 2},
      {id: 'm5', name: 'Finished stew', cookedDate: localDate(-1), storage: 'fridge', fridgeLife: 4, freezerLife: 60, initialPortions: 4, portionsRemaining: 0}],
    pantry: [
      {id: 'p1', name: 'Rice', quantity: 2, unit: 'kg', category: 'Grains', purchaseDate: localDate(-5), storage: 'pantry'},
      {id: 'p2', name: 'Eggs', quantity: 6, unit: 'pieces', category: 'Protein', purchaseDate: localDate(-2), storage: 'fridge'},
      {id: 'p3', name: 'Spinach', quantity: 1, unit: 'bag', category: 'Vegetables', purchaseDate: localDate(-1), storage: 'fridge'},
      {id: 'p4', name: 'Used-up flour', quantity: 0, unit: 'kg', category: 'Baking', purchaseDate: localDate(-30), storage: 'pantry'}]}),
  alyssa: () => ({updatedAt: new Date().toISOString(), version: 1, recipes: [], preparedFlavors: [], mealConsumptions: [],
    cookedMeals: [{id: 'a1', name: 'Overnight oats', cookedDate: localDate(0), storage: 'fridge', fridgeLife: 3, freezerLife: 30, initialPortions: 2, portionsRemaining: 2}],
    pantry: [{id: 'a2', name: 'Milk', quantity: 1, unit: 'L', category: 'Dairy', purchaseDate: localDate(-1), storage: 'fridge'}]}),
};

// ── Meal Prep emulators ──────────────────────────────────────────────────────
const up = async url => { try { await fetch(url); return true; } catch { return false; } };
async function ensureMealEmulators() {
  if (await up(`${LOCAL}:${MEAL.authPort}/`) && await up(`${LOCAL}:${MEAL.firestorePort}/`)) return null;
  if (!MEAL.dir || !existsSync(path.join(MEAL.dir, 'firebase.local.json'))) throw new Error(`Meal Prep emulator config not found${MEAL.dir ? ` in ${MEAL.dir}` : ''}: set MEAL_PREP_TEST_HOSTING to Meal Prep's test-hosting folder`);
  const child = spawn('firebase', ['emulators:start', '--config', 'firebase.local.json', '--only', 'auth,firestore', '--project', MEAL.project],
    {cwd: MEAL.dir, shell: true, stdio: 'ignore'});
  for (let i = 0; i < 240; i++) {
    if (await up(`${LOCAL}:${MEAL.authPort}/`) && await up(`${LOCAL}:${MEAL.firestorePort}/`)) return child;
    await new Promise(r => setTimeout(r, 500));
  }
  child.kill(); throw new Error('Meal Prep emulators did not start');
}
async function mealJson(url, init) {
  if (!url.startsWith(`${LOCAL}:`)) throw new Error('loopback only');
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return {ok: response.ok, status: response.status, body};
}
export async function mealSignIn(email) {
  const key = 'demo-local';
  const base = `${LOCAL}:${MEAL.authPort}/identitytoolkit.googleapis.com/v1/accounts`;
  const json = {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password: MEAL.password, returnSecureToken: true})};
  let r = await mealJson(`${base}:signInWithPassword?key=${key}`, json);
  if (!r.ok) r = await mealJson(`${base}:signUp?key=${key}`, json);
  if (!r.ok) throw new Error(`Meal Prep auth emulator: ${JSON.stringify(r.body)}`);
  return {uid: r.body.localId, idToken: r.body.idToken};
}
const fsValue = v => v === null || v === undefined ? {nullValue: null} : typeof v === 'string' ? {stringValue: v} : typeof v === 'boolean' ? {booleanValue: v}
  : typeof v === 'number' ? (Number.isInteger(v) ? {integerValue: String(v)} : {doubleValue: v}) : Array.isArray(v) ? {arrayValue: {values: v.map(fsValue)}}
    : {mapValue: {fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fsValue(x)]))}};
const docUrl = p => `${LOCAL}:${MEAL.firestorePort}/v1/projects/${MEAL.project}/databases/(default)/documents/${p}`;
/** Admin write (emulator owner bypass) — stands in for the Meal Prep app saving its own document. */
export async function mealPut(uid, data, fields) {
  const mask = fields ? '?' + fields.map(f => `updateMask.fieldPaths=${f}`).join('&') : '';
  const r = await mealJson(docUrl(`users/${uid}`) + mask, {method: 'PATCH', headers: {'content-type': 'application/json', Authorization: 'Bearer owner'},
    body: JSON.stringify({fields: Object.fromEntries(Object.entries(data).map(([k, x]) => [k, fsValue(x)]))})});
  if (!r.ok) throw new Error(`Meal seed failed: ${JSON.stringify(r.body)}`);
}
/** A read AS a signed-in Meal Prep user — proves Meal Prep's own rules decide access. */
export async function mealReadAs(idToken, uid) {
  return (await mealJson(docUrl(`users/${uid}`), {headers: {Authorization: `Bearer ${idToken}`}})).status;
}

// ── page bootstrap (replaces the auth SDK script for the DEFAULT ChronaSense app only) ──
function bootstrap({who, rtdbPort, ns, seed}) {
  const person = PEOPLE[who];
  const config = {databaseURL: `${LOCAL}:${rtdbPort}?ns=${ns}`, projectId: 'demo-household', apiKey: 'demo-local'};
  return `
;(() => {
  const person = ${JSON.stringify({uid: person.uid, email: person.email, displayName: person.displayName, tasks: person.tasks, done: person.done || []})};
  const idToken = ${JSON.stringify(token(person.uid, {email: person.email}))};
  const realInit = firebase.initializeApp.bind(firebase);
  const app = realInit(${JSON.stringify(config)});
  // Named apps (the Meal Prep connection) stay real and separate; only the default app is pinned.
  firebase.initializeApp = (cfg, name) => name ? realInit(cfg, name) : app;
  app.database().useEmulator('127.0.0.1', ${rtdbPort}, {mockUserToken: idToken});
  app.database().INTERNAL.forceWebSockets();
  const user = {uid: person.uid, displayName: person.displayName, email: person.email, emailVerified: true, photoURL: '', getIdToken: () => Promise.resolve(idToken)};
  const listeners = new Set();
  const auth = {currentUser: user, onAuthStateChanged(cb) { listeners.add(cb); setTimeout(() => cb(auth.currentUser), 0); return () => listeners.delete(cb); },
    async signOut() { auth.currentUser = null; listeners.forEach(cb => cb(null)); }};
  const realAuth = firebase.auth;
  firebase.auth = target => target && target.name !== '[DEFAULT]' ? realAuth(target) : auth;
  Object.assign(firebase.auth, realAuth);
  firebase.auth.GoogleAuthProvider = class {}; firebase.auth.GoogleAuthProvider.credential = () => ({});
  globalThis.__householdTest = {person, auth};
  try {
    localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const key = 'ta3-settings:uid_' + person.uid;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({timezone: tz, intervalMin: 30, sleepSetupDone: true, presets: [], templates: []}));
    localStorage.setItem('ta3-tz:uid_' + person.uid, tz);
  } catch {}
  ${seed ? `
  // Synthetic first-run: add this person's tasks through the app's own plan authority, once,
  // and opt in to full-list sharing through the app's own consent control.
  const seedKey = 'household-preview-seeded:' + person.uid;
  const timer = setInterval(() => {
    try {
      if (globalThis.getChronaSenseRoomCode?.() !== 'uid_' + person.uid || !globalThis.PlanAuthority?.current()
        || PlanAuthority.authorityState?.() !== 'legacy' || typeof createPlanItem !== 'function') return;
      clearInterval(timer);
      if (localStorage.getItem(seedKey)) return;
      const target = PlanAuthority.current();
      const have = new Set(PlanAuthority.items(target).map(item => item.task));
      if (person.tasks.some(([title]) => !have.has(title))) {
        // Idempotent: another session of the same person may have seeded concurrently.
        for (const [title, when, kind] of person.tasks) if (!have.has(title)) PlanAuthority.addItem({destination: target, item: createPlanItem(title, when, kind)});
        for (const item of PlanAuthority.items(target)) if (person.done.includes(item.task)) toggleTimelinePlanDone(target.id, item.id);
        refreshAuthoritativePlanSurfaces();
      }
      setPartnerDailyTaskSharing(true);
      localStorage.setItem(seedKey, '1');
    } catch (err) { console.warn('household preview seed', err); }
  }, 250);` : ''}
})();`;
}

const CONTENT_TYPES = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png'};

/** Starts everything. Returns {url(who), rtdb, stop}. */
export async function startHouseholdEnv({port = 0, seed = true, link = true} = {}) {
  const mealChild = await ensureMealEmulators();
  const emulator = await startEmulator();
  const rtdb = await emulator.fresh(readFileSync(path.join(ROOT, 'firebase.rules.json'), 'utf8'));
  if (link) {
    await rtdb.seed(`uid_${PEOPLE.me.uid}/partnerUid`, PEOPLE.alyssa.uid);
    await rtdb.seed(`uid_${PEOPLE.alyssa.uid}/partnerUid`, PEOPLE.me.uid);
  }
  const meal = {};
  for (const who of ['me', 'alyssa']) {
    meal[who] = await mealSignIn(PEOPLE[who].email);
    await mealPut(meal[who].uid, FOOD[who]());
  }
  const allowed = new Set(computeClosure({rootDir: ROOT}).files);
  const sdk = name => readFileSync(path.join(ROOT, `node_modules/firebase/firebase-${name}-compat.js`), 'utf8');
  const mealConfig = `HouseholdFoodSource.configure(${JSON.stringify({firebase: {apiKey: 'demo-local', projectId: MEAL.project, authDomain: `${MEAL.project}.firebaseapp.com`},
    emulator: {auth: `${LOCAL}:${MEAL.authPort}`, firestoreHost: '127.0.0.1', firestorePort: MEAL.firestorePort}})});`;
  const csp = `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; `
    + `connect-src 'self' ${LOCAL}:${emulator.port} ws://127.0.0.1:${emulator.port} ${LOCAL}:${MEAL.authPort} ${LOCAL}:${MEAL.firestorePort}; worker-src 'none'; frame-src 'none'`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const who = url.searchParams.get('as') === 'alyssa' ? 'alyssa' : 'me';
    const send = (type, body, extra = {}) => { response.writeHead(200, {'content-type': type, 'cache-control': 'no-store', ...extra}); response.end(body); };
    if (url.pathname.startsWith('/__sdk/')) {
      const name = url.pathname.slice(7).replace(/\.js$/, '');
      if (name === 'auth') {
        const referer = new URL(request.headers.referer || 'http://localhost/');
        const as = referer.searchParams.get('as') === 'alyssa' ? 'alyssa' : 'me';
        return send('text/javascript', sdk('auth') + bootstrap({who: as, rtdbPort: emulator.port, ns: rtdb.name, seed}));
      }
      if (['app', 'database', 'firestore'].includes(name)) return send('text/javascript', sdk(name));
      response.writeHead(404).end(); return;
    }
    if (url.pathname === '/__household/meal-config.js') return send('text/javascript', mealConfig);
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    if (!allowed.has(file)) { response.writeHead(404).end(); return; }
    if (file === 'index.html') {
      const html = readFileSync(path.join(ROOT, file), 'utf8')
        .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-(app|database|auth)-compat\.js/g, '/__sdk/$1.js')
        .replace('</body>', '<script src="/__sdk/firestore.js"></script>\n<script defer src="/__household/meal-config.js"></script>\n</body>');
      return send('text/html', html, {'Content-Security-Policy': csp});
    }
    send(CONTENT_TYPES[path.extname(file)] || 'application/octet-stream', readFileSync(path.join(ROOT, file)));
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const base = `${LOCAL}:${server.address().port}`;
  return {
    base, rtdb, meal, emulatorPort: emulator.port,
    url: (who = 'me') => `${base}/?household=1${who === 'alyssa' ? '&as=alyssa' : ''}`,
    async stop() { await new Promise(r => server.close(r)); emulator.stop(); if (mealChild) mealChild.kill(); },
  };
}
