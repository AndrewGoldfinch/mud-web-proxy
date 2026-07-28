/**
 * Capacity is reserved before DNS and TCP work, not after (MWP-92).
 *
 * Raised in review of #35. `enforceConnectionLimits` consults counters that
 * are only incremented once a dial succeeds, so a client sending many connect
 * frames at once passes every check — nothing has been counted yet. Omitting
 * `deviceToken` skipped the check entirely. Reordering limits ahead of DNS
 * achieved nothing on its own, because there was no reservation to hold.
 */

import { describe, expect, test } from 'bun:test';
import { SessionManager } from '../src/session-manager.js';

const mgr = () =>
  new SessionManager({ maxPerIP: 2, maxPerDevice: 5, timeoutHours: 24 });

describe('reservePendingDial', () => {
  test('permits reservations up to the per-IP limit', () => {
    const m = mgr();
    expect(m.reservePendingDial('1.2.3.4').allowed).toBe(true);
    expect(m.reservePendingDial('1.2.3.4').allowed).toBe(true);
  });

  test('refuses beyond the limit, before any dial has completed', () => {
    const m = mgr();
    m.reservePendingDial('1.2.3.4');
    m.reservePendingDial('1.2.3.4');
    // This is the case the review describes: nothing has connected yet, so
    // the old check would have allowed it.
    expect(m.reservePendingDial('1.2.3.4').allowed).toBe(false);
  });

  test('counts pending reservations alongside established sessions', () => {
    const m = mgr();
    m.incrementIPCount('1.2.3.4'); // one established
    expect(m.reservePendingDial('1.2.3.4').allowed).toBe(true); // now at 2
    expect(m.reservePendingDial('1.2.3.4').allowed).toBe(false);
  });

  test('tracks addresses independently', () => {
    const m = mgr();
    m.reservePendingDial('1.2.3.4');
    m.reservePendingDial('1.2.3.4');
    expect(m.reservePendingDial('9.9.9.9').allowed).toBe(true);
  });

  test('applies with no device token at all', () => {
    // The device-limit check was skipped entirely for tokenless clients;
    // the per-IP reservation must not be.
    const m = mgr();
    m.reservePendingDial('1.2.3.4');
    m.reservePendingDial('1.2.3.4');
    expect(m.reservePendingDial('1.2.3.4').allowed).toBe(false);
  });
});

describe('releasePendingDial', () => {
  test('frees capacity when a dial fails', () => {
    const m = mgr();
    m.reservePendingDial('1.2.3.4');
    m.reservePendingDial('1.2.3.4');
    expect(m.reservePendingDial('1.2.3.4').allowed).toBe(false);

    m.releasePendingDial('1.2.3.4');
    expect(m.reservePendingDial('1.2.3.4').allowed).toBe(true);
  });

  test('repeated failures do not leak capacity', () => {
    // A leaked reservation is permanent until restart, so this is the
    // property that matters most.
    const m = mgr();
    for (let i = 0; i < 50; i++) {
      expect(m.reservePendingDial('1.2.3.4').allowed).toBe(true);
      m.releasePendingDial('1.2.3.4');
    }
    expect(m.pendingDials('1.2.3.4')).toBe(0);
  });

  test('never drops below zero on an unmatched release', () => {
    const m = mgr();
    m.releasePendingDial('1.2.3.4');
    m.releasePendingDial('1.2.3.4');
    expect(m.pendingDials('1.2.3.4')).toBe(0);
    expect(m.reservePendingDial('1.2.3.4').allowed).toBe(true);
  });

  test('forgets an address once it returns to zero', () => {
    const m = mgr();
    m.reservePendingDial('1.2.3.4');
    m.releasePendingDial('1.2.3.4');
    expect(m.pendingDials('1.2.3.4')).toBe(0);
  });
});
