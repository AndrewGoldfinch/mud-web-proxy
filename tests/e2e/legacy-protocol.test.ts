/**
 * Process-level coverage for both wire protocols.
 *
 * MWP-90 requires these to be process-level: unit tests over parse() cannot
 * catch a divergence in limit reservation, data framing, or teardown, which
 * is the failure mode that matters.
 *
 * Note on the mock: it sends nothing on connect (verified — a raw TCP client
 * receives zero bytes), so MUD output can only be observed by first sending
 * input and reading the reply. Asserting on a connect banner would assert on
 * the harness, and is the pre-existing "should receive data from mock server"
 * failure in mock-mud.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import net, { type Server, type Socket } from 'net';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { inflateRawSync } from 'zlib';
import { startMockMUDTest, type MockMUDSetup } from './mock-mud-helper';
import { startTestProxy } from './proxy-launcher';
import { createIREMUD } from './mock-mud';

const PROXY_PORT = 6321;
const AUTH_PORT = 6322;
const REQUIRED_PROXY_PORT = 6325;
const REQUIRED_MUD_PORT = 6326;
const PREFER_PROXY_PORT = 6327;
const PREFER_MUD_PORT = 6328;
const STALL_PROXY_PORT = 6329;
const STALL_MUD_PORT = 6330;
const TLS_PROXY_PORT = 6331;
const TLS_MUD_PORT = 6332;
const LEGACY_REQUIRED_REJECTION =
  'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.';
const SETTLE_MS = 1500;

const settle = (ms = SETTLE_MS) => new Promise((r) => setTimeout(r, ms));

const portOf = (mud: unknown): number =>
  (mud as { config: { port: number } }).config.port;

/**
 * Open a raw socket. E2EConnection hardcodes a typed connect frame, so the
 * legacy protocol has to drive the WebSocket directly.
 */
const openRaw = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('open timeout')), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('socket error'));
    };
  });

/**
 * Decode legacy frames. Every byte the proxy sends a legacy client is
 * base64, so an assertion on human-readable text has to decode first.
 */
const decodeLegacy = (frames: string[]): string =>
  frames
    .map((f) => {
      try {
        return Buffer.from(f, 'base64').toString('utf8');
      } catch {
        return '';
      }
    })
    .join('');

/** Established legacy player frames may be deflated before base64 encoding. */
const decodeLegacyPlayer = (frames: string[]): string =>
  frames
    .map((frame) => {
      const data = Buffer.from(frame, 'base64');
      try {
        return inflateRawSync(data).toString('utf8');
      } catch {
        return data.toString('utf8');
      }
    })
    .join('');

