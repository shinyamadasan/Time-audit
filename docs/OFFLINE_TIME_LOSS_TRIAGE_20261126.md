# Offline / time-loss known-failure triage — TASK-051 (November 26, 2026)

Candidate: **98b32b4** (TASK-048 tree; runtime identical to 3d8c9f9, the TASK-047 wider-run commit).
Live main: **0ff39ec**. Scratch checkouts only (`D:/t/t051`, `D:/t/t051main`). No runtime, test, ledger or
production change was made. Evidence root: `D:/ChronaSenseQualificationEvidence/20261126-queue/task-051/` (`$E` below).

## 1. Verdict

**No RELEASE-BLOCKING case.** Every time-loss-shaped entry in `scripts/ci-known-failures.json` falls into one of
three groups:

- it now passes (F-4 and F-5 among them);
- the test's expectation is obsolete under the owner-approved accounting contract (O1 ACK-gated offline
  confirmation, view-only mirror devices, P4 legacy-cache policy, removed legacy publication path);
- the harness does not install the shipped accounting transport (it uses a 1 ms-per-call mock clock with a
  1000 ms tolerance, or its async calls are not awaited).

For every daily-use case I reproduced the real user path with probes, including reconnect. The original
session and its interval are kept and confirmed exactly once, locally and on the server. Candidate and live main
behave identically on every probe (§5). TASK-041/045 do not touch these paths. TASK-050 has one review item
(§6), not a blocker.

Coverage note: the original daily-use F-1..F-3 / S6 / S7 assertions are *not* required tests today. Their
versioned O1 replacements are in the mandatory 490 and pass on both trees: `accounting-staged-effects.spec.js`
F1-O1 (:428), F2-O1 (:447), O1 accidental recovery 10/45 min (:152), reconnect-before-choice (:340) and
heartbeat-readback endpoint (:321). That is 12/12 on each tree (`$E/mandatory-o1-t051.log`,
`$E/mandatory-o1-t051main.log`). The DEFERRED test-repair task D-1 restores the daily-use originals as required
tests.

## 2. Method

1. Ran `tests/daily-use-reliability.spec.js` in full on both trees, one worker (`$E/cand-daily-use-full.log`,
   `$E/main-daily-use-full.log`). The result was 22 passed and 22 failed on each, with an **identical
   pass/fail set** (`diff` empty).
2. Extracted the first error of every ledger entry from the TASK-047 wider JSON. That run used 3d8c9f9, which
   has the same app runtime as 98b32b4; the only later runtime change is the Life Ledger worker
   (`$E/cand-wider.json`, `$E/ledger-classification.json`, scripts `extract.mjs`/`classify.mjs`).
3. Wrote scratch probes that reuse the daily-use harness verbatim and follow each scenario past the test's
   window. They read the coordinator queue, the provisional view and the server copy, and they reconnect, settle,
   Stop and reopen (`$E/zz-t051-probe.spec.js`; logs `$E/probe-cand*.log`, `$E/probe-main.log`,
   `$E/probe-mirror-ui-*.log`). Identical probes ran on both trees.
4. Ran two controls. (a) `timer-away-account-isolation` with only the acknowledging transport added
   (`$E/zz-t051-ctl-timer-away.spec.js`, `$E/control-timer-away-cand.log`). (b) The shipped capability with no
   transport (`$E/zz-t051-notransport.spec.js`, `$E/probe-notransport-cand.log`).

Repro commands (TMP/TEMP=D:/t, in each checkout):
```
npx playwright test tests/daily-use-reliability.spec.js --workers=1 -g "F-[1-5] "
npx playwright test tests/daily-use-reliability.spec.js --workers=1          # full spec
npx playwright test tests/zz-t051-probe.spec.js --workers=1                   # copy from $E first
npx playwright test tests/accounting-staged-effects.spec.js --workers=1 -g "F1-O1|F2-O1|O1 accidental recovery at|O1 reconnect before recovery choice|O1 heartbeat readback survives"
```

## 3. Summary table — daily-use-reliability (26 ledger entries)

