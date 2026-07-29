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

describe('the mTLS fallback is gone, not merely guarded', () => {
  // It used to be `ALLOW_MTLS_FALLBACK === 'true' && NODE_ENV !==
  // 'production'`. That guard read backwards in the case that mattered: an
  // unset NODE_ENV — the common case on a bare `bun start` — is not
  // 'production', so the fallback was ON. MWP-95 removes the fallback rather
  // than re-tuning the condition.

  test('the retired flag aborts startup instead of being ignored', () => {
    // Silently ignoring it would leave the operator believing certificate
    // auth is available while every client is rejected for missing App
    // Attest headers.
    expect(() =>
      getRuntimeConfig({ ...base, ALLOW_MTLS_FALLBACK: 'true' }),
    ).toThrow(/ALLOW_MTLS_FALLBACK has been removed/);
  });

  test('it aborts even when set to a falsy value', () => {
    // Presence is what matters. A config still carrying the name is stale
    // regardless of its value, and the operator should learn that now.
    expect(() =>
      getRuntimeConfig({ ...base, ALLOW_MTLS_FALLBACK: 'false' }),
    ).toThrow(/ALLOW_MTLS_FALLBACK has been removed/);
  });

  test('the companion CA path is retired too', () => {
    expect(() =>
      getRuntimeConfig({ ...base, MTLS_CLIENT_CA_PATH: '/etc/ca.pem' }),
    ).toThrow(/MTLS_CLIENT_CA_PATH has been removed/);
  });

  test('the error points at a mechanism that still exists', () => {
    let message = '';
    try {
      getRuntimeConfig({ ...base, ALLOW_MTLS_FALLBACK: 'true' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/AUTH_MODE=shared-secret/);
  });

  test('no config field survives for callers to consult', () => {
    expect(getRuntimeConfig(base)).not.toHaveProperty('allowMtlsFallback');
    expect(getRuntimeConfig(base)).not.toHaveProperty('mtlsClientCaPath');
  });
});

describe('no security decision keys on NODE_ENV', () => {
  // MWP-95. NODE_ENV is a string the same operator sets, and it is unset far
  // more often than assumed — so any rule keyed on it is absent precisely
  // where it was supposed to apply.

  test('NODE_ENV=production does not change the parsed config', () => {
    const withoutEnv = getRuntimeConfig(base);
    const withEnv = getRuntimeConfig({ ...base, NODE_ENV: 'production' });
    expect(JSON.stringify({ ...withEnv, _raw: null })).toBe(
      JSON.stringify({ ...withoutEnv, _raw: null }),
    );
  });

  test('the config exposes no nodeEnv for callers to branch on', () => {
    expect(getRuntimeConfig(base)).not.toHaveProperty('nodeEnv');
  });

  test('plaintext on loopback needs no acknowledgment, in any NODE_ENV', () => {
    // The bind address is the real signal about who can reach the listener.
    for (const nodeEnv of ['production', 'development', undefined]) {
      expect(() =>
        getRuntimeConfig({
          TN_HOST: 'mud.example.org',
          TN_PORT: '4000',
          TARGET_MODE: 'fixed',
          INBOUND_TLS_MODE: 'off',
          BIND_HOST: '127.0.0.1',
          NODE_ENV: nodeEnv as string,
        }),
      ).not.toThrow();
    }
  });

  test('plaintext off loopback needs acknowledgment, in any NODE_ENV', () => {
    for (const nodeEnv of ['production', 'development', undefined]) {
      expect(() =>
        getRuntimeConfig({
          TN_HOST: 'mud.example.org',
          TN_PORT: '4000',
          TARGET_MODE: 'fixed',
          INBOUND_TLS_MODE: 'off',
          BIND_HOST: '0.0.0.0',
          NODE_ENV: nodeEnv as string,
        }),
      ).toThrow(/ALLOW_INSECURE_INBOUND_NO_TLS/);
    }
  });
});

describe('log settings are parsed once', () => {
  test('LOG_LEVEL is accepted in either case', () => {
    expect(() =>
      getRuntimeConfig({ ...base, LOG_LEVEL: 'DEBUG' }),
    ).not.toThrow();
    expect(() =>
      getRuntimeConfig({ ...base, LOG_LEVEL: 'debug' }),
    ).not.toThrow();
  });

  test('an unrecognized LOG_LEVEL aborts rather than silently defaulting', () => {
    expect(() => getRuntimeConfig({ ...base, LOG_LEVEL: 'verbose' })).toThrow(
      /LOG_LEVEL/,
    );
  });

  test('NO_COLOR is exposed on the config', () => {
    expect(getRuntimeConfig({ ...base, NO_COLOR: '1' }).log.noColor).toBe(
      true,
    );
    expect(getRuntimeConfig(base).log.noColor).toBe(false);
  });
});

describe('the plaintext guard names a usable remedy', () => {
  // resolveTlsSettings told operators to set ALLOW_INSECURE_PRODUCTION_NO_TLS
  // — a variable parseRuntimeConfig retires and aborts on. Following the
  // error message could not work, so an exposed plaintext listener was an
  // unreachable state rather than an acknowledged one.
  //
  // MWP-95 rehomed the trigger from NODE_ENV onto the bind address, so these
  // exercise a non-loopback bind rather than a production environment name.
  const exposed = {
    ...base,
    BIND_HOST: '0.0.0.0',
    ALLOW_INSECURE_INBOUND_NO_TLS: undefined as unknown as string,
  };

  test('an exposed plaintext listener is refused without acknowledgment', () => {
    expect(() => getRuntimeConfig(exposed)).toThrow();
  });

  test('the refusal names the variable that actually works', () => {
    let message = '';
    try {
      getRuntimeConfig(exposed);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ALLOW_INSECURE_INBOUND_NO_TLS/);
    expect(message).not.toMatch(/ALLOW_INSECURE_PRODUCTION_NO_TLS=true/);
  });

  test('acknowledging it with the live variable starts', () => {
    expect(() =>
      getRuntimeConfig({
        ...exposed,
        ALLOW_INSECURE_INBOUND_NO_TLS: 'true',
      }),
    ).not.toThrow();
  });
});
