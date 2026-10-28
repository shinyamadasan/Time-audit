# Direct selection — minimal contract proposal, before implementation

Status: **GATE FAILED; direct selection is not connected.** Initial review found the proposed
extension bounded, but implementation proof and subsequent independent review exposed the writer
replay gap below. Experimental changes are quarantined in review artifacts; all production promotion,
rules, storage and authority files are restored to d7e01d0. No strict global-cap/atomicity guarantee.

The existing claim makes destination identity and schedule recoverable, but not the edited headline,
notes, priority kind or overnight day offset. The source mismatch fix in d7e01d0 protects a fresh
claim's source facts; it does not persist a deferred selection's source precondition or edited intent.
`normalizeCapture` reconstructs an allowlisted claim and strips additional fields. `buildPlanItem`
reconstructs kind `task` and the source text. Foreground `ok:true` means local finalization, not a
combined durable receipt. Reusing those results as a confirmed edited priority would be incorrect.

## Required extension, confined to existing claim and fence

1. Selection creates only account/target-bound UI draft metadata: capture ID, a frozen source
   precondition, exact chosen kind/headline/notes/start/duration/day offset and canonical target.
   No claim/write occurs until Save; duplicate clicks select the same capture once. Classification
   is never inferred or changed. Returning to Brain Dump retains the existing draft protections.
2. Save must compare the frozen source precondition INSIDE every authoritative capture transaction
   callback, not refresh it from the current local cache. Bind semantic source fields plus lifecycle
   generation (claimEpoch/reopenCount, status and source revision); an edit/reopen since selection
   refuses that item. Exact retries of an existing claim compare the ENTIRE intent before success.
3. Persist the exact validated immutable creation intent on that existing claim before creation:
   kind, headline, bounded notes, start, duration, day offset, target ID/key/timezone/boundary and a
   deterministic intent identity. Recovery must use that intent, never source text or device tomorrow.
   Source text remains the capture's text. No secondary task store or UI-only recovery of a claim.
4. A version barrier is mandatory: old normalizers strip new fields and old recovery creates the
   wrong item. A new capture schema/claim version must be unreadable/fail-closed to old recovery;
   rules must reject downgrade, intent mutation/removal, mismatched fence creation and old-style
   finalization of the new claim. Existing v1/v2 captures and existing promotions retain their rules.
   Merely adding optional fields or a client feature flag is insufficient.
5. Create only at the existing deterministic fenced child. Recovery validates exact target and
   generation, respects revoked/expired claims and tombstones, and never overwrites a divergent item.
   An already edited destination is a conflict/review outcome, never an invitation to recreate it.
6. Confirmation must separately inspect authoritative exact fence presence and source disposition.
   Per item: not attempted / source changed / claim pending unknown / claimed awaiting item /
   item confirmed awaiting disposition / confirmed / conflict. A timeout is unknown, not rejection.
   Local availability is distinct from server confirmation. A retry resumes the SAME capture/intent.
7. Preparation and several promotions are not atomic. Preserve partial outcomes per item and draft;
   never mark the whole plan saved/synced if any required step is unknown. Re-read the target before
   preparation; mixed ordinary draft edits must not replace remotely recovered fenced items.

## Specific unresolved viability checks

- Does the existing authority enforce the three-priority limit at a server-arbitrated point shared by
  ordinary preparation, direct claim recovery and competing devices? If it only checks a local array,
  a remotely durable `kind:priority` claim can become impossible to fulfill after another device fills
  the Top 3. Do not silently demote it, delete it or finalize it as if its exact intent succeeded.
- Can existing confirmation APIs prove the source disposition remotely without treating a locally
  finalized repository record as durable? If not, a new exact confirmation seam is required.
- Enumerate every claim reader/normalizer, generated Function copy and server rule transition before
  choosing the compatibility barrier. Unknown-field stripping is already demonstrated by TASK-031.

## Proof required before connecting UI

Focused actual-function tests: old clients cannot consume/mutate a new claim; transaction retry after
source edit/reopen refuses; two different edited intents conflict; interrupted create recovers exact
kind/headline/notes/overnight time; destination divergence/tombstone is preserved; remote source
confirmation is distinguished from local finalization; offline/late completion/repeated Save is
recoverable with one identity; two devices filling the last priority slot converge without an
unfulfillable claim. Rule tests must exercise old-client payloads against the actual emulator.

Independent review must first decide whether these guarantees fit a bounded extension of the current
authority. If a shared priority reservation/commit protocol is necessary, report that exact blocker
and retain completed visual work. Do not improvise a reservation store or claim cross-store atomicity.

## Reviewed refinement

