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
    expect(unit).not.toMatch(/^ExecStop=/m);
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
    expect(unit).not.toContain('DynamicUser=yes');
    expect(unit).not.toContain('PrivateNetwork=true');
    expect(unit).not.toContain('MemoryDenyWriteExecute=true');
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
