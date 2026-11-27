# TASK-055 — Option B: one stored copy of time entries (plan)

Status: **plan only, not approved for implementation.** Queued by owner decision QUEUE-20261126-B item 8
("A+B": Option A ships in this release, Option B is the next dedicated storage project). Red zone: entry storage,
accounting envelope, crash recovery. Landing gate for every implementation task below: **`approved` (held)**, never `done`.

Author: Claude (architect), 2026-11-27, static reading of the TASK-050 tree (`70986e0` + docs to `48c8f83`) and the
recorded evidence. No code was run for this plan. Line numbers refer to that tree and will drift; re-locate by
function name via `CODEMAP.md` before editing.

Evidence used:
- `D:/ChronaSenseQualificationEvidence/20261126-queue/task-045/diagnosis.log` (per-part envelope sizes, E=2489, pre-A)
- `.../task-046/mixed-projection.json` (mixed workload, pre-A, commit 120dba5)
- `.../task-050/mixed/mixed-projection.json` (same harness after Option A, commit 70986e0)
- DECISIONS #45 and #47; `planning/PROPOSALS.md` "Storage headroom after TASK-045"

---

## 0. Summary

- **Today (after Option A)** each time entry is held in localStorage **three times in steady state**, plus a fourth
  transient copy during the first hydrate. At the owner's scale (E=2,489) that is about 4.3M of the ~5.24M-character
  origin quota. Each copy costs about 571–580 characters per entry.
- **Recommendation:** a staged, expand-then-contract change that keeps **one canonical copy** in the existing
  localStorage envelope:
  - **B1:** stop persisting the `ta3-entries` compatibility cache once a confirmed envelope exists. Live main already
    tolerates this state: it is the at-quota removal path, `storage.js:1101-1137`.
  - **B2:** store only `committed.value.physicalEntries` and derive `committed.value.entries` in memory. This needs an
    envelope codec, shipped first as a reader-only release.
  - **B3:** stop the first hydrate from holding a second full physical copy.
  - **B4:** bound the drop-map residue.
  - **Option C (IndexedDB for entries)** is designed here but deferred. It becomes necessary only when one copy no
    longer fits: about E ≈ 7,500, or about 3× today.
- **Projected headroom** (model in §3, calibrated against the TASK-050 probe), measured to the localStorage wall:
  - **Today:** about 27–29 day-equivalents at E=2,489, and 2× does not fit at all.
  - **B1 only:** about 150 day-equivalents.
  - **B1+B2(+B3+B4):** about 400 day-equivalents at E=2,489, and about 240 at 2× (E=4,978). 5× needs Option C.
- **No entry schema change, no RTDB/rules change.** Each entry's bytes are unchanged; only how many local copies exist changes.

---

## 1. Current state (precise)

### 1.1 Every place an entry is persisted locally

