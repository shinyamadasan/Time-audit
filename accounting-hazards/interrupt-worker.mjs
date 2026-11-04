// Test process ends after a durable local checkpoint, before a command can publish anything.
import fs from 'node:fs';
await import('../time-ack.js');
await import('./command-journal.js');
const [file, uid] = process.argv.slice(2), owner = `uid_${uid}`;
const storage = { getItem: () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
  setItem: (_key, value) => fs.writeFileSync(file, value) };
const journal = globalThis.AccountingCommandJournal.createJournal({ storage, lock: (_owner, fn) => fn(),
  core: globalThis.TimeAckCore, randomId: () => 'interrupted_command',
  transport: { read: () => { throw Error('must never reach network'); }, patch: () => { throw Error('must never reach network'); } } });
const before = { 'entries/e_1': { id: 1, tsStart: 0, ts: 600000 }, timer: { taskStartTime: 600000 } };
await journal.run({ owner, uid, device: 'original-device', name: 'Stop', at: 720000, before,
  blocked: () => false, capture: () => null, apply() {
    const draft = { entries: [{ id: 1, tsStart: 0, ts: 720000 }], cursor: { taskStartTime: 600000 } };
    journal.checkpoint(owner, draft);
    process.exit(17);
  } });