Read-only reviewer `/root/task028_independent_review` initially considered a strict global capacity
guarantee, then explicitly withdrew that as stronger than the owner's actual requirements. Existing
Top 3 checks are local. A remotely claimed priority blocked by capacity remains a visible per-item
conflict, retrying the SAME intent when the owner frees a slot. It never silently changes kind. If the
day ends first, existing revocation/remote presence-or-absence/epoch recovery releases or completes it.
Concurrent overflow remains visible for the existing explicit overcapacity review. No new task store,
live cancellation, claim retargeting or strict reservation protocol is promised.

The wire barrier will be capture schema 3, with `draftIntent` persisted on claim, promotion and expired
claim. It contains v=1, kind, task, description, whenDayOffset, timezone, and the frozen source facts
(text, importance, urgency, status, revision/writer, reopenCount, claimEpoch). Claim timing and physical
target remain their existing fields. All intent comparison and recovery uses those persisted fields.
New claims require matching source facts/revision in the transaction; old schema readers fail closed.
All version-2-stamping recovery/reopen transitions must preserve schema 3. New claim finalization needs
exact remote destination content, and confirmed UI success additionally needs an exact remote source
read. Divergent/deleted destination remains conflict. Partial saves preserve draft and per-item receipts.

## Second gate: precise remaining issue

The source/intent extension is insufficient while initial creation recovery still uses the ordinary
`pushFencedItems` → `mergeCalendarPlanRecords` last-writer merge. A device with no cached destination
can replay a newly stamped creation over an unseen owner edit. Afterwards exact readback falsely
looks like successful fulfillment because the edit has already been overwritten. The retained probe
uses those actual functions and the experimental committed-rules interpreter and reproduces it.
It is a synthetic contract gap, not evidence of a counted production incident.
The reproduction uses the unreleased schema-3 proposal; it does not by itself establish the timing
or incidence of this race in the unchanged v1/v2 production workflow. No general production audit was done.

An active-claim-only refusal is also insufficient: delayed creation can arrive after promotion, and
an existing edited/deleted destination makes strict-exact finalization plus absence-only expiry leave
the claim stuck. Data is retained, but there is no complete recovery outcome for that state.

The smallest recommended refinement requires both:

1. An initial create-if-absent / exact-existing operation in the actual atomic fence transaction,
   distinct from later ordinary owner edits. A pre-read or timestamp preference is insufficient.
2. An explicit disposition policy: when exact creation happened and a later owner edit/deletion won,
   may the capture finalize as **initially applied, subsequently changed**, while the planner reports
   that review outcome rather than claiming the current draft was saved exactly?

That policy is not silently added to this visual release. Independent review recommends it as the
next contract decision. Existing immutable `brainDumpOrigin` may prove initial creation without a new
marker if fresh schema-3 claims require the exact destination absent, new creates require exact intent,
old claims cannot acquire that intent, and origin/epoch stays immutable. Those conditions and the
create-only writer must be proven together, including delayed replay after promotion. If this proof
fails, an immutable creation receipt on the same existing fenced item would need separate review.
Neither approach needs a second task store or a strict global priority reservation.

The concrete smallest implementation direction is a promotion-only Plan Authority fulfillment seam:
validate the canonical target/range/cap, perform create-if-absent/exact-existing at the one existing
fence child, and only then project the server result locally. Initial fulfillment must not first call
ordinary local-first `addItem`, which immediately queues the unsafe LWW creation. Keep ordinary later
task edits on their existing path. This seam, source disposition policy and proof are still pending.

Also required before a renewed gate: unconditional origin/epoch binding at new-version finalization,
and bounded unknown outcomes for every new-version foreground revoke/finalize/recover wait. These are
documented prototype findings, not shipped code. No new task was created.

## Evidence and replay

- `review-artifacts/task-033-product-quality/REPLAY_WRITER_RESULT.json`: reproduced owner-edit overwrite.
- `REPLAY_WRITER_EMULATOR_RESULT.json`: the local RTDB server accepts exact creation, a subsequent owner
  edit and the unsafe replay. Run the same probe with `--emulator` (Java 21); no cloud project is used.
- `replay-writer-probe.mjs`: runnable against the unchanged actual writer; no network or storage writes
  except its own result artifact. The experimental rules are read from `contract-prototype/` only.
- `contract-prototype/UNCONNECTED_EXPERIMENT.patch.gz`: scoped experimental source/tests, plus its two new
  confirmation files. Apply only to a disposable copy of d7e01d0 to inspect/replay; never to a release.
- Model/source/recovery/REST positive checks and 170 emulator/SDK/mutation checks passed after fixture
  corrections. They did **not** prove the stronger integration invariant; independent review found the
  missing replay case. Full raw attempts are preserved and are not counted as release acceptance.
