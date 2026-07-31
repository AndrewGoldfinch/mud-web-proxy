# Hardened systemd and host Caddy implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship and verify the static-user systemd service, native environment,
and host Caddy edge for the Ubuntu 26.04 new-Droplet deployment.

**Architecture:** Caddy owns public HTTPS/WSS on ports 80 and 443 and proxies
to a Bun process listening only on `127.0.0.1:6200`. systemd runs that process
from the MWP-104 immutable `current` release as a locked persistent user with a
strict read-only filesystem and one durable state-directory exception. Static
contract tests run in ordinary CI; a disposable Ubuntu 26.04 VM run validates
the actual sandbox, hostname resolution, resource profile, shutdown, Caddy
header boundary, reboot behavior, and measured systemd security score.

**Tech Stack:** Bun 1.3.14, TypeScript, Bun test, systemd 259 on Ubuntu 26.04
LTS x64, Caddy's official Ubuntu package, Bash, WebSocket/Telnet test helpers.

## Global constraints

- Work only in the MWP-105 worktree and preserve unrelated user changes.
- The sole native host target is DigitalOcean `ubuntu-26-04-x64`; do not add a
  24.04 matrix or an in-place migration path.
- Use the exact command
  `/opt/mud-web-proxy/current/runtime/bin/bun
/opt/mud-web-proxy/current/dist/wsproxy.js`.
- Use `User=mud-web-proxy`, `Group=mud-web-proxy`, `DynamicUser=no`,
  `StateDirectory=mud-web-proxy`, `StateDirectoryMode=0700`, and `UMask=0077`.
- Never recommend or accept `DynamicUser=yes`.
- The only persistent path writable by the application is
  `/var/lib/mud-web-proxy`; service-private `/tmp` and `/var/tmp` remain
  ephemeral exceptions.
- Native topology is `BIND_HOST=127.0.0.1`, `WS_PORT=6200`,
  `INBOUND_TLS_MODE=off`, `TARGET_MODE=fixed`, and
  `TRUSTED_PROXY_CIDRS=127.0.0.1`.
- Native configuration omits `ALLOW_INSECURE_INBOUND_NO_TLS`,
  `TLS_CERT_PATH`, and `TLS_KEY_PATH`.
- Set `SHUTDOWN_GRACE_MS=3000`, `SHUTDOWN_DEADLINE_MS=15000`, and
  `TimeoutStopSec=30s`.
- Set `MAX_SESSIONS_GLOBAL=200`, `LimitNOFILE=1024`,
  `MemoryHigh=384M`, `MemoryMax=512M`, and `TasksMax=128`.
- Caddy must overwrite both `X-Forwarded-For` and `X-Real-IP`; neither may be
  appended or passed through.
- The public repository carries `proxy.example.com`, never the production
  hostname or production secrets.
- Keep `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` unless the Ubuntu
  hostname test proves `AF_NETLINK` is required. If it does, update the design,
  unit, test, baseline explanation, and documentation together.
- The clean-host resource profile is at least 50 simultaneous sessions with
  periodic bidirectional traffic for at least 60 seconds. It is a lower bound,
  not proof of the 200-session ceiling.
- Do not guess a `systemd-analyze security` threshold. Record the first
  Ubuntu 26.04 score and commit a maximum exactly 0.1 above it.
- Never run the destructive acceptance setup on an existing host. The script
  requires an explicit disposable-host acknowledgement and still refuses any
  existing production-shaped path.
- Do not weaken the acceptance script to make a failing hardening directive
  pass. Capture the failure, identify the required behavior, and revise the
  design explicitly.

## File map

| Path                                                                     | Responsibility                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `deploy/systemd/mud-web-proxy.service`                                   | Exact process, lifecycle, resource, and sandbox contract.                                     |
| `deploy/sysusers.d/mud-web-proxy.conf`                                   | Locked persistent service user and matching group.                                            |
| `deploy/caddy/Caddyfile.example`                                         | Reusable public-hostname template and forwarded-IP overwrite boundary.                        |
| `config/mud-web-proxy.env.systemd.example`                               | Native topology, shutdown, capacity, and placeholder target values.                           |
| `tests/deployment/systemd-contract.test.ts`                              | Fast source-level assertions over all shipped deployment artifacts.                           |
| `tests/deployment/systemd-acceptance-client.ts`                          | WSS, App Attest CA-load, spoofed-header, and graceful-close client.                           |
| `tests/deployment/systemd-load-client.ts`                                | Fifty-session sustained bidirectional load and shutdown observer.                             |
| `tests/deployment/run-systemd-acceptance.sh`                             | Fail-closed disposable Ubuntu host orchestration and evidence capture.                        |
| `tests/deployment/systemd-security-baseline.json`                        | Measured Ubuntu/systemd identity, exposure score, allowed maximum, and residual explanations. |
| `docs/deployment/systemd.md`                                             | Installation and day-two native operations.                                                   |
| `docs/deployment/systemd-acceptance.md`                                  | Disposable VM prerequisites, execution, evidence, and cleanup.                                |
| `README.md`                                                              | Short native deployment entry point linking to the shipped files.                             |
| `package.json`                                                           | Includes nested deployment contract tests in `test:unit`.                                     |
| `docs/superpowers/specs/2026-07-30-hardened-systemd-and-caddy-design.md` | Records any evidence-driven `AF_NETLINK`, resource, or score adjustment.                      |

---

### Task 1: Ship the static identity and hardened systemd unit

**Files:**

