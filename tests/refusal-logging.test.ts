/**
 * Every upgrade refusal says why, in the log (MWP-138).
 *
 * Found on a clean host during the MWP-123 step 4 install: a client with no
 * `Origin` header was correctly refused, and the journal recorded only
 *
 *     INFO [auth] Upgrade request peer=… path=/ requireAppAuth=false …
 *
 * and then nothing. Auth and App Attest refusals log a reason; origin and
 * draining refusals did not.
 *
 * That asymmetry got worse with MWP-136. The client is now told
 * `close=1008, reason="403 Forbidden"` — so the person hitting the wall knew
 * more than the operator who could move it, which is backwards.
 *
 * Asserted against a running process rather than by reading the source. The
 * property is "this binary, refusing this connection, wrote a usable line",
 * and a unit test of a logging helper is green whether or not the refusal
 * path calls it — the exact failure mode MWP-122 was written to stop.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import WebSocket from 'ws';
import {
  startMockMud,
  startProxy,
  type MockMud,
  type RunningProxy,
} from './process-harness.js';

const WS_PORT = 6241;
const MUD_PORT = 6242;
const ALLOWED = 'https://allowed.example';

let proxy: RunningProxy;
let mud: MockMud;

/** Open with the given headers and wait for the connection to settle. */
function attempt(
  headers: Record<string, string>,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/`, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(undefined);
    }, 8000);
    ws.on('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on('error', () => {
      // The close event still arrives and resolves this.
    });
  });
}

beforeAll(async () => {
  mud = await startMockMud(MUD_PORT);
  proxy = await startProxy(WS_PORT, {
    TN_HOST: '127.0.0.1',
    TN_PORT: String(MUD_PORT),
    TARGET_MODE: 'fixed',
    ALLOWED_ORIGINS: ALLOWED,
  });
}, 45000);

afterAll(async () => {
  await proxy?.stop();
  await mud?.stop();
});

describe('an origin refusal is recorded', () => {
  test('a wrong origin is logged with the value that was received', async () => {
    await attempt({ Origin: 'https://wrong.example' });
    const out = proxy.output();
    expect(out).toMatch(/Rejected upgrade: origin not allowed/);
    // The received value is the diagnostic. Without it the operator learns
    // only that *some* origin failed, which they already knew.
    expect(out).toContain('https://wrong.example');
  });

  test('a missing origin is distinguishable from a wrong one', async () => {
    // These have different fixes — one is a misconfigured client, the other
    // a non-browser client or ALLOW_MISSING_ORIGIN — so one message for both
    // would send the operator down the wrong path.
    await attempt({});
    expect(proxy.output()).toMatch(
      /Rejected upgrade: origin not allowed \(received <missing>\)/,
    );
  });

  test('the allowed origin is admitted, so the test is not trivially green', async () => {
    // Without this, every assertion above passes on a proxy that refuses
    // everything for some unrelated reason.
    const before = proxy.output().length;
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/`, {
      headers: { Origin: ALLOWED },
    });
    const opened = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 8000);
      ws.on('open', () => {
        clearTimeout(t);
        resolve(true);
      });
      ws.on('error', () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    ws.terminate();
    expect(opened).toBe(true);
    // And it produced no refusal line of its own.
    expect(proxy.output().slice(before)).not.toMatch(/origin not allowed/);
  });
});

describe('the refusal goes through the central logger', () => {
  test('the line carries the standard timestamp and level', () => {
    // Why this rather than a log-injection test: control characters cannot
    // reach this line. Checked with a raw handshake rather than assumed —
    // an `Origin` carrying ESC is rejected by the HTTP parser before the
    // upgrade event fires, so no refusal is even logged. Asserting
    // neutralisation here would have been guarding an unreachable attack.
    //
    // What is worth pinning is the routing. `srv.log` applies
    // `redactLogMessage`, which is where secrets and control sequences are
    // handled; a `console.log` added later would look fine and silently sit
    // outside all of it. The timestamp-and-level prefix is the observable
    // difference — the `[app-attest]` warnings in MWP-137 were spotted in
    // production precisely because they lacked it.
    expect(proxy.output()).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+WARN\s+\[auth] Rejected upgrade: origin not allowed/m,
    );
  });
});

describe('the refusal reaches the client too', () => {
  test('an origin refusal closes with 1008', async () => {
    // Pairs with the log assertions: MWP-136 gave the client a reason, and
    // MWP-138 gave the operator one. Both halves, or neither is much use.
    const code = await attempt({ Origin: 'https://wrong.example' });
    expect(code).toBe(1008);
  });
});
