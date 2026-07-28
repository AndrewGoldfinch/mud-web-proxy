/**
 * A malformed TRUSTED_PROXY_CIDRS entry must abort startup (MWP-83).
 *
 * Silently accepting one is the worst outcome: it matches nothing, so
 * forwarded headers are ignored, every client collapses onto the proxy's own
 * address, and per-IP limits trip service-wide — while the operator believes
 * the trust boundary is configured.
 */

import { describe, expect, test } from 'bun:test';
import { getRuntimeConfig } from '../src/runtime-config.js';

const base = {
  TN_HOST: 'mud.example.org',
  TN_PORT: '4000',
  TARGET_MODE: 'fixed',
  INBOUND_TLS_MODE: 'off',
  ALLOW_INSECURE_INBOUND_NO_TLS: 'true',
  BIND_HOST: '127.0.0.1',
};

const withCidrs = (v: string) => ({ ...base, TRUSTED_PROXY_CIDRS: v });

describe('valid values start', () => {
  for (const v of [
    '127.0.0.1',
    '10.0.0.0/8',
    '127.0.0.1,172.16.0.0/12',
    '::1',
    '2001:db8::/32',
    'true',
    'false',
  ]) {
    test(`accepts ${v}`, () => {
      expect(() => getRuntimeConfig(withCidrs(v))).not.toThrow();
    });
  }

  test('accepts an unset value, meaning trust nothing', () => {
    expect(() => getRuntimeConfig(base)).not.toThrow();
  });
});

describe('malformed values abort', () => {
  for (const v of [
    'garbage',
    '10.0.0.0/99',
    '10.0.0.0/8/oops',
    '999.1.1.1',
    '10.0.0.0/',
    '2001:db8::/999',
    '127.0.0.1,garbage',
  ]) {
    test(`rejects ${v}`, () => {
      expect(() => getRuntimeConfig(withCidrs(v))).toThrow(
        /TRUSTED_PROXY_CIDRS/,
      );
    });
  }
});
