import { asStub } from './support/doubles';
import { asDouble } from './support/doubles';
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
  setupTelnetHandlers(): void;
}

const originalTlsConnect = tls.connect;
const originalCreateConnection = net.createConnection;

afterEach(() => {
  tls.connect = originalTlsConnect;
  net.createConnection = originalCreateConnection;
});

function asTelnetSocket(socket: MockTelnetSocket): TelnetSocket {
  return asDouble<TelnetSocket>()(socket);
}

function installTelnetHandlers(
  session: Session,
  socket: MockTelnetSocket,
): void {
  const sessionAccess = asDouble<SessionTestAccess>()(session);
  sessionAccess.telnet = asTelnetSocket(socket);
  sessionAccess.setupTelnetHandlers();
}

function makeTcpError(code: 'ECONNREFUSED' | 'ECONNRESET'): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:4000`), {
    code,
  });
}

function installTlsError(error: Error): void {
  tls.connect = asStub<typeof tls.connect>()(
    (
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
    },
  );
}

function installTlsClose(): void {
  tls.connect = asStub<typeof tls.connect>()(
    (
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
    },
  );
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
      net.createConnection = asStub<typeof net.createConnection>()(
        (_port: number, _host: string, _callback?: () => void) => {
          plainAttempts++;
          const socket = new MockTelnetSocket();
          queueMicrotask(() => {
            socket.emit('error', new Error('plain fallback was attempted'));
          });
          return asTelnetSocket(socket);
        },
      );

      await expect(session.connect()).rejects.toThrow();
      expect(plainAttempts).toBe(0);
    },
  );

  test('falls back to plain TCP for TLS negotiation failures', async () => {
    const session = new Session('mud.example.com', 4000);
    const plainSocket = new MockTelnetSocket();
    let plainAttempts = 0;

    installTlsError(
      new Error('ssl3_get_record:wrong version number during TLS handshake'),
    );
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainAttempts++;
        queueMicrotask(() => {
          plainSocket.emit('connect');
        });
        return asTelnetSocket(plainSocket);
      },
    );

    await expect(session.connect()).resolves.toBeUndefined();
    expect(plainAttempts).toBe(1);
    expect(session.telnet).toBe(asTelnetSocket(plainSocket));
    expect(session.telnetConnected).toBe(true);
    expect(session.tlsDowngraded).toBe(true);
  });

  test('falls back to plain TCP when TLS probe closes before secure connect', async () => {
    const session = new Session('mud.example.com', 4000);
    const plainSocket = new MockTelnetSocket();
    let plainAttempts = 0;

    installTlsClose();
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainAttempts++;
        queueMicrotask(() => {
          plainSocket.emit('connect');
        });
        return asTelnetSocket(plainSocket);
      },
    );

    const connectResult = Promise.race([
      session.connect().then(() => 'connected'),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 100);
      }),
    ]);

    await expect(connectResult).resolves.toBe('connected');
    expect(plainAttempts).toBe(1);
    expect(session.telnet).toBe(asTelnetSocket(plainSocket));
    expect(session.telnetConnected).toBe(true);
    expect(session.tlsDowngraded).toBe(true);
  });

  test('hands off a secure socket with its final lifecycle handlers', async () => {
    const session = new Session('mud.example.com', 4000);
    const tlsSocket = new MockTelnetSocket();
    const data: Buffer[] = [];
    const errors: Error[] = [];
    let closed = false;

    tls.connect = asStub<typeof tls.connect>()(
      (_port: number, _host: string, _options: tls.ConnectionOptions) =>
        asTelnetSocket(tlsSocket),
    );
    session.onData((chunk) => data.push(chunk));
    session.onError((error) => errors.push(error));
    session.onClose(() => {
      closed = true;
    });

    const pending = session.connect();
    tlsSocket.emit('secureConnect');
    await expect(pending).resolves.toBeUndefined();

    expect(session.telnet).toBe(asTelnetSocket(tlsSocket));
    expect(session.telnetConnected).toBe(true);
    expect(session.tlsDowngraded).toBe(false);

    const received = Buffer.from('hello');
    const socketError = new Error('post-handoff socket error');
    tlsSocket.emit('data', received);
    tlsSocket.emit('error', socketError);
    tlsSocket.emit('close');

    expect(data).toEqual([received]);
    expect(errors).toEqual([socketError]);
    expect(closed).toBe(true);
    expect(session.telnetConnected).toBe(false);
  });

  test('aborts a stalled TLS attempt without opening a plaintext fallback', async () => {
    const session = new Session(
      'mud.example.com',
      4000,
      undefined,
      undefined,
      'prefer',
    );
    const tlsSocket = new MockTelnetSocket();
    let plainAttempts = 0;

    tls.connect = asStub<typeof tls.connect>()(
      (_port: number, _host: string, _options: tls.ConnectionOptions) =>
        asTelnetSocket(tlsSocket),
    );
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string, _callback?: () => void) => {
        plainAttempts++;
        return asTelnetSocket(new MockTelnetSocket());
      },
    );

    const pending = session.connect();
    session.close();

    expect(tlsSocket.destroyed).toBe(true);
    await expect(pending).rejects.toThrow('MUD transport connection aborted');
    expect(plainAttempts).toBe(0);
  });

  test('aborts the previous stalled connect before replacing it', async () => {
    const session = new Session('mud.example.com', 4000);
    const firstSocket = new MockTelnetSocket();
    const replacementSocket = new MockTelnetSocket();
    const sockets = [firstSocket, replacementSocket];
    let tlsAttempts = 0;

    tls.connect = asStub<typeof tls.connect>()(
      (_port: number, _host: string, _options: tls.ConnectionOptions) => {
        const socket = sockets[tlsAttempts];
        tlsAttempts++;
        return asTelnetSocket(socket!);
      },
    );

    const first = session.connect();
    const firstResult = first.then(
      () => undefined,
      (error: Error) => error,
    );
    const replacement = session.connect();

    expect(firstSocket.destroyed).toBe(true);
    await expect(firstResult).resolves.toMatchObject({
      message: 'MUD transport connection aborted',
    });

    firstSocket.emit('secureConnect');
    expect(session.telnet).toBeNull();
    expect(session.telnetConnected).toBe(false);

    replacementSocket.emit('secureConnect');
    await expect(replacement).resolves.toBeUndefined();
    expect(session.telnet).toBe(asTelnetSocket(replacementSocket));
    expect(session.telnetConnected).toBe(true);
  });

  test('close aborts both a replaced and replacement stalled connect', async () => {
    const session = new Session('mud.example.com', 4000);
    const firstSocket = new MockTelnetSocket();
    const replacementSocket = new MockTelnetSocket();
    const sockets = [firstSocket, replacementSocket];
    let tlsAttempts = 0;
    let plainAttempts = 0;

    tls.connect = asStub<typeof tls.connect>()(
      (_port: number, _host: string, _options: tls.ConnectionOptions) => {
        const socket = sockets[tlsAttempts];
        tlsAttempts++;
        return asTelnetSocket(socket!);
      },
    );
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainAttempts++;
        return asTelnetSocket(new MockTelnetSocket());
      },
    );

    const first = session.connect();
    const replacement = session.connect();
    const settledPromise = Promise.allSettled([first, replacement]);
    session.close();

    expect(firstSocket.destroyed).toBe(true);
    expect(replacementSocket.destroyed).toBe(true);

    const settled = await Promise.race([
      settledPromise,
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), 100);
      }),
    ]);

    expect(settled).toBeDefined();
    if (!settled) throw new Error('connection promises did not settle');
    expect(settled).toHaveLength(2);
    for (const result of settled) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({
          message: 'MUD transport connection aborted',
        });
      }
    }
    expect(plainAttempts).toBe(0);

    firstSocket.emit('secureConnect');
    replacementSocket.emit('secureConnect');
    expect(session.telnet).toBeNull();
    expect(session.telnetConnected).toBe(false);
  });

  test('rejects a new connect after handoff without disturbing the live socket', async () => {
    const session = new Session('mud.example.com', 4000);
    const tlsSocket = new MockTelnetSocket();
    let tlsAttempts = 0;
    let plainAttempts = 0;

    tls.connect = asStub<typeof tls.connect>()(
      (_port: number, _host: string, _options: tls.ConnectionOptions) => {
        tlsAttempts++;
        return asTelnetSocket(tlsSocket);
      },
    );
    net.createConnection = asStub<typeof net.createConnection>()(
      (_port: number, _host: string) => {
        plainAttempts++;
        return asTelnetSocket(new MockTelnetSocket());
      },
    );

    const first = session.connect();
    tlsSocket.emit('secureConnect');
    await expect(first).resolves.toBeUndefined();

    const duplicate = session.connect();
    expect(tlsAttempts).toBe(1);
    await expect(duplicate).rejects.toThrow('Session is already connected');
    expect(plainAttempts).toBe(0);
    expect(session.telnet).toBe(asTelnetSocket(tlsSocket));
    expect(session.telnetConnected).toBe(true);
    expect(tlsSocket.destroyed).toBe(false);
  });
});
