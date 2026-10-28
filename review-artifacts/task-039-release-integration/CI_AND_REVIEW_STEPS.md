# Next approval — hosted CI and formal review only

Repository: `shinyamadasan/Time-audit`.
Local release branch: `task-039-release-integration`.
Verified remote-main base: `ce24092f4037cbacd9e2cf79a7465638bb8ef2ec`.
Final local head is recorded in POSTCOMMIT_STATUS.json and the owner handoff.

Single next approval requested:

> Authorize pushing the exact final task-039-release-integration commit and opening a draft PR
> against main for required hosted CI and formal repository review only. No merge, auto-merge,
> rules deployment, application publication or production-data action.

No step below has been executed. Keep the PR draft and auto-merge disabled.
These are prepared agent steps; no owner terminal work is requested.

1. Before the approved push, verify local head/tree and read remote main again. If the base moved,
   inspect the new difference and reconcile/retest as required; do not claim the earlier base review
   covers a different base. No force-push or main update.

   ```powershell
   git branch --show-current
   git rev-parse HEAD
   git status --short
   git ls-remote --heads origin main
   ```

2. Push only the isolated branch after that approval:

   ```powershell
   git push --set-upstream origin task-039-release-integration
   ```

3. Create a **draft** PR with head `task-039-release-integration`, base `main`, title
   `Integrate approved planning release with current-main compatibility`, and the prepared
   PR_BODY.md content. Prefer the connected GitHub tool's structured body; CLI equivalent:

   ```powershell
   gh pr create --repo shinyamadasan/Time-audit --draft --base main --head task-039-release-integration --title "Integrate approved planning release with current-main compatibility" --body-file "review-artifacts/task-039-release-integration/PR_BODY.md"
   ```

4. `.github/workflows/ci.yml` triggers on pull requests to main; pushing a non-main branch alone
   does not trigger this workflow. Both required jobs must pass against the exact pushed head and
   reviewed base: **test** and **Firebase fence / rules integration**. No check bypass or soft failure.
   The test job installs Node22/dependencies/Chromium, verifies www parity, runs full npm tests,
   Worker tests plus bundle dry run, and `npm run test:smoke` (the full Playwright suite).
   The fence job installs Java21, checks generated rules and runs provisioned rules/SDK/mutation tests.
   CI does not deploy through this workflow. Any Pages publication remains tied to main changes.

5. Obtain formal repository/Claude review of the exact head/base, including source provenance,
   unchanged current-main backend/Worker/TASK032 models, approved rules and stronger-fence legacy
   completion compatibility, warm-cache fix, frozen UI and all test evidence. Independent local
   review supports this handoff; it does not substitute for formal approval. Record review findings
   through the repository's owner/reviewer workflow; resolve must-fix findings before readiness.

6. Return hosted job URLs, head/base SHAs and formal verdict. Stop with draft PR held. A green PR
   grants no production authorization. Rules-first rollout and main merge/publication need separate
   explicit owner approval after live compatibility/rollback capture and deployment-stage canaries.
