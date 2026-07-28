/**
 * Configuration guards that must actually bite.
 *
 * Each of these was accepted by validation while the property it claims to
 * enforce did not hold — the failure mode that makes a config module worse
 * than none, because the operator believes a control is in force.
 *
 * Raised in review of PR #32.
 */

import { describe, expect, test } from 'bun:test';
import { getRuntimeConfig, parseRuntimeConfig } from '../src/runtime-config.js';

const base = {
  TN_HOST: 'mud.example.org',
  TN_PORT: '4000',
  TARGET_MODE: 'fixed',
};

const noFiles = () => false;
const allFiles = () => true;

describe('ALLOW_INSECURE_INBOUND_NO_TLS is a boolean, not a string', () => {
  const exposed = {
    ...base,
    INBOUND_TLS_MODE: 'off',
    BIND_HOST: '0.0.0.0',
  };

  test('rejects a non-loopback plaintext listener when unset', () => {
    const { errors } = parseRuntimeConfig(exposed, noFiles, '/app');
    expect(errors.join(' ')).toMatch(/ALLOW_INSECURE_INBOUND_NO_TLS/);
  });

  test('rejects it when explicitly set to false', () => {
    // Every non-empty string is truthy, so "false" previously satisfied the
    // acknowledgment and exposed a plaintext listener the operator had just
    // declined to accept.
    const { errors } = parseRuntimeConfig(
      { ...exposed, ALLOW_INSECURE_INBOUND_NO_TLS: 'false' },
      noFiles,
      '/app',
    );
    expect(errors.join(' ')).toMatch(/ALLOW_INSECURE_INBOUND_NO_TLS/);
  });

  test('rejects it when set to 0', () => {
    const { errors } = parseRuntimeConfig(
      { ...exposed, ALLOW_INSECURE_INBOUND_NO_TLS: '0' },
      noFiles,
      '/app',
    );
    expect(errors.join(' ')).toMatch(/ALLOW_INSECURE_INBOUND_NO_TLS/);
  });

  test('accepts it when genuinely acknowledged', () => {
    const { errors } = parseRuntimeConfig(
      { ...exposed, ALLOW_INSECURE_INBOUND_NO_TLS: 'true' },
      noFiles,
      '/app',
    );
    expect(errors.join(' ')).not.toMatch(/ALLOW_INSECURE_INBOUND_NO_TLS/);
  });

  test('loopback needs no acknowledgment', () => {
    const { errors } = parseRuntimeConfig(
      { ...base, INBOUND_TLS_MODE: 'off', BIND_HOST: '127.0.0.1' },
      noFiles,
      '/app',
    );
    expect(errors.join(' ')).not.toMatch(/ALLOW_INSECURE_INBOUND_NO_TLS/);
  });
});

describe('INBOUND_TLS_MODE=required is enforced, not filtered away', () => {
  const required = {
    ...base,
    INBOUND_TLS_MODE: 'required',
    TLS_CERT_PATH: '/tls/cert.pem',
    TLS_KEY_PATH: '/tls/key.pem',
  };

  test('aborts when the certificate files are absent', () => {
    // The error was previously discarded, so the server fell back to
    // plaintext despite an explicit "required".
    expect(() => getRuntimeConfig(required)).toThrow(/TLS/i);
  });

  test('starts when the certificate files are present', () => {
    const { errors } = parseRuntimeConfig(required, allFiles, '/app');
    expect(errors.join(' ')).not.toMatch(/TLS certificate not found/);
  });

  test('INBOUND_TLS_MODE=off does not demand certificates', () => {
    expect(() =>
      getRuntimeConfig({
        ...base,
        INBOUND_TLS_MODE: 'off',
        BIND_HOST: '127.0.0.1',
      }),
    ).not.toThrow();
  });
});

describe('allowlist validation uses the same parser as enforcement', () => {
  const allowlist = (targets: string) => ({
    ...base,
    TARGET_MODE: 'allowlist',
    ALLOWED_TARGETS: targets,
  });

  test('accepts a genuinely valid entry', () => {
    expect(() => getRuntimeConfig(allowlist('mud.example.org:4000'))).not
      .toThrow();
  });

  test('rejects an entry whose host is blank', () => {
    // " :4000" has a separator and a valid port, so a hand-rolled check
    // passed it — while parseAllowedTargets drops it for an empty host. The
    // proxy then started in allowlist mode and denied every connection.
    expect(() => getRuntimeConfig(allowlist(' :4000'))).toThrow(
      /ALLOWED_TARGETS/,
    );
  });

  test('rejects entries with an out-of-range port', () => {
    expect(() => getRuntimeConfig(allowlist('mud.example.org:70000'))).toThrow(
      /ALLOWED_TARGETS/,
    );
  });

  test('rejects an entry with no port at all', () => {
    expect(() => getRuntimeConfig(allowlist('mud.example.org'))).toThrow(
      /ALLOWED_TARGETS/,
    );
  });

  test('accepts a valid entry alongside a malformed one', () => {
    expect(() =>
      getRuntimeConfig(allowlist(' :4000,mud.example.org:4000')),
    ).not.toThrow();
  });
});
