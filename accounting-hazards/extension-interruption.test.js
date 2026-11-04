import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('./extension-interrupt-worker.mjs', import.meta.url));
const cleanup = directory => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('task039-extension-'));
  fs.rmSync(directory, { recursive: true, force: true });
};
for (const uid of ['alice', 'bob']) {
  for (const point of ['after-enqueue', 'after-merge', 'before-active-removal']) {
    test(`${uid}: process exit ${point} retains the original endpoint across a one-day offline restart`, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'task039-extension-')), file = path.join(directory, 'storage.json');
      try {
        const killed = spawnSync(process.execPath, [worker, file, point, uid], { encoding: 'utf8' }); assert.equal(killed.status, 17, killed.stderr);
        const before = JSON.parse(fs.readFileSync(file, 'utf8')), captured = JSON.parse(before[`ta3-extension-writes-v1:${uid}`]).queue[0];
        assert.equal(captured.entry.ts, 1600000); assert.equal(captured.entry.blockIntervalMin, 10);
        const recovered = spawnSync(process.execPath, [worker, file, 'recover', uid], { encoding: 'utf8' }); assert.equal(recovered.status, 0, recovered.stderr);
        const after = JSON.parse(fs.readFileSync(file, 'utf8')), state = JSON.parse(after[`ta3-extension-writes-v1:${uid}`]);
        assert.equal(state.queue.length, 1); assert.equal(state.queue[0].id, captured.id);
        assert.deepEqual(state.queue[0].entry, captured.entry); assert.equal(state.queue[0].reason, 'physical-fence-unproven');
        assert.equal(after.activeTab, undefined);
      } finally { cleanup(directory); }
    });
  }
  test(`${uid}: failed durable capture leaves the original active session for explicit recovery`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'task039-extension-')), file = path.join(directory, 'storage.json');
    try {
      const result = spawnSync(process.execPath, [worker, file, 'storage-failure', uid], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
      const state = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(state.activeTab.startedAt, 1000000);
      assert.equal(state[`ta3-extension-merge:${uid}`], undefined); assert.equal(state[`ta3-extension-writes-v1:${uid}`], undefined);
      assert.match(result.stderr, /tracking paused; original state retained/);
    } finally { cleanup(directory); }
  });
}