| # | Store (key) | What it holds | Size at E=2,489 | Writer (file:line) | Readers (file:line) |
|---|---|---|---|---|---|
| L1 | localStorage `ta3-accounting-state-v1:<owner>`, field `committed.value.entries` | App-shape entry array, the confirmed projection | **1,421,345** (571.0/entry) | `AccountingCommand.save()` `accounting-command.js:183-187`, called from `commitProjection()` `:629-651`; the value is built by the `project` hook `index.html:3123-3173` (`result.entries =` `:3159`), `accountingConfirmedFrame()` `:3263-3335` (`:3280`), `reconcileAccountingServer()` `:3414-3470` (`:3459`) and `hydrateFocusAccountingFrame()` `focus-mode.js:193-211` (keeps the base `entries`) | `coordinator.restore()` `accounting-command.js:952-960` → `applyAccountingFrame()` `index.html:2427-2470` (becomes the `entries` global); `retainUnconfirmedCompatibilityCaches()` `index.html:2616-2650` (`:2619`); `accountingCacheWitnesses()` `:2862-2880` (`:2864`); `syncAccountingCompatibility()` `:3380-3400` (compares the live frame) |
| L2 | same envelope, field `committed.value.physicalEntries` | RTDB-shape raw map `{physicalKey: record}` incl. `_csWrite` stamps, the server's last confirmed bytes | **1,443,811** (580.1/entry) | same commit paths: `index.html:3160`, `:3334`, `:3465`, `focus-mode.js:209` (`= raw.entries`) | `applyAccountingFrame()` → `_accountingRawEntries` `index.html:2449`; patch preconditions `EntryPhysicalKeys.resolve(before.physicalEntries…)` `:3489`, `:3823`, `:3915`; `accountingConfirmedFrame()` `base.physicalEntries` `:3268-3272` |
| L3 | localStorage `ta3-entries:<owner>` (compatibility cache) | `JSON.stringify(entries)` sorted newest first | **~1,421,345** (fails at quota before the first cut; fits after it) | `persist()` `storage.js:1140` via `persistCompatibilityCache()` `:1101-1137`, called from `applyAccountingFrame()` `index.html:2465` and ~20 other `persist()` call sites | `bindAccountLocalState()` `storage.js:394-398` (boot/account bind, before restore); `restoreUnifiedAccounting()` `index.html:2551-2557` (captured as legacy evidence **only when no committed envelope exists**); `retainUnconfirmedCompatibilityCaches()` `:2637-2643` (stale/unknown detection); `accountingCacheWitnesses()` `:2867-2876` (archive protection); `legacyCachesOnServer()` `:3234-3235`; `hydrateAccounting()` `sourceCaches` `:3374-3376` (only with no committed) |
| L4 | same envelope, `history[]` record `input.frame` of the **first** `hydrate-accounting` | `captureAccountingFrame()` `index.html:2392-2402` taken before any commit: `entries` is `[]` there (cleared at `:2564`), `physicalEntries` holds the full listener raw map | **1,443,271** frame chars (diagnosis "hydrate-accounting … frame 1443271") | `hydrateAccounting()` `index.html:3361-3377` → `coordinator.capture()` `accounting-command.js:255-275` → import → commit into history | Only replay/inspection; archived to IndexedDB by the Option A cut once the envelope passes 3 Mi (`index.html:2792-2808`) |
| L5 | localStorage `ta3-accounting-capture-v1:<owner>:<id>` intake slots | A captured operation before import. The first hydrate's slot holds L4 again, and a `legacy-accounting-caches` capture holds the raw `ta3-entries` string | transient; up to 1.44M (hydrate) or 1.42M (legacy) | `capture()` `accounting-command.js:255-275` | `captures()`/`importCaptures()` `:188-200`, `:325-337`; slot removed after import |
| L6 | envelope `history[]` record `input.source['ta3-entries']` of a `legacy-accounting-caches` op | Raw pre-accounting/old-tab cache string (evidence) | 0 in the probes; up to one full copy on upgraded installs | `restoreUnifiedAccounting()` `index.html:2558-2560`; `syncAccountingCompatibility()` `:3389-3392` | `legacyCachesOnServer()` `:3227-3260`; **never archived** (Decision 47, `legacy-*`) |
| L7 | IndexedDB `chronasense-accounting-archive` / `history` | Archived history records (incl. the L4 first hydrate after the cut) | not counted against the localStorage wall | `AccountingHistoryArchive.store()` `index.html:2899-2965` | `warm()`/`verified()`/`read()` same block |
| L8 | per-op `before`/`after` frames, `records` | Changed records only. Whole entry arrays are deleted before capture (`index.html:3529`, `:3916`, `:15192`) | ~1 entry per op | `buildAccountingInput` family | history readers |

Checked and not entry copies: `ta3-time-ack:<room>` (Undo receipt, ~1K), `lastUndoAction` (~925), the timer/away/break
caches, `ta3-settings`/`ta3-plans`/reviews, the Firebase Auth IndexedDB, and the service-worker Cache Storage
(app shell only). The RTDB web SDK runs without disk persistence. No other root file reads `ta3-entries` or the
envelope key (grep of `*.js|*.mjs|*.html` outside `www/` and tests: only `storage.js`, `index.html` and
`accounting-command.js`).

### 1.2 Why each copy exists (decision history)

- **L3 `ta3-entries`**:
  - Before TASK-039 it was *the* local store. "Remote Cross-Account Isolation V1" scoped it per room (`storage.js:55-75`).
  - TASK-039 kept it as a **compatibility cache**, for four reasons:
    - older builds and the boot bind read it (`storage.js:394`);
    - with no envelope it is captured as legacy evidence (`index.html:2551`);
    - a stale value written by an old tab or old build must be detected and retained, never overwritten
      (`retainUnconfirmedCompatibilityCaches`, CODEMAP "TASK-039 qualification closure");
    - it is the rollback path to pre-envelope builds.
  - Commit `c647e75` (on live main `0ff39ec`) already removes it at quota when a confirmed log exists and the cache is
    proven known or captured.
- **L1 + L2 both in `committed.value`**:
  - The coordinator commits **one frame value**, and `applyAccountingFrame()` installs it field by field.
  - `entries` is the app view.
  - `physicalEntries` is the exact server bytes. The physical-key compatibility closure (TASK-039, extension numeric
    keys vs app `e_` aliases, `EntryPhysicalKeys`) needs those bytes for conditional-write preconditions and for
    "server changed since" checks.
  - Nobody chose to store both. They are two fields of the same frame object.
- **L4/L5 first hydrate frame**:
  - The first hydrate captures the device's pre-receipt runtime as evidence (Decision 44 / TASK-039 no-envelope bootstrap).
  - Flags `refFirstHydrate` (A1b, SHA reference instead of bytes) and `stripFirstHydrate` exist, default OFF
    (`index.html:2804-2805`, `accounting-command.js:476-485`, `index.html:2966-2990`).
  - Option A archives the record after the first verified cut.
- **L6**: legacy evidence is the only copy of pre-accounting device facts, so Decision 47 never archives it.