- Create: `deploy/systemd/mud-web-proxy.service`
- Create: `deploy/sysusers.d/mud-web-proxy.conf`
- Create: `tests/deployment/systemd-contract.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: MWP-104 paths under `/opt/mud-web-proxy/current`,
  `/etc/mud-web-proxy.env`, and `/var/lib/mud-web-proxy`.
- Produces: the exact `mud-web-proxy.service`, sysusers declaration, and
  `readArtifact(relativePath: string): string` test helper used by Task 2.

- [ ] **Step 1: Add the nested deployment test entry point and failing unit
      contract**

Change both `test` and `test:unit` in `package.json` to:

```json
"test": "bun test tests/*.test.ts tests/deployment/*.test.ts --coverage",
"test:unit": "bun test tests/*.test.ts tests/deployment/*.test.ts --coverage"
```

Create `tests/deployment/systemd-contract.test.ts` with these helpers and
assertions:

```typescript
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
```

- [ ] **Step 2: Run the focused test and prove the artifacts are missing**

Run:

```bash
bun test tests/deployment/systemd-contract.test.ts
```

Expected: FAIL with `ENOENT` for
`deploy/sysusers.d/mud-web-proxy.conf` or
`deploy/systemd/mud-web-proxy.service`.

- [ ] **Step 3: Create the sysusers declaration**

Create `deploy/sysusers.d/mud-web-proxy.conf`:

```text
u! mud-web-proxy - "MUD Web Proxy" /var/lib/mud-web-proxy /usr/sbin/nologin
```

- [ ] **Step 4: Create the hardened unit**

Create `deploy/systemd/mud-web-proxy.service`:

```ini
[Unit]
Description=MUD Web Proxy
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
User=mud-web-proxy
Group=mud-web-proxy
DynamicUser=no
EnvironmentFile=/etc/mud-web-proxy.env
WorkingDirectory=/opt/mud-web-proxy/current
ExecStart=/opt/mud-web-proxy/current/runtime/bin/bun /opt/mud-web-proxy/current/dist/wsproxy.js

Restart=on-failure
RestartSec=5s
RestartSteps=4
RestartMaxDelaySec=60s
TimeoutStopSec=30s

UMask=0077
StateDirectory=mud-web-proxy
StateDirectoryMode=0700
ReadWritePaths=/var/lib/mud-web-proxy

NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectClock=true
ProtectControlGroups=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectProc=invisible
ProcSubset=pid
LockPersonality=true
RemoveIPC=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

MemoryHigh=384M
MemoryMax=512M
TasksMax=128
LimitNOFILE=1024

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Do not add `ExecStop`, `PrivateNetwork`, `IPAddressDeny`,
`MemoryDenyWriteExecute`, or a speculative `SystemCallFilter`.

- [ ] **Step 5: Run the focused and full unit suites**

Run:

```bash
bun test tests/deployment/systemd-contract.test.ts
bun run test:unit
```

Expected: both commands PASS; the full suite includes
`tests/deployment/systemd-contract.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add package.json deploy/systemd/mud-web-proxy.service \
  deploy/sysusers.d/mud-web-proxy.conf \
  tests/deployment/systemd-contract.test.ts
git commit -m "feat: add hardened systemd service"
```

---

### Task 2: Ship the native environment and Caddy templates

**Files:**

- Create: `config/mud-web-proxy.env.systemd.example`
- Create: `deploy/caddy/Caddyfile.example`
- Modify: `tests/deployment/systemd-contract.test.ts`

**Interfaces:**

- Consumes: `readArtifact`, `directiveValues`, and `requireDirective` from
  Task 1.
- Produces: `parseEnvironment(source: string): Map<string, string>` and
  `durationToMs(value: string): number`, reused by later contract assertions.

- [ ] **Step 1: Add failing native-environment and Caddy tests**

Append:

```typescript
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
```

Format the long `expect` lines with Prettier rather than hand-wrapping them.

- [ ] **Step 2: Run the focused test and prove both templates are missing**

Run:

```bash
bun test tests/deployment/systemd-contract.test.ts
```

Expected: FAIL with `ENOENT` for the systemd environment example.

- [ ] **Step 3: Create the native environment example**

Create `config/mud-web-proxy.env.systemd.example`:

```dotenv
# Native host-Caddy topology. Copy to /etc/mud-web-proxy.env, replace the
# example target and origin values, add production auth/App Attest/APNs
# settings when enabled, then install as 0640 root:mud-web-proxy.
BIND_HOST=127.0.0.1
WS_PORT=6200
INBOUND_TLS_MODE=off
TARGET_MODE=fixed
TN_HOST=mud.example.com
TN_PORT=4000
MUD_TLS_MODE=prefer
ALLOWED_ORIGINS=https://proxy.example.com
TRUSTED_PROXY_CIDRS=127.0.0.1
ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
SHUTDOWN_GRACE_MS=3000
SHUTDOWN_DEADLINE_MS=15000
MAX_SESSIONS_GLOBAL=200
LOG_LEVEL=INFO
```

Do not add the three forbidden native variables, even as commented
assignments; the contract test intentionally treats the example as the
copyable source.

- [ ] **Step 4: Create the reusable Caddy template**

Create `deploy/caddy/Caddyfile.example`:

```caddyfile
proxy.example.com {
	reverse_proxy 127.0.0.1:6200 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Real-IP {remote_host}
	}
}
```

Do not add `tls internal` to the production template. The acceptance script
gets local certificates automatically by rendering the reserved template to
`localhost`.

