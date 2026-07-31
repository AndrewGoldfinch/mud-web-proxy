# Hardened systemd and host Caddy design

**Issue:** MWP-105

**Date:** 2026-07-30

**Status:** Approved

## Goal

Provide the canonical native process supervisor and HTTPS/WSS edge for the
new-Droplet deployment defined by MWP-104:

```text
Internet
   |
   | HTTPS/WSS on ports 443/80
   v
host Caddy
   |
   | HTTP/WebSocket on 127.0.0.1:6200
   v
hardened mud-web-proxy.service
   |
   | TCP/TLS
   v
configured MUD target
```

The proxy runs as a locked, persistent system user. It has no Linux
capabilities, cannot modify its release or host configuration, and can write
durable data only below `/var/lib/mud-web-proxy`. Caddy is the only public
listener and replaces client-supplied forwarding headers before the
application sees them.

MWP-104 owns the release, runtime, state, and new-host cutover layout.
MWP-103 owns the release artifact and installer. MWP-105 supplies the
service-account declaration, unit, native environment template, Caddy
template, installation documentation, contract tests, and clean-host
acceptance procedure. MWP-106 executes the production cutover.

## Scope

MWP-105 adds:

- a `systemd-sysusers` declaration for the static service identity;
- a hardened `mud-web-proxy.service`;
- a native `/etc/mud-web-proxy.env` template;
- a reusable host Caddy template;
- installation and operations documentation;
- source-level contract tests; and
- an Ubuntu 26.04 clean-host acceptance test.

MWP-105 does not:

- build or publish release archives;
- install or activate application releases;
- run production cutover;
- replace the MWP-104 App Attest transfer gates;
- add a container or Compose deployment path; or
- preserve PM2 as a supported supervisor.

## Supported platform

The sole native verification target remains a new DigitalOcean Droplet using
Ubuntu 26.04 LTS x64:

```text
ubuntu-26-04-x64
```

The implementation relies on systemd 259 behavior available on that release,
including `u!` sysusers entries, `Type=exec`, restart-delay steps,
`StateDirectory`, and offline security thresholds.

Ubuntu 24.04 is not part of the test matrix. The MWP-104 cutover does not run
the new unit or package installation on the old Droplet.

## Repository artifacts

The implementation uses these paths:

```text
deploy/
├── caddy/
│   └── Caddyfile.example
├── systemd/
│   └── mud-web-proxy.service
└── sysusers.d/
    └── mud-web-proxy.conf
config/
└── mud-web-proxy.env.systemd.example
docs/deployment/
├── systemd.md
└── systemd-acceptance.md
tests/deployment/
├── systemd-security-baseline.json
├── systemd-contract.test.ts
└── run-systemd-acceptance.sh
```

Names may move during implementation only if the replacement preserves the
same clear ownership boundary and every documentation and test reference is
updated in the same change.

## Static service identity

`deploy/sysusers.d/mud-web-proxy.conf` declares:

```text
u! mud-web-proxy - "MUD Web Proxy" /var/lib/mud-web-proxy /usr/sbin/nologin
```

The `u!` entry creates a system user and same-named primary group, disables
password login, and locks other login mechanisms. Automatic UID/GID
allocation is intentional. The identity is persistent on the host; it is not
a predetermined numeric ID.

The file is installed as:

```text
/usr/local/lib/sysusers.d/mud-web-proxy.conf
```

The installer runs:

```bash
systemd-sysusers mud-web-proxy.conf
```

The command is idempotent. Installation then requires:

```text
user:  mud-web-proxy
group: mud-web-proxy
shell: /usr/sbin/nologin
home:  /var/lib/mud-web-proxy
```

`DynamicUser=yes` is forbidden. The unit states `DynamicUser=no` explicitly.
A dynamic identity relocates `StateDirectory` under `/var/lib/private` and
uses a transient UID/GID. That conflicts with the pre-seeded
`mud-web-proxy:mud-web-proxy` App Attest store required by MWP-104.

