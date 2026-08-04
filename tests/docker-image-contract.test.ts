import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const readRoot = (name: string): string =>
  readFileSync(path.join(repoRoot, name), 'utf8');

const stageBody = (dockerfile: string, stage: string): string => {
  const start = dockerfile.indexOf(` AS ${stage}\n`);
  if (start === -1) return '';
  const bodyStart = dockerfile.indexOf('\n', start) + 1;
  const next = dockerfile.indexOf('\nFROM ', bodyStart);
  return dockerfile.slice(bodyStart, next === -1 ? undefined : next);
};

describe('production Docker image contract', () => {
  test('pins Bun and keeps development and production installs separate', () => {
    const dockerfile = readRoot('Dockerfile');
    expect(dockerfile).toContain(
      'ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4',
    );
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(5);

    const dev = stageBody(dockerfile, 'deps-dev');
    const prod = stageBody(dockerfile, 'deps-prod');
    expect(dev).toContain('bun install --frozen-lockfile');
    expect(dev).not.toContain('--production');
    expect(prod).toContain('bun install --frozen-lockfile --production');

    const build = stageBody(dockerfile, 'build');
    const runtime = stageBody(dockerfile, 'runtime');
    expect(build).toContain(
      'COPY --from=deps-dev /opt/mud-web-proxy/node_modules ./node_modules',
    );
    expect(runtime).toContain(
      'COPY --from=deps-prod /opt/mud-web-proxy/node_modules ./node_modules',
    );
  });

  test('contains only the required runtime artifacts and identity', () => {
    const runtime = stageBody(readRoot('Dockerfile'), 'runtime');
    expect(runtime).toContain(
      'COPY --from=build --chown=0:0 --chmod=0444 /opt/mud-web-proxy/dist/wsproxy.js ./dist/wsproxy.js',
    );
    expect(runtime).toContain(
      'COPY --chown=0:0 --chmod=0444 config/apple-app-attest-root-ca.pem ./config/apple-app-attest-root-ca.pem',
    );
    expect(runtime).toContain(
      'COPY --chown=0:0 --chmod=0444 LICENSE NOTICE ./',
    );
    expect(runtime).toContain(
      'ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json',
    );
    expect(runtime).toContain('USER 10001:10001');
    expect(runtime).toContain('STOPSIGNAL SIGTERM');
    expect(runtime).toContain('ENTRYPOINT ["bun", "dist/wsproxy.js"]');
    expect(runtime).toContain('CMD []');
    expect(runtime).not.toMatch(/^\s*(EXPOSE|HEALTHCHECK|VOLUME)\b/m);
    expect(runtime).not.toContain('COPY . .');
  });

  test('uses an allowlisted build context that excludes private material', () => {
    const ignore = readRoot('.dockerignore');
    expect(ignore.startsWith('**\n')).toBe(true);
    for (const included of [
      '!package.json',
      '!bun.lock',
      '!tsconfig.json',
      '!wsproxy.ts',
      '!LICENSE',
      '!NOTICE',
      '!src/',
      '!src/**',
      '!config/',
      '!config/apple-app-attest-root-ca.pem',
    ]) {
      expect(ignore).toContain(included);
    }
    expect(ignore).not.toContain('!cert.pem');
    expect(ignore).not.toContain('!privkey.pem');
  });
});
