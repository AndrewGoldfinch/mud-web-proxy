import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '../..');
const readArtifact = (relativePath: string): string =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

const directiveValues = (unit: string, name: string): string[] =>
  unit
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1));

const requireDirective = (
  unit: string,
  name: string,
  expected: string,
): void => {
  expect(directiveValues(unit, name)).toEqual([expected]);
};

describe('native systemd identity and process contract', () => {
  test('declares one locked persistent service identity', () => {
    const sysusers = readArtifact(
      'deploy/sysusers.d/mud-web-proxy.conf',
    ).trim();
    expect(sysusers).toBe(
      'u! mud-web-proxy - "MUD Web Proxy" /var/lib/mud-web-proxy /usr/sbin/nologin',
    );
  });

  test('starts the release-local Bun runtime as the static user', () => {
    const unit = readArtifact('deploy/systemd/mud-web-proxy.service');
    requireDirective(unit, 'Type', 'exec');
    requireDirective(unit, 'User', 'mud-web-proxy');
    requireDirective(unit, 'Group', 'mud-web-proxy');
    requireDirective(unit, 'DynamicUser', 'no');
    requireDirective(unit, 'EnvironmentFile', '/etc/mud-web-proxy.env');
    requireDirective(unit, 'WorkingDirectory', '/opt/mud-web-proxy/current');
    requireDirective(
      unit,
      'ExecStart',
      '/opt/mud-web-proxy/current/runtime/bin/bun /opt/mud-web-proxy/current/dist/wsproxy.js',
    );
    for (const name of [
      'ExecStop',
      'PrivateNetwork',
      'IPAddressDeny',
      'MemoryDenyWriteExecute',
      'SystemCallFilter',
    ]) {
      expect(directiveValues(unit, name)).toEqual([]);
    }
  });

  test('applies the approved state, sandbox, and capability boundary', () => {
    const unit = readArtifact('deploy/systemd/mud-web-proxy.service');
    for (const [name, value] of [
      ['UMask', '0077'],
      ['StateDirectory', 'mud-web-proxy'],
      ['StateDirectoryMode', '0700'],
      ['ReadWritePaths', '/var/lib/mud-web-proxy'],
      ['NoNewPrivileges', 'true'],
      ['ProtectSystem', 'strict'],
      ['ProtectHome', 'true'],
      ['PrivateTmp', 'true'],
      ['PrivateDevices', 'true'],
      ['ProtectClock', 'true'],
      ['ProtectControlGroups', 'true'],
      ['ProtectHostname', 'true'],
      ['ProtectKernelLogs', 'true'],
      ['ProtectKernelModules', 'true'],
      ['ProtectKernelTunables', 'true'],
      ['ProtectProc', 'invisible'],
      ['ProcSubset', 'pid'],
      ['LockPersonality', 'true'],
      ['RemoveIPC', 'true'],
      ['RestrictNamespaces', 'true'],
      ['RestrictRealtime', 'true'],
      ['RestrictSUIDSGID', 'true'],
      ['SystemCallArchitectures', 'native'],
      ['RestrictAddressFamilies', 'AF_UNIX AF_INET AF_INET6'],
    ] as const) {
      requireDirective(unit, name, value);
    }
    requireDirective(unit, 'CapabilityBoundingSet', '');
    requireDirective(unit, 'AmbientCapabilities', '');
  });

  test('bounds restart, shutdown, memory, tasks, and descriptors', () => {
    const unit = readArtifact('deploy/systemd/mud-web-proxy.service');
    for (const [name, value] of [
      ['Restart', 'on-failure'],
      ['RestartSec', '5s'],
      ['RestartSteps', '4'],
      ['RestartMaxDelaySec', '60s'],
      ['TimeoutStopSec', '30s'],
      ['MemoryHigh', '384M'],
      ['MemoryMax', '512M'],
      ['TasksMax', '128'],
      ['LimitNOFILE', '1024'],
    ] as const) {
      requireDirective(unit, name, value);
    }
  });
});

const parseEnvironment = (source: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`invalid environment line: ${raw}`);
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
};

const durationToMs = (value: string): number => {
  const match = /^([1-9][0-9]*)(ms|s)$/.exec(value);
  if (!match) throw new Error(`unsupported duration: ${value}`);
  const amount = Number(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
};

describe('native environment contract', () => {
  test('keeps plaintext on loopback behind one trusted Caddy hop', () => {
    const env = parseEnvironment(
      readArtifact('config/mud-web-proxy.env.systemd.example'),
    );
    expect(Object.fromEntries(env)).toMatchObject({
      BIND_HOST: '127.0.0.1',
      WS_PORT: '6200',
      INBOUND_TLS_MODE: 'off',
      TARGET_MODE: 'fixed',
      TRUSTED_PROXY_CIDRS: '127.0.0.1',
      ATTESTED_KEYS_PATH: '/var/lib/mud-web-proxy/attested-keys.json',
      SHUTDOWN_GRACE_MS: '3000',
      SHUTDOWN_DEADLINE_MS: '15000',
      MAX_SESSIONS_GLOBAL: '200',
    });
    for (const forbidden of [
      'ALLOW_INSECURE_INBOUND_NO_TLS',
      'TLS_CERT_PATH',
      'TLS_KEY_PATH',
    ]) {
      expect(env.has(forbidden)).toBe(false);
    }
  });

  test('keeps the application deadline below systemd termination', () => {
    const env = parseEnvironment(
      readArtifact('config/mud-web-proxy.env.systemd.example'),
    );
    const unit = readArtifact('deploy/systemd/mud-web-proxy.service');
    const grace = Number(env.get('SHUTDOWN_GRACE_MS'));
    const deadline = Number(env.get('SHUTDOWN_DEADLINE_MS'));
    const stop = durationToMs(directiveValues(unit, 'TimeoutStopSec')[0]);
    expect(grace).toBeGreaterThan(0);
    expect(grace).toBeLessThan(deadline);
    expect(deadline).toBeLessThan(stop);
  });
});

describe('host Caddy template', () => {
  test('uses a reusable hostname and loopback-only upstream', () => {
    const caddy = readArtifact('deploy/caddy/Caddyfile.example');
    expect(caddy).toMatch(/^proxy\.example\.com\s*\{/);
    expect(caddy).toContain('reverse_proxy 127.0.0.1:6200');
    expect(caddy).not.toMatch(
      /reverse_proxy\s+(?:0\.0\.0\.0|\[?::\]?|localhost):6200/,
    );
  });

  test('overwrites both accepted client-IP headers', () => {
    const caddy = readArtifact('deploy/caddy/Caddyfile.example');
    expect(
      caddy.match(/header_up X-Forwarded-For \{remote_host\}/g),
    ).toHaveLength(1);
    expect(caddy.match(/header_up X-Real-IP \{remote_host\}/g)).toHaveLength(
      1,
    );
    expect(caddy).not.toMatch(/header_up \+X-(?:Forwarded-For|Real-IP)/);
  });
});
