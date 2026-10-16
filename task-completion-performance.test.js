// Synthetic cost observations only: no account data and no billing/network measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fixture, command, memory, NOW } from './task-completion-test-support.js';
import { createCompletionHandler, execute } from './functions/src/completion-api.js';

for (const [tasks, mib] of [[22, .5], [100, 2], [1000, 8]]) {
  test(`synthetic ${tasks} tasks / ${mib} MiB room: bounded batch inspection and one sibling contention`, async t => {
    const f = fixture(), plan = f.room.calendarPlans[f.targetKey];
    plan.items = Array.from({ length: tasks }, (_, i) => ({ ...f.item, id: `scale-${i}` }));
    f.room.syntheticPadding = 'x'.repeat(Math.floor(mib * 1024 * 1024) - Buffer.byteLength(JSON.stringify(f.room)) - 32);
    const bytes = Buffer.byteLength(JSON.stringify(f.room)), io = memory(f.room);
    let reads = 0, puts = 0, downloaded = 0, uploaded = 0;
    const read = io.read, cas = io.cas;
    io.read = async uid => { reads++; const value = await read(uid); downloaded += Buffer.byteLength(JSON.stringify(value.value)); return value; };
    io.cas = async (...args) => { puts++; uploaded += Buffer.byteLength(JSON.stringify(args[2]));
      if (puts === 1) io.change(room => ({ ...room, timer: { ...room.timer, unrelatedHeartbeat: 1 } }));
      return cas(...args); };
    const handler = createCompletionHandler({ verifyIdToken: async uid => ({ uid }), domain: io, now: () => NOW });
    const start = performance.now();
    for (let offset = 0; offset < tasks; offset += 100) {
      const identities = plan.items.slice(offset, offset + 100).map(item => ({ ...f.identity, itemId: item.id }));
      const result = await handler({ method: 'POST', authorization: 'Bearer alice', rawBody: Buffer.from(JSON.stringify({ kind: 'inspect', identities })) });
      assert.equal(result.body.outcome, 'CONFIRMED'); assert.ok(result.body.views.every(view => view.state === 'unfinished'));
    }
    const inspectMs = Math.round(performance.now() - start), inspectReads = reads;
    const request = await command(f.room, { ...f.identity, itemId: 'scale-0' });
    const before = performance.now(), result = await execute(io, 'alice', request, NOW);
    assert.equal(result.outcome, 'CONFIRMED'); assert.equal(puts, 2); assert.equal(reads - inspectReads, 3);
    assert.equal(io.value().timer.unrelatedHeartbeat, 1);
    t.diagnostic(JSON.stringify({ tasks, roomBytes: bytes, inspectMs, completionMs: Math.round(performance.now() - before), inspectReads,
      completionReads: reads - inspectReads, conditionalPutAttempts: puts, downloadedBytes: downloaded, attemptedUploadBytes: uploaded }));
  });
}
