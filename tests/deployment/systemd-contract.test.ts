import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
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

const runDeploymentBunScript = (
  script: string,
  ...args: string[]
): ReturnType<typeof Bun.spawnSync> =>
  Bun.spawnSync({
    cmd: [process.execPath, path.join(repoRoot, script), ...args],
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

interface BuildInput {
  imports: Array<{ path: string; external?: boolean }>;
}

interface BuildOutput {
  inputs: Record<string, { bytesInOutput: number }>;
}

interface BuildMetafile {
  inputs: Record<string, BuildInput>;
  outputs: Record<string, BuildOutput>;
}

describe('Node acceptance client build boundary', () => {
  test('bundles local helpers but leaves npm ws for Node to load', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-node-clients-'),
    );
    const outputDirectory = path.join(directory, 'out');
    const metafile = path.join(directory, 'metafile.json');
    try {
      const result = Bun.spawnSync({
        cmd: [
          'bash',
          'tests/deployment/build-systemd-acceptance-clients.sh',
          outputDirectory,
          metafile,
        ],
        cwd: repoRoot,
        env: { ...process.env, BUN_BIN: process.execPath },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);

      const metadata = JSON.parse(
        readFileSync(metafile, 'utf8'),
      ) as BuildMetafile;
      const clientInputs = Object.entries(metadata.inputs).filter(([name]) =>
        /systemd-(?:acceptance|load)-client\.ts$/.test(name),
      );
      expect(clientInputs).toHaveLength(2);
      for (const [, input] of clientInputs) {
        expect(
          input.imports.some(
            (dependency) =>
              dependency.path === 'ws' && dependency.external === true,
          ),
        ).toBe(true);
      }

      const loadOutput = Object.entries(metadata.outputs).find(([name]) =>
        name.endsWith('systemd-load-client.js'),
      )?.[1];
      expect(loadOutput).toBeDefined();
      expect(
        Object.entries(loadOutput?.inputs ?? {}).some(
          ([name, input]) =>
            name.endsWith('systemd-load-activity.ts') &&
            input.bytesInOutput > 0,
        ),
      ).toBe(true);
      expect(
        existsSync(path.join(outputDirectory, 'systemd-acceptance-client.js')),
      ).toBe(true);
      expect(
        existsSync(path.join(outputDirectory, 'systemd-load-client.js')),
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('systemd shutdown evidence predicates', () => {
  test('bounds the live resource sampler even without a stop signal', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-resource-sampler-'),
    );
    const fakeSystemctl = path.join(directory, 'systemctl');
    const stopFile = path.join(directory, 'stop');
    try {
      writeFileSync(
        fakeSystemctl,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == is-active ]]; then
  printf 'active\\n'
  exit 0
fi
if [[ "$1" == show && "$2" == -p && "$4" == --value ]]; then
  case "$3" in
    MainPID) printf '%s\\n' "\${FAKE_MAIN_PID}" ;;
    TasksCurrent) printf '3\\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );
      const result = Bun.spawnSync({
        cmd: [
          'bash',
          'tests/deployment/systemd-resource-sampler.sh',
          'mud-web-proxy.service',
          stopFile,
        ],
        cwd: repoRoot,
        env: {
          ...process.env,
          SYSTEMCTL_BIN: fakeSystemctl,
          FAKE_MAIN_PID: String(process.pid),
          MWP_RESOURCE_SAMPLE_LIMIT: '1',
          MWP_RESOURCE_SAMPLE_INTERVAL: '0.001',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).not.toBe(0);
      const lines = result.stdout.toString().trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(
        'sample\tmonotonic_ms\tstate\tmain_pid\ttasks\tfile_descriptors',
      );
      expect(lines[1]).toMatch(
        /^1\t[0-9]+\tactive\t[1-9][0-9]*\t3\t[1-9][0-9]*$/,
      );
      expect(result.stderr.toString()).toContain(
        'resource sampler reached its sample limit',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('samples a normal drain after the main process exits', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-resource-drain-'),
    );
    const fakeSystemctl = path.join(directory, 'systemctl');
    const stopFile = path.join(directory, 'stop');
    try {
      writeFileSync(
        fakeSystemctl,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == is-active ]]; then
  printf 'deactivating\\n'
  exit 0
fi
if [[ "$1" == show && "$2" == -p && "$4" == --value ]]; then
  case "$3" in
    MainPID) printf '0\\n' ;;
    TasksCurrent) printf '[not set]\\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );
      writeFileSync(stopFile, 'stop\n');
      const result = Bun.spawnSync({
        cmd: [
          'bash',
          'tests/deployment/systemd-resource-sampler.sh',
          'mud-web-proxy.service',
          stopFile,
        ],
        cwd: repoRoot,
        env: { ...process.env, SYSTEMCTL_BIN: fakeSystemctl },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim().split('\n')[1]).toMatch(
        /^1\t[0-9]+\tdeactivating\t0\t0\t0$/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rechecks service state when the main process exits between reads', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-resource-state-race-'),
    );
    const fakeSystemctl = path.join(directory, 'systemctl');
    const stateReads = path.join(directory, 'state-reads');
    const stopFile = path.join(directory, 'stop');
    try {
      writeFileSync(
        fakeSystemctl,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == is-active ]]; then
  reads=0
  [[ ! -e "\${FAKE_STATE_READS}" ]] || reads="$(<"\${FAKE_STATE_READS}")"
  reads=$((reads + 1))
  printf '%s\n' "\${reads}" >"\${FAKE_STATE_READS}"
  if ((reads == 1)); then
    printf 'active\n'
  else
    printf 'inactive\n'
  fi
  exit 0
fi
if [[ "$1" == show && "$2" == -p && "$4" == --value ]]; then
  case "$3" in
    MainPID) printf '0\n' ;;
    TasksCurrent) printf '[not set]\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );
      writeFileSync(stopFile, 'stop\n');
      const result = Bun.spawnSync({
        cmd: [
          'bash',
          'tests/deployment/systemd-resource-sampler.sh',
          'mud-web-proxy.service',
          stopFile,
        ],
        cwd: repoRoot,
        env: {
          ...process.env,
          FAKE_STATE_READS: stateReads,
          SYSTEMCTL_BIN: fakeSystemctl,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim().split('\n')[1]).toMatch(
        /^1\t[0-9]+\tinactive\t0\t0\t0$/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('derives task and descriptor peaks from a complete sample series', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-resource-peaks-'),
    );
    const samples = path.join(directory, 'samples.tsv');
    const peaks = path.join(directory, 'peaks.txt');
    try {
      writeFileSync(
        samples,
        [
          'sample\tmonotonic_ms\tstate\tmain_pid\ttasks\tfile_descriptors',
          '1\t1000\tactive\t42\t4\t100',
          '2\t1100\tactive\t42\t6\t117',
          '3\t1200\tdeactivating\t42\t5\t80',
          '4\t1300\tinactive\t0\t0\t0',
          '',
        ].join('\n'),
      );
      expect(
        runEvidenceFunction(
          'resource_sample_peaks',
          samples,
          peaks,
          '128',
          '1024',
        ).exitCode,
      ).toBe(0);
      expect(readFileSync(peaks, 'utf8')).toBe(
        'Samples=4\nFirstMonotonicMs=1000\nLastMonotonicMs=1300\nTaskPeak=6\nFileDescriptorPeak=117\n',
      );

      writeFileSync(
        samples,
        readFileSync(samples, 'utf8').replace(
          '2\t1100\tactive\t42\t6\t117',
          '2\t1100\tactive\t42\t128\t117',
        ),
      );
      expect(
        runEvidenceFunction(
          'resource_sample_peaks',
          samples,
          peaks,
          '128',
          '1024',
        ).exitCode,
      ).not.toBe(0);

      writeFileSync(
        samples,
        readFileSync(samples, 'utf8').replace(
          '2\t1100\tactive\t42\t128\t117',
          '2\t1100\tactive\t42\t6\t1024',
        ),
      );
      expect(
        runEvidenceFunction(
          'resource_sample_peaks',
          samples,
          peaks,
          '128',
          '1024',
        ).exitCode,
      ).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('requires one-GiB memory and one logical CPU in host preflight', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-host-shape-'),
    );
    const meminfo = path.join(directory, 'meminfo');
    try {
      writeFileSync(meminfo, 'MemTotal:         979308 kB\n');
      expect(
        runEvidenceFunction('host_shape_matches', meminfo, '1').exitCode,
      ).toBe(0);

      for (const [memory, cpus] of [
        ['899999', '1'],
        ['1200001', '1'],
        ['979308', '2'],
        ['not-a-number', '1'],
      ]) {
        writeFileSync(meminfo, `MemTotal:         ${memory} kB\n`);
        expect(
          runEvidenceFunction('host_shape_matches', meminfo, cpus).exitCode,
        ).not.toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('records two valid and different boot IDs in copied evidence', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-boot-ids-'),
    );
    const output = path.join(directory, 'boot-ids.txt');
    const install = '11111111-1111-4111-8111-111111111111';
    const postReboot = '22222222-2222-4222-8222-222222222222';
    try {
      expect(
        runEvidenceFunction('record_boot_id_pair', install, postReboot, output)
          .exitCode,
      ).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(
        `install-boot-id=${install}\npost-reboot-boot-id=${postReboot}\n`,
      );
      expect(
        runEvidenceFunction('record_boot_id_pair', install, install, output)
          .exitCode,
      ).not.toBe(0);
      expect(
        runEvidenceFunction(
          'record_boot_id_pair',
          'invalid',
          postReboot,
          output,
        ).exitCode,
      ).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('accepts only one matching archive checksum from a manifest', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-node-manifest-'),
    );
    const archive = path.join(directory, 'node-v22.21.1-linux-x64.tar.gz');
    const manifest = path.join(directory, 'SHASUMS256.txt');
    const archiveBody = 'node acceptance archive\n';
    const checksum = createHash('sha256').update(archiveBody).digest('hex');
    const entry = `${checksum}  ${path.basename(archive)}\n`;
    try {
      writeFileSync(archive, archiveBody);
      writeFileSync(manifest, entry);
      expect(
        runEvidenceFunction(
          'archive_matches_sha256_manifest',
          manifest,
          archive,
        ).exitCode,
      ).toBe(0);

      writeFileSync(manifest, entry.replace(checksum, '0'.repeat(64)));
      expect(
        runEvidenceFunction(
          'archive_matches_sha256_manifest',
          manifest,
          archive,
        ).exitCode,
      ).not.toBe(0);

      writeFileSync(manifest, entry + entry);
      expect(
        runEvidenceFunction(
          'archive_matches_sha256_manifest',
          manifest,
          archive,
        ).exitCode,
      ).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

describe('systemd security residual comparison', () => {
  const baseline = {
    residuals: [
      { assessment: 'RootDirectory=/RootImage=', reason: 'required fixture' },
      {
        assessment: 'MemoryDenyWriteExecute=',
        reason: 'required fixture',
      },
    ],
  };

  test('retains an exact sorted live-to-baseline residual match', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-security-residuals-'),
    );
    const report = path.join(directory, 'report.txt');
    const baselineFile = path.join(directory, 'baseline.json');
    const comparison = path.join(directory, 'comparison.json');
    try {
      writeFileSync(baselineFile, `${JSON.stringify(baseline)}\n`);
      writeFileSync(
        report,
        [
          '  NAME                            DESCRIPTION             EXPOSURE',
          '✗ MemoryDenyWriteExecute=         Writable executable         0.1',
          '✗ RootDirectory=/RootImage=       Host root                   0.1',
          '',
          '→ Overall exposure level for mud-web-proxy.service: 2.8 OK',
          '',
        ].join('\n'),
      );
      const result = runDeploymentBunScript(
        'tests/deployment/systemd-security-residuals.ts',
        report,
        baselineFile,
        comparison,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(comparison, 'utf8'))).toEqual({
        status: 'match',
        baselineIdentifiers: [
          'MemoryDenyWriteExecute=',
          'RootDirectory=/RootImage=',
        ],
        liveIdentifiers: [
          'MemoryDenyWriteExecute=',
          'RootDirectory=/RootImage=',
        ],
        missing: [],
        extra: [],
        baselineDuplicates: [],
        liveDuplicates: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects missing, extra, and duplicate live residuals', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-security-residuals-'),
    );
    const report = path.join(directory, 'report.txt');
    const baselineFile = path.join(directory, 'baseline.json');
    const comparison = path.join(directory, 'comparison.json');
    try {
      writeFileSync(baselineFile, `${JSON.stringify(baseline)}\n`);
      for (const [body, expected] of [
        [
          '✗ RootDirectory=/RootImage=       Host root          0.1\n',
          {
            missing: ['MemoryDenyWriteExecute='],
            extra: [],
            liveDuplicates: [],
          },
        ],
        [
          '✗ RootDirectory=/RootImage=       Host root          0.1\n' +
            '✗ MemoryDenyWriteExecute=       JIT memory         0.1\n' +
            '✗ PrivateNetwork=               Host network       0.5\n',
          {
            missing: [],
            extra: ['PrivateNetwork='],
            liveDuplicates: [],
          },
        ],
        [
          '✗ RootDirectory=/RootImage=       Host root          0.1\n' +
            '✗ RootDirectory=/RootImage=     Host root again    0.1\n' +
            '✗ MemoryDenyWriteExecute=       JIT memory         0.1\n',
          {
            missing: [],
            extra: [],
            liveDuplicates: ['RootDirectory=/RootImage='],
          },
        ],
      ] as const) {
        writeFileSync(report, body);
        const result = runDeploymentBunScript(
          'tests/deployment/systemd-security-residuals.ts',
          report,
          baselineFile,
          comparison,
        );
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(readFileSync(comparison, 'utf8'))).toMatchObject({
          status: 'mismatch',
          ...expected,
        });
      }

      rmSync(comparison, { force: true });
      writeFileSync(report, '✗ malformed-assessment-line\n');
      expect(
        runDeploymentBunScript(
          'tests/deployment/systemd-security-residuals.ts',
          report,
          baselineFile,
          comparison,
        ).exitCode,
      ).not.toBe(0);
      expect(JSON.parse(readFileSync(comparison, 'utf8'))).toEqual({
        status: 'invalid',
        error: 'unparseable failed systemd assessment',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('DigitalOcean acceptance evidence', () => {
  test('normalizes the exact provider shape without retaining extra fields', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'mwp-systemd-provider-evidence-'),
    );
    const input = path.join(directory, 'input.json');
    const output = path.join(directory, 'output.json');
    const valid = {
      dropletId: 123,
      name: 'mwp-105-acceptance-verify-fixture',
      regionSlug: 'nyc3',
      imageSlug: 'ubuntu-26-04-x64',
      sizeSlug: 's-1vcpu-1gb',
      memoryMiB: 1024,
      vcpus: 1,
      diskGiB: 25,
      status: 'active',
      capturedAt: '2026-07-31T15:00:00Z',
      networks: 'must-not-be-retained',
    };
    try {
      writeFileSync(input, `${JSON.stringify(valid)}\n`);
      const result = runDeploymentBunScript(
        'tests/deployment/digitalocean-evidence.ts',
        input,
        output,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
        dropletId: 123,
        name: 'mwp-105-acceptance-verify-fixture',
        regionSlug: 'nyc3',
        imageSlug: 'ubuntu-26-04-x64',
        sizeSlug: 's-1vcpu-1gb',
        memoryMiB: 1024,
        vcpus: 1,
        diskGiB: 25,
        status: 'active',
        capturedAt: '2026-07-31T15:00:00Z',
      });

      for (const invalid of [
        { ...valid, imageSlug: 'ubuntu-other' },
        { ...valid, sizeSlug: 's-2vcpu-2gb' },
        { ...valid, regionSlug: '' },
        { ...valid, memoryMiB: 2048 },
        { ...valid, vcpus: 2 },
        { ...valid, diskGiB: 50 },
        { ...valid, status: 'off' },
        { ...valid, name: 'production' },
      ]) {
        writeFileSync(input, `${JSON.stringify(invalid)}\n`);
        expect(
          runDeploymentBunScript(
            'tests/deployment/digitalocean-evidence.ts',
            input,
            output,
          ).exitCode,
        ).not.toBe(0);
      }
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

interface SecurityBaseline {
  image: string;
  osVersion: string;
  architecture: string;
  systemdPackage: string;
  measuredExposure: number;
  maximumExposure: number;
  residuals: Array<{ assessment: string; reason: string }>;
}

const convertSystemdThreshold = async (
  exposure: string,
): Promise<{ status: number; stdout: string }> => {
  const process = Bun.spawn({
    cmd: [
      'bash',
      path.join(repoRoot, 'tests/deployment/systemd-exposure-threshold.sh'),
      exposure,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(process.stdout).text();
  return { status: await process.exited, stdout };
};

test('converts one-decimal exposure scores to strict CLI percentages', async () => {
  for (const [exposure, percentage] of [
    ['0.0', '0'],
    ['2.9', '29'],
    ['9.9', '99'],
    ['10.0', '100'],
  ]) {
    expect(await convertSystemdThreshold(exposure)).toEqual({
      status: 0,
      stdout: `${percentage}\n`,
    });
  }

  for (const exposure of [
    '',
    '-0.1',
    '2',
    '2.90',
    '02.9',
    '10.1',
    '11.0',
    'not-a-number',
  ]) {
    expect((await convertSystemdThreshold(exposure)).status).not.toBe(0);
  }
});

test('pins a measured Ubuntu security regression baseline', async () => {
  const baselinePath = path.join(
    repoRoot,
    'tests/deployment/systemd-security-baseline.json',
  );
  const baselineExists = existsSync(baselinePath);
  expect(baselineExists).toBe(true);
  if (!baselineExists) return;

  const baseline = (await Bun.file(baselinePath).json()) as SecurityBaseline;
  expect(baseline.image).toBe('ubuntu-26-04-x64');
  expect(baseline.osVersion).toBe('26.04');
  expect(baseline.architecture).toBe('x86_64');
  expect(baseline.systemdPackage).toMatch(/^[0-9]/);
  expect(Number.isInteger(baseline.measuredExposure * 10)).toBe(true);
  expect(Number.isInteger(baseline.maximumExposure * 10)).toBe(true);
  expect(
    Math.round((baseline.maximumExposure - baseline.measuredExposure) * 10),
  ).toBe(1);
  expect(baseline.residuals).toHaveLength(19);
  expect(
    new Set(baseline.residuals.map((residual) => residual.assessment)).size,
  ).toBe(baseline.residuals.length);
  for (const residual of baseline.residuals) {
    expect(residual.assessment.trim()).not.toBe('');
    expect(residual.reason.trim()).not.toBe('');
  }
});
