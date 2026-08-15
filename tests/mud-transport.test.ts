import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import {
  connectMudTransport,
  describeTransportError,
  type ConnectedMudTransport,
} from '../src/mud-transport.js';
import type { TelnetSocket } from '../src/types/index.js';
import { asDouble, asStub } from './support/doubles';
import { toError } from '../src/error-text';

class TestSocket extends EventEmitter {
  destroyed = false;
  destroyCalls = 0;

  destroy(): this {
    this.destroyed = true;
    this.destroyCalls++;
    return this;
  }
}

const originalCreateConnection = net.createConnection;
const originalTlsConnect = tls.connect;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  net.createConnection = originalCreateConnection;
  tls.connect = originalTlsConnect;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

const asTelnetSocket = (socket: TestSocket): TelnetSocket =>
  asDouble<TelnetSocket>()(socket);

/** Distinct from the 4,000 ms handshake deadline so the two never collide. */
const DIAL_TIMEOUT_FOR_TESTS = 30_000;

/**
 * The handshake timers only. Since MWP-127 a dial timer is armed first on
 * every connect, so a bare view of every timer no longer isolates the
 * handshake deadline these tests are about.
 */
const handshakeOnly = (timers: {
  callbacks: Array<() => void>;
  delays: number[];
  handles: Array<ReturnType<typeof setTimeout>>;
}) => {
  const idx = timers.delays
    .map((d, i) => (d !== DIAL_TIMEOUT_FOR_TESTS ? i : -1))
    .filter((i) => i >= 0);
  return {
    callbacks: idx.map((i) => timers.callbacks[i]),
    delays: idx.map((i) => timers.delays[i]),
    handles: idx.map((i) => timers.handles[i]),
  };
};

const connectionOptions = (
  mode: 'plain' | 'prefer' | 'required',
  signal: AbortSignal,
  connected: ConnectedMudTransport[],
  downgrades: string[],
) => ({
  requestedHost: 'mud.example',
  dialAddress: '203.0.113.7',
  port: 4000,
  mode,
  signal,
  // Distinct from TLS_HANDSHAKE_TIMEOUT_MS so a test can always tell which
  // timer it is looking at. MWP-127 added a second one.
  dialTimeoutMs: DIAL_TIMEOUT_FOR_TESTS,
  onDowngrade: (reason: string) => downgrades.push(reason),
  onConnected: (connection: ConnectedMudTransport) =>
    connected.push(connection),
});

const observeRejection = (pending: Promise<void>) => {
  let rejection: Error | undefined;
  const observed = pending.catch((cause: unknown) => {
    rejection = toError(cause);
  });

  return {
    get rejection(): Error | undefined {
      return rejection;
    },
    observed,
  };
};

const installTimerStubs = () => {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const handles: Array<ReturnType<typeof setTimeout>> = [];
  const cleared: Array<ReturnType<typeof setTimeout>> = [];

  globalThis.setTimeout = asStub<typeof setTimeout>()(
    (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      callbacks.push(() => callback(...args));
      delays.push(delay ?? 0);
      const handle = asDouble<ReturnType<typeof setTimeout>>()(
        callbacks.length,
      );
      handles.push(handle);
      return handle;
    },
  );
  globalThis.clearTimeout = asStub<typeof clearTimeout>()(
    (handle: ReturnType<typeof setTimeout>) => {
      cleared.push(handle);
    },
  );

  return { callbacks, cleared, delays, handles };
};

