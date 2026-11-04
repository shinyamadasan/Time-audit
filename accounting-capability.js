// accounting-capability.js — the shipped accounting transport (TASK-039). Classic script.
//
// The coordinator sends only through a transport that enforces the staged-command gates. This file
// is that release capability: a descriptor paired with one exact firebase.rules.json, and the proven
// TimeAckCore REST transport behind a server proof. A database marker cannot activate it. Before any
// read or send it checks that the installed rules BEHAVE like the paired rules:
//   allow  the permanent cancellation sink accepts a fence (older rules have no such sink)
//   deny   that fence cannot be erased, and no parent grant covers focusRedemptions
// The two denied checks write null to a fixed path, so older rules store nothing. The allow check
// leaves one fixed marker per account, which no operation ID can equal (randomOperationId is op_...).
// Until the proof passes, every captured fact stays in the coordinator and nothing is sent, so an
// upgraded client stays quiesced until the gates are installed. Proof is per page and per account,
// expires quickly because permissive rules would never refuse a write, and a refused write discards
// it. It samples the gates; the two-stage cutover verifies the exact rules hash with release tooling.
(function (root) {
  'use strict';
  const CAPABILITY = Object.freeze({ v: 1, protocol: 'staged-command-v1', coordinatorVersion: 1,
    rulesSha256: '93f0a77424e730aa5996825af4183e0d42d5f29251260b8f85eea3756645be00' });
  const PROBE_ID = 'capability-probe-v1';
  const PROOF_TTL_MS = 5 * 60 * 1000;
  const denied = response => response.status === 401 || response.status === 403;

  async function check(server, owner) {
    const sink = await server.cancel(owner, PROBE_ID);
    if (sink.status === 200) {
      const results = [await server.put(owner, `timeAckCancellations/${PROBE_ID}`, 'null'),
        await server.put(owner, `focusRedemptions/r_${PROBE_ID}`, 'null')];
      if (results.every(denied)) return 'proven';
      return results.some(result => result.status === 200) ? 'incompatible' : 'unverified';
    }
    if (!denied(sink)) return 'unverified';
    // An expired token is refused too. Only an authorized read makes this a fact about the rules.
    await server.read(owner, ['timeAckCancellations']);
    return 'incompatible';
  }

  function createTransport({ rest, coordinator = root.AccountingCommand, now = () => Date.now() }) {
    const compatible = coordinator?.PROTOCOL === CAPABILITY.protocol && coordinator?.VERSION === CAPABILITY.coordinatorVersion;
    const settled = new Map(), provenAt = new Map();
    const state = owner => compatible ? settled.get(owner) || 'unverified' : 'incompatible';
    const current = owner => state(owner) === 'proven' && Math.abs(now() - provenAt.get(owner)) < PROOF_TTL_MS;
    // Offline and unverified are normal: inspect() throws, and the coordinator retains the command.
    async function prove(owner) {
      if (current(owner)) return;
      const result = await check(rest(), owner).catch(() => 'unverified');
      if (result === 'unverified') settled.delete(owner); else settled.set(owner, result);
      if (result === 'proven') provenAt.set(owner, now());
      if (result !== 'proven') throw Error('Accounting fence unproven');
    }
    return {
      enforcesAccounting: compatible, enforcesCancellation: compatible, state,
      async inspect(owner) { await prove(owner); return (await rest().read(owner, ['']))[''] || {}; },
      async patch(owner, patch) {
        if (!current(owner)) throw Error('Accounting fence unproven');
        const response = await rest().patch(owner, patch);
        if (denied(response)) settled.delete(owner);
        return response;
      },
      async cancel(owner, id) { await prove(owner); return rest().cancel(owner, id); },
    };
  }

  root.AccountingCapability = { CAPABILITY, createTransport };
})(globalThis);
