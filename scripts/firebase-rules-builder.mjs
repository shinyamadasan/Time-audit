// scripts/firebase-rules-builder.mjs
//
// Builds firebase.rules.json. Test/tooling only (never shipped, never imported by the app).
//
// WHY A BUILDER: the Brain Dump promotion fence (DECISIONS #33) needs the same
// authorization logic in three branch-aware copies (calendar / operational / legacy
// fence collections) plus the capture state machine. Realtime Database rules have no
// functions, so the shared predicates are written ONCE here as named fragments and
// expanded into the plain JSON the server reads. Two things follow:
//   - `npm run check:firebase-rules` proves the committed firebase.rules.json is
//     exactly this builder's output (no hand edit can drift from the source);
//   - the mutation tests rebuild the rules with ONE named predicate disabled
//     (`buildRules({ without: ['targetBinding'] })`) and prove the emulator matrix
//     notices, so every predicate is demonstrably load-bearing.
//
// Usage: node scripts/firebase-rules-builder.mjs --write | --check

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES_PATH = path.join(HERE, '..', 'firebase.rules.json');

const ROOM_OWNER = "auth != null && $roomId === ('uid_' + auth.uid)";
const NORMAL_TOKEN = 'auth.token.chronasenseActionId == null';
const ACTION_TOKEN = 'auth.token.chronasenseActionId != null';
const OWNER = `${ROOM_OWNER} && ${NORMAL_TOKEN}`;
const AND = parts => parts.filter(Boolean).join(' && ');
const OR = parts => `(${parts.filter(Boolean).join(' || ')})`;
const group = expression => `(${expression})`;

/** Every named predicate the mutation tests may disable. */
export const PREDICATES = Object.freeze([
  'targetBinding', 'storeBinding', 'originImmutability', 'itemIdBinding', 'revokeMonotonic', 'epochMonotonic', 'tombstoneMonotonic',
  'stableKeyFormat', 'parentOverwriteClosed', 'epochBinding', 'claimIdentity', 'recoveryAbsence', 'finalizePresence', 'claimDeletionClosed',
  'relocationRefused', 'claimSourcePreserved',
  // Action API plan items (TASK-011, DECISIONS #37): a calendar fence child created by the action-scoped token.
  'actionKindBinding', 'actionTargetBinding', 'actionMarkerBinding', 'actionIdMarkerConsistency', 'actionCreateOnly',
  'actionAuthorityRequired', 'actionTombstoneMonotonic', 'actionRelocationRefused', 'actionCaptureKind', 'arrayActionRefused',
  // TASK-012 (DECISIONS #38): an Action API item relocates to another calendar plan only through ONE atomic multi-path
  // update by a plan_move token (destination create + source tombstone, each checked against the other's new state).
  'actionMoveBinding', 'actionMoveSourceLive', 'actionMoveLinked', 'actionMoveSequence', 'actionRelocationImmutable',
  // R1: the move commits only under this action's own short move lock, taken by a conditional PUT on the source's exact
  // content (ETag); while a lock is active no ordinary write can change the source.
  'actionMoveLocked', 'actionMoveLockExclusive', 'actionMoveLockServerTime', 'actionMoveLockRespected',
]);

const ROOM_REF = "root.child('rooms').child($roomId)";
const CAPTURE_STORES = ['calendar', 'operational', 'legacy'];
const FENCE_COLLECTION_BY_STORE = { calendar: 'calendarPlanFences', operational: 'operationalPlanFences', legacy: 'planFences' };
const TARGET_KEY_FORMAT = {
  calendar: '/^cal1:[0-9]{4}-[0-9]{2}-[0-9]{2}$/',
  legacy: '/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/',
  operational: '/^[A-Za-z0-9_-]+$/',
};
const ITEM_ID_FORMAT = '/^bdp1\\|[A-Za-z0-9_-]{3,64}$/';

const ACTION_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ACTION_ITEM_ID_FORMAT = `/^api1_${ACTION_UUID}$/`;
const ACTION_ID_FORMAT = `/^act1_${ACTION_UUID}$/`;

