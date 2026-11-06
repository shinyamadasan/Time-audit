# Performance Recovery V1 — final bounded validation

**Eligible to return for separate owner approval. Merge and deployment remain on hold.**

Exactly one fresh full unchanged-gate validation was dispatched. [Run 42283392080](https://github.com/shinyamadasan/Time-audit/actions/runs/42283392080) passed **14/14 required jobs**, on frozen candidate **fbe1c38cbeefb4b37bbb8bfa15ecfbf942f060cc**, through CI-only tag `ci-perf-recovery-v1-final-20261106-fbe1c38`. No retry, implementation correction, assertion/count/catalog change, merge, deployment or production write occurred. Evidence commits are separate from this tested candidate.

## Results and limits

- Mandatory accounting/data-preservation: **490 unique passed, zero failed/skipped attempts**.
- Strict packaged validation: **62/62 passed, zero skipped**.
- Wider suite: **1,071 ran; 772 passed, 299 existing cataloged failures**. No missing/added cases or failures outside the unchanged catalog. The formerly blocking two-reminder Save/reload/Stop case passed once in this full run.
- Unit and rules required jobs passed their existing gates. Logs explicitly retain **six existing platform/opt-in Node skips** and **nine existing reported rules/SDK failures** handled by the unchanged evaluator. Passing required gates does not mean every test passes.
- Priya independently reviewed complete results and identity, including unit/rules disclosures: **RETURN FOR OWNER APPROVAL**, not release authorization. See INDEPENDENT_REVIEW.md.
- Prior failed full run 42269983544 and focused comparison 42280197609 remain retained. The original execution-context loss has no proven cause or justified fix. A later pass does not establish that it was harmless.

No additional Performance Recovery investigation or Phase 2 follows this validation. Storage/history growth, external-writer accounting conflicts and slow-device performance remain separate follow-ups. Available capacity returns to the existing Ramon/ChronaSense integration and the authorized read-only West Edge Exterior audit.

## Identity

Candidate root/www bytes (102 runtime files) match retained artifacts built from runtime commit `8986703977a3cda51551fad040e9f2c293bece5f`. Verified before launch and independently reviewed:

| Artifact | SHA-256 |
| --- | --- |
| Web tree | `ceedc27b84fd1da3ff38013477d30f4bfe2d824a6e455eb637a031a6fdef14f5` |
| Extracted Android bundle | `3e9f1ba5a6eada04f86fa3667ebe4bb614b3af25186a01f62c26d0ad72ca333b` |
| Retained local debug APK | `a6f5e69cc75482950f69b151af7a113b72b05ae8ee64285a5c7f39debb66f0a4` |
| Hosted debug APK | `b36e24219b8b0549b5cf4e0cb1f2c47de33fd56111b2c54fbb5ab996f7b13b5e` |
| Rules (unchanged) | `93f0a77424e730aa5996825af4183e0d42d5f29251260b8f85eea3756645be00` |

Local and hosted debug signing produces different APK binaries; matching packaged bundle pins do not establish production signing parity. Production signing, real-device acceptance, baseline failures/coverage gaps and the unexplained historical context loss remain decision risks. No fresh slow-device performance claim is made.

## Rollback for a separately approved release

Nothing was deployed, so no production rollback is currently needed. Retained predecessor is `9fd8c912349219481908bccce8efb3fad35c5273`; see the existing ROLLBACK_ARTIFACT_MANIFEST.json and original RELEASE_REPORT.md.

1. Confirm predecessor against the actual deployed version and retain exact production artifacts.
2. With separate owner authorization, publish predecessor artifacts through the approved release channel after checking web `bf2443d9f1ee2b20d03ad223bca3b8e1678a9ea0f74248d2299885cc2c4e8cfc` and bundle `5ff0b43550193d85b8591afeb29bb9786c94a4268fb3a42046f49c2fad368e96`.
3. Preserve Android signing compatibility/version code and local data. Do not uninstall, clear data or force a destructive downgrade.
4. Verify restored version and retained entries/pending operations under the approved canary plan. Keep Firebase/rules and all accounting history unchanged; no repair, trimming or reconstruction.

Machine-readable run, launch, identity, comparison and shard evidence accompany this report; complete raw job logs remain locally retained and hosted by GitHub. This report supersedes the earlier disposition only for eligibility to seek owner approval; it does not rewrite historical failures.