### 1.3 Sizes and growth at E=2,489

| Point | Total LS chars | Envelope | Entry copies | Source |
|---|---|---|---|---|
| Pre-A, day 0 (first start) | 4,311,664 | 4,307,364 (L1+L2+L4) | 3 (L3 write **fails**: 9 quota errors) | task-046 probe |
| Pre-A, day 6 | 5,129,633 | 3,683,423 | 3 | task-046 probe; 122K/day; ≈7 day-eq |
| Post-A, day 2 (after first cut) | 4,572,091 | 3,140,221 | 3 (L3 fits) | task-050 probe |
| Post-A, day 6, E=2,543 | 4,681,650 | 3,235,440 | 3 | task-050 probe; 27.4K/day day-end, 12.7–13.4K/day peak; 26–50 day-eq |

Steady-state decomposition at day 6 after A:
- **Three entry copies:** about 3 × 576 × 2,543 ≈ 4.39M.
- **Everything else:** about 0.30M. That is the history sawtooth of 53–77 records, the drop maps, checkpoints and the other keys.
- **Daily growth:** about 9 entries/day × 3 copies ≈ 15.5K, plus about 3.5K/day of `droppedIds`/`droppedEventKeys`
  residue (Decision 47).

---

## 2. Design alternatives

Common constraints for every option:
- No entry schema change and no RTDB rules or wire change.
- The coordinator's synchronous lock-held `load`/`save` with byte readback (`accounting-command.js:132-139`, `:183-187`) is preserved.
- No startup auto-repair beyond what is listed (Decision 44).
- Vanilla JS, no build step, no new dependency.

### B1 — Do not persist the `ta3-entries` cache while a confirmed envelope exists

- **Change:**
  - In `persist()` (`storage.js:1140`), when the owner has `committed`, skip the write.
  - If a cache key still exists, remove it only under the **same proof the quota path already uses**
    (`storage.js:1108-1126`): every record is known to the confirmed log, or its exact bytes are held by a captured
    `legacy-accounting-caches` op. Otherwise keep it, and keep writing as today.
  - With no committed envelope (signed in before the first receipt), behaviour is unchanged.
  - The same applies to `ta3-focus-redemptions` (small, for symmetry; optional).
- **Bytes saved:** about 1.42M at E=2,489 (571/entry).
- **Read paths:**
  - `bindAccountLocalState` (`storage.js:394`) reads `'[]'` and then restores from the envelope synchronously
    (`:446`). The boot order is unchanged, so Hard Rule 8 holds.
  - `retainUnconfirmedCompatibilityCaches` and `accountingCacheWitnesses` treat absence as `[]`, so there is nothing
    unknown and nothing to witness. This is correct, because absence carries no unconfirmed fact.
  - `legacyCachesOnServer` and the hydrate `sourceCaches` run only without a committed envelope.
  - **Must verify:** every non-accounting reader of the `entries` global gets it from the envelope restore and never
    from the cache. Static reading says yes: the only cache read is the bind.
- **Crash/consistency:** removal is a single synchronous `removeItem`, after the proof and after the envelope already
  holds everything. A crash before the removal leaves an extra copy. A crash after it leaves the envelope as the
  source. Nothing is lost in either case.
- **Multi-tab:**
  - An old-build tab keeps rewriting the cache on each `persist()`, and the new tab removes it again after proof.
    Correctness holds; the cost is wasted writes.
  - An old tab writing a *stale* cache is detected exactly as today, captured as evidence, and never deleted unproven.
- **Android WebView:** no change in kind. It frees quota in the same origin bucket.
- **Hard Rules:**
  - 1–3 untouched (display helpers).
  - 4/6/7 untouched.
  - 8: the restore order is unchanged; add a regression test.
  - 9 (red zone): the proof-before-delete is the safeguard.
