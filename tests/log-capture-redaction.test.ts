/**
 * Redaction, asserted against a running process (MWP-122, area 9).
 *
 * `tests/log-redaction.test.ts` covers `redactLogMessage()` as a unit, plus a
 * set of source greps. Both are worth having and neither can see the property
 * that actually matters to an operator: *this binary, with these settings,
 * under this traffic, wrote no secret to its log.* That depends on wiring —
 * on `logSecrets()` carrying the configured values, and on every log path
 * going through `srv.log()` rather than a private `console.log`. A unit test
 * of the helper is green whether or not anything calls it.
 *
 * The sentinels are English, not entropy. A realistic-looking key here would
 * be indistinguishable from a real one to a secret scanner — gitleaks flagged
 * exactly that shape in `log-redaction.test.ts` once — and allowlisting it
 * teaches the scanner to ignore the thing it exists to find.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import WebSocket from 'ws';
import {
  startMockMud,
  startProxy,
  type MockMud,
  type RunningProxy,
} from './process-harness.js';

const WS_PORT = 6231;
const MUD_PORT = 6232;

// >= 32 UTF-16 code units, which AUTH_MODE=shared-secret requires.
const SHARED_SECRET = 'SENTINEL-shared-secret-never-log-this-value';
const ADMIN_TOKEN = 'SENTINEL-admin-token-never-log-this-value';
const WRONG_SECRET = 'SENTINEL-wrong-secret-never-log-this-value';
const PLAYER_INPUT = 'SENTINEL-player-typed-this-at-a-prompt';

/** Every value that must never reach the transcript, with why it is here. */
const FORBIDDEN: ReadonlyArray<[string, string]> = [
  [SHARED_SECRET, 'the configured shared secret'],
  [ADMIN_TOKEN, 'the configured admin token'],
  [WRONG_SECRET, 'a credential someone supplied — wrong, but still a secret'],
  [PLAYER_INPUT, 'what a player typed, which may be their password'],
];

let proxy: RunningProxy;
let mud: MockMud;

const settle = (ms = 700): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Open a socket with real headers; Bun's built-in WebSocket cannot set them. */
function open(url: string, headers: Record<string, string> = {}) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => reject(new Error('open timeout')), 8000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

beforeAll(async () => {
  mud = await startMockMud(MUD_PORT);
  proxy = await startProxy(WS_PORT, {
    TN_HOST: '127.0.0.1',
    TN_PORT: String(MUD_PORT),
    // Debug is the point. Redaction that only holds at the default level is
    // not redaction — an operator raising verbosity to diagnose an incident
    // is exactly when a leak would happen and exactly when logs get shared.
    LOG_LEVEL: 'debug',
    AUTH_MODE: 'shared-secret',
    PROXY_SHARED_SECRET: SHARED_SECRET,
    // Puts the secret in the request line, so it reaches the upgrade log
    // through `req.url` as well as through the Authorization header.
    AUTH_ALLOW_QUERY_SECRET: 'true',
    ADMIN_TOKEN,
  });

  // --- drive every path that handles a secret or player input -------------

  // 1. Authorized upgrade, carrying the secret in a header.
  const authed = await open(`ws://127.0.0.1:${WS_PORT}/`, {
    Authorization: `Bearer ${SHARED_SECRET}`,
  });
  authed.send(
    JSON.stringify({ type: 'connect', host: '127.0.0.1', port: MUD_PORT }),
  );
  await settle();

  // 2. Player input over a live session. This is the one that used to be
  //    logged verbatim whenever ECHO detection failed to spot a password
  //    prompt, which is a best-effort heuristic.
  authed.send(JSON.stringify({ type: 'input', text: `${PLAYER_INPUT}\r\n` }));
  await settle();
  authed.close();

  // 2b. The same over the legacy protocol, which is not a formality: player
  //     input on the typed path goes through the session stack, while legacy
  //     goes through `forward()` — the function that used to log the bytes
  //     themselves, gated on a best-effort ECHO heuristic. Different code,
  //     so it needs its own evidence.
  const legacy = await open(`ws://127.0.0.1:${WS_PORT}/`, {
    Authorization: `Bearer ${SHARED_SECRET}`,
  });
  legacy.send(
    JSON.stringify({ connect: 1, host: '127.0.0.1', port: MUD_PORT }),
  );
  await settle();
  legacy.send(`${PLAYER_INPUT}\r\n`);
  await settle();
  legacy.close();

  // 3. Authorized upgrade, carrying the secret in the query string.
  const viaQuery = await open(
    `ws://127.0.0.1:${WS_PORT}/?secret=${encodeURIComponent(SHARED_SECRET)}`,
  );
  await settle(300);
  viaQuery.close();

  // 4. A rejected attempt. The supplied value is attacker-controlled and is
  //    still a credential — often a real one, sent to the wrong place.
  await open(`ws://127.0.0.1:${WS_PORT}/`, {
    Authorization: `Bearer ${WRONG_SECRET}`,
  }).catch(() => undefined);
  await settle(300);

  // 5. A diagnostics request presenting the admin token.
  await fetch(`http://127.0.0.1:${WS_PORT}/health`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  }).catch(() => undefined);
  await settle(300);
}, 45000);

afterAll(async () => {
  await proxy?.stop();
  await mud?.stop();
});

describe('the captured transcript is worth asserting over', () => {
  // Without these, every assertion below passes on an empty string. That is
  // the failure mode this whole file exists to avoid, so it is checked first.

  test('the proxy logged a substantial amount', () => {
    expect(proxy.output().length).toBeGreaterThan(500);
  });

  test('it logged the upgrade requests the secrets travelled on', () => {
    expect(proxy.output()).toContain('Upgrade request');
  });

  test('it logged the rejection, so the wrong secret was really handled', () => {
    expect(proxy.output()).toMatch(/Rejected upgrade/);
  });

  test('debug-level logging was actually in effect', () => {
    // If LOG_LEVEL were ignored, the quietest possible transcript would pass
    // the redaction assertions for the wrong reason. The first version of
    // this asserted only that some line said DEBUG, and it failed: the typed
    // path emits none. `forward:` is the specific debug line that sits on the
    // path where player input used to be logged verbatim, so requiring it
    // proves both that the level took effect and that the leaky path ran.
    expect(proxy.output()).toMatch(/DEBUG/);
    expect(proxy.output()).toMatch(/forward: \d+ bytes/);
  });

  test('both protocols really carried the player input to the MUD', () => {
    // Proves the sentinel reached the data plane. If it never got that far,
    // "it does not appear in the log" is trivially true. Twice, because the
    // typed and legacy sessions each sent it.
    const hits = mud.received().split(PLAYER_INPUT).length - 1;
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});

describe('no sentinel reaches the log', () => {
  for (const [value, why] of FORBIDDEN) {
    test(`${why} is absent`, () => {
      const transcript = proxy.output();
      expect(transcript).not.toContain(value);
    });
  }

  test('no long fragment of a secret survives either', () => {
    // Truncation is the recurring near-miss in this codebase: seven separate
    // sites had rolled their own `slice(0, 8)`. A prefix of a credential is
    // credential material, so check for one directly.
    const transcript = proxy.output();
    for (const [value] of FORBIDDEN) {
      expect(transcript).not.toContain(value.slice(0, 16));
    }
  });
});
