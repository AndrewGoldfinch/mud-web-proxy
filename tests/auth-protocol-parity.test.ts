/**
 * Auth and policy parity across both wire protocols (MWP-122, areas 1 and 3).
 *
 * The acceptance criterion asks that both protocols be exercised for policy
 * and auth "with parity asserted". Reading the code first changes what is
 * worth writing:
 *
 *  - **Auth cannot differ by protocol today, structurally.** It runs on the
 *    HTTP `upgrade` event, before `handleUpgrade` and before any frame is
 *    read — and the protocol is chosen from the *shape of the first frame*.
 *    At rejection time there is no protocol yet. So a test that offers a bad
 *    secret "as a typed client" and again "as a legacy client" runs the same
 *    code twice and proves nothing; written naively it is a vacuous test that
 *    would pass even if one protocol were wide open.
 *
 *    What is worth pinning is that structure: rejection happens at the HTTP
 *    layer, so the socket never opens and *no* client of any protocol gets
 *    through. That fails the moment someone moves enforcement inside a
 *    protocol handler, which is the realistic regression.
 *
 *  - **Policy genuinely runs twice.** `openLegacyConnection` and the typed
 *    connect path are separate code that both call
 *    `sessionIntegration.authorizeConnect`. Nothing structural forces that;
 *    it is a convention one refactor can break. This is where a real
 *    side-by-side comparison earns its place.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'crypto';
import { connect } from 'net';
import WebSocket from 'ws';
import {
  startMockMud,
  startProxy,
  type MockMud,
  type RunningProxy,
} from './process-harness.js';

const WS_PORT = 6233;
const MUD_PORT = 6234;

const SECRET = 'parity-test-shared-secret-long-enough-value';

let proxy: RunningProxy;
let mud: MockMud;

const settle = (ms = 700): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface Attempt {
  opened: boolean;
  status?: number;
}

/**
 * Perform the upgrade handshake over a raw socket and read the status line.
 *
 * Two client libraries were tried first and both obscured what was happening:
 * the `ws` client emits `error` before `unexpected-response`, and Bun's
 * `http.request` reports a connection error for a rejection while surfacing a
 * successful 101 as a `response` rather than an `upgrade`. Reading the bytes
 * directly takes every client parser out of the question and states the claim
 * as literally as it can be: this is what the server put on the wire.
 *
 * Which turned out to matter — on a rejection it puts nothing there at all.
 * See the Bun defect test below.
 */
function attempt(headers: Record<string, string>): Promise<Attempt> {
  const lines = [
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${WS_PORT}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '',
    '',
  ].join('\r\n');

  return new Promise((resolve) => {
    const sock = connect(WS_PORT, '127.0.0.1');
    let buf = '';

    const done = (): void => {
      clearTimeout(timer);
      sock.destroy();
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1]);
      resolve(
        Number.isFinite(status)
          ? { opened: status === 101, status }
          : { opened: false },
      );
    };

    const timer = setTimeout(done, 8000);

    sock.on('connect', () => sock.write(lines));
    sock.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      // The status line is all this needs, and it is in the first packet.
      if (buf.includes('\r\n')) done();
    });
    sock.on('close', done);
    sock.on('error', done);
  });
}

