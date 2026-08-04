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
import { startMockMUDTest, type MockMUDSetup } from './mock-mud-helper';
import { startTestProxy } from './proxy-launcher';
import { createIREMUD } from './mock-mud';

const PROXY_PORT = 6321;
const AUTH_PORT = 6322;
const REQUIRED_PROXY_PORT = 6325;
const REQUIRED_MUD_PORT = 6326;
const LEGACY_REQUIRED_REJECTION =
  'Legacy connections are unavailable when MUD_TLS_MODE=required.';
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

  test('10. required mode rejects legacy before dialing upstream', async () => {
    const before = mock.getAcceptedConnectionCount();
    const ws = await openRaw(proxy.url);
    const frames = collect(ws);
    let closed = false;
    ws.onclose = () => {
      closed = true;
    };

    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();

    // Keep this first: the red run is valid only when this reports 1 vs 0.
    expect(mock.getAcceptedConnectionCount()).toBe(before);
    expect(decodeLegacy(frames)).toContain(LEGACY_REQUIRED_REJECTION);
    expect(closed).toBe(true);
  });

  test('11. required mode still routes typed connects through TLS', async () => {
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
    expect(mock.getAcceptedConnectionCount()).toBeGreaterThan(before);
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
    // Auth lives at the upgrade, so the socket never opens without it — and
    // the rejection must consume no session or limit capacity.
    await expect(openRaw(proxy.url)).rejects.toThrow();
    await settle(500);

    expect(mock.getClientCount()).toBe(0);
    expect(mock.getReceivedCommands()).toHaveLength(0);
  });
});