const parseJsonFrames = (frames: string[]): Array<Record<string, unknown>> =>
  frames.flatMap((frame) => {
    try {
      return [JSON.parse(frame) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

/** Collect every frame the proxy sends, as text. */
const collect = (ws: WebSocket): string[] => {
  const frames: string[] = [];
  ws.onmessage = (ev: MessageEvent) => {
    frames.push(
      typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString(),
    );
  };
  return frames;
};

describe('legacy connect protocol, process-level', () => {
  let setup: MockMUDSetup;
  let mudPort: number;

  beforeAll(async () => {
    setup = await startMockMUDTest('ire', PROXY_PORT, 6323);
    mudPort = portOf(setup.mockServer);
  });

  afterAll(async () => {
    await setup.stop();
  });

  test('1. a legacy connect opens a telnet session', async () => {
    const before = setup.mockServer.getClientCount();
    const ws = await openRaw(setup.url);
    const frames = collect(ws);

    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();

    expect(setup.mockServer.getClientCount()).toBeGreaterThan(before);
    // A legacy client must never receive the typed session frame.
    expect(frames.join('')).not.toContain('"type":"session"');
    ws.close();
    await settle();
  });

  test('2. legacy player input reaches the MUD', async () => {
    const ws = await openRaw(setup.url);
    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();
    setup.mockServer.clearReceivedCommands();

    // Raw, non-JSON text — the legacy client's ordinary input path. This is
    // what silently vanished when the legacy connect created a Session but
    // never set socket.ts, leaving forward() with nothing to write to.
    ws.send('legacy-probe\r\n');

    // Poll for arrival rather than sleeping a fixed interval. A flat settle()
    // is a bet that the round trip always fits in 1500ms, and under a full
    // suite run it intermittently does not.
    const deadline = Date.now() + 8000;
    while (
      Date.now() < deadline &&
      !setup.mockServer.getReceivedCommands().includes('legacy-probe')
    ) {
      await settle(100);
    }

    expect(setup.mockServer.getReceivedCommands()).toContain('legacy-probe');
    ws.close();
    await settle();
    // Must exceed the poll deadline above, or the test is killed mid-poll
    // and every later test in this block fails on the torn-down socket.
  }, 15000);

  test('3. MUD output reaches a legacy client as bare base64, not JSON', async () => {
    const ws = await openRaw(setup.url);
    const frames = collect(ws);
    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();
    frames.length = 0;

    // Provoke a reply, since the mock sends nothing unprompted.
    ws.send('tester\r\n');
    await settle();

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      // Legacy clients decode base64 directly. A typed JSON envelope would
      // be rendered as literal JSON in the player's terminal.
      expect(frame.trimStart().startsWith('{')).toBe(false);
      expect(frame).not.toContain('"type":"data"');
      expect(frame).toMatch(/^[A-Za-z0-9+/=]*$/);
    }
    ws.close();
    await settle();
  });

  test('4. closing a legacy socket tears the MUD connection down', async () => {
    const ws = await openRaw(setup.url);
    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();
    const connected = setup.mockServer.getClientCount();
    expect(connected).toBeGreaterThan(0);

    // A legacy client holds no session token, so nothing could ever resume
    // this connection. Detaching and leaving it alive would orphan it for
    // the full session timeout.
    ws.close();
    await settle(2500);

    expect(setup.mockServer.getClientCount()).toBeLessThan(connected);
  });

  test('5. a legacy connect to a disallowed target is denied in plaintext', async () => {
    const before = setup.mockServer.getClientCount();
    const ws = await openRaw(setup.url);
    const frames = collect(ws);

    ws.send(JSON.stringify({ connect: 1, host: 'evil.example', port: 4000 }));
    await settle();

    const joined = frames.join('');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toContain('"type":"error"');
    // The reason is carried in the legacy framing, so decode to read it.
    expect(decodeLegacy(frames)).toContain('only allows connections');
    // A denied target is never dialled.
    expect(setup.mockServer.getClientCount()).toBe(before);
    ws.close();
    await settle();
  });

  test('6. a malformed legacy message is rejected in plaintext, not JSON', async () => {
    const ws = await openRaw(setup.url);
    const frames = collect(ws);

    // Validation fails before the connect path, so this rejection is
    // rendered by parse() rather than by the connect flow — it must still
    // respect the legacy framing.
    ws.send(JSON.stringify({ connect: 1, port: 'not-a-port' }));
    await settle();

    const joined = frames.join('');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toContain('invalid_request');
    expect(joined).not.toContain('"type":"error"');
    const text = decodeLegacy(frames);
    expect(text).toContain('port');
    expect(text.trimStart().startsWith('{')).toBe(false);
    ws.close();
    await settle();
  });

  test("7. a typo'd typed control message never reaches the MUD", async () => {
    const ws = await openRaw(setup.url);
    const frames = collect(ws);

    ws.send(
      JSON.stringify({
        type: 'connect',
        host: 'localhost',
        port: mudPort,
        deviceToken: 'e2e-typo',
      }),
    );
    await settle();
    setup.mockServer.clearReceivedCommands();

    // `hieght` is a typo. Under the old contract the whole blob was typed
    // into the game; it must now come back as invalid_request instead.
    ws.send(JSON.stringify({ type: 'naws', width: 80, hieght: 24 }));
    await settle();

    const received = setup.mockServer.getReceivedCommands().join('\n');
    expect(received).not.toContain('hieght');
    expect(received).not.toContain('naws');
    expect(frames.join('')).toContain('invalid_request');
    ws.close();
    await settle();
  });

  test('8a. a second typed connect is rejected', async () => {
    const ws = await openRaw(setup.url);
    const frames = collect(ws);
    ws.send(
      JSON.stringify({
        type: 'connect',
        host: 'localhost',
        port: mudPort,
        deviceToken: 'e2e-second',
      }),
    );
    await settle();

    const mark = frames.length;
    ws.send(
      JSON.stringify({ type: 'connect', host: 'localhost', port: mudPort }),
    );
    await settle();

    expect(frames.slice(mark).join('')).toContain('already has a session');
    ws.close();
    await settle();
  }, 15000);

  test('8b. a second legacy connect is rejected, in legacy framing', async () => {
    const ws = await openRaw(setup.url);
    const frames = collect(ws);
    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();

    const mark = frames.length;
    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();

    const added = frames.slice(mark);
    expect(decodeLegacy(added)).toContain('already has a session');
    expect(added.join('')).not.toContain('"type":"error"');
    ws.close();
    await settle();
  }, 15000);
});

describe('legacy connect under preferred MUD TLS', () => {
  let mock: ReturnType<typeof createIREMUD>;
  let proxy: Awaited<ReturnType<typeof startTestProxy>>;
  let mudPort: number;

  beforeAll(async () => {
    mock = createIREMUD();
    (mock as unknown as { config: { port: number } }).config.port =
      PREFER_MUD_PORT;
    mudPort = portOf(mock);
    await mock.start();
    proxy = await startTestProxy(PREFER_PROXY_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: mudPort.toString(),
      MUD_TLS_MODE: 'prefer',
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  test('10. prefer mode probes TLS then relays legacy data over plaintext', async () => {
    const before = mock.getAcceptedConnectionCount();
    const ws = await openRaw(proxy.url);
    const frames = collect(ws);

    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));

    const acceptedDeadline = Date.now() + 8000;
    while (
      Date.now() < acceptedDeadline &&
      mock.getAcceptedConnectionCount() !== before + 2
    ) {
      await settle(100);
    }

    // Keep this first: the red run is valid only when this reports +1 vs +2.
    expect(mock.getAcceptedConnectionCount()).toBe(before + 2);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    mock.clearReceivedCommands();
    frames.length = 0;
    ws.send('legacy-prefer-probe\r\n');

    const responseDeadline = Date.now() + 8000;
    while (
      Date.now() < responseDeadline &&
      (!mock.getReceivedCommands().includes('legacy-prefer-probe') ||
        !decodeLegacyPlayer(frames).includes('Password:'))
    ) {
      await settle(100);
    }

    expect(decodeLegacyPlayer(frames)).toContain('Password:');
    expect(mock.getReceivedCommands()).toContain('legacy-prefer-probe');
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.trimStart().startsWith('{')).toBe(false);
      expect(frame).not.toContain('"type":"data"');
      expect(frame).toMatch(/^[A-Za-z0-9+/=]*$/);
    }
    expect(mock.getAcceptedConnectionCount()).toBe(before + 2);

    ws.close();
    await settle();
  }, 20000);
});

describe('legacy connect over trusted real TLS', () => {
  // Every other transport case here points at a plaintext MUD, which can only
  // ever prove the downgrade. This is the one that proves the feature: a
  // legacy client's bytes traversing an actual TLSSocket, through send(),
  // encodeTelnetOutbound, writeTelnet's writable check, telnet negotiation,
  // and base64 framing.
  let mock: ReturnType<typeof createIREMUD>;
  let proxy: Awaited<ReturnType<typeof startTestProxy>>;
  let certDir: string;
  let mudPort: number;

  beforeAll(async () => {
    certDir = mkdtempSync(path.join(tmpdir(), 'mwp135-tls-'));
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');

    // SAN DNS:localhost, because the proxy presents `localhost` as SNI and
    // Node checks the name it asked for, not the address it dialled.
    const openssl = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ]);
    expect(openssl.exitCode).toBe(0);

    mock = createIREMUD();
    const config = (
      mock as unknown as {
        config: { port: number; tls?: { key: Buffer; cert: Buffer } };
      }
    ).config;
    config.port = TLS_MUD_PORT;
    config.tls = {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
    mudPort = portOf(mock);
    await mock.start();

    proxy = await startTestProxy(TLS_PROXY_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: mudPort.toString(),
      MUD_TLS_MODE: 'prefer',
      NODE_EXTRA_CA_CERTS: certPath,
    });
  });

  afterAll(async () => {
    // The child process reads the CA from disk, so the directory outlives it.
    await proxy.stop();
    await mock.stop();
    rmSync(certDir, { recursive: true, force: true });
  });

  test('13. prefer mode keeps a trusted TLS connection and relays legacy data', async () => {
    const before = mock.getAcceptedConnectionCount();
    const ws = await openRaw(proxy.url);
    const frames = collect(ws);

    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));

    const acceptedDeadline = Date.now() + 8000;
    while (
      Date.now() < acceptedDeadline &&
      (mock.getAcceptedConnectionCount() === before ||
        mock.getClientCount() < 1)
    ) {
      await settle(100);
    }

    // Keep this first. A downgrade would also deliver data, so without the
    // exact count this test would pass over plaintext and prove nothing —
    // the certificate has to be trusted, not merely present.
    expect(mock.getAcceptedConnectionCount()).toBe(before + 1);
    expect(mock.getClientCount()).toBeGreaterThan(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    mock.clearReceivedCommands();
    frames.length = 0;
    ws.send('legacy-tls-probe\r\n');

    const responseDeadline = Date.now() + 8000;
    while (
      Date.now() < responseDeadline &&
      (!mock.getReceivedCommands().includes('legacy-tls-probe') ||
        !decodeLegacyPlayer(frames).includes('Password:'))
    ) {
      await settle(100);
    }

    expect(mock.getReceivedCommands()).toContain('legacy-tls-probe');
    expect(decodeLegacyPlayer(frames)).toContain('Password:');
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.trimStart().startsWith('{')).toBe(false);
      expect(frame).not.toContain('"type":"data"');
      expect(frame).toMatch(/^[A-Za-z0-9+/=]*$/);
    }
    // Re-asserted after the round trip: no late fallback opened a second
    // connection once data was already flowing.
    expect(mock.getAcceptedConnectionCount()).toBe(before + 1);

    ws.close();
    await settle();
  }, 20000);
});

