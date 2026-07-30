/**
 * Ordered, bounded, idempotent shutdown (MWP-96).
 *
 * The ordering is the whole point, and it is the part that has no natural test
 * if it lives inline in a signal handler. Extracted here so the sequence can be
 * asserted without sockets, signals, or real time.
 *
 * What makes a restart safe under a load balancer is not "close everything" but
 * *when* each thing closes: become unready, wait long enough for the balancer to
 * notice, and only then take capacity away. Skipping that wait is the common
 * cause of errors during a deploy — the process stops accepting while traffic is
 * still being routed to it.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { ShutdownCoordinator } from '../src/shutdown.js';
import { getRuntimeConfig } from '../src/runtime-config.js';

/** Records step order and lets individual steps hang or throw. */
const recorder = () => {
  const order: string[] = [];
  return {
    order,
    step: (name: string, behaviour?: 'hang' | 'throw') => ({
      name,
      run: async () => {
        order.push(name);
        if (behaviour === 'hang') await new Promise<void>(() => {});
        if (behaviour === 'throw') throw new Error(`${name} failed`);
      },
    }),
  };
};

describe('steps run in the declared order', () => {
  test('every step runs, in sequence', async () => {
    const r = recorder();
    const outcomes: string[] = [];

    const c = new ShutdownCoordinator({
      steps: [r.step('unready'), r.step('reject'), r.step('close')],
      deadlineMs: 1000,
      onComplete: (reason) => outcomes.push(reason),
    });

    await c.start();
    expect(r.order).toEqual(['unready', 'reject', 'close']);
    expect(outcomes).toEqual(['completed']);
  });

  test('a step that throws does not abandon the rest', async () => {
    // A drain is best-effort. Aborting because one socket refused to close
    // would leave listeners bound and state unflushed.
    const r = recorder();
    const c = new ShutdownCoordinator({
      steps: [r.step('first'), r.step('boom', 'throw'), r.step('third')],
      deadlineMs: 1000,
      onComplete: () => {},
    });

    await c.start();
    expect(r.order).toEqual(['first', 'boom', 'third']);
  });
});

describe('the deadline is absolute', () => {
  test('a hung step does not prevent completion', async () => {
    // The property that matters most: an orchestrator killing a container that
    // will not exit is a worse outcome than dropping a connection early.
    const r = recorder();
    const outcomes: string[] = [];

    const c = new ShutdownCoordinator({
      steps: [r.step('fine'), r.step('hangs', 'hang'), r.step('never')],
      deadlineMs: 50,
      onComplete: (reason) => outcomes.push(reason),
    });

    await c.start();
    expect(outcomes).toEqual(['deadline']);
    expect(r.order).toEqual(['fine', 'hangs']);
  });

  test('completing before the deadline reports completion, not timeout', async () => {
    const r = recorder();
    const outcomes: string[] = [];

    const c = new ShutdownCoordinator({
      steps: [r.step('quick')],
      deadlineMs: 5000,
      onComplete: (reason) => outcomes.push(reason),
    });

    await c.start();
    expect(outcomes).toEqual(['completed']);
  });

  test('onComplete fires exactly once even when a step hangs', async () => {
    // Both the deadline timer and the step runner can reach the end; firing
    // twice would call process.exit twice.
    const r = recorder();
    let calls = 0;

    const c = new ShutdownCoordinator({
      steps: [r.step('hangs', 'hang')],
      deadlineMs: 30,
      onComplete: () => calls++,
    });

    await c.start();
    await new Promise((res) => setTimeout(res, 80));
    expect(calls).toBe(1);
  });
});

