import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import EventEmitter from 'events';
import fs from 'fs';
import http2 from 'http2';
import os from 'os';
import path from 'path';
import { NotificationManager } from '../src/notification-manager';
import { TriggerMatcher } from '../src/trigger-matcher';

type APNSRequestResponder = (request: MockAPNSRequest) => void;

const respondWithSuccess: APNSRequestResponder = (
  request: MockAPNSRequest,
): void => {
  request.emit('response', {
    ':status': 200,
    'apns-id': 'mock-apns-id',
  });
  request.emit('end');
};

class MockAPNSRequest extends EventEmitter {
  payload = '';
  closedWithCode: number | undefined;
  private timeoutHandler: (() => void) | undefined;

  constructor(private readonly responder: APNSRequestResponder) {
    super();
  }

  setEncoding(_encoding: BufferEncoding): void {}

  setTimeout(_ms: number, callback: () => void): void {
    this.timeoutHandler = callback;
  }

  close(code?: number): void {
    this.closedWithCode = code;
    this.emit('close');
  }

  end(data?: string): void {
    this.payload = data ?? '';
    queueMicrotask(() => {
      this.responder(this);
    });
  }

  triggerTimeout(): void {
    this.timeoutHandler?.();
  }
}

class MockAPNSClient extends EventEmitter {
  readonly requests: MockAPNSRequest[] = [];
  closeCalls = 0;
  closed = false;
  destroyed = false;

  constructor(private readonly responder: APNSRequestResponder) {
    super();
  }

  request(_headers: http2.OutgoingHttpHeaders): MockAPNSRequest {
    const request = new MockAPNSRequest(this.responder);
    this.requests.push(request);
    return request;
  }

  close(): void {
    this.closeCalls++;
    this.closed = true;
    this.emit('close');
  }
}

const originalConnect = http2.connect;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

interface MockCallTracker {
  mock: {
    calls: unknown[][];
  };
}

const setHttp2Connect = (connect: typeof http2.connect): void => {
  (http2 as unknown as { connect: typeof http2.connect }).connect = connect;
};

/**
 * A key path guaranteed absent, inside a directory only this process can
 * reach. A fixed `/tmp` name is one another local user can create first, and
 * then the "no key file" path under test reads their file instead.
 */
const missingKeyPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'mwp-apns-missing-')),
  'missing-apns-key.p8',
);

const createManager = (): NotificationManager => {
  const config = {
    enabled: false,
    apns: {
      keyPath: missingKeyPath,
      keyId: 'KEYID12345',
      teamId: 'TEAMID1234',
      topic: 'org.example.mud',
      environment: 'sandbox' as const,
    },
  };
  const manager = new NotificationManager(config, new TriggerMatcher());
  config.enabled = true;
  const internals = manager as unknown as {
    authToken: string;
    tokenExpiry: number;
  };
  internals.authToken = 'mock-auth-token';
  internals.tokenExpiry = Date.now() + 60_000;
  return manager;
};

describe('NotificationManager APNS connection reuse', () => {
  let clients: MockAPNSClient[];
  let connectMock: ReturnType<typeof mock>;
  let requestResponder: APNSRequestResponder;

  beforeEach(() => {
    clients = [];
    requestResponder = respondWithSuccess;
    connectMock = mock((_authority: string | URL) => {
      const client = new MockAPNSClient(requestResponder);
      clients.push(client);
      return client as unknown as http2.ClientHttp2Session;
    });
    setHttp2Connect(connectMock as unknown as typeof http2.connect);
    console.log = mock(() => {}) as typeof console.log;
    console.error = mock(() => {}) as typeof console.error;
  });

  afterEach(() => {
    setHttp2Connect(originalConnect);
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  test('reuses one healthy APNS HTTP/2 client for multiple pushes', async () => {
    const manager = createManager();

    const first = await manager.sendSilentPush(
      'device-token-0000000000000001',
      'session-1',
    );
    const second = await manager.sendAlertPush(
      'device-token-0000000000000002',
      'title',
      'body',
    );

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.requests).toHaveLength(2);
    expect(clients[0]?.closeCalls).toBe(0);
  });

  test('creates a new APNS client after the cached session closes', async () => {
    const manager = createManager();

    expect(
      await manager.sendSilentPush(
        'device-token-0000000000000001',
        'session-1',
      ),
    ).toBe(true);

    clients[0]?.emit('close');

    expect(
      await manager.sendSilentPush(
        'device-token-0000000000000002',
        'session-2',
      ),
    ).toBe(true);

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(2);
    expect(clients[1]?.requests).toHaveLength(1);
  });

  test('closes the cached APNS client when the manager is closed', async () => {
    const manager = createManager();

    expect(
      await manager.sendSilentPush(
        'device-token-0000000000000001',
        'session-1',
      ),
    ).toBe(true);

    manager.close();

    expect(clients[0]?.closeCalls).toBe(1);

    expect(
      await manager.sendSilentPush(
        'device-token-0000000000000002',
        'session-2',
      ),
    ).toBe(true);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  test('settles a push once when the APNS request errors', async () => {
    requestResponder = (request: MockAPNSRequest): void => {
      request.emit('error', new Error('stream failed'));
      request.emit('response', {
        ':status': 200,
        'apns-id': 'late-success',
      });
      request.emit('end');
    };
    const manager = createManager();

    const result = await manager.sendSilentPush(
      'device-token-0000000000000001',
      'session-1',
    );

    const logCalls = (console.log as unknown as MockCallTracker).mock.calls;
    const successLogs = logCalls.filter((call) =>
      String(call[0]).includes('APNS request success'),
    );
    expect(result).toBe(false);
    expect(successLogs).toHaveLength(0);
  });
});
