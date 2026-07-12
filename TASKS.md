# Tasks

> **Handoff document.** Claude writes tasks; Codex checks them off.
> Tasks must come from an approved item in `planning/BUILD_QUEUE.md`.
> One task = one atomic, independently testable unit.

## Status legend

`todo` -> `codex` -> `in-progress` -> `review` -> `approved` / `done`

- `done`     = approved AND reversible -> auto-merged to main (see CLAUDE.md Risk-gated merge)
- `approved` = approved BUT red-zone   -> HELD, human merges after a glance
- `blocked`  = Codex hit an ambiguity; Claude must resolve before work continues

---

<!-- Paste new tasks above this line. -->

<!-- TASK TEMPLATE -- copy and fill:

### TASK-001 - <short title>
status: codex
owner: codex
source: BQ-<id>
priority: P2
depends-on: none
files: index.html (CODEMAP section: <name>), storage.js

context:
  <what exists today, which CODEMAP section, why this change>

acceptance:
  - [ ] criterion 1
  - [ ] criterion 2

constraints:
  - Read CODEMAP.md first; never read index.html in full
  - <hard-rule constraints that apply>

test steps:
  - [ ] npm test
  - [ ] SMOKETEST.md items touched by this change

-->