- [ ] **Step 5: Run focused tests and format checks**

Run:

```bash
bun test tests/deployment/systemd-contract.test.ts
bun run check:config-docs
bunx prettier --check \
  config/mud-web-proxy.env.systemd.example \
  deploy/caddy/Caddyfile.example \
  deploy/systemd/mud-web-proxy.service \
  tests/deployment/systemd-contract.test.ts
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add config/mud-web-proxy.env.systemd.example \
  deploy/caddy/Caddyfile.example \
  tests/deployment/systemd-contract.test.ts
git commit -m "feat: add native Caddy and environment templates"
```

---

### Task 3: Build the fail-closed Ubuntu acceptance harness

**Files:**

- Create: `tests/deployment/systemd-acceptance-client.ts`
- Create: `tests/deployment/systemd-load-client.ts`
- Create: `tests/deployment/run-systemd-acceptance.sh`
- Modify: `tests/deployment/systemd-contract.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: the four deployment artifacts from Tasks 1 and 2, the existing
  `tests/e2e/mock-mud.ts`, the MWP-104 release layout, and a clean root shell
  on Ubuntu 26.04.
- Produces:
  - `systemd-acceptance-client: ca-loaded`
  - `systemd-acceptance-client: spoof-probe-ready`
  - `systemd-load-client: 50 sessions ready`
  - `systemd-load-client: sustained`
  - `systemd-load-client: graceful-close-observed`
  - evidence under a root-only directory printed by the shell runner.

- [ ] **Step 1: Add failing behavioral contracts for acceptance preflight**

Import `existsSync` from `fs`, then append:

```typescript
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
```

Add a package script:

```json
"test:systemd": "bun test tests/deployment/systemd-contract.test.ts",
"test:systemd:acceptance": "bash tests/deployment/run-systemd-acceptance.sh"
```

- [ ] **Step 2: Run the focused test and prove the runner is missing**

Run:

```bash
bun run test:systemd
```

Expected: FAIL because the missing runner exits with Bash's file-not-found
diagnostic instead of the required preflight diagnostics.

- [ ] **Step 3: Create the single-session acceptance client**

Create `tests/deployment/systemd-acceptance-client.ts` by extracting the
timeout, App Attest invalid-chain, and session state machine from
`tests/container/acceptance-client.ts`. Its exact runtime interface is:

```typescript
interface AcceptanceEnvironment {
  PROXY_HTTP_URL: string;
  PROXY_WS_URL: string;
  CADDY_CA_PATH: string;
  MUD_HOST: string;
  MUD_PORT: string;
}
```

Implement these required differences:

```typescript
import { encode } from 'cbor-x';
import { readFileSync } from 'fs';
import WebSocket from 'ws';

const required = (name: keyof AcceptanceEnvironment): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`systemd-acceptance-client: missing ${name}`);
  }
  return value;
};

const ca = readFileSync(required('CADDY_CA_PATH'));
const socket = new WebSocket(required('PROXY_WS_URL'), {
  ca,
  rejectUnauthorized: true,
  headers: {
    'X-Forwarded-For': '198.51.100.77',
    'X-Real-IP': '203.0.113.88',
  },
});
```

Use `PROXY_HTTP_URL=http://127.0.0.1:6200` for the App Attest challenge and
invalid registration, so that test exercises the release CA file without
disabling TLS verification. Use WSS and the explicit Caddy CA for the session.
The connect frame must use `MUD_HOST=mwp-mud.test` and `MUD_PORT=6300`.

After the invalid registration reaches certificate parsing, print:

```text
systemd-acceptance-client: ca-loaded
```

After the WSS connection has received the mock welcome text, print:

```text
systemd-acceptance-client: spoof-probe-ready
```

Keep the socket open. On close, require code 1001 and reason
`Server restarting`, then print:

```text
systemd-acceptance-client: graceful-close-observed
```

Every wait uses the existing `withTimeout` pattern. Do not set
`NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: false`, or a generic
TLS bypass.

- [ ] **Step 4: Create the fifty-session load client**

Create `tests/deployment/systemd-load-client.ts`. Use the `ws` package and
these exact defaults:

```typescript
const sessionCount = Number(process.env.SESSION_COUNT ?? '50');
const sustainMs = Number(process.env.SUSTAIN_MS ?? '60000');
const wsUrl = process.env.PROXY_WS_URL ?? 'wss://localhost';
const mudHost = process.env.MUD_HOST ?? 'mwp-mud.test';
const mudPort = Number(process.env.MUD_PORT ?? '6300');
```

Read `CADDY_CA_PATH` and pass `ca` with `rejectUnauthorized: true` to every
socket. For each socket:

1. send the typed connect frame for `mwp-mud.test:6300`;
2. send a unique `systemd-load-${index}` login every 250 ms until the mock
   welcome message arrives;
3. resolve that socket's ready promise only after the welcome;
4. send `look ${index}\r\n` every second during the sustained phase; and
5. keep the socket open after the sustained phase.

After all 50 ready promises resolve, print:

```text
systemd-load-client: 50 sessions ready
```

After 60 seconds, print:

```text
systemd-load-client: sustained
```

Then wait for all sockets to close. Require code 1001 and reason
`Server restarting` for every socket, clear every interval, and print:

```text
systemd-load-client: graceful-close-observed
```

Reject duplicate ready/close resolution, proxy error frames, early close,
unexpected close reason, or any 20-second per-phase timeout.

- [ ] **Step 5: Create the fail-closed shell runner**

