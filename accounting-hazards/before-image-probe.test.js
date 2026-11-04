// Local capability probe: can RTDB rules compare arbitrary whole-record before-images?
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEmulator } from '../rtdb-emulator-support.js';

test('RTDB whole-object before-image equality capability', async () => {
  const emulator = await startEmulator();
  try {
    const w = await emulator.fresh({ rules: {
      before: { '.read': true },
      record: { '.read': true, '.write': "data.val() === root.child('before').val()" },
    } });
    const value = { id: 1, tsStart: 1, ts: 600001, nested: { a: 'keep', b: [1, 2] } };
    await w.seed('before', value); await w.seed('record', value);
    const equal = await w.write('record', { ...value, deleted: true });
    console.log(JSON.stringify({ wholeObjectEqualityGranted: equal }));
    assert.equal(equal, false, 'whole-object equality cannot provide the required generic before-image gate');
    assert.equal(await w.write('record', { ...value, ts: 700001 }), false, 'changed before-image must refuse');
  } finally { emulator.stop(); }
});
