/**
 * App Attest and APNS are optional and off by default (MWP-95).
 *
 * Both were previously entangled with the proxy's core path: App Attest
 * routes were registered unconditionally whether or not the feature was
 * configured, and APNS built a half-populated config object out of a single
 * environment variable. Neither is useful to a self-hosting operator who runs
 * the proxy for a browser client, so neither should cost them attack surface.
 *
 * These cover the configuration layer. Route registration itself is a
 * process-level concern and lives in attest-route-gating.test.ts.
 */

import { errorText } from '../src/error-text';
import { describe, expect, test } from 'bun:test';
import {
  getRuntimeConfig,
  parseRuntimeConfig,
} from '../src/runtime-config.js';

const base = {
  TN_HOST: 'mud.example.org',
  TN_PORT: '4000',
  TARGET_MODE: 'fixed',
  INBOUND_TLS_MODE: 'off',
  BIND_HOST: '127.0.0.1',
};

const configured = {
  ...base,
  APPATTEST_BUNDLE_ID: 'com.example.app',
  APPATTEST_TEAM_ID: 'AAABBBCCC1',
};

describe('App Attest is off unless configured', () => {
  test('bare defaults leave it disabled', () => {
    expect(getRuntimeConfig(base).appAttest.enabled).toBe(false);
  });

  test('both identifiers together enable it', () => {
    expect(getRuntimeConfig(configured).appAttest.enabled).toBe(true);
  });

  test('a bundle id alone is a startup error, not a half-enabled feature', () => {
    // Silently disabling on a typo'd APPATTEST_TEAM_ID would look identical
    // to "not configured", and the operator would be hunting the wrong bug.
    expect(() =>
      getRuntimeConfig({ ...base, APPATTEST_BUNDLE_ID: 'com.example.app' }),
    ).toThrow(/partially configured/);
  });

  test('a team id alone is a startup error too', () => {
    expect(() =>
      getRuntimeConfig({ ...base, APPATTEST_TEAM_ID: 'AAABBBCCC1' }),
    ).toThrow(/partially configured/);
  });

  test('whitespace-only identifiers do not count as configured', () => {
    expect(() =>
      getRuntimeConfig({
        ...base,
        APPATTEST_BUNDLE_ID: '   ',
        APPATTEST_TEAM_ID: 'AAABBBCCC1',
      }),
    ).toThrow(/partially configured/);
  });

  test('identifiers are trimmed, so a trailing newline still works', () => {
    // Env files and secret mounts routinely add one.
    const config = getRuntimeConfig({
      ...base,
      APPATTEST_BUNDLE_ID: 'com.example.app\n',
      APPATTEST_TEAM_ID: ' AAABBBCCC1 ',
    });
    expect(config.appAttest.enabled).toBe(true);
    expect(config.appAttest.bundleId).toBe('com.example.app');
    expect(config.appAttest.teamId).toBe('AAABBBCCC1');
  });
});

describe('REQUIRE_APP_AUTH cannot be enabled without App Attest', () => {
  test('enforcement without configuration refuses to start', () => {
    // It would otherwise reject every upgrade for missing headers that no
    // client could obtain, because /attest/challenge is not registered.
    // That is an outage wearing the costume of a security setting.
    expect(() =>
      getRuntimeConfig({ ...base, REQUIRE_APP_AUTH: 'true' }),
    ).toThrow(/REQUIRE_APP_AUTH=true requires App Attest to be configured/);
  });

  test('enforcement with configuration starts', () => {
    expect(() =>
      getRuntimeConfig({ ...configured, REQUIRE_APP_AUTH: 'true' }),
    ).not.toThrow();
  });

  test('leaving it off is fine with App Attest configured', () => {
    // Registration endpoints available, enforcement not yet switched on — the
    // ordinary rollout sequence.
    const config = getRuntimeConfig(configured);
    expect(config.appAttest.enabled).toBe(true);
    expect(config.requireAppAuth).toBe(false);
  });
});

describe('the removed bypass variables have no effect', () => {
  // MWP-95 deleted these rather than restricting them. Nothing in the config
  // layer reads them, so a stale deployment carrying them is simply running
  // with verification on — the safe direction, and the reason these are
  // ignored rather than turned into startup errors.

  const bypassVars = {
    APPATTEST_ALLOW_ASSERTION_BYPASS: 'true',
    APPATTEST_DIAG_CROSSKEY: 'true',
  };

  test('setting them changes nothing about the parsed config', () => {
    const clean = getRuntimeConfig(configured);
    const withBypass = getRuntimeConfig({ ...configured, ...bypassVars });
    expect(JSON.stringify({ ...withBypass, _raw: null })).toBe(
      JSON.stringify({ ...clean, _raw: null }),
    );
  });

  test('setting them does not prevent startup', () => {
    expect(() =>
      getRuntimeConfig({ ...configured, ...bypassVars }),
    ).not.toThrow();
  });

  test('no config field carries them forward', () => {
    const { appAttest } = getRuntimeConfig({ ...configured, ...bypassVars });
    expect(appAttest).not.toHaveProperty('allowAssertionBypass');
    expect(appAttest).not.toHaveProperty('diagCrosskey');
    expect(Object.keys(appAttest).sort()).toEqual([
      'attestedKeysPath',
      'bundleId',
      'enabled',
      'teamId',
    ]);
  });
});

