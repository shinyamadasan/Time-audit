// Test-only (TASK-039). A stub room exposing window.__fbTest.get/remoteWrite answers an acknowledged
// Undo the way the RTDB REST API does in production: an authoritative read per path, and one
// all-or-nothing PATCH acknowledged with its echo. `offlineKey` names the stub's persisted network
// flag (a JSON {failWrites}) so an offline stub refuses the attempt like a lost connection;
// window.__timeAckDropPatch drops Undo and staged accounting PATCHes before delivery.
export async function acknowledgingServer(target, { offlineKey = null } = {}) {
  await target.route('**/accounting-capability.js*', route => route.fulfill({ contentType: 'text/javascript',
    body: 'globalThis.AccountingCapability = { createTransport: () => window.__testAccountingTransport };' }));
  await target.addInitScript(({ offlineKey }) => {
    const offline = () => {
      if (!offlineKey) return false;
      try { return !!JSON.parse(localStorage.getItem(offlineKey) || '{}').failWrites; } catch { return false; }
    };
    // Current staged runtime uses a deterministic room fixture. Its real rule/atomicity
    // guarantees are tested separately with the SDK/emulator; this adapter never reaches a network.
    // Installed below by replacing the shipped accounting-capability.js on the wire.
    const attached = owner => owner && owner === window.getChronaSenseRoomCode?.();
    window.__testAccountingTransport = {
      enforcesAccounting: true, enforcesCancellation: true, state: () => 'proven',
      async inspect(owner) {
        if (offline() || !attached(owner)) throw new Error('Account inspection unavailable (test stub)');
        return window.__fbTest.get(`rooms/${owner}`) || {};
      },
      async patch(owner, patch) {
        if (offline() || window.__timeAckDropPatch || !attached(owner)) throw new Error('Accounting unconfirmed (test stub)');
        const room = window.__fbTest.get(`rooms/${owner}`) || {};
        for (const [path, value] of Object.entries(patch)) {
          const before = path.split('/').reduce((node, key) => node?.[key], room), meta = value?._csWrite;
          if (!/^(timer|awayState|breakState|entries\/[^/]+|focusRedemptions\/[^/]+)$/.test(path)
            || meta?.protocol !== 'staged-command-v1' || !Number.isSafeInteger(meta.revision)
            || meta.baseExists !== (before != null) || meta.baseRevision !== (before?._csWrite?.revision || 0)
            || meta.revision !== meta.baseRevision + 1 || room.timeAckCancellations?.[meta.operationId]) return { status: 403 };
        }
        Object.entries(patch).forEach(([path, value]) => {
          if (Array.isArray(window.__fbTest.log?.writes)) window.__fbTest.log.writes.push({ path: `rooms/${owner}/${path}`, value: JSON.parse(JSON.stringify(value)) });
          window.__fbTest.remoteWrite(`rooms/${owner}/${path}`, value);
        });
        return { status: 200, body: patch };
      },
      async cancel(owner, id) {
        if (offline() || !attached(owner) || !/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new Error('Cancellation unconfirmed (test stub)');
        window.__fbTest.remoteWrite(`rooms/${owner}/timeAckCancellations/${id}`, true);
      },
    };
  }, { offlineKey });
}