Ubuntu documents that a `u` sysusers entry creates the same-named group and
that `u!` creates a fully locked account:
[Ubuntu 26.04 `sysusers.d`](https://manpages.ubuntu.com/manpages/resolute/man5/sysusers.d.5.html).

## Service process contract

The unit contains:

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

[Install]
WantedBy=multi-user.target
```

The `ExecStart` path is exact. The single MWP-104 `current` symlink selects
both the application release and its release-local `runtime` link.

`Type=exec` is used instead of `Type=simple`. systemd does not report the
unit started until user setup and `execve` succeed, so a missing user,
runtime, or bundle is a start failure rather than a false successful start.
Ubuntu recommends `Type=exec` for long-running services where this error
reporting matters:
[Ubuntu 26.04 `systemd.service`](https://manpages.ubuntu.com/manpages/resolute/man5/systemd.service.5.html).

There is no custom `ExecStop`. systemd sends SIGTERM to the main Bun process,
and the application's MWP-96 shutdown runner owns readiness withdrawal,
session drain, listener close, state flush, and exit.

Application stdout and stderr go to journald. The service does not create a
file log.

## Shutdown and restart

The native environment fixes the initial shutdown pair:

```text
SHUTDOWN_GRACE_MS=3000
SHUTDOWN_DEADLINE_MS=15000
```

The unit sets:

```ini
Restart=on-failure
RestartSec=5s
RestartSteps=4
RestartMaxDelaySec=60s
TimeoutStopSec=30s
```

The contract is:

```text
0 < SHUTDOWN_GRACE_MS
SHUTDOWN_GRACE_MS < SHUTDOWN_DEADLINE_MS
SHUTDOWN_DEADLINE_MS < TimeoutStopSec
```

The environment and unit use different time units, so the contract test
parses both values rather than comparing source strings.

The 30-second systemd timeout gives the application its complete 15-second
deadline and reserves another 15 seconds for scheduler delay and service
manager cleanup. A future environment change may not raise the application
deadline to 30 seconds or more without changing and re-verifying the unit.

`Restart=on-failure` recovers from crashes and resource-limit termination but
does not undo an intentional operator stop. The restart delay starts at five
seconds and is bounded at 60 seconds so a persistent configuration failure
does not become a tight restart loop.

Acceptance must show that SIGTERM with a real WebSocket/MUD session:

1. makes `/health` unready;
2. closes the client with code 1001 and the restart reason;
3. flushes App Attest state when configured;
4. logs `shutdown: completed`;
5. exits before `TimeoutStopSec`; and
6. is not recorded as a timeout or SIGKILL.

## State and filesystem boundary

The unit sets:

```ini
UMask=0077
StateDirectory=mud-web-proxy
StateDirectoryMode=0700
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/mud-web-proxy
PrivateTmp=true
```

`StateDirectory` creates `/var/lib/mud-web-proxy` as the static service
identity. `ReadWritePaths` makes the intended exception to
`ProtectSystem=strict` explicit even though `StateDirectory` already creates
a writable exception.

The directory, not merely `attested-keys.json`, is writable. App Attest
atomically stages a sibling temporary file and renames it over the live
store.

The durable write boundary is:

```text
/var/lib/mud-web-proxy/**
```

The application cannot modify:

- `/opt/mud-web-proxy/releases/**`;
- `/opt/mud-web-proxy/runtimes/**`;
- `/opt/mud-web-proxy/current`;
- `/etc/mud-web-proxy.env`;
- `/etc/mud-web-proxy/**`; or
- Caddy configuration and certificate state.

`PrivateTmp=true` provides writable, service-private `/tmp` and `/var/tmp`.
Those paths are ephemeral and invisible to other host services. Therefore
the precise claim is that the state directory is the application's only
persistent host-writable path, not that every path in its mount namespace is
read-only.

The App Attest state file remains:

```text
/var/lib/mud-web-proxy/attested-keys.json
owner: mud-web-proxy:mud-web-proxy
mode:  0600
```

The installer verifies the directory and file independently before first
start. systemd may enforce directory ownership and mode; it does not
guarantee correction of the pre-seeded file.

## Privilege and kernel hardening

The unit applies:

```ini
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
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
```

The service needs no capability. Port 6200 is unprivileged, state is
pre-owned, releases are root-owned, and Caddy owns ports 80 and 443.

Allowed address families cover:

- `AF_INET` and `AF_INET6` for Caddy, MUD, DNS-resolved network targets, and
  APNs traffic; and
- `AF_UNIX` for runtime and host-local facilities.

`AF_NETLINK` is not granted speculatively. On glibc systems,
`getaddrinfo` may open a netlink route socket while sorting resolved
addresses. Whether Bun's production `net.connect` and TLS paths require that
socket under Ubuntu 26.04 must be decided by the hostname-based clean-host
test below. If the restricted service cannot connect through a hostname but
the same target works by IP, the unit adds `AF_NETLINK`; the design and
security-baseline explanation then record that measured requirement.

The clean-host acceptance test is authoritative for compatibility with Bun,
JavaScriptCore, `ws`, `cbor-x`, DNS, TLS, and App Attest file persistence.
If a directive proves incompatible, the implementation must return to design
review with the observed failure. It must not silently loosen the shipped
unit.

### Deliberate residual exposure

The unit does not set:

- `PrivateNetwork=true`, because the application must accept Caddy traffic
  and open outbound MUD and APNs connections;
- `IPAddressDeny=any`, because the required outbound destinations are not a
  static systemd allowlist;
- `MemoryDenyWriteExecute=true`, because Bun's JavaScriptCore runtime uses
  executable memory; or
- a speculative `SystemCallFilter` allowlist, because Bun, JavaScriptCore,
  TLS, and optional native dependency paths have not yet been traced under
  the full workload.

These omissions are documented beside the captured
`systemd-analyze security` report. They are not treated as unexplained
failures or patched over with inaccurate claims.

## Resource limits for the supported Droplet

The initial production host is a Basic DigitalOcean Droplet with one vCPU
and 1 GiB RAM. The unit sets:

```ini
MemoryHigh=384M
MemoryMax=512M
TasksMax=128
LimitNOFILE=1024
```

`MemoryHigh` is the primary pressure boundary. `MemoryMax` is the final
containment limit and may terminate the service when memory cannot be
reclaimed. `TasksMax` counts processes and threads, not only Bun processes.
Ubuntu recommends using `MemoryHigh` as the main control and `MemoryMax` as
the last defense:
[Ubuntu 26.04 `systemd.resource-control`](https://manpages.ubuntu.com/manpages/resolute/man5/systemd.resource-control.5.html).

These limits leave capacity for the kernel, Caddy, journald, SSH, and package
operations. Release installation and dependency installation do not run
inside the service cgroup.

The hard memory limit is an explicit availability trade. If the proxy reaches
512 MiB, systemd may OOM-kill and restart it, disconnecting every active
session. Preventing one process from starving Caddy and the 1 GiB host takes
priority over preserving those sessions. The limit is not described as
cost-free containment.

The native environment also sets:

```text
MAX_SESSIONS_GLOBAL=200
```

That makes the application reject excess sessions through its normal
capacity path before the process reaches an implicit descriptor ceiling.
`LimitNOFILE=1024` is stated explicitly rather than inheriting a host default.
The budget allows four descriptors per admitted session (800 total) and
reserves 224 for listeners, DNS/TLS work, APNs, journald, and transient
accepts. A normal session is expected to retain two descriptors: the client
WebSocket and its MUD socket. The factor of two is headroom, not a claim that
every session always uses four.

The acceptance workload records:

- idle `MemoryCurrent`;
- peak `MemoryCurrent`;
- `MemoryPeak`;
- current task count; and
- file-descriptor count;
- `memory.events`; and
- whether either memory boundary was crossed.

The clean-host profile sustains at least 50 concurrent
WebSocket-to-mock-MUD sessions with periodic bidirectional traffic for at
least 60 seconds. A passing idle start or one-session test does not validate
the caps. The profile is a repeatable lower bound, not a claim that it proves
the 200-session production ceiling.

The values remain provisional until MWP-106 records the first production
`MemoryCurrent`, `MemoryPeak`, task count, descriptor count, and
`memory.events` under representative traffic. That production measurement is
the real sizing gate. An `oom`, `oom_kill`, or `max` event blocks acceptance;
a `high` event requires review and either a justified retained limit or a
measured change. Any limit change updates this design and its recorded
evidence.

## Native environment contract

`config/mud-web-proxy.env.systemd.example` begins with:

```text
BIND_HOST=127.0.0.1
WS_PORT=6200
INBOUND_TLS_MODE=off
TARGET_MODE=fixed
TRUSTED_PROXY_CIDRS=127.0.0.1
ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
SHUTDOWN_GRACE_MS=3000
SHUTDOWN_DEADLINE_MS=15000
MAX_SESSIONS_GLOBAL=200
```

Production must additionally set the fixed MUD target, origin/authentication
policy, and any enabled App Attest or APNs values described in
`docs/configuration.md`.

The following variables must be absent:

```text
ALLOW_INSECURE_INBOUND_NO_TLS
TLS_CERT_PATH
TLS_KEY_PATH
```

Loopback plaintext does not require
`ALLOW_INSECURE_INBOUND_NO_TLS=true`. Omitting it preserves the startup
guard against a later accidental non-loopback plaintext bind. Caddy owns the
inbound certificate and private key.

`TRUSTED_PROXY_CIDRS=127.0.0.1` is narrow by construction. The application
honors forwarding headers only from the host Caddy connection. It does not
use the legacy trust-everything boolean.

The installed file remains:

```text
/etc/mud-web-proxy.env
owner: root:mud-web-proxy
mode:  0640
```

The example contains no production secret or production hostname.

## Host Caddy contract

The repository carries a reusable template, not the production hostname:

```caddyfile
proxy.example.com {
	reverse_proxy 127.0.0.1:6200 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Real-IP {remote_host}
	}
}
```

The installer copies the template to a root-only staging file, replaces
`proxy.example.com` with the actual hostname, and fails if the placeholder
remains. It then installs the rendered file as `/etc/caddy/Caddyfile`.

The site address activates Caddy's automatic HTTPS. Caddy handles WebSocket
upgrades through `reverse_proxy`; no WebSocket-specific path or transport
configuration is required.

Both client-IP headers are assigned with `header_up` and no `+` prefix.
Therefore Caddy overwrites, rather than appends to, any client-supplied
`X-Forwarded-For` or `X-Real-IP`. The second assignment is essential:
Caddy's defaults protect `X-Forwarded-*`, but do not create or sanitize
`X-Real-IP` unless configured. The application prefers `X-Real-IP`, so
passing an incoming value through would defeat the trusted-proxy boundary.

Caddy documents that ordinary `header_up` assignment overwrites an existing
request header and that its proxy handles the standard forwarded headers:
[Caddy `reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Caddy is installed from the official stable Ubuntu repository. The package
provides and starts the `caddy` systemd service automatically:
[Caddy installation](https://caddyserver.com/docs/install).

Because package installation starts Caddy before the production template is
rendered, provisioning must:

1. install the official package;
2. stop `caddy.service`;
3. render `/etc/caddy/Caddyfile`;
4. run `caddy fmt --overwrite /etc/caddy/Caddyfile`;
5. run `caddy validate --config /etc/caddy/Caddyfile`;
6. keep Caddy stopped until the loopback proxy is healthy; and
7. enable and start Caddy only at the MWP-104 final-state gate.

The vendor unit is not replaced. Caddy logs remain under the official
service's journald and package-managed state model. The application unit does
not receive access to `/var/lib/caddy`.

Only Caddy listens publicly. The host firewall exposes SSH plus TCP ports 80
and 443. Port 6200 is never added to the firewall.

## Installation ordering

The new-host pre-stage order is:

1. Install Caddy from its official stable Ubuntu repository, then stop it.
2. Install the sysusers declaration.
3. Run `systemd-sysusers mud-web-proxy.conf`.
4. Verify the locked static user and group.
5. Install the environment template as `/etc/mud-web-proxy.env`, then supply
   production values with owner `root:mud-web-proxy` and mode `0640`.
6. Install the systemd unit as
   `/etc/systemd/system/mud-web-proxy.service`.
7. Run `systemctl daemon-reload`.
8. Run `systemd-analyze verify` before enabling the unit.
9. Render, format, and validate the Caddyfile.
10. Install and link the verified MWP-103 release without starting it.
11. Create or verify `/var/lib/mud-web-proxy` and install the final validated
    App Attest store under the MWP-104 aggregate transfer gate.
12. Keep both services inactive until the final-state gate.

Installing the service files does not start either service. This preserves
MWP-104's single-active-production-instance invariant.

At final activation:

1. prove the old proxy is stopped and the final App Attest store is valid;
2. start `mud-web-proxy.service`;
3. require loopback `/health` to become ready;
4. require the post-start key count floor;
5. start `caddy.service`;
6. require the public HTTPS/WSS checks; and
7. only then route production traffic.

Any failure follows MWP-104's fail-closed branch and proves both new services
inactive before the old host is restored.

## Verification design

Verification has two layers. Source-level tests are fast and deterministic;
the clean-host run proves the behavior that text inspection cannot.

### Source-level contract tests

`tests/deployment/systemd-contract.test.ts` reads the shipped artifacts and
requires:

- the exact `ExecStart`;
- `Type=exec`;
- the static user and group;
- `DynamicUser=no`;
- the exact environment file and working directory;
- `StateDirectory`, its `0700` mode, and `UMask=0077`;
- `ProtectSystem=strict`, `ProtectHome=true`, and the state write exception;
- an empty capability bounding set and empty ambient capability set;
- required privilege, device, kernel, process, namespace, and address-family
  restrictions;
- `Restart=on-failure` and bounded restart delay;
- the parsed 3-second/15-second/30-second shutdown inequality;
- `MemoryHigh=384M`, `MemoryMax=512M`, `TasksMax=128`, and
  `LimitNOFILE=1024`;
- `MAX_SESSIONS_GLOBAL=200`;
- no `DynamicUser=yes`;
- no non-loopback application bind;
- no insecure plaintext acknowledgement or application TLS-key variables;
- `TRUSTED_PROXY_CIDRS=127.0.0.1`;
- a Caddy upstream of exactly `127.0.0.1:6200`;
- overwrite assignments for both client-IP headers;
- no append form for either client-IP header; and
- a reusable example hostname rather than a repository production hostname.

The tests assert security contracts, not every line or formatting choice.
They must not become an exact snapshot of the unit or Caddyfile.

The documentation checker also requires every shipped environment variable
to be described in `docs/configuration.md`.

### Ubuntu 26.04 clean-host acceptance

The authoritative host test runs as root on a clean Ubuntu 26.04 LTS x64 VM.
It may be a disposable DigitalOcean Droplet. It receives a test release, not
production configuration or production App Attest keys.

The script requires an explicit disposable-host acknowledgement and refuses
to run when any of these production-shaped paths already exist:

```text
/opt/mud-web-proxy
/etc/mud-web-proxy.env
/var/lib/mud-web-proxy
/var/lib/mud-web-proxy-deploy
```

The acknowledgement alone cannot override an existing-path failure. An
operator must inspect and remove an unintended target manually; the script
never deletes or reuses it.

The test:

1. proves the host release and architecture;
2. installs the official Caddy package and repository artifacts;
3. creates the static account through `systemd-sysusers`;
4. creates a root-owned immutable test release with the versioned Bun
   runtime layout from MWP-104;
5. runs the repository mock MUD as a separate test process on the VM's
   non-loopback test address;
6. assigns that address a reserved `.test` hostname and renders `TN_HOST` to
   the hostname, never its IP literal;
7. enables App Attest with test identifiers and a test `{}` key store so the
   atomic state path is exercised;
8. renders the Caddy template to `localhost`;
9. validates the unit and Caddy configuration before start;
10. starts the proxy and requires `http://127.0.0.1:6200/health`;
11. proves `ss` shows port 6200 only on loopback;
12. proves HTTPS through Caddy while explicitly trusting Caddy's local test
    CA, without disabling TLS verification;
13. opens WSS through Caddy, establishes a real mock-MUD session through the
    hostname target, and exchanges data in both directions, proving the
    service's restricted `net.connect` hostname-resolution path;
14. sends spoofed `X-Forwarded-For` and `X-Real-IP` values and proves the
    accepted connection log contains the actual test peer, not either
    spoofed value;
15. sustains at least 50 simultaneous WSS-to-mock-MUD sessions with periodic
    bidirectional traffic for at least 60 seconds;
16. records memory, task, descriptor, and `memory.events` metrics during that
    profile;
17. enters the service mount namespace as the service user and proves a write
    below the active release fails while a state-directory write succeeds;
18. sends SIGTERM with sessions active and proves the graceful shutdown
    contract;
19. proves the App Attest store is valid JSON and was flushed without
    `EROFS`, `read-only file system`, or `shutdown: ... failed:` logs;
20. starts the service again and repeats loopback health and hostname-based
    WSS checks;
21. explicitly stops and restarts each of `mud-web-proxy.service` and
    `caddy.service`, requiring the expected inactive and healthy states after
    each operation;
22. reboots the VM and proves both enabled services return healthy; and
23. captures service status, journal excerpts, security analysis, socket
    state, memory peak, and task peak as review evidence.

The test does not mount repository source or tests into the installed
release. Test helpers run outside the service filesystem boundary.

### Security score

The first Ubuntu 26.04 run measures the loaded unit without a guessed
threshold:

```bash
systemd-analyze verify /etc/systemd/system/mud-web-proxy.service
systemd-analyze security --no-pager mud-web-proxy.service
```

The implementation records the exact Ubuntu image, systemd package version,
measured exposure score, and every residual assessment in
`tests/deployment/systemd-security-baseline.json`. The committed maximum is
exactly 0.1 above the measured score. For example, a measured `2.3` produces
a maximum of `2.4`; this example is arithmetic, not the expected score.

After that baseline is committed, the authoritative rerun reads the maximum
from the JSON and executes:

```text
systemd-analyze security --threshold=<recorded maximum> --no-pager mud-web-proxy.service
```

The command must exit zero and its complete output is retained. The contract
test requires both JSON values to be one-decimal numbers and requires:

```text
maximumExposure == measuredExposure + 0.1
```

The acceptance script refuses a missing baseline, a host release or systemd
version that differs from the recorded baseline, or a current score above
the recorded maximum. It never derives the threshold from the current run;
doing that would create a gate that cannot detect regression.

The measured score must be in systemd's `OK` assessment band or better. A
threshold is a regression gate, not proof that the service is secure.
`systemd-analyze` measures only systemd-provided controls and describes lower
scores as lower exposure:
[Ubuntu 26.04 `systemd-analyze`](https://manpages.ubuntu.com/manpages/resolute/man1/systemd-analyze.1.html).

Every remaining failed assessment is classified as:

- required for application behavior;
- not applicable to the static non-root service;
- deferred pending measured runtime compatibility; or
- an implementation defect that blocks acceptance.

Unexplained residuals block completion.

## Error handling

Provisioning fails before service start when:

- the sysusers declaration cannot create or resolve the expected identity;
- the acceptance host contains an existing production-shaped path;
- the account has a login-capable shell;
- the environment has the wrong ownership or mode;
- a forbidden native variable is present;
- shutdown timings violate their inequality;
- the release, runtime, CA, or external dependencies are missing;
- App Attest state ownership, mode, or JSON validation fails;
- the Caddy placeholder remains;
- Caddy formatting or validation fails;
- `systemd-analyze verify` reports a unit error; or
- the security baseline is absent or does not match the host;
- the measured security result is not `OK` or better; or
- the security exposure exceeds the measured baseline plus 0.1.

Runtime acceptance fails when:

- the proxy binds a non-loopback address;
- Caddy or the proxy is unhealthy;
- WSS cannot exchange data with the mock MUD;
- a spoofed client-IP header survives;
- a release/configuration write succeeds;
- a state-directory write or atomic state flush fails;
- the 50-session profile records an `oom`, `oom_kill`, or `max` memory event;
- shutdown reaches SIGKILL or omits `shutdown: completed`; or
- either service fails to return after reboot.

The acceptance script uses an exit trap that stops both test services and the
mock MUD. It never deletes production paths or operates on a non-disposable
host.

## Documentation changes

`docs/deployment/systemd.md` becomes the installation and operator guide for
the shipped artifacts rather than a future-tense MWP-104 handoff. It keeps
the release and cutover constraints already approved.

The guide explains:

- official Caddy package installation and its automatic initial start;
- static-user creation;
- exact artifact destinations and modes;
- environment rendering;
- why `DynamicUser=yes` is forbidden;
- why the application TLS and insecure-ack variables are absent;
- unit and Caddy validation;
- start, stop, restart, reload, logs, health, and status commands;
- resource and shutdown limits;
- how to capture the security report;
- how to upgrade without changing the unit;
- how MWP-104 failure recovery stops both new services; and
- that PM2 is not part of the supported native deployment.

`docs/deployment/systemd-acceptance.md` records the clean VM prerequisites,
exact invocation, required evidence, and cleanup. It separates disposable
test credentials from production cutover instructions.

## Acceptance criteria

MWP-105 is complete when:

1. The shipped sysusers file creates a locked persistent
   `mud-web-proxy:mud-web-proxy` identity.
2. The unit uses the exact MWP-104 `ExecStart`, static identity, environment,
   working directory, and state directory.
3. `DynamicUser=no` is explicit and no supported documentation recommends
   `DynamicUser=yes`.
4. The proxy's only persistent writable host path is
   `/var/lib/mud-web-proxy`.
5. The unit carries no Linux capability and applies the approved sandbox.
6. The 1 GiB provisional resource limits survive the 50-session clean-host
   profile, and MWP-106 owns the representative production measurement gate.
7. Shutdown drains the real session and exits before 30 seconds without
   SIGKILL.
8. The proxy listens only on `127.0.0.1:6200`.
9. Caddy is the only public listener and provides HTTPS/WSS.
10. Caddy overwrites both accepted client-IP headers.
11. App Attest state survives stop, restart, and reboot with its required
    owner, mode, and JSON shape.
12. `systemd-analyze verify` passes.
13. The measured systemd security score is `OK` or better, the checked-in
    threshold is exactly 0.1 above it, the threshold rerun passes, and every
    residual is explained.
14. Both services stop and restart cleanly, and both enabled services return
    healthy after reboot.
15. Contract tests, repository quality gates, and the Ubuntu 26.04
    clean-host acceptance run pass.

## Rejected alternatives

### Dynamic system user

Rejected because MWP-104 transfers a pre-owned App Attest store before first
start. `DynamicUser=yes` changes the state path and identity model underneath
that mandatory transfer.

### PM2

Rejected because it adds a second supervisor and log/restart policy on a host
already managed by systemd. The supported native path has one process manager
with one shutdown timeout and one restart policy.

### Application-managed inbound TLS

Rejected because host Caddy owns certificates, automatic HTTPS, and WSS.
Giving the Bun process TLS private keys would widen its read boundary and
duplicate renewal logic.

### Public application listener

Rejected because only Caddy needs public ingress. Keeping the application on
loopback makes plaintext transport local and prevents direct bypass of
Caddy's client-IP sanitization.

### Environment-expanded public hostname

Rejected for the initial template. Caddyfile environment substitution would
require a service drop-in or an additional Caddy environment file. A literal
`proxy.example.com` replacement gate is simpler, visible, and keeps the
official Caddy unit unmodified.

### One-gigabyte application memory limit

Rejected on a one-gigabyte Droplet because it provides no meaningful
containment and could starve the operating system and Caddy. The 512 MiB hard
limit reserves host capacity.

### Maximum score-driven hardening

Rejected because `MemoryDenyWriteExecute`, network isolation, or an unmeasured
syscall allowlist would prevent required Bun or proxy behavior. The selected
unit applies strong controls whose compatibility is verified and documents
the small number of deliberate residuals.
