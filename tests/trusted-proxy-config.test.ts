/**
 * Tests for TRUSTED_PROXY_CIDRS parsing.
 *
 * The variable was briefly named TRUST_PROXY. It was never released, but it
 * did reach `develop` and may be set on a deployed host, so the old name must
 * abort startup rather than be silently ignored — a silently-dropped value
 * would leave the proxy trusting nothing, collapsing every client behind the
 * reverse proxy onto one address and tripping per-IP limits service-wide.
 */

import { describe, expect, test } from 'bun:test';
import { getRuntimeConfig } from '../src/runtime-config.js';

/**
 * INBOUND_TLS_MODE defaults to `required`, which now demands a usable
 * certificate and key at startup (MWP-81). These tests are about proxy trust,
 * not TLS, so they opt out explicitly rather than depending on whether a
 * cert.pem happens to exist in the working directory — which is exactly what
 * made an earlier version of this change pass locally and fail in CI.
 */
const base = { INBOUND_TLS_MODE: 'off' };

describe('TRUSTED_PROXY_CIDRS parsing', () => {
  test('defaults to trusting no proxy', () => {
    expect(getRuntimeConfig({ ...base }).trustedProxyCidrs).toBe(false);
  });

  test('treats "true" as trusting every peer', () => {
    expect(
      getRuntimeConfig({ ...base, TRUSTED_PROXY_CIDRS: 'true' })
        .trustedProxyCidrs,
    ).toBe(true);
  });

  test('treats "false" as trusting no peer', () => {
    expect(
      getRuntimeConfig({ ...base, TRUSTED_PROXY_CIDRS: 'false' })
        .trustedProxyCidrs,
    ).toBe(false);
  });

  test('parses a single CIDR entry into a list', () => {
    expect(
      getRuntimeConfig({ ...base, TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })
        .trustedProxyCidrs,
    ).toEqual(['10.0.0.0/8']);
  });

  test('parses a comma-separated list and trims whitespace', () => {
    expect(
      getRuntimeConfig({
        ...base,
        TRUSTED_PROXY_CIDRS: ' 127.0.0.1 , 172.16.0.0/12 ',
      }).trustedProxyCidrs,
    ).toEqual(['127.0.0.1', '172.16.0.0/12']);
  });

  test('treats an empty value as trusting no peer', () => {
    expect(
      getRuntimeConfig({ ...base, TRUSTED_PROXY_CIDRS: '   ' })
        .trustedProxyCidrs,
    ).toBe(false);
  });
});

describe('TRUST_PROXY is retired and fails fast', () => {
  test('aborts when the retired name is set', () => {
    expect(() => getRuntimeConfig({ TRUST_PROXY: '10.0.0.0/8' })).toThrow(
      /TRUST_PROXY/,
    );
  });

  test('names the replacement variable in the error', () => {
    expect(() => getRuntimeConfig({ TRUST_PROXY: 'true' })).toThrow(
      /TRUSTED_PROXY_CIDRS/,
    );
  });

  test('aborts even when the retired name is set to false', () => {
    // Silently ignoring it would be just as wrong: the operator believes they
    // have expressed a trust policy either way.
    expect(() => getRuntimeConfig({ TRUST_PROXY: 'false' })).toThrow(
      /TRUST_PROXY/,
    );
  });

  test('does not abort when only the new name is set', () => {
    expect(() =>
      getRuntimeConfig({ ...base, TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }),
    ).not.toThrow();
  });
});
