// TASK-018 staging isolation guard. Every staging tool goes through this module; it fails closed.
// Production identifiers below are already public in storage.js; they are listed so they can be REFUSED.

export const PRODUCTION = Object.freeze({
  projectId: 'time-audit-3c3da',
  apiKey: 'AIzaSyDQeoZ1o1uz7adi1fLQiC6VKFCJ-6q8kgA',
  // Any URL or file containing one of these reaches production data, auth or functions.
  dataPlaneMarkers: ['time-audit-3c3da', 'AIzaSyDQeoZ1o1uz7adi1fLQiC6VKFCJ-6q8kgA'],
  // Production static hosting (sounds, share-link fallback). Never data, but still blocked at runtime in staging.
  staticHosts: ['shinyamadasan.github.io'],
});
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export class StagingGuardError extends Error {}
const refuse = message => { throw new StagingGuardError(message); };

/** Validates a staging public config and returns the exact hosts staging may contact. */
export function assertStagingConfig(config) {
  if (!config || typeof config !== 'object') refuse('staging config required');
  const { apiKey, authDomain, databaseURL, projectId } = config;
  if (!PROJECT_ID.test(projectId || '')) refuse('staging projectId missing or malformed');
  for (const value of [apiKey, authDomain, databaseURL, projectId]) {
    if (typeof value !== 'string' || !value) refuse('staging config incomplete');
    if (PRODUCTION.dataPlaneMarkers.some(marker => value.includes(marker))) refuse('staging config references PRODUCTION');
  }
  if (!projectId.includes('staging')) {
    refuse('staging projectId must contain "staging" so it cannot be mistaken for production');
  }
  if (authDomain !== `${projectId}.firebaseapp.com`) refuse('authDomain must belong to the staging project');
  const db = new URL(databaseURL);
  if (db.search || db.hash || db.username || db.password || db.port) refuse('databaseURL must be a bare https origin');
  const dbOk = db.protocol === 'https:' && db.pathname === '/' && (db.hostname === `${projectId}-default-rtdb.asia-southeast1.firebasedatabase.app`
    || db.hostname === `${projectId}-default-rtdb.firebaseio.com`);
  if (!dbOk) refuse('databaseURL must be the staging project default RTDB instance');
  const endpoint = `https://asia-southeast1-${projectId}.cloudfunctions.net/chronasenseCompletionApi`;
  return Object.freeze({ endpoint, databaseHost: db.hostname,
    hosts: new Set([db.hostname, `asia-southeast1-${projectId}.cloudfunctions.net`, authDomain,
      'identitytoolkit.googleapis.com', 'securetoken.googleapis.com']) });
}

/** fetch wrapper: refuses any URL outside the staging allowlist or containing a production marker. */
export function guardedFetch(config, fetchImpl = fetch) {
  const { hosts } = assertStagingConfig(config);
  return (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (PRODUCTION.dataPlaneMarkers.some(marker => url.href.includes(marker))) refuse(`blocked production request to ${url.hostname}`);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname)) refuse(`blocked non-staging request to ${url.hostname}`);
    // Redirects are never followed: the allowlist must hold for every hop, so a redirect is an error.
    return fetchImpl(url, { ...options, redirect: 'error' });
  };
}
