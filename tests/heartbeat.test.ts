/**
 * Heartbeats reclaim capacity from dead connections (MWP-92, criterion 6).
 *
 * Without them a half-open connection — a laptop lid closed on a train, a NAT
 * that dropped the mapping silently — holds its session slot until the 24-hour
 * timeout. The peer is gone but the quota is not, so the caps added in #72
 * bound live clients while dead ones accumulate underneath.
 *
 * The liveness bookkeeping is separated from the socket so it can be tested
 * against a clock rather than against real timers. A test that has to wait
 * 30 seconds to observe a 30-second interval gets deleted or made
 * meaningless, and a fake socket only proves the fake responds.
 */

import { describe, expect, test } from 'bun:test';
import { HeartbeatMonitor } from '../src/heartbeat.js';
import { getRuntimeConfig } from '../src/runtime-config.js';

/** A monitor driven by an explicit clock. */
const monitor = (intervalMs = 1000, timeoutMs = 3000) => {
  let clock = 0;
  const m = new HeartbeatMonitor<string>({
    intervalMs,
    timeoutMs,
    now: () => clock,
  });
  return {
    m,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe('a responsive peer is never reclaimed', () => {
  test('a peer that answers stays tracked', () => {
    const { m, advance } = monitor();
    m.track('a');

    for (let i = 0; i < 10; i++) {
      advance(1000);
      m.markAlive('a');
      expect(m.sweep()).toEqual([]);
    }
    expect(m.size()).toBe(1);
  });

  test('answering just inside the timeout is enough', () => {
    const { m, advance } = monitor(1000, 3000);
    m.track('a');
    advance(2999);
    m.markAlive('a');
    advance(2999);
    expect(m.sweep()).toEqual([]);
  });
});

describe('an unresponsive peer is reclaimed', () => {
  test('silence beyond the timeout reports the peer as dead', () => {
    const { m, advance } = monitor(1000, 3000);
    m.track('a');
    advance(3001);
    expect(m.sweep()).toEqual(['a']);
  });

  test('a reclaimed peer is untracked, so it is reported once only', () => {
    // Reporting repeatedly would terminate an already-closed socket on every
    // tick and leak the entry forever.
    const { m, advance } = monitor(1000, 3000);
    m.track('a');
    advance(3001);
    expect(m.sweep()).toEqual(['a']);
    expect(m.sweep()).toEqual([]);
    expect(m.size()).toBe(0);
  });

  test('only the silent peers are reclaimed', () => {
    const { m, advance } = monitor(1000, 3000);
    m.track('quiet');
    m.track('chatty');

    advance(2000);
    m.markAlive('chatty');
    advance(2000);

    expect(m.sweep()).toEqual(['quiet']);
    expect(m.size()).toBe(1);
  });

  test('exactly at the timeout is not yet dead', () => {
    // A boundary that terminates on equality would reclaim a peer whose pong
    // is in flight.
    const { m, advance } = monitor(1000, 3000);
    m.track('a');
    advance(3000);
    expect(m.sweep()).toEqual([]);
  });
});

describe('bookkeeping does not leak', () => {
  test('untrack removes a peer', () => {
    const { m } = monitor();
    m.track('a');
    m.untrack('a');
    expect(m.size()).toBe(0);
  });

  test('untracking an unknown peer is harmless', () => {
    const { m } = monitor();
    m.untrack('never-seen');
    expect(m.size()).toBe(0);
  });

  test('markAlive on an untracked peer does not resurrect it', () => {
    // A pong arriving after close must not re-add an entry that nothing will
    // ever remove.
    const { m } = monitor();
    m.track('a');
    m.untrack('a');
    m.markAlive('a');
    expect(m.size()).toBe(0);
  });

  test('tracking the same peer twice keeps one entry', () => {
    const { m } = monitor();
    m.track('a');
    m.track('a');
    expect(m.size()).toBe(1);
  });
});

describe('configuration is validated at construction', () => {
  test('a timeout below the interval is rejected', () => {
    // It would reclaim every peer before the first ping could be answered.
    expect(
      () => new HeartbeatMonitor({ intervalMs: 5000, timeoutMs: 1000 }),
    ).toThrow(/timeout/i);
  });

  test('a non-positive interval is rejected', () => {
    expect(
      () => new HeartbeatMonitor({ intervalMs: 0, timeoutMs: 1000 }),
    ).toThrow(/interval/i);
  });
});

describe('heartbeat settings come from configuration', () => {
  const base = { INBOUND_TLS_MODE: 'off' };

  test('enabled by default, with a timeout allowing missed pings', () => {
    const { heartbeat } = getRuntimeConfig(base);
    expect(heartbeat.enabled).toBe(true);
    expect(heartbeat.intervalMs).toBeGreaterThan(0);
    // Room for more than one lost ping before a live peer is reclaimed.
    expect(heartbeat.timeoutMs).toBeGreaterThan(heartbeat.intervalMs * 2);
  });

  test('interval and timeout are settable', () => {
    const { heartbeat } = getRuntimeConfig({
      ...base,
      WS_HEARTBEAT_INTERVAL_MS: '5000',
      WS_HEARTBEAT_TIMEOUT_MS: '20000',
    });
    expect(heartbeat).toMatchObject({
      enabled: true,
      intervalMs: 5000,
      timeoutMs: 20000,
    });
  });

  test('it can be turned off', () => {
    expect(
      getRuntimeConfig({ ...base, WS_HEARTBEAT_ENABLED: 'false' }).heartbeat
        .enabled,
    ).toBe(false);
  });

  test('a timeout at or below the interval is a startup error', () => {
    // Accepting it would reclaim every peer on the first sweep — a config that
    // disconnects all clients should not start, not start and misbehave.
    expect(() =>
      getRuntimeConfig({
        ...base,
        WS_HEARTBEAT_INTERVAL_MS: '30000',
        WS_HEARTBEAT_TIMEOUT_MS: '30000',
      }),
    ).toThrow(/WS_HEARTBEAT_TIMEOUT_MS/);
  });

  test('a non-positive interval is a startup error', () => {
    expect(() =>
      getRuntimeConfig({ ...base, WS_HEARTBEAT_INTERVAL_MS: '0' }),
    ).toThrow(/WS_HEARTBEAT_INTERVAL_MS/);
  });
});