describe('pending legacy transport races', () => {
  let stallServer: Server;
  let proxy: Awaited<ReturnType<typeof startTestProxy>>;
  let acceptedUpstreams = 0;
  const activeUpstreams = new Set<Socket>();

  beforeAll(async () => {
    stallServer = net.createServer((socket) => {
      acceptedUpstreams += 1;
      activeUpstreams.add(socket);
      socket.once('close', () => activeUpstreams.delete(socket));
      // Send no bytes: the TLS transport must remain provisional until its
      // handshake deadline or an explicit abort.
    });

    await new Promise<void>((resolve, reject) => {
      stallServer.once('error', reject);
      stallServer.listen(STALL_MUD_PORT, () => {
        stallServer.off('error', reject);
        resolve();
      });
    });

    proxy = await startTestProxy(STALL_PROXY_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: STALL_MUD_PORT.toString(),
      MUD_TLS_MODE: 'prefer',
    });
  });

  afterAll(async () => {
    try {
      await proxy.stop();
    } finally {
      for (const socket of activeUpstreams) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        stallServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  test('a stalled handshake is aborted when the legacy client closes', async () => {
    const before = acceptedUpstreams;
    const ws = await openRaw(proxy.url);

    ws.send(
      JSON.stringify({
        connect: 1,
        host: 'localhost',
        port: STALL_MUD_PORT,
      }),
    );

    const acceptedDeadline = Date.now() + 2000;
    while (Date.now() < acceptedDeadline && acceptedUpstreams !== before + 1) {
      await settle(25);
    }
    expect(acceptedUpstreams).toBe(before + 1);

    const closedAt = Date.now();
    ws.close();
    const upstreamCloseDeadline = closedAt + 3000;
    while (Date.now() < upstreamCloseDeadline && activeUpstreams.size !== 0) {
      await settle(25);
    }

    expect(activeUpstreams.size).toBe(0);
    expect(Date.now() - closedAt).toBeLessThan(4000);
    expect(acceptedUpstreams).toBe(before + 1);
  }, 8000);

  test('same-turn duplicate legacy frames create exactly one upstream dial', async () => {
    const before = acceptedUpstreams;
    const ws = await openRaw(proxy.url);
    const frames = collect(ws);
    let closed = false;
    ws.onclose = () => {
      closed = true;
    };
    const connect = JSON.stringify({
      connect: 1,
      host: 'localhost',
      port: STALL_MUD_PORT,
    });

    ws.send(connect);
    ws.send(connect);

    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      (!closed ||
        activeUpstreams.size !== 0 ||
        !decodeLegacy(frames).includes('already has a session'))
    ) {
      await settle(25);
    }

    expect(acceptedUpstreams).toBe(before + 1);
    expect(decodeLegacy(frames)).toContain('already has a session');
    expect(closed).toBe(true);
    expect(activeUpstreams.size).toBe(0);
  }, 8000);
});

describe('legacy connect under required MUD TLS', () => {
  let mock: ReturnType<typeof createIREMUD>;
  let proxy: Awaited<ReturnType<typeof startTestProxy>>;
  let mudPort: number;

  beforeAll(async () => {
    mock = createIREMUD();
    (mock as unknown as { config: { port: number } }).config.port =
      REQUIRED_MUD_PORT;
    mudPort = portOf(mock);
    await mock.start();
    proxy = await startTestProxy(REQUIRED_PROXY_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: mudPort.toString(),
      MUD_TLS_MODE: 'required',
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  test('11. required mode makes one TLS attempt and rejects legacy', async () => {
    const before = mock.getAcceptedConnectionCount();
    const ws = await openRaw(proxy.url);
    const frames = collect(ws);
    let closed = false;
    ws.onclose = () => {
      closed = true;
    };

    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();

    // Keep this first: the red run is valid only when this reports 0 vs +1.
    expect(mock.getAcceptedConnectionCount()).toBe(before + 1);
    expect(decodeLegacy(frames)).toContain(LEGACY_REQUIRED_REJECTION);
    expect(closed).toBe(true);
  });

  test('12. required mode still routes typed connects through TLS', async () => {
    const before = mock.getAcceptedConnectionCount();
    const ws = await openRaw(proxy.url);
    const frames = collect(ws);

    ws.send(
      JSON.stringify({
        type: 'connect',
        host: 'localhost',
        port: mudPort,
        deviceToken: 'required-typed-path',
      }),
    );

    const deadline = Date.now() + 5000;
    let errorFrame: Record<string, unknown> | undefined;
    while (Date.now() < deadline && !errorFrame) {
      errorFrame = parseJsonFrames(frames).find(
        (frame) =>
          frame.type === 'error' && frame.code === 'connection_failed',
      );
      if (!errorFrame) await settle(100);
    }

    expect(errorFrame).toMatchObject({
      type: 'error',
      code: 'connection_failed',
    });
    expect(decodeLegacy(frames)).not.toContain(LEGACY_REQUIRED_REJECTION);
    expect(mock.getAcceptedConnectionCount()).toBe(before + 1);
    ws.close();
    await settle();
  }, 10000);
});

describe('legacy connect under shared-secret auth', () => {
  let mock: ReturnType<typeof createIREMUD>;
  let proxy: Awaited<ReturnType<typeof startTestProxy>>;

  beforeAll(async () => {
    mock = createIREMUD();
    // The factory hardcodes 6301, which mock-mud.test.ts also uses; give
    // this suite its own port so a full run cannot cross the two.
    (mock as unknown as { config: { port: number } }).config.port = 6324;
    await mock.start();
    proxy = await startTestProxy(AUTH_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: portOf(mock).toString(),
      AUTH_MODE: 'shared-secret',
      PROXY_SHARED_SECRET: 'a'.repeat(64),
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  test('9. an unauthenticated legacy connect is rejected at the upgrade', async () => {
    mock.clearReceivedCommands();

    // MWP-90 requires the legacy path to enforce identical authentication.
    // Auth lives at the upgrade, so the refusal is decided before this client
    // sends a single frame — and it must consume no session or limit capacity.
    //
    // This asserted `rejects.toThrow()` until MWP-136. The refusal used to be
    // an HTTP status written to the upgrade socket, which Bun discards, so
    // the client got a bare reset and the handshake failed. It is now
    // completed and immediately closed with a code that says why, so the
    // socket opens and then goes away. Same refusal, delivered legibly.
    const closed = await new Promise<{ code: number; reason: string }>(
      (resolve) => {
        const ws = new WebSocket(proxy.url);
        const timer = setTimeout(
          () => resolve({ code: -1, reason: 'never closed' }),
          8000,
        );
        ws.onclose = (ev) => {
          clearTimeout(timer);
          resolve({ code: ev.code, reason: ev.reason });
        };
        ws.onerror = () => {
          // The close event still arrives and resolves this.
        };
      },
    );

    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain('401');
    await settle(500);

    expect(mock.getClientCount()).toBe(0);
    expect(mock.getReceivedCommands()).toHaveLength(0);
  });
});
