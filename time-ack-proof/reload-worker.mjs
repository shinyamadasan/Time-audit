// A fresh process has no original promise, live frame, or in-memory receipt.
import {DiskEnvelope, cleanup, transportFor} from './fixtures.js';
import {createLifecycle} from './lifecycle.js';
const [file, base, namespace, owner, device, session] = process.argv.slice(2);
const store = new DiskEnvelope(); store.file = file;
try {
  const transport = transportFor({base}, {name: namespace});
  const lifecycle = createLifecycle({store, owner, active: () => ({owner, device, session}), transport});
  const outcome = await lifecycle.recover();
  const first = lifecycle.apply(), second = lifecycle.apply();
  console.log(JSON.stringify({phase: outcome.phase, first, second, applications: lifecycle.snapshot().applications,
    cursor: lifecycle.snapshot().frame.timer.taskStartTime, writes: transport.writes}));
} finally {cleanup();}
