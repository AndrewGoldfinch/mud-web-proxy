/**
 * Tests for IP counting fixes:
 *   1. X-Forwarded-For used instead of remoteAddress for real client IP
 *   2. removeSession always decrements IP count (covers MUD drop + connect failure leaks)
 *   3. handleSocketClose (backgrounding) does NOT decrement — session still alive
 *   4. Device-limit eviction decrements evicted session's IP count
 *   5. Failed MUD connect does not increment IP count
 *   6. MUD termination decrements IP count via removeSession
 */

import { parseFrame, type ProxyFrame } from './support/frames';
import { asDouble } from './support/doubles';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import net from 'net';
import { SessionManager } from '../src/session-manager.js';
import { SessionIntegration } from '../src/session-integration.js';
import type { SocketExtended } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockSocket extends SocketExtended {
  messages: string[];
}

function makeSocket(
  opts: { remoteAddress?: string; xff?: string } = {},
): MockSocket {
  const messages: string[] = [];
  const s = asDouble<MockSocket>()(new EventEmitter());
  s.readyState = 1; // WebSocket.OPEN
  s.remoteAddress = opts.remoteAddress ?? '127.0.0.1';
  s.messages = messages;
  // sendUTF is used by SessionIntegration directly (sendError, session response)
  s.sendUTF = (data: string | Buffer) => {
    messages.push(String(data));
  };
  // send is used by Session.broadcastToClients
  s.send = (data: Parameters<MockSocket['send']>[0]) => {
    messages.push(String(data));
  };
  s.terminate = () => {};
  s.ttype = [];
  s.compressed = 0;
  s.req = asDouble<MockSocket['req']>()({
    headers: opts.xff ? { 'x-forwarded-for': opts.xff } : {},
    connection: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    url: '/',
    method: 'GET',
  });
  return s;
}

/** Checks whether enforceConnectionLimits would block the given IP. */
function isBlocked(mgr: SessionManager, ip: string): boolean {
  // Use a fresh unique device token so device-limit logic never fires here.
  return !mgr.enforceConnectionLimits(`probe-${Math.random()}`, ip).allowed;
}

/** Returns the parsed JSON of the last message sent to a socket. */
/**
 * Find a message by type. Asserting on the LAST message races the real dial:
 * an unstubbed connection can fail and append `connection_failed` before the
 * assertion runs, which is what made these tests flaky in CI but not locally.
 */
function findMsg(socket: MockSocket, type: string): ProxyFrame | undefined {
  return socket.messages
    .map((m) => parseFrame(m))
    .find((m) => m.type === type);
}

function lastMsg(socket: MockSocket): ProxyFrame {
  const raw = socket.messages.at(-1);
  if (!raw) throw new Error('no messages on socket');
  return parseFrame(raw);
}

/**
 * Polls socket.messages until one satisfies the predicate,
 * or rejects after `timeout` ms.
 */