describe('APNS is off unless fully configured', () => {
  const apnsEnv = {
    APNS_KEY_PATH: '/etc/apns/key.p8',
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: 'AAABBBCCC1',
    APNS_TOPIC: 'com.example.app',
  };

  test('bare defaults leave push disabled', () => {
    expect(getRuntimeConfig(base).apns).toBeUndefined();
  });

  test('the full set enables it', () => {
    const config = getRuntimeConfig({ ...base, ...apnsEnv });
    expect(config.apns).toMatchObject({
      keyPath: '/etc/apns/key.p8',
      keyId: 'ABC123DEFG',
      teamId: 'AAABBBCCC1',
      topic: 'com.example.app',
      environment: 'sandbox',
    });
  });

  test('a key path alone is a startup error, not an empty-string config', () => {
    // This used to build { keyId: '', teamId: '', topic: '' } and report
    // itself as configured. Every push then failed at Apple with a 4xx that
    // only showed up in the notification manager's own logs.
    expect(() =>
      getRuntimeConfig({ ...base, APNS_KEY_PATH: '/etc/apns/key.p8' }),
    ).toThrow(/APNS is partially configured/);
  });

  test('the error names both what is set and what is missing', () => {
    let message = '';
    try {
      getRuntimeConfig({
        ...base,
        APNS_KEY_PATH: '/etc/apns/key.p8',
        APNS_KEY_ID: 'ABC123DEFG',
      });
    } catch (e) {
      message = errorText(e);
    }
    expect(message).toMatch(/APNS_KEY_PATH/);
    expect(message).toMatch(/APNS_TEAM_ID/);
    expect(message).toMatch(/APNS_TOPIC/);
  });

  test('every single-variable subset is refused', () => {
    for (const name of Object.keys(apnsEnv)) {
      expect(() => getRuntimeConfig({ ...base, [name]: 'value' })).toThrow(
        /APNS is partially configured/,
      );
    }
  });

  test('APNS_ENVIRONMENT alone does not half-enable push', () => {
    // It is not in the required set, so it must not act as a switch.
    expect(() =>
      getRuntimeConfig({ ...base, APNS_ENVIRONMENT: 'production' }),
    ).not.toThrow();
    expect(
      getRuntimeConfig({ ...base, APNS_ENVIRONMENT: 'production' }).apns,
    ).toBeUndefined();
  });

  test('production environment is carried through when requested', () => {
    expect(
      getRuntimeConfig({
        ...base,
        ...apnsEnv,
        APNS_ENVIRONMENT: 'production',
      }).apns?.environment,
    ).toBe('production');
  });
});

describe('the two features switch independently', () => {
  test('APNS can run without App Attest', () => {
    // Push notifications do not depend on device attestation; requiring one
    // for the other would force operators into a feature they did not ask
    // for.
    const config = getRuntimeConfig({
      ...base,
      APNS_KEY_PATH: '/etc/apns/key.p8',
      APNS_KEY_ID: 'ABC123DEFG',
      APNS_TEAM_ID: 'AAABBBCCC1',
      APNS_TOPIC: 'com.example.app',
    });
    expect(config.apns).toBeDefined();
    expect(config.appAttest.enabled).toBe(false);
  });

  test('App Attest can run without APNS', () => {
    const config = getRuntimeConfig(configured);
    expect(config.appAttest.enabled).toBe(true);
    expect(config.apns).toBeUndefined();
  });
});

describe('validation reports every problem at once', () => {
  test('a config with several faults lists them together', () => {
    // parseRuntimeConfig collects rather than throwing on the first, so an
    // operator fixes one round of errors instead of one error per restart.
    const { errors } = parseRuntimeConfig(
      {
        ...base,
        APPATTEST_BUNDLE_ID: 'com.example.app',
        APNS_KEY_PATH: '/etc/apns/key.p8',
        ALLOW_MTLS_FALLBACK: 'true',
      },
      () => true,
      '/app',
    );

    expect(errors).toHaveLength(3);
    expect(errors.join(' ')).toMatch(/App Attest is partially configured/);
    expect(errors.join(' ')).toMatch(/APNS is partially configured/);
    expect(errors.join(' ')).toMatch(/ALLOW_MTLS_FALLBACK has been removed/);
  });
});