- **Schema/RTDB:** none.
- **Rollback:**
  - Live main `0ff39ec` already runs with the cache absent after its own at-quota removal (`c647e75` is in
    `0ff39ec`'s storage.js). On boot it reads `[]`, restores from the v1 envelope, and recreates the cache, or
    removes it again at quota.
  - The envelope format is unchanged, so this is **fully rollback-safe**.
- **Risk:** low.

### B2 — One canonical copy inside the envelope (store `physicalEntries`, derive `entries`)

- **Change:**
  - Add an optional `codec` to `createCoordinator()`, applied only inside `load()` and `save()`. On save,
    `encode(state)` replaces `committed.value.entries` with a small descriptor, but **only if**
    `derive(committed.value.physicalEntries)` reproduces the array exactly. Otherwise the entries are stored inline,
    so the change fails open to today's format.
  - On load, `decode` re-derives them. `derive = EntryPhysicalKeys.project(physical).entries`, plus the producer's
    exact ordering rule.
  - Each commit producer sets `entries` from `project(raw.entries)` and `physicalEntries = raw.entries` from the same
    `raw` (`index.html:3159-3160`, `:3280` + `:3334`, `:3459` + `:3465`). `project` returns `null` or throws on
    conflicts (`:3124-3125`, `:3266`), so a committed frame always has a conflict-free bijection.
  - **But ordering is not uniform:** `:3459` does not sort, while `:3159` and `:3280` do. The descriptor must therefore
    record the ordering rule (`{ $derived: 'physical-v1', order: 'tsStart-desc' | 'project' }`), or the codec must
    store inline whenever exact equality fails.
  - Readback stays byte-exact on the **stored** string (`save()` compares raw). `validatedRaw` memoizes per raw string,
    so derivation runs once per new envelope string, not on every `snapshot()`.
- **Bytes saved:** about 1.42M (L1).
- **Read paths:** none outside the coordinator. Every reader gets the decoded state from `load()`/`snapshot()`.
  - Hot paths are `snapshot()` from `retainUnconfirmedCompatibilityCaches`, `syncAccountingCompatibility` and the
    persist quota path. These need a perf check at 2×E.
  - Derivation costs one `project()` pass, which is already done per command at `:3124`.
- **Crash/consistency:** unchanged. There is still one synchronous `setItem` + readback per commit, with no second store.
- **Multi-tab:** every tab running a codec-aware build reads both encodings. **A tab running an older build reads an
  encoded envelope as malformed:**
  - `validateEnvelope` does not inspect `committed.value`.
  - `applyAccountingFrame` would install a non-array `entries`, which breaks rendering silently. That is a Hard Rule 9
    style "app lies" failure.
  - So **B2 needs expand/contract:** release N ships the decoder only, and the encoder stays off. Release N+1 enables
    the encoder. Until N+1, no envelope on any device is ever encoded.
  - The old build's behaviour against an encoded envelope must also be made fail-closed, and tested.
- **Android WebView:** same as today.
- **Hard Rules:** 1–8 untouched (the coordinator is internal). Rule 9 is the main risk; mitigate with the
  inline-on-mismatch fallback and a digest check (below).
- **Schema/RTDB:** none. The envelope format gains one optional descriptor, which is a local format change.
  **Decision needed (DECISIONS #48).**
- **Rollback:** see §4.2. Rolling back to N works. Rolling back to anything older than N (including `0ff39ec`) needs
  a re-inline step, or must be prevented.
- **Risk:** medium.

### B3 — First hydrate without a second physical copy

- **Change:** turn on the existing reference mechanism for the first hydrate (`refFirstHydrate`, A1b,
  `index.html:2966-2990`), or strip the frame's `physicalEntries` at commit (`stripFirstHydrate`,
  `accounting-command.js:476-485`). Pick whichever keeps the evidence semantics of Decision 44. A1b keeps a SHA
  reference and treats a changed value as a conflict, never a guess.
- **Bytes saved:** removes the transient L4/L5 copy (about 1.44M at E=2,489; about 2.9M at 2×).
- **Why it matters:** without it, **a first sign-in on a new device at 2× cannot fit even after B1+B2**. The transient
  would be 2.88M committed physical + 2.88M frame, which exceeds the wall.
- **Risk:** medium. These flags were built default-off and never qualified under the mandatory suite. Treat them as new code.

### B4 — Bound the drop-map residue

- **Problem:** `droppedIds`/`droppedEventKeys` grow by about 3.5K/day (Decision 47). After B1+B2 this is about 40% of
  daily growth, and about 1.4M over 400 days.
- **Options:**
  - Fold ids into the checkpoint that owns them (`droppedIds[id] = checkpointId` is already a many-to-one map, so a
    per-checkpoint id list is about 30% smaller).
  - Or move drop maps older than the oldest live dependency into the IndexedDB archive, behind the same
    verified-copy rule.
- **Status:** needs its own audit, because `accountingExistingEvent` and `resolveDropped` read these maps. Listed here
  so the headroom projection is honest. It can ship after B1/B2.

### C — Entries in IndexedDB, localStorage holds a small index (deferred design)

- **Change:**
  - Write `physicalEntries` in content-addressed chunks (for example one chunk per local calendar month of `tsStart`)
    to a new IndexedDB store, using the `AccountingHistoryArchive` pattern: write, read back in a fresh transaction,
    and compare with `TimeAckCore.same`.
  - The envelope stores `{ $chunks: [{ key, digest, count }] }` and commits only after every referenced chunk is
    verified. Superseded chunks are garbage-collected only when no envelope (current, or a pending readback)
    references them.
- **Bytes saved (localStorage):** all entry copies. The localStorage wall stops being the limit; Chromium's origin
  IndexedDB quota is a share of disk, typically hundreds of MB or more.
- **Read paths:** **the coordinator's `load()` is synchronous and called from synchronous callers** (`snapshot()` in
  `persist`, retention, witnesses, and `restoreUnifiedAccounting` at boot inside `bindAccountLocalState`). C therefore
  needs:
  - an asynchronous boot step that loads the chunks into memory **before** `restoreUnifiedAccounting()`;
  - a synchronous in-memory chunk cache keyed by digest;
  - asynchronous reloads when another tab commits a new digest.
  - This restructures boot: Hard Rule 8 (restore before `renderToday()`) must be re-proven, and Hard Rule 6 (the
    heartbeat IIFE runs first and once) must stay untouched.
