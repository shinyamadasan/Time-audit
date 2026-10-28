# TASK-033 — owner visual refinement

Ready for **owner visual review**, not release. Branch `task-033-visual-refinement` starts at
protected `ff3d426`. The original TASK-028, TASK-030, TASK-031 and TASK-033 worktrees remain intact.
No promotion-contract changes, push, merge or deployment.

| Actual app comparison | My Day and planner, before / after | Raw captures |
|---|---|---|
| 1920 × 1080 desktop | [Compare](review-artifacts/task-033-visual-refinement/desktop-before-after.png) | [Before My Day](review-artifacts/task-033-visual-refinement/before/my-day-desktop.png), [after](review-artifacts/task-033-visual-refinement/after/my-day-desktop.png); [before planner](review-artifacts/task-033-visual-refinement/before/planner-desktop.png), [after](review-artifacts/task-033-visual-refinement/after/planner-desktop.png) |
| 1366 × 768 laptop | [Compare](review-artifacts/task-033-visual-refinement/laptop-before-after.png) | [Before My Day](review-artifacts/task-033-visual-refinement/before/my-day-laptop.png), [after](review-artifacts/task-033-visual-refinement/after/my-day-laptop.png); [before planner](review-artifacts/task-033-visual-refinement/before/planner-laptop.png), [after](review-artifacts/task-033-visual-refinement/after/planner-laptop.png) |
| 390 × 844 phone | [Compare](review-artifacts/task-033-visual-refinement/mobile-before-after.png) | [Before My Day](review-artifacts/task-033-visual-refinement/before/my-day-mobile.png), [after](review-artifacts/task-033-visual-refinement/after/my-day-mobile.png); [before planner](review-artifacts/task-033-visual-refinement/before/planner-mobile.png), [after](review-artifacts/task-033-visual-refinement/after/planner-mobile.png) |

[Sharing contact sheet](review-artifacts/task-033-visual-refinement/review-contact-sheet.png) ·
[More menu](review-artifacts/task-033-visual-refinement/after/mobile-more.png) ·
[Read-only ideas](review-artifacts/task-033-visual-refinement/after/planner-mobile-ideas.png) ·
[Expanded timeline detail](review-artifacts/task-033-visual-refinement/my-day-mobile-detail-before-after.png).

These are actual, unretouched Chromium application captures, not generated mockups. Both sides use
the same synthetic tasks, fixed October 26 clock and the real Personal Day resolver with an 18:00
Asia/Manila boundary. The planner correctly shows October 27, 18:00 through October 28, 18:00.
The untouched `ff3d426` worktree supplies the before application. No real account records are used.

The visible refinements:

- **Hierarchy and actions:** Up Next keeps Start and Next visible. Choose task and Focus mode sit
  behind a native disclosure beside Next, with an accessible name and 44px target. In this fixture
  the card drops from **220.8px to 169px**, through grouping rather than smaller text. Existing
  active timer, remote-device, routine and free-form actions retain their original handlers.
- **Navigation:** Phone/tablet navigation shows My Day, Brain Dump, Week, Trends and More. More
  exposes Life, Learning plans, Career and Settings through their original navigation buttons.
  Desktop retains all eight destinations. Native dialog focus, Escape, backdrop dismissal and
  focus restoration are tested. Secondary views also retain the More entry and active indication.
- **Typography:** Bundled Inter is retained. Planner headings use 26px/600 desktop and 22px/600
  phone; task titles use 15px/550, body/context 13–14px, inputs 16px, navigation 11px/500.
  Line heights remain 1.4–1.5 for readable content; muted planner text measures 7.05:1 contrast.
  Long explanatory text is bounded by character width, without shrinking the dashboard itself.
- **Spacing:** Shared 4/8/12/16/24/32px tokens guide the touched surfaces: 32px desktop outer
  gutters, 16px phone gutters, 24px desktop modal padding, 16px phone modal padding, 24px section
  separation, 12–16px card padding, 8px control gaps and 4px close label/detail spacing. Content
  determines card height. Reminder counts and their actions now have explicit separation.
- **Planning:** The heading is **Plan your next day**. Authoritative dates, boundary start and
  timezone remain visible; explicitly chosen future days retain their named-date heading. On
  phone, **From Brain Dump · 4** is visible alongside the planning modes and opens/focuses the
  existing Q1/Q2 panel. Desktop keeps that panel beside the priorities. Recommendations remain
  read-only; the existing Brain Dump route preserves the planning draft. The 880px modal and
  full-height phone sheet keep one content scroller and a separate footer that does not cover it.

Tradeoffs for owner assessment: alternate task actions and secondary mobile destinations take one
additional tap. Desktop account notices and Needs you remain data-dependent and can push the
timeline lower. The approved timeline interactions and existing dashboard sections are retained.

Verification:

- **195 distinct affected browser cases passed across targeted runs**, including two new cases
  for More/task-action disclosure and read-only idea discovery/keyboard-height footer geometry.
  The initial 193-case batch had one outdated direct-Focus click; its corrected disclosure path
  passed with the original task-label and non-completion assertions. An overlapping dashboard
  run had loaded that old test too. There are no unresolved test failures.
- `npm test`: **2,321 passed, one existing opt-in diagnostic skip**; legacy harness **455/455**.
  Final runtime/generation/planning static subset: **79/79**. Lint: zero errors, 48 existing warnings.
- Runtime mirror: 98 files byte-identical; shared-source and rules parity pass. **107 production
  JS/rules files are unchanged**, including promotion, Plan Authority, time tracking and Personal Day.
  Index changes stay within reviewed presentation anchors and the coherent cache generation.
- Five viewport geometry checks include tablet and a 200%-equivalent CSS viewport. Phone keyboard
  testing uses a 390×480 viewport simulation. Native zoom and physical iOS/Android keyboard feel
  remain unverified. The whole browser, fence and Worker suites were not repeated for this visual
  rework; accepted Stage 1 evidence remains preserved, with affected regressions run here.

Evidence: [gate results](review-artifacts/task-033-visual-refinement/GATE_RESULTS.json),
[layout checks](review-artifacts/task-033-visual-refinement/LAYOUT_CHECKS.json),
[source/baseline invariants](review-artifacts/task-033-visual-refinement/INVARIANTS.json),
[before measurements](review-artifacts/task-033-visual-refinement/before/MEASUREMENTS.json),
[after measurements](review-artifacts/task-033-visual-refinement/after/MEASUREMENTS.json).

Code-health self-review passes; visual/device acceptance remains **ship-pending-human-review**.
Direct Eisenhower selection stays deferred behind the preserved promotion safety gate. Stop here
for owner visual approval; this package authorizes no release action.
