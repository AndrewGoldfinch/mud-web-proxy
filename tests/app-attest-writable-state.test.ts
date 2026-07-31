/**
 * App Attest must be able to persist, or it is not really enabled.
 *
 * Found by running the Compose stack rather than reading it. With App Attest
 * configured but no state volume mounted, the proxy started cleanly, passed
 * its health check, and logged "App Attest ENABLED" — while every write to
 * /var/lib/mud-web-proxy returned EROFS, because the image creates that
 * directory and the container root is read-only.
 *
 * That combination is the worst shape a misconfiguration can take: it looks
 * correct until the first registration is flushed, and then the registration
 * is gone. Startup is the only honest place to catch it.
 *
 * The directory is what these assert on, not the file. On a first run the
 * file does not exist yet, and persistence stages a sibling file in the same
 * directory before renaming it into place.
 */

import { describe, expect, test } from 'bun:test';
import { parseRuntimeConfig } from '../src/runtime-config.js';

const base = {
  INBOUND_TLS_MODE: 'off',
  APPATTEST_BUNDLE_ID: 'com.example.app',
  APPATTEST_TEAM_ID: 'ABCDE12345',
  ATTESTED_KEYS_PATH: '/var/lib/mud-web-proxy/attested-keys.json',
};

const alwaysExists = () => true;
const parse = (
  env: Record<string, string>,
  dirIsWritable: (p: string) => boolean,
) => parseRuntimeConfig(env, alwaysExists, '/app', dirIsWritable);

describe('an unwritable state directory is a startup error', () => {
  test('refuses when the directory cannot be written', () => {
    const { errors } = parse(base, () => false);
    expect(errors.join('\n')).toMatch(/App Attest is enabled but its state/i);
  });

  test('names the directory, not the file', () => {
    // An operator who is told "attested-keys.json is not writable" reaches
    // for the file — and mounting the file is itself the other failure mode
    // this codebase warns about.
    const { errors } = parse(base, () => false);
    const message = errors.find((e) => e.includes('App Attest is enabled'));
    expect(message).toContain('/var/lib/mud-web-proxy');
    expect(message).not.toContain('attested-keys.json.');
  });

  test('tests the directory, not the file itself', () => {
    // The file legitimately does not exist before the first flush, so a
    // check against the file would refuse every first run.
    const probed: string[] = [];
    parse(base, (p) => {
      probed.push(p);
      return true;
    });
    expect(probed).toContain('/var/lib/mud-web-proxy');
    expect(probed).not.toContain('/var/lib/mud-web-proxy/attested-keys.json');
  });

  test('the message points at the fix', () => {
    const message = parse(base, () => false).errors.find((e) =>
      e.includes('App Attest is enabled'),
    );
    expect(message).toMatch(/compose\.appattest\.yaml/);
  });
});

describe('a writable state directory is accepted', () => {
  test('starts when the directory is writable', () => {
    const { errors } = parse(base, () => true);
    expect(errors.filter((e) => e.includes('App Attest is enabled'))).toEqual(
      [],
    );
  });
});

describe('the check applies only when App Attest is enabled', () => {
  test('an unwritable directory is irrelevant when it is off', () => {
    // With App Attest disabled the proxy writes no state at all, which is
    // exactly why the default Compose stack runs read-only with no volume.
    // Refusing to start there would break the supported configuration.
    const off = {
      INBOUND_TLS_MODE: 'off',
      ATTESTED_KEYS_PATH: '/var/lib/mud-web-proxy/attested-keys.json',
    };

    const { errors } = parse(off, () => false);
    expect(errors.filter((e) => e.includes('App Attest is enabled'))).toEqual(
      [],
    );
  });

  test('partial configuration still reports the partial-config error', () => {
    // Half-configured is a different fault and keeps its own message; the
    // writability check must not mask it.
    const partial = {
      INBOUND_TLS_MODE: 'off',
      APPATTEST_BUNDLE_ID: 'com.example.app',
      ATTESTED_KEYS_PATH: '/var/lib/mud-web-proxy/attested-keys.json',
    };

    const { errors } = parse(partial, () => false);
    expect(errors.join('\n')).toMatch(/partially configured/i);
  });
});