describe('connectMudTransport success paths', () => {
  test('plain connects over TCP and hands off the emitted socket', async () => {
    const socket = new TestSocket();
    const plainCalls: Array<[number, string]> = [];
    let tlsCalls = 0;
    net.createConnection = asStub<typeof net.createConnection>()(
      (port: number, host: string) => {
        plainCalls.push([port, host]);
        return asTelnetSocket(socket);
      },
    );
    tls.connect = asStub<typeof tls.connect>()(
      (_port: number, _host: string, _options: tls.ConnectionOptions) => {
        tlsCalls++;
        return asTelnetSocket(new TestSocket());
      },
    );

    const controller = new AbortController();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];

    const pending = connectMudTransport({
      requestedHost: 'mud.example',
      dialAddress: '203.0.113.7',
      port: 4000,
      mode: 'plain',
      signal: controller.signal,
      onDowngrade: (reason) => downgrades.push(reason),
      onConnected: (connection) => connected.push(connection),
    });

    expect(plainCalls).toEqual([[4000, '203.0.113.7']]);
    expect(tlsCalls).toBe(0);
    expect(downgrades).toEqual([]);

    socket.emit('connect');
    await pending;

    expect(connected).toHaveLength(1);
    expect(connected[0]?.socket).toBe(asTelnetSocket(socket));
    expect(connected[0]).toEqual({
      socket: asTelnetSocket(socket),
      transport: 'plain',
      downgraded: false,
    });
  });

  test('prefer waits for a secure TLS connection before handoff', async () => {
    const socket = new TestSocket();
    let plainCalls = 0;
    let tlsCalls = 0;
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(new TestSocket());
      },
    );
    tls.connect = asStub<typeof tls.connect>()(
      (_port: number, _host: string, _options: tls.ConnectionOptions) => {
        tlsCalls++;
        return asTelnetSocket(socket);
      },
    );

    const controller = new AbortController();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];

    const pending = connectMudTransport({
      requestedHost: 'mud.example',
      dialAddress: '203.0.113.7',
      port: 4000,
      mode: 'prefer',
      signal: controller.signal,
      onDowngrade: (reason) => downgrades.push(reason),
      onConnected: (connection) => connected.push(connection),
    });

    expect(plainCalls).toBe(0);
    expect(tlsCalls).toBe(1);
    expect(connected).toEqual([]);
    expect(downgrades).toEqual([]);

    socket.emit('secureConnect');
    await pending;

    expect(connected).toHaveLength(1);
    expect(connected[0]?.socket).toBe(asTelnetSocket(socket));
    expect(connected[0]).toEqual({
      socket: asTelnetSocket(socket),
      transport: 'tls',
      downgraded: false,
    });
  });

  test('TLS dials the validated address and sends SNI for the requested host', async () => {
    const socket = new TestSocket();
    const tlsCalls: Array<[number, string, tls.ConnectionOptions]> = [];
    tls.connect = asStub<typeof tls.connect>()(
      (port: number, host: string, options: tls.ConnectionOptions) => {
        tlsCalls.push([port, host, options]);
        return asTelnetSocket(socket);
      },
    );

    const controller = new AbortController();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];

    const pending = connectMudTransport({
      requestedHost: 'mud.example',
      dialAddress: '203.0.113.7',
      port: 4000,
      mode: 'prefer',
      signal: controller.signal,
      onDowngrade: (reason) => downgrades.push(reason),
      onConnected: (connection) => connected.push(connection),
    });

    expect(tlsCalls).toEqual([
      [4000, '203.0.113.7', { servername: 'mud.example' }],
    ]);

    socket.emit('secureConnect');
    await pending;
    expect(connected).toHaveLength(1);
    expect(downgrades).toEqual([]);
  });
});

