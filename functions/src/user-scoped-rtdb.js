// functions/src/user-scoped-rtdb.js
//
// USER-SCOPED domain access (docs/CHRONASENSE_ACTION_API_V1.md §3). The Admin SDK is used here for exactly two
// things: confirming the configured UID is a live account, and minting a custom token for it. That token is
// exchanged (accounts:signInWithCustomToken) for a short-lived Firebase ID token, and every domain read is an
// RTDB REST request authenticated with that ID token (`?auth=`), so the existing security rules evaluate it as
// auth.uid === the owner and stay fully enforced. The refresh token is discarded; tokens never leave this module.
//
// There is deliberately NO Admin path here: this module never receives an Admin database or access token, and
// if the ID token cannot be obtained the operation FAILS. It never falls back to privileged access.

import { ApiError, AuthorityBoundaryViolation } from './errors.js';
import { ACTION_ID, captureIdForAction } from './command-identity.js';
import { validFirebaseUid } from './identity.js';
import { parseCalendarPlanId } from '../shared/calendar-plan-model.js';
import { validPlanDate } from '../shared/plan-tomorrow-model.js';
import { actionPlanItemIdFor, captureIdOfPlanItem, isActionPlanItemId } from '../shared/plan-item-origin.js';

/** The only room collections a user-scoped read may name. Paths are built here, never taken from a request. */
const READABLE_COLLECTIONS = new Set([
  'brainDump', 'settings', 'calendarPlanAuthority', 'dayBoundaryRevisions',
  'calendarPlans', 'operationalPlans', 'plans', 'calendarPlanFences',
  'operationalPlanFences', 'planFences', 'entries', 'commitments', 'coarseLifeEvidence',
]);
const TOKEN_EXCHANGE_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken';
// Fixed read model: cap each complete RTDB collection at 1 MiB before parsing; the separate API result cap is 64 KiB.
export const MAX_SOURCE_BODY_BYTES = 1024 * 1024;

const transport = reason => new ApiError('RETRYABLE_TRANSPORT', 'ChronaSense data is temporarily unavailable.', { reason });
const denied = reason => new ApiError('FORBIDDEN', 'ChronaSense account access was refused.', { reason });
const sourceTooLarge = () => new ApiError('DOMAIN_LIMIT', 'The complete source collection exceeds the 1 MiB read limit; no partial result is returned.',
  { reason: 'source-too-large', details: { limitBytes: MAX_SOURCE_BODY_BYTES } });

async function boundedSourceJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw transport('domain-read-body');
  const bytes = new Uint8Array(MAX_SOURCE_BODY_BYTES);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.length > MAX_SOURCE_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw sourceTooLarge();
      }
      bytes.set(value, length);
      length += value.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw transport('domain-read-body');
  }
}

function jwtClaims(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  } catch { return null; }
}

/** A calendar plan's own Firebase key (`cal1:<valid date>`), never a path. */
const calendarPlanKey = value => typeof value === 'string' && parseCalendarPlanId(value) !== null && value === `cal1:${parseCalendarPlanId(value)}`;
/** TASK-036: a legacy plan's own Firebase key (a valid `YYYY-MM-DD`), never a path. */
const legacyPlanKey = value => validPlanDate(value);

/** The custom claims of an action-scoped token. Brain Dump (TASK-010) keeps exactly its original single claim;
 *  a plan create (TASK-011) also names its kind and its ONE target plan, so the rules let that token create
 *  exactly one item at exactly one path and nothing else (DECISIONS #37). */
function actionClaims(actionId, plan) {
  if (!plan) return { chronasenseActionId: actionId };
  if (plan.kind === 'plan_move') {
    // TASK-012: the move lock and the one atomic move of ONE Action API item from one calendar plan to another. The rules
    // bind every claim (DECISIONS #38); source freshness is proven by the lock's conditional write, not by a claim.
    return { chronasenseActionId: actionId, chronasenseActionKind: 'plan_move', chronasenseActionTarget: plan.target,
      chronasenseActionSource: plan.source, chronasenseActionItem: plan.item };
  }
  return { chronasenseActionId: actionId, chronasenseActionKind: 'plan_create', chronasenseActionTarget: plan.target };
}
const validMovePlan = plan => plan.kind === 'plan_move' && calendarPlanKey(plan.source) && plan.source !== plan.target
  && isActionPlanItemId(plan.item) && Object.keys(plan).sort().join(',') === 'item,kind,source,target';

