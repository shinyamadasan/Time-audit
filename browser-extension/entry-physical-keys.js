// Shared by the extension and LOCAL accounting adapter. No time arithmetic or storage effects.
(function (root) {
  'use strict';
  const PROTOCOL = 'staged-command-v1';
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  function wire(value) {
    if (value == null) return null;
    if (typeof value !== 'object') return value;
    const result = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value).sort()) {
      const child = wire(value[key]);
      if (child !== null) result[key] = child;
    }
    return Object.keys(result).length ? result : null;
  }
  const same = (left, right) => JSON.stringify(wire(left)) === JSON.stringify(wire(right));
  const content = record => record == null ? null : { ...record, _csWrite: null };
  const validKey = key => typeof key === 'string' && key.length > 0 && !/[\x00-\x1f\x7f.#$\[\]/]/.test(key);
  function revision(record) {
    const meta = record?._csWrite;
    if (meta === undefined) return 0;
    if (!meta || meta.v !== 1 || !Number.isSafeInteger(meta.revision) || meta.revision < 1
      || !Number.isSafeInteger(meta.baseRevision) || meta.baseRevision < 0 || meta.revision !== meta.baseRevision + 1
      || typeof meta.baseExists !== 'boolean' || !meta.baseExists && meta.baseRevision !== 0
      || typeof meta.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(meta.operationId)
      || (meta.protocol != null && meta.protocol !== PROTOCOL)
      || Object.keys(meta).some(key => !['v', 'protocol', 'revision', 'baseRevision', 'baseExists', 'operationId'].includes(key))) throw Error('Unknown entry revision');
    return meta.revision;
  }
  function resolve(raw, id, prefer = 'app') {
    const identity = String(id);
    if (!validKey(identity) || !['string', 'number'].includes(typeof id)
      || (typeof id === 'number' && (!Number.isSafeInteger(id) || id <= 0))) return { status: 'unknown', reason: 'invalid-identity', id };
    for (const key of [identity, `e_${identity}`]) {
      if (Object.hasOwn(raw || {}, key) && raw[key]?.id !== id) {
        return { status: 'unknown', reason: 'physical-key-occupied', id, physical: [[key, copy(raw[key])]] };
      }
    }
    const matches = Object.entries(raw || {}).filter(([, value]) => value && String(value.id) === identity);
    const before = {};
    for (const [key, value] of matches) {
      if (![identity, `e_${identity}`].includes(key) || value.id !== id) {
        return { status: 'unknown', reason: 'physical-identity-conflict', id, physical: copy(matches) };
      }
      try { revision(value); } catch { return { status: 'unknown', reason: 'unknown-metadata', id, physical: copy(matches) }; }
      before[`entries/${key}`] = copy(value);
    }
    if (!matches.length) {
      const key = prefer === 'extension' ? identity : `e_${identity}`;
      if (Object.hasOwn(raw || {}, key)) return { status: 'unknown', reason: 'physical-key-occupied', id, physical: [[key, copy(raw[key])]] };
      return { status: 'absent', id, record: null, before: { [`entries/${key}`]: null } };
    }
    const record = matches[0][1];
    if (!matches.every(([, value]) => same(content(value), content(record)))) {
      return { status: 'unknown', reason: 'contradictory-aliases', id, physical: copy(matches) };
    }
    return { status: 'found', id, record: copy(record), before };
  }
  function prepare(basis, after, operationId) {
    if (!['found', 'absent'].includes(basis.status)) throw Error('Unresolved physical entry identity');
    if (!after || after.id !== basis.id || !/^[A-Za-z0-9_-]{8,100}$/.test(operationId)) throw Error('Changed entry intent');
    const patch = {};
    for (const [path, before] of Object.entries(basis.before)) {
      if (before?.deleted && !after.deleted && !(after.undoRestoredAt > before.updatedAt)) throw Error('Tombstone restoration is not authorized');
      const base = revision(before);
      if (base === Number.MAX_SAFE_INTEGER) throw Error('Entry revision exhausted');
      patch[path] = wire({ ...copy(after), _csWrite: { v: 1, protocol: PROTOCOL, baseExists: before != null,
        baseRevision: base, revision: base + 1, operationId } });
    }
    return { id: operationId, entryId: basis.id, before: copy(basis.before), patch };
  }
  function unchanged(basis, raw) {
    const actual = resolve(raw, basis.id, Object.keys(basis.before || {})[0] === `entries/${basis.id}` ? 'extension' : 'app');
    return ['found', 'absent'].includes(actual.status) && same(actual.before, basis.before);
  }
  function project(raw) {
    const ids = [...new Map(Object.values(raw || {}).filter(record => record && record.id != null).map(record => [String(record.id), record.id])).values()];
    const entries = [], conflicts = [];
    for (const id of ids) {
      const basis = resolve(raw, id);
      if (basis.status === 'found') entries.push(basis.record);
      else conflicts.push(basis);
    }
    const malformed = Object.entries(raw || {}).filter(([, record]) => !record || record.id == null);
    if (malformed.length) conflicts.push({ status: 'unknown', reason: 'malformed-physical-record', physical: copy(malformed) });
    return { entries, conflicts };
  }
  root.EntryPhysicalKeys = { PROTOCOL, copy, wire, same, content, resolve, prepare, unchanged, project };
})(globalThis);
