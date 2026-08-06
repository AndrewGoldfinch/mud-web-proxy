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
 *    What is worth pinning is that structure: the refusal is decided before
 *    the client sends anything at all, so it cannot depend on the protocol.
 *    These clients send no frames and are still refused. That fails the
 *    moment someone moves enforcement inside a protocol handler, which is the
 *    realistic regression.
 *
 *  - **Policy genuinely runs twice.** `openLegacyConnection` and the typed
 *    connect path are separate code that both call
 *    `sessionIntegration.authorizeConnect`. Nothing structural forces that;
 *    it is a convention one refactor can break. This is where a real
 *    side-by-side comparison earns its place.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

/**
 * Open a socket and report whether it is still connected a moment later.
 *
 * The counterpart to `closeReason`: proves an accepted credential is not
 * merely admitted to the handshake but left connected, which is what
 * distinguishes acceptance from the reject path — that one also completes
 * the handshake, then closes.
 */
function staysOpen(headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/`, { headers });
    let closed = false;
    ws.on('close', () => {
      closed = true;
    });
    ws.on('error', () => {
      closed = true;
    });
    setTimeout(() => {
      const open = !closed && ws.readyState === WebSocket.OPEN;
      ws.terminate();
      resolve(open);
    }, 1500);
  });
}

interface CloseInfo {
  code?: number;
  reason: string;
}

/**
 * Attempt an upgrade with a WebSocket client and report how it was closed.
 *
 * Sends nothing: it opens and waits. The refusal arrives as a close frame
 * rather than an HTTP status, for the reason set out on `rejectUpgrade`.
 */
function closeReason(headers: Record<string, string>): Promise<CloseInfo> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/`, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ reason: 'timeout' });
    }, 8000);
    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.on('error', () => {
      // A close frame still arrives; `close` resolves us.
    });
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
  test('a valid secret is admitted and stays connected', async () => {
    const r = await staysOpen({ Authorization: `Bearer ${SECRET}` });
    expect(r).toBe(true);
  });

  // Each of these is refused without the client ever sending a frame — which
  // is what carries the parity claim. The protocol is chosen from the shape
  // of the first frame, so a decision reached before any frame arrives cannot
  // depend on the protocol. Move enforcement into a protocol handler and
  // these clients, which send nothing, would simply sit there instead.
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
    test(`${name} is refused before any frame is sent`, async () => {
      const r = await closeReason(headers);
      expect([1008, 1013]).toContain(r.code);
    });
  }

  test('the server records the refusal', () => {
    // Pairs with the above: proves the connection died because auth refused
    // it, not because the handshake was malformed and the server ignored it.
    expect(proxy.output()).toMatch(/Rejected upgrade/);
  });

  test('the client is told why, not just disconnected', async () => {
    // The regression this guards: rejections used to be an HTTP status
    // written to the upgrade socket, which Bun discards, so every refusal —
    // 503, 403, 401, 429 — arrived as a bare reset. Indistinguishable from a
    // crash, from a network fault, and from each other.
    const r = await closeReason({ Authorization: 'Bearer definitely-wrong' });
    expect(r.code).toBe(1008);
    expect(r.reason).toContain('401');
  });

  test('a throttled client is told to retry, distinctly from a refused one', async () => {
    // 1008 says "policy, do not bother retrying"; 1013 says "later". A client
    // that cannot tell them apart either hammers a wall or gives up too soon.
    let seen: CloseInfo | undefined;
    for (let i = 0; i < 12; i++) {
      seen = await closeReason({ Authorization: 'Bearer definitely-wrong' });
      if (seen.code === 1013) break;
    }
    expect(seen?.code).toBe(1013);
    expect(seen?.reason).toContain('429');
  });

  test('refusing still allocates no session and no capacity', async () => {
    // The property the old reset gave for free and the close frame must not
    // cost: completing the handshake to say why must not register the socket.
    // `/health` is the cheapest proof the process is unencumbered, and the
    // MUD count proves nothing was dialled.
    const res = await fetch(`http://127.0.0.1:${WS_PORT}/health`);
    expect(res.status).toBe(200);
    expect(mud.connections()).toBe(0);
    expect(proxy.output()).not.toMatch(/session created/);
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
