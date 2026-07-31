/**
 * The native release bundle (MWP-103).
 *
 * Deployment used to be `git pull`, so the deployed tree could contain
 * anything the branch contained. The bundle replaces that with a fixed,
 * checksummed set of files — which is only worth anything if the set is
 * actually fixed, so these tests assert the contents rather than that the
 * build exited zero.
 *
 * Two properties are checked, not one. "The bundle is usable" and "the
 * bundle carries no secrets" are independent: a bundle can satisfy the first
 * while failing the second, and testing only the first passes while leaking.
 * That is exactly how the .npmignore regression happened.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as { version: string; engines?: { bun?: string } };

let outDir: string;
let entries: string[];

const bundleRoot = `mud-web-proxy-${manifest.version}`;

beforeAll(() => {
  outDir = mkdtempSync(path.join(tmpdir(), 'mwp-bundle-'));

  // dist/wsproxy.js is a required input, so build first rather than
  // depending on whatever a previous command happened to leave behind.
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: repoRoot,
    stderr: 'pipe',
  });
  if (build.exitCode !== 0) {
    throw new Error(`build failed: ${build.stderr.toString()}`);
  }

  const result = Bun.spawnSync(
    ['bun', 'scripts/build-release-bundle.ts', outDir],
    { cwd: repoRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  if (result.exitCode !== 0) {
    throw new Error(`bundler failed: ${result.stderr.toString()}`);
  }

  const listing = Bun.spawnSync(
    ['tar', 'tzf', path.join(outDir, `${bundleRoot}.tar.gz`)],
    { stdout: 'pipe' },
  );
  entries = listing.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.endsWith('/'))
    .map((line) => line.replace(`${bundleRoot}/`, ''));
});

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('the bundle carries what the systemd path needs', () => {
  test.each([
    'package.json',
    'bun.lock',
    '.bun-version',
    'VERSION',
    'LICENSE',
    'NOTICE',
    'dist/wsproxy.js',
    'config/apple-app-attest-root-ca.pem',
    'config/mud-web-proxy.env.systemd.example',
    'deploy/systemd/mud-web-proxy.service',
    'deploy/sysusers.d/mud-web-proxy.conf',
    'deploy/caddy/Caddyfile.example',
  ])('includes %s', (file) => {
    expect(entries).toContain(file);
  });

  test('extracts to a version-named directory', () => {
    // The systemd layout installs releases as releases/<version>, so an
    // archive that extracts to a generic name would have to be renamed by
    // hand on every deploy.
    const listing = Bun.spawnSync(
      ['tar', 'tzf', path.join(outDir, `${bundleRoot}.tar.gz`)],
      { stdout: 'pipe' },
    );
    for (const line of listing.stdout.toString().split('\n').filter(Boolean)) {
      expect(line.startsWith(`${bundleRoot}/`)).toBe(true);
    }
  });

  test('VERSION agrees with package.json', () => {
    const extracted = Bun.spawnSync(
      [
        'tar',
        'xzOf',
        path.join(outDir, `${bundleRoot}.tar.gz`),
        `${bundleRoot}/VERSION`,
      ],
      { stdout: 'pipe' },
    );
    expect(extracted.stdout.toString().trim()).toBe(manifest.version);
  });

  test('publishes a SHA256SUMS that verifies', () => {
    const check = Bun.spawnSync(['sha256sum', '-c', 'SHA256SUMS'], {
      cwd: outDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(check.exitCode).toBe(0);
  });
});

describe('the bundle carries nothing it should not', () => {
  // Each of these is a separate assertion because "no secrets" is not one
  // property; a bundle can exclude .env and still ship a private key.

  test('no private key material', () => {
    const offenders = entries.filter((e) =>
      /\.(key|p8|p12|pfx)$|(^|\/)privkey\.pem$/.test(e),
    );
    expect(offenders).toEqual([]);
  });

  test('the only .pem is the public App Attest CA', () => {
    const pems = entries.filter((e) => e.endsWith('.pem'));
    expect(pems).toEqual(['config/apple-app-attest-root-ca.pem']);
  });

  test('no environment files', () => {
    // The .systemd.example template is a documented placeholder and is
    // deliberately present; a real .env is not.
    const offenders = entries.filter((e) => /(^|\/)\.env($|\.)/.test(e));
    expect(offenders).toEqual([]);
  });

  test('no sources, tests, or docs', () => {
    const offenders = entries.filter(
      (e) => /^(src|tests|docs)\//.test(e) || e.endsWith('.ts'),
    );
    expect(offenders).toEqual([]);
  });

  test('no dependencies — the host installs them', () => {
    // Shipping node_modules would make the bundle architecture-specific and
    // silently stale relative to bun.lock.
    expect(entries.filter((e) => e.startsWith('node_modules/'))).toEqual([]);
  });
});

describe('the runtime pin travels with the bundle', () => {
  test('.bun-version equals package.json#engines.bun', () => {
    // The installer reads the bundled .bun-version to choose the runtime. If
    // it disagreed with engines.bun, dependencies would be installed under
    // one runtime and declared for another, and only the production host
    // would find out.
    const bundled = Bun.spawnSync(
      [
        'tar',
        'xzOf',
        path.join(outDir, `${bundleRoot}.tar.gz`),
        `${bundleRoot}/.bun-version`,
      ],
      { stdout: 'pipe' },
    );
    expect(bundled.stdout.toString().trim()).toBe(manifest.engines?.bun);
  });
});
