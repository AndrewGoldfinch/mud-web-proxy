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
import { validateTlsMaterial } from '../src/runtime-config.js';

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
