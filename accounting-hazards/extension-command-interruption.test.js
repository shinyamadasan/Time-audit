import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startEmulator } from '../rtdb-emulator-support.js';
const worker = fileURLToPath(new URL('./extension-command-interrupt-worker.mjs', import.meta.url));
const rules = fs.readFileSync(new URL('../firebase.rules.json', import.meta.url), 'utf8');
let emulator;
before(async () => { emulator = await startEmulator(); });
after(() => emulator?.stop());
for (const uid of ['alice', 'bob']) {
  for (const point of ['after-capture', 'after-import', 'after-intake-removal', 'after-seal', 'after-etag', 'after-pending', 'after-server-commit', 'after-accepted-save']) {
    test(`${uid}: process exit ${point} preserves original command and once-only acceptance one day later`, async () => {
      const world = await emulator.fresh(rules), databaseURL = `${emulator.base}?ns=${world.name}`;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'task039-extension-command-')), file = path.join(directory, 'storage.json');
      try {
        const killed = spawnSync(process.execPath, [worker, file, point, uid, databaseURL], { encoding: 'utf8', timeout: 30000 });
        assert.ifError(killed.error); assert.notEqual(killed.status, 0, killed.stderr);
        const before = JSON.parse(fs.readFileSync(file, 'utf8')), slot = `ta3-extension-writes-v1:${uid}`;
        assert.equal(before.__interrupted, point);
        const prior = before[slot] ? JSON.parse(before[slot]) : null;
        const original = prior?.queue[0] || prior?.history[0] || JSON.parse(before[`ta3-extension-capture-v1:${uid}:extension_original`]);
        assert.equal(original.entry.ts, 1600000); assert.equal(original.entry.blockIntervalMin, 10);
        const recovered = spawnSync(process.execPath, [worker, file, 'recover', uid, databaseURL], { encoding: 'utf8', timeout: 30000 });
        assert.equal(recovered.status, 0, recovered.stderr);
        const after = JSON.parse(fs.readFileSync(file, 'utf8')), state = JSON.parse(after[slot]);
        assert.equal(state.queue.length, 0); assert.equal(state.history.length, 1);
        const accepted = state.history[0];
        assert.equal(accepted.id, original.id); assert.deepEqual(accepted.entry, original.entry);
        if (original.command) assert.deepEqual(accepted.command, original.command);
        if (original.etag) assert.equal(accepted.etag, original.etag);
        const raw = await world.read(`rooms/uid_${uid}/entries`);
        assert.deepEqual(Object.keys(raw), ['1000000']); assert.deepEqual(raw['1000000'], accepted.command.patch['entries/1000000']);
        assert.equal(after.__writes.length, 1);
        assert.deepEqual(JSON.parse(after.__writes[0].bytes), accepted.command.patch['entries/1000000']);
      } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('task039-extension-command-'));
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
