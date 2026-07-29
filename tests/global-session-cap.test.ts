/**
 * A global concurrent-session cap (MWP-92, criterion 3).
 *
 * `reservePendingDial` bounds connections per address. That leaves total
 * concurrency unbounded: the per-IP limit is only a limit if the attacker has
 * one address, and the cheapest thing an attacker has is more addresses. N
 * distinct sources each stay under maxPerIP and the process still exhausts
 * its sockets and memory.
 *
 * The global cap is checked at reservation time, before DNS and TCP, for the
 * same reason the per-IP one is: a check that happens after the expensive
 * work has started does not bound the expensive work.
 */

import { describe, expect, test } from 'bun:test';
import { SessionManager } from '../src/session-manager.js';
import { getRuntimeConfig } from '../src/runtime-config.js';

const mgr = (maxGlobal: number, maxPerIP = 100) =>
  new SessionManager({
    maxPerIP,
    maxPerDevice: 100,
    maxGlobal,
    timeoutHours: 24,
  });

describe('the global cap bounds total concurrency', () => {
  test('admits reservations up to the cap', () => {
    const m = mgr(3);
    expect(m.reservePendingDial('1.1.1.1').allowed).toBe(true);
    expect(m.reservePendingDial('2.2.2.2').allowed).toBe(true);
    expect(m.reservePendingDial('3.3.3.3').allowed).toBe(true);
  });

  test('refuses beyond the cap even from unrelated addresses', () => {
    // Each address is well under maxPerIP. Only a global bound stops this.
    const m = mgr(3);
    m.reservePendingDial('1.1.1.1');
    m.reservePendingDial('2.2.2.2');
    m.reservePendingDial('3.3.3.3');

    const result = m.reservePendingDial('4.4.4.4');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/capacity|global/i);
  });

  test('names the global dimension, not the per-IP one', () => {
    // The rejection reason is what an operator reads when diagnosing. Saying
    // "too many connections from this address" for a global exhaustion sends
    // them to investigate an innocent client.
    const m = mgr(1);
    m.reservePendingDial('1.1.1.1');
    expect(m.reservePendingDial('2.2.2.2').reason).not.toMatch(
      /from this address/i,
    );
  });

  test('counts established sessions toward the cap', () => {
    const m = mgr(2);
    m.incrementIPCount('1.1.1.1');
    m.incrementIPCount('2.2.2.2');
    expect(m.reservePendingDial('3.3.3.3').allowed).toBe(false);
  });

  test('counts pending and established together', () => {
    const m = mgr(2);
    m.incrementIPCount('1.1.1.1');
    expect(m.reservePendingDial('2.2.2.2').allowed).toBe(true);
    expect(m.reservePendingDial('3.3.3.3').allowed).toBe(false);
  });
});