- **Crash/consistency:**
  - The two stores are not atomic together, but chunk-first then envelope gives a safe order. A crash in between
    leaves an orphan chunk, which is harmless.
  - An envelope that references a missing chunk (partial site-data clear, IndexedDB corruption) must **fail closed
    and re-hydrate from the server**. Confirmed entries are on the server, but unconfirmed ops are not, so they must
    never depend on chunk contents.
- **Multi-tab:** IndexedDB transactions are atomic per store. Cross-tab cache invalidation comes from the
  localStorage `storage` event on the envelope key.
- **Android WebView:**
  - localStorage and IndexedDB share one origin bucket, and Chromium evicts best-effort origins as a whole, so C is
    not *less* durable than today.
  - `navigator.storage.persist()` could be requested; it is an owner decision, with a UX prompt on some browsers.
  - IndexedDB failures (private mode, old WebView, full disk) must fall back to the inline format.
- **Hard Rules:** 6 and 8 are directly exposed. Rule 9 has high exposure.
- **Schema/RTDB:** none.
- **Rollback:** older builds cannot read chunks, so a re-inline step is required. At large E, re-inlining may not fit,
  so rollback has a size ceiling.
- **Risk:** high. Recommended only when the k=1 ceiling (about E ≈ 7,500) comes into view, or if the owner wants 5×
  headroom now.

### Rejected

- **Compression** (an LZ-string-style codec in a vendored file). CPU cost on every commit for about 1.4M of JSON on
  Android, a new code dependency, byte readback over an encoded string, and it still leaves three copies. B1+B2 gives
  more with less risk.
- **Keep `entries` canonical and derive `physicalEntries`.** The physical map is the server's truth: it carries the
  physical keys (extension numeric keys vs `e_` aliases) and the `_csWrite` revisions that preconditions use
  (`index.html:3268-3272`, `:3489`). Rebuilding the map from the app view needs a side table, and gets the
  precondition bytes wrong if that table ever drifts. Derive the view from the truth, not the reverse.
- **Drop `physicalEntries` and re-read the server per command.** Offline commands would lose their precondition basis.

---

## 3. Recommendation and projected headroom

**Direction:**
1. B1 first: rollback-safe, low risk, and it removes 1.42M.
2. Then B2 via expand/contract (reader release N, encoder release N+1).
3. B3 and B4 alongside, with C designed but deferred, and an explicit trigger to start it.

**Rationale:**
- B1 alone moves the wall from weeks to about 5 months at owner scale, with no format change and a rollback that
  live main already handles.
- B2 is the only change that reaches "one copy" without touching the synchronous coordinator contract or the boot
  order.
- C is the only path to 5×, but it reopens Hard Rules 6/8 and the boot sequence. North-star #3 says not to take that
  risk before it is needed.

**Model** (calibrated against the TASK-050 day-6 sample: predicted 4.70M vs 4.68M measured):

```
total(E, D) = k · c · (E + n·D) + H + r·D
c = 576 chars per copy per entry (avg of 571 app + 580 physical)
H = 302K non-entry overhead (history sawtooth + other keys, post-A)
n = 9 entries/day (probe workload — real rate to be measured; see Q5)
r = 3.5K/day drop-map residue (Decision 47); r = 0 if B4 bounds it
W = 5,242,880 (probe wall; prior bracket 5,241,910–5,242,939)
day-equivalents = (W − k·c·E − H) / (k·c·n + r)
```

| Configuration | copies k | E=2,489 | E=4,978 (2×) | E=12,445 (5×) |
|---|---|---|---|---|
| Today (post-A) | 3 | ~29 (measured 26–50) | **does not fit** (8.6M) | does not fit |
| B1 | 2 | ~150 | **does not fit** (5.7M) | does not fit |
| B1+B2 | 1 | ~404 | ~239 | **does not fit** (7.2M) |
| B1+B2+B4 (r≈0) | 1 | ~677 | ~400 | does not fit |
| C (entries in IndexedDB) | 0 in LS | IndexedDB-quota bound (years) | same | same |

Caveats:
- First-sign-in transient: without B3, B1+B2 at 2× fails on a fresh device (§2 B3).
- The k=1 ceiling is about E ≈ (W − H − 1 page-op margin) / c ≈ 8,000, or about 7,500 with margin. At 9 entries/day
  that is roughly 1.5 years from today. This is the trigger for C.
- The archive threshold (3 Mi, `index.html:2792`) becomes inactive below that envelope size. History then grows up to
  3 Mi before the first cut. That stays under the wall, but the post-B mixed probe must measure the real sawtooth.
- Every figure above is a model. TASK-055-F re-measures with the unchanged mixed harness.

