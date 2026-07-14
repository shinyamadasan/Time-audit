# METRICS — Weekly Engineering Metrics

> A simple weekly log to replace intuition with evidence. After a month you can answer: *Is QA getting
> better? Is Self Review reducing reverts? Is autonomous development actually saving time?*
>
> **Honesty rule (same as QA.md / SELF_REVIEW.md):** every number is tagged by source. **Auto** = an
> agent can compute it from git + the repo files. **Manual** = needs a human signal — don't fabricate;
> leave `—` until you have a real number. Never report a metric you can't actually measure.

## How each metric is sourced
| Metric | Source | Type |
|---|---|---|
| Features shipped | `git log --since feat:` / `planning/DONE.md` | Auto |
| Bugs fixed | `git log --since fix:` | Auto |
| Reverts | `git log --since` reverts | Auto |
| Ideas captured | `captures/processed/**` dated in the week | Auto |
| Ideas implemented | captured items that reached `DONE.md` | Auto |
| Autonomous success rate | runs completing without Blocked ÷ runs (`claude-session.log` / STATUS) | Auto* |
| Bugs escaped QA | bugs found **after** ship (by you or users) | Manual |
| Avg review time | wall-clock per task, if tracked | Manual |

\* approximate from STATUS entries until run-logging exists.

## Week template — copy per week, newest at top
```
## Week of YYYY-MM-DD
- Features shipped: N
- Bugs fixed: N
- Bugs escaped QA: N        (manual)
- Reverts: N
- Autonomous success rate: N%
- Ideas captured: N
- Ideas implemented: N
- Avg review time: —        (manual)
- Notes: <what changed · what to watch next week>
```

*(Auto metrics can be filled by a future `/report` prompt — parked in ROADMAP → Research.)*

---

## Log

## Week of 2026-06-25 — OS bootstrap (baseline, not steady-state)
- Features shipped: **1** user-facing (recipe count) — the rest of the week was infrastructure
- Bugs fixed: **3** (cloud-data wipe on deploy · light-only rendering · n8n auth type)
- Bugs escaped QA: **0** known
- Reverts: **0**
- Autonomous success rate: **—** (no autonomous feature build yet — all interactive this week)
- Ideas captured: **4** (1 real validation feature + 3 test/noise — all triaged correctly)
- Ideas implemented: **1**
- Avg review time: —
- Notes: This week built the **AI Dev OS itself** (docs system, capture pipeline, Self Review + QA + metrics) plus the light-only fix. Real steady-state numbers begin once the scheduled runs start building queued features. Treat this as the baseline, not a performance read.