Create `tests/deployment/run-systemd-acceptance.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly INSTALL_ROOT=/opt/mud-web-proxy
readonly ENV_FILE=/etc/mud-web-proxy.env
readonly STATE_DIR=/var/lib/mud-web-proxy
readonly DEPLOY_STATE_DIR=/var/lib/mud-web-proxy-deploy
readonly TEST_MUD_NAME=mwp-mud.test
readonly TEST_MUD_PORT=6300
readonly SESSION_COUNT=50
readonly SUSTAIN_MS=60000
readonly SECURITY_MODE="${MWP_SECURITY_MODE:-verify}"
readonly ACCEPTANCE_PHASE="${MWP_ACCEPTANCE_PHASE:-install}"
readonly EVIDENCE_DIR="/root/mwp-105-evidence-$(date -u +%Y%m%dT%H%M%SZ)"

mock_mud_pid=
acceptance_client_pid=
load_client_pid=

fail() {
  echo "systemd-acceptance: $*" >&2
  exit 1
}

cleanup() {
  systemctl stop mud-web-proxy caddy >/dev/null 2>&1 || true
  if [[ -n "${acceptance_client_pid}" ]]; then
    kill "${acceptance_client_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${load_client_pid}" ]]; then
    kill "${load_client_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${mock_mud_pid}" ]]; then
    kill "${mock_mud_pid}" >/dev/null 2>&1 || true
  fi
}
```

Validate `MWP_ACCEPTANCE_PHASE` before every host or privilege check. In the
`install` phase, call `require_disposable_host` before registering any trap;
only a host that passes the complete clean-host gate may install:

```bash
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
```

This ordering makes unsupported-phase, missing-acknowledgement, and
existing-installation failures observable without stopping services or
changing files.

Implement the following functions with the stated fail-closed behavior:

```bash
require_disposable_host()     # root, exact ack, 26.04, x86_64, four absent paths
install_caddy()               # official stable repo, stop immediately after package install
install_identity_and_unit()   # /usr/local/lib/sysusers.d and /etc/systemd/system
install_test_release()        # immutable MWP-104 current/runtime/config/dist/node_modules layout
install_test_state()          # pre-seeded 0700 directory and 0600 empty JSON object
render_test_environment()     # hostname target, MAX_SESSIONS_PER_IP=100, App Attest test IDs
render_caddy()                # localhost site, fmt, validate, keep service stopped
start_mock_mud()              # bind 6300, verify VM non-loopback address and .test host mapping
wait_for_health()             # bounded loop for expected 200 or 503
capture_resource_evidence()   # MemoryCurrent/Peak, TasksCurrent, LimitNOFILE, fd count, memory.events
verify_mount_boundary()       # nsenter as service user: release write fails, state write succeeds
measure_security()            # unthresholded score and complete output
verify_security()             # baseline host match and --threshold recorded maximum
verify_logs()                 # no EROFS/read-only/shutdown step failure/timeout/SIGKILL
prepare_reboot()              # persist evidence pointer and enable both services
verify_post_reboot()          # validate the persisted run after operator reboot
```

`require_disposable_host` requires:

```bash
[[ "${EUID}" -eq 0 ]] || fail 'must run as root'
[[ "${MWP_DISPOSABLE_VM_ACK:-}" == \
  'ERASE THIS CLEAN UBUNTU 26.04 VM' ]] ||
  fail 'set the exact disposable VM acknowledgement'
for path in \
  /opt/mud-web-proxy \
  /etc/mud-web-proxy.env \
  /var/lib/mud-web-proxy \
  /var/lib/mud-web-proxy-deploy; do
  [[ ! -e "${path}" && ! -L "${path}" ]] ||
    fail "refusing non-clean host: ${path} exists"
done
```

The acknowledgement never bypasses the path loop.

`start_mock_mud` gets the primary non-loopback IPv4 address with:

```bash
test_address="$(ip -4 route get 1.1.1.1 |
  awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
[[ -n "${test_address}" && "${test_address}" != 127.* ]] ||
  fail 'no non-loopback test address'
printf '%s %s\n' "${test_address}" "${TEST_MUD_NAME}" >>/etc/hosts
```

The cleanup trap removes only the exact `/etc/hosts` line it added. The mock
MUD binds all interfaces by its existing CLI behavior, but the host firewall
must not expose port 6300.

`render_test_environment` writes a root-owned staging file, validates it, then
installs it as `0640 root:mud-web-proxy`. It includes:

```dotenv
BIND_HOST=127.0.0.1
WS_PORT=6200
INBOUND_TLS_MODE=off
TARGET_MODE=fixed
TN_HOST=mwp-mud.test
TN_PORT=6300
MUD_TLS_MODE=plain
TRUSTED_PROXY_CIDRS=127.0.0.1
ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
APPATTEST_BUNDLE_ID=com.example.mwp-systemd-test
APPATTEST_TEAM_ID=MWPTESTTEAM
SHUTDOWN_GRACE_MS=3000
SHUTDOWN_DEADLINE_MS=15000
MAX_SESSIONS_GLOBAL=200
MAX_SESSIONS_PER_IP=100
LOG_LEVEL=INFO
```

It rejects the three forbidden native variables by name.

`install_test_state` runs only after the static identity exists:

```bash
install -d -o mud-web-proxy -g mud-web-proxy -m 0700 \
  /var/lib/mud-web-proxy
state_staging="$(mktemp /var/lib/mud-web-proxy/.attested-keys.XXXXXX)"
printf '{}\n' >"${state_staging}"
chown mud-web-proxy:mud-web-proxy "${state_staging}"
chmod 0600 "${state_staging}"
mv -Tf "${state_staging}" \
  /var/lib/mud-web-proxy/attested-keys.json
```

Then require the directory to be `700 mud-web-proxy:mud-web-proxy`, the file
to be `600 mud-web-proxy:mud-web-proxy`, and the JSON root to be an object.

Run `systemd-analyze verify` and Caddy validation before either production
service starts. Start the proxy first, require loopback health, then start
Caddy. Require Caddy's local root CA at
`/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`, copy it to
the root-only evidence directory as `caddy-local-root.crt`, and pass that copy
to both Bun clients.

The WSS spoof probe must run before the load client. After
`spoof-probe-ready`, require the proxy journal to contain the actual local
test peer and neither `198.51.100.77` nor `203.0.113.88`.

After the load client prints `sustained`, capture resources, verify the mount
boundary, and send:

```bash
systemctl kill --signal=TERM mud-web-proxy.service
```

Require `/health` to return 503 during drain, both clients to report graceful
close, and the unit to become inactive before 30 seconds. Require valid JSON
state and no `oom`, `oom_kill`, or `max` increment in `memory.events`.

Resolve the running cgroup and process paths rather than guessing them:

```bash
main_pid="$(systemctl show -p MainPID --value mud-web-proxy.service)"
control_group="$(
  systemctl show -p ControlGroup --value mud-web-proxy.service
)"
memory_events="/sys/fs/cgroup${control_group}/memory.events"
fd_count="$(find "/proc/${main_pid}/fd" -mindepth 1 -maxdepth 1 | wc -l)"
```

For the write-boundary probe, enter the service mount namespace and drop to
the static identity:

```bash
service_uid="$(id -u mud-web-proxy)"
service_gid="$(id -g mud-web-proxy)"
if nsenter --target "${main_pid}" --mount -- \
  setpriv --reuid="${service_uid}" --regid="${service_gid}" \
    --clear-groups -- \
    touch /opt/mud-web-proxy/current/write-probe; then
  fail 'service user wrote to the immutable release'
fi
nsenter --target "${main_pid}" --mount -- \
  setpriv --reuid="${service_uid}" --regid="${service_gid}" \
    --clear-groups -- \
    touch /var/lib/mud-web-proxy/write-probe
rm -f /var/lib/mud-web-proxy/write-probe
```

After the drain assertions, start the proxy again and require health and a
hostname-based WSS session. Stop and start Caddy, then stop and start the
proxy, requiring the expected inactive and healthy state after each
transition. Only then enable both services for reboot verification.

The runner has exactly two values for `MWP_ACCEPTANCE_PHASE`:

- `install` is the default. It requires the clean-host gate, performs the full
  install and runtime workload, explicitly tests stop/restart, enables both
  services, writes the evidence directory to
  `/root/mwp-105-acceptance-resume`, and exits zero with a
  `systemd-acceptance: reboot required` marker.
- `post-reboot` requires the root-only resume file and deliberately skips the
  clean-host gate because the install phase created the production-shaped
  paths. It requires both services active, loopback health 200, HTTPS health
  200 with the persisted local CA, and port 6200 bound only to
  `127.0.0.1`. It writes the final evidence-complete marker and exits zero.

Any other phase fails before mutation. The runner never reboots its own SSH
session. After a successful install phase, the operator runs
`sudo systemctl reboot`, reconnects, and invokes the post-reboot phase. This
makes both phase results observable as ordinary exit codes.

`MWP_SECURITY_MODE=measure` records the unthresholded output and a
machine-readable measurement, requires the overall summary to contain the
`OK` assessment, but does not claim the baseline gate passed. The default
`verify` mode requires the checked-in baseline, requires the same `OK`
assessment, and runs the recorded threshold. No mode derives an allowed
threshold from its current score.

- [ ] **Step 6: Format and run static verification**

Run:

```bash
chmod +x tests/deployment/run-systemd-acceptance.sh
bash -n tests/deployment/run-systemd-acceptance.sh
bunx prettier --write \
  tests/deployment/systemd-acceptance-client.ts \
  tests/deployment/systemd-load-client.ts \
  tests/deployment/systemd-contract.test.ts
bun run test:systemd
bun run typecheck
bun run lint
git diff --check
```

Expected: all commands PASS. Do not run the root acceptance script on the
development box.

- [ ] **Step 7: Commit**

```bash
git add package.json tests/deployment
git commit -m "test: add systemd host acceptance harness"
```

---

### Task 4: Turn the MWP-104 handoff into operator documentation

**Files:**