export function buildRules({ without = [] } = {}) {
  const off = new Set(without);
  for (const name of off) if (!PREDICATES.includes(name)) throw new Error(`unknown predicate ${name}`);
  const on = name => !off.has(name);

  // ── capture state machine (rooms/<room>/brainDump/$captureId) ──────────────
  const d = "data";
  const n = "newData";
  const epoch = node => `(${node}.child('claimEpoch').isNumber() ? ${node}.child('claimEpoch').val() : 0)`;
  const DC = `${d}.child('promotionClaim')`;
  const NC = `${n}.child('promotionClaim')`;
  const DP = `${d}.child('promotion')`;
  const NP = `${n}.child('promotion')`;
  const sameFields = (left, right, fields) => AND(fields.map(f => `${left}.child('${f}').val() === ${right}.child('${f}').val()`));
  const active = node => OR([`${node}.child('status').val() === 'untriaged'`, `${node}.child('status').val() === 'triaged'`]);
  const fenceCollectionOf = claim => `(${claim}.child('store').val() === 'calendar' ? 'calendarPlanFences' : (${claim}.child('store').val() === 'operational' ? 'operationalPlanFences' : 'planFences'))`;
  const destination = `${ROOM_REF}.child(${fenceCollectionOf(DC)}).child(${DC}.child('targetKey').val()).child(${DC}.child('planItemId').val())`;
  const claimShape = AND([
    `${NC}.child('planItemId').val() === ('bdp1|' + $captureId)`,
    `(${CAPTURE_STORES.map(s => `${NC}.child('store').val() === '${s}'`).join(' || ')})`,
    `(${NC}.child('type').val() === 'do-today' || ${NC}.child('type').val() === 'schedule')`,
    `(!${NC}.child('targetKey').exists() || ${NC}.child('targetKey').isString())`,
    `!${NC}.child('revokedAt').exists()`,
  ]);
  const claimIdentityFields = ['type', 'store', 'targetId', 'targetKey', 'planItemId', 'when', 'durationMinutes', 'claimedAt', 'claimedBy'];
  const sameClaim = AND([
    on('claimIdentity') ? sameFields(NC, DC, claimIdentityFields) : null,
    on('revokeMonotonic') ? `(!${DC}.child('revokedAt').exists() || ${NC}.child('revokedAt').val() === ${DC}.child('revokedAt').val())` : null,
    on('epochMonotonic') ? `${epoch(n)} === ${epoch(d)}` : null,
    active(n),
  ]);
  const finalize = AND([
    `${n}.child('status').val() === 'promoted'`,
    on('epochMonotonic') ? `${epoch(n)} === ${epoch(d)}` : null,
    sameFields(NP, DC, ['type', 'store', 'targetId', 'targetKey', 'planItemId']),
    // A REVOKED fenced claim may only be finalized when its exact destination really exists.
    on('finalizePresence')
      ? `(!${DC}.child('targetKey').exists() || !${DC}.child('revokedAt').exists() || (${destination}.exists() && ${destination}.child('brainDumpOrigin').child('claimEpoch').val() === ${epoch(d)}))`
      : null,
  ]);
  const recover = AND([
    `${DC}.child('revokedAt').exists()`,
    on('epochMonotonic') ? `${epoch(n)} === ${epoch(d)} + 1` : null,
    active(n),
    // A fenced claim may only be recovered when its exact destination does NOT exist.
    on('recoveryAbsence') ? `(!${DC}.child('targetKey').exists() || !${destination}.exists())` : null,
  ]);
  const withClaim = OR([
    group(AND([`${NC}.exists()`, sameClaim])),
    group(AND([`!${NC}.exists()`, on('claimDeletionClosed') ? OR([group(finalize), group(recover)]) : 'true'])),
  ]);
  const newClaim = AND([active(d), active(n), claimShape, on('epochMonotonic') ? `${epoch(n)} === ${epoch(d)}` : null,
    on('claimSourcePreserved') ? sameFields(n, d, ['text', 'important', 'urgent', 'status']) : null]);
  const claimTransition = OR([
    group(AND([`!${DC}.exists()`, OR([`!${NC}.exists()`, group(newClaim)]), on('epochMonotonic') ? `${epoch(n)} === ${epoch(d)}` : null])),
    group(AND([`${DC}.exists()`, withClaim])),
  ]);
  const promotedImmutable = OR([
    `${d}.child('status').val() !== 'promoted'`,
    group(AND([
      `${n}.child('status').val() === 'promoted'`, `!${NC}.exists()`,
      on('epochMonotonic') ? `${epoch(n)} === ${epoch(d)}` : null,
      sameFields(NP, DP, ['type', 'store', 'targetId', 'targetKey', 'planItemId']),
    ])),
  ]);
  const promotionNeedsClaim = OR([`${n}.child('status').val() !== 'promoted'`, `${d}.child('status').val() === 'promoted'`, `${DC}.exists()`]);
  const schemaMonotonic = OR([`!${d}.child('schemaVersion').isNumber()`, group(AND([`${n}.child('schemaVersion').isNumber()`, `${n}.child('schemaVersion').val() >= ${d}.child('schemaVersion').val()`]))]);
  const captureUpdate = AND([
    `${n}.child('createdAt').val() === ${d}.child('createdAt').val()`,
    `${n}.child('creationActionId').val() === ${d}.child('creationActionId').val()`,
    schemaMonotonic,
    claimTransition,
    promotedImmutable,
    promotionNeedsClaim,
  ]);
  const captureCreate = AND([
    `!${d}.exists()`,
    OR([
      `!${n}.child('creationActionId').exists()`,
      group(AND([
        `${n}.child('creationActionId').isString()`,
        `${n}.child('creationActionId').val().matches(/^act1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)`,
        `${n}.child('creationActionId').val() === auth.token.chronasenseActionId`,
        `${n}.child('id').val() === ('bdc1_' + ${n}.child('creationActionId').val().replace('act1_', ''))`,
      ])),
    ]),
    OR([`!${n}.child('claimEpoch').exists()`, group(AND([`${n}.child('claimEpoch').isNumber()`, `${n}.child('claimEpoch').val() >= 0`, `${n}.child('claimEpoch').val() % 1 === 0`]))]),
    OR([`!${NC}.exists()`, group(claimShape)]),
    OR([`!${NC}.exists()`, active(n)]),
  ]);
  const captureWrite = AND([ROOM_OWNER, `${n}.exists()`, `${n}.child('id').val() === $captureId`, OR([
    group(AND([NORMAL_TOKEN, OR([group(captureCreate), group(AND([`${d}.exists()`, captureUpdate]))])])),
    group(AND([ACTION_TOKEN, `${n}.child('creationActionId').exists()`,
      on('actionCaptureKind') ? "(auth.token.chronasenseActionKind == null || auth.token.chronasenseActionKind === 'brain_dump_add')" : null, captureCreate])),
  ])]);

  // ── fenced plan items (rooms/<room>/<fence collection>/$targetKey/$itemId) ──
  const itemCapture = `${ROOM_REF}.child('brainDump').child($itemId.replace('bdp1|', ''))`;
  const itemClaim = `${itemCapture}.child('promotionClaim')`;
  const itemPromotion = `${itemCapture}.child('promotion')`;
  const origin = node => `${node}.child('brainDumpOrigin')`;
  // ── Action API plan items (rooms/<room>/calendarPlanFences/$targetKey/api1_<uuid>) ──
  // The same location-bound representation as a fenced Brain Dump item (DECISIONS #33/#37). The path IS the
  // identity: CREATE only by the backend's action-scoped token, at exactly the item id, marker and plan its
  // claims name, and only once the account is calendar-authoritative (date routing itself is the backend's,
  // through Plan Authority). UPDATE only by an ordinary owner token, with the marker pinned (the path-bound
  // id must keep deriving from it) and the tombstone monotonic. No delete, no move, no parent overwrite.
  const actionPlanItemRules = () => {
    const marker = `${n}.child('creationActionId')`;
    const authority = on('actionAuthorityRequired') ? `${ROOM_REF}.child('calendarPlanAuthority').exists()` : null;
    const create = AND([
      ROOM_OWNER, ACTION_TOKEN,
      on('actionCreateOnly') ? `!${d}.exists()` : null,
      on('actionKindBinding') ? "auth.token.chronasenseActionKind === 'plan_create'" : "auth.token.chronasenseActionKind !== 'plan_move'",
      on('actionTargetBinding') ? '$targetKey === auth.token.chronasenseActionTarget' : null,
      on('actionMarkerBinding') ? `${marker}.val() === auth.token.chronasenseActionId` : null,
      // A created item has never moved: relocation fields exist only through a plan_move (below).
      on('actionRelocationRefused') ? `!${n}.child('relocationRevision').exists() && !${n}.child('movedToDayId').exists() && !${n}.child('moveLock').exists()` : null,
      authority,
    ]);
    // ── TASK-012 move: the item's OTHER end, in the plan the token names, before (root) and after (newData) this write.
    const before = plan => `${ROOM_REF}.child('calendarPlanFences').child(${plan}).child($itemId)`;
    const after = plan => `${n}.parent().parent().child(${plan}).child($itemId)`;
    const reloc = node => `${node}.child('relocationRevision')`;
    const sameRelocation = (a, b) => AND(['schemaVersion', 'sequence', 'fromDayId', 'toDayId', 'updatedBy', 'updatedAt']
      .map(field => `${reloc(a)}.child('${field}').val() === ${reloc(b)}.child('${field}').val()`));
    const SOURCE = 'auth.token.chronasenseActionSource';
    const DESTINATION = 'auth.token.chronasenseActionTarget';
    const moveToken = AND([ROOM_OWNER, ACTION_TOKEN, "auth.token.chronasenseActionKind === 'plan_move'",
      on('actionMoveBinding') ? `$itemId === auth.token.chronasenseActionItem && ${SOURCE} !== ${DESTINATION}` : null]);
    // R1 move lock { actionId, destination, at } on the SOURCE child. The Function takes it with a PUT whose `if-match`
    // is the source child's ETag (a hash of its exact content), so the lock proves the exact pre-image the move was built
    // from; while it is active (server time < at + 60 s) no ordinary write may change the child, so that pre-image is
    // still current when the atomic relocation commits. `at` must be the SERVER timestamp of the lock write, so no client
    // or Function clock is involved, and the lock expires by itself: a crashed move never freezes the item.
    const moveLock = node => `${node}.child('moveLock')`;
    const lockActive = node => `(${moveLock(node)}.exists() && ${moveLock(node)}.child('at').val() > now - 60000)`;
    const ownLock = node => `${moveLock(node)}.child('actionId').val() === auth.token.chronasenseActionId && ${moveLock(node)}.child('destination').val() === ${DESTINATION}`;
    const lockCreate = AND([
      moveToken, `${d}.exists()`, '$targetKey === ' + SOURCE, `${d}.child('deleted').val() !== true`, `${n}.child('deleted').val() !== true`,
      on('actionMoveLockExclusive') ? `(!${lockActive(d)} || ${moveLock(d)}.child('actionId').val() === auth.token.chronasenseActionId)` : null,
      ownLock(n),
      on('actionMoveLockServerTime') ? `${moveLock(n)}.child('at').val() === now` : null,
      sameRelocation(n, d), `!${n}.child('movedToDayId').exists()`,
    ]);
    // The destination copy: created (never over an existing child), carrying the source's marker and the NEXT relocation,
    // and only together with the source's own tombstone in the same atomic update.
    const moveIn = AND([
      moveToken, `!${d}.exists()`, '$targetKey === ' + DESTINATION,
      on('actionMoveSourceLive') ? `${before(SOURCE)}.exists() && ${before(SOURCE)}.child('deleted').val() !== true` : null,
      // (Both ends' marker is already pinned by the id <-> marker consistency above: one id, one creating action.)
      on('actionMoveSequence') ? AND([`${reloc(n)}.child('schemaVersion').val() === 1`, `${reloc(n)}.child('fromDayId').val() === ${SOURCE}`,
        `${reloc(n)}.child('toDayId').val() === $targetKey`,
        `${reloc(n)}.child('sequence').val() === (${reloc(before(SOURCE))}.child('sequence').isNumber() ? ${reloc(before(SOURCE))}.child('sequence').val() : 0) + 1`]) : null,
      on('actionMoveLinked') ? AND([`${after(SOURCE)}.child('deleted').val() === true`, `${after(SOURCE)}.child('movedToDayId').val() === $targetKey`,
        sameRelocation(n, after(SOURCE))]) : null,
      `!${n}.child('movedToDayId').exists()`, `${n}.child('deleted').val() !== true`, `${reloc(n)}.exists()`, `!${moveLock(n)}.exists()`,
      authority,
    ]);
    // The source copy: tombstoned in place, naming the destination, only under THIS action's active move lock (so it is
    // still exactly the content the lock's conditional write proved), and only with the destination created in the same
    // atomic update.
    const moveOut = AND([
      moveToken, `${d}.exists()`, '$targetKey === ' + SOURCE, on('actionMoveSourceLive') ? `${d}.child('deleted').val() !== true` : null,
      on('actionMoveLocked') ? `${lockActive(d)} && ${ownLock(d)}` : null,
      `${marker}.val() === ${d}.child('creationActionId').val()`,
      `${n}.child('deleted').val() === true`, `${n}.child('movedToDayId').val() === ${DESTINATION}`, `!${moveLock(n)}.exists()`,
      on('actionMoveLinked') ? AND([`!${before(DESTINATION)}.exists()`, `${after(DESTINATION)}.exists()`, sameRelocation(n, after(DESTINATION))]) : null,
    ]);
    const update = AND([
      OWNER, `${d}.exists()`,
      on('actionTombstoneMonotonic') ? `(${d}.child('deleted').val() !== true || ${n}.child('deleted').val() === true)` : null,
      // An ordinary owner write keeps whatever relocation the item has: it can neither move nor fabricate a move.
      on('actionRelocationImmutable') ? AND([sameRelocation(n, d), `${n}.child('movedToDayId').val() === ${d}.child('movedToDayId').val()`]) : null,
      // R1: no ordinary write while a move lock is active, and an owner never creates or alters a lock (it may only
      // keep or drop an expired one, e.g. a client re-pushing the child it folded).
      on('actionMoveLockRespected') ? `!${lockActive(d)}` : null,
      `(!${moveLock(n)}.exists() || (${moveLock(n)}.child('actionId').val() === ${moveLock(d)}.child('actionId').val() && ${moveLock(n)}.child('destination').val() === ${moveLock(d)}.child('destination').val() && ${moveLock(n)}.child('at').val() === ${moveLock(d)}.child('at').val()))`,
    ]);
    const write = AND([
      `${n}.exists()`,
      `$targetKey.matches(${TARGET_KEY_FORMAT.calendar}) && $itemId.matches(${ACTION_ITEM_ID_FORMAT})`,
      `${n}.child('id').val() === $itemId`,
      // In .write, not only .validate: .validate is an OR with the Brain Dump branch, which an origin would satisfy.
      `!${n}.child('brainDumpOrigin').exists()`,
      `${marker}.isString() && ${marker}.val().matches(${ACTION_ID_FORMAT})`,
      on('actionIdMarkerConsistency') ? `$itemId === ('api1_' + ${marker}.val().replace('act1_', ''))` : null,
      OR([group(create), group(update), group(lockCreate), group(moveIn), group(moveOut)]),
    ]);
    const validate = AND([
      `$itemId.matches(${ACTION_ITEM_ID_FORMAT})`,
      `${n}.hasChildren(['id', 'task', 'creationActionId'])`,
      `!${n}.child('brainDumpOrigin').exists()`,
      `(!${n}.child('movedToDayId').exists() || ${n}.child('deleted').val() === true)`,
    ]);
    return { write, validate };
  };

  const fencedItemRules = store => {
    // The origin an item is authorized BY: a create is judged on the origin it brings; an update is judged
    // on the origin ALREADY STORED (and origin immutability then pins the update to it), so immutability
    // is a load-bearing guard, never a restatement of the authorization check.
    const authorizedBy = o => AND([
      `${o}.child('v').val() === 2`,
      `${o}.child('type').isString()`,
      on('storeBinding') ? `${o}.child('store').val() === '${store}'` : null,
      on('targetBinding') ? `${o}.child('targetKey').val() === $targetKey` : null,
      `${o}.child('claimEpoch').isNumber()`,
      on('epochBinding') ? `${o}.child('claimEpoch').val() === ${epoch(itemCapture)}` : null,
      on('itemIdBinding') ? `${itemCapture}.child('id').val() === $itemId.replace('bdp1|', '')` : null,
      OR([
        group(AND([
          `${itemClaim}.exists()`, `!${itemClaim}.child('revokedAt').exists()`,
          on('itemIdBinding') ? `${itemClaim}.child('planItemId').val() === $itemId` : null,
          on('storeBinding') ? `${itemClaim}.child('store').val() === '${store}'` : null,
          on('targetBinding') ? `${itemClaim}.child('targetKey').val() === $targetKey` : null,
          `${itemClaim}.child('type').val() === ${o}.child('type').val()`,
        ])),
        group(AND([
          `${itemCapture}.child('status').val() === 'promoted'`,
          on('itemIdBinding') ? `${itemPromotion}.child('planItemId').val() === $itemId` : null,
          on('storeBinding') ? `${itemPromotion}.child('store').val() === '${store}'` : null,
          on('targetBinding') ? `${itemPromotion}.child('targetKey').val() === $targetKey` : null,
          `${itemPromotion}.child('type').val() === ${o}.child('type').val()`,
        ])),
      ]),
    ]);
    const immutable = on('originImmutability')
      ? AND(['v', 'claimEpoch', 'type', 'store', 'targetKey'].map(f => `${origin(n)}.child('${f}').val() === ${origin(d)}.child('${f}').val()`))
      : 'true';
    const tombstone = on('tombstoneMonotonic') ? `(${d}.child('deleted').val() !== true || ${n}.child('deleted').val() === true)` : 'true';
    const guard = store === 'calendar' ? null : `!${ROOM_REF}.child('calendarPlanAuthority').exists()`;
    const write = AND([
      OWNER, `${n}.exists()`, guard,
      on('stableKeyFormat') ? `$targetKey.matches(${TARGET_KEY_FORMAT[store]}) && $itemId.matches(${ITEM_ID_FORMAT})` : null,
      on('itemIdBinding') ? `${n}.child('id').val() === $itemId` : null,
      OR([group(AND([`!${d}.exists()`, authorizedBy(origin(n))])), group(AND([`${d}.exists()`, immutable, tombstone, authorizedBy(origin(d))]))]),
    ]);
    const validate = AND([
      `${n}.hasChildren(['id', 'brainDumpOrigin'])`,
      on('relocationRefused') ? `!${n}.child('relocationRevision').exists() && !${n}.child('movedToDayId').exists()` : null,
    ]);
    const originKey = key => [key, { '.validate': true }];
    const action = store === 'calendar' ? actionPlanItemRules() : null;
    return {
      [FENCE_COLLECTION_BY_STORE[store]]: {
        // No `.write` here or on $targetKey: a parent overwrite is never granted, so every
        // write is evaluated at the ITEM, against that item's own data/newData.
        ...(on('parentOverwriteClosed') ? {} : { '.write': AND([OWNER]) }),
        $targetKey: {
          $itemId: {
            '.write': action ? OR([group(write), group(action.write)]) : write,
            '.validate': action ? OR([group(validate), group(action.validate)]) : validate,
            brainDumpOrigin: {
              '.validate': `${n}.hasChildren(['v', 'claimEpoch', 'type', 'store', 'targetKey'])`,
              ...Object.fromEntries(['v', 'claimEpoch', 'type', 'store', 'targetKey'].map(originKey)),
              $other: { '.validate': false },
            },
            // Only an Action API item can carry one (a fenced Brain Dump item refuses it in its own .validate).
            ...(action ? { moveLock: {
              '.validate': `${n}.hasChildren(['actionId', 'destination', 'at']) && ${n}.child('actionId').isString() && ${n}.child('actionId').val().matches(${ACTION_ID_FORMAT}) && ${n}.child('destination').isString() && ${n}.child('destination').val().matches(${TARGET_KEY_FORMAT.calendar}) && ${n}.child('at').isNumber()`,
              ...Object.fromEntries(['actionId', 'destination', 'at'].map(originKey)),
              $other: { '.validate': false },
            } } : {}),
            ...(action ? { relocationRevision: {
              '.validate': `${n}.hasChildren(['schemaVersion', 'sequence', 'fromDayId', 'toDayId', 'updatedBy']) && ${n}.child('schemaVersion').val() === 1 && ${n}.child('sequence').isNumber() && ${n}.child('fromDayId').isString() && ${n}.child('toDayId').isString() && ${n}.child('updatedBy').isString()`,
              ...Object.fromEntries(['schemaVersion', 'sequence', 'fromDayId', 'toDayId', 'updatedBy', 'updatedAt'].map(originKey)),
              $other: { '.validate': false },
            } } : {}),
          },
        },
      },
    };
  };

  // ── legacy (pre-fence) Brain Dump items in an ordinary plan array ──────────
  // An ordinary `items/$i` can never be addressed by the server, so a Brain Dump item is accepted
  // there only on the strength of its capture's own state, and only for a pre-fence claim or
  // promotion (one with no targetKey). A fenced capture's item lives in its fence collection
  // and is refused here, as is any item that carries an origin.
  const legacyCapture = `${ROOM_REF}.child('brainDump').child(newData.child('id').val().replace('bdp1|', ''))`;
  const legacyClaim = `${legacyCapture}.child('promotionClaim')`;
  const legacyPromotion = `${legacyCapture}.child('promotion')`;
  const legacyItemValidate = AND([
    `!newData.child('brainDumpOrigin').exists()`,
    // The api1_ namespace and the Action API marker exist only at an action item's keyed fence child (#37).
    on('arrayActionRefused') ? "!newData.child('creationActionId').exists() && (!newData.child('id').isString() || !newData.child('id').val().beginsWith('api1_'))" : null,
    OR([
      '!newData.child(\'id\').isString()',
      '!newData.child(\'id\').val().beginsWith(\'bdp1|\')',
      group(AND([
        `newData.child('id').val().matches(${ITEM_ID_FORMAT})`,
        `${legacyCapture}.child('id').val() === newData.child('id').val().replace('bdp1|', '')`,
        OR([
          group(AND([`${legacyClaim}.exists()`, `!${legacyClaim}.child('revokedAt').exists()`, `!${legacyClaim}.child('targetKey').exists()`, `${legacyClaim}.child('planItemId').val() === newData.child('id').val()`])),
          group(AND([`${legacyCapture}.child('status').val() === 'promoted'`, `!${legacyPromotion}.child('targetKey').exists()`, `${legacyPromotion}.child('planItemId').val() === newData.child('id').val()`])),
        ]),
      ])),
    ]),
  ]);
  const arrayItems = { items: { $i: { '.validate': legacyItemValidate } } };

  const ownerWrite = { '.write': OWNER };
  const entryWrite = AND([
    OWNER,
    'newData.exists()',
    OR([
      "data.child('deleted').val() !== true",
      AND(["newData.child('deleted').val() === true", "newData.child('updatedAt').isNumber()", "data.child('updatedAt').isNumber()", "newData.child('updatedAt').val() >= data.child('updatedAt').val()"]),
      AND(["!newData.child('deleted').exists()", "newData.child('id').val() === data.child('id').val()", "newData.child('undoRestoredAt').isNumber()", "newData.child('updatedAt').isNumber()", "data.child('updatedAt').isNumber()", "newData.child('undoRestoredAt').val() === newData.child('updatedAt').val()", "newData.child('updatedAt').val() > data.child('updatedAt').val()"]),
    ]),
  ]);
  const roomChildren = {
    timer: ownerWrite, entries: { $entryId: { '.write': entryWrite } }, intention: ownerWrite, devices: ownerWrite, settings: ownerWrite, templates: ownerWrite, templatesSavedAt: ownerWrite,
    breakState: ownerWrite, awayState: ownerWrite, reviews: ownerWrite, weeklyReviews: ownerWrite, focusRedemptions: ownerWrite, coarseLifeEvidence: ownerWrite,
    dayBoundaryRevisions: ownerWrite, commitments: ownerWrite,
    // No `.write` on brainDump itself: a whole-collection write is never granted, so no parent
    // overwrite can skip a capture's own transition rule (and none can delete one).
    brainDump: { $captureId: { '.write': captureWrite } },
    planByDeadlineRevisions: ownerWrite,
    intentionalOffDays: ownerWrite,
    calendarPlans: { '.write': OWNER, $planId: arrayItems },
    // TASK-018: only the dedicated, owner-authenticated completion service writes resolution facts.
    taskCompletionResolutions: { '.write': false },
    plans: { '.write': `${OWNER} && !${ROOM_REF}.child('calendarPlanAuthority').exists()`, $dateKey: arrayItems },
    operationalPlans: { '.write': `${OWNER} && !${ROOM_REF}.child('calendarPlanAuthority').exists()`, $dayKey: arrayItems },
    ...fencedItemRules('calendar'),
    ...fencedItemRules('legacy'),
    ...fencedItemRules('operational'),
    calendarPlanAuthority: {
      $factId: {
        '.write': `${OWNER} && !data.exists() && newData.exists()`,
        '.validate': "newData.hasChildren(['schemaVersion','id','activatedAtMs','timezone','activationDate','deviceId']) && newData.child('schemaVersion').val() === 1 && newData.child('id').val() === $factId && newData.child('id').val().length <= 200 && newData.child('activatedAtMs').isNumber() && newData.child('activatedAtMs').val() > 0 && newData.child('activatedAtMs').val() <= 8640000000000000 && newData.child('timezone').isString() && newData.child('timezone').val().matches(/^[A-Za-z][A-Za-z0-9_+.-]*(\\/[A-Za-z0-9_+.-]+)*$/) && newData.child('activationDate').isString() && newData.child('activationDate').val().matches(/^[0-9]{4}-((01|03|05|07|08|10|12)-(0[1-9]|[12][0-9]|3[01])|(04|06|09|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-9]))$/) && newData.child('deviceId').isString() && newData.child('deviceId').val().length > 0 && newData.child('deviceId').val().length <= 200",
        schemaVersion: { '.validate': true },
        id: { '.validate': true },
        activatedAtMs: { '.validate': true },
        timezone: { '.validate': true },
        activationDate: { '.validate': true },
        deviceId: { '.validate': true },
        $other: { '.validate': false },
      },
    },
  };
  return {
    rules: {
      '.read': false,
      '.write': false,
      rooms: { $roomId: { '.read': "auth != null && $roomId === ('uid_' + auth.uid)", ...roomChildren } },
      // Action API server-private infrastructure (docs/CHRONASENSE_ACTION_API_V1.md §6): only the backend's Admin
      // credential (which bypasses rules) may touch these. Explicit nodes so the top-level $userNode wildcard can
      // never match them, and no rule anywhere below grants a read or write.
      serverRequestNonces: { '.read': false, '.write': false, $service: { '.indexOn': ['expiresAt'] } },
      serverActionReceipts: { '.read': false, '.write': false },
      pairs: {
        $pairId: {
          '.read': "auth != null && (data.child('creator').val() === auth.uid || data.child('partner').val() === auth.uid)",
          '.write': `auth != null && ${NORMAL_TOKEN} && ((!data.exists() && newData.child('creator').val() === auth.uid && !newData.child('partner').exists()) || (data.child('creator').val() === auth.uid) || (data.child('creator').exists() && data.child('creator').val() !== auth.uid && newData.child('creator').val() === data.child('creator').val() && newData.child('accepted').val() === data.child('accepted').val() && newData.child('createdAt').val() === data.child('createdAt').val() && ((!data.child('partner').exists() && newData.child('partner').val() === auth.uid) || (data.child('partner').val() === auth.uid && !newData.child('partner').exists()))))`,
        },
      },
      $userNode: {
        public: {
          '.read': "auth != null && ($userNode === ('uid_' + auth.uid) || (root.child($userNode).child('partnerUid').val() === auth.uid && root.child('uid_' + auth.uid).child('partnerUid').val() === $userNode.replace('uid_', '')))",
          '.write': `auth != null && ${NORMAL_TOKEN} && $userNode === ('uid_' + auth.uid)`,
        },
        shared: {
          '.read': "auth != null && ($userNode === ('uid_' + auth.uid) || (root.child($userNode).child('partnerUid').val() === auth.uid && root.child('uid_' + auth.uid).child('partnerUid').val() === $userNode.replace('uid_', '')))",
          '.write': `auth != null && ${NORMAL_TOKEN} && $userNode === ('uid_' + auth.uid)`,
        },
        partnerUid: { '.read': "auth != null && $userNode === ('uid_' + auth.uid)", '.write': `auth != null && ${NORMAL_TOKEN} && $userNode === ('uid_' + auth.uid)` },
        pairCode: { '.read': "auth != null && $userNode === ('uid_' + auth.uid)", '.write': `auth != null && ${NORMAL_TOKEN} && $userNode === ('uid_' + auth.uid)` },
        nudges: {
          '.read': "auth != null && $userNode === ('uid_' + auth.uid)",
          // Keep the existing partner grant; a self-link must not grant the recipient creation/edit authority.
          '.write': `auth != null && ${NORMAL_TOKEN} && $userNode !== ('uid_' + auth.uid) && root.child($userNode).child('partnerUid').val() === auth.uid`,
          $nudgeId: { '.write': `auth != null && ${NORMAL_TOKEN} && $userNode === ('uid_' + auth.uid) && !newData.exists()` },
        },
      },
    },
  };
}

export function serializeRules(rules) {
  return `${JSON.stringify(rules, null, 2)}\n`;
}

/**
 * Parity check between the checked-in artifact and the builder's output. The ONLY representation
 * difference tolerated is CRLF vs LF: with `core.autocrlf=true` (and no .gitattributes eol rule) a
 * Windows checkout legitimately holds this file with CRLF while the builder always emits LF. Everything
 * else stays strict -- content, key order, indentation, trailing whitespace and the final newline.
 * It is deliberately NOT a JSON-semantic comparison.
 */
export function artifactMatchesBuilder(current, wanted) {
  const toLf = text => text.replace(/\r\n/g, '\n');
  return toLf(current) === toLf(wanted);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wanted = serializeRules(buildRules());
  if (process.argv.includes('--write')) {
    writeFileSync(RULES_PATH, wanted);
    console.log('firebase.rules.json written');
  } else {
    const current = readFileSync(RULES_PATH, 'utf8');
    if (!artifactMatchesBuilder(current, wanted)) { console.error('firebase.rules.json is NOT the builder output. Run: node scripts/firebase-rules-builder.mjs --write'); process.exit(1); }
    console.log('firebase.rules.json matches the builder');
  }
}
