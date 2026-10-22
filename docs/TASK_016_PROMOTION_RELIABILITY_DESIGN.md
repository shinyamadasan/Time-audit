# TASK-016 — Brain Dump Promotion and Synchronization Reliability

**Status: PLANNING / DESIGN ONLY. Not implementation authorized.**
Audit performed on `main` @ `57754a3dad6817cc00bcc99fbfcf4b6939b35ce7`, 2026-10-21.
Owner authorization covers preparation and planning only. Nothing in this document has been built.

Recommendation up front: **GO for implementation, scoped to §3 Fix A + Fix B + Fix C.**
Rationale and the NO-GO carve-outs are in §8.

---

## 1. The defect, and whether it still exists

### 1.1 What TASK-015 reported

`TASK_015_HANDOFF.md` records a pre-existing defect in the protected sync layer. Under same-browser
two-tab stress (6 Playwright workers), 7 of 240 tray runs and 3 of 240 plain-view runs ended with:

- both tabs showing "Added to today's plan.";
- exactly one `bdp1|<id>` plan item (never a duplicate);
- the capture still `triaged`, still holding its `promotionClaim`, both locally *and* remotely, for 40s+;
- a reload failing to heal it within 10s.

Calling `reconcilePromotionClaim` by hand in the reloaded page finalized it immediately. The handoff's
stated suspicion was a **cross-tab localStorage lost update**, and it was explicit that this was a
hypothesis, not a proven root cause. The owner's instruction for this audit was to not assume it.

### 1.2 Confirmed: the defect remains on current `main`

It does. And the localStorage lost-update hypothesis is **not** the cause of the failure to recover.

I bisected it with a deterministic, offline, two-case reproduction built on the module's own builders
(`buildCapture` -> `triageCapture` -> `claimPromotion`) and the existing in-memory room harness, run
against the current `main` sources. Both cases pass, i.e. both behaviours reproduce:

**Case 1 — the finishing logic is healthy.** `reconcilePromotionClaim()`, invoked directly on the exact
stuck record, returns `ok:true`, settles the capture to `promoted`, and produces exactly one correctly
attributed plan item `bdp1|<id>`. There is nothing wrong with reconciliation.

**Case 2 — nothing invokes it.** The capture stays `triaged` with its claim through the initial listener
delivery, a replayed whole-subtree snapshot, *and* a reconnect `pushAllLocal()`. Measured
`onRemoteChange` calls across all three: **zero**.

### 1.3 Root cause — three mechanisms, trigger-side

**M1 — the `changed` gate swallows the trigger.** `brain-dump-repository.js` `mergeRemote()` computes
`changed = JSON.stringify(local) !== JSON.stringify(merged)` and only writes and reports a change when
they differ. `brain-dump-sync.js` fires `onRemoteChange(id, record)` **only** `if (changed)` — at all
three of its merge sites (the listener path, `pushCapture`'s post-commit merge, and
`finishClaimAttempt`). Once the stuck record is byte-identical locally and remotely — exactly the
post-reload steady state the handoff observed — every subsequent delivery of that record is a no-change
merge, and the listener-driven reconciler is never called again. *This is the measured mechanism.*

**M2 — the only other trigger fires once, too early, and can silently no-op.** The bind-time sweep
`settleAllOutstandingClaims()` exists precisely because "a claim that expired since this device last
looked would never produce a merge change on its own". It is reached only via
`onRebind` -> `globalThis.refreshBrainDumpSurfaces?.()`, dispatched one microtask after `attach()`:

```js
onRebind: () => Promise.resolve().then(() => {
  try { globalThis.refreshBrainDumpSurfaces?.(); } catch { /* UI not mounted yet */ }
}),
```

Two problems. It fires **once per bind with no retry**. And the `?.()` makes it a **silent no-op** when
`brain-dump-ui.js` has not yet evaluated and assigned `globalThis.refreshBrainDumpSurfaces`. In
`index.html`, `storage.js` is a classic script (line 1782) that runs ahead of the deferred brain-dump
module scripts (lines 1814-1815), and `brain-dump-sync.js`'s own bottom block calls `attach()` itself
when it finds the room already joined — which is before `brain-dump-ui.js` (the next module in order)
has evaluated. Recovery on reload therefore depends on winning a module-evaluation race. That is exactly
"ordinary reload did not **reliably** trigger it."

**M3 — the sweep reads an unhydrated cache.** `settleAllOutstandingClaims()` iterates
`repository().listAllRaw()`, the local cache, at bind time — before the listener's first `value` event.
On a reload with warm localStorage it does see the stuck record (so M2 is the binding constraint there);
on a fresh profile or after a cache clear it sees nothing, and no later trigger arrives because of M1.

M2 and M3 are code-grounded and were not separately executed; M1 and the healthy-reconciler result are
measured.

