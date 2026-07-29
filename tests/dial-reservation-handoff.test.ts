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

import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { SessionIntegration } from '../src/session-integration.js';
import type { SocketExtended } from '../src/types/index.js';

interface MockSocket extends SocketExtended {
  messages: string[];
}

function makeSocket(): MockSocket {
  const messages: string[] = [];
  const s = new EventEmitter() as MockSocket;
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
  s.req = {
    headers: {},
    connection: { remoteAddress: '127.0.0.1' },
    url: '/',
    method: 'GET',
  } as MockSocket['req'];
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
    } as never,
  });
  integrations.push(si);

  const originalCreate = si.sessionManager.create.bind(si.sessionManager);
  si.sessionManager.create = ((...args: unknown[]) => {
    const session = originalCreate(
      ...(args as Parameters<typeof originalCreate>),
    );
    // Never resolves: the dial is permanently in flight.
    session.connect = () => new Promise<void>(() => {});
    return session;
  }) as typeof si.sessionManager.create;

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

const errorsOf = (s: MockSocket) =>
  s.messages
    .map((m) => JSON.parse(m) as Record<string, unknown>)
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