function waitForMsg(
  socket: MockSocket,
  match: (msg: ProxyFrame) => boolean,
  label: string,
  timeout = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Timeout waiting for ${label}`)),
      timeout,
    );
    const check = () => {
      const found = socket.messages.some((m) => {
        try {
          return match(parseFrame(m));
        } catch {
          return false;
        }
      });
      if (found) {
        clearTimeout(deadline);
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// 1. X-Forwarded-For extraction
// ---------------------------------------------------------------------------

describe('X-Forwarded-For: real client IP used for rate limiting', () => {
  let si: SessionIntegration;

  beforeEach(() => {
    si = new SessionIntegration({
      targets: {
        targetMode: 'arbitrary' as const,
        defaultHost: 'mud.test',
        defaultPort: 23,
        arbitraryAllowedPorts: ['1-65535'],
      },
      // These fixtures exercise session accounting, not DNS. Stub resolution
      // so arbitrary mode does not perform real lookups for test hostnames.
      resolveTarget: async (host: string) => ({
        allowed: true,
        address: host,
      }),
      sessions: { maxPerIP: 1, maxPerDevice: 5, timeoutHours: 24 },
      trustedProxyCidrs: true,
    });
  });

  afterEach(() => {
    si.shutdown();
  });

  test('rate-limits on XFF IP, not remoteAddress', () => {
    // Pre-fill the XFF IP to the limit; remoteAddress is NOT at limit.
    si.sessionManager.incrementIPCount('1.2.3.4');

    const socket = makeSocket({ remoteAddress: '127.0.0.1', xff: '1.2.3.4' });
    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'mud.test',
          port: 23,
          deviceToken: 'dev',
        }),
      ),
    );

    // With trustedProxyCidrs=true: 1.2.3.4 checked via XFF → at limit → rate_limited.
    expect(lastMsg(socket)).toMatchObject({
      type: 'error',
      code: 'rate_limited',
    });
  });

  test('allows connection when XFF IP is not at limit even if remoteAddress is', async () => {
    // remoteAddress is at limit; XFF points to a different, uncapped IP.
    si.sessionManager.incrementIPCount('127.0.0.1');

    const socket = makeSocket({ remoteAddress: '127.0.0.1', xff: '9.9.9.9' });
    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'mud.test',
          port: 23,
          deviceToken: 'dev',
        }),
      ),
    );

    // With trustedProxyCidrs=true: 9.9.9.9 checked via XFF → not at limit → session created.
    // handleConnect awaits DNS resolution in arbitrary mode.
    await Bun.sleep(0);
    expect(findMsg(socket, 'session')).toBeDefined();
  });

  test('uses first IP from comma-separated XFF header', () => {
    si.sessionManager.incrementIPCount('10.0.0.1');

    const socket = makeSocket({
      remoteAddress: '127.0.0.1',
      xff: '10.0.0.1, 10.0.0.2, 10.0.0.3',
    });
    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'mud.test',
          port: 23,
          deviceToken: 'dev',
        }),
      ),
    );

    expect(lastMsg(socket)).toMatchObject({
      type: 'error',
      code: 'rate_limited',
    });
  });

  test('falls back to remoteAddress when XFF header is absent', () => {
    si.sessionManager.incrementIPCount('127.0.0.1');

    const socket = makeSocket({ remoteAddress: '127.0.0.1' }); // no xff
    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'mud.test',
          port: 23,
          deviceToken: 'dev',
        }),
      ),
    );

    expect(lastMsg(socket)).toMatchObject({
      type: 'error',
      code: 'rate_limited',
    });
  });

  test('ignores XFF headers when trustedProxyCidrs is false (default)', async () => {
    si.shutdown();
    si = new SessionIntegration({
      targets: {
        targetMode: 'arbitrary' as const,
        defaultHost: 'mud.test',
        defaultPort: 23,
        arbitraryAllowedPorts: ['1-65535'],
      },
      // These fixtures exercise session accounting, not DNS. Stub resolution
      // so arbitrary mode does not perform real lookups for test hostnames.
      resolveTarget: async (host: string) => ({
        allowed: true,
        address: host,
      }),
      sessions: { maxPerIP: 1, maxPerDevice: 5, timeoutHours: 24 },
      trustedProxyCidrs: false,
    });

    // XFF IP is at limit, but remoteAddress is NOT.
    si.sessionManager.incrementIPCount('1.2.3.4');

    const socket = makeSocket({ remoteAddress: '127.0.0.1', xff: '1.2.3.4' });
    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'mud.test',
          port: 23,
          deviceToken: 'dev',
        }),
      ),
    );

    // Without trustedProxyCidrs: remoteAddress (127.0.0.1) is used, not XFF → session created.
    // handleConnect awaits DNS resolution in arbitrary mode.
    await Bun.sleep(0);
    expect(findMsg(socket, 'session')).toBeDefined();
  });

  test('honours XFF from a peer inside a trusted CIDR range', () => {
    si.shutdown();
    si = new SessionIntegration({
      targets: {
        targetMode: 'arbitrary' as const,
        defaultHost: 'mud.test',
        defaultPort: 23,
        arbitraryAllowedPorts: ['1-65535'],
      },
      // These fixtures exercise session accounting, not DNS. Stub resolution
      // so arbitrary mode does not perform real lookups for test hostnames.
      resolveTarget: async (host: string) => ({
        allowed: true,
        address: host,
      }),
      sessions: { maxPerIP: 1, maxPerDevice: 5, timeoutHours: 24 },
      trustedProxyCidrs: ['10.0.0.0/8'],
    });

    si.sessionManager.incrementIPCount('1.2.3.4');

    const socket = makeSocket({ remoteAddress: '10.1.2.3', xff: '1.2.3.4' });
    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'mud.test',
          port: 23,
          deviceToken: 'dev',
        }),
      ),
    );

    // The proxy at 10.1.2.3 is inside 10.0.0.0/8, so XFF is honoured and the
    // real client 1.2.3.4 is already at its limit.
    expect(lastMsg(socket)).toMatchObject({
      type: 'error',
      code: 'rate_limited',
    });
  });

  test('honours XFF from an IPv4-mapped IPv6 peer matching a trusted entry', () => {
    si.shutdown();
    si = new SessionIntegration({
      targets: {
        targetMode: 'arbitrary' as const,
        defaultHost: 'mud.test',
        defaultPort: 23,
        arbitraryAllowedPorts: ['1-65535'],
      },
      // These fixtures exercise session accounting, not DNS. Stub resolution
      // so arbitrary mode does not perform real lookups for test hostnames.
      resolveTarget: async (host: string) => ({
        allowed: true,
        address: host,
      }),
      sessions: { maxPerIP: 1, maxPerDevice: 5, timeoutHours: 24 },
      trustedProxyCidrs: ['127.0.0.1'],
    });

    si.sessionManager.incrementIPCount('1.2.3.4');

    const socket = makeSocket({
      remoteAddress: '::ffff:127.0.0.1',
      xff: '1.2.3.4',
    });
    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'mud.test',
          port: 23,
          deviceToken: 'dev',
        }),
      ),
    );

    expect(lastMsg(socket)).toMatchObject({
      type: 'error',
      code: 'rate_limited',
    });
  });

  test('ignores XFF from a peer outside the trusted CIDR range', async () => {
    si.shutdown();
    si = new SessionIntegration({
      targets: {
        targetMode: 'arbitrary' as const,
        defaultHost: 'mud.test',
        defaultPort: 23,
        arbitraryAllowedPorts: ['1-65535'],
      },
      // These fixtures exercise session accounting, not DNS. Stub resolution
      // so arbitrary mode does not perform real lookups for test hostnames.
      resolveTarget: async (host: string) => ({
        allowed: true,
        address: host,
      }),
      sessions: { maxPerIP: 1, maxPerDevice: 5, timeoutHours: 24 },
      trustedProxyCidrs: ['10.0.0.0/8'],
    });

    si.sessionManager.incrementIPCount('1.2.3.4');

    const socket = makeSocket({
      remoteAddress: '203.0.113.9',
      xff: '1.2.3.4',
    });
    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: 'mud.test',
          port: 23,
          deviceToken: 'dev',
        }),
      ),
    );

    // Untrusted peer: the spoofed XFF is ignored, so the peer address is used.
    // handleConnect awaits DNS resolution in arbitrary mode.
    await Bun.sleep(0);
    expect(findMsg(socket, 'session')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. SessionManager.removeSession IP count cleanup
// ---------------------------------------------------------------------------

describe('SessionManager.removeSession: IP count cleanup', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager({ maxPerDevice: 5, maxPerIP: 1 });
  });

  afterEach(() => {
    mgr.stop();
  });

  test('decrements count when session has clientIp', () => {
    const session = mgr.create('mud.test', 23, 'dev-token');
    session.clientIp = '1.2.3.4';
    mgr.incrementIPCount('1.2.3.4');

    // Confirm at limit before removal.
    expect(isBlocked(mgr, '1.2.3.4')).toBe(true);

    mgr.removeSession(session.id);

    // BEFORE fix: count never decremented → still blocked.
    // AFTER fix:  count decremented via removeSession → allowed again.
    expect(isBlocked(mgr, '1.2.3.4')).toBe(false);
  });

  test('does not touch count when session has no clientIp', () => {
    const session = mgr.create('mud.test', 23, 'dev-token');
    // clientIp intentionally not set (e.g. anonymous connection or no deviceToken).
    mgr.incrementIPCount('1.2.3.4');

    expect(isBlocked(mgr, '1.2.3.4')).toBe(true);

    mgr.removeSession(session.id);

    // Count for '1.2.3.4' must be unchanged — removing an unrelated session
    // must not accidentally free another IP's slot.
    expect(isBlocked(mgr, '1.2.3.4')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Device-limit eviction decrements evicted session's IP count
// ---------------------------------------------------------------------------

describe('SessionManager: device-limit eviction decrements IP count', () => {
  test('evicted session IP is freed', () => {
    // maxPerDevice=1 forces eviction when a second session arrives for the device.
    // maxPerIP=1 lets us observe whether the count was decremented.
    const mgr = new SessionManager({ maxPerDevice: 1, maxPerIP: 1 });

    const s1 = mgr.create('mud.test', 23, 'shared-device');
    s1.clientIp = '1.2.3.4';
    mgr.incrementIPCount('1.2.3.4'); // count for 1.2.3.4 = 1 → at limit

    expect(isBlocked(mgr, '1.2.3.4')).toBe(true);

    // Second connect for same device token from a different IP → evicts s1.
    mgr.enforceConnectionLimits('shared-device', '5.6.7.8');

    // BEFORE fix: removeSession did not decrement → 1.2.3.4 still blocked.
    // AFTER fix:  removeSession decrements s1.clientIp → 1.2.3.4 freed.
    expect(isBlocked(mgr, '1.2.3.4')).toBe(false);

    mgr.stop();
  });
});

// ---------------------------------------------------------------------------
// 4. handleSocketClose (backgrounding) does NOT decrement IP count
// ---------------------------------------------------------------------------

describe('handleSocketClose: backgrounding a socket does not decrement IP count', () => {
  test('count stays at 1 after client backgrounds (socket close, session alive)', () => {
    const si = new SessionIntegration({
      targets: {
        targetMode: 'arbitrary' as const,
        defaultHost: 'mud.test',
        defaultPort: 23,
        arbitraryAllowedPorts: ['1-65535'],
      },
      // These fixtures exercise session accounting, not DNS. Stub resolution
      // so arbitrary mode does not perform real lookups for test hostnames.
      resolveTarget: async (host: string) => ({
        allowed: true,
        address: host,
      }),
      sessions: { maxPerIP: 1, maxPerDevice: 5, timeoutHours: 24 },
    });

    // Manually create a session as if a successful connect happened.
    const session = si.sessionManager.create('mud.test', 23, 'dev-token');
    session.clientIp = '1.2.3.4';
    si.sessionManager.incrementIPCount('1.2.3.4');

    const socket = makeSocket({ remoteAddress: '1.2.3.4' });
    si.sessionManager.attachWebSocket(session.id, socket);

    // At limit before backgrounding.
    expect(isBlocked(si.sessionManager, '1.2.3.4')).toBe(true);

    // Simulate the client going to background (WebSocket closes, session survives).
    si.handleSocketClose(socket);

    // BEFORE fix: handleSocketClose called decrementIPCount → count=0 → not blocked.
    // AFTER fix:  no decrement here; session still alive → count=1 → still blocked.
    expect(isBlocked(si.sessionManager, '1.2.3.4')).toBe(true);

    si.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 5. Failed MUD connect: IP count is NOT incremented
// ---------------------------------------------------------------------------

describe('Failed MUD connect: IP count not incremented', () => {
  test('count remains 0 after connection refused, allowing retry', async () => {
    const si = new SessionIntegration({
      targets: {
        targetMode: 'arbitrary' as const,
        defaultHost: 'mud.test',
        defaultPort: 23,
        arbitraryAllowedPorts: ['1-65535'],
      },
      // These fixtures exercise session accounting, not DNS. Stub resolution
      // so arbitrary mode does not perform real lookups for test hostnames.
      resolveTarget: async (host: string) => ({
        allowed: true,
        address: host,
      }),
      sessions: { maxPerIP: 1, maxPerDevice: 5, timeoutHours: 24 },
    });

    const socket = makeSocket({ remoteAddress: '1.2.3.4' });

    // Port 1 is never listening; connect will be refused quickly.
    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: '127.0.0.1',
          port: 1,
          deviceToken: 'dev',
        }),
      ),
    );

    // sendError sends { type: 'error', code: 'connection_failed' }
    await waitForMsg(
      socket,
      (m) => m.type === 'error' && m.code === 'connection_failed',
      'connection_failed error',
    );

    // BEFORE fix: count incremented before connect attempt → stuck at 1 → blocked.
    // AFTER fix:  count only incremented after successful connect → stays 0 → allowed.
    expect(isBlocked(si.sessionManager, '1.2.3.4')).toBe(false);

    si.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 6. MUD termination: IP count decremented via removeSession
// ---------------------------------------------------------------------------

describe('MUD termination: IP count decremented when session is destroyed', () => {
  test('count returns to 0 after MUD drops the connection', async () => {
    // Spin up a TCP server that accepts then immediately destroys the socket.
    const server = net.createServer((sock) => sock.destroy());
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = asDouble<net.AddressInfo>()(server.address());

    const si = new SessionIntegration({
      targets: {
        targetMode: 'arbitrary' as const,
        defaultHost: 'mud.test',
        defaultPort: 23,
        arbitraryAllowedPorts: ['1-65535'],
      },
      // These fixtures exercise session accounting, not DNS. Stub resolution
      // so arbitrary mode does not perform real lookups for test hostnames.
      resolveTarget: async (host: string) => ({
        allowed: true,
        address: host,
      }),
      // Dial plaintext directly. This server accepts and immediately destroys,
      // which surfaces as a reset — and a reset is no longer treated as
      // evidence the peer wants cleartext (MWP-89), so under `prefer` the
      // connection would never establish and the drop under test could not
      // occur. The subject here is termination accounting, not negotiation.
      mudTlsMode: 'plain' as const,
      sessions: { maxPerIP: 1, maxPerDevice: 5, timeoutHours: 24 },
    });

    const socket = makeSocket({ remoteAddress: '1.2.3.4' });

    si.parseNewMessage(
      socket,
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          host: '127.0.0.1',
          port,
          deviceToken: 'dev',
        }),
      ),
    );

    // Wait for the MUD to drop the connection and the cleanup to propagate.
    // handleMudTermination broadcasts 'disconnected' then schedules removeSession
    // after a 150 ms flush window — wait for the message, then the timer.
    await waitForMsg(socket, (m) => m.type === 'disconnected', 'disconnected');
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    // BEFORE fix: handleMudTermination → removeSessionAndCleanup did not decrement
    //             → count stayed 1 → still blocked.
    // AFTER fix:  removeSession decrements session.clientIp → count=0 → allowed.
    expect(isBlocked(si.sessionManager, '1.2.3.4')).toBe(false);

    si.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
