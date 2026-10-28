# Independent local integration review — PASS

Reviewer: `/root/task037_independent_review`, read-only, no source edits.
Final current-main base: `ce24092f4037cbacd9e2cf79a7465638bb8ef2ec`.
Approved application input: `bd96cccfec9bb893a44bc6573d0e04356cd80333`.

No product must-fix found. All **340 approved imports** preserve approved content except the six
intended integration source/test combinations; all **35 retained-main paths** preserve current-main
canonical content, separating this task's own entry/permitted log append. The exact combined index
preserves approved UI/accounting/guards, desktop PC-autostart removal, the commitments-model import-map
pin and unified generation. Root/www identical. Reviewed rules exact approved source; combined rule
tests retain both current-main completion/rescheduling cases and candidate source guards.

Independent actual tests: **86/86 backend/model/identity tests PASS**, zero failures/skips, plus
**1/1 warm-cache browser PASS**. Final legacy moves retain atomic ordinary-owner CAS, both-day guards,
raw metadata/IDs/tombstones and fail-closed refusal. No migration or privileged write shortcut.

Exact fixture source matches the historical model. Warm-cache assertions use real HTTP caching and
the actual import map, preserving the valid date-only record. A frozen test fixture removes any
dependence on historical Git objects in hosted shallow checkouts. Initial fixture precision was
corrected before the actual strict red; no assertion or timeout was weakened.

The last main refresh changed no browser runtime/test surface. Independent recursive static import
analysis found **94 dependency files from 59 browser test files**, zero intersection with that delta.
This supports retaining the 1,027-case browser result while rerunning affected complete backend gates.

Final audit after gate output archival: all **11 generated outputs** match archive hashes and original
imported historical copies are restored. No unexpected imported differences. Local main remains
`0e04ebb`. Protected-tree verification is separately recorded in PRESERVATION.json.

Exact reviewed working-tree hashes and canonical LF object hashes are recorded in
SOURCE_REVIEW_HASHES.json. Logs are archived with original SHA256 in ARTIFACT_MANIFEST.json:

- independent-backend-final.log: 86 passes; SHA256 `82624c3b5608a8280313fa99e351c41b3d94a6c8e5a756eb586dafd89953b6e5`.
- independent-warm.log: 1 pass; SHA256 `1d8ab57597451b2b132f426f4d384504dbee30cbc641eb9ef0357b8d3e5cb096`.
- independent-audit-final.log: full import/history/archive audit; SHA256 `888b51ec8ba3626171af31186c85aef799eec73d4d1cd1a20260b68490bab8cc`.

Backend command: `node --test commitments-model.test.js functions/test/two-user-identity.test.js functions/test/plan-legacy-completion.test.js functions/test/plan-legacy-move.test.js`.
Warm command: `node node_modules/@playwright/test/cli.js test tests/release-integration.spec.js --workers=1 --reporter=line --output=<unique TEMP output>`.

This is independent local review. Hosted CI, formal exact-head/base repository approval, live release
inventory/canaries and owner production authorization are separate gates and have not been claimed.