| Case | Candidate / 0ff39ec | Observed vs expected | Real outcome (probe) | Test valid? | Class |
|---|---|---|---|---|---|
| **F-1** offline expired → accidental | fail / fail | `taskStartTime` = T0+1321 ms; test requires < T0+1000 | Session kept: running from original start on reconnect; Stop logs 50 min T0→T0+50 once, local + remote (P-F1, P-F1c) | No — tolerance (§4.1) | DEFERRED (test) |
| **F-2** offline expired → intentional, no false prompt | fail / fail | `entries` empty while offline | Stop held provisionally; after reconnect one entry T0→last observation (5 min), heartbeat null, no prompt on reopen (P-F2c). With no observation at all, 0 min is logged (P-F2) | No — O1 ACK-gating + harness heartbeat (§4.2) | DEFERRED (test) |
| **F-3** offline missed ping, reopen < 2 min | fail / fail | precondition `running` false | Provisional session continues with no prompt; confirmed on reconnect with original start; Stop logs 40 min once (P-F3, P-F3b) | No — reads confirmed globals (§4.2) | DEFERRED (test) |
| **F-4** notification quick log keeps pending start | **pass / pass** | — | — | Yes | Remove from ledger |
| **F-5** quick log duration matches instants | **pass / pass** | — | — | Yes | Remove from ledger |
| S1 survives reload; S1/S2 within interval (×3); S2 longer intentional; S1 online missed ping; S9 midnight | fail / fail | start/end 1219–1321 ms after T0 | Start equals the press instant +1 ms (P-drift) | No — tolerance | DEFERRED (test) |
| S1 longer, online, accidental | fail / fail | recovery text lacks "ping timer also expired" | Copy only. Online restore re-adopts the remote copy and the modal shows "Session logged so far: 5 min" | No — copy | DEFERRED (test) |
| S6 ×2, S7 offline entry kept / pushed / not cross-account | fail / fail | `entries` lacks the offline entry; no "saved locally" toast | Offline Stop shown as "20 min pending" and survives reload. Pushed once to A on reconnect; never shown or written in B (P-S6, P-S6b, P-S7) | No — O1 | DEFERRED (test) |
| S2 quick-log; S5 browser denied; S8; Quick Save Undo (extension) | fail / fail | `_startTimer` → false | The fixture seeds a local-only pre-accounting cache that the server lacks. This gives a `legacy-accounting-caches` conflict with toast "Changing time waits…"; the same seed present on the server starts normally (P-S5, P-S5c) | No — pre-accounting fixture | DEFERRED (test; see D-3) |
| held restore ack ×2 | fail / fail | `__heldTimer` never set | Hooks the `syncTimerState` RTDB transaction that no longer exists (`storage.js:1860` routes to accounting) | No — removed path | DEFERRED (delete tests) |
| numeric identities | fail / fail | `entries[0]` undefined | `quickRetroLog` is async (`index.html:8784`); the entry exists after await with a safe-integer id (P-NUM) | No — missing await | DEFERRED (test) |
| S3 mirror never pings | fail / fail | waits for a countdown reset | No ping, no entry, no own timer write (P-S3a) | Partly — the wait is an implementation detail | DEFERRED (test) |
| S3 stop on one device logs once | fail / fail | mirror `stopAndLog()` logs nothing | The mirror renders no Stop button, only "Take over". Take over then Stop gives one entry with the original start, local + remote (P-S3) | No — view-only contract | DEFERRED (test; packet note §7) |
| S1 in-page ping reload; S5 native | **pass / pass** | — | — | Yes | Remove from ledger |

## 4. Root causes (file:line on 98b32b4; 0ff39ec line in brackets)

### 4.1 Mock-clock tolerance (F-1 and 7 S-cases)
The harness `Date` advances 1 ms per `Date.now()` call (`tests/daily-use-reliability.spec.js:218-228`).
About 1,300 calls now happen during app start before the test presses Start, so `taskStartTime` = T0+1319 ms
(T0+1307 on 0ff39ec). The press instant itself is T0+1318 (P-drift: `startMinusPressMs: 1`). Assertions such as
`toBeLessThan(T0 + 1000)` (:343, :387, :416, :459, :510, :1060, and `sessionKept` :423-424) measure app-start call
volume, not recorded time. For F-1 specifically, `online+500ms` already shows `running: true,
taskStartTime: T0+1321`, which is the original start.

