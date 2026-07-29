/**
 * Reclaiming slots from sessions nobody is attached to (MWP-92, criterion 6).
 *
 * Raised by Codex review of #75. Terminating an unresponsive socket does not
 * free its session slot: `handleSocketClose` deliberately detaches and leaves
 * the session — and its per-IP and global capacity — alive so a client can
 * resume. So the heartbeat killed dead transports while the quota they held
 * stayed held until SESSION_TIMEOUT_HOURS, which is 24 hours by default.
 *
 * Destroying the session the moment a heartbeat expires is not the answer
 * either: a backgrounded mobile client is in exactly that state, and silent
 * push runs every 20 minutes, so a short reap would delete the session before
 * the push that would have woken it to resume.
 *
 * Hence a grace window: the transport dies immediately, the session survives
 * clientless long enough for a realistic resume, and only then is its capacity
 * reclaimed.
 */

import { describe, expect, test } from 'bun:test';
import { SessionManager } from '../src/session-manager.js';
import type { SocketExtended } from '../src/types/index.js';

const socket = () => ({ readyState: 1 }) as unknown as SocketExtended;

const managerWith = (graceMs: number) =>
  new SessionManager({
    maxPerIP: 10,
    maxPerDevice: 10,
    maxGlobal: 3,
    timeoutHours: 24,
    resumeGraceMs: graceMs,
  });

/** A session that has been created, counted, then left with no clients. */
function clientlessSession(m: SessionManager, ip = '1.1.1.1') {
  const s = m.create('mud.example.org', 4000);
  const ws = socket();
  m.attachWebSocket(s.id, ws);
  s.clientIp = ip;
  m.incrementIPCount(ip);
  m.detachWebSocket(ws);
  return s;
}

describe('a clientless session keeps its slot during the grace window', () => {
  test('it is not reaped immediately', () => {
    const m = managerWith(60_000);
    const s = clientlessSession(m);

    expect(m.reapClientlessSessions(Date.now())).toBe(0);
    expect(m.get(s.id)).toBeDefined();
    m.shutdown?.();
  });

  test('capacity is still accounted for, so resume is possible', () => {
    const m = managerWith(60_000);
    clientlessSession(m, '1.1.1.1');
    expect(m.globalPending()).toBe(0);
    // The slot is still held: that is the point of the window.
    expect(m.reservePendingDial('2.2.2.2').allowed).toBe(true);
    m.shutdown?.();
  });
});

describe('after the window the slot is reclaimed', () => {
  test('the session is removed once the window has elapsed', () => {
    const m = managerWith(60_000);
    const s = clientlessSession(m);

    expect(m.reapClientlessSessions(Date.now() + 60_001)).toBe(1);
    expect(m.get(s.id)).toBeUndefined();
    m.shutdown?.();
  });

  test('reaping releases per-IP and global capacity', () => {
    // The whole reason this exists: without it, the caps bound live clients
    // while dead sessions accumulate underneath.
    const m = managerWith(60_000);
    clientlessSession(m, '1.1.1.1');
    clientlessSession(m, '2.2.2.2');
    clientlessSession(m, '3.3.3.3');

    // Global cap of 3 is now fully consumed by sessions nobody is attached to.
    expect(m.reservePendingDial('4.4.4.4').allowed).toBe(false);

    expect(m.reapClientlessSessions(Date.now() + 60_001)).toBe(3);
    expect(m.reservePendingDial('4.4.4.4').allowed).toBe(true);
    m.shutdown?.();
  });

  test('exactly at the window is not yet reaped', () => {
    const m = managerWith(60_000);
    clientlessSession(m);
    expect(m.reapClientlessSessions(Date.now() + 60_000)).toBe(0);
    m.shutdown?.();
  });
});

describe('sessions with clients are never reaped', () => {
  test('an attached session survives indefinitely', () => {
    const m = managerWith(60_000);
    const s = m.create('mud.example.org', 4000);
    m.attachWebSocket(s.id, socket());

    expect(m.reapClientlessSessions(Date.now() + 86_400_000)).toBe(0);
    expect(m.get(s.id)).toBeDefined();
    m.shutdown?.();
  });

  test('reattaching within the window cancels the reap', () => {
    // A client woken by silent push and resuming must not be reaped for having
    // been briefly absent.
    const m = managerWith(60_000);
    const s = clientlessSession(m);

    m.attachWebSocket(s.id, socket());
    expect(m.reapClientlessSessions(Date.now() + 60_001)).toBe(0);
    expect(m.get(s.id)).toBeDefined();
    m.shutdown?.();
  });

  test('detaching again restarts the window rather than resuming it', () => {
    const m = managerWith(60_000);
    const s = clientlessSession(m);
    const ws = socket();

    m.attachWebSocket(s.id, ws);
    const reattachedAt = Date.now() + 50_000;
    m.detachWebSocket(ws, reattachedAt);

    // 50s after the original detach plus 20s is inside a window that restarted.
    expect(m.reapClientlessSessions(reattachedAt + 20_000)).toBe(0);
    expect(m.reapClientlessSessions(reattachedAt + 60_001)).toBe(1);
    m.shutdown?.();
  });
});

describe('the window is off unless configured', () => {
  test('no resumeGraceMs means no reaping', () => {
    // Existing deployments keep the previous behaviour until an operator opts
    // in, matching how maxGlobal was introduced.
    const m = new SessionManager({ maxPerIP: 10, maxPerDevice: 10 });
    const s = m.create('mud.example.org', 4000);
    const ws = socket();
    m.attachWebSocket(s.id, ws);
    m.detachWebSocket(ws);

    expect(m.reapClientlessSessions(Date.now() + 86_400_000)).toBe(0);
    expect(m.get(s.id)).toBeDefined();
    m.shutdown?.();
  });
});
