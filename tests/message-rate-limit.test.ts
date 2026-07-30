/**
 * Per-session and per-address message rate limits (MWP-124).
 *
 * Everything merged for MWP-92 bounds *connections*. Nothing bounded *rate*: a
 * client inside every connection cap could send frames as fast as the socket
 * allowed, and each `input` frame becomes a telnet write — so the first
 * casualty is the upstream MUD, whose own flood protection sees one abusive
 * address, ours. `AUTH_MODE=shared-secret` does not help, because it proves a
 * client is entitled to connect, not that it is behaving.
 *
 * Two dimensions, because either alone is trivially defeated: a per-session
 * limit is bypassed by opening several sessions, and a per-address limit alone
 * punishes a legitimate multi-session user. Both, with the address budget the
 * larger.
 *
 * Driven by an injected clock. A rate limiter tested against real time either
 * sleeps for whole seconds or asserts nothing.
 */

import { describe, expect, test } from 'bun:test';
import { MessageRateLimiter } from '../src/message-rate-limit.js';

const limiter = (perSession: number, perAddress: number) => {
  let clock = 0;
  const l = new MessageRateLimiter(
    { perConnectionPerSecond: perSession, perAddressPerSecond: perAddress },
    { now: () => clock },
  );
  return { l, advance: (ms: number) => (clock += ms) };
};

describe('a client within its allowance is never throttled', () => {
  test('messages up to the limit are allowed', () => {
    const { l } = limiter(5, 100);
    for (let i = 0; i < 5; i++) {
      expect(l.check('conn-1', '1.1.1.1').allowed).toBe(true);
    }
  });

  test('the allowance refreshes as the window slides', () => {
    const { l, advance } = limiter(3, 100);
    for (let i = 0; i < 3; i++) l.check('conn-1', '1.1.1.1');
    expect(l.check('conn-1', '1.1.1.1').allowed).toBe(false);

    advance(1001);
    expect(l.check('conn-1', '1.1.1.1').allowed).toBe(true);
  });
});

describe('the per-connection limit bites', () => {
  test('exceeding it is refused and names the connection dimension', () => {
    // The dimension is what an operator reads when diagnosing. Reporting a
    // session breach as an address breach sends them after the wrong client.
    const { l } = limiter(2, 100);
    l.check('conn-1', '1.1.1.1');
    l.check('conn-1', '1.1.1.1');

    const decision = l.check('conn-1', '1.1.1.1');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.dimension).toBe('connection');
  });

  test('one noisy session does not throttle another on the same address', () => {
    const { l } = limiter(2, 100);
    l.check('conn-1', '1.1.1.1');
    l.check('conn-1', '1.1.1.1');
    expect(l.check('conn-1', '1.1.1.1').allowed).toBe(false);

    expect(l.check('conn-2', '1.1.1.1').allowed).toBe(true);
  });
});

describe('opening more sessions does not buy more throughput', () => {
  test('the address budget is the binding constraint', () => {
    // The bypass the per-address dimension exists to close: without it, N
    // sessions multiply a per-session allowance by N.
    const { l } = limiter(10, 12);

    let allowed = 0;
    for (let s = 0; s < 20; s++) {
      for (let i = 0; i < 10; i++) {
        if (l.check(`conn-${s}`, '9.9.9.9').allowed) allowed++;
      }
    }

    expect(allowed).toBe(12);
  });

  test('the refusal names the address dimension', () => {
    const { l } = limiter(10, 2);
    l.check('conn-1', '9.9.9.9');
    l.check('conn-2', '9.9.9.9');

    const decision = l.check('conn-3', '9.9.9.9');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.dimension).toBe('address');
  });

  test('a different address has its own budget', () => {
    const { l } = limiter(10, 2);
    l.check('a', '1.1.1.1');
    l.check('b', '1.1.1.1');
    expect(l.check('c', '1.1.1.1').allowed).toBe(false);

    expect(l.check('d', '2.2.2.2').allowed).toBe(true);
  });
});

