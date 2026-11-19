# SOP-linked Execution V1: feasibility and prototype

Status: **prototype (data layer only)**. It's on local branch `local/sop-linked-execution`, off `origin/main` 9fd8c91. It's unpushed, not deployed and not wired into the UI.

## What it is

An **SOP** is a reusable, ordered checklist. A **plan item** can be *linked* to one SOP. Executing the item then walks that SOP's steps, and the item shows its progress and next step. The same SOP can be linked to many items; each link has its own independent **run**.

## What the real data model allows (findings)

| Area | Finding | Consequence |
|---|---|---|
| Plan item shape | `{id, task, when, done, doneAt, updatedAt, updatedBy, kind?}` (`index.html` `createPlanItem`). It's synced through three authority-routed stores (`plans`, `operationalPlans`, `calendarPlans`) with fence and merge code (`plan-authority.js`, `operational-plan-model.js`, `plan-item-origin.js`). | **Don't add a field to the plan item.** The RTDB rules (`firebase.rules.json`) don't allowlist item keys, so it would be *accepted*. But every merge, fence and sync path, plus every older client, would have to preserve it, and that's a cross-store schema change. |
| Plan item identity | Ids are stable strings: `p…` (`createPlanItem`), `bdp1\|…` (Brain Dump promotion), `api1_…` (Action API). | A link can safely be keyed **by item id**, without touching the item. Brain Dump and Action API items are linkable as they are. |
| Daily Routines | A reusable template, per-instance state, and links to Learning steps. They're stored **device-local and room-scoped** (`daily-routines-repository.js`, Device-Local Account Isolation V1). | **The precedent to mirror.** SOPs use the same envelope-per-room pattern. |
| Learning Plans | Ordered steps and `plan_step_completed` Life Ledger events, but progress lives **on the template** (`step.completed`). | It can't be reused as SOP storage, because repeated execution needs a run per execution. Only the pattern is reused. |
| Obsidian | `obsidian-life-ledger-*` is **export-only** (writer). | Writing SOPs as vault notes and reading them back needs a new read path. That's out of V1's scope. |
| Accounting / timer | Not involved. | The prototype touches no accounting, timer, restore or Focus code. |

## Prototype (this branch)

- `sop-model.js`: pure functions.
  - **Templates:** `createSop`, `upsertSop`, `deleteSop`.
  - **Links:** `linkSop`, `unlinkSop`.
  - **Execution:** `setStepChecked`, then `sopRunView`, which returns progress, the next step and whether the run is complete.
  - **Cleanup:** `pruneSopLinks`.
  - **Validation:** strict, so a corrupt envelope is refused rather than guessed.
- `sop-repository.js`: a device-local, room-scoped envelope at `ta3-sops-v1:<roomId>`.
  - No owner gives an empty state and refuses every write.
  - A write is validated before it's saved, then read back.
- `sop-linked-execution.test.js`: 13 node tests, wired into `npm test`, as `npm-test-wiring.test.js` requires.
- Behaviour choices:
  - Progress **never marks the plan item done**; that stays the user's existing action.
  - Re-linking to a different SOP starts a fresh run.
  - Editing an SOP during a run counts against the current steps.

**Not yet:** UI, cross-device sync, Life Ledger events, Obsidian import.

## Blockers for anything beyond local

1. **Cross-device sync** needs a new RTDB path (`rooms/$roomId/sops`), plus rules, emulator tests and a sync module. That's new live structure and needs review and approval. It's deliberately not in V1.
2. **Ledger history** (`sop_step_completed`) would be a Life Ledger contract change (`docs/LIFE_LEDGER_CONTRACT.md`).
3. **Auto-completing the plan item** would write to the plan stores under plan authority. Keep that out until it's explicitly decided.

## Smallest next milestone (M1)

Wire it into the UI, still local only:
- **On a Today plan row:** a "Link SOP" picker, then "SOP 2/5 · Next: …" with an expandable checklist.
- **SOP editor:** a small panel.

That touches `index.html` plan-row rendering (non-accounting), an import-map pin, the `npm run lint` list, and one Playwright spec.

Then:
- **M2:** sync, which needs approval.
- **M3:** ledger events.
- **M4:** Obsidian import.
