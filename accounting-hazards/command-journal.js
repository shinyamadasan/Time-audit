// LOCAL accounting coordinator. Not loaded by the application until its writer boundary is proven.
// Existing command bodies supply frozen before/after values; this module contains no time math.
(function (root) {
  'use strict';
  const BASE = 'ta3-accounting-command';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

  function createJournal({ storage, lock, transport, core, randomId }) {
    const key = owner => `${BASE}:${owner}`;
    function load(owner) {
      const raw = storage.getItem(key(owner));
      const state = raw ? JSON.parse(raw) : { v: 1, owner, command: null, history: [] };
      if (state.v !== 1 || state.owner !== owner || !Array.isArray(state.history)) throw Error('Invalid accounting journal');
      return state;
    }
    function save(owner, state) {
      const raw = JSON.stringify(state);
      storage.setItem(key(owner), raw);
      if (storage.getItem(key(owner)) !== raw) throw Error('Accounting journal readback failed');
    }
    function edit(owner, id, fn) {
      const state = load(owner);
      if (state.command?.id !== id) throw Error('Accounting command replaced');
      fn(state.command, state); save(owner, state); return clone(state.command);
    }
    function pending(owner) { return clone(load(owner).command); }
    function snapshot(owner) { return clone(load(owner)); }
    function retire(owner, id) {
      edit(owner, id, (command, state) => {
        state.history.unshift(command); state.command = null;
      });
    }
    let active = null;
    function checkpoint(owner, draft) {
      if (!active || active.owner !== owner) return;
      edit(owner, active.id, command => { command.draft = clone(draft); });
    }
    function stage(owner, records) {
      if (!active || active.owner !== owner) throw Error('No accounting command boundary');
      edit(owner, active.id, command => Object.assign(command.records, clone(records)));
    }
    async function send(owner, command) {
      command = edit(owner, command.id, current => { current.phase = 'pending'; current.attempts++; });
      try {
        const response = await transport.patch(owner, clone(command.patch));
        const echo = response.body;
        const exact = Object.entries(command.patch).every(([path, value]) => core.same(
          Object.hasOwn(echo || {}, path) ? echo[path] : path.split('/').reduce((node, part) => node?.[part], echo), value));
        return edit(owner, command.id, current => {
          current.phase = response.status === 200 && exact ? 'accepted' : 'unknown';
          current.evidence = { status: response.status };
        });
      } catch {
        return edit(owner, command.id, current => { current.phase = 'unknown'; });
      }
    }
    async function seal(owner, command) {
      let actual;
      try { actual = await transport.read(owner, Object.keys(command.records)); }
      catch { return edit(owner, command.id, current => { current.phase = 'ready'; }); }
      if (!Object.entries(command.before).every(([path, value]) => core.same(actual[path], value))) {
        return edit(owner, command.id, current => { current.phase = 'conflict'; });
      }
      command = edit(owner, command.id, current => {
        current.patch = Object.fromEntries(Object.entries(current.records).map(([path, after]) =>
          [path, core.stamp(current.before[path], after, current.id)]));
        current.phase = 'intent';
      });
      return send(owner, command);
    }

    /** One lock covers durable preparation, unchanged local command body, seal and server send. */
    function run({ owner, uid, device, name, at, before, capture, apply, blocked, validate = () => true, eventId = null }) {
      return lock(owner, async () => {
        const state = load(owner);
        if (eventId && state.history.some(command => command.eventId === eventId && command.phase === 'accepted')) {
          return { value: true, command: null, completed: true };
        }
        if (state.command || blocked() || !validate()) return { blocked: true };
        const id = randomId();
        state.command = { id, eventId, owner, uid, device, name, at, phase: 'preparing', attempts: 0,
          before: clone(before), draft: null, records: {}, patch: null };
        save(owner, state); // before any local mutation or network operation
        active = { owner, id };
        let value;
        try {
          value = apply();
          if (value && typeof value.then === 'function') throw Error('Accounting boundary must be synchronous');
          checkpoint(owner, capture());
        } catch (error) {
          edit(owner, id, command => { command.phase = 'interrupted'; });
          throw error;
        } finally { active = null; }
        let command = pending(owner);
        if (!Object.keys(command.records).length) { retire(owner, id); return { value, command: null }; }
        // Only the paths this command actually changes participate in its immutable precondition.
        command = edit(owner, id, current => {
          current.before = Object.fromEntries(Object.keys(current.records).map(path => [path, current.before[path] ?? null]));
          current.phase = 'ready';
        });
        return { value, command: await seal(owner, command) };
      });
    }
    function recover(owner) {
      return lock(owner, async () => {
        const command = pending(owner);
        if (!command) return null;
        if (command.phase === 'preparing') return edit(owner, command.id, current => { current.phase = 'interrupted'; });
        if (command.phase === 'ready') return seal(owner, command); // nothing was ever sent
        if (!['pending', 'unknown', 'intent'].includes(command.phase)) return command;
        let actual;
        try { actual = await transport.read(owner, Object.keys(command.patch)); } catch { return command; }
        if (Object.entries(command.patch).every(([path, value]) => core.same(actual[path], value))
          || Object.values(actual).some(value => value?._csWrite?.operationId === command.id)) {
          return edit(owner, command.id, current => { current.phase = 'accepted'; });
        }
        return edit(owner, command.id, current => { current.phase = 'unknown'; });
      });
    }
    function finalize(owner, apply) {
      return lock(owner, () => {
        const command = pending(owner);
        if (command?.phase !== 'accepted' || !apply(clone(command))) return false;
        retire(owner, command.id); return true;
      });
    }
    return { run, recover, pending, snapshot, checkpoint, stage, finalize };
  }
  root.AccountingCommandJournal = { BASE, createJournal };
})(globalThis);
