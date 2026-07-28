/**
 * Reserved-network rejection on the connect path (second half of MWP-88).
 *
 * `resolveTargetAddress` existed and was tested, but nothing called it when
 * dialling — so arbitrary mode enforced ports and not reserved networks. This
 * covers the wiring: policy check, then resolution, then dial the address that
 * was validated rather than the name that was requested.
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
  s.sendUTF = (data: string | Buffer) => {
    messages.push(String(data));
  };
  s.send = (data: Parameters<MockSocket['send']>[0]) => {
    messages.push(String(data));
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

const lastMsg = (s: MockSocket): Record<string, unknown> => {
  const raw = s.messages.at(-1);
  if (!raw) throw new Error('socket has no messages');
  return JSON.parse(raw) as Record<string, unknown>;
};

const integrations: SessionIntegration[] = [];
afterEach(() => {
  for (const i of integrations.splice(0)) i.shutdown();
});

function build(
  targets: Record<string, unknown>,
  resolveTarget?: SessionIntegration['config']['resolveTarget'],
): SessionIntegration {
  const si = new SessionIntegration({
    sessions: { maxPerIP: 100, maxPerDevice: 100, timeoutHours: 24 },
    targets: targets as never,
    resolveTarget,
  });
  integrations.push(si);
  return si;
}

const connect = (si: SessionIntegration, s: MockSocket, host: string, port: number) =>
  si.parseNewMessage(
    s,
    Buffer.from(JSON.stringify({ type: 'connect', host, port })),
  );

const ARBITRARY = {
  targetMode: 'arbitrary',
  defaultHost: 'mud.example.org',
  defaultPort: 4000,
  arbitraryAllowedPorts: ['23', '4000-4100'],
};

describe('arbitrary mode resolves before dialling', () => {
  test('refuses a hostname resolving to a reserved address', async () => {
    const si = build(ARBITRARY, async () => ({
      allowed: false,
      reason: 'Target resolves to a reserved network',
    }));

    const socket = makeSocket();
    connect(si, socket, 'evil.example', 4000);
    await Bun.sleep(10);

    expect(lastMsg(socket)).toMatchObject({ type: 'error' });
    // The policy allowed the port; only resolution refused it.
    expect(JSON.stringify(lastMsg(socket))).toMatch(/reserved/i);
  });

  test('refuses when resolution fails', async () => {
    const si = build(ARBITRARY, async () => ({
      allowed: false,
      reason: 'Target hostname could not be resolved',
    }));

    const socket = makeSocket();
    connect(si, socket, 'broken.example', 4000);
    await Bun.sleep(10);

    expect(lastMsg(socket)).toMatchObject({ type: 'error' });
  });

  test('dials the validated address, not the requested name', async () => {
    let dialled: string | undefined;
    const si = build(ARBITRARY, async () => ({
      allowed: true,
      address: '203.0.113.10',
    }));
    // Capture what the session was told to dial.
    const originalCreate = si.sessionManager.create.bind(si.sessionManager);
    si.sessionManager.create = ((...args: unknown[]) => {
      const session = originalCreate(...(args as Parameters<typeof originalCreate>));
      dialled = session.dialAddress;
      return session;
    }) as typeof si.sessionManager.create;

    const socket = makeSocket();
    connect(si, socket, 'good.example', 4000);
    await Bun.sleep(10);

    expect(dialled).toBe('203.0.113.10');
  });

  test('rejects a port outside the range before resolving at all', async () => {
    let called = false;
    const si = build(ARBITRARY, async () => {
      called = true;
      return { allowed: true, address: '203.0.113.10' };
    });

    const socket = makeSocket();
    connect(si, socket, 'good.example', 22);
    await Bun.sleep(10);

    expect(lastMsg(socket)).toMatchObject({ type: 'error' });
    // Cheapest check first: no DNS work for a port we were never going to allow.
    expect(called).toBe(false);
  });
});

describe('other modes do not resolve', () => {
  test('fixed mode never calls the resolver', async () => {
    let called = false;
    const si = build(
      { targetMode: 'fixed', defaultHost: 'mud.example.org', defaultPort: 4000 },
      async () => {
        called = true;
        return { allowed: true, address: '203.0.113.10' };
      },
    );

    const socket = makeSocket();
    connect(si, socket, 'mud.example.org', 4000);
    await Bun.sleep(10);

    expect(called).toBe(false);
  });

  test('allowlist mode never calls the resolver, so a listed private target still works', async () => {
    // An exact operator-configured entry may name a private address
    // deliberately; that distinction is the whole point of the mode.
    let called = false;
    const si = build(
      {
        targetMode: 'allowlist',
        defaultHost: 'mud.example.org',
        defaultPort: 4000,
        allowedTargets: ['10.0.0.5:23'],
      },
      async () => {
        called = true;
        return { allowed: false, reason: 'reserved' };
      },
    );

    const socket = makeSocket();
    connect(si, socket, '10.0.0.5', 23);
    await Bun.sleep(10);

    expect(called).toBe(false);
    expect(lastMsg(socket)).toMatchObject({ type: 'session' });
  });
});