- Modify: `docs/deployment/systemd.md`
- Create: `docs/deployment/systemd-acceptance.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: exact artifact destinations, commands, modes, and test invocation
  from Tasks 1-3.
- Produces: public installation/operations instructions and the clean-VM
  evidence checklist used in Task 5.

- [ ] **Step 1: Record the documentation review checklist**

Before editing, record in the task report that the current guide still uses
the future-tense MWP-105 handoff and that
`docs/deployment/systemd-acceptance.md` is absent. The review checklist is:

- all four shipped artifact paths and their exact install commands;
- `systemd-analyze verify` and Caddy validation;
- the `DynamicUser=yes` prohibition;
- the 200-session and 1024-descriptor limits;
- the 512 MiB availability trade;
- the measured security threshold plus 0.1; and
- both acceptance modes and the exact disposable-host acknowledgement.

These are human-facing instructions, so do not add substring tests that
merely freeze prose. The task reviewer and final whole-branch reviewer verify
the checklist against the rendered documents.

- [ ] **Step 2: Update the native installation and operations guide**

In `docs/deployment/systemd.md`:

1. Replace the future-tense MWP-105 scope text with links to the four shipped
   artifact paths.
2. Add these official Caddy Ubuntu installation commands and stop the
   package-started service immediately:

   ```bash
   sudo apt install -y \
     debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
     sudo gpg --dearmor \
       -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf \
     'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' |
     sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
   sudo chmod o+r \
     /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
     /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update
   sudo apt install -y caddy
   sudo systemctl stop caddy.service
   ```

3. Install the sysusers file to `/usr/local/lib/sysusers.d`, invoke
   `systemd-sysusers mud-web-proxy.conf`, and verify the locked shell,
   persistent user, and matching group.
4. Install the unit to `/etc/systemd/system`, the environment to
   `/etc/mud-web-proxy.env`, and the rendered Caddyfile to
   `/etc/caddy/Caddyfile` with the documented ownership and modes.
5. Fail if `proxy.example.com`, `mud.example.com`, or
   `https://proxy.example.com` remains after rendering.
6. Preserve the MWP-104 two-phase link/process activation and fail-closed
   App Attest ordering.
7. Add exact `enable`, `start`, `stop`, `restart`, `status`, `journalctl`,
   health, socket, resource, and security-report commands.
8. Explain the 200-session cap, 1024-descriptor budget, provisional memory
   limits, 50-session clean-host profile, 512 MiB OOM/restart availability
   trade, and MWP-106 production measurement requirement.
9. Explain the hostname-resolution/`AF_NETLINK` decision and point to the
   recorded Ubuntu acceptance evidence.
10. State that PM2 is unsupported and must not supervise the systemd process.

Do not duplicate the full new-Droplet cutover runbook. Link its state-transfer
and rollback gates.

- [ ] **Step 3: Write the clean-host acceptance guide**

Create `docs/deployment/systemd-acceptance.md` with:

- the clean `ubuntu-26-04-x64`, one-vCPU/one-GiB prerequisite;
- the four paths that must not exist;
- the exact acknowledgement value;
- root execution and repository checkout prerequisites;
- the `MWP_ACCEPTANCE_PHASE=install` invocation;
- the operator-run reboot and `MWP_ACCEPTANCE_PHASE=post-reboot` invocation;
- `MWP_SECURITY_MODE=measure` for the first install-phase run;
- the measurement-to-baseline procedure from Task 5;
- `MWP_SECURITY_MODE=verify` for the final install-phase run;
- expected evidence files and journal markers;
- the hostname-versus-IP diagnostic branch;
- the 50-session/60-second lower-bound wording;
- the reboot/reconnect procedure;
- explicit Droplet deletion after evidence is copied; and
- a warning that production configuration and App Attest keys never enter the
  disposable test.

- [ ] **Step 4: Update the README entry point**

Replace the native systemd future tense with:

```markdown
The repository ships the hardened unit, static-user declaration, native
environment example, and reusable Caddy template under `deploy/` and
`config/`. Follow [Native systemd deployment](docs/deployment/systemd.md);
validate changes on a disposable Ubuntu 26.04 host with
[Systemd acceptance](docs/deployment/systemd-acceptance.md).
```

Keep the separate MWP-103 release-bundle and MWP-104 cutover references.

- [ ] **Step 5: Run documentation and repository checks**

Run:

```bash
bun run test:systemd
bun run check:config-docs
bunx prettier --check README.md docs/deployment \
  docs/superpowers/specs/2026-07-30-hardened-systemd-and-caddy-design.md
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/deployment \
  tests/deployment/systemd-contract.test.ts
git commit -m "docs: publish native systemd deployment guide"
```

---

### Task 5: Measure Ubuntu 26.04 behavior and pin the security baseline

**Files:**

- Create:
  `tests/deployment/systemd-security-baseline.json`
- Modify when evidence requires:
  `deploy/systemd/mud-web-proxy.service`
- Modify when evidence requires:
  `tests/deployment/systemd-contract.test.ts`
- Modify when evidence requires:
  `docs/deployment/systemd.md`
- Modify when evidence requires:
  `docs/superpowers/specs/2026-07-30-hardened-systemd-and-caddy-design.md`
- Modify: `docs/deployment/systemd-acceptance.md`

**Interfaces:**

- Consumes: one disposable Basic one-vCPU/one-GiB
  `ubuntu-26-04-x64` VM and the complete harness from Task 3.
- Produces: the measured address-family decision, resource evidence, complete
  systemd security output, and checked-in JSON regression baseline.

- [ ] **Step 1: Provision and independently verify a disposable VM**

Create a new Basic one-vCPU/one-GiB DigitalOcean Droplet from
`ubuntu-26-04-x64` through the user's normal DigitalOcean control plane. Do
not reuse the existing production Droplet. Record the Droplet ID and intended
deletion time outside the repository.

On the VM run:

```bash
source /etc/os-release
test "${ID}" = ubuntu
test "${VERSION_ID}" = 26.04
test "$(uname -m)" = x86_64
test "$(awk '/MemTotal/ {print ($2 >= 900000 && $2 <= 1200000)}' \
  /proc/meminfo)" = 1
```

Expected: every command exits zero.

- [ ] **Step 2: Run measurement mode**

