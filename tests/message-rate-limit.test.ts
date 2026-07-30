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
    { perSessionPerSecond: perSession, perAddressPerSecond: perAddress },
    { now: () => clock },
  );
  return { l, advance: (ms: number) => (clock += ms) };
};

describe('a client within its allowance is never throttled', () => {
  test('messages up to the limit are allowed', () => {
    const { l } = limiter(5, 100);
    for (let i = 0; i < 5; i++) {
      expect(l.check('sess-1', '1.1.1.1').allowed).toBe(true);
    }
  });

  test('the allowance refreshes as the window slides', () => {
    const { l, advance } = limiter(3, 100);
    for (let i = 0; i < 3; i++) l.check('sess-1', '1.1.1.1');
    expect(l.check('sess-1', '1.1.1.1').allowed).toBe(false);

    advance(1001);
    expect(l.check('sess-1', '1.1.1.1').allowed).toBe(true);
  });
});

describe('the per-session limit bites', () => {
  test('exceeding it is refused and names the session dimension', () => {
    // The dimension is what an operator reads when diagnosing. Reporting a
    // session breach as an address breach sends them after the wrong client.
    const { l } = limiter(2, 100);
    l.check('sess-1', '1.1.1.1');
    l.check('sess-1', '1.1.1.1');

    const decision = l.check('sess-1', '1.1.1.1');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.dimension).toBe('session');
  });

  test('one noisy session does not throttle another on the same address', () => {
    const { l } = limiter(2, 100);
    l.check('sess-1', '1.1.1.1');
    l.check('sess-1', '1.1.1.1');
    expect(l.check('sess-1', '1.1.1.1').allowed).toBe(false);

    expect(l.check('sess-2', '1.1.1.1').allowed).toBe(true);
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
        if (l.check(`sess-${s}`, '9.9.9.9').allowed) allowed++;
      }
    }

    expect(allowed).toBe(12);
  });

  test('the refusal names the address dimension', () => {
    const { l } = limiter(10, 2);
    l.check('sess-1', '9.9.9.9');
    l.check('sess-2', '9.9.9.9');

    const decision = l.check('sess-3', '9.9.9.9');
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

describe('a client with no session is still limited', () => {
  test('the legacy protocol, which has no session, is bounded by address', () => {
    // Legacy raw-telnet connections have no Session. Skipping the check for
    // them would leave the older protocol as the unlimited one.
    const { l } = limiter(10, 3);
    for (let i = 0; i < 3; i++) {
      expect(l.check(undefined, '5.5.5.5').allowed).toBe(true);
    }
    expect(l.check(undefined, '5.5.5.5').allowed).toBe(false);
  });
});

describe('the client is told once, not once per dropped frame', () => {
  test('only the first refusal in a window asks for a notification', () => {
    // Replying to every dropped frame would amplify outbound traffic during
    // exactly the flood the limiter exists to damp — the limiter becoming the
    // denial of service.
    const { l } = limiter(1, 100);
    l.check('sess-1', '1.1.1.1');

    const first = l.check('sess-1', '1.1.1.1');
    const second = l.check('sess-1', '1.1.1.1');
    const third = l.check('sess-1', '1.1.1.1');

    expect(first.allowed).toBe(false);
    if (!first.allowed) expect(first.notify).toBe(true);
    if (!second.allowed) expect(second.notify).toBe(false);
    if (!third.allowed) expect(third.notify).toBe(false);
  });

  test('a later window notifies again, so a recurring problem stays visible', () => {
    const { l, advance } = limiter(1, 100);
    l.check('sess-1', '1.1.1.1');
    const first = l.check('sess-1', '1.1.1.1');
    if (!first.allowed) expect(first.notify).toBe(true);

    advance(5000);
    l.check('sess-1', '1.1.1.1');
    const later = l.check('sess-1', '1.1.1.1');
    expect(later.allowed).toBe(false);
    if (!later.allowed) expect(later.notify).toBe(true);
  });
});

describe('bookkeeping is bounded and released', () => {
  test('many distinct sessions do not grow without bound', () => {
    // A client that rotates session ids must not be able to grow the limiter's
    // own memory — the limiter would become the leak.
    //
    // 15k rather than 50k iterations: comfortably past the 10k cap, while not
    // timing out under coverage instrumentation in the full suite. A test that
    // only passes on an idle machine is a flaky test.
    const { l } = limiter(5, 100000);
    for (let i = 0; i < 15_000; i++) l.check(`sess-${i}`, '1.1.1.1');
    expect(l.trackedSessions()).toBeLessThanOrEqual(10_000);
  });
});
