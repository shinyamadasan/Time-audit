# QA — Pre-Commit Quality Gate

> **Mandatory before every production commit** (the Commit event in `WORKFLOW.md`).
> Two tiers: **AI checks** the agent MUST pass autonomously, and **Human checks** the agent CANNOT
> verify headlessly — it logs those to `STATUS.md` for the human, and they never block a run.
>
> No build step / no test runner: QA here = static verification (grep, read, code-trace) + git/tool
> checks. Each item is something an agent can actually confirm with the tools it has.
>
> **Gate rule:** any failed **AI** check → treat the task as **Blocked** (record in `TASK.md` +
> `STATUS.md`, do NOT commit broken code). Human checks → append a "Needs human verification" note to
> `STATUS.md`; commit may proceed.

*Items marked `[app]` encode this repo's hard rules (CLAUDE.md / DECISIONS). When this OS is reused
for another product, swap the `[app]` items; the six section structure stays.*

---

## 1. Functional Tests (AI)
- [ ] Every event handler resolves: each `on*="fn(...)"` in `index.html`/`app.js` has a matching `function fn` or `window.fn =` (grep handlers → confirm definition). No undefined handler.
- [ ] Each Success Criterion in `planning/TASK.md` is traceable to the code path that satisfies it (code-trace, not assumption).
- [ ] New code has error handling for its realistic failure paths; no uncaught throw on the happy path.
- [ ] `[app]` `_stopHeartbeat()` is still called on **every** clean exit — grep all three: `resetTimer()`, `stopAndLog()`, `confirmExitFocus()`. Missing one = false crash-recovery modal on every next open.
- [ ] `[app]` `doPing()` still contains the device guard `if (timerOwnerDeviceId !== deviceId) return;` (grep) — removing it causes multi-device double-logging.

## 2. Visual & Responsive Tests (AI where possible)
- [ ] No new hardcoded colors: colors in changed CSS use `var(--color-*)`, not raw `#hex`/`rgb()` (grep the diff).
- [ ] Touched inputs keep `font-size >= 16px` (prevents iOS Safari zoom-on-focus).
- [ ] Changed components still respect the `@media (max-width: 768px)` mobile patterns (read).
- [ ] 👤 **Real-device rendering** (iOS Safari + Android Chrome): no clipping/overflow, controls usable.

## 3. Regression Checks (AI)
- [ ] No broken references: every new `getElementById('x')` has a matching `id="x"` in `index.html` (and removed ids have no remaining lookups).
- [ ] No dangling callers: any renamed/removed symbol has **zero** remaining references (grep old name).
- [ ] No dead code introduced: every function added is referenced; functions the change orphaned are removed or flagged.
- [ ] No debug leftovers in the diff (`console.log`, commented-out blocks, `TODO`-without-ticket).
- [ ] `[app]` **Timeline helpers intact** — `clipOverlapsForDisplay()` still returns *shallow copies* (no in-place mutation of `entries`); `mergeConsecutiveForDisplay()` still emits `_mergedIds`; `MAX_GAP_MS` ≤ ~10 min; `computeGaps()` still anchors on `getWorkDayStartTs()` and `MIN_GAP_MIN` ≥ 5 (grep the constants).
- [ ] `[app]` `_todayRenderKey` still uses the `'__FORCE__'` sentinel — never `null` or `''` (both are valid cached states and silently skip the re-render).
- [ ] `[app]` The heartbeat crash-detection IIFE still runs **once, first, undeferred** — not wrapped in a function, not deferred.

## 4. Data Integrity (AI)
- [ ] `[app]` **Timer restore (INIT) still runs BEFORE `renderToday()`** — otherwise the restored timer renders invisible.
- [ ] `[app]` **No logged time can be lost.** No code path deletes or overwrites `entries` without an explicit user action. A lost log cannot be reconstructed (north-star goal #3).
- [ ] `[app]` Any change to the **entry schema** or the **RTDB sync path** is **red-zone** — it must land at `status: approved` for human merge, never auto-ship (CLAUDE Risk-gated merge).
- [ ] Backward-compatible state: new fields are read with `|| <default>`; old saved data can't crash the load.
- [ ] Auto-logged entries still never overwrite manual logs.

## 5. Documentation (AI)
- [ ] **`CODEMAP.md` updated** if code structure moved — function added/renamed/deleted, moved between sections, new feature area, section extracted to a file, or line ranges shifted. (Do **not** update it for bug fixes, copy changes, or array additions.)
- [ ] `DECISIONS.md` updated if a non-obvious choice was made or reversed.
- [ ] `SMOKETEST.md` run for anything user-facing before pushing.
- [ ] `docs/DECISIONS.md` has a new `D-0NN` if a non-obvious choice was made/reversed.
- [ ] `STATUS.md` updated · `planning/DONE.md` appended · `planning/TASK.md` criteria ticked.
- [ ] No line numbers introduced in docs — stable anchors only (DECISIONS D-008).

## 6. Git Hygiene (AI)
- [ ] On the intended branch; `git pull --rebase` done; no unintended divergence.
- [ ] Only intended files staged — `git status` shows no stray/untracked files getting swept in (e.g. `cpb-diet-import.json`).
- [ ] **Code + docs in the same commit** (the golden rule — WORKFLOW.md Commit).
- [ ] Commit message: conventional prefix (`feat`/`fix`/`docs`/…), task-tied, with the `Co-Authored-By` trailer.
- [ ] No secrets in the diff: grep for `github_pat_`, `AIza`, `Bearer `, bot tokens, `*_API_KEY`.

---

## 👤 Human verification (never blocks an autonomous run)
The agent appends these to `STATUS.md` as "Needs human verification" for review after deploy. They
require a real device and human judgment:

- Does it **feel good on a phone**? (tap targets, scroll, no jank)
- Are **animations/transitions smooth**?
- Does the **layout look polished** — spacing, alignment, hierarchy?
- Is the **microcopy clear** and on-voice (warm, kitchen)?
- Does the **interaction feel intuitive**?
- **Real-device rendering**: iOS Safari + Android Chrome match the intended light theme.

---

## Autonomous-run policy (summary)
1. Run the **AI** checks at the Commit event.
2. **Any AI check fails → Blocked.** Record the failure in `TASK.md` (Blocker) + `STATUS.md`; do not commit.
3. All AI checks pass → commit. Append the **Human** checklist to `STATUS.md` as pending verification.
4. Never block a run waiting on a Human check — that's the human's job after deploy.