/**
 * @param {{authAdmin:{getUser(uid:string):Promise<{disabled?:boolean}>, createCustomToken(uid:string, claims?:object):Promise<string>},
 *          webApiKey:string, fetch?:typeof fetch, exchangeUrl?:string, timeoutMs?:number}} options
 * @returns {{getIdToken(firebaseUid:string, actionId?:string, plan?:{target:string}):Promise<string>}}
 */
export function createIdTokenProvider({ authAdmin, webApiKey, fetch: fetchImpl = globalThis.fetch, exchangeUrl = TOKEN_EXCHANGE_URL, timeoutMs = 10_000 }) {
  return Object.freeze({
    async getIdToken(firebaseUid, actionId, plan) {
      if (!validFirebaseUid(firebaseUid)) throw denied('invalid-uid');
      if (actionId !== undefined && (typeof actionId !== 'string' || !ACTION_ID.test(actionId))) throw denied('invalid-action-id');
      if (plan !== undefined && (actionId === undefined || !plan || !calendarPlanKey(plan.target)
        || (plan.kind !== undefined && !validMovePlan(plan)))) throw denied('invalid-action-target');
      const claimsWanted = actionId ? actionClaims(actionId, plan) : undefined;
      let user;
      try { user = await authAdmin.getUser(firebaseUid); } catch (error) {
        if (error?.code === 'auth/user-not-found') throw denied('owner-account-missing');
        throw transport('admin-get-user');
      }
      if (!user || user.disabled) throw denied('owner-account-disabled');
      let customToken;
      try { customToken = await authAdmin.createCustomToken(firebaseUid, claimsWanted); } catch { throw transport('custom-token'); }
      let response;
      try {
        response = await fetchImpl(`${exchangeUrl}?key=${encodeURIComponent(webApiKey)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: customToken, returnSecureToken: true }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { throw transport('token-exchange-network'); }
      if (response.status >= 500) throw transport(`token-exchange-${response.status}`);
      if (response.status !== 200) throw denied(`token-exchange-${response.status}`);
      let idToken;
      try { ({ idToken } = await response.json()); } catch { throw transport('token-exchange-body'); }
      // The refresh token in that response is dropped here, unread. The ID token must name exactly the owner.
      const claims = typeof idToken === 'string' ? jwtClaims(idToken) : null;
      if (!claims || (claims.user_id ?? claims.sub) !== firebaseUid
        || Object.entries(claimsWanted || {}).some(([name, value]) => claims[name] !== value)) throw denied('token-exchange-identity');
      return idToken;
    },
  });
}

/**
 * @param {{databaseUrl:string, namespace?:string, fetch?:typeof fetch, idTokens:{getIdToken(uid:string):Promise<string>}, timeoutMs?:number}} options
 */
export function createUserScopedRtdb({ databaseUrl, namespace, fetch: fetchImpl = globalThis.fetch, idTokens, timeoutMs = 10_000 }) {
  if (!idTokens || typeof idTokens.getIdToken !== 'function') throw new Error('user-scoped RTDB needs an ID-token provider');
  function captureUrl(identity, captureId, idToken) {
    if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`
      || typeof captureId !== 'string' || !/^bdc1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(captureId)) {
      throw new AuthorityBoundaryViolation('capture address is not derived from the bound UID and action ID');
    }
    const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/brainDump/${captureId}.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    url.searchParams.set('auth', idToken);
    return url;
  }
  /** R011-02: the one calendar plan record whose canonical origin plan_create may freeze; nothing else. */
  function planRecordUrl(identity, planId, idToken) {
    if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}` || !calendarPlanKey(planId)) {
      throw new AuthorityBoundaryViolation('plan record address is not derived from the bound UID and plan');
    }
    const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/calendarPlans/${planId}.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    url.searchParams.set('auth', idToken);
    return url;
  }
  function planItemUrl(identity, planId, itemId, idToken) {
    if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`
      || !calendarPlanKey(planId) || !isActionPlanItemId(itemId)) {
      throw new AuthorityBoundaryViolation('plan item address is not derived from the bound UID, plan and action ID');
    }
    const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/calendarPlanFences/${planId}/${itemId}.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    url.searchParams.set('auth', idToken);
    return url;
  }
  /** TASK-012: one EXISTING calendar fence child — an Action API item (`api1_<uuid>`) or a fenced Brain Dump item
   *  (`bdp1|<captureId>`) — for an ordinary-owner compare-and-set update. Never another collection or depth. */
  function fenceItemUrl(identity, planId, itemId, idToken) {
    if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`
      || !calendarPlanKey(planId) || !(isActionPlanItemId(itemId) || captureIdOfPlanItem(itemId) !== null)) {
      throw new AuthorityBoundaryViolation('fence item address is not derived from the bound UID, plan and a fenced item id');
    }
    const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/calendarPlanFences/${planId}/${encodeURIComponent(itemId)}.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    url.searchParams.set('auth', idToken);
    return url;
  }
  /** TASK-012: the owner's calendar plan collection, for the ONE atomic compare-and-set a cross-day move needs (its
   *  source tombstone and destination copy must commit together or not at all). Nothing else, at no other depth. */
  function calendarPlansUrl(identity, idToken) {
    if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`) {
      throw new AuthorityBoundaryViolation('calendar plans address is not derived from the bound UID');
    }
    const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/calendarPlans.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    url.searchParams.set('auth', idToken);
    return url;
  }
  /** TASK-036: the one legacy plan record (`plans/<YYYY-MM-DD>`) a legacy completion compare-and-sets; nothing else. */
  function legacyPlanRecordUrl(identity, dateKey, idToken) {
    if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}` || !legacyPlanKey(dateKey)) {
      throw new AuthorityBoundaryViolation('legacy plan record address is not derived from the bound UID and plan');
    }
    const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/plans/${dateKey}.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    url.searchParams.set('auth', idToken);
    return url;
  }
  /** TASK-038: the owner's legacy plan collection, for the ONE atomic compare-and-set a legacy cross-day move needs.
   *  Nothing else, at no other depth. */
  function legacyPlansUrl(identity, idToken) {
    if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`) {
      throw new AuthorityBoundaryViolation('legacy plans address is not derived from the bound UID');
    }
    const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/plans.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    url.searchParams.set('auth', idToken);
    return url;
  }
  /** TASK-036: one EXISTING legacy fence child — a fenced Brain Dump item (`bdp1|<captureId>`) only; an Action API item
   *  is never in a legacy plan (plan_create is calendar-only). Never another collection or depth. */
  function legacyFenceItemUrl(identity, dateKey, itemId, idToken) {
    if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`
      || !legacyPlanKey(dateKey) || captureIdOfPlanItem(itemId) === null) {
      throw new AuthorityBoundaryViolation('legacy fence item address is not derived from the bound UID, plan and a fenced item id');
    }
    const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/planFences/${dateKey}/${encodeURIComponent(itemId)}.json`);
    if (namespace) url.searchParams.set('ns', namespace);
    url.searchParams.set('auth', idToken);
    return url;
  }
  /** An ordinary-owner GET with its ETag (value null = authoritatively absent). */
  async function readWithEtag(url, label) {
    let response;
    try { response = await fetchImpl(url, { method: 'GET', headers: { 'X-Firebase-ETag': 'true' }, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw transport(`domain-${label}-read-network`); }
    if (response.status === 401 || response.status === 403) throw denied(`domain-${label}-read-${response.status}`);
    if (response.status !== 200) throw transport(`domain-${label}-read-${response.status}`);
    const etag = response.headers.get('ETag');
    if (!etag) throw transport(`domain-${label}-etag-missing`);
    return { value: await boundedSourceJson(response), etag };
  }
  /** An ordinary-owner PUT conditional on `etag`, through the unchanged rules. @returns {Promise<'written'|'changed'>} */
  async function putIfMatch(url, record, etag, label) {
    let response;
    try { response = await fetchImpl(url, { method: 'PUT', headers: { 'if-match': etag, 'content-type': 'application/json' },
      body: JSON.stringify(record), signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw transport(`domain-${label}-write-network`); }
    if (response.status === 200) return 'written';
    if (response.status === 412) return 'changed';
    if (response.status === 401 || response.status === 403) throw denied(`domain-${label}-write-${response.status}`);
    throw transport(`domain-${label}-write-${response.status}`);
  }
  return Object.freeze({
    /** TASK-036: the legacy plan record and its ETag, as the ordinary owner (no action claim). */
    async readLegacyPlanWithEtag(identity, dateKey) {
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      return readWithEtag(legacyPlanRecordUrl(identity, dateKey, idToken), 'legacy-plan-record');
    },
    /** TASK-036: compare-and-set of an EXISTING legacy plan record, as the ordinary owner, through the unchanged rules
     *  (which refuse every legacy write once the account has cut over). Never a create and never a delete. */
    async putLegacyPlanIfMatch(identity, dateKey, record, etag) {
      if (typeof etag !== 'string' || !etag || etag === 'null_etag' || !record || typeof record !== 'object' || Array.isArray(record)) {
        throw new AuthorityBoundaryViolation('legacy plan record write requires the existing record and its ETag');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      return putIfMatch(legacyPlanRecordUrl(identity, dateKey, idToken), record, etag, 'legacy-plan-record');
    },
    /** TASK-036: the exact legacy fence child and its ETag, as the ordinary owner (value null = authoritatively absent). */
    async readLegacyPlanFenceItemWithEtag(identity, dateKey, itemId) {
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      return readWithEtag(legacyFenceItemUrl(identity, dateKey, itemId, idToken), 'legacy-fence-item');
    },
    /** TASK-036: compare-and-set of an EXISTING legacy fence child through the unchanged fence rules. Never a create or delete. */
    async putLegacyPlanFenceItemIfMatch(identity, dateKey, itemId, record, etag) {
      if (typeof etag !== 'string' || !etag || etag === 'null_etag' || !record || typeof record !== 'object'
        || Array.isArray(record) || record.id !== itemId) {
        throw new AuthorityBoundaryViolation('legacy fence item update requires the existing item, its id and its ETag');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      return putIfMatch(legacyFenceItemUrl(identity, dateKey, itemId, idToken), record, etag, 'legacy-fence-item');
    },
    /** TASK-038: every legacy plan record and the collection ETag, as the ordinary owner (bounded like every read). */
    async readLegacyPlansWithEtag(identity) {
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      return readWithEtag(legacyPlansUrl(identity, idToken), 'legacy-plans');
    },
    /** TASK-038: atomic compare-and-set of the whole legacy collection, as the ordinary owner, through the unchanged rules
     *  (which refuse every legacy write once the account has cut over). Only over an EXISTING collection (a move's source
     *  plan exists), legacy date keys only. @returns {Promise<'written'|'changed'>} */
    async putLegacyPlansIfMatch(identity, plans, etag) {
      if (typeof etag !== 'string' || !etag || etag === 'null_etag' || !plans || typeof plans !== 'object' || Array.isArray(plans)
        || Object.keys(plans).some(key => !legacyPlanKey(key))) {
        throw new AuthorityBoundaryViolation('legacy plans write requires legacy plan records and the collection ETag');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      return putIfMatch(legacyPlansUrl(identity, idToken), plans, etag, 'legacy-plans');
    },
    /** TASK-012: every calendar plan record and the collection ETag, as the ordinary owner (bounded like every read). */
    async readCalendarPlansWithEtag(identity) {
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = calendarPlansUrl(identity, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'GET', headers: { 'X-Firebase-ETag': 'true' }, signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-plans-read-network'); }
      if (response.status === 401 || response.status === 403) throw denied(`domain-plans-read-${response.status}`);
      if (response.status !== 200) throw transport(`domain-plans-read-${response.status}`);
      const etag = response.headers.get('ETag');
      if (!etag) throw transport('domain-plans-etag-missing');
      return { value: await boundedSourceJson(response), etag };
    },
    /** TASK-012: atomic compare-and-set of the whole collection, as the ordinary owner, through the unchanged plan
     *  rules. Only over an EXISTING collection (a move's source plan exists). @returns {Promise<'written'|'changed'>} */
    async putCalendarPlansIfMatch(identity, plans, etag) {
      if (typeof etag !== 'string' || !etag || etag === 'null_etag' || !plans || typeof plans !== 'object' || Array.isArray(plans)
        || Object.keys(plans).some(key => !calendarPlanKey(key))) {
        throw new AuthorityBoundaryViolation('calendar plans write requires calendar plan records and the collection ETag');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = calendarPlansUrl(identity, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'PUT', headers: { 'if-match': etag, 'content-type': 'application/json' },
        body: JSON.stringify(plans), signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-plans-write-network'); }
      if (response.status === 200) return 'written';
      if (response.status === 412) return 'changed';
      if (response.status === 401 || response.status === 403) throw denied(`domain-plans-write-${response.status}`);
      throw transport(`domain-plans-write-${response.status}`);
    },
    /** TASK-012: ONE atomic relocation of an Action API item between two calendar plans: a multi-path update of exactly
     *  `<source>/<item>` (its tombstone) and `<destination>/<item>` (its live copy) under calendarPlanFences, with a token
     *  whose claims name this action, both plans and the item. The rules accept both paths or neither, and only while this
     *  action holds its move lock on the source (lockActionPlanItemForMove). @returns {Promise<'written'>} */
    async relocateActionPlanItem(identity, { actionId, sourcePlanId, destinationPlanId, itemId, tombstone, moved }) {
      if (typeof actionId !== 'string' || !ACTION_ID.test(actionId) || !validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`
        || !calendarPlanKey(sourcePlanId) || !calendarPlanKey(destinationPlanId) || sourcePlanId === destinationPlanId || !isActionPlanItemId(itemId)
        || tombstone?.id !== itemId || moved?.id !== itemId || tombstone.creationActionId !== moved.creationActionId
        || actionPlanItemIdFor(moved.creationActionId) !== itemId || tombstone.deleted !== true || moved.deleted === true
        || tombstone.moveLock !== undefined || moved.moveLock !== undefined) {
        throw new AuthorityBoundaryViolation('relocation requires one Action API item, two distinct calendar plans and its exact two ends');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid, actionId, { kind: 'plan_move', target: destinationPlanId, source: sourcePlanId, item: itemId });
      const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/calendarPlanFences.json`);
      if (namespace) url.searchParams.set('ns', namespace);
      url.searchParams.set('auth', idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [`${sourcePlanId}/${itemId}`]: tombstone, [`${destinationPlanId}/${itemId}`]: moved }), signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-relocate-network'); }
      if (response.status === 200) return 'written';
      if (response.status === 401 || response.status === 403) throw denied(`domain-relocate-${response.status}`);
      throw transport(`domain-relocate-${response.status}`);
    },
    /** TASK-012 R1: the move lock. A conditional PUT (`if-match` = the source child's ETag, i.e. its exact content) of the
     *  same item plus this action's `moveLock` (its `at` is the server timestamp placeholder, so the rules time the lock by
     *  server clock), with the plan_move token. Landing proves the source is exactly the
     *  pre-image the move was built from; while the lock is active the rules refuse every ordinary write to it.
     *  @returns {Promise<'written'|'changed'>} */
    async lockActionPlanItemForMove(identity, { actionId, sourcePlanId, destinationPlanId, itemId, record, etag }) {
      if (typeof actionId !== 'string' || !ACTION_ID.test(actionId) || !calendarPlanKey(sourcePlanId) || !calendarPlanKey(destinationPlanId)
        || sourcePlanId === destinationPlanId || !isActionPlanItemId(itemId) || record?.id !== itemId || record.deleted === true
        || actionPlanItemIdFor(record.creationActionId) !== itemId || record.moveLock?.actionId !== actionId
        || record.moveLock.destination !== destinationPlanId || JSON.stringify(record.moveLock.at) !== '{".sv":"timestamp"}'
        || typeof etag !== 'string' || !etag || etag === 'null_etag') {
        throw new AuthorityBoundaryViolation('a move lock requires the existing Action API item, its exact ETag and this action lock');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid, actionId, { kind: 'plan_move', target: destinationPlanId, source: sourcePlanId, item: itemId });
      const url = fenceItemUrl(identity, sourcePlanId, itemId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'PUT', headers: { 'if-match': etag, 'content-type': 'application/json' },
        body: JSON.stringify(record), signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-move-lock-network'); }
      if (response.status === 200) return 'written';
      if (response.status === 412) return 'changed';
      if (response.status === 401 || response.status === 403) throw denied(`domain-move-lock-${response.status}`);
      throw transport(`domain-move-lock-${response.status}`);
    },
    /** TASK-012: the exact fence child and its ETag, as the ordinary owner (value null = authoritatively absent). */
    async readPlanFenceItemWithEtag(identity, planId, itemId) {
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = fenceItemUrl(identity, planId, itemId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'GET', headers: { 'X-Firebase-ETag': 'true' }, signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-fence-item-read-network'); }
      if (response.status === 401 || response.status === 403) throw denied(`domain-fence-item-read-${response.status}`);
      if (response.status !== 200) throw transport(`domain-fence-item-read-${response.status}`);
      const etag = response.headers.get('ETag');
      if (!etag) throw transport('domain-fence-item-etag-missing');
      return { value: await boundedSourceJson(response), etag };
    },
    /** TASK-012: compare-and-set of an EXISTING fence child, as the ordinary owner, through the unchanged fence rules
     *  (marker pinned, tombstone monotonic, no relocation). Never a create (no null ETag) and never a delete.
     *  @returns {Promise<'written'|'changed'>} */
    async putPlanFenceItemIfMatch(identity, planId, itemId, record, etag) {
      if (typeof etag !== 'string' || !etag || etag === 'null_etag' || !record || typeof record !== 'object'
        || Array.isArray(record) || record.id !== itemId) {
        throw new AuthorityBoundaryViolation('fence item update requires the existing item, its id and its ETag');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = fenceItemUrl(identity, planId, itemId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'PUT', headers: { 'if-match': etag, 'content-type': 'application/json' },
        body: JSON.stringify(record), signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-fence-item-write-network'); }
      if (response.status === 200) return 'written';
      if (response.status === 412) return 'changed';
      if (response.status === 401 || response.status === 403) throw denied(`domain-fence-item-write-${response.status}`);
      throw transport(`domain-fence-item-write-${response.status}`);
    },
    async createCaptureIfAbsent(identity, captureId, actionId, record) {
      if (typeof actionId !== 'string' || !ACTION_ID.test(actionId) || captureId !== captureIdForAction(actionId)
        || record?.id !== captureId || record.creationActionId !== actionId) {
        throw new AuthorityBoundaryViolation('capture create requires its exact action attribution');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid, actionId);
      const url = captureUrl(identity, captureId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'PUT', headers: { 'if-match': 'null_etag', 'content-type': 'application/json' },
        body: JSON.stringify(record), signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-create-network'); }
      if (response.status === 200) return 'created';
      if (response.status === 412) return 'exists';
      if (response.status === 401 || response.status === 403) throw denied(`domain-create-${response.status}`);
      throw transport(`domain-create-${response.status}`);
    },
    /** TASK-011: the one Action API plan item, at its keyed calendar fence child, conditionally created with a
     *  token whose claims name exactly this action, kind and plan. @returns {Promise<'created'|'exists'>} */
    async createPlanItemIfAbsent(identity, planId, itemId, actionId, record) {
      if (typeof actionId !== 'string' || !ACTION_ID.test(actionId) || itemId !== actionPlanItemIdFor(actionId)
        || record?.id !== itemId || record.creationActionId !== actionId) {
        throw new AuthorityBoundaryViolation('plan item create requires its exact action attribution');
      }
      const idToken = await idTokens.getIdToken(identity.firebaseUid, actionId, { target: planId });
      const url = planItemUrl(identity, planId, itemId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'PUT', headers: { 'if-match': 'null_etag', 'content-type': 'application/json' },
        body: JSON.stringify(record), signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-plan-create-network'); }
      if (response.status === 200) return 'created';
      if (response.status === 412) return 'exists';
      if (response.status === 401 || response.status === 403) throw denied(`domain-plan-create-${response.status}`);
      throw transport(`domain-plan-create-${response.status}`);
    },
    /** The exact keyed child, as the owner (null = authoritatively absent; unknown is never absent). */
    async readPlanItem(identity, planId, itemId) {
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = planItemUrl(identity, planId, itemId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-plan-item-read-network'); }
      if (response.status === 401 || response.status === 403) throw denied(`domain-plan-item-read-${response.status}`);
      if (response.status !== 200) throw transport(`domain-plan-item-read-${response.status}`);
      return boundedSourceJson(response);
    },
    /** The calendar plan record and its ETag, as the ordinary owner (no action claim). */
    async readCalendarPlanWithEtag(identity, planId) {
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = planRecordUrl(identity, planId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'GET', headers: { 'X-Firebase-ETag': 'true' }, signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-plan-record-read-network'); }
      if (response.status === 401 || response.status === 403) throw denied(`domain-plan-record-read-${response.status}`);
      if (response.status !== 200) throw transport(`domain-plan-record-read-${response.status}`);
      const etag = response.headers.get('ETag');
      if (!etag) throw transport('domain-plan-record-etag-missing');
      return { value: await boundedSourceJson(response), etag };
    },
    /** Compare-and-set of that record, as the ordinary owner, through the unchanged plan rules. @returns {Promise<'written'|'changed'>} */
    async putCalendarPlanIfMatch(identity, planId, record, etag) {
      if (typeof etag !== 'string' || !etag || !record || typeof record !== 'object' || Array.isArray(record)) throw new AuthorityBoundaryViolation('plan record write requires a record and an ETag');
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = planRecordUrl(identity, planId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'PUT', headers: { 'if-match': etag, 'content-type': 'application/json' },
        body: JSON.stringify(record), signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-plan-record-write-network'); }
      if (response.status === 200) return 'written';
      if (response.status === 412) return 'changed';
      if (response.status === 401 || response.status === 403) throw denied(`domain-plan-record-write-${response.status}`);
      throw transport(`domain-plan-record-write-${response.status}`);
    },
    async readCapture(identity, captureId) {
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = captureUrl(identity, captureId, idToken);
      let response;
      try { response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }); }
      catch { throw transport('domain-capture-read-network'); }
      if (response.status === 401 || response.status === 403) throw denied(`domain-capture-read-${response.status}`);
      if (response.status !== 200) throw transport(`domain-capture-read-${response.status}`);
      return boundedSourceJson(response);
    },
    /**
     * Reads rooms/<identity.roomId>/<collection> as the owner. Returns the parsed value (null = authoritatively
     * absent). Throws RETRYABLE_TRANSPORT when the outcome is unknown (timeout, 5xx, unreadable body): unknown
     * is never reported as absent.
     */
    async readRoomCollection(identity, collection) {
      if (!READABLE_COLLECTIONS.has(collection)) throw new AuthorityBoundaryViolation('collection is not readable through the Action API');
      if (!validFirebaseUid(identity?.firebaseUid) || identity.roomId !== `uid_${identity.firebaseUid}`) throw new AuthorityBoundaryViolation('room is not derived from the bound UID');
      const idToken = await idTokens.getIdToken(identity.firebaseUid);
      const url = new URL(`${databaseUrl}/rooms/${identity.roomId}/${collection}.json`);
      if (namespace) url.searchParams.set('ns', namespace);
      url.searchParams.set('auth', idToken);
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      } catch { throw transport('domain-read-network'); }
      if (response.status === 401 || response.status === 403) throw denied(`domain-read-${response.status}`);
      if (response.status !== 200) throw transport(`domain-read-${response.status}`);
      return boundedSourceJson(response);
    },
  });
}
