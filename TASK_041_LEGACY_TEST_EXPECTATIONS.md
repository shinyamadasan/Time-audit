# TASK-041 - Separate legacy test expectation findings

This is evidence only. The original `accounting-hazards/staged-effects.test.js` and its
runtime dependencies are unchanged by TASK-041. These findings are not an authorization
for a second implementation task.

## Confirmed baseline result

On the owner-selected `b0bbc6f` baseline, running
`node --test accounting-hazards/staged-effects.test.js` gives 51 passed and 5 failed.
All five failures report `Missing expected rejection`. The completed independent audit
also reproduced the same five failures on rollback `37ef976` and traced their origin to
the earlier quota-handling change, not the seven overnight fixes.

## Five outdated expectations

1. `failed quota capture retains the complete original identity and input until readback before callback or send`:
   the quota branch expects `c.drain()` to reject. The readback branch of that parameterized
   test is different and must continue requiring a readback error.
2. `read-only recovery beside failed capture retires its intake and applies its receipt only once`:
   the quota-blocked `c.drain()` call still expects rejection.
3. `failed hydration commit retains the original captured cache and can repeat a coherent read after restart`:
   `c.submit()` still expects rejection when the envelope commit hits quota.
4. `failed atomic local commit leaves accepted command recoverable and cursor/Undo unapplied`:
   `c.submit()` still expects quota rejection after the command is accepted.
5. `O1 observation intake survives envelope quota and recovers its original observed timestamp`:
   `c.observeProvisional()` still expects quota rejection, although its retained intake
   observation survives and the method currently returns true after import is quota-blocked.

## Existing contract and evidence

`createCoordinator` -> `drainOnce` catches recognized quota errors and returns
`{ status: 'storage-full', reason: 'local-storage-full', retained: true, stuck }`.
`observeProvisional` imports under the owner lock and retains an observation in intake
when its envelope import does not fit. Neither outcome proves that a command was applied.

The baseline audit used an evidence-only adapted copy to inspect the remaining safety
assertions. Both main and rollback passed 56/56 in that copy. This does not change or
reclassify the five failures in the original suite, and does not replace a reviewed
test-only correction. In particular, a future correction must assert exact outcomes,
retained original bytes and timestamps, no callback/send before durable readback,
and exactly-once recovery. It must not simply remove rejection assertions.

The original staged-effects suite is not part of the baseline `npm test` command.
Any future decision to wire it into that command belongs with a separately reviewed
test-only correction. No related runtime behavior is changed here.

## Local evidence

The TASK-041 isolated worktree rerun is retained outside the repository at
`C:/Users/DevLabs-Test/AppData/Local/Temp/chronasense-task041-evidence-20261124/legacy-expectations.log`.
Prior baseline and independent qualification evidence is under
`C:/Users/DevLabs-Test/AppData/Local/Temp/chronasense-qualification-20261124`.
