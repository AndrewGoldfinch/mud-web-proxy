/**
 * SlidingWindowLimiter — per-source rate limit on successful requests
 * (MWP-95).
 *
 * FailedAuthLimiter counts only failures, which is right for guessing a
 * secret and wrong for App Attest challenge issuance, where every *success*
 * stores a nonce. The client to bound there is the one that never fails.
 */

import { describe, expect, test } from 'bun:test';
import { SlidingWindowLimiter } from '../src/wsproxy-utils.js';

describe('SlidingWindowLimiter', () => {
  test('permits requests up to the limit', () => {
    const limiter = new SlidingWindowLimiter({
      maxRequests: 3,
      windowMs: 1000,
    });
    expect(limiter.tryConsume('1.2.3.4')).toBe(true);
    expect(limiter.tryConsume('1.2.3.4')).toBe(true);
    expect(limiter.tryConsume('1.2.3.4')).toBe(true);
  });

  test('refuses the request that exceeds the limit', () => {
    const limiter = new SlidingWindowLimiter({
      maxRequests: 3,
      windowMs: 1000,
    });
    for (let i = 0; i < 3; i++) limiter.tryConsume('1.2.3.4');
    expect(limiter.tryConsume('1.2.3.4')).toBe(false);
  });

  test('tracks sources independently', () => {
    const limiter = new SlidingWindowLimiter({
      maxRequests: 2,
      windowMs: 1000,
    });
    limiter.tryConsume('1.2.3.4');
    limiter.tryConsume('1.2.3.4');
    expect(limiter.tryConsume('1.2.3.4')).toBe(false);
    expect(limiter.tryConsume('9.9.9.9')).toBe(true);
  });

  test('the window slides, restoring the allowance', () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: () => now,
    });

    expect(limiter.tryConsume('1.2.3.4')).toBe(true);
    expect(limiter.tryConsume('1.2.3.4')).toBe(true);
    expect(limiter.tryConsume('1.2.3.4')).toBe(false);

    now += 1001;
    expect(limiter.tryConsume('1.2.3.4')).toBe(true);
  });

  test('hammering while blocked does not extend the block', () => {
    // A refused attempt must not be recorded, or a client that keeps retrying
    // would hold its own window permanently full and never recover.
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: () => now,
    });

    expect(limiter.tryConsume('1.2.3.4')).toBe(true);
    for (let i = 0; i < 50; i++) {
      now += 10;
      expect(limiter.tryConsume('1.2.3.4')).toBe(false);
    }

    // 1001ms after the single accepted request, the allowance is back.
    now = 1_000_000 + 1001;
    expect(limiter.tryConsume('1.2.3.4')).toBe(true);
  });

  test('the tracking store is itself bounded', () => {
    // Otherwise the limiter becomes the memory-growth vector it exists to
    // prevent: one entry per attacker-chosen source address.
    const limiter = new SlidingWindowLimiter({
      maxRequests: 5,
      windowMs: 60_000,
      maxTrackedSources: 10,
    });

    for (let i = 0; i < 500; i++) {
      limiter.tryConsume(`10.0.0.${i}`);
    }

    expect(limiter.size()).toBeLessThanOrEqual(10);
  });

  test('a limit of one permits exactly one request', () => {
    const limiter = new SlidingWindowLimiter({
      maxRequests: 1,
      windowMs: 1000,
    });
    expect(limiter.tryConsume('1.2.3.4')).toBe(true);
    expect(limiter.tryConsume('1.2.3.4')).toBe(false);
  });
});
