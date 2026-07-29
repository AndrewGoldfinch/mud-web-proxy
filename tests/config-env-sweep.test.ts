/**
 * Every setting is read once, in runtime-config (MWP-80).
 *
 * MWP-80's criteria require no `process.env` reads outside the config module.
 * That was not true: 29 remained, each a second definition of a value the
 * config had already parsed. Four settings had reached production this way
 * with the config parsing them and nothing consuming it.
 *
 * The mTLS fallback is the one where the two definitions actually disagreed.
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

describe('allowMtlsFallback keeps its production guard', () => {
  // wsproxy computed `ALLOW_MTLS_FALLBACK === 'true' && NODE_ENV !==
  // 'production'`, while the config parsed the flag alone. Centralizing on
  // the config value without the guard would have enabled the fallback in
  // production — a security regression introduced by a tidy-up.

  test('is off when the flag is unset', () => {
    expect(getRuntimeConfig(base).allowMtlsFallback).toBe(false);
  });

  test('is on outside production when enabled', () => {
    expect(
      getRuntimeConfig({ ...base, ALLOW_MTLS_FALLBACK: 'true' })
        .allowMtlsFallback,
    ).toBe(true);
  });

  test('is OFF in production even when enabled', () => {
    expect(
      getRuntimeConfig({
        ...base,
        ALLOW_MTLS_FALLBACK: 'true',
        NODE_ENV: 'production',
      }).allowMtlsFallback,
    ).toBe(false);
  });

  test('is off in production regardless of spelling', () => {
    for (const v of ['true', '1', 'yes', 'on']) {
      expect(
        getRuntimeConfig({
          ...base,
          ALLOW_MTLS_FALLBACK: v,
          NODE_ENV: 'production',
        }).allowMtlsFallback,
      ).toBe(false);
    }
  });
});

describe('log settings are parsed once', () => {
  test('LOG_LEVEL is accepted in either case', () => {
    expect(() => getRuntimeConfig({ ...base, LOG_LEVEL: 'DEBUG' })).not
      .toThrow();
    expect(() => getRuntimeConfig({ ...base, LOG_LEVEL: 'debug' })).not
      .toThrow();
  });

  test('an unrecognized LOG_LEVEL aborts rather than silently defaulting', () => {
    expect(() => getRuntimeConfig({ ...base, LOG_LEVEL: 'verbose' })).toThrow(
      /LOG_LEVEL/,
    );
  });

  test('NO_COLOR is exposed on the config', () => {
    expect(getRuntimeConfig({ ...base, NO_COLOR: '1' }).log.noColor).toBe(true);
    expect(getRuntimeConfig(base).log.noColor).toBe(false);
  });
});

describe('the production TLS guard names a usable remedy', () => {
  // resolveTlsSettings told operators to set ALLOW_INSECURE_PRODUCTION_NO_TLS
  // — a variable parseRuntimeConfig retires and aborts on. Following the
  // error message could not work, so production + INBOUND_TLS_MODE=off was an
  // unreachable state rather than an acknowledged one.

  test('production + INBOUND_TLS_MODE=off is refused without acknowledgment', () => {
    expect(() =>
      getRuntimeConfig({
        ...base,
        NODE_ENV: 'production',
        ALLOW_INSECURE_INBOUND_NO_TLS: undefined as unknown as string,
      }),
    ).toThrow();
  });

  test('the refusal names the variable that actually works', () => {
    let message = '';
    try {
      getRuntimeConfig({
        ...base,
        NODE_ENV: 'production',
        ALLOW_INSECURE_INBOUND_NO_TLS: undefined as unknown as string,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ALLOW_INSECURE_INBOUND_NO_TLS/);
    expect(message).not.toMatch(/ALLOW_INSECURE_PRODUCTION_NO_TLS=true/);
  });

  test('acknowledging it with the live variable starts', () => {
    expect(() =>
      getRuntimeConfig({ ...base, NODE_ENV: 'production' }),
    ).not.toThrow();
  });
});
