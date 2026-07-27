import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import { Session } from '../src/session.js';
import { SessionManager } from '../src/session-manager.js';
import type { TelnetSocket } from '../src/types/index.js';

class MockTelnetSocket extends EventEmitter {
  destroyed = false;
  written: Array<string | Buffer> = [];

  send(data: string | Buffer): void {
    this.write(data);
  }

  write(data: string | Buffer): boolean {
    this.written.push(data);
    return true;
  }

  end(): this {
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

interface SessionTestAccess {
  telnet: TelnetSocket | null;
  setupTelnetHandlers(onConnectError: (err: Error) => void): void;
}

const originalTlsConnect = tls.connect;
const originalCreateConnection = net.createConnection;

afterEach(() => {
  tls.connect = originalTlsConnect;
  net.createConnection = originalCreateConnection;
});

function asTelnetSocket(socket: MockTelnetSocket): TelnetSocket {
  return socket as unknown as TelnetSocket;
}

function installTelnetHandlers(
  session: Session,
  socket: MockTelnetSocket,
  onConnectError: (err: Error) => void = () => {},
): void {
  const sessionAccess = session as unknown as SessionTestAccess;
  sessionAccess.telnet = asTelnetSocket(socket);
  sessionAccess.setupTelnetHandlers(onConnectError);
}

function makeTcpError(code: 'ECONNREFUSED' | 'ECONNRESET'): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:4000`), {
    code,
  });
}

function installTlsError(error: Error): void {
  tls.connect = ((
    _port: number,
    _host: string,
    _options: tls.ConnectionOptions,
    _callback?: () => void,
  ) => {
    const socket = new MockTelnetSocket();
    queueMicrotask(() => {
      socket.emit('error', error);
    });
    return asTelnetSocket(socket);
  }) as typeof tls.connect;
}

function installTlsClose(): void {
  tls.connect = ((
    _port: number,
    _host: string,
    _options: tls.ConnectionOptions,
    _callback?: () => void,
  ) => {
    const socket = new MockTelnetSocket();
    queueMicrotask(() => {
      socket.emit('close');
    });
    return asTelnetSocket(socket);
  }) as typeof tls.connect;
}

describe('Session close observers', () => {
  test('preserves SessionManager cleanup when another close observer is added', () => {
    const manager = new SessionManager();
    const session = manager.create('mud.example.com', 4000);
    const socket = new MockTelnetSocket();
    let observerCalled = false;

    session.onClose(() => {
      observerCalled = true;
    });
    installTelnetHandlers(session, socket);

    socket.emit('close');

    expect(observerCalled).toBe(true);
    expect(manager.get(session.id)).toBeUndefined();

    manager.stop();
  });

  test('runs all close observers even when one observer throws', () => {
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      const session = new Session('mud.example.com', 4000);
      const socket = new MockTelnetSocket();
      let throwingObserverCalled = false;
      let laterObserverCalled = false;

      session.onClose(() => {
        throwingObserverCalled = true;
        throw new Error('close observer failed');
      });
      session.onClose(() => {
        laterObserverCalled = true;
      });
      installTelnetHandlers(session, socket);

      expect(() => socket.emit('close')).not.toThrow();
      expect(throwingObserverCalled).toBe(true);
      expect(laterObserverCalled).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe('Session TLS fallback classification', () => {
  test.each([
    ['ECONNREFUSED', makeTcpError('ECONNREFUSED')],
    ['ECONNRESET', makeTcpError('ECONNRESET')],
  ])(
    'does not fall back to plain TCP for generic %s',
    async (_name, error) => {
      const session = new Session('mud.example.com', 4000);
      let plainAttempts = 0;

      installTlsError(error);
      net.createConnection = ((
        _port: number,
        _host: string,
        _callback?: () => void,
      ) => {
        plainAttempts++;
        const socket = new MockTelnetSocket();
        queueMicrotask(() => {
          socket.emit('error', new Error('plain fallback was attempted'));
        });
        return asTelnetSocket(socket);
      }) as typeof net.createConnection;

      await expect(session.connect()).rejects.toThrow();
      expect(plainAttempts).toBe(0);
    },
  );

  test('falls back to plain TCP for TLS negotiation failures', async () => {
    const session = new Session('mud.example.com', 4000);
    let plainAttempts = 0;

    installTlsError(
      new Error('ssl3_get_record:wrong version number during TLS handshake'),
    );
    net.createConnection = ((
      _port: number,
      _host: string,
      callback?: () => void,
    ) => {
      plainAttempts++;
      const socket = new MockTelnetSocket();
      queueMicrotask(() => {
        callback?.();
      });
      return asTelnetSocket(socket);
    }) as typeof net.createConnection;

    await expect(session.connect()).resolves.toBeUndefined();
    expect(plainAttempts).toBe(1);
    expect(session.telnetConnected).toBe(true);
  });

  test('falls back to plain TCP when TLS probe closes before secure connect', async () => {
    const session = new Session('mud.example.com', 4000);
    let plainAttempts = 0;

    installTlsClose();
    net.createConnection = ((
      _port: number,
      _host: string,
      callback?: () => void,
    ) => {
      plainAttempts++;
      const socket = new MockTelnetSocket();
      queueMicrotask(() => {
        callback?.();
      });
      return asTelnetSocket(socket);
    }) as typeof net.createConnection;

    const connectResult = Promise.race([
      session.connect().then(() => 'connected'),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 100);
      }),
    ]);

    await expect(connectResult).resolves.toBe('connected');
    expect(plainAttempts).toBe(1);
    expect(session.telnetConnected).toBe(true);
  });
});