describe('a repeated signal is ignored', () => {
  test('a second start does not re-run the steps', async () => {
    // Operators and orchestrators both send more than one signal. Re-running
    // would restart the drain and, worse, reset the deadline.
    const r = recorder();
    const c = new ShutdownCoordinator({
      steps: [r.step('once')],
      deadlineMs: 1000,
      onComplete: () => {},
    });

    await c.start();
    await c.start();
    await c.start();

    expect(r.order).toEqual(['once']);
  });

  test('a second signal mid-drain does not extend the deadline', async () => {
    const r = recorder();
    const outcomes: string[] = [];
    const c = new ShutdownCoordinator({
      steps: [r.step('hangs', 'hang')],
      deadlineMs: 40,
      onComplete: (reason) => outcomes.push(reason),
    });

    void c.start();
    await new Promise((res) => setTimeout(res, 20));
    void c.start(); // would push the deadline out if it restarted anything
    await new Promise((res) => setTimeout(res, 60));

    expect(outcomes).toEqual(['deadline']);
  });

  test('isShuttingDown reports the state for other code to consult', () => {
    const r = recorder();
    const c = new ShutdownCoordinator({
      steps: [r.step('x')],
      deadlineMs: 1000,
      onComplete: () => {},
    });

    expect(c.isShuttingDown()).toBe(false);
    void c.start();
    expect(c.isShuttingDown()).toBe(true);
  });
});

describe('progress is observable', () => {
  test('each step is logged, so a stuck drain can be diagnosed', () => {
    // Without this an operator watching a container refuse to exit has no idea
    // which step is hanging.
    const r = recorder();
    const logged: string[] = [];

    const c = new ShutdownCoordinator({
      steps: [r.step('alpha'), r.step('beta')],
      deadlineMs: 1000,
      onComplete: () => {},
      log: (m) => logged.push(m),
    });

    return c.start().then(() => {
      expect(logged.join(' ')).toContain('alpha');
      expect(logged.join(' ')).toContain('beta');
    });
  });
});

describe('shutdown configuration is validated as a pair', () => {
  // Raised by Codex review of #79. The two values were accepted independently,
  // so a 20s grace against the 15s default deadline let the deadline fire while
  // still waiting — demonstrated as a real process: the log stopped after
  // "await 4000ms drain grace" and went straight to "deadline". No client close,
  // no session cleanup, no key flush, no listener close. A configuration that
  // silently defeats the entire ordered shutdown must not start.

  test('a deadline at or below the grace period is a startup error', () => {
    expect(() =>
      getRuntimeConfig({
        INBOUND_TLS_MODE: 'off',
        SHUTDOWN_GRACE_MS: '20000',
      }),
    ).toThrow(/SHUTDOWN_DEADLINE_MS/);

    expect(() =>
      getRuntimeConfig({
        INBOUND_TLS_MODE: 'off',
        SHUTDOWN_GRACE_MS: '5000',
        SHUTDOWN_DEADLINE_MS: '5000',
      }),
    ).toThrow(/SHUTDOWN_DEADLINE_MS/);
  });

  test('the error names both values, so the fix is obvious', () => {
    expect(() =>
      getRuntimeConfig({
        INBOUND_TLS_MODE: 'off',
        SHUTDOWN_GRACE_MS: '20000',
      }),
    ).toThrow(/SHUTDOWN_GRACE_MS/);
  });

  test('a valid pair is accepted', () => {
    const { shutdown } = getRuntimeConfig({
      INBOUND_TLS_MODE: 'off',
      SHUTDOWN_GRACE_MS: '2000',
      SHUTDOWN_DEADLINE_MS: '9000',
    });
    expect(shutdown).toEqual({ gracePeriodMs: 2000, deadlineMs: 9000 });
  });
});

describe('state is flushed after the listener closes', () => {
  // Also raised by Codex review of #79, and it contradicts the order MWP-96
  // prescribes. Flushing before closing let an App Attest registration still
  // being verified update the key store *after* the flush, then schedule a
  // debounced save that never fired because the process exited. The issue's
  // step order is wrong on the merits; nothing must be able to mutate the
  // store once it has been written.

  test('close listener precedes flush in the wired sequence', () => {
    const proxy = readFileSync('wsproxy.ts', 'utf8');
    const closeAt = proxy.indexOf("name: 'close listener'");
    const flushAt = proxy.indexOf("name: 'flush attested keys'");

    expect(closeAt).toBeGreaterThan(-1);
    expect(flushAt).toBeGreaterThan(-1);
    expect(closeAt).toBeLessThan(flushAt);
  });
});
