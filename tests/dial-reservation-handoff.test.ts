/**
 * A dial in flight must occupy capacity (MWP-92, from Codex review of #72).
 *
 * `dialSession` released the reservation as soon as the Session object
 * existed, but the established count only rises after `await
 * session.connect()` resolves. Between those two points a dial is counted as
 * neither pending nor established, so concurrent connects each observe spare
 * capacity and pass — the precise hole the reservation mechanism exists to
 * close.
 *
 * This asserts against the integration, not the SessionManager: the manager's
 * counters were always correct in isolation. The defect is in when the
 * connect path chooses to call them.
 */

import { z } from 'zod';

/**
 * A dial that connects to nothing and never errors.
 *
 * Only the three methods the transport calls on a pending socket; anything
 * else it reaches for is a genuine gap in the double.
 */
interface BlackHoleSocket extends EventEmitter {
  destroy: () => void;
  off: () => BlackHoleSocket;
  once: () => BlackHoleSocket;
}
import { asDouble, asStub } from './support/doubles';
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import net from 'net';
import { SessionIntegration } from '../src/session-integration.js';
import type { SocketExtended } from '../src/types/index.js';

interface MockSocket extends SocketExtended {
  messages: string[];
}

function makeSocket(): MockSocket {
  const messages: string[] = [];
  const s = asDouble<MockSocket>()(new EventEmitter());
  s.readyState = 1;
  s.remoteAddress = '127.0.0.1';
  s.messages = messages;
  s.sendUTF = (d: string | Buffer) => {
    messages.push(String(d));
  };
  s.send = (d: Parameters<MockSocket['send']>[0]) => {
    messages.push(String(d));
  };
  s.terminate = () => {};
  s.ttype = [];
  s.compressed = 0;
  s.req = asDouble<MockSocket['req']>()({
    headers: {},
    connection: { remoteAddress: '127.0.0.1' },
    url: '/',
    method: 'GET',
  });
  return s;
}

const integrations: SessionIntegration[] = [];
afterEach(() => {
  for (const i of integrations.splice(0)) i.shutdown();
});

/**
 * An integration whose dials never complete, so every connect stays in the
 * window between reservation handoff and the established count.
 */
function buildWithHangingDial(maxGlobal: number): SessionIntegration {
  const si = new SessionIntegration({
    sessions: {
      maxPerIP: 500,
      maxPerDevice: 500,
      maxGlobal,
      timeoutHours: 24,
    },
    targets: {
      targetMode: 'fixed',
      defaultHost: 'mud.example.org',
      defaultPort: 4000,
    },
  });
  integrations.push(si);

  const originalCreate = si.sessionManager.create.bind(si.sessionManager);
  si.sessionManager.create = asStub<typeof si.sessionManager.create>()(
    (...args: unknown[]) => {
      const session = originalCreate(
        ...asDouble<Parameters<typeof originalCreate>>()(args),
      );
      // Never resolves: the dial is permanently in flight.
      session.connect = () => new Promise<void>(() => {});
      return session;
    },
  );

  return si;
}

const connect = (si: SessionIntegration, s: MockSocket) =>
  si.parseNewMessage(
    s,
    Buffer.from(
      JSON.stringify({
        type: 'connect',
        host: 'mud.example.org',
        port: 4000,
      }),
    ),
  );

/** The error frames a mock client received, read only for their `type`. */
const errorFrameSchema = z.looseObject({ type: z.string().optional() });

const errorsOf = (s: MockSocket) =>
  s.messages
    .map((m) => errorFrameSchema.parse(JSON.parse(m)))
    .filter((m) => m.type === 'error');

describe('an in-flight dial still occupies capacity', () => {
  test('the reservation is held while the dial is outstanding', () => {
    const si = buildWithHangingDial(5);
    connect(si, makeSocket());

    // With the reservation dropped at session creation this reads 0, and the
    // dial is invisible to every subsequent capacity check.
    expect(si.sessionManager.globalPending()).toBe(1);
  });

  test('concurrent dials cannot exceed the global cap', async () => {
    const si = buildWithHangingDial(2);

    const sockets = [makeSocket(), makeSocket(), makeSocket()];
    for (const s of sockets) connect(si, s);
    await Bun.sleep(10);

    // The third must be refused: two dials are outstanding and neither has
    // completed, so neither has been counted as established yet.
    expect(errorsOf(sockets[2]).length).toBeGreaterThan(0);
    expect(JSON.stringify(errorsOf(sockets[2]))).toMatch(/capacity/i);

    expect(errorsOf(sockets[0]).length).toBe(0);
    expect(errorsOf(sockets[1]).length).toBe(0);
  });
});

/**
 * A dial that times out must return its capacity (MWP-127).
 *
 * The refused-connection path already released correctly. The gap was a
 * routable address that silently drops SYNs: nothing bounded the connect, so
 * the reservation was held for the OS retry budget — roughly two minutes.
 * Under TARGET_MODE=arbitrary the client picks the address, so that is a cheap
 * way to exhaust both the per-IP and global dimensions.
 *
 * Asserted against the integration rather than SessionManager, for the same
 * reason as the tests above: the counters were never wrong in isolation.
 */
describe('a timed-out dial releases its reservation', () => {
  test('capacity after repeated timeouts equals capacity before', async () => {
    const originalCreateConnection = net.createConnection;
    try {
      // A socket that connects to nothing and never errors — the black hole.
      net.createConnection = asStub<typeof net.createConnection>()(() => {
        const s = asDouble<BlackHoleSocket>()(new EventEmitter());
        s.destroy = () => {};
        s.off = () => s;
        s.once = () => s;
        return s;
      });

      const si = new SessionIntegration({
        sessions: { maxPerIP: 2, maxPerDevice: 5, timeoutHours: 24 },
        targets: {
          targetMode: 'fixed',
          defaultHost: 'mud.example.org',
          defaultPort: 4000,
        },
        mudTlsMode: 'plain',
        mudDialTimeoutMs: 20,
      });

      const before = si.sessionManager.pendingDials('127.0.0.1');

      for (let i = 0; i < 4; i++) {
        const socket = makeSocket();
        si.parseNewMessage(
          socket,
          Buffer.from(
            JSON.stringify({
              type: 'connect',
              host: 'mud.example.org',
              port: 4000,
            }),
          ),
        );
        await Bun.sleep(80);
      }

      // The decisive assertion: four black-holed dials, no capacity consumed.
      expect(si.sessionManager.pendingDials('127.0.0.1')).toBe(before);

      // And the budget is genuinely usable afterwards, not merely zeroed.
      expect(si.sessionManager.reservePendingDial('127.0.0.1').allowed).toBe(
        true,
      );
      si.shutdown();
    } finally {
      net.createConnection = originalCreateConnection;
    }
  }, 15000);
});
