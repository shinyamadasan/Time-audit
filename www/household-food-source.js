/* global firebase */
// Household My Day V1 — Meal Prep food source.
//
// Meal Prep is a SEPARATE Firebase project (Firestore + its own Auth). This module keeps the
// two authentication boundaries apart: it uses its own named Firebase app instance, signs in
// to MEAL PREP's Auth with the viewer's own Meal Prep account, and reads only that account's
// own `users/{uid}` document, which Meal Prep's rules already restrict to its owner. The
// ChronaSense session, token and database are never given to Meal Prep, and nothing is written.
//
// There is no built-in project configuration: until `configure()` is called with an approved
// Meal Prep web config the column reports "not configured". Emulator endpoints are honoured
// only on a loopback page.
(() => {
  const APP_NAME = 'chronasense-household-meal-prep';
  const SDK_VERSION = '10.12.2';
  const FIRESTORE_SDK = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore-compat.js`;
  const LOOPBACK = ['127.0.0.1', 'localhost'];

  let config = null;
  let app = null, auth = null, db = null, ready = null;
  let boundOwner = null, boundEmail = '';
  let status = 'not-configured', doc = null, exists = false, fromCache = false, lastError = '';
  let stopDoc = null, epoch = 0, switching = null;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => { try { fn(); } catch { /* a listener never breaks the source */ } });
  const normalEmail = v => typeof v === 'string' ? v.trim().toLowerCase() : '';

  function configure(next) {
    if (config) throw new Error('Meal Prep connection is already configured.');
    if (!next || typeof next !== 'object' || !next.firebase || typeof next.firebase.projectId !== 'string'
      || typeof next.firebase.apiKey !== 'string') throw new Error('An approved Meal Prep web configuration is required.');
    if (next.emulator && !LOOPBACK.includes(location.hostname)) throw new Error('Meal Prep emulators are local only.');
    config = Object.freeze({firebase: {...next.firebase}, emulator: next.emulator ? {...next.emulator} : null});
    status = 'signed-out';
    notify();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src; el.async = true;
      el.onload = resolve; el.onerror = () => reject(new Error('Could not load Meal Prep connection.'));
      document.head.append(el);
    });
  }

  function init() {
    if (ready) return ready;
    ready = (async () => {
      if (typeof firebase === 'undefined' || typeof firebase.initializeApp !== 'function') throw new Error('Firebase is not loaded.');
      if (typeof firebase.firestore !== 'function') await loadScript(FIRESTORE_SDK);
      app = firebase.apps.find(a => a.name === APP_NAME) || firebase.initializeApp(config.firebase, APP_NAME);
      auth = app.auth();
      db = app.firestore();
      if (config.emulator) {
        auth.useEmulator(config.emulator.auth);
        db.useEmulator(config.emulator.firestoreHost, config.emulator.firestorePort);
      }
      auth.onAuthStateChanged(user => onMealUser(user)); // lives as long as the page
    })();
    ready.catch(() => { status = 'error'; lastError = 'load'; notify(); });
    return ready;
  }

  function stopReading() {
    epoch++;
    const stop = stopDoc; stopDoc = null;
    doc = null; exists = false; fromCache = false;
    if (stop) try { stop(); } catch { /* already stopped */ }
  }

  function onMealUser(user) {
    if (switching && user) return; // the previous account's session is still being signed out
    stopReading();
    if (!user) { status = lastError === 'mismatch' ? 'mismatch' : 'signed-out'; notify(); return; }
    // Identity binding across the two projects: the Meal Prep account must use the same email
    // address as the signed-in ChronaSense account (an address match, not a verification check).
    if (!boundOwner || !boundEmail || normalEmail(user.email) !== boundEmail) {
      lastError = 'mismatch'; status = 'mismatch'; notify();
      auth.signOut().catch(() => {});
      return;
    }
    lastError = ''; status = 'loading'; notify();
    const mine = ++epoch;
    stopDoc = db.collection('users').doc(user.uid).onSnapshot({includeMetadataChanges: true}, snap => {
      if (mine !== epoch) return;
      exists = snap.exists; doc = snap.exists ? snap.data() : null; fromCache = snap.metadata.fromCache;
      status = 'ready'; notify();
    }, err => {
      if (mine !== epoch) return;
      doc = null; exists = false;
      status = err && err.code === 'permission-denied' ? 'refused' : 'error'; notify();
    });
  }

  /** Called on every My Day refresh with the CURRENT ChronaSense account. A change of
   *  account (or sign-out) ends the Meal Prep session so food can never carry over. */
  function bind(owner, email) {
    if (!config) return; // configure() notifies, and the next refresh binds the current account
    const nextEmail = normalEmail(email);
    if (owner === boundOwner && nextEmail === boundEmail) return;
    const changed = boundOwner !== null;
    boundOwner = owner || null; boundEmail = owner ? nextEmail : '';
    stopReading();
    lastError = '';
    if (changed) {
      // The previous account's Meal Prep session ends before anything is read for the new one.
      status = 'signed-out';
      const done = switching = init().then(() => auth.signOut()).catch(() => {})
        .finally(() => { if (switching === done) switching = null; if (auth && auth.currentUser) onMealUser(auth.currentUser); });
      notify();
    }
    // The first onAuthStateChanged after init reports any persisted Meal Prep session,
    // which onMealUser re-checks against this binding.
    if (boundOwner) init().catch(() => {});
    else { status = 'signed-out'; notify(); }
  }

  async function connect(email, password) {
    if (!config) throw new Error('Meal Prep connection is not configured.');
    if (!boundOwner) throw new Error('Sign in to ChronaSense first.');
    if (normalEmail(email) !== boundEmail) { lastError = 'mismatch'; status = 'mismatch'; notify(); throw new Error('Use the Meal Prep account with the same email as this ChronaSense account.'); }
    await init();
    lastError = ''; status = 'connecting'; notify();
    try { await auth.signInWithEmailAndPassword(email.trim(), password); }
    catch (err) {
      status = 'signed-out'; notify();
      throw new Error(err && /wrong-password|invalid-credential|user-not-found|invalid-login/.test(err.code || '') ? 'Meal Prep sign-in failed. Check the email and password.' : 'Could not reach Meal Prep. Try again.');
    }
  }

  async function disconnect() {
    stopReading(); lastError = '';
    if (auth) await auth.signOut().catch(() => {});
    status = config ? 'signed-out' : 'not-configured'; notify();
  }

  function snapshot(today) {
    return {state: status, doc, exists, fromCache, today};
  }

  globalThis.HouseholdFoodSource = Object.freeze({
    configure, bind, connect, disconnect, snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get configured() { return !!config; }
  });
})();
