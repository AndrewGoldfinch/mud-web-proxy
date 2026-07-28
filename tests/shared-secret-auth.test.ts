/**
 * Shared-secret authentication at the WebSocket upgrade (MWP-85).
 *
 * Until now the proxy had no general authentication at all — only ADMIN_TOKEN
 * for diagnostics and the optional, Apple-specific App Attest path. AUTH_MODE
 * and PROXY_SHARED_SECRET were parsed by the config and enforced nowhere.
 */

import { describe, expect, test } from 'bun:test';
import {
  FailedAuthLimiter,
  authorizeSharedSecret,
  type SharedSecretAuthConfig,
} from '../src/wsproxy-utils.js';

const SECRET = 'k'.repeat(48);

const enabled: SharedSecretAuthConfig = {
  authMode: 'shared-secret',
  sharedSecret: SECRET,
  allowQuerySecret: false,
};

const enabledWithQuery: SharedSecretAuthConfig = {
  ...enabled,
  allowQuerySecret: true,
};

const disabled: SharedSecretAuthConfig = {
  authMode: 'none',
  sharedSecret: '',
  allowQuerySecret: false,
};

describe('AUTH_MODE=none', () => {
  test('authorizes with no credentials at all', () => {
    expect(authorizeSharedSecret({}, '/', disabled).authorized).toBe(true);
  });

  test('authorizes even when a bogus credential is supplied', () => {
    expect(
      authorizeSharedSecret(
        { authorization: 'Bearer nonsense' },
        '/',
        disabled,
      ).authorized,
    ).toBe(true);
  });
});

describe('Authorization: Bearer', () => {
  test('authorizes the correct secret', () => {
    expect(
      authorizeSharedSecret(
        { authorization: `Bearer ${SECRET}` },
        '/',
        enabled,
      ).authorized,
    ).toBe(true);
  });

  test('treats the scheme as case-insensitive, per RFC 7235', () => {
    expect(
      authorizeSharedSecret(
        { authorization: `bearer ${SECRET}` },
        '/',
        enabled,
      ).authorized,
    ).toBe(true);
  });

  test('rejects a wrong secret of the same length', () => {
    expect(
      authorizeSharedSecret(
        { authorization: `Bearer ${'x'.repeat(48)}` },
        '/',
        enabled,
      ).authorized,
    ).toBe(false);
  });

  test('rejects a wrong secret of a different length without throwing', () => {
    // timingSafeEqual throws on unequal lengths; the caller must length-check.
    expect(
      authorizeSharedSecret({ authorization: 'Bearer short' }, '/', enabled)
        .authorized,
    ).toBe(false);
  });

  test('rejects a missing header', () => {
    expect(authorizeSharedSecret({}, '/', enabled).authorized).toBe(false);
  });

  test('rejects an empty bearer value', () => {
    expect(
      authorizeSharedSecret({ authorization: 'Bearer ' }, '/', enabled)
        .authorized,
    ).toBe(false);
  });

  test('rejects a non-Bearer scheme carrying the right value', () => {
    expect(
      authorizeSharedSecret({ authorization: `Basic ${SECRET}` }, '/', enabled)
        .authorized,
    ).toBe(false);
  });

  test('rejects an array-valued header rather than coercing it', () => {
    expect(
      authorizeSharedSecret(
        { authorization: [`Bearer ${SECRET}`] as unknown as string },
        '/',
        enabled,
      ).authorized,
    ).toBe(false);
  });
});

