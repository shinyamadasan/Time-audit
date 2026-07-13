# Self Review â€” Code Health Gate

> Runs at the **Self Review** event in `WORKFLOW.md` â€” **after Execution, before QA**.
> Two different questions, in order:
> - **Self Review (this file):** *"Is this **good code**?"* â€” simple, maintainable, no debt.
> - **QA (`QA.md`):** *"Does it **work**?"* â€” correct, no regressions, data-safe.
>
> Review your own diff **as if reviewing someone's PR.** This is **AI-verifiable** â€” every item below
> is assessable by reading the diff / grepping the codebase. No device or human judgment required.
> If Self Review finds a problem, **fix it now and re-review â€” before QA** (so QA verifies the clean
> version, not a draft you're about to rewrite).

## The reviewer's mindset
Read the diff and ask: *"If I were reviewing this PR, what would I flag?"*
- Did I **overengineer**? Is this the **smallest** implementation that satisfies the task?
- Did I touch **unrelated** code? (Every changed line should trace to the task.)
- Did I follow the **existing patterns** (one file, global functions, imperative `render*()`)?
- Did I introduce **technical debt** or a shortcut I'd regret in a month?

## Code Health checklist (AI-verifiable â€” read the diff)
- [ ] **No duplicated logic** â€” reuse an existing function/util instead of re-implementing (grep first).
- [ ] **No magic numbers** â€” use a named const/token, or add an explaining comment.
- [ ] **No unnecessary complexity** â€” no abstraction, config, or "flexibility" the task didn't ask for.
- [ ] **No dead code** â€” no unused vars/functions/branches introduced; orphans removed.
- [ ] **No TODO / commented-out code** left behind (unless it's a tracked ROADMAP item).
- [ ] **Reuse checked** â€” is there an existing helper that already does this? (grep before adding one.)
- [ ] **Consistent naming** â€” matches the surrounding code's conventions.
- [ ] **No unnecessary state** â€” no `AppState` field/flag a local or derived value would cover.
- [ ] **No unnecessary DOM queries** â€” cache `getElementById` results; don't re-query inside loops.
- [ ] **Could this be a helper?** â€” repeated inline blocks extracted to a small named function.

## The ship question â€” one question, every commit
> ### "Would I ship this?"
> *If I were downloading this update from the App Store, would I be happy to receive it?*

Answer **honestly**, from what you can actually assess (complete Â· correct-by-trace Â· simple Â· debt-free):
- **Yes** â†’ proceed to QA.
- **"Almostâ€¦"** â†’ **the task is not done.** Fix whatever made you hesitate, then re-review. "Almost" is a no.
- If the *only* hesitation is a **human-verified** aspect (feel, polish, animation, real-device render),
  do **not** claim it's verified â€” mark it **`ship-pending-human-review`** and log it to `STATUS.md`
  (see the honesty rule in `QA.md`). The agent ships code it can vouch for and flags what it can't.

---

**Exit:** code health clean **and** "Would I ship this?" = yes â†’ continue to **QA** (`QA.md`).