**Why the localStorage hypothesis is the wrong target.** A cross-tab lost update plausibly explains how
the claim first ends up outstanding while the plan item already exists. It cannot explain the
non-recovery, because the non-recovery reproduces with a single client and no competing writer at all:
once local and remote agree, M1 alone is sufficient to strand the record permanently. Fixing the
localStorage write path would therefore leave the user-visible defect in place. The eventual
implementation should still reduce the cross-tab write hazard, but as hardening, not as the fix.

---

## 2. Assessment of the other areas the owner named

| Area | Finding |
|---|---|
| **Cross-tab lost updates** | Real hazard, unproven as root cause, and **not** the cause of the non-recovery (§1.3). Both tabs read-merge-write the whole envelope via `writeEnvelope`. Hardening, not the fix. |
| **Missing reconciliation triggers** | **Confirmed, primary.** M1/M2/M3 above. |
| **Tray double-tap / Today-then-Tomorrow races** | **Confirmed still open** (TASK-015 reviewer S3). `trayPlace()`, `doToday()` and `toggleSchedule()` each check `pendingPromotionIds.has(id)`, but that set is only populated in `reportPromotionOutcome()` *after* the await resolves `'pending'` (`brain-dump-ui.js:336`). During the in-flight window it is empty, so the second tap passes the guard. No duplicate item results — the differing intent is correctly refused by `samePromotionIntent` — but only one of the two user intents is honoured, and the feedback is wrong (next row). Also `pendingPromotionIds` is a module-level `Set`, so it is per-tab only and gives cross-tab taps no guard whatsoever. |
| **Misleading "another device" feedback** | **Confirmed.** `brain-dump-ui.js:369` maps `already-claimed` to "This item is already being added to your plan on another device." and `:558` says "This item was already added to your plan on another device." Both fire routinely for the *same* device and often the same tab. TASK-015 measured the related false conflict in 41/240 tray and 95/240 plain-view stress runs. |
| **Offline / uncertain promotion outcomes** | **Already correct; preserve it.** A `'pending'` claim is treated as genuinely UNKNOWN: Plan Authority is not touched, nothing is written, and the UI says "Still confirming..." rather than success or failure. `settleOutstandingClaim` never releases on uncertainty — unreadable destination, unresolvable target, unknown end state and offline remote all leave the claim as-is. This is a property to protect, not change. |
| **Cross-device and account isolation** | **No defect found.** Claims are arbitrated remotely by `arbitratePromotionClaim` before Plan Authority is touched; the plan item id is deterministic (`brainDumpPlanItemId`), so concurrent devices converge on one item; room ownership is re-checked *at settlement time* in `finishClaimAttempt`, so a late transaction cannot merge into a switched account's cache; the repository is per-room scoped (`ta3-brain-dump-v1:<room>`) and refuses writes with no room joined. Covered by `brain-dump-account-isolation.test.js` and the fence suites. Separate devices do not share localStorage, so the cross-tab mechanism does not apply across devices. |

---

## 3. Bounded implementation design

Three fixes, all client-side, all repairs to existing mechanisms. **No new task store, sync engine or
backend.** No Firebase rules, schema or IAM change. The remote claim protocol, the deterministic plan
item id, CAS arbitration, receipts and the UNKNOWN semantics are all unchanged.

### Fix A — make an outstanding claim reconcilable without a `changed` merge

The bug is that recovery rides on a change signal, when the condition it needs to detect is a *state*,
not a change. Decouple them.

- In `brain-dump-sync.js`, at the listener merge site, after the existing `if (changed) onRemoteChange(...)`,
  also notify when the merged record carries an **outstanding `promotionClaim`** in a non-terminal
  status, even when `changed` is false. Keep it a distinct signal (e.g. `onOutstandingClaim(id, record)`)
  so no existing `onRemoteChange` contract shifts.
- `maybeReconcile` is already idempotent and guarded by `reconciling` plus the status/claim checks, so a
  redundant call is a no-op. This is why the fix is cheap.
- **Bounded, not a loop.** The signal fires only on an actual snapshot delivery, only for records
  holding a claim, and each one settles or is left alone. No timer, no polling, no self-rescheduling.

### Fix B — make the sweep reliable rather than racy

- Remove the dependence on module evaluation order: have `brain-dump-ui.js` **run the sweep once on its
  own initialization** if a room is already bound, in addition to the existing `onRebind` path. Both are
  idempotent, so running both is safe and it removes the race in M2.
- Additionally sweep on the lifecycle events that mean "we may have missed something": `online`, and
  `visibilitychange` -> visible. These are **event-driven, not polled**, and each one runs the same
  idempotent path. This satisfies "recovery occurs automatically on appropriate lifecycle events without
  an unbounded polling or listener loop."
