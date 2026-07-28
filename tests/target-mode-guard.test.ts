/**
 * Arbitrary target mode must not be reachable until the controls it depends
 * on actually exist.
 *
 * TARGET_MODE=arbitrary lets a client name any host. That is only safe with
 * two things in place: authentication (MWP-85) and reserved-network rejection
 * on the connect path (MWP-88). AUTH_MODE=shared-secret is currently declared
 * by the config but enforced nowhere, and resolveTargetAddress is not yet
 * called when dialling.
 *
 * So the combination that passes the existing checks —
 *   TARGET_MODE=arbitrary + AUTH_MODE=shared-secret
 * — would yield arbitrary outbound TCP with no authentication and no SSRF
 * protection, while reading as configured. Refuse to start instead.
 *
 * Delete this guard when MWP-85 and MWP-88 are both complete.
 */

import { describe, expect, test } from 'bun:test';
import { getRuntimeConfig } from '../src/runtime-config.js';

const base = {
  TN_HOST: 'mud.example.org',
  TN_PORT: '4000',
  INBOUND_TLS_MODE: 'off',
  ALLOW_INSECURE_INBOUND_NO_TLS: 'true',
  BIND_HOST: '127.0.0.1',
};

describe('arbitrary target mode is gated on its prerequisites', () => {
  test('refuses to start even with AUTH_MODE=shared-secret', () => {
    expect(() =>
      getRuntimeConfig({
        ...base,
        TARGET_MODE: 'arbitrary',
        AUTH_MODE: 'shared-secret',
        PROXY_SHARED_SECRET: 'x'.repeat(32),
        ARBITRARY_ALLOWED_PORTS: '23,4000-4100',
      }),
    ).toThrow(/arbitrary/i);
  });

  test('still refuses with AUTH_MODE=none', () => {
    expect(() =>
      getRuntimeConfig({
        ...base,
        TARGET_MODE: 'arbitrary',
        AUTH_MODE: 'none',
        ARBITRARY_ALLOWED_PORTS: '23',
      }),
    ).toThrow(/arbitrary/i);
  });

  test('names the issues that must land first', () => {
    let message = '';
    try {
      getRuntimeConfig({
        ...base,
        TARGET_MODE: 'arbitrary',
        AUTH_MODE: 'shared-secret',
        PROXY_SHARED_SECRET: 'x'.repeat(32),
        ARBITRARY_ALLOWED_PORTS: '23',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    // An operator hitting this needs to know why, not just that.
    expect(message).toMatch(/MWP-85/);
    expect(message).toMatch(/MWP-88/);
  });
});

describe('the supported modes still start', () => {
  test('fixed mode starts', () => {
    expect(() =>
      getRuntimeConfig({ ...base, TARGET_MODE: 'fixed' }),
    ).not.toThrow();
  });

  test('allowlist mode starts with a populated list', () => {
    expect(() =>
      getRuntimeConfig({
        ...base,
        TARGET_MODE: 'allowlist',
        ALLOWED_TARGETS: 'mud.example.org:4000',
      }),
    ).not.toThrow();
  });

  test('allowlist mode with an empty list does not start', () => {
    expect(() =>
      getRuntimeConfig({
        ...base,
        TARGET_MODE: 'allowlist',
        ALLOWED_TARGETS: '',
      }),
    ).toThrow();
  });
});