### 4.2 O1: offline time is provisional until acknowledged (F-2, F-3, S6, S7)
Owner decision O1 (Oct 30; CODEMAP "TASK-039 unified accounting") says that confirmed globals and caches
(`entries`, `running`, totals, exports, Undo) change only on server ACK. Offline Start/Stop/recovery are captured
durably in the account envelope and shown through `ordinaryProvisionalState()` (`index.html:3509` [3486]) and
`renderOrdinaryProvisional()`, which displays "Started offline — awaiting sync" or "Saved on this device —
awaiting sync … N min pending". The tests read the confirmed globals while offline, so they fail by design.

- F-3 cannot even build its precondition: `running` is false for an offline-started session.
- F-2 drives the legacy heartbeat (`_startHeartbeat()`), but a provisional session's endpoint is its last
  provisional observation (`observeOrdinaryProvisional`, every 15 s via the 1 s ticker, `index.html:3671`). The
  recovery Stop uses `recovery.shutdownTs` = that observation (`:3743` [3720]; prompt threshold `:3678` [3655];
  `handleRecovery` provisional branch `:5183`). With the harness's clock jump no observation exists, so the
  intentional choice logs start→start, which is nothing (P-F2). When the observer has run (P-F2c), exactly
  T0→T0+5 is logged once.
- **Real-use bound:** an intentional recovery logs up to the last observation, which is at most about 15 s
  before an abrupt close while the page was running. This is the same semantics as the legacy heartbeat (15 s
  writer). There is one difference: the provisional path has no `beforeunload` observation (the
  `index.html:5208` handler only writes the legacy heartbeat when confirmed `running`). Either way, background
  JS suspension on Android stops both writers. Not a regression (§5).

### 4.3 Pre-accounting fixture (S2-quick-log, S5-denied, S8, Quick Save extension)
These tests seed `ta3-entries:<room>` with a record that the server does not hold and no envelope exists. The
first-start upgrade path (owner-direct Nov 5, CHANGELOG "First-start upgrade fix") captures it as
`legacy-accounting-caches` with phase `conflict` and reason `legacy-source-needs-resolution`. Logging then waits:
the status reads "Legacy time needs recovery review. Its original record is retained unchanged… Check now / Keep
server version". With the same record also on the server, Start works at once (P-S5c). This state is reachable
only from a pre-accounting build. 0ff39ec already writes the envelope, so 0ff39ec → candidate does not enter it.

### 4.4 Removed legacy publication path (held restore ×2)
`syncTimerState` (`storage.js:1860`) now delegates to `syncAccountingCompatibility`. The RTDB `transaction`
that the tests intercept is gone, which matches the ledger's own "superseded" note for
`entry-reliability-sdk.test.js`.

### 4.5 Mirror is view-only (S3 stop)
`captureOrdinaryTimer('stop')` refuses a session whose `timerOwnerDeviceId` is another device
(`index.html:3742` [3719]). The mirror UI shows no Stop control: Up Next is in state `remote` with the primary
"Take over", and there are no visible Stop buttons (`$E/probe-mirror-ui-*.log`). `takeOverActiveTimer()`
(`:7895`) followed by Stop logs once with the original start.

## 5. Present on live main? Worsened?

Every daily-use outcome is identical on 0ff39ec and 98b32b4:

- same 22/22 pass/fail split;
- 44 of 47 probe observations byte-identical after masking timestamps;
- the 3 differences are a random operation id, a random retro id, and 1307 vs 1319 app-start clock calls.

The runtime diff 0ff39ec..98b32b4 (`index.html` 75 lines, `accounting-command.js` 70) is TASK-041 orphan
recovery and TASK-045 capture-failure/storage-full messaging. In the ordinary capture path it changes only the
failure toast (`showAccountingCaptureFailure`) and the storage-full display. **Nothing in this triage is made
worse or newly reachable by TASK-041/045.**