- Make the sweep run *after* first hydration as well as at bind, which closes M3.

### Fix C — honest in-flight state and honest copy

- Add `id` to `pendingPromotionIds` **before** awaiting the claim round trip, not after it resolves
  `'pending'`, and clear it in a `finally`. That makes the existing guards in `trayPlace()`, `doToday()`
  and `toggleSchedule()` actually cover the in-flight window, so Today-then-Tomorrow is refused locally
  instead of producing a false conflict.
- Replace the "another device" strings with copy that does not assert a cause it cannot know — e.g.
  "This item is already being added to your plan." A cross-tab tap is indistinguishable from a
  cross-device one at that layer, so the message must not claim either.
- Cross-tab in-flight coordination is explicitly **out of scope** (see §8 NO-GO): Fix A makes the
  cross-tab outcome *recover*, which is the property that matters.

### Files expected to change

| File | Change |
|---|---|
| `brain-dump-sync.js` | Fix A: outstanding-claim notification at the listener merge site; new optional dep. |
| `brain-dump-ui.js` | Fix A wiring; Fix B init + lifecycle sweeps; Fix C pending-set timing and copy. |
| `www/brain-dump-sync.js`, `www/brain-dump-ui.js` | Regenerated mirrors (parity gate). |
| `brain-dump-sync.test.js`, `brain-dump-promotion.test.js`, `brain-dump-production-ux.test.js` | New deterministic cases per §4. |
| `tests/brain-dump-plan-tray.spec.js` | Browser cases per §5. |
| `index.html` | Brain Dump release token bump only, if the token discipline requires it. |
| `CODEMAP.md`, `CHANGELOG.md`, `TEST_REPORT.md`, `TASKS.md` | Docs + evidence. |

Not touched: `brain-dump-model.js`, `brain-dump-repository.js`, `brain-dump-promotion.js` core phases,
`plan-authority.js`, `storage.js`, `firebase.rules.json`, `functions/`.

---

## 4. Deterministic concurrency and recovery test matrix

All offline, no real Firebase, using the existing in-memory room and rules-enforcing harnesses.

| # | Scenario | Required outcome |
|---|---|---|
| C1 | Stuck claim identical local+remote; listener delivers | Reconciles; capture leaves `triaged`; one plan item. **This is the current regression — it must fail before Fix A.** |
| C2 | Same, after a reconnect `pushAllLocal()` | Reconciles. |
| C3 | Same, on a fresh profile with an empty local cache | Reconciles after first hydration (M3). |
| C4 | `onRebind` fires before `brain-dump-ui.js` evaluates | Sweep still runs via the UI's own init (M2). |
| C5 | Repeated deliveries of the same outstanding claim | Exactly one plan item; `reconciling` prevents concurrent work; no unbounded re-entry. |
| C6 | Today then Tomorrow before the first claim settles | Second tap refused locally; one plan item; no "another device" copy. |
| C7 | Same-tab double tap, same intent | Idempotent success; one plan item. |
| C8 | Two tabs, both intents, both settle orders | Exactly one plan item; both tabs converge; loser sees cause-neutral copy. |
| C9 | Claim settles while the account has switched away | No merge into the wrong cache; claim preserved for its owner. |
| C10 | Claim on an ENDED day | Revoke -> authoritative presence read -> promoted or returned to the active list; never released on uncertainty. |
| C11 | Offline claim, then reconnect | No plan item while offline; UNKNOWN preserved; recovers on reconnect. |
| C12 | Revoked claim present at sweep time | Resolved via `settleOutstandingClaim`, never finalized from local presence. |
| C13 | Archive/delegate attempted while a claim is outstanding | Still refused. |
| C14 | Terminal/malformed record carrying a claim | Still rejected by `normalizeCapture`. |

Mutation discipline, as TASK-015 did: temporarily revert each fix and confirm its targeted case fails.

---

## 5. Real Firebase emulator and browser acceptance plan

- **Emulator (required):** `npm run test:fence`, `test:fence-sdk`, `test:rules-emulator`,
  `test:rules-mutation` — all four must stay green at their current totals (151 in CI). No rules change
  is proposed, so any movement here is a red flag.
- **Browser:** full `npm run test:smoke -- --workers=2` at the current baseline (957 in CI). Add C6/C7/C8
  and a reload-recovery case to `tests/brain-dump-plan-tray.spec.js`.
- **Reload recovery, explicitly:** drive a capture into the stuck state, reload, and assert it settles
  with **no manual action** — the exact scenario that fails today.
- **Stress, to compare against TASK-015's own numbers:** repeat the two-tab race at 6 workers x240 runs
  and require **0 stuck claims** (baseline: 7/240 tray, 3/240 plain view) and 0 duplicates. Also re-measure
  the false-conflict rate against TASK-015's 41/240 and 95/240.