describe('connectMudTransport TLS fallback', () => {
  test('prefer destroys TLS and falls back exactly once after a classified error', async () => {
    const tlsSocket = new TestSocket();
    const plainSocket = new TestSocket();
    const plainCalls: Array<[number, string]> = [];
    const tlsCalls: Array<[number, string]> = [];
    const destructionBeforePlainDial: boolean[] = [];
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    tlsSocket.on('error', () => undefined);

    net.createConnection = asStub<typeof net.createConnection>()(
      (port: number, host: string) => {
        destructionBeforePlainDial.push(tlsSocket.destroyed);
        plainCalls.push([port, host]);
        return asTelnetSocket(plainSocket);
      },
    );
    tls.connect = asStub<typeof tls.connect>()(
      (port: number, host: string) => {
        tlsCalls.push([port, host]);
        return asTelnetSocket(tlsSocket);
      },
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );
    const tlsError = Object.assign(new Error('wrong version number'), {
      code: 'EPROTO',
    });

    tlsSocket.emit('error', tlsError);
    tlsSocket.emit('close');
    tlsSocket.emit('error', tlsError);
    tlsSocket.emit('close');

    expect(tlsCalls).toEqual([[4000, '203.0.113.7']]);
    expect(plainCalls).toEqual([[4000, '203.0.113.7']]);
    expect(destructionBeforePlainDial).toEqual([true]);
    expect(tlsSocket.destroyCalls).toBe(1);
    expect(downgrades).toHaveLength(1);
    expect(connected).toEqual([]);

    plainSocket.emit('connect');
    await pending;

    expect(connected).toEqual([
      {
        socket: asTelnetSocket(plainSocket),
        transport: 'plain',
        downgraded: true,
      },
    ]);
    plainSocket.emit('connect');
    expect(connected).toHaveLength(1);
  });

  test('throwing onDowngrade rejects without opening plaintext', async () => {
    const tlsSocket = new TestSocket();
    const callbackError = new Error('downgrade callback failed');
    let plainCalls = 0;
    let downgradeCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    tlsSocket.on('error', () => undefined);
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(new TestSocket());
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport({
      requestedHost: 'mud.example',
      dialAddress: '203.0.113.7',
      port: 4000,
      mode: 'prefer',
      signal: controller.signal,
      onDowngrade: () => {
        downgradeCalls++;
        throw callbackError;
      },
      onConnected: (connection) => connected.push(connection),
    });
    const observation = observeRejection(pending);
    const tlsError = new Error('wrong version number');

    expect(() => tlsSocket.emit('error', tlsError)).not.toThrow();
    tlsSocket.emit('close');
    tlsSocket.emit('error', tlsError);
    tlsSocket.emit('close');
    controller.abort();
    await Promise.resolve();

    expect(observation.rejection).toBe(callbackError);
    expect(tlsSocket.destroyed).toBe(true);
    expect(plainCalls).toBe(0);
    expect(downgradeCalls).toBe(1);
    expect(connected).toEqual([]);
    await observation.observed;
  });

  test('prefer falls back exactly once after close before secureConnect', async () => {
    const tlsSocket = new TestSocket();
    const plainSocket = new TestSocket();
    let plainCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(plainSocket);
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );

    tlsSocket.emit('close');
    tlsSocket.emit('close');

    expect(plainCalls).toBe(1);
    expect(tlsSocket.destroyCalls).toBe(1);
    expect(downgrades).toHaveLength(1);

    plainSocket.emit('connect');
    await pending;
    expect(connected).toEqual([
      {
        socket: asTelnetSocket(plainSocket),
        transport: 'plain',
        downgraded: true,
      },
    ]);
  });

  test('special Node pre-handshake ECONNRESET diagnostic falls back', async () => {
    const tlsSocket = new TestSocket();
    const plainSocket = new TestSocket();
    let plainCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    tlsSocket.on('error', () => undefined);
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(plainSocket);
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );
    const reset = Object.assign(
      new Error(
        'Client network socket disconnected before secure TLS connection was established',
      ),
      { code: 'ECONNRESET' },
    );

    tlsSocket.emit('error', reset);

    expect(plainCalls).toBe(1);
    expect(downgrades).toHaveLength(1);
    plainSocket.emit('connect');
    await pending;
    expect(connected).toHaveLength(1);
  });

  for (const code of [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ]) {
    test(`prefer rejects ordinary ${code} without plaintext fallback`, async () => {
      const tlsSocket = new TestSocket();
      let plainCalls = 0;
      const connected: ConnectedMudTransport[] = [];
      const downgrades: string[] = [];
      net.createConnection = asStub<typeof net.createConnection>()(
        (_port: number, _host: string) => {
          plainCalls++;
          return asTelnetSocket(new TestSocket());
        },
      );
      tls.connect = asStub<typeof tls.connect>()(() =>
        asTelnetSocket(tlsSocket),
      );

      const controller = new AbortController();
      const pending = connectMudTransport(
        connectionOptions('prefer', controller.signal, connected, downgrades),
      );
      const observation = observeRejection(pending);
      const transportError = Object.assign(new Error(`dial ${code}`), {
        code,
      });

      tlsSocket.emit('error', transportError);
      await Promise.resolve();

      expect(observation.rejection).toBe(transportError);
      expect(plainCalls).toBe(0);
      expect(downgrades).toEqual([]);
      expect(connected).toEqual([]);
      await observation.observed;
    });
  }

  test('fallback plain failure rejects and cannot start a third dial', async () => {
    const tlsSocket = new TestSocket();
    const plainSocket = new TestSocket();
    let plainCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    tlsSocket.on('error', () => undefined);
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(plainSocket);
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);
    const tlsError = new Error('wrong version number');
    const plainError = Object.assign(new Error('plain refused'), {
      code: 'ECONNREFUSED',
    });

    tlsSocket.emit('error', tlsError);
    plainSocket.emit('error', plainError);
    plainSocket.emit('close');
    tlsSocket.emit('close');
    await Promise.resolve();

    expect(observation.rejection).toBe(plainError);
    expect(plainCalls).toBe(1);
    expect(downgrades).toHaveLength(1);
    expect(connected).toEqual([]);
    await observation.observed;
  });
});