## 6. TASK-050 (planned archiving) — review item, not a blocker

`ordinaryProvisionalState()` walks a queued ordinary op's lineage back to its Start through `state.history`
(`index.html:3542`). If an ancestor is missing, it throws `Missing provisional source`, which pauses logging
(`_accountingLegacyLoadError = 'ordinary-source-unreadable'`, `:3643`); it does not lose data. `cutHistory`
(`accounting-command.js:538-560`) pins only *direct* `dependsOn` and `sourceId` of queued, captured or failed
ops, plus `provisionalObserved` keys, and keeps the newest ≥ 50 records. A grandparent Start in the lineage is
not pinned. Reaching this today needs ≥ 50 settled records between a Start's apply and its still-queued
descendant, which is implausible.

TASK-050 widens the eligible kinds (ping, recovery/resume and others). Its per-kind audit should therefore
either pin the **full ordinary lineage** of every queued/captured ordinary op, or show the walk resolves through
`resolveDropped` checkpoints. Add a regression for the pending chain Start → resume → (queued) Stop across a cut.

## 7. Other ledger specs with time-shaped titles (families)

| Family | Specs (ledger count) | Mechanism / evidence | Class |
|---|---|---|---|
| Stub harness without the shipped accounting transport | focus-reload-recovery (24), time-ack-undo (7), time-ack-unknown-hazards (28), timer-away-account-isolation (11), online-planner-sdk-ui quick-log (6), daily-command-center (3), entry-validation (1), no-pc-autostart (1), analytics-truth (3), coarse-life-evidence (2), remaining-remote-account-isolation (18), smoke time/auto-log/Focus subset, learning-plan-ui, daily-routines-ui, guided-measurement-loop, normal-tracking-hud, plan-linkage | These specs load the real `accounting-capability.js` with no acknowledging server, so the capability stays `unverified` and every command is retained. Signatures: "timer did not start", `currentTask ''`, Focus phase `idle`, seeded entries absent, "Legacy time needs recovery review". Control (a): adding only the transport flips 6 of 11 timer-away ledger entries to pass. The other 5 call async `_startTimer`/`startBreak` without awaiting and then mutate globals. Control (b): with no transport the app shows `unverified`, retains a legacy cache and a hydrate, and changes nothing. | DEFERRED (test harness) |
| Rejected acceptance contract | accounting-focus-acceptance-boundary (4) | Encodes the original Focus acceptance the owner did not adopt ("demands removal / activation of ownerless cache"). FA3/FA4-V1 are mandatory and pass. | DEFERRED (retire) |
| Versioned coverage in the mandatory 490 | — | Focus reload/expiry/midnight: `accounting-focus-authority-v1` FA1-V1 (:117, :136, :149), `accounting-qualification-closure` G9-CV1 (:498). Scheduled log: `accounting-staged-effects` (:2395). Offline/recovery: §1. | — |

No entry in these specs is a demonstrated time loss on the shipped transport. The full per-entry list with
family, flag and candidate error is in `$E/ledger-classification.json` (314 entries, 0 unclassified; 17 now
passing in the wider run).

## 8. DEFERRED follow-ups (proposed tasks; none required for this release)