describe('both wire protocols get both dimensions', () => {
  // Raised by Codex review of #80, and an earlier version of this file blessed
  // the gap: the limiter keyed the second dimension on the session id, which a
  // legacy raw-telnet connection never has. Legacy traffic was therefore bound
  // only by the address allowance — 240/second against the 60/second the
  // per-connection limit advertises, and further apart under a custom address
  // budget. MWP-90 established that both protocols get identical policy.
  //
  // Keying on the connection rather than the session fixes it for both, and
  // avoids a client's key changing mid-connection when its session appears.

  test('a connection with no session is still bound by the smaller limit', () => {
    const { l } = limiter(3, 100);
    for (let i = 0; i < 3; i++) {
      expect(l.check('conn:7', '5.5.5.5').allowed).toBe(true);
    }
    const decision = l.check('conn:7', '5.5.5.5');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.dimension).toBe('connection');
  });

  test('a connection over its own limit does not burn its siblings budget', () => {
    // Addresses are shared routinely, by NAT and CGNAT. If a frame refused on
    // connection grounds still consumed address budget, one abusive client would
    // throttle innocent players behind the same address. Writing this test the
    // other way round is what surfaced it.
    const { l } = limiter(2, 3);
    l.check('conn:1', '5.5.5.5'); // conn 1/2, addr 1/3
    l.check('conn:1', '5.5.5.5'); // conn 2/2, addr 2/3
    expect(l.check('conn:1', '5.5.5.5').allowed).toBe(false); // conn refused

    // The refused frame must not have taken the third address slot.
    expect(l.check('conn:2', '5.5.5.5').allowed).toBe(true);
  });

  test('but reconnecting still cannot exceed the address budget', () => {
    const { l } = limiter(10, 3);
    expect(l.check('conn:1', '5.5.5.5').allowed).toBe(true);
    expect(l.check('conn:2', '5.5.5.5').allowed).toBe(true);
    expect(l.check('conn:3', '5.5.5.5').allowed).toBe(true);

    const decision = l.check('conn:4', '5.5.5.5');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.dimension).toBe('address');
  });
});

describe('the client is told once, not once per dropped frame', () => {
  test('only the first refusal in a window asks for a notification', () => {
    // Replying to every dropped frame would amplify outbound traffic during
    // exactly the flood the limiter exists to damp — the limiter becoming the
    // denial of service.
    const { l } = limiter(1, 100);
    l.check('conn-1', '1.1.1.1');

    const first = l.check('conn-1', '1.1.1.1');
    const second = l.check('conn-1', '1.1.1.1');
    const third = l.check('conn-1', '1.1.1.1');

    expect(first.allowed).toBe(false);
    if (!first.allowed) expect(first.notify).toBe(true);
    if (!second.allowed) expect(second.notify).toBe(false);
    if (!third.allowed) expect(third.notify).toBe(false);
  });

  test('a later window notifies again, so a recurring problem stays visible', () => {
    const { l, advance } = limiter(1, 100);
    l.check('conn-1', '1.1.1.1');
    const first = l.check('conn-1', '1.1.1.1');
    if (!first.allowed) expect(first.notify).toBe(true);

    advance(5000);
    l.check('conn-1', '1.1.1.1');
    const later = l.check('conn-1', '1.1.1.1');
    expect(later.allowed).toBe(false);
    if (!later.allowed) expect(later.notify).toBe(true);
  });
});

describe('bookkeeping is bounded and released', () => {
  test('many distinct connections do not grow without bound', () => {
    // A client that reconnects rapidly must not be able to grow the limiter's
    // own memory — the limiter would become the leak.
    //
    // 15k rather than 50k iterations: comfortably past the 10k cap, while not
    // timing out under coverage instrumentation in the full suite. A test that
    // only passes on an idle machine is a flaky test.
    const { l } = limiter(5, 100000);
    for (let i = 0; i < 15_000; i++) l.check(`conn-${i}`, '1.1.1.1');
    expect(l.trackedConnections()).toBeLessThanOrEqual(10_000);
  });
});
