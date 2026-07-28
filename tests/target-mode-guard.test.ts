/**
 * Arbitrary target mode and its prerequisites.
 *
 * TARGET_MODE=arbitrary lets a client name any host, so it is only safe with
 * two things in place: enforced authentication (MWP-85, landed) and
 * reserved-network rejection on the connect path (MWP-88, landed). A
 * temporary guard refused the mode outright while those were missing; it has
 * been removed now that both hold, and what remains is the auth requirement.
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

describe('arbitrary mode requires enforced authentication', () => {
  test('starts with AUTH_MODE=shared-secret', () => {
    // Previously refused outright, because shared-secret was declared and
    // enforced nowhere. It is enforced at the upgrade now.
    expect(() =>
      getRuntimeConfig({
        ...base,
        TARGET_MODE: 'arbitrary',
        AUTH_MODE: 'shared-secret',
        PROXY_SHARED_SECRET: 'x'.repeat(32),
        ARBITRARY_ALLOWED_PORTS: '23,4000-4100',
      }),
    ).not.toThrow();
  });

  test('refuses with AUTH_MODE=none', () => {
    // An unauthenticated arbitrary mode is an open SSRF relay.
    expect(() =>
      getRuntimeConfig({
        ...base,
        TARGET_MODE: 'arbitrary',
        AUTH_MODE: 'none',
        ARBITRARY_ALLOWED_PORTS: '23',
      }),
    ).toThrow(/AUTH_MODE/);
  });

  test('refuses without ARBITRARY_ALLOWED_PORTS', () => {
    expect(() =>
      getRuntimeConfig({
        ...base,
        TARGET_MODE: 'arbitrary',
        AUTH_MODE: 'shared-secret',
        PROXY_SHARED_SECRET: 'x'.repeat(32),
      }),
    ).toThrow(/ARBITRARY_ALLOWED_PORTS/);
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
