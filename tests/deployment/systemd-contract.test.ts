import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spansSustainedInterval } from './systemd-load-activity';

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

const runAcceptance = (
  environment: Record<string, string>,
): ReturnType<typeof Bun.spawnSync> =>
  Bun.spawnSync({
    cmd: ['bash', 'tests/deployment/run-systemd-acceptance.sh'],
    cwd: repoRoot,
    env: { ...process.env, ...environment },
    stdout: 'pipe',
    stderr: 'pipe',
  });

const runEvidenceFunction = (
  functionName: string,
  ...args: string[]
): ReturnType<typeof Bun.spawnSync> =>
  Bun.spawnSync({
    cmd: [
      'bash',
      '-c',
      'source "$1"; shift; "$@"',
      'systemd-evidence-test',
      path.join(repoRoot, 'tests/deployment/systemd-evidence.sh'),
      functionName,
      ...args,
    ],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

describe('Ubuntu acceptance preflight behavior', () => {
  test('rejects an unsupported phase before mutating the host', () => {
    const protectedPaths = [
      '/opt/mud-web-proxy',
      '/etc/mud-web-proxy.env',
      '/var/lib/mud-web-proxy',
      '/var/lib/mud-web-proxy-deploy',
    ];
    const before = protectedPaths.map((candidate) => existsSync(candidate));
    const result = runAcceptance({
      MWP_ACCEPTANCE_PHASE: 'unsupported',
      MWP_DISPOSABLE_VM_ACK: 'ERASE THIS CLEAN UBUNTU 26.04 VM',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'unsupported MWP_ACCEPTANCE_PHASE: unsupported',
    );
    expect(protectedPaths.map((candidate) => existsSync(candidate))).toEqual(
      before,
    );
  });

  test('requires the exact disposable-host acknowledgement', () => {
    const result = runAcceptance({
      MWP_ACCEPTANCE_PHASE: 'install',
      MWP_DISPOSABLE_VM_ACK: '',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'set the exact disposable VM acknowledgement',
    );
  });
});

describe('systemd shutdown evidence predicates', () => {
  test('ignores symlink mode bits in an immutable tree', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-immutable-'),
    );
    const release = path.join(directory, 'release');
    const artifact = path.join(release, 'artifact');
    try {
      mkdirSync(release, { mode: 0o755 });
      writeFileSync(artifact, 'release artifact\n', { mode: 0o444 });
      symlinkSync('artifact', path.join(release, 'artifact-link'));
      symlinkSync('.', path.join(release, 'directory-link'));
      chmodSync(release, 0o555);
      expect(
        runEvidenceFunction(
          'tree_has_no_writable_files_or_directories',
          release,
        ).exitCode,
      ).toBe(0);
    } finally {
      if (existsSync(release)) chmodSync(release, 0o755);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects writable regular files and directories', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-immutable-'),
    );
    const release = path.join(directory, 'release');
    const artifact = path.join(release, 'artifact');
    try {
      mkdirSync(release, { mode: 0o755 });
      writeFileSync(artifact, 'release artifact\n', { mode: 0o644 });
      chmodSync(release, 0o555);
      expect(
        runEvidenceFunction(
          'tree_has_no_writable_files_or_directories',
          release,
        ).exitCode,
      ).not.toBe(0);

      chmodSync(artifact, 0o444);
      chmodSync(release, 0o755);
      expect(
        runEvidenceFunction(
          'tree_has_no_writable_files_or_directories',
          release,
        ).exitCode,
      ).not.toBe(0);

      chmodSync(release, 0o555);
      expect(
        runEvidenceFunction(
          'tree_has_no_writable_files_or_directories',
          release,
        ).exitCode,
      ).toBe(0);
    } finally {
      if (existsSync(release)) chmodSync(release, 0o755);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects unit and system journal failure vocabulary', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-evidence-'),
    );
    const journal = path.join(directory, 'journal.txt');
    try {
      for (const failure of [
        'write failed: Read-only filesystem',
        'shutdown: state failed: EROFS',
        'drain deadline exceeded',
        'Main process exited, code=killed, status=9/KILL',
        'Out of memory: Killed process 42 (bun)',
      ]) {
        writeFileSync(journal, `${failure}\n`);
        expect(
          runEvidenceFunction('journal_has_unit_failure', journal).exitCode,
        ).toBe(0);
      }
      writeFileSync(journal, 'Welcome to the room\nshutdown: completed\n');
      expect(
        runEvidenceFunction('journal_has_unit_failure', journal).exitCode,
      ).not.toBe(0);

      writeFileSync(journal, 'kernel: oom-kill: Killed process 42 (bun)\n');
      expect(
        runEvidenceFunction('journal_has_system_failure', journal).exitCode,
      ).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('requires complete unchanged terminal memory counters', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-evidence-'),
    );
    const before = path.join(directory, 'before.txt');
    const after = path.join(directory, 'after.txt');
    const baseline =
      'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n';
    try {
      writeFileSync(before, baseline);
      writeFileSync(after, baseline);
      expect(
        runEvidenceFunction('memory_events_unchanged', before, after).exitCode,
      ).toBe(0);

      writeFileSync(after, baseline.replace('oom_kill 0', 'oom_kill 1'));
      expect(
        runEvidenceFunction('memory_events_unchanged', before, after).exitCode,
      ).not.toBe(0);

      writeFileSync(after, 'low 0\nhigh 0\n');
      expect(
        runEvidenceFunction('memory_events_unchanged', before, after).exitCode,
      ).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('systemd load activity evidence', () => {
  test('requires matching traffic near both ends of the sustained interval', () => {
    expect(
      spansSustainedInterval(
        {
          startedAt: 1_000,
          firstOutboundAt: 1_000,
          lastOutboundAt: 59_500,
          firstInboundAt: 1_100,
          lastInboundAt: 59_600,
        },
        61_000,
        60_000,
      ),
    ).toBe(true);
  });

  test('rejects residual login data and beginning-only traffic', () => {
    expect(
      spansSustainedInterval(
        {
          startedAt: 1_000,
          firstOutboundAt: 1_000,
          lastOutboundAt: 2_000,
          firstInboundAt: 900,
          lastInboundAt: 2_100,
        },
        61_000,
        60_000,
      ),
    ).toBe(false);
    expect(
      spansSustainedInterval(
        {
          startedAt: 1_000,
          firstOutboundAt: 1_000,
          lastOutboundAt: 59_500,
          firstInboundAt: 1_100,
          lastInboundAt: 1_100,
        },
        61_000,
        60_000,
      ),
    ).toBe(false);
  });
});