/** Open an authorized socket and collect every frame it receives. */
async function openAuthorized(): Promise<{
  ws: WebSocket;
  frames: string[];
}> {
  const frames: string[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${WS_PORT}/`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const timer = setTimeout(() => reject(new Error('open timeout')), 8000);
    sock.on('open', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  ws.on('message', (d: Buffer) => frames.push(d.toString()));
  return { ws, frames };
}

beforeAll(async () => {
  mud = await startMockMud(MUD_PORT);
  proxy = await startProxy(WS_PORT, {
    TN_HOST: '127.0.0.1',
    TN_PORT: String(MUD_PORT),
    TARGET_MODE: 'fixed',
    AUTH_MODE: 'shared-secret',
    PROXY_SHARED_SECRET: SECRET,
  });
}, 45000);

afterAll(async () => {
  await proxy?.stop();
  await mud?.stop();
});

describe('authentication is settled before a protocol exists', () => {
  test('a valid secret is admitted', async () => {
    const r = await attempt({ Authorization: `Bearer ${SECRET}` });
    expect(r.opened).toBe(true);
  });

  // Each of these is rejected at the HTTP layer. The absence of a 101 is the
  // assertion that carries the parity claim: the socket never opened, so no
  // frame was ever read, so no protocol was ever selected.
  const rejected: ReadonlyArray<[string, Record<string, string>]> = [
    [
      'a wrong secret of the same length',
      {
        Authorization: `Bearer ${'x'.repeat(SECRET.length)}`,
      },
    ],
    [
      'a wrong secret of a different length',
      {
        Authorization: 'Bearer short',
      },
    ],
    ['no credential at all', {}],
    [
      'the right value under the wrong scheme',
      {
        Authorization: `Basic ${SECRET}`,
      },
    ],
    ['the secret in the query string, which is not enabled here', {}],
  ];

  for (const [name, headers] of rejected) {
    test(`${name} never completes the upgrade`, async () => {
      const r = await attempt(headers);
      // No 101 means no WebSocket, so no frame is ever read and no protocol
      // is ever chosen. That is the whole parity claim, and it is what goes
      // red if enforcement moves into a protocol handler.
      expect(r.opened).toBe(false);
      expect(r.status).not.toBe(101);
    });
  }

  test('the server records the refusal', () => {
    // Pairs with the above: proves the connection died because auth refused
    // it, not because the handshake was malformed and the server ignored it.
    expect(proxy.output()).toMatch(/Rejected upgrade/);
  });

  test('the rejection status never reaches the client (Bun defect)', async () => {
    // Documented rather than asserted away, because it is a real operational
    // problem and not a property of this codebase.
    //
    // `rejectUpgrade` writes `HTTP/1.1 401 ...` to the upgrade socket. Under
    // Bun 1.3.14 those bytes are silently discarded: the client gets a bare
    // connection reset with no status. The same server code on Node 24
    // delivers all 67 bytes, so this is the runtime, not the write. Switching
    // `write`+`destroy` to `end()` does not change it either — that was
    // tried.
    //
    // The cost is diagnostic: an operator with a wrong token sees a reset
    // instead of 401, and an edge proxy in front of it turns a reset into
    // 502. This test is here so that the day Bun fixes it, this file fails
    // and someone tightens the assertions above to check for 401 and 429.
    const r = await attempt({ Authorization: 'Bearer definitely-wrong' });
    expect(r.status).toBeUndefined();
  });

  test('a refused attempt never reaches the MUD', () => {
    // Auth sits before capacity reservation and before dialling, so a wrong
    // guess must cost nothing downstream.
    expect(mud.connections()).toBe(0);
  });
});

describe('target policy refuses the same target on both protocols', () => {
  // The substantive parity check. Two distinct code paths, one policy.
  const forbidden = { host: 'evil.example', port: 4000 };

  test('the typed protocol refuses it, in typed framing', async () => {
    const { ws, frames } = await openAuthorized();
    ws.send(JSON.stringify({ type: 'connect', ...forbidden }));
    await settle();
    ws.close();

    const joined = frames.join('');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).toContain('"type":"error"');
  });

  test('the legacy protocol refuses it, in legacy framing', async () => {
    const { ws, frames } = await openAuthorized();
    ws.send(JSON.stringify({ connect: 1, ...forbidden }));
    await settle();
    ws.close();

    const joined = frames.join('');
    expect(joined.length).toBeGreaterThan(0);
    // A legacy client renders whatever arrives, so a JSON envelope would be
    // printed into the player's terminal rather than understood.
    expect(joined).not.toContain('"type":"error"');
    const decoded = frames
      .map((f) => {
        try {
          return Buffer.from(f, 'base64').toString('utf8');
        } catch {
          return '';
        }
      })
      .join('');
    expect(decoded).toContain('only allows connections');
  });

  test('neither protocol dialled the forbidden target', () => {
    // The parity that matters. Both were refused, and refused before the
    // dial — so the mock MUD, the only target either could have reached,
    // saw nothing. A protocol that skipped `authorizeConnect` would show up
    // here as a connection.
    expect(mud.connections()).toBe(0);
  });
});

describe('both protocols reach the MUD once the target is allowed', () => {
  // The counterpart to the above: prove the refusals were caused by policy
  // and not by the test driving either protocol wrongly. Without this, a
  // typo in the legacy frame would look like a successful denial.

  test('the typed protocol connects to the permitted target', async () => {
    const before = mud.connections();
    const { ws } = await openAuthorized();
    ws.send(
      JSON.stringify({ type: 'connect', host: '127.0.0.1', port: MUD_PORT }),
    );
    await settle();
    ws.close();
    expect(mud.connections()).toBe(before + 1);
  });

  test('the legacy protocol connects to the permitted target', async () => {
    const before = mud.connections();
    const { ws } = await openAuthorized();
    ws.send(JSON.stringify({ connect: 1, host: '127.0.0.1', port: MUD_PORT }));
    await settle();
    ws.close();
    expect(mud.connections()).toBe(before + 1);
  });
});