| Id | Scope | Files | Size / risk |
|---|---|---|---|
| D-1 | **daily-use-reliability v2 (test-only).** Capture the press instant instead of T0+1000. Assert offline cases through the provisional view, then after reconnect (exactly-once local + remote). Make F-2/F-3 drive `observeOrdinaryProvisional`. Seed S2/S5/S8/Quick-Save entries server-present or app-created. Await `quickRetroLog`. Use the current recovery copy. Use Take over → Stop for S3. Delete the held-restore pair. Make all of these required, and drop the passing and replaced entries from the ledger. | `tests/daily-use-reliability.spec.js`, `scripts/ci-known-failures.json` | M / none to runtime. Gives F-1..F-3 required daily-use coverage again. |
| D-2 | Wider-suite harness migration: give the stub specs the acknowledging transport (`tests/time-ack-test-server.js`), await async commands, and retire specs superseded by mandatory versions. Spec by spec. | tests only, ledger | L / none |
| D-3 | Pre-accounting device upgrade. A device still on a pre-accounting build with **unsynced** local entries opens the candidate blocked on "Legacy time needs recovery review". Its only exit, "Keep server version" (two-step confirm), discards device-only legacy data by policy P4 (`index.html:3317-3320`). Decide whether an explicit "send my local records" path is wanted. Until then, sync before upgrading. | product decision; index.html legacy reconcile | S–M / red zone |
| D-4 | Intentional recovery of a provisional session shows no "logged so far" duration (legacy prompt does), and `beforeunload` writes no provisional observation (≤ 15 s). Add a duration line and a final observation on unload. | `index.html` restoreOrdinaryProvisional / beforeunload | S / red zone |
| D-5 | TASK-050 audit item in §6 (lineage pinning + regression). | accounting-command.js `cutHistory` | inside TASK-050 |

Packet note (docs only, recommended before the device run): in `docs/RELEASE_PACKET_QUEUE_20261126.md` §5.5
step X2 ("Stop on device A" for a session started on B), the actual UI on A is **Take over here**, then Stop.
Expected: one entry with B's original start, and B shows stopped. Without this the owner may record a false
failure.

## 9. Limits

- Probes use the repository's stub room and acknowledging transport, not production RTDB rules. All
  conclusions assume the production capability is `proven`, i.e. the paired rules are installed (DECISIONS
  #43). Without it, every client holds facts and sends nothing, by design.
- Android background JS suspension (which bounds both heartbeat and provisional observation) was not measured
  on a device.
- The non-daily-use families are classified from wider-run signatures plus two controls. They were not
  individually re-proven, and an independent reviewer should spot-check them (TASK-051 acceptance).

---

## Independent review (2026-11-27) — AGREE: no case is release-blocking

Verdict: `D:/ChronaSenseQualificationEvidence/20261126-queue/task-051/review/VERDICT.md`; the reviewer's own probes in
`.../task-051/review/probes/`. Independently reproduced on 98b32b4 and 0ff39ec with the reviewer's own probes: F-1
(clean clock: original test and all 6 start-tolerance S-cases pass; offline → killed → reopened +45 → accidental →
reconnect → Stop +50 logs one 50-min entry), F-2, F-3, S6/S7, D-3 not reachable from 0ff39ec (served 0ff39ec then the
candidate on one origin: unsynced offline time, an offline running session and an online running timer all carried
over and logged once), held-restore deletion and focus-acceptance-boundary retirement confirmed.

Corrections to this document:
- Start-tolerance S-cases: 6, not 7.
- "No accounting connection" family: the class (test defect, nothing lost) holds, the stated mechanism does not for most:
  time-ack-undo already uses the real connection and fails because Start is pressed before the connection check
  finishes (~3 s); remaining-remote: the connection fixes 3/18, the rest write through a removed publish path and the
  app holds those for review (not lost); focus-reload-recovery: 0/24 fixed by the connection alone; with it, an awaited
  start and waiting for confirmation, the reviewer's 4 Focus scenarios log once. So D-2 is larger than "add the
  connection".

Added follow-ups (deferred, none release-blocking):
- D-3 Android caveat: if the owner's phone runs a pre-accounting build with unsynced offline entries, updating it in
  place opens blocked and the only exit discards that time. Release packet Android step: open the old app online and
  let it sync first.
- D-4 to be raised before any Android release (intentional-close recovery can log 0 min without warning if the page
  was suspended right after Start; same on live main).
- D-6 (UX): "Keep server version" is offered for ordinary offline pending time and holds the entry in conflict instead
  of delivering it; Start is refused for ~1–3 s after the app opens. Both visible, same on live main.
Not covered: Android WebView suspension (needs the phone), hidden-tab throttling, S3 mirror and numeric-identity cases
(code read only), production RTDB rules.