---

## 4. Migration plan

### 4.1 Forward (in place, idempotent, resumable)

**B1 (release N):** there is no migration step. The steady-state rule is enforced at `persist()`:
1. Precondition: the owner's envelope has `committed`, and `window._accountingLegacyLoadError` is unset.
2. Run `retainUnconfirmedCompatibilityCaches(coordinator)`. Any unknown cache bytes are captured as a
   `legacy-accounting-caches` op, with readback.
3. Remove `ta3-entries:<owner>` only if it is fully known, or its exact raw bytes are in a captured op. Re-read the key
   and confirm it still equals the raw value that was proven (the same as `storage.js:1124-1125`).
4. Any failure (unreadable cache, capture quota, unreadable envelope) means: **keep the cache and keep writing it as today.**
5. Re-running is a no-op. A crash at any step leaves either both copies or the envelope alone, and the envelope always
   holds everything.

**B2 (release N reader, N+1 encoder):**
1. Release N: `decode` accepts both inline and descriptor forms, and `encode` is the identity. Ship and soak.
2. Release N+1: `encode` runs inside `save()` under the account Web Lock:
   - (a) Clone the state.
   - (b) Compute `derived = derive(physical, order)`.
   - (c) Require `TimeAckCore.same(derived, committed.value.entries)`. Also require
     `sha256(JSON.stringify(entries)) === descriptor.digest`, with the digest stored in the descriptor.
   - (d) Write the descriptor form.
   - (e) Read back the raw string, **decode it**, and require the decoded `entries` to equal the pre-encode `entries`
     byte for byte (`JSON.stringify`).
   - (f) On any mismatch, rewrite inline. If that fails at quota, the prior bytes are still intact, because `setItem`
     either succeeded with the encoded form, whose decoded check then failed, or never ran.
3. No separate migration pass. The first commit after N+1 encodes. An envelope that never commits again stays
   inline, which is valid forever.
4. `decode` failure on load (the digest does not match the derivation, or `project()` reports conflicts) means
   **fail closed**:
   - Treat it like today's unreadable envelope (paused, `accounting-recovery-unconfirmed`).
   - Retain the bytes unchanged.
   - Never re-derive from guesses.
   - Recovery is a later explicit, locked re-hydrate from the server (owner-approved procedure, like Decision 44).

**B3:** a flag-to-default change, effective on the next first hydrate. Existing envelopes are unaffected, because
the frame they already hold is archived by A.

**B4:** follows its own audit. It must preserve `validDropMaps()` (`accounting-command.js:168-182`).

### 4.2 Rollback to the previous release

| From → to | What the old build sees | Outcome |
|---|---|---|
| B1 (N) → `0ff39ec` / A-release | v1 envelope, **no** `ta3-entries` | Same state as live main after its own at-quota removal. Boot reads `[]`, restores from the envelope, and rewrites the cache (or removes it at quota). **Safe; no loss, no duplication.** Must be proven by a synthetic downgrade test (TASK-052 found this class untested). |
| B2 encoder (N+1) → N | descriptor envelopes | N decodes. **Safe.** |
| B2 encoder (N+1) → older than N | descriptor envelope it cannot read | **Unsafe**, so it is prevented. N+1 never ships unless N has been the rollback target. The release packet must state "rollback target for N+1 is N, never earlier". If a deeper rollback is ever needed, N+1 ships a `ta3-accounting-flag-inline-entries` kill switch that re-inlines on the next commit. Run it, verify, then roll back. |
| C → anything | chunk references | Requires a re-inline that may not fit at large E. Defined in C's own plan. |

Pending/unconfirmed operations live in `queue`, intake slots and `history`, none of which B1 or B2 touches. A rollback
therefore cannot drop or replay them twice: the old build's drain sees the same op ids and phases.

### 4.3 Multi-version window (old tab + new tab, same device)

- **B1:**
  - The old tab rewrites `ta3-entries` after each of its commits, and the new tab removes it after proof. Each is
    safe on its own.
  - At quota, the old tab's write fails into its existing removal path.
  - A stale old-tab cache is captured as evidence, never deleted unproven.
  - Test: two contexts, one on the A-release build and one on N, interleaving Start/Stop/edit while offline and
    online, then reload both.
- **B2:**
  - N and N+1 tabs interoperate: N decodes, and N+1 encodes on commit.
  - An **A-release tab** cannot coexist with N+1. That is the reason for the N gate.
  - Service-worker update timing means an old tab can outlive a deploy by hours. N must therefore be live long enough
    that no pre-N tab is plausibly open. The owner sets the soak (Q2).
- Account switch (`bindAccountLocalState`) is per-owner key, so nothing crosses accounts.

---

## 5. Verification plan

**Data:** synthetic only, never real records.
- Seed E=2,489 through the existing perf/mixed harness (`tests/zz-perf-profile.spec.js` seeding, the
  `task-050/mixed/mixed-settled.spec.mjs` harness).
