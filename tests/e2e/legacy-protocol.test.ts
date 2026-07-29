/**
 * Process-level coverage for both wire protocols.
 *
 * MWP-90 requires these to be process-level: unit tests over parse() cannot
 * catch a divergence in limit reservation or auth ordering, which is the
 * failure mode that matters.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startMockMUDTest, type MockMUDSetup } from './mock-mud-helper';
import { startTestProxy } from './proxy-launcher';
import { createIREMUD } from './mock-mud';

const PROXY_PORT = 6321;
const AUTH_PORT = 6322;
const SETTLE_MS = 1500;

const settle = (ms = SETTLE_MS) => new Promise((r) => setTimeout(r, ms));

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
    setup = await startMockMUDTest('ire', PROXY_PORT);
    mudPort = (setup.mockServer as unknown as { config: { port: number } })
      .config.port;
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

    // The MUD observing a new inbound connection is what proves the telnet
    // session opened. Asserting on banner bytes instead would be testing the
    // harness: MUD-to-client data does not flow in this mock at baseline,
    // for the typed protocol either (see the pre-existing failure "should
    // receive data from mock server" in mock-mud.test.ts).
    expect(setup.mockServer.getClientCount()).toBeGreaterThan(before);

    // A legacy client must never receive the typed session frame.
    expect(frames.join('')).not.toContain('"type":"session"');
    ws.close();
  });

  test('2. a legacy connect to a disallowed target is denied in plaintext', async () => {
    const before = setup.mockServer.getClientCount();
    const ws = await openRaw(setup.url);
    const frames = collect(ws);

    ws.send(JSON.stringify({ connect: 1, host: 'evil.example', port: 4000 }));
    await settle();

    const joined = frames.join('');
    expect(joined.length).toBeGreaterThan(0);
    // Legacy clients render bytes, so a JSON error frame would be printed
    // into the player's terminal — the failure MWP-91 exists to prevent.
    expect(joined).not.toContain('"type":"error"');
    // A denied target is never dialled.
    expect(setup.mockServer.getClientCount()).toBe(before);
    ws.close();
  });

  test("3. a typo'd control message never reaches the MUD", async () => {
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
  });

  test('4. a second typed connect on the same socket is rejected', async () => {
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

    const before = frames.length;
    ws.send(
      JSON.stringify({ type: 'connect', host: 'localhost', port: mudPort }),
    );
    await settle();

    expect(frames.slice(before).join('')).toContain('already has a session');
    ws.close();
  });

  test('4b. a second legacy connect is rejected too', async () => {
    const ws = await openRaw(setup.url);
    const frames = collect(ws);

    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();

    const before = frames.length;
    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();

    const added = frames.slice(before).join('');
    expect(added).toContain('already has a session');
    expect(added).not.toContain('"type":"error"');
    ws.close();
  });
});

describe('legacy connect under shared-secret auth', () => {
  let mock: ReturnType<typeof createIREMUD>;
  let proxy: Awaited<ReturnType<typeof startTestProxy>>;

  beforeAll(async () => {
    mock = createIREMUD();
    await mock.start();
    proxy = await startTestProxy(AUTH_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: (
        mock as unknown as { config: { port: number } }
      ).config.port.toString(),
      AUTH_MODE: 'shared-secret',
      PROXY_SHARED_SECRET: 'a'.repeat(64),
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  test('5. an unauthenticated legacy connect is rejected at the upgrade', async () => {
    mock.clearReceivedCommands();

    // MWP-90 requires the legacy path to enforce identical authentication.
    // Auth lives at the upgrade, so the socket never opens without it — and
    // the rejection must consume no session or limit capacity.
    await expect(openRaw(proxy.url)).rejects.toThrow();
    await settle(500);

    expect(mock.getReceivedCommands()).toHaveLength(0);
  });
});