- `npm test`, `npm run lint` (0 errors; warning count must not exceed main's 48),
  `npm run check:www-parity`, `npm run check:firebase-rules`, `git diff --check`.
- Note the known environment hazard: plain `npm ci` fails ERESOLVE; use `--legacy-peer-deps`, as CI does.
  A fresh worktree without `npm ci` cannot run the fence/rules suites at all (`targaryen` is a
  devDependency) — install before claiming a local result.

---

## 6. Risk and rollback assessment

**Blast radius: red zone.** Brain Dump sync and promotion claims sit on Hard Rule 9 (never lose logged
time or a capture). Any implementation lands at `status: approved`, **held for human merge, never
auto-merged**.

| Risk | Severity | Mitigation |
|---|---|---|
| Fix A re-entering reconciliation repeatedly | Med | Signal is delivery-scoped and claim-scoped; `reconciling` guard; no timer. Assert call counts in C5. |
| Lifecycle sweeps becoming a busy loop | Med | Only `online` and `visibilitychange`->visible; no interval; idempotent path. Assert in C4/C5. |
| Fix C's earlier pending-set entry stranding the UI if a path forgets to clear | Med | Clear in `finally`; C6/C7 assert the row becomes actionable again. |
| Reconciling a claim whose day has ended | **High** | Unchanged `settleOutstandingClaim` ordering: revoke first, then authoritative remote presence; never trust local presence. C10/C12. |
| Weakening the UNKNOWN contract | **High** | Explicitly out of scope; C11 pins it. |
| Cross-account leakage | **High** | No change to room scoping or settlement-time ownership re-check. C9 plus the existing isolation suite. |
| www mirror drift | Low | `check:www-parity` is a required gate. |

**Rollback.** Client-only, so rollback is a revert of the merge commit plus a Pages redeploy; no backend
or data migration is involved, and no record written under the fix becomes unreadable without it (the
claim/receipt shapes are unchanged). Baseline for the current production frontend is
`ca2c90f822dc4f8648157fbc62b35324f73f5cca`; the rollback target for a release containing TASK-016 would
be whatever main is at the time, which is `57754a3dad6817cc00bcc99fbfcf4b6939b35ce7` today.

---

## 7. Independent-review requirements

A reviewer who did not build it must, on the exact candidate SHA:

1. Reproduce C1 **failing** before the fix and passing after — the regression is the whole point.
2. Confirm Fix A cannot re-enter unboundedly: read the notification site and assert call counts.
3. Confirm no Firebase rules, schema, IAM or backend change, and that `firebase.rules.json` is untouched.
4. Confirm the UNKNOWN/offline contract is intact in behaviour (C11).
5. Confirm account isolation and settlement-time ownership re-checks are unchanged (C9).
6. Independently run the full emulator and browser gates, and the 6-worker stress comparison in §5.
7. Confirm no historical rewrite: original plan dates/outcomes preserved, no fabricated completion.
8. Verify the user-facing copy no longer asserts a cause it cannot know.
9. Verify `CODEMAP.md` reflects any moved logic.

Builder self-review does not count, per `TASK_015_HANDOFF.md`'s own standard.

---

## 8. GO / NO-GO

**GO** for Fix A + Fix B + Fix C as scoped above.

Why: the defect is confirmed present on current `main`; it is user-visible (a task sits on My Day while
its capture stays in Triaged and the tray keeps offering it); the root cause is now understood and is
narrow and trigger-side rather than architectural; the finishing logic it needs is already correct and
proven; and the fix repairs existing mechanisms without new infrastructure, without touching the backend,
and without weakening the UNKNOWN contract. The residual risk is concentrated in re-entry and
ended-day handling, both of which have deterministic tests and an unchanged safety ordering.

**NO-GO / explicitly out of scope** for this task:

- Any new task store, sync engine, event framework or backend. Prohibited by the owner's instruction and
  unnecessary given §1.3.
- Any Firebase rules, schema or IAM change.
- Cross-tab in-flight coordination (a leader election or a shared lock). Fix A makes the cross-tab
  outcome *recover*, which is the property that matters; a locking scheme is a much larger risk for a
  cosmetic gain.
- Rewriting the whole-envelope read-merge-write in `brain-dump-repository.js`. It is a real hazard but it
  is not this defect's cause, and it is the most dangerous file in the area. If wanted, it is a separate,
  separately reviewed task.
- The TASK-015 limitations unrelated to promotion reliability: stale tray date labels across midnight
  with no re-render timer, calendar-native/Personal-Day accounts unexercised in the browser, the
  undefined `--bd` CSS variable, and Android/Capacitor coverage.

**Owner decision required:** approve implementation of Fix A + B + C, which moves TASK-016 to
`status: codex`. Until then it stays `todo` and nothing is built.