Transfer or clone the branch, install the exact Bun version from
`.bun-version`, install frozen dependencies, and run:

```bash
sudo env \
  PATH="$PATH" \
  MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' \
  MWP_SECURITY_MODE=measure \
  MWP_ACCEPTANCE_PHASE=install \
  bash tests/deployment/run-systemd-acceptance.sh
```

Expected: the command runs the complete pre-reboot acceptance workload and
unthresholded security measurement, then prints the evidence directory and
`systemd-acceptance: reboot required`.

Before rebooting, run the identical install-phase command a second time.
Expected: it exits nonzero with `refusing non-clean host`, creates no new
evidence directory, leaves `/root/mwp-105-acceptance-resume` unchanged, and
does not stop or restart either enabled service. Retain this output as the
behavioral proof that even the exact acknowledgement cannot bypass the
existing-installation gate.

Run:

```bash
sudo systemctl reboot
```

Reconnect after boot, return to the same checkout, and run:

```bash
sudo env \
  PATH="$PATH" \
  MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' \
  MWP_SECURITY_MODE=measure \
  MWP_ACCEPTANCE_PHASE=post-reboot \
  bash tests/deployment/run-systemd-acceptance.sh
```

Expected: the post-reboot phase finds the root-only resume record, verifies
both enabled services and both health paths, writes the evidence-complete
marker, and exits zero. Preserve the printed evidence directory off-host
before any retry.

- [ ] **Step 3: Resolve the address-family decision from evidence**

If the hostname-based WSS-to-MUD session succeeds, leave:

```ini
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
```

If it fails:

1. retain the failing service journal and socket error;
2. rerun the identical target once with `TN_HOST` set to the already verified
   test IP solely as a diagnostic;
3. if the IP works, test a unit containing:

   ```ini
   RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
   ```

4. add `AF_NETLINK` only if that hostname run succeeds;
5. update the design, unit test, operator guide, and residual explanation;
6. discard the VM and rerun measurement from a new clean VM.

If the IP diagnostic also fails, do not add `AF_NETLINK`; use the systematic
debugging workflow because the result does not isolate hostname resolution.

- [ ] **Step 4: Evaluate the resource profile without overstating it**

Require the evidence to show:

- at least 50 concurrent ready sessions;
- at least 60 seconds of sustained traffic;
- no `oom`, `oom_kill`, or `max` event increment;
- peak descriptors below 1024;
- peak tasks below 128; and
- successful graceful close for all clients.

Record `MemoryCurrent`, `MemoryPeak`, descriptor peak, task peak, and every
`memory.events` counter in `docs/deployment/systemd-acceptance.md`.

If `high` increments or the measured peak leaves less than 20% headroom below
512 MiB, stop and revise the resource design from evidence. Do not merely
raise the cap on the one-GiB host.

- [ ] **Step 5: Create the measured security baseline**

From the retained unthresholded output, create
`tests/deployment/systemd-security-baseline.json` with the
`SecurityBaseline` interface defined in Step 6. Obtain the package and score
without transcribing them from memory:

```bash
systemd_package="$(dpkg-query -W -f='${Version}\n' systemd)"
security_report="$(
  find /root -maxdepth 2 -type f \
    -path '/root/mwp-105-evidence-*/systemd-security.txt' -print
)"
test "$(printf '%s\n' "${security_report}" | wc -l)" -eq 1
measured_exposure="$(
  sed -nE \
    's/.*Overall exposure level for mud-web-proxy.service: ([0-9]+\.[0-9]+).*/\1/p' \
    "${security_report}"
)"
test "$(printf '%s\n' "${measured_exposure}" | wc -l)" -eq 1
maximum_exposure="$(
  awk -v score="${measured_exposure}" 'BEGIN { printf "%.1f", score + 0.1 }'
)"
```

Use `apply_patch` to create the JSON with:

- literal image `ubuntu-26-04-x64`;
- literal OS version `26.04`;
- literal architecture `x86_64`;
- the captured `systemd_package`;
- numeric `measured_exposure`;
- numeric `maximum_exposure`; and
- one residual object for every failed assessment line in the retained
  report.

Each residual uses the assessment identifier printed by systemd and a
specific reason from one of these classes: required application networking,
non-applicability to the locked non-root service, or measured compatibility
deferral. Copying a generic class label without explaining the actual
assessment is not sufficient. Omit no failed assessment.

- [ ] **Step 6: Add the baseline contract test**

Append:

```typescript
interface SecurityBaseline {
  image: string;
  osVersion: string;
  architecture: string;
  systemdPackage: string;
  measuredExposure: number;
  maximumExposure: number;
  residuals: Array<{ assessment: string; reason: string }>;
}

test('pins a measured Ubuntu security regression baseline', async () => {
  const baseline = (await Bun.file(
    path.join(repoRoot, 'tests/deployment/systemd-security-baseline.json'),
  ).json()) as SecurityBaseline;
  expect(baseline.image).toBe('ubuntu-26-04-x64');
  expect(baseline.osVersion).toBe('26.04');
  expect(baseline.architecture).toBe('x86_64');
  expect(baseline.systemdPackage).toMatch(/^[0-9]/);
  expect(Number.isInteger(baseline.measuredExposure * 10)).toBe(true);
  expect(Number.isInteger(baseline.maximumExposure * 10)).toBe(true);
  expect(
    Math.round((baseline.maximumExposure - baseline.measuredExposure) * 10),
  ).toBe(1);
  expect(baseline.residuals.length).toBeGreaterThan(0);
  for (const residual of baseline.residuals) {
    expect(residual.assessment.trim()).not.toBe('');
    expect(residual.reason.trim()).not.toBe('');
  }
});
```

