# TASK-018 — Refined A, design evidence

2026-10-15. Owner directs refinement of Option A only. **Production implementation approval remains pending.**
Open [A-refined.html](A-refined.html) for the interactive mock in complete My Day, or
[A-refinement-evidence.html](A-refinement-evidence.html) for the screenshot gallery. Double-click either HTML file;
no server, app account or build step is needed. The initial A/B/C study and prior uncommitted proposal are preserved.

## Changes requested by the owner

- Five tasks remain in My Day. **View all** replaces pagination. It opens a bounded dialog with a search field,
  all 22 mock tasks and an internal scrolling list. Search receives focus immediately and finds tasks outside the
  preview. My Day has no permanent search box, grouping headers or next/previous page controls.
- The native checkbox always means **Complete today**. **Done earlier…** stays in the small anchored More menu,
  with an explicitly labelled actual-date input, today default, Yesterday shortcut and Save completion.
- A small floating Undo notification replaces the full-width success banner. It expires after eight seconds,
  restarts after pointer/focus leaves, and stays while hovered or keyboard-focused. Expiry hides recovery UI; it
  does not undo the completed mock task. Last-operation recovery is memory-only, not a real persistence guarantee.
- Existing Move to today, Reschedule and Not doing concepts remain secondary mock actions. Original planned dates
  remain on the source fixture; completion/rescheduling outcomes are separate in-memory values.
- Task text remains 14px with a two-line preview and tap/keyboard expansion in place. Row controls and title areas
  have at least 44×44px targets. More/date overlays work in both preview and full backlog, without duplicated titles.
- The surrounding My Day keeps Up Next, Add, Needs You, Intelligence, Brain Dump tray, timeline, So Far, streak and
  navigation. This is the same labelled mock reconstruction used in the initial study, not a production UI change.

## Measured dimensions

Actual Chromium renders, 100% zoom, same frozen October 15, 2026 fixture and 22 realistic tasks as the initial study.

| Measurement | Mobile 390×844 viewport | Desktop 1440×900 viewport |
| --- | --- | --- |
| Full expanded five-task section, header/footer included | **367px** | **348px** |
| Five task rows combined | 273px | 254px |
| Individual default rows | 50, 51, 70, 51, 51px | 50, 51, 51, 51, 51px |
| Full backlog dialog | 356×580.4px | 600×580.4px |
| Internal backlog list maximum height | 440px | 440px |
| Temporary Undo notice (earlier completion sample) | 178.8×46px | 178.8×46px |

The desktop long title fits on one line within the wider My Day content column, which accounts for its shorter
section. Opening View all, More, the date form or the notification does not increase the preview section height.
Search/scroll controls are confined to the opt-in full backlog. No fixed row height was imposed.

## Interaction counts

| Intent | Interactions |
| --- | --- |
| Complete a visible task today | **1 checkbox action** |
| Complete a visible task yesterday | **4 taps**: More → Done earlier → Yesterday → Save |
| Complete on an arbitrary date | **5+ taps**: includes opening the native date picker and choosing a date; month navigation can add taps |
| Open all tasks | **1 tap**: View all; search autofocuses |
| Locate a known task anywhere in the backlog | **1 tap + typing** from My Day: View all, then type |
| Complete a searched task outside the preview today | **2 taps + typing**: View all → type → checkbox |
| Undo latest successful mock action | **1 tap** while the notice is available |
| Move / Not doing | **2 taps**: More → action |
| Reschedule tomorrow | **4 taps**: More → Reschedule → Tomorrow → Reschedule |
| Close backlog | **1 close-button action**, or Escape; focus returns to View all |

These are deterministic control-path counts, not timed human usability results. Native mobile picker and virtual
keyboard behavior can differ on physical devices. No Android/screen-reader/real Firebase testing was performed.

## Evidence paths

All screenshots are actual rendered HTML/CSS. Root folder:
`C:\Users\Admin\Desktop\Vibe code\Time audit app\.worktrees\task-018\playwright-report\task-018-refined-a\`.

For each `mobile` and `desktop` prefix:

- `*-my-day-full.png`: complete My Day document, viewport widths 390 and 1440 respectively.
- `*-my-day-preview.png`: normal viewport framing of the timeline tail, expanded Unfinished and surrounding page.
- `*-five-task-preview.png`: complete measured section crop.
- `*-full-backlog.png`: bounded searchable window with all 22 tasks available by internal scrolling.
- `*-backlog-search.png`: search result for task 19, outside the five-task preview.
- `*-more-menu.png` / `*-done-earlier.png`: preview More and actual completion-date states.
- `*-backlog-menu.png` / `*-backlog-date.png`: the same controls inside the full backlog.
- `*-backlog-long-title.png`: expanded long title without duplication.
- `*-temporary-undo.png`: the small Undo notification.
- `*-backlog-no-matches.png` / `*-save-error.png`: empty-search and failed-action recovery states.

For readable full-document and section-crop captures, navigation is placed at the document foot rather than stitched
across the page or obscuring cropped task rows. Interactive and ordinary viewport captures retain fixed navigation. This capture-only
class changes no product behavior. Mock controls and the small design label are review aids, not additions to My Day.

`measurements.json` in the evidence folder contains final dimensions and check results.
Reproduce with `node design/task-018/capture-A-refined.mjs` from this worktree; the existing Playwright browser
installation is used. Local browser process creation may require normal sandbox approval.

## Verification and boundary

**62 focused mock assertions pass** across both requested viewport sizes, with no page exceptions, external requests,
storage writes or horizontal overflow. Checks cover five-item/no-search/no-pagination preview, all 22 backlog items,
search autofocus and beyond-preview matching, bounded internal scrolling, keyboard menu/Escape/focus return,
explicit actual dates and future-date refusal, correct one-action completion identity, compact notification,
conditional mock error/retry, Undo, unchanged original fixture history and notification expiry/pause behavior.

The first focused runs caught a pending-render checkbox reset and inconsistent Escape behavior from a search field;
both were fixed in this standalone mock before the final pass. Full production regressions were intentionally not
run. The shared initial prototype JS/CSS and B/C HTML files remain unchanged.

The [technical feasibility assessment](FEASIBILITY.md) still applies: no general real historical-completion write or
safe remote Undo is supplied by this prototype. Planning authority, persistence, Firebase schema/rules, sync and live
data are unchanged. No integration, push or deployment. **Stop at design evidence; production approval pending.**