- Add envelopes written by `0ff39ec`, by the A-release candidate, and by N, captured as fixtures like
  `task-050/migration/`.
- Include the shapes below.

| Shape | What it is |
|---|---|
| Extension-numeric physical keys | Records under extension numeric keys instead of app `e_` aliases (`EntryPhysicalKeys` alias cases). |
| Unsorted `project()` frames | Produced by `reconcileAccountingServer`. |
| Upgraded install | Has an L6 legacy record. |
| Pending ops | Pending offline Start/Stop. |
| Page-held capture | A capture that is still page-held. |
| Unconfirmed Undo | An Undo that is not yet confirmed. |
| Live Focus chain | A Focus chain that is still running. |
| Stale cache | A stale `ta3-entries` written by an old tab. |

**Fault injection** (loopback, `tests/accounting-storage-durability.spec.js` style):

| Fault | Scenarios |
|---|---|
| Quota | At B1 removal; at B2 encode and readback; at the B3 first hydrate at 2×E. |
| Unreadable or deleted IndexedDB | A/B3 archive interplay. For C: a missing chunk. |
| Kill mid-step | Page close between proof and `removeItem`, between encode-write and decoded readback, and during the first hydrate import. |
| Multi-tab | A-release + N, N + N+1. |
| Account switch | During removal. |
| Offline | Offline → online with pending ops across an upgrade, and across a downgrade (N→A, N+1→N). |

**Invariants checked after every scenario:**
- The entry digest set is identical (`EntryPhysicalKeys.content` per id).
- Unfiled/device-only records are unchanged.
- Pending op ids and phases are unchanged.
- Nothing is filed or sent twice. Check the RTDB emulator write log.
- No false crash-recovery modal (Hard Rule 4/6).
- The timer hero is restored before render (Hard Rule 8).

**Gates** (each task as applicable, all at the end on the candidate):
- `npm test`; `node scripts/runtime-mirror.mjs --check`; `git diff --check`; lint.
- New focused unit tests: codec round-trip and derive-equality property tests over random physical maps, including
  alias keys and ties.
- Mandatory accounting **490**: 10 specs, 3 shards, one worker, quiet.
- `tests/accounting-storage-durability.spec.js` and `tests/zz-perf-profile.spec.js`, **unchanged**: E=2489,
  PERF_OPS=0,40. Also re-run perf at E=4,978 as an evidence probe, because B2 adds a derive on load.
- Wider classifier (1107, `scripts/ci-run-wider.mjs`, 0 outside `scripts/ci-known-failures.json`).
- Mixed probe (same harness as task-046/050): stored characters per day and the day-equivalent projection.
  **Target: at least 120 day-equivalents at E=2,489 for B1, and at least 300 for B1+B2**, with both estimators
  reported. Repeat at E=4,978 for B1+B2(+B3).
- Household 11/11.
- Release artifacts rebuilt with `scripts/build-release-artifacts.mjs`, pins justified byte for byte, packaged
  62/62, and independent APK parity and signature checks.
- Hosted CI on a new release branch (explicit refspec, never main), as in TASK-053.
- Physical-device steps for the owner: Android WebView quota at 2×E, and an upgrade over a real-shaped (synthetic)
  profile on a dedicated device profile.

**Acceptance (project level):**
- In steady state, each confirmed entry is stored once in localStorage (B1+B2). The only exceptions are a transient
  during a single commit, and the evidence records listed in §1 that Decision 47 keeps.
- No forward-migration, rollback (to the declared target) or multi-version scenario loses, duplicates or alters a
  logged entry, an unfiled record or a pending op.
- No entry schema, RTDB rules or wire change.
- Hard Rules 1–9 hold, with regressions for 4, 6 and 8.

**Independent review points** (a separate agent each time, at most two fix/review cycles before escalation):
1. B1 design + DECISIONS #48 text, before code.
2. B1 implementation.
3. B2 codec design (derive equality, ordering, descriptor format, fail-closed load), before code.
4. B2 reader release N.
5. B2 encoder N+1, plus the rollback/multi-version evidence.
6. B3/B4 each.
7. Final requalification.

**Gate: `approved` (held)** for every task. The owner merges.

---

## 6. Draft task breakdown (for Claude planning; not recorded in TASKS.md)

Every task listed here has **owner: codex** and **gate: `approved`**. Each carries the same constraints:
- no entry schema, rules or RTDB change;
- Hard Rules 4/6/7/8 untouched;
- root/www parity.

**TASK-055-A — DECISIONS #48 + fixtures (docs/test-only)**
- Files: `DECISIONS.md`; `tests/fixtures/storage-b/` (synthetic envelopes from `0ff39ec`, the A-release candidate and
  the shapes in §5); one fixture-generator script.
- Acceptance:
  - #48 states the one-copy rule, the B1 proof-before-delete, the B2 descriptor and the fail-closed load, the
    rollback-target rule and the C trigger.
  - Fixtures load cleanly under the current build (a no-op test).

