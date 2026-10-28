Combines the approved visual/planner/reliability/notification/Save candidate bd96ccc with current main
ce24092. The result retains TASK032's date-only commitment fix and two-account isolation, latest-main
legacy completion/rescheduling and desktop PC Time autostart removal, and the approved planning/Brain Dump UI.

The integration-only runtime repair adds the unchanged commitment model to the existing governed
import map: a real warm-cache regression showed that a previously cached model could otherwise hide
valid Firebase-pruned date-only commitments after upgrade. The model and its validation are unchanged.
Reviewed source-protection rules are carried from the approved candidate without new rule logic.

Local validation results and source provenance are in TASK_039_RELEASE_INTEGRATION.md and
review-artifacts/task-039-release-integration/. They distinguish actual passes, the existing opt-in
Node diagnostic skip, setup attempts and inherited physical-device evidence. No new phone testing.

Review focus: retained current-main backend/Worker and owner guards; both legacy completion/rescheduling and
approved source fences together; no time loss/duplication; cache upgrade behavior; frozen approved UI.

Hold as a draft for required hosted **test** and **Firebase fence / rules integration**, then formal
exact-head/base repository review. Do not enable auto-merge or merge main: that can publish Pages.
No production rollout, rules deployment, migration or production-data change is authorized by this PR.