- [ ] **Step 7: Run verification mode from another clean VM state**

Because measurement mode mutates the first VM, create a new clean
`ubuntu-26-04-x64` VM or rebuild the first Droplet from that image. Run:

```bash
sudo env \
  PATH="$PATH" \
  MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' \
  MWP_SECURITY_MODE=verify \
  MWP_ACCEPTANCE_PHASE=install \
  bash tests/deployment/run-systemd-acceptance.sh
```

Expected:

- host and systemd package match the JSON;
- `systemd-analyze verify` passes;
- `systemd-analyze security --threshold=<maximumExposure>` passes;
- hostname-based mock-MUD traffic passes under the final address families;
- the 50-session profile passes;
- the write boundary and App Attest flush pass;
- both clients observe graceful shutdown;
- explicit stop/restart checks pass; and
- the install phase prints `systemd-acceptance: reboot required`.

Then run `sudo systemctl reboot`, reconnect, and run:

```bash
sudo env \
  PATH="$PATH" \
  MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' \
  MWP_SECURITY_MODE=verify \
  MWP_ACCEPTANCE_PHASE=post-reboot \
  bash tests/deployment/run-systemd-acceptance.sh
```

Expected: the final evidence marker exists and the command exits zero.

Copy evidence off-host and delete every disposable test Droplet. Confirm
deletion by Droplet ID; do not leave an undated billed VM with test state.

- [ ] **Step 8: Commit the evidence-bound decision**

```bash
git add tests/deployment/systemd-security-baseline.json \
  tests/deployment/systemd-contract.test.ts \
  docs/deployment/systemd-acceptance.md \
  docs/deployment/systemd.md \
  docs/superpowers/specs/2026-07-30-hardened-systemd-and-caddy-design.md \
  deploy/systemd/mud-web-proxy.service
git commit -m "test: pin Ubuntu systemd acceptance baseline"
```

Only paths changed by measured evidence appear in the commit.

---

### Task 6: Record the production-measurement handoff and verify the branch

**Files:**

- Modify: `docs/deployment/new-droplet-cutover.md`
- Modify: `docs/deployment/systemd.md`

**Interfaces:**

- Consumes: measured clean-host values from Task 5.
- Produces: an explicit MWP-106 post-routing measurement gate and a fully
  verified MWP-105 branch.

- [ ] **Step 1: Record the MWP-106 handoff review checklist**

Before editing, record in the task report that the production guides do not
yet require the 24-hour observation. Review the finished guides for all of:

```text
MemoryCurrent
MemoryPeak
TasksCurrent
LimitNOFILE
memory.events
24 hours
MAX_SESSIONS_GLOBAL=200
```

The cutover guide must state that an `oom`, `oom_kill`, or `max` event blocks
native-deployment acceptance and that a `high` event requires explicit
review. Do not add automated substring tests for this human-facing prose;
the task reviewer and final whole-branch reviewer perform the checklist.

- [ ] **Step 2: Add the production observation gate**

In `docs/deployment/new-droplet-cutover.md`, after public routing and before
old-Droplet deletion:

1. record the five requested service/cgroup values immediately after routing;
2. record them again after representative traffic and at 24 hours;
3. retain `systemctl show mud-web-proxy` and `memory.events` output;
4. abort acceptance and execute the existing fail-closed recovery on
   `oom`, `oom_kill`, or `max`;
5. require explicit review for a `high` increment;
6. compare production peaks to the Task 5 clean-host profile; and
7. update the MWP-105 resource design before changing a limit.

This observation does not keep the old Droplet forever. It runs inside the
already approved retention window and its owner/deletion date rules.

Mirror the steady-state commands and interpretation in
`docs/deployment/systemd.md`.

- [ ] **Step 3: Update MWP-106 in Linear**

Add a top-level MWP-106 comment containing the exact 24-hour measurement
gate, the five values, and the event interpretation above. Do not rely only
on a cross-reference to repository prose.

- [ ] **Step 4: Run the complete pinned-runtime verification matrix**

Use Bun 1.3.14 on `PATH`, then run:

```bash
bun --version
bun run check:bun-version
bun run format
bun run check:config-docs
bun run typecheck
bun run lint
bun run test:unit
bun run test:e2e:mock
bun run build
bash -n tests/deployment/run-systemd-acceptance.sh
git diff --check
git status --short
```

Expected:

- Bun prints `1.3.14`;
- every command exits zero;
- 1,063 existing tests plus the new deployment tests pass;
- mock E2E passes;
- the build succeeds; and
- only intentional MWP-105 files are modified.

Do not rerun the destructive VM acceptance on the development host. Task 5's
fresh VM evidence is the host verification.

- [ ] **Step 5: Commit the handoff**

```bash
git add docs/deployment/new-droplet-cutover.md \
  docs/deployment/systemd.md \
  tests/deployment/systemd-contract.test.ts
git commit -m "docs: gate production systemd resource sizing"
```

- [ ] **Step 6: Review the final diff against the specification**

Run:

```bash
git diff main...HEAD --stat
git diff main...HEAD -- \
  deploy config tests/deployment docs/deployment README.md package.json
```

Check every MWP-105 acceptance criterion against a shipped artifact, a static
test, and the retained Ubuntu evidence. Stop if any requirement relies only
on prose or any test claims more than its workload demonstrates.