**TASK-055-B — B1: stop persisting `ta3-entries` once a confirmed envelope exists**
- Files: `storage.js` (`persist()` only); `www/storage.js`; a new `accounting-entry-cache-b1.test.cjs`; a new focused
  browser spec; `npm test` wiring.
- Acceptance:
  - Steady-state localStorage drops by about one entry copy, measured.
  - No `ta3-entries:<owner>` key exists after the first commit, unless it is unproven, in which case the key is kept
    and its bytes are captured.
  - The behaviour with no envelope is byte-identical to today.
  - A synthetic downgrade to `0ff39ec` and to the A-release passes with no loss, no false modal, and the cache
    recreated.
  - The multi-tab A-release + N scenario passes.
  - The Hard Rule 8 boot-order regression passes.
  - The mixed probe reaches at least 120 day-equivalents at E=2,489.
  - Full gates (§5).

**TASK-055-C — B2 reader (release N): envelope codec, decode only**
- Files: `accounting-command.js` (`createCoordinator` `codec` option, `load`/`save` only); `index.html` (coordinator
  construction `:3003`, `derive` helper next to `EntryPhysicalKeys` use, via CODEMAP); `www/` mirrors; unit property
  tests; CODEMAP.
- Acceptance:
  - Decoding a descriptor envelope yields exactly the inline state.
  - Inline envelopes are unaffected.
  - A digest or derive mismatch fails closed with the bytes unchanged.
  - `encode` is the identity, so no stored byte changes in this release. Prove it with byte-identical envelopes
    before and after across the mandatory suite.
  - Perf: `snapshot()` cost at E=4,978 is within the perf-profile budget.

**TASK-055-D — B2 encoder (release N+1)**
- Depends on: N released and soaked (owner).
- Files: same as C, plus the `ta3-accounting-flag-inline-entries` kill switch.
- Acceptance:
  - The encoded envelope saves about one copy.
  - Write → decoded readback equality on every commit, with an inline fallback.
  - Rollback N+1→N is safe, and the kill switch re-inlines.
  - The N + N+1 multi-tab scenario passes.
  - Fault injection: quota and a kill between write and readback.
  - Mixed probe at least 300 day-equivalents at E=2,489, and the projection at 2×E reported.

**TASK-055-E — B3: first hydrate by reference**
- Files: `index.html` (`accountingCompactionFlags`, `hydrateAccounting`/`hydrateRef` area); `accounting-command.js`
  only if the strip path is chosen; tests.
- Acceptance:
  - A first sign-in on a fresh profile at E=4,978 (synthetic) completes under the wall, with Decision 44 evidence
    semantics preserved.
  - A changed referenced value is a conflict.
  - The existing hydrate regressions pass.

**TASK-055-F — B4: drop-map residue audit + bound**
- Design-first, in DECISIONS: the readers of `droppedIds`/`droppedEventKeys`, then the chosen bound.
- Acceptance: `validDropMaps()` semantics are preserved, and daily residue growth is at most 0.5K/day in the mixed probe.

**TASK-055-G — Requalification + release packet**
- TASK-052/053/054 shape: every gate in §5, upgrade and downgrade on synthetic profiles, hosted CI, and the owner's
  device checklist.

**TASK-055-H (deferred) — Option C design spike**
- Start only on the trigger (E approaching about 7,000, or an owner request).
- Deliverable: a boot-sequence design that preserves Hard Rules 6 and 8, plus an IndexedDB failure and eviction matrix
  for Android WebView.

---

## 7. Open questions for the owner

1. **Approve the direction:** B1 → B2 (expand/contract) → B3/B4, with C deferred to a trigger? Or go straight to C for
   5× headroom (higher risk; it reopens the boot order)?
2. **Rollback window for B2:** B2 needs a reader release N before the encoder N+1. The rollback target for N+1 is
   then N, never live main. How long should N soak, and in how many releases? A suggestion is at least one release
   cycle and at least 7 days.
3. **Upgraded-install legacy evidence (L6):** may a `legacy-accounting-caches` history record that
   `legacyCachesOnServer()` proves fully on the server be archived to IndexedDB, under the verified-copy rule? Decision
   47 currently never archives `legacy-*`. On a device that went through the pre-accounting upgrade it may be a fourth
   full copy. We have not yet measured how common that is. TASK-055-A fixtures will show it.
4. **`navigator.storage.persist()`:** request persistent storage on web and Android (fewer evictions; some browsers
   prompt)? It is relevant now for the IndexedDB archive and mandatory if C ships.
5. **Capacity target:** use measured day-equivalents at E=2,489 with the probe's 9 entries/day, or the owner's real
   daily entry rate? The headroom figures scale with it. Proposed targets: ≥120 (B1) and ≥300 (B1+B2). Also confirm
   that "fits at 2×E including a first sign-in on a new device" is a requirement (it forces B3).
6. **`ta3-focus-redemptions`:** include it in B1 for symmetry (small savings, same proof), or leave it unchanged to
   minimise the change surface?
