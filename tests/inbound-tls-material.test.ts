/**
 * INBOUND_TLS_MODE=required must mean required (MWP-81).
 *
 * Two defects motivate this file.
 *
 *  - Validation stopped at `existsSync`. A cert that is present but
 *    unreadable, truncated, or paired with the wrong key passed startup and
 *    failed later, on the first user's connection rather than on the deploy.
 *
 *  - `required` was only enforced when the operator set the variable
 *    explicitly. It is also the DEFAULT, and on the default path
 *    `resolveTlsSettings` fell through to `{ useTls: false }` and served
 *    plain HTTP. The setting was accepted and then ignored — the same
 *    config-says-one-thing/enforcement-does-another class as MWP-70/80.
 *
 * Key material is generated per-run in a temp directory. It is never
 * committed: a PEM private key in the tree would trip gitleaks and push
 * protection, and a fixture that must be excluded from secret scanning is a
 * fixture that will eventually be excluded from review too.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  parseRuntimeConfig,
  validateTlsMaterial,
} from '../src/runtime-config.js';

let dir: string;
let certPath: string;
let keyPath: string;
let otherKeyPath: string;
let garbagePath: string;
let emptyPath: string;

const openssl = (args: string[]): void => {
  const r = Bun.spawnSync(['openssl', ...args]);
  if (r.exitCode !== 0) {
    throw new Error(`openssl ${args.join(' ')} failed: ${r.stderr}`);
  }
};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mwp-tls-'));
  certPath = path.join(dir, 'cert.pem');
  keyPath = path.join(dir, 'privkey.pem');
  otherKeyPath = path.join(dir, 'other.pem');
  garbagePath = path.join(dir, 'garbage.pem');
  emptyPath = path.join(dir, 'empty.pem');

  // A self-signed pair, and a second unrelated key to test mismatch.
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
  ]);
  openssl(['genrsa', '-out', otherKeyPath, '2048']);

  writeFileSync(garbagePath, 'this is not a PEM file\n');
  writeFileSync(emptyPath, '');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a valid, matching pair is accepted', () => {
  test('returns no error', () => {
    expect(validateTlsMaterial(certPath, keyPath)).toBeNull();
  });
});

describe('missing files are rejected', () => {
  test('missing certificate', () => {
    expect(validateTlsMaterial(path.join(dir, 'nope.pem'), keyPath)).toMatch(
      /certificate/i,
    );
  });

  test('missing key', () => {
    expect(validateTlsMaterial(certPath, path.join(dir, 'nope.pem'))).toMatch(
      /key/i,
    );
  });
});

describe('present but unusable material is rejected', () => {
  // This is the gap that mattered: existsSync passes for every case here.

  test('unreadable key', () => {
    const locked = path.join(dir, 'locked.pem');
    writeFileSync(locked, 'x');
    chmodSync(locked, 0o000);
    const result = validateTlsMaterial(certPath, locked);
    chmodSync(locked, 0o600);
    // Root ignores file permissions, so accept either the permission error or
    // the parse error that follows from reading 'x'.
    expect(result).not.toBeNull();
  });

  test('malformed certificate', () => {
    expect(validateTlsMaterial(garbagePath, keyPath)).not.toBeNull();
  });

  test('malformed key', () => {
    expect(validateTlsMaterial(certPath, garbagePath)).not.toBeNull();
  });

  test('empty certificate', () => {
    expect(validateTlsMaterial(emptyPath, keyPath)).not.toBeNull();
  });

  test('empty key', () => {
    expect(validateTlsMaterial(certPath, emptyPath)).not.toBeNull();
  });
});

describe('a mismatched pair is rejected', () => {
  // Both files are valid PEM and both parse. Only comparing the public keys
  // catches this, and it is the case most likely to reach production: a cert
  // renewed without its key, or copied from the wrong host.

  test('cert does not match key', () => {
    const result = validateTlsMaterial(certPath, otherKeyPath);
    expect(result).not.toBeNull();
    expect(result).toMatch(/match/i);
  });
});

describe('the dist-parent fallback survives startup validation', () => {
  // Raised by Codex review of #71. A compiled server started from its own
  // dist directory keeps certificates beside the PROJECT, not beside the
  // bundle. resolveTlsSettings has always searched the parent for exactly
  // this layout, but the new startup check resolved against basePath alone
  // and aborted before that code could run — so a supported deployment
  // stopped starting. Two resolutions of the same paths disagreed, which is
  // the duplication this issue set out to remove.

  const parentLayout = (p: string) =>
    p === '/app/cert.pem' || p === '/app/privkey.pem';

  test('finds certificates beside the project when run from dist', () => {
    const { config, errors } = parseRuntimeConfig(
      { INBOUND_TLS_MODE: 'required' },
      parentLayout,
      '/app/dist',
    );
    expect(errors.join(' ')).not.toMatch(/TLS certificate not found/);
    expect(config.tlsCertPath).toBe('/app/cert.pem');
    expect(config.tlsKeyPath).toBe('/app/privkey.pem');
  });

  test('an explicit path is never second-guessed', () => {
    // The fallback only applies when the operator has expressed no preference.
    const { config } = parseRuntimeConfig(
      {
        INBOUND_TLS_MODE: 'required',
        TLS_CERT_PATH: '/etc/tls/c.pem',
        TLS_KEY_PATH: '/etc/tls/k.pem',
      },
      parentLayout,
      '/app/dist',
    );
    expect(config.tlsCertPath).toBe('/etc/tls/c.pem');
    expect(config.tlsKeyPath).toBe('/etc/tls/k.pem');
  });

  test('a non-dist working directory does not reach into its parent', () => {
    // Silently climbing out of the configured directory would be surprising
    // anywhere else.
    const { config } = parseRuntimeConfig(
      { INBOUND_TLS_MODE: 'required' },
      parentLayout,
      '/app/srv',
    );
    expect(config.tlsCertPath).toBe('/app/srv/cert.pem');
  });
});
