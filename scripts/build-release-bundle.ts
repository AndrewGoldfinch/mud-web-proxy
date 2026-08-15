/**
 * Build the native release bundle consumed by the systemd path.
 *
 * Deployment was `git pull` on the production host, which means the deployed
 * tree could contain anything the branch contained, could not be verified,
 * and could not be rolled back to a known state. This produces the immutable,
 * checksummed artifact that makes atomic activation and rollback possible.
 *
 * The bundle is assembled from an explicit allowlist rather than by copying
 * the tree and deleting what should not ship. An allowlist that forgets a
 * file produces a broken release, which is loud. A denylist that forgets a
 * pattern ships a secret, which is silent.
 *
 * Usage: bun scripts/build-release-bundle.ts [outputDir]
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

interface Manifest {
  version?: string;
  engines?: { bun?: string };
}

/** Files copied verbatim into the bundle root. */
const FILES = [
  'package.json',
  'bun.lock',
  '.bun-version',
  'LICENSE',
  'NOTICE',
  'dist/wsproxy.js',
  'config/apple-app-attest-root-ca.pem',
  'config/mud-web-proxy.env.systemd.example',
  'deploy/systemd/mud-web-proxy.service',
  'deploy/sysusers.d/mud-web-proxy.conf',
  'deploy/caddy/Caddyfile.example',
] as const;

/**
 * Nothing in the bundle may match these. Checked against the assembled tree,
 * not against the source, so it catches a mistake in the allowlist itself.
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|\/)\.env($|\.)/, why: 'environment file' },
  { pattern: /\.(key|p8|p12|pfx)$/, why: 'private key material' },
  { pattern: /(^|\/)privkey\.pem$/, why: 'private key' },
  { pattern: /(^|\/)cert\.pem$/, why: 'server certificate' },
  { pattern: /(^|\/)(src|tests|docs)\//, why: 'source, tests, or docs' },
  { pattern: /(^|\/)node_modules\//, why: 'dependencies (installed on host)' },
  { pattern: /\.ts$/, why: 'TypeScript source' },
];

/** The one .pem that is allowed: Apple's public App Attest root CA. */
const ALLOWED_PEM = 'config/apple-app-attest-root-ca.pem';

const fail = (message: string): never => {
  console.error(`build-release-bundle: ${message}`);
  process.exit(1);
};

const walk = (dir: string, prefix = ''): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    return statSync(abs).isDirectory() ? walk(abs, rel) : [rel];
  });

const manifest: Manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const version = manifest.version;
if (!version) fail('package.json has no version');

// The runtime pin must agree before anything is built. A bundle whose
// .bun-version disagrees with engines.bun installs its dependencies with one
// runtime and declares another, and the disagreement only surfaces on the
// production host.
const bunVersionFile = readFileSync(
  path.join(repoRoot, '.bun-version'),
  'utf8',
).trim();
if (bunVersionFile !== manifest.engines?.bun) {
  fail(
    `.bun-version (${bunVersionFile}) does not equal package.json#engines.bun ` +
      `(${manifest.engines?.bun ?? 'unset'})`,
  );
}

const outputDir = path.resolve(
  process.argv[2] ?? path.join(repoRoot, 'release'),
);
const bundleName = `mud-web-proxy-${version}`;
const stageDir = path.join(outputDir, bundleName);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const file of FILES) {
  const source = path.join(repoRoot, file);
  if (!existsSync(source)) {
    fail(`required bundle input is missing: ${file}`);
  }
  const target = path.join(stageDir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target);
}

writeFileSync(path.join(stageDir, 'VERSION'), `${version}\n`);

// Verify the assembled tree, not the intent. This is the check that would
// have caught the .npmignore mistake where secret exclusions were dropped:
// "the artifact is usable" and "the artifact carries no secrets" are two
// properties, and only testing the first passes while leaking.
const assembled = walk(stageDir);
for (const rel of assembled) {
  if (rel.endsWith('.pem') && rel !== ALLOWED_PEM) {
    fail(`unexpected .pem in bundle: ${rel}`);
  }
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(rel)) {
      fail(`bundle contains ${why}: ${rel}`);
    }
  }
}

const tarball = path.join(outputDir, `${bundleName}.tar.gz`);
rmSync(tarball, { force: true });

// --sort=name and a pinned mtime/owner keep the archive byte-identical for
// identical inputs, so a rebuild can be compared against a published digest.
try {
  execFileSync(
    'tar',
    [
      '--sort=name',
      '--mtime=UTC 2020-01-01',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      tarball,
      '-C',
      outputDir,
      bundleName,
    ],
    { stdio: 'pipe' },
  );
} catch (err) {
  fail(`tar failed: ${err instanceof Error ? err.message : String(err)}`);
}

const digest = createHash('sha256')
  .update(readFileSync(tarball))
  .digest('hex');
writeFileSync(
  path.join(outputDir, 'SHA256SUMS'),
  `${digest}  ${bundleName}.tar.gz\n`,
);

rmSync(stageDir, { recursive: true, force: true });

console.log(`bundle:  ${tarball}`);
console.log(`sha256:  ${digest}`);
console.log(`files:   ${assembled.length}`);
