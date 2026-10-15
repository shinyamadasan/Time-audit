# TASK-018 — Visual-first design study

**Latest refinement:** the owner directed refinement of A only, without production implementation authorization.
Open [refined A in complete My Day](A-refined.html), [the visual evidence page](A-refinement-evidence.html), or
[refinement notes and measurements](A-REFINEMENT.md). The initial A/B/C study below remains unchanged for reference.

2026-10-15 · **DESIGN ONLY · OWNER APPROVAL PENDING**.
Owner's pasted instructions in this session authorize these standalone artifacts, mock JavaScript, screenshots,
research and feasibility documentation only. No design is selected. The earlier 64px exploration remains unapproved.
Base: `bb171a287ac67d76ae27634b5227bc24f66919de`. Worktree: `.worktrees/task-018`.

## Open the designs

Double-click [comparison.html](comparison.html) in this folder; no server or build step is needed.
It shows actual rendered screenshots side by side and switches between rows, menu, date, My Day, empty and error views.
Use **Try prototype** to interact; **My Day context** places the same working mock in its surrounding layout.

- [A — Minimal checkbox list](A-minimal.html)
- [B — Grouped task manager](B-manager.html)
- [C — Triage inbox](C-triage.html)
- [Technical safety assessment](FEASIBILITY.md)

Absolute comparison-page path:
`C:\Users\Admin\Desktop\Vibe code\Time audit app\.worktrees\task-018\design\task-018\comparison.html`.

All actions are mock behavior. A source array holds 22 realistic tasks; outcomes exist only in browser memory.
The mock clock is fixed to October 15, 2026. Reload/reset discards outcomes. No ChronaSense app modules, localStorage, Firebase, credentials or production APIs are
used by the prototypes. CSP disallows connections. There is no Delete action: its data-model approval is separate.

## Inspecting the current product

Read `CODEMAP.md`, the named My Day section, TASK-017's `staleHtml` / `staleAction`, `.pc-stale-*` styles, the existing
proposal and uncommitted revision, `style.css` tokens and `TASK_017_COMPLETION_DELETE_DESIGN.md`. Never read index.html
in full. The prior proposal files and their uncommitted bytes were preserved; they are not the current selected design.

`capture-current.mjs` rendered the real current app in a new temporary browser with 22 synthetic old tasks and two
current planned tasks. The repository's recording Firebase stub intercepted Firebase scripts; every other external
request was blocked. This uses isolated fixture storage, not an existing profile or live account. The app's font
request was blocked, so the baseline uses its sans-serif fallback. These captures are UI inspection, not sync tests.

Evidence: `../../playwright-report/task-018-design/current/`.

| Current TASK-017 | Mobile 390px | Desktop 1440px |
| --- | --- | --- |
| Expanded section, five tasks | 824.3px | 785.1px |
| One More panel open | 1137.1px | 1045.9px |
| Top of section in document | 738.6px | 617.6px |

The repeated action rows, expanded secondary panels, repeated titles and history explanation dominate the task
content. The missing Done action is also a missing data contract, not just an omitted icon. Current My Day already
places Unfinished below Up Next, Add, Needs You/Intelligence and the timeline; reducing this component does not make
the whole backlog appear above the fold without scrolling. No overall My Day reordering is proposed.

Prototype `?context=day` views are labelled **mock reconstructions** of that surrounding My Day structure and proportions,
with the same current-task examples plus a collapsed three-item Brain Dump tray. They retain timeline and tray roles;
their surrounding controls are intentionally read-only. They are not screenshots of a changed production page.

## Research: observed references versus design inference

Reviewed official public documentation on 2026-10-15. No signed-in third-party app session or physical-device study.

