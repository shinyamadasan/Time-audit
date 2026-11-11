# My Day learning and execution task candidate

Branch `local/sop-linked-execution`, on top of SOP-linked Execution V1. It's local: unpushed, unmerged, not deployed.

## What changes

| Task kind | Where it comes from | What My Day shows | Completion |
|---|---|---|---|
| **Learning** | The **existing** Daily Routine learning linkage (`source: 'learning'`, `planId`, and the per-day `links[instance] = {planId, stepId, stepTitle}`). **No new association.** Plan items have no learning linkage today, and none was invented. | The routine card adds "**<Learning Plan title> · Today's step: <step>**". The title is read live, so renames show. | Unchanged: the routine's existing source/manual completion. |
| **Execution** | A My Day plan item linked to an SOP (SOP-linked Execution V1 store `ta3-sops-v1:<room>`). | On the task row: "**SOP 1/3 · Next: <step>**" and an **Open SOP** button. That opens the checklist in the **Procedures (SOPs)** panel under the Anytime lane, where you can also create SOPs and link or unlink them. | **Unchanged:** the task's own checkbox (plan item `done`/`doneAt` via `toggleTimelinePlanDone`). Ticking SOP steps never writes the plan item. |
| **Regular** | Any unlinked plan item. | **Unchanged.** The row HTML is identical (`sopBadgeHtml` returns `''`). The only addition to My Day is one closed "Procedures (SOPs)" panel. | Unchanged. |

Files:
- `sop-ui.js` (new).
- `index.html`:
  - a panel section;
  - 2 import-map pins and 1 module script tag;
  - `sopBadgeHtml(row)` in the timed and anytime plan rows;
  - one `SopUI.setMyDayTasks(...)` call after `renderAnytimeLane`.
- `daily-routines-ui.js`: the plan title on learning cards.
- The `www/` mirror (byte-identical copies, as `scripts/runtime-mirror.test.js` requires).
- The lint list and the ESLint module block (as `npm-test-wiring.test.js` requires).
- Tests.

Not touched: timer, Focus internals, accounting, recovery, Undo, plan stores and their sync, Firebase rules, schema, cross-device sync.

## Evidence to collect (Jomar)

1. `node --test sop-linked-execution.test.js`: 15 tests, covering the model, repository and pure UI helpers.
2. `npx playwright test tests/my-day-learning-execution.spec.js`: 4 tests.
   - **Regular task:** unchanged, the panel starts closed, and no SOP storage is created.
   - **Execution task:** link, tick through to "2/2 All steps done".
     - The plan store is **byte-identical** before and after linking and ticking.
     - The task is completed only by its own toggle (`done` and `doneAt` set).
     - It persists across a reload.
   - **Open SOP from the row:** opens that task's run, and unlinking returns it to a regular task.
   - **Learning card:** shows "Frontend fundamentals · Today's step: Step A". The Learning Plan store is unchanged.
3. Regression:
   - `npx playwright test tests/daily-routines-ui.spec.js tests/daily-command-center.spec.js`;
   - `npm test`, which includes `npm-test-wiring` and `scripts/runtime-mirror.test.js` parity.

## Limitations (stated plainly)

- **Device-local only.** SOPs, links and runs don't sync across devices. Sync would need a new RTDB path and approval.
- **Learning is per routine, not per plan item.** A plain My Day task can't be marked as learning. Adding that would need a new persisted association, which this candidate deliberately doesn't create.
- **"Today's step"** is the step bound to today's routine instance when it was first shown, which is the next incomplete step at that moment. It stays the same for the day, as existing routine behaviour does.
- **Timed Focus is not claimed.** This candidate adds nothing to Focus. A learning routine's existing "Start Focus" button is unchanged and untested here.
- **SOP progress never completes the task**, by design.
- Links whose plan item was deleted are kept harmlessly. They're never shown, because only rendered My Day rows are linkable or displayed. `pruneSopLinks` exists but isn't wired.
- The SOP line sits in the agenda card's body, which the existing Daily Command Center decoration moves there. So it's visible when the task card is expanded, not in the collapsed headline.

## Owner acceptance steps (local build only)

1. Apply the branch locally and serve the app the usual way. Don't deploy.
2. **Regular:** open My Day with a normal task. It looks exactly as before. "Procedures (SOPs)" is a single closed line.
3. **Execution:**
   - Open *Procedures (SOPs)* → *New SOP*, give it a title and 2–3 steps (one per line), then *Save SOP*.
   - Pick a task under *Task*, pick the SOP, then *Link SOP*.
   - Expand that task's card in My Day. It shows "SOP 0/3 · Next: …" and *Open SOP*.
   - Tick the steps in the checklist. The task line updates to "All steps done", and **the task is still not done**.
   - Tick the task's own *Mark done*. It completes as it always has.
   - Reload the page. The SOP progress is still there.
4. **Learning:**
   - With a Learning Plan that has unfinished steps, add a Routine (Manage routines → Add routine) with Completion source *Learning* and that plan.
   - Open Routines → All routines. The card reads "<plan title> · Today's step: <step>".
5. Accept, or note what's wrong. Nothing here syncs, so the other device won't show SOPs. That's expected.
