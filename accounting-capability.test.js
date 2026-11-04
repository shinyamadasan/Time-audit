// Shipped accounting capability: proof classification and its pin to the exact rules artifact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import './accounting-command.js';
import './accounting-capability.js';

const { AccountingCapability, AccountingCommand } = globalThis;
const OWNER = 'uid_alice';

function server({ sink = 200, erase = 401, parent = 401, read = true, patch = 200 } = {}) {
  const calls = [];
  const status = value => { if (value instanceof Error) throw value; return { status: value, body: null }; };
  return { calls,
    cancel: async (owner, id) => { calls.push(`cancel ${id}`); return status(sink); },
    put: async (owner, path) => { calls.push(`put ${path}`); return status(path.startsWith('focus') ? parent : erase); },
    read: async (owner, paths) => {
      calls.push(`read ${paths}`);
      if (!read) throw Error('refused');
      return { '': { timer: null } };
    },
    patch: async () => { calls.push('patch'); return status(patch); } };
}
const transport = (fake, options) => AccountingCapability.createTransport({ rest: () => fake, ...options });

test('capability is pinned to the exact rules artifact and coordinator protocol', () => {
  const rules = readFileSync(new URL('./firebase.rules.json', import.meta.url));
  const hash = createHash('sha256').update(rules.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
  assert.equal(AccountingCapability.CAPABILITY.rulesSha256, hash, 'rules changed: requalify and update the capability');
  assert.equal(AccountingCapability.CAPABILITY.protocol, AccountingCommand.PROTOCOL);
  assert.equal(AccountingCapability.CAPABILITY.coordinatorVersion, AccountingCommand.VERSION);
});

test('candidate rules prove once, and the proof is reused', async () => {
  const fake = server(), shipped = transport(fake);
  await shipped.inspect(OWNER); await shipped.inspect(OWNER);
  assert.equal(shipped.state(OWNER), 'proven');
  assert.equal(fake.calls.filter(call => call.startsWith('cancel')).length, 1);
});

test('an unproven transport never reaches the server with a command', async () => {
  const fake = server(), shipped = transport(fake);
  await assert.rejects(shipped.patch(OWNER, { timer: {} }));
  assert.deepEqual(fake.calls, []);
});

for (const [name, setup, state] of [
  ['older rules without the sink are incompatible', { sink: 401 }, 'incompatible'],
  ['an erasable fence is incompatible', { erase: 200 }, 'incompatible'],
  ['a parent grant is incompatible', { parent: 200 }, 'incompatible'],
  ['a refused token is unverified, not incompatible', { sink: 401, read: false }, 'unverified'],
  ['a server error is unverified', { sink: 503 }, 'unverified'],
  ['an inconclusive deny check is unverified', { erase: 500 }, 'unverified'],
  ['a network failure is unverified', { sink: new TypeError('offline') }, 'unverified'],
]) {
  test(name, async () => {
    const fake = server(setup), shipped = transport(fake);
    await assert.rejects(shipped.inspect(OWNER), /fence unproven/);
    assert.equal(shipped.state(OWNER), state);
    await assert.rejects(shipped.patch(OWNER, { timer: {} }));
    assert.equal(fake.calls.includes('patch'), false);
  });
}

test('an unproven proof is retried, so installing gates activates a waiting client', async () => {
  const fake = server({ sink: 401 }), shipped = transport(fake);
  await assert.rejects(shipped.inspect(OWNER));
  fake.cancel = async () => ({ status: 200 });
  await shipped.inspect(OWNER);
  assert.equal(shipped.state(OWNER), 'proven');
});

test('a refused write discards the proof', async () => {
  const fake = server({ patch: 401 }), shipped = transport(fake);
  await shipped.inspect(OWNER);
  assert.equal((await shipped.patch(OWNER, { timer: {} })).status, 401);
  assert.equal(shipped.state(OWNER), 'unverified');
});

test('an expired proof is re-proved, so rolled-back rules stop sends without any refused write', async () => {
  let at = 1000;
  const fake = server(), shipped = transport(fake, { now: () => at });
  await shipped.inspect(OWNER);
  await shipped.patch(OWNER, { timer: {} });
  at += 5 * 60 * 1000;
  await assert.rejects(shipped.patch(OWNER, { timer: {} }), /fence unproven/);
  fake.cancel = async () => ({ status: 401 });
  await assert.rejects(shipped.inspect(OWNER), /fence unproven/);
  assert.equal(shipped.state(OWNER), 'incompatible');
  assert.equal(fake.calls.filter(call => call === 'patch').length, 1);
});

test('proof is per account', async () => {
  const shipped = transport(server());
  await shipped.inspect(OWNER);
  assert.equal(shipped.state('uid_bob'), 'unverified');
});

test('a coordinator from another protocol disables the capability', () => {
  const shipped = AccountingCapability.createTransport({ rest: () => server(),
    coordinator: { PROTOCOL: 'staged-command-v2', VERSION: 1 } });
  assert.equal(shipped.enforcesAccounting, false);
  assert.equal(shipped.enforcesCancellation, false);
  assert.equal(shipped.state(OWNER), 'incompatible');
});