| Product / primary reference | Observed or documented pattern | Lesson applied here (our inference) |
| --- | --- | --- |
| [Todoist — Introduction to tasks](https://www.todoist.com/help/todoist/features/introduction-to-tasks-080OAXric) | A task has a direct completion circle; completing removes it from the active list. Other actions use task menus. | A keeps the direct completion control visible and moves secondary choices into a small overlay. We do not copy Todoist's analytics/Karma effects. |
| [Todoist — Manage multiple tasks](https://www.todoist.com/help/todoist/features/add-or-manage-multiple-tasks-in-todoist-PcPoskdUp) | Explicit selection and a shared action toolbar support repeated management operations. | C exposes selection deliberately rather than assuming every check means selection. Completion and selection remain separate controls. |
| [Things — Scheduling to-dos](https://culturedcode.com/things/support/articles/2803579/) | The When picker schedules attention/start dates; Today, Upcoming, Anytime and Someday are separate lists. Start dates differ from deadlines. | Planned date must remain a quiet, distinct fact; the actual completion-date form is explicitly labelled. Do not make a date icon silently alter plan history. |
| [Things — Quick Find](https://culturedcode.com/things/support/articles/2803584/) | Search and navigation are combined in Quick Find. | B/C offer a single title search across all 22 records, not just the current five. |
| [Linear — Select issues](https://linear.app/docs/select-issues) | Highlighting, keyboard navigation, explicit selection and contextual commands support list work. Its selection checkbox is not completion. | B adds keyboard navigation and C separates selection from the completion checkbox. The common mistake of silently changing check semantics is avoided. |
| [Linear — Display options](https://linear.app/docs/display-options) | Grouping, ordering and visible metadata are configurable presentation choices. | B groups by existing planned dates; C offers oldest-first ordering. These are derived views, not new task authority. |

The public [Things list illustration](https://culturedcode.com/frozen/2026/01/dates-alllists.jpg) was downloaded and
visually inspected; it shows Quick Find, the date-based lists and Logbook. Local research copy:
`../../playwright-report/task-018-design/references/things-date-lists.jpg`. It is not a prototype asset.
Linear/Todoist embedded image fetches failed through the web reader; their readable official documentation was used.
We did not infer their exact pixel dimensions or claim hands-on timings. Their colors, branding and layouts were not copied.

## Three different interaction architectures

**A — Minimal checkbox list.** A single scannable list in original order, dates under task titles, one completion
check and one More trigger per task. Five tasks per bounded page. Best for the owner's primary one-step resolution
action. Weakness: without a search field, finding a known task among 100 records means paging/scanning.

**B — Grouped task manager.** Persistent search over the full backlog, derived recent/earlier groups, aligned planned
date metadata and a separate direct completion-date shortcut. Same controls on mobile/desktop; no hover-only actions.
J/K navigate tasks and D opens completion date when a row title has focus. Weakness: header/search/group space and
the extra date control reduce title width on mobile. A calendar/check icon can still need explanation; its tooltip
and accessible name say completion date, while the separate original date remains immutable.

**C — Triage inbox.** Oldest-first queue, search on demand, explicit selection mode and one shared batch action bar.
Normal completion checks always mean completed today. Selection uses separate right-hand boxes in a visibly labelled
mode; the row More controls return when selection ends. Best for a deliberate cleanup session. Weakness: single-line
titles truncate earlier (tap to expand), selection adds cognitive cost, and production partial failure/Undo is harder.

All three have anchored More overlays, completion-date forms (today default, Yesterday shortcut, explicit Save),
move/reschedule, dismissal, mock completion/error/empty states and last-operation Undo. No inline full-width menu,
repeated task title or per-task instructional paragraph. Long titles expand in place rather than appearing again in a menu.

## Measured evaluation

Real Chromium renders, system UI fallback typography, 100% zoom. No predetermined row-height choice; rows follow
content and minimum accessible target sizes. The long mock title is included in A/B's first five, and C's oldest task
is also a long title. C clips it to one line until explicitly expanded.

| Metric | A | B | C |
| --- | --- | --- | --- |
| Five rendered row heights, mobile | 50, 51, 70, 51, 51px | 45, 45, 49, 45, 45px | 44, 45, 45, 45, 45px |
| Sum of five rows, mobile | 273px | 229px | 224px |
| First-to-last row span, including intervening group label | 273px | 254px | 224px |
| Full section incl. all chrome, mobile | 367px | 421px | 365px |
| Full section, desktop | 367px | 423px | 365px |
| Full mobile screen fraction (844px) | 43.5% | 49.9% | 43.2% |
| Tasks per 100px, whole mobile section | 1.36 | 1.19 | 1.37 |
| Reduction vs current mock TASK-017 section | 55.5% | 48.9% | 55.7% |
| Complete today | 1 tap | 1 tap | 1 tap |
| Complete yesterday, explicit Save | 4 taps | 3 taps (direct date shortcut) | 4 taps |
| Pick another calendar date | 5+ taps | 4+ taps | 5+ taps |
| Move / dismiss / Undo | 2 / 2 / 1 taps | 2 / 2 / 1 taps | 2 / 2 / 1 taps |
| Five tasks completed today | 5 taps | 5 taps | 5 individual taps; 7 via selection mode |
| Five tasks dismissed | 10 taps | 10 taps | 7 via selection mode |
| Five tasks with yesterday completion date | 20 taps | 15 taps | 9 via selection mode |
| Find fixture task “volunteer roster” | 3 next-page taps then scan | 1 input-focus tap + typing | 1 search-icon tap + typing |

Tap paths are deterministic interaction counts, not usability timings: More → completion-date → Yesterday → Save
for A/C; direct date → Yesterday → Save for B. Arbitrary native date selection adds opening and choosing a day;
month navigation and Android picker behavior can add more. Batch counts include entering selection, choosing each
task and the shared action. C's mock batches are not proof of a safe real batch write.

| Judgment criterion | A | B | C |
| --- | --- | --- | --- |
| Visual clarity / discoverability | Strongest task-text hierarchy; standard checkbox and always-visible More | Stronger navigation, but more competing affordances; date icon less self-explanatory | Clean queue at rest; explicit selection mode needs learning |
| Mobile usability | More title space and no management toolbar | Fast known-task lookup; narrow title column, small date metadata | Best row density, but more title expansion and selection-mode risk |
| Desktop usability | Simple keyboard traversal; paging limits large-list lookup | Strongest for search/date navigation; visible shortcuts | Useful for cleanup sessions and repeated actions |
| UI implementation complexity | Lowest; existing page window and one action menu | Moderate; derived groups/filter state/direct date shortcut | Highest; selection, batch progress, partial outcomes and reversal |
| Historical-completion compatibility | Same required explicit resolution protocol | Same protocol; no extra persisted grouping required | Same individual protocol plus a separate batch-outcome design |
| Accessibility | Native checkbox, named actions, 44px targets, in-place full title | Same plus labelled search and keyboard navigation | Same plus separately labelled selection; no hidden long-press requirement |

Accessibility consideration is not certification. No physical Android, screen-reader, 200% text-zoom or human timed
usability study was performed. Metadata is intentionally quieter than 13–14px task text. All row action and title
targets measure at least 44×44px; native check boxes are visually 20px inside their larger labels. Focus, Escape,
menu arrow navigation and date-form Tab containment are present. Error state keeps tasks and offers a mock retry.

## Recommendation and weaknesses

**Recommend A for the first production slice**, because the owner's dominant job is already-completed-task resolution,
not managing task metadata. It saves over half the current mobile section footprint in this fixture, keeps more room
for task text and introduces the least new UI state. It is not the shortest possible row design; C's compact rows
save almost no full-section space once its management controls are included.

B is preferable if locating specific tasks becomes the dominant daily activity. C is preferable for dedicated
backlog cleanup involving shared dates/dismissals, but bulk completion today actually costs more taps than individual
checks. These are judgment calls, not measured owner preferences. **No option is selected or approved.**

Production completion and safe Undo are blocked on a protected contract, regardless of the visual choice. See
[FEASIBILITY.md](FEASIBILITY.md): no hidden Move-to-today substitution, original-day completion inflation or claim
that the current persistence path already supports date-only historical completion.

## Evidence and focused verification

Root: `../../playwright-report/task-018-design/`.

For each option `A`, `B`, `C` and viewport `mobile` (390×844) / `desktop` (1440×900):

```text
<option>-<viewport>-default.png          requested default viewport
<option>-<viewport>-menu.png             compact overlay
<option>-<viewport>-date.png             date selection (Yesterday selected)
<option>-<viewport>-component.png        complete section crop, no review controls
<option>-<viewport>-success.png          mock result and Undo
<option>-<viewport>-error.png            failed action and Retry
<option>-<viewport>-empty.png            empty queue
<option>-<viewport>-long-title.png       expanded long task title
<option>-<viewport>-my-day-full.png      complete surrounding My Day reconstruction
<option>-<viewport>-my-day-focus.png     scroll position showing timeline tail + Unfinished
C-<viewport>-selection.png              two tasks selected, completion checks still separate
```

`measurements.json` contains actual dimensions. `verification.json` records 182 passing focused mock assertions, errors and request
counts. `contact-sheet.png` is generated from the comparison page's three actual rendered component images;
`comparison-{menu,date,my-day-focus,my-day-full}.png` show those states side by side.

Capture scripts: `node design/task-018/capture-current.mjs` (baseline, isolated recording fixture),
`node design/task-018/capture.mjs` (prototype states/interactions),
`node design/task-018/capture-comparison.mjs` (comparison evidence). Run from the task-018 worktree, with the existing
Playwright package/browser installation; browser process creation may need normal sandbox approval.

No complete production regression suite was run, per owner instruction. These checks prove only standalone mock
interaction/rendering: no real Firebase, account boundaries, concurrency, old clients, historical completion or Undo
durability is exercised. No new production tests or changed product behavior are claimed.

## Preservation and delivery boundary

Existing uncommitted `TASK_018_UX_PROPOSAL.html` was preserved at SHA-256
`455a32329367119d64a62ad8837fb3a1eef8bad1d8ad80fcea111498c5095f86`.
Its older proposal documentation remains intact, even though this visual-first phase supersedes its direction.
Production source and generated www/rules are unchanged. No merge, push, deployment or real-data mutation.
Only design artifacts and TASK-018's phase/lifecycle record belong to this phase. **Owner visual approval is pending.**