describe('the per-IP cap still applies underneath', () => {
  test('a single address cannot consume the whole global budget', () => {
    const m = mgr(100, 2);
    expect(m.reservePendingDial('1.1.1.1').allowed).toBe(true);
    expect(m.reservePendingDial('1.1.1.1').allowed).toBe(true);
    const result = m.reservePendingDial('1.1.1.1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/from this address/i);
  });
});

describe('global capacity is released, not leaked', () => {
  test('a released reservation frees global capacity', () => {
    const m = mgr(1);
    m.reservePendingDial('1.1.1.1');
    expect(m.reservePendingDial('2.2.2.2').allowed).toBe(false);

    m.releasePendingDial('1.1.1.1');
    expect(m.reservePendingDial('2.2.2.2').allowed).toBe(true);
  });

  test('repeated failed dials do not erode the global budget', () => {
    // The decisive test named in the issue: capacity after N failures must
    // equal capacity before. A leaked global reservation is worse than a
    // leaked per-IP one — it denies service to every client, not one.
    const m = mgr(2);
    for (let i = 0; i < 50; i++) {
      expect(m.reservePendingDial(`10.0.0.${i % 7}`).allowed).toBe(true);
      m.releasePendingDial(`10.0.0.${i % 7}`);
    }
    expect(m.globalPending()).toBe(0);
    expect(m.reservePendingDial('1.1.1.1').allowed).toBe(true);
    expect(m.reservePendingDial('2.2.2.2').allowed).toBe(true);
    expect(m.reservePendingDial('3.3.3.3').allowed).toBe(false);
  });

  test('an unmatched release never creates capacity', () => {
    // Releasing more than was reserved must not push the counter negative,
    // which would silently raise the cap.
    const m = mgr(1);
    m.releasePendingDial('1.1.1.1');
    m.releasePendingDial('1.1.1.1');
    expect(m.globalPending()).toBe(0);

    m.reservePendingDial('1.1.1.1');
    expect(m.reservePendingDial('2.2.2.2').allowed).toBe(false);
  });
});

describe('the cap is off by default', () => {
  test('an unset global cap does not bound anything', () => {
    // Existing deployments must not acquire a surprise limit on upgrade; the
    // bound arrives when the operator configures it.
    const m = new SessionManager({ maxPerIP: 100, maxPerDevice: 100 });
    for (let i = 0; i < 200; i++) {
      expect(m.reservePendingDial(`10.1.${i % 5}.${i % 250}`).allowed).toBe(
        true,
      );
    }
  });
});

describe('session limits are configuration, not constants', () => {
  // They were hardcoded at wsproxy.ts:147-151, so an operator could not change
  // them and the config module did not report them — the centralization gap
  // MWP-80 exists to close.

  test('defaults preserve the previous hardcoded values', () => {
    const { sessions } = getRuntimeConfig({ INBOUND_TLS_MODE: 'off' });
    expect(sessions).toMatchObject({
      timeoutHours: 24,
      maxPerDevice: 5,
      maxPerIP: 10,
    });
    expect(sessions.maxGlobal).toBeUndefined();
  });

  test('every limit is settable', () => {
    const { sessions } = getRuntimeConfig({
      INBOUND_TLS_MODE: 'off',
      SESSION_TIMEOUT_HOURS: '6',
      MAX_SESSIONS_PER_DEVICE: '2',
      MAX_SESSIONS_PER_IP: '3',
      MAX_SESSIONS_GLOBAL: '500',
    });
    expect(sessions).toMatchObject({
      timeoutHours: 6,
      maxPerDevice: 2,
      maxPerIP: 3,
      maxGlobal: 500,
    });
  });

  test('a non-positive limit is a startup error, not a silent disable', () => {
    // Zero would read as "no connections allowed" or "unlimited" depending on
    // which comparison it meets. Neither is what an operator typing 0 means.
    for (const name of [
      'MAX_SESSIONS_GLOBAL',
      'MAX_SESSIONS_PER_IP',
      'MAX_SESSIONS_PER_DEVICE',
      'SESSION_TIMEOUT_HOURS',
    ]) {
      expect(() =>
        getRuntimeConfig({ INBOUND_TLS_MODE: 'off', [name]: '0' }),
      ).toThrow(new RegExp(name));
      expect(() =>
        getRuntimeConfig({ INBOUND_TLS_MODE: 'off', [name]: '-1' }),
      ).toThrow(new RegExp(name));
    }
  });
});

describe('a reservation is held until capacity is actually counted', () => {
  // Raised by Codex review of #72. The reservation was released the moment the
  // session object existed, but the established count only rises after
  // `await session.connect()` resolves. In between, an in-flight dial is
  // counted as neither pending nor established — so concurrent slow dials each
  // see spare capacity and pass. That is the exact hole the reservation exists
  // to close, reintroduced one layer up.

  test('handing off must not leave a gap in the total', () => {
    const m = mgr(1);
    m.reservePendingDial('1.1.1.1');

    // Simulate the handoff as the connect path performs it: count the
    // established session BEFORE dropping the reservation, so the running
    // total never dips and a concurrent reservation cannot slip through.
    m.incrementIPCount('1.1.1.1');
    m.releasePendingDial('1.1.1.1');

    expect(m.globalPending()).toBe(0);
    expect(m.reservePendingDial('2.2.2.2').allowed).toBe(false);
  });

  test('releasing before counting would admit an extra session', () => {
    // The ordering this guards against, stated explicitly: drop first and the
    // total momentarily reads zero.
    const m = mgr(1);
    m.reservePendingDial('1.1.1.1');
    m.releasePendingDial('1.1.1.1');
    expect(m.reservePendingDial('2.2.2.2').allowed).toBe(true);
  });
});

describe('fractional limits are rejected, not silently rounded', () => {
  // Raised by Codex review of #72. readOptionalIntegerEnv checked
  // Number.isFinite, so "1.5" was accepted despite the name promising an
  // integer. The comparison `total >= 1.5` then admits 2 — the configuration
  // says one thing and enforcement does another, the recurring defect class.

  test('MAX_SESSIONS_GLOBAL rejects a fraction', () => {
    expect(() =>
      getRuntimeConfig({
        INBOUND_TLS_MODE: 'off',
        MAX_SESSIONS_GLOBAL: '1.5',
      }),
    ).toThrow(/MAX_SESSIONS_GLOBAL/);
  });

  test('the same guard covers the other optional integers', () => {
    // The helper is shared by six push-timing settings; fixing it at the call
    // site would have left those accepting fractions.
    expect(() =>
      getRuntimeConfig({
        INBOUND_TLS_MODE: 'off',
        SILENT_PUSH_INTERVAL_MS: '1500.5',
      }),
    ).toThrow(/SILENT_PUSH_INTERVAL_MS/);
  });

  test('whole numbers are still accepted', () => {
    expect(
      getRuntimeConfig({ INBOUND_TLS_MODE: 'off', MAX_SESSIONS_GLOBAL: '12' })
        .sessions.maxGlobal,
    ).toBe(12);
  });
});
