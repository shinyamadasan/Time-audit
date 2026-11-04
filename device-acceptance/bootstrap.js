// Test transport only. Loaded before the approved runtime, which remains byte-for-byte unchanged.
(() => {
  const config = window.__deviceTestConfig;
  const initialize = firebase.initializeApp.bind(firebase);
  firebase.initializeApp = () => initialize({ apiKey:'local-device-test-only', projectId:'demo-chronasense-device',
    databaseURL:`http://127.0.0.1:${config.emulatorPort}?ns=${config.namespace}` });
  const app = firebase.initializeApp();
  const database = app.database();
  database.useEmulator('127.0.0.1', config.emulatorPort, {mockUserToken: {sub:config.uid,user_id:config.uid}});
  database.INTERNAL.forceWebSockets();

  // Only the auth UI is a test fixture. All database writes use the real SDK and candidate rules.
  const user = {uid:config.uid,displayName:'LOCAL TEST — disposable data',email:'device-test@example.invalid',
    photoURL:'',getIdToken:()=>Promise.reject(new Error('Completion backend is outside this isolated test'))};
  let current = user;
  const callbacks = new Set();
  const auth = {
    get currentUser(){return current;},
    onAuthStateChanged(callback){callbacks.add(callback);setTimeout(()=>callback(current),0);return()=>callbacks.delete(callback);},
    async signInWithPopup(){current=user;callbacks.forEach(callback=>callback(user));return{user};},
    async signOut(){current=null;callbacks.forEach(callback=>callback(null));},
  };
  firebase.auth = () => auth;
  firebase.auth.GoogleAuthProvider = class {};
  firebase.auth.GoogleAuthProvider.credential = () => ({});

  const room = `uid_${config.uid}`;
  localStorage.setItem('ta3-onboarded','1');
  sessionStorage.setItem('ta3-session-started','1'); // avoid unrelated automatic desktop PC Time
  if (!localStorage.getItem('device-test-seeded')) {
    localStorage.setItem(`ta3-settings:${room}`,JSON.stringify({timezone:config.timezone,intervalMin:1,
      sleepSetupDone:true,presets:[],templates:[]}));
    localStorage.setItem(`ta3-tz:${room}`,config.timezone);
    localStorage.setItem('device-test-seeded','1');
  }
  const setOffline = offline => {
    localStorage.setItem('device-test-offline',offline?'1':'0');
    offline ? database.goOffline() : database.goOnline();
  };
  if (localStorage.getItem('device-test-offline') === '1') database.goOffline();
  window.addEventListener('storage',event=>{
    if(event.key==='device-test-offline') setOffline(event.newValue==='1');
  });
  window.__deviceAcceptance = Object.freeze({setOffline,namespace:config.namespace,room,
    candidate:config.candidate,transport:'real SDK → same-origin proxy → loopback RTDB emulator'});
})();
