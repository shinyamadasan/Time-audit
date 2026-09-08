// ══════════════════════════════════════════════════════
// PHASE 6B.1 — Windows Ambient Focus HUD state bridge
//
// Pushes the *existing* authoritative Focus state (owned by focus-mode.js)
// to an optional local Windows companion process (windows-hud/ChronaSenseHud.ps1)
// over loopback HTTP. This module creates no Focus state of its own — every
// push is triggered by focus-mode.js from a real Focus lifecycle transition
// (start, phase change, end). If no companion is running, or the browser
// hasn't granted local-network access, every push fails fast and is silently
// swallowed: Focus itself is completely unaffected either way.
//
// ONE-WAY ONLY (fix round 1): the HUD has no way to mutate Focus state. There
// is no command channel of any kind — the companion's HTTP response carries
// no instruction back, and this module does not read one. ChronaSense's own
// controls remain the only way to end/change a session.
//
// Transport note: a persistent WebSocket was tried first and rejected — a
// public HTTPS page (ChronaSense's real deployment) opening a raw ws:// to
// 127.0.0.1 is hard-blocked by Chrome's Local Network Access policy with no
// server-side opt-in available for WebSocket specifically (verified against
// the live production origin: net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS).
// Plain fetch() DOES work, gated behind the one-time "access devices on your
// local network" permission prompt Chrome shows on first use — which fires
// from the same click that starts Focus, since pushActive() is called
// synchronously from the Start button's handler.
//
// Visibility-aware freshness (fix round 1): document.visibilityState is
// stamped on every push as bridge-health metadata only — never Focus truth —
// so the companion can apply a longer stale-tolerance while the tab is
// genuinely backgrounded (where Chromium throttles timers) without ever
// mistaking normal background throttling for a lost connection. A
// visibilitychange listener forces an immediate re-push (bypassing the
// heartbeat's in-flight guard) so the companion learns about the transition
// itself, not just its downstream effect on timer cadence.
// ══════════════════════════════════════════════════════

export const HUD_BRIDGE_PORT = 51739;
export const HUD_BRIDGE_URL = `http://127.0.0.1:${HUD_BRIDGE_PORT}/focus-bridge/state`;
export const HUD_HEARTBEAT_MS = 4000;
const LINK_TYPES = ['daily-routine', 'learning-plan', 'none'];

function currentPageVisibility() {
  if (typeof document === 'undefined' || typeof document.visibilityState !== 'string') return 'visible';
  return document.visibilityState === 'hidden' ? 'hidden' : 'visible';
}

export function buildActiveSnapshot({ title, phase, startedAt, plannedEndAt, linkType, deviceOwned }) {
  return {
    type: 'focus-active',
    title: String(title || 'Focus session').slice(0, 200),
    phase: phase === 'break' ? 'break' : 'work',
    startedAt: Number(startedAt) || Date.now(),
    plannedEndAt: Number(plannedEndAt) || Date.now(),
    linkType: LINK_TYPES.includes(linkType) ? linkType : 'none',
    deviceOwned: !!deviceOwned,
    pageVisibility: currentPageVisibility()
  };
}

export function buildEndedSnapshot() {
  return { type: 'focus-ended' };
}

// fetchImpl/setIntervalImpl/clearIntervalImpl are injectable purely so this can be
// unit-tested with no real network/timers (see windows-hud-bridge.test.js).
export function createHudBridge({
  fetchImpl = (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null),
  setIntervalImpl = (typeof setInterval !== 'undefined' ? setInterval : null),
  clearIntervalImpl = (typeof clearInterval !== 'undefined' ? clearInterval : null),
  onStatusChange
} = {}) {
  let lastSnapshot = null;
  let lastActiveFields = null; // raw fields, kept so visibilitychange can rebuild with fresh visibility
  let heartbeatTimer = null;
  let inFlight = false;
  let connected = null; // null = unknown yet, true/false once we've observed an outcome

  function setConnected(next) {
    if (connected === next) return;
    connected = next;
    if (typeof onStatusChange === 'function') onStatusChange(next);
  }

  async function send(snapshot, { isHeartbeat = false } = {}) {
    lastSnapshot = snapshot;
    if (!fetchImpl) return;
    if (isHeartbeat && inFlight) return; // never stack heartbeats behind a slow/hung request
    inFlight = true;
    try {
      const resp = await fetchImpl(HUD_BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot)
      });
      setConnected(!!(resp && resp.ok));
    } catch {
      // Either no companion is listening, or the browser hasn't granted local
      // network access — indistinguishable from script (browsers don't expose
      // that detail to catch()), so we report one honest status: "not connected".
      setConnected(false);
    } finally {
      inFlight = false;
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer && clearIntervalImpl) clearIntervalImpl(heartbeatTimer);
    heartbeatTimer = null;
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (!setIntervalImpl) return;
    heartbeatTimer = setIntervalImpl(() => {
      if (lastSnapshot && lastSnapshot.type === 'focus-active') send(lastSnapshot, { isHeartbeat: true });
    }, HUD_HEARTBEAT_MS);
  }

  function pushActive(fields) {
    lastActiveFields = fields;
    const snapshot = buildActiveSnapshot(fields);
    send(snapshot);
    startHeartbeat();
  }

  function pushEnded() {
    stopHeartbeat();
    lastActiveFields = null;
    const hadSnapshot = !!lastSnapshot;
    lastSnapshot = null;
    if (hadSnapshot) send(buildEndedSnapshot());
    connected = null; // unknown again until the next real attempt
  }

  function notifyVisibilityChange() {
    // Bridge-health metadata only — rebuilding from the same raw fields just
    // re-stamps a fresh pageVisibility; it never alters Focus truth.
    if (lastActiveFields) pushActive(lastActiveFields);
  }

  return {
    pushActive,
    pushEnded,
    notifyVisibilityChange,
    isConnected: () => connected,
    _send: send // exposed for tests only
  };
}

let _sharedBridge = null;
export function getSharedHudBridge(handlers) {
  if (!_sharedBridge) _sharedBridge = createHudBridge(handlers);
  return _sharedBridge;
}

if (typeof window !== 'undefined') {
  const bridge = getSharedHudBridge({
    onStatusChange: (isConnected) => {
      if (typeof globalThis.onHudBridgeStatusChange === 'function') {
        globalThis.onHudBridgeStatusChange(isConnected);
      }
    }
  });
  window.chronaSenseHudBridge = bridge;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => bridge.notifyVisibilityChange());
  }
}
