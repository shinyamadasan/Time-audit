// Install before the SDK captures WebSocket. Only the loopback emulator may be proxied.
(() => {
  const config = window.__deviceTestConfig;
  const nativeSocket = window.WebSocket;
  window.WebSocket = class TestSocket extends nativeSocket {
    constructor(url, protocols) {
      const address = new URL(url);
      if (address.hostname !== '127.0.0.1' || address.port !== String(config.emulatorPort)) {
        throw new Error('Test instance refuses non-emulator WebSockets');
      }
      const target = new URL('/rtdb' + address.pathname + address.search, location.origin);
      target.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      super(target.href, protocols);
    }
  };
})();