describe('connectMudTransport required policy', () => {
  test('required wraps TLS errors and never dials plaintext', async () => {
    const tlsSocket = new TestSocket();
    let plainCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(new TestSocket());
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('required', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);
    const tlsError = new Error('certificate has expired');

    tlsSocket.emit('error', tlsError);
    await Promise.resolve();

    expect(observation.rejection?.message).toBe(
      'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.',
    );
    expect(observation.rejection?.cause).toBe(tlsError);
    expect(plainCalls).toBe(0);
    expect(downgrades).toEqual([]);
    expect(connected).toEqual([]);
    await observation.observed;
  });

  test('required wraps pre-handshake close and never dials plaintext', async () => {
    const tlsSocket = new TestSocket();
    let plainCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(new TestSocket());
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('required', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);

    tlsSocket.emit('close');
    await Promise.resolve();

    expect(observation.rejection?.message).toBe(
      'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.',
    );
    expect(observation.rejection?.cause).toBeUndefined();
    expect(plainCalls).toBe(0);
    expect(downgrades).toEqual([]);
    expect(connected).toEqual([]);
    await observation.observed;
  });
});

describe('connectMudTransport TLS handshake deadline', () => {
  test('handshake timer starts on TCP connect and secureConnect clears it', async () => {
    const timers = installTimerStubs();
    const tlsSocket = new TestSocket();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );

    expect(handshakeOnly(timers).callbacks).toHaveLength(0);
    expect(handshakeOnly(timers).delays).toEqual([]);

    tlsSocket.emit('connect');
    tlsSocket.emit('connect');

    expect(handshakeOnly(timers).callbacks).toHaveLength(1);
    expect(handshakeOnly(timers).delays).toEqual([4_000]);

    tlsSocket.emit('secureConnect');
    await pending;

    const hsHandle = handshakeOnly(timers).handles[0];
    expect(timers.cleared.filter((h) => h === hsHandle)).toHaveLength(1);
    expect(connected).toHaveLength(1);
    expect(downgrades).toEqual([]);
  });

  test('prefer handshake deadline falls back exactly once', async () => {
    const timers = installTimerStubs();
    const tlsSocket = new TestSocket();
    const plainSocket = new TestSocket();
    let plainCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(plainSocket);
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );

    expect(handshakeOnly(timers).callbacks).toHaveLength(0);
    tlsSocket.emit('connect');
    expect(handshakeOnly(timers).delays).toEqual([4_000]);

    handshakeOnly(timers).callbacks[0]?.();
    handshakeOnly(timers).callbacks[0]?.();

    const hsHandle = handshakeOnly(timers).handles[0];
    expect(timers.cleared.filter((h) => h === hsHandle)).toHaveLength(1);
    expect(tlsSocket.destroyCalls).toBe(1);
    expect(plainCalls).toBe(1);
    expect(downgrades).toHaveLength(1);
    expect(connected).toEqual([]);

    plainSocket.emit('connect');
    await pending;
    expect(connected).toEqual([
      {
        socket: asTelnetSocket(plainSocket),
        transport: 'plain',
        downgraded: true,
      },
    ]);
  });

  test('required handshake deadline rejects with stable policy text', async () => {
    const timers = installTimerStubs();
    const tlsSocket = new TestSocket();
    let plainCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(new TestSocket());
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('required', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);

    expect(handshakeOnly(timers).callbacks).toHaveLength(0);
    tlsSocket.emit('connect');
    expect(handshakeOnly(timers).delays).toEqual([4_000]);
    handshakeOnly(timers).callbacks[0]?.();
    await Promise.resolve();

    expect(observation.rejection?.message).toBe(
      'MUD_TLS_MODE=required: TLS handshake timed out after 4000ms and plaintext fallback is not permitted.',
    );
    const hsHandle = handshakeOnly(timers).handles[0];
    expect(timers.cleared.filter((h) => h === hsHandle)).toHaveLength(1);
    expect(tlsSocket.destroyCalls).toBe(1);
    expect(plainCalls).toBe(0);
    expect(downgrades).toEqual([]);
    expect(connected).toEqual([]);
    await observation.observed;
  });

  test('handshake timer is cleared on TLS error', async () => {
    const timers = installTimerStubs();
    const tlsSocket = new TestSocket();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);
    const transportError = Object.assign(new Error('dial refused'), {
      code: 'ECONNREFUSED',
    });

    tlsSocket.emit('connect');
    tlsSocket.emit('error', transportError);
    await Promise.resolve();

    const hsHandle = handshakeOnly(timers).handles[0];
    expect(timers.cleared.filter((h) => h === hsHandle)).toHaveLength(1);
    expect(observation.rejection).toBe(transportError);
    await observation.observed;
  });

  test('handshake timer is cleared on pre-handshake close', async () => {
    const timers = installTimerStubs();
    const tlsSocket = new TestSocket();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('required', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);

    tlsSocket.emit('connect');
    tlsSocket.emit('close');
    await Promise.resolve();

    const hsHandle = handshakeOnly(timers).handles[0];
    expect(timers.cleared.filter((h) => h === hsHandle)).toHaveLength(1);
    expect(observation.rejection?.message).toBe(
      'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.',
    );
    await observation.observed;
  });
});