describe('query parameter fallback', () => {
  // Browsers cannot set headers on a WebSocket, so this exists for them —
  // but the secret lands in access logs and referrers, so it is opt-in.

  test('is ignored when not enabled, even with the correct secret', () => {
    expect(
      authorizeSharedSecret({}, `/?secret=${SECRET}`, enabled).authorized,
    ).toBe(false);
  });

  test('authorizes the correct secret when enabled', () => {
    expect(
      authorizeSharedSecret({}, `/?secret=${SECRET}`, enabledWithQuery)
        .authorized,
    ).toBe(true);
  });

  test('rejects a wrong secret when enabled', () => {
    expect(
      authorizeSharedSecret({}, '/?secret=wrong', enabledWithQuery).authorized,
    ).toBe(false);
  });

  test('rejects when the parameter is absent', () => {
    expect(
      authorizeSharedSecret({}, '/?other=1', enabledWithQuery).authorized,
    ).toBe(false);
  });

  test('handles a url with no query string', () => {
    expect(
      authorizeSharedSecret({}, '/', enabledWithQuery).authorized,
    ).toBe(false);
  });

  test('handles a malformed url without throwing', () => {
    expect(
      authorizeSharedSecret({}, '://%%%', enabledWithQuery).authorized,
    ).toBe(false);
  });

  test('prefers the header when both are present', () => {
    expect(
      authorizeSharedSecret(
        { authorization: `Bearer ${SECRET}` },
        '/?secret=wrong',
        enabledWithQuery,
      ).authorized,
    ).toBe(true);
  });
});

describe('the failure reason never contains the attempted value', () => {
  test('omits the supplied secret', () => {
    const attempted = 'sup3rsecret-attempt-value';
    const result = authorizeSharedSecret(
      { authorization: `Bearer ${attempted}` },
      '/',
      enabled,
    );
    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.reason).not.toContain(attempted);
    }
  });

  test('omits the configured secret', () => {
    const result = authorizeSharedSecret({}, '/', enabled);
    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.reason).not.toContain(SECRET);
    }
  });
});

describe('FailedAuthLimiter', () => {
  test('permits attempts below the threshold', () => {
    const limiter = new FailedAuthLimiter({ maxFailures: 3, windowMs: 1000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
  });

  test('blocks once the threshold is reached', () => {
    const limiter = new FailedAuthLimiter({ maxFailures: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);
  });

  test('tracks sources independently', () => {
    const limiter = new FailedAuthLimiter({ maxFailures: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('9.9.9.9')).toBe(false);
  });

  test('expires failures outside the window', () => {
    let now = 0;
    const limiter = new FailedAuthLimiter({
      maxFailures: 3,
      windowMs: 1000,
      now: () => now,
    });
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);
    now = 1001;
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
  });

  test('clears a source on success, so a typo is not punished', () => {
    const limiter = new FailedAuthLimiter({ maxFailures: 3, windowMs: 1000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    limiter.recordSuccess('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
  });

  test('does not grow without bound', () => {
    // The store is attacker-addressable, so it needs a cap of its own.
    const limiter = new FailedAuthLimiter({
      maxFailures: 3,
      windowMs: 1000,
      maxTrackedSources: 10,
    });
    for (let i = 0; i < 500; i++) limiter.recordFailure(`10.0.0.${i % 250}`);
    expect(limiter.size()).toBeLessThanOrEqual(10);
  });
});

describe('a blocked source must not lock out valid credentials', () => {
  // Raised in review of #33: clients commonly share a source address through
  // NAT or a forward proxy. Blocking before verifying lets one failing client
  // deny service to every authorized client on that address — a trivial DoS.
  //
  // Rate limiting exists to bound the cost of wrong guesses, not to reject
  // right ones. Verify first; apply the block only to failures.

  test('a correct secret is accepted even while the source is blocked', () => {
    const limiter = new FailedAuthLimiter({ maxFailures: 3, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) limiter.recordFailure('203.0.113.7');
    expect(limiter.isBlocked('203.0.113.7')).toBe(true);

    // The credential itself is still valid, so authorization must succeed.
    const result = authorizeSharedSecret(
      { authorization: `Bearer ${SECRET}` },
      '/',
      enabled,
    );
    expect(result.authorized).toBe(true);

    // ...and success clears the block for everyone behind that address.
    limiter.recordSuccess('203.0.113.7');
    expect(limiter.isBlocked('203.0.113.7')).toBe(false);
  });

  test('a wrong secret from a blocked source stays blocked', () => {
    const limiter = new FailedAuthLimiter({ maxFailures: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) limiter.recordFailure('203.0.113.7');

    const result = authorizeSharedSecret(
      { authorization: 'Bearer wrong' },
      '/',
      enabled,
    );
    expect(result.authorized).toBe(false);
    expect(limiter.isBlocked('203.0.113.7')).toBe(true);
  });
});