describe('connectMudTransport abort and callback ownership', () => {
  test('already-aborted signal rejects without any dial', async () => {
    let plainCalls = 0;
    let tlsCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(new TestSocket());
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() => {
      tlsCalls++;
      return asTelnetSocket(new TestSocket());
    });

    const controller = new AbortController();
    controller.abort();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);

    await Promise.resolve();

    expect(observation.rejection?.message).toBe(
      'MUD transport connection aborted',
    );
    expect(tlsCalls).toBe(0);
    expect(plainCalls).toBe(0);
    expect(downgrades).toEqual([]);
    expect(connected).toEqual([]);
    await observation.observed;
  });

  test('abort during provisional TLS destroys it and suppresses fallback and handoff', async () => {
    const timers = installTimerStubs();
    const tlsSocket = new TestSocket();
    let plainCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    tlsSocket.on('error', () => undefined);
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(new TestSocket());
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);

    tlsSocket.emit('connect');
    controller.abort();
    tlsSocket.emit('error', new Error('wrong version number'));
    tlsSocket.emit('close');
    tlsSocket.emit('secureConnect');
    handshakeOnly(timers).callbacks[0]?.();
    await Promise.resolve();

    expect(observation.rejection?.message).toBe(
      'MUD transport connection aborted',
    );
    expect(tlsSocket.destroyCalls).toBe(1);
    const hsHandle = handshakeOnly(timers).handles[0];
    expect(timers.cleared.filter((h) => h === hsHandle)).toHaveLength(1);
    expect(plainCalls).toBe(0);
    expect(downgrades).toEqual([]);
    expect(connected).toEqual([]);
    await observation.observed;
  });

  test('abort during provisional plain connection destroys it without handoff', async () => {
    const plainSocket = new TestSocket();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    net.createConnection = asStub<typeof net.createConnection>()(() =>
      asTelnetSocket(plainSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('plain', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);

    controller.abort();
    plainSocket.emit('connect');
    await Promise.resolve();

    expect(observation.rejection?.message).toBe(
      'MUD transport connection aborted',
    );
    expect(plainSocket.destroyCalls).toBe(1);
    expect(connected).toEqual([]);
    expect(downgrades).toEqual([]);
    await observation.observed;
  });

  test('abort during provisional fallback keeps both attempts bounded', async () => {
    const tlsSocket = new TestSocket();
    const plainSocket = new TestSocket();
    let tlsCalls = 0;
    let plainCalls = 0;
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    tlsSocket.on('error', () => undefined);
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainCalls++;
        return asTelnetSocket(plainSocket);
      },
    );
    tls.connect = asStub<typeof tls.connect>()(() => {
      tlsCalls++;
      return asTelnetSocket(tlsSocket);
    });

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );
    const observation = observeRejection(pending);

    tlsSocket.emit('error', new Error('wrong version number'));
    controller.abort();
    plainSocket.emit('connect');
    tlsSocket.emit('close');
    await Promise.resolve();

    expect(observation.rejection?.message).toBe(
      'MUD transport connection aborted',
    );
    expect(tlsCalls).toBe(1);
    expect(plainCalls).toBe(1);
    expect(tlsSocket.destroyCalls).toBe(1);
    expect(plainSocket.destroyCalls).toBe(1);
    expect(downgrades).toHaveLength(1);
    expect(connected).toEqual([]);
    await observation.observed;
  });

  test('onConnected throws destroys the final socket and rejects with that error', async () => {
    const plainSocket = new TestSocket();
    const callbackError = new Error('handoff failed');
    let callbackCalls = 0;
    const downgrades: string[] = [];
    net.createConnection = asStub<typeof net.createConnection>()(() =>
      asTelnetSocket(plainSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport({
      requestedHost: 'mud.example',
      dialAddress: '203.0.113.7',
      port: 4000,
      mode: 'plain',
      signal: controller.signal,
      onDowngrade: (reason) => downgrades.push(reason),
      onConnected: () => {
        callbackCalls++;
        throw callbackError;
      },
    });
    const observation = observeRejection(pending);

    expect(() => plainSocket.emit('connect')).not.toThrow();
    await Promise.resolve();

    expect(observation.rejection).toBe(callbackError);
    expect(callbackCalls).toBe(1);
    expect(plainSocket.destroyCalls).toBe(1);
    expect(downgrades).toEqual([]);
    await observation.observed;
  });

  test('abort after successful handoff does not destroy the final socket', async () => {
    const tlsSocket = new TestSocket();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    tls.connect = asStub<typeof tls.connect>()(() =>
      asTelnetSocket(tlsSocket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport(
      connectionOptions('prefer', controller.signal, connected, downgrades),
    );

    tlsSocket.emit('secureConnect');
    await pending;
    controller.abort();

    expect(tlsSocket.destroyCalls).toBe(0);
    expect(connected).toHaveLength(1);
    expect(downgrades).toEqual([]);
  });
});

describe('describeTransportError', () => {
  // required mode replaces the underlying error with stable policy text so the
  // player never sees a Node TLS diagnostic. That text alone cannot be
  // debugged: "TLS connection failed" reads identically for a refused port and
  // for an expired certificate. The log has to carry both.
  test('appends the cause when a policy error wraps one', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:4000');
    const wrapped = new Error(
      'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.',
      { cause },
    );

    expect(describeTransportError(wrapped)).toBe(
      'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted. (connect ECONNREFUSED 127.0.0.1:4000)',
    );
  });

  test('returns the message alone when there is no cause', () => {
    expect(describeTransportError(new Error('plain failure'))).toBe(
      'plain failure',
    );
  });

  test('ignores a non-Error cause rather than printing [object Object]', () => {
    const wrapped = new Error('policy text', { cause: { code: 'NOPE' } });
    expect(describeTransportError(wrapped)).toBe('policy text');
  });

  test('accepts a thrown non-Error', () => {
    expect(describeTransportError('just a string')).toBe('just a string');
  });
});

/**
 * MWP-127. Nothing bounded how long a dial could take. A refused connection
 * fails fast, but a routable target that silently drops SYNs hangs until the
 * OS retry budget runs out — roughly two minutes on Linux.
 *
 * That is a capacity problem, not just a slow request: an in-flight dial holds
 * a reservation in both the per-IP and global dimensions (MWP-92), and under
 * TARGET_MODE=arbitrary the client picks the address. One cheap WebSocket
 * frame buys two minutes of held capacity.
 *
 * The issue predates MWP-135 and says to fix this in Session.connect(). That
 * would only cover typed sessions; dialling now lives here, so bounding it
 * here covers the legacy protocol too.
 */
describe('dial timeout', () => {
  test('a silent plain dial is abandoned at the deadline', async () => {
    const socket = new TestSocket(); // never emits connect
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    let armed: number | undefined;
    globalThis.setTimeout = asStub<typeof setTimeout>()(
      (fn: () => void, ms?: number) => {
        if (armed === undefined) armed = ms;
        return asDouble<ReturnType<typeof setTimeout>>()({ unref() {} });
      },
    );
    let fire: (() => void) | undefined;
    globalThis.setTimeout = asStub<typeof setTimeout>()(
      (fn: () => void, ms?: number) => {
        if (armed === undefined) {
          armed = ms;
          fire = fn;
        }
        return asDouble<ReturnType<typeof setTimeout>>()({ unref() {} });
      },
    );

    net.createConnection = asStub<typeof net.createConnection>()(() =>
      asTelnetSocket(socket),
    );

    const controller = new AbortController();
    const pending = connectMudTransport({
      ...connectionOptions('plain', controller.signal, connected, downgrades),
      dialTimeoutMs: 10_000,
    });

    expect(armed).toBe(10_000);
    fire?.();

    await expect(pending).rejects.toThrow(/dial.*timed out|timed out/i);
    expect(socket.destroyCalls).toBeGreaterThan(0);
    expect(connected).toHaveLength(0);
  });

  test('a dial that connects in time clears the deadline', async () => {
    const socket = new TestSocket();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];
    let cleared = 0;
    globalThis.clearTimeout = asStub<typeof clearTimeout>()(() => {
      cleared++;
    });

    net.createConnection = asStub<typeof net.createConnection>()(() =>
      asTelnetSocket(socket),
    );
    const controller = new AbortController();
    const pending = connectMudTransport({
      ...connectionOptions('plain', controller.signal, connected, downgrades),
      dialTimeoutMs: 10_000,
    });

    socket.emit('connect');
    await pending;

    expect(connected).toHaveLength(1);
    expect(cleared).toBeGreaterThan(0);
    expect(socket.destroyCalls).toBe(0);
  });
});
