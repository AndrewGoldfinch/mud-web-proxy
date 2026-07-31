# Systemd Release, State, and Cutover Design

**Issue:** MWP-104

**Date:** 2026-07-30

**Status:** Approved

## Goal

Define the native production layout and migration model for
`mud-web-proxy`: immutable verified releases, versioned Bun runtimes, a
single atomic `current` symlink, systemd-managed durable state, and a
new-Droplet cutover with an offline rollback target.

MWP-104 defines the contract. MWP-105 will implement the hardened systemd
unit and host Caddy configuration, MWP-103 will publish the native release
bundle, and MWP-106 will execute the production cutover and remove PM2 from
the supported deployment matrix.

This design does not define an in-place conversion of the existing Droplet.
Maintaining both an in-place procedure and a cutover procedure would create
two migration models, while only one would be exercised.

## Platform baseline

The canonical native host is a new DigitalOcean Droplet created from the
Ubuntu 26.04 LTS x64 image:

```text
ubuntu-26-04-x64
```

Ubuntu released 26.04 LTS on 2026-04-23 and supports it through April 2031.
DigitalOcean made the `ubuntu-26-04-x64` image available through its control
panel and API on 2026-07-01. See the
[Ubuntu 26.04 release notes](https://documentation.ubuntu.com/release-notes/26.04/)
and the [DigitalOcean Droplets updates](https://docs.digitalocean.com/products/droplets/#latest-updates).

Ubuntu 24.04 is not a verification target. The existing Droplet's release is
irrelevant under the cutover model: no new release layout, Bun runtime,
systemd unit, package installation, or migration transform runs there. The
cutover reads configuration and state from the old host, stops its existing
service, and leaves that host intact as a short-lived rollback target.

The old host's operating system would matter for an in-place conversion, but
that is explicitly not the selected strategy.

## Filesystem layout

The native installation uses this layout:

```text
/opt/mud-web-proxy/
├── current -> releases/<version>
├── releases/
│   ├── <active-version>/
│   │   ├── .bun-version
│   │   ├── VERSION
│   │   ├── config/
│   │   │   └── apple-app-attest-root-ca.pem
│   │   ├── dist/
│   │   │   └── wsproxy.js
│   │   ├── node_modules/
│   │   ├── package.json
│   │   ├── bun.lock
│   │   └── runtime -> ../../runtimes/bun/<bun-version>
│   └── <previous-version>/
└── runtimes/
    └── bun/
        └── <bun-version>/
            └── bin/
                └── bun
/etc/mud-web-proxy.env
/etc/mud-web-proxy/
└── apns-auth-key.p8              # only when APNS is enabled
/var/lib/mud-web-proxy/
└── attested-keys.json            # only when App Attest is enabled
/var/lib/mud-web-proxy-deploy/
└── previous-release              # root-only persistent rollback target
```

### Ownership and modes

| Path                             | Owner                         | Mode                              | Contract                                                        |
| -------------------------------- | ----------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `/opt/mud-web-proxy`             | `root:root`                   | `0755`                            | Service user can traverse but not modify.                       |
| `releases/`                      | `root:root`                   | `0755`                            | Contains immutable verified releases.                           |
| `releases/<version>/`            | `root:root`                   | `0755`                            | No file is modified after activation.                           |
| Release files                    | `root:root`                   | `0644` unless executable          | Bundle and installed dependencies are read-only to the service. |
| `current`                        | `root:root`                   | symlink                           | Replaced atomically; never edited in place.                     |
| `runtimes/bun/<version>/`        | `root:root`                   | directories `0755`, binary `0755` | Versioned and immutable.                                        |
| `/etc/mud-web-proxy.env`         | `root:mud-web-proxy`          | `0640`                            | Contains configuration and secrets; not world-readable.         |
| `/etc/mud-web-proxy/`            | `root:mud-web-proxy`          | `0750`                            | Holds read-only secret files referenced by the environment.     |
| APNS private key                 | `root:mud-web-proxy`          | `0640`                            | Present only when APNS is enabled.                              |
| `/var/lib/mud-web-proxy/`        | `mud-web-proxy:mud-web-proxy` | `0700`                            | Created by systemd `StateDirectory`.                            |
| `attested-keys.json`             | `mud-web-proxy:mud-web-proxy` | `0600`                            | Durable App Attest registrations and counters.                  |
| `/var/lib/mud-web-proxy-deploy/` | `root:root`                   | `0700`                            | Root-only deployment metadata outside service-writable state.   |
| `previous-release`               | `root:root`                   | `0600`                            | Persistent rollback target written before activation.           |

### MWP-105 systemd handoff

MWP-105 must use `StateDirectory=mud-web-proxy`,
`StateDirectoryMode=0700`, `UMask=0077`, and the static
`mud-web-proxy:mud-web-proxy` account. It must set `DynamicUser=no` or omit
the directive, whose default is false.

`DynamicUser=yes` is forbidden. With a dynamic user, systemd relocates
`StateDirectory` under `/var/lib/private`, presents `/var/lib/mud-web-proxy`
through a symlink, and assigns a transient UID/GID. That conflicts with the
pre-seeded `mud-web-proxy:mud-web-proxy` file and can make the mandatory App
Attest store inaccessible at first start. The ownership, mode-correction, and
dynamic-user behavior are defined in
[Ubuntu 26.04's `systemd.exec`](https://manpages.ubuntu.com/manpages/resolute/man5/systemd.exec.5.html#runtime-directory-state-directory-cache-directory-logs-directory-configuration-directory).

systemd creates the state directory when absent, sets the innermost
directory's owner and `StateDirectoryMode`, and recursively changes ownership
only if that directory initially has the wrong owner or group. If the
directory already has the configured owner and group, child ownership is left
unchanged as an optimization. The configured mode applies to the innermost
directory, not to the pre-seeded JSON file. systemd therefore does not
reliably infer or repair that file's `mud-web-proxy:mud-web-proxy` owner or
`0600` mode. The installer must verify both the directory and file before
first start.

The state directory, rather than the JSON file alone, must be writable
because App Attest stages an atomic write with `mkdtemp`, writes a sibling
file, and renames it over the live store.

The service must not write to the active release directory. The App Attest
state directory is its only persistent writable path.

### Release immutability

A release becomes immutable only after:

1. its archive, checksum, and provenance are verified;
2. it is extracted into a new version-named directory;
3. frozen production dependencies are installed;
4. its required versioned Bun runtime is present and verified;
5. its `runtime` symlink is created; and
6. its files, ownership, and modes pass validation.

The release is never built on the production host. `dist/wsproxy.js` comes
from the verified MWP-103 artifact. `bun install --frozen-lockfile
--production` installs the external production dependencies required by the
bundle. That command may also populate Bun's global download cache outside
the release tree. The cache is disposable installer state: it is not part of
the immutable release, is not backed up, and is never required for rollback.

Installation and activation are separate. A failed installation leaves
`current` unchanged.

## Bun runtime contract

The initial native deployment uses exactly Bun `1.3.14`, matching the
repository's `.bun-version` and `package.json#engines.bun`.

Bun is not installed through Ubuntu packages, a mutable user-home
installation, or an unversioned `/usr/local/bin/bun`. Provisioning downloads
the exact official Bun release asset, verifies its published checksum, and
installs it under:

```text
/opt/mud-web-proxy/runtimes/bun/1.3.14/
```

The official installer supports selecting an exact release, but the
production procedure uses the direct release asset so its destination,
checksum verification, ownership, and coexistence with later runtimes are
explicit. See [Bun installation](https://bun.sh/docs/installation).

Each MWP-103 release bundle must carry `.bun-version`. Before installing
dependencies, the installer requires:

```text
.bun-version == package.json#engines.bun
runtime/bin/bun --version == .bun-version
```

The release-local `runtime` symlink points to the matching versioned host
runtime. MWP-105 therefore starts:

```text
/opt/mud-web-proxy/current/runtime/bin/bun /opt/mud-web-proxy/current/dist/wsproxy.js
```

The single `current` swap selects the application and its required Bun
runtime together. No second global-runtime symlink is switched.

Future Bun upgrades install a new runtime beside the old one. A runtime may
not be removed while any retained release refers to it. The active release
and every rollback release must have its dependencies and Bun runtime
already present, so rollback requires no network access.

## Native environment contract

Host Caddy terminates HTTPS/WSS and proxies to the application over
loopback. `/etc/mud-web-proxy.env` must explicitly contain:

```text
BIND_HOST=127.0.0.1
WS_PORT=6200
INBOUND_TLS_MODE=off
TARGET_MODE=fixed
ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
```

`ALLOW_INSECURE_INBOUND_NO_TLS` must be absent. The runtime guard requires
that acknowledgement only for a non-loopback plaintext listener. Copying
the Compose value `ALLOW_INSECURE_INBOUND_NO_TLS=true` into the native
environment would erase a useful signal and make a later accidental
non-loopback bind easier to overlook.

`TLS_CERT_PATH` and `TLS_KEY_PATH` are also absent. Caddy owns inbound TLS
and its certificate state; the application neither reads nor stores the
private certificate.

Production-specific target, authentication, origin, trusted-proxy, App
Attest, APNS, resource-limit, and shutdown values are carried in the same
environment file. If APNS is enabled, `APNS_KEY_PATH` points into
`/etc/mud-web-proxy/`, never into a release directory.

The old configuration is an input, not a file to copy blindly. Build the new
environment against the current configuration reference, preserve required
production values and secrets, reject retired variables, and apply the
loopback/TLS rules above. This transformation runs on the new host or an
administrative workstation, never as an upgrade of the old host.

## Durable, backup-required, and disposable data

### Backup required

The following data must be backed up independently of a Droplet image:

- `/etc/mud-web-proxy.env`;
- any secret file referenced by it, currently the APNS signing key when APNS
  is enabled;
- `/var/lib/mud-web-proxy/attested-keys.json` when App Attest is enabled; and
- `/var/lib/mud-web-proxy-deploy/previous-release`.

Backups of configuration and state are encrypted, stored off-Droplet, and
restored only with their original restrictive ownership and modes. Take a
backup before every upgrade and at least daily. Test a restore on a
non-production host.

DigitalOcean automated Droplet backups remain enabled as a machine-level
recovery layer, but they do not replace file-level configuration and state
backups. DigitalOcean documents daily and weekly automated images and their
retention in its [backup guidance](https://docs.digitalocean.com/support/how-do-i-manually-back-up-my-droplet/).

### Retained for offline rollback

Retain the active release, the release named by the non-empty root-only
rollback record, and the two most recent verified previous releases. Retain
every Bun runtime referenced by those releases. A failed release does not
count as a verified rollback target.

Installed production dependencies are reproducible from `bun.lock`, but each
retained release keeps its existing `node_modules` because rebuilding it
would violate the no-network rollback requirement.

### Disposable or deliberately not preserved

The following data is not transferred to the new Droplet and is not restored
as application state:

- the old Git checkout, `.git`, source, tests, and build output;
- the old `node_modules`;
- PM2 state, process dumps, and `ecosystem.config.cjs`;
- the old Bun installation;
- Bun's global package-download cache;
- repository-root `cert.pem` and `privkey.pem`;
- Certbot or other old-host ACME state;
- runtime logs;
- `chat.json`, which the current application does not read or write;
- in-memory WebSocket, Telnet, and resumable-session state;
- App Attest challenge nonces; and
- cached APNS tokens and live-activity scheduling state.

Caddy obtains new certificates on the new host. Copying old certificate
private keys would reintroduce the private-material exposure that the
artifact and image boundaries intentionally removed.

## App Attest migration is mandatory

App Attest is enabled in the current production deployment. A production
`/attest/challenge` probe returned HTTP 200 on 2026-07-30; the route exists
only when both App Attest identifiers are configured.

The old host's resolved `ATTESTED_KEYS_PATH` is therefore a mandatory
transfer item. It is not acceptable to start the new host with an empty store
or to treat a missing file as a warning.

iOS clients retain their `keyId` in Keychain and skip registration on later
launches. If the server loses the corresponding entry, those clients do not
register again automatically; they fail with `Unknown key`. Losing the file
would therefore reject every established device without an automatic
client-side recovery path.

The current production release predates both MWP-95's atomic save and
MWP-96's explicit shutdown flush. Its save truncates and rewrites the live
file directly. The cutover therefore takes two copies:

1. During pre-stage, copy the live file to encrypted administrative staging.
   Require valid JSON, record its SHA-256 and key count, and retry the copy if
   it intersects a write. This is the recoverable safety copy and its key
   count is the floor for the final store.
2. During the window, block new public requests to the old application, wait
   at least five seconds—longer than the existing two-second debounced
   save—and then stop the old proxy. Once the process has exited, validate
   the on-disk store before treating it as the final source.

The pre-stop and final records each contain:

```text
source path
SHA-256
JSON object key count
file owner and mode
```

If the post-stop store does not parse as a JSON object or contains fewer keys
than the pre-stop floor, do not copy it to the new host. Restore the validated
pre-stop copy through a same-directory mode-`0600` unique temporary file.
Validate the temporary JSON object, numeric count, and checksum, apply the
recorded numeric owner and mode, atomically rename it over the old configured
path, and verify the final path's JSON, count, checksum, owner, and mode.
Only then restart the old service, restore old-host public ingress, and abort
the cutover window. A partial transfer never writes the live path. Public
routing has not changed at this point.

The copy is installed as:

```text
/var/lib/mud-web-proxy/attested-keys.json
```

Before first service start, create the containing directory with the same
owner and mode required from systemd `StateDirectory`. Install the file
through a same-directory mode-`0600` unique temporary file, validate its JSON,
numeric count, and checksum, assign owner `mud-web-proxy:mud-web-proxy`, and
atomically rename it over the configured destination. Verify the final
destination's JSON, count, checksum, owner, and mode. The final quiesced count
is persisted and both it and the pre-stop floor must match `^[0-9]+$`.
Checksum and count comparisons form one aggregate pre-start gate: the first
production service start is in the same strict procedure after every gate.
After start, require a JSON object and the unchanged final count again.
Routing remains conditional on that aggregate result and loopback health.

If production later disables App Attest, the private cutover record must say
so explicitly and show that both App Attest identifiers are absent. Silence
or an unreadable old configuration is not evidence that the feature is
disabled.

## Upgrade and rollback

### Upgrade

An upgrade performs:

1. download the release archive, checksums, SBOM, and provenance;
2. verify the checksum and provenance before extraction;
3. extract into a new directory on the same filesystem as `releases/`;
4. validate the version name, bundle contents, and canonical Bun pin;
5. install or verify the required versioned Bun runtime;
6. run the pinned runtime's `bun install --frozen-lockfile --production`;
7. validate ownership, modes, the public App Attest CA, and the built entry
   point;
8. create the release-local `runtime` symlink;
9. run the release's pre-activation checks;
10. persist the validated prior `current` target in the root-only
    `/var/lib/mud-web-proxy-deploy/previous-release` record;
11. create a unique temporary symlink under `/opt/mud-web-proxy`, clean it
    through a trap, and atomically rename it over `current`;
12. restart `mud-web-proxy.service`; and
13. require application health, WSS, and a complete mock-MUD session before
    accepting the release.

The activation shell uses `set -euo pipefail`, accepts only a safe basename
release identifier, proves the resolved release is a direct child of
`releases/`, and validates `VERSION`, `node_modules`, `dist/wsproxy.js`,
`.bun-version`, `package.json#engines.bun`, the relative runtime symlink, and
the runtime's reported version before writing the record or changing
`current`. A stale fixed temporary name is never reused, and restart cannot
run after a failed prerequisite or rename.

The service becomes unready before closing connections. A restart closes
WebSocket clients with code `1001` and reason `Server restarting`, closes
Telnet sessions, flushes App Attest state, and exits by its configured
shutdown deadline.

### Offline rollback

Before activation, the previous `current` target is recorded persistently.
Rollback:

1. reads the root-only record and rejects an empty or malformed target;
2. repeats the full release, entry-point, dependency, package/runtime pin, and
   direct-child path validation;
3. creates a unique same-filesystem temporary symlink with trap cleanup and
   atomically renames it over `current`;
4. restarts `mud-web-proxy.service`; and
5. repeats health, WSS, and mock-MUD validation.

No download, dependency installation, package-manager resolution, or DNS
lookup for artifacts occurs during rollback.

Configuration and App Attest state normally remain forward-compatible and
are shared across releases. Any future release that changes durable state
must either remain readable by every retained rollback release or declare a
state-backup and restore procedure before activation. A destructive,
backward-incompatible state migration cannot use this rollback model.

Pruning occurs only after the new release is accepted. Never prune the
recorded rollback target, either of the two retained previous releases, or a
Bun runtime referenced by a retained release.

## New-Droplet cutover

### Pre-stage

The production owner performs these steps before the low-traffic cutover
window:

1. Create an Ubuntu 26.04 LTS x64 Droplet with automated backups and
   DigitalOcean monitoring enabled.
2. If the current service uses a DigitalOcean Reserved IP, create the new
   Droplet in the same datacenter; Reserved IPs can only be reassigned within
   a datacenter.
3. Apply the production Cloud Firewall.
4. Install the exact versioned Bun runtime, MWP-105 systemd/Caddy
   configuration, and a verified MWP-103 release.
5. Transfer and validate configuration and referenced non-TLS secret files.
6. Resolve the old App Attest path and take the validated pre-stop safety
   copy, checksum, and key-count floor. Defer only the final copy until the
   old service is quiescent.
7. Validate the systemd and Caddy configuration while keeping the production
   systemd service stopped. Any pre-window application-health check uses an
   isolated foreground process, disposable App Attest state, and
   non-production configuration. Do not send production traffic to the new
   host.
8. Record the old and new Droplet IDs, current public-routing mechanism,
   previous DNS values and TTL, active and rollback release identifiers,
   artifact checksum, App Attest key count, cutover operator, and rollback
   command sequence in the private operations record.

DigitalOcean Cloud Firewalls are stateful and deny traffic not expressly
allowed. The production rules permit public TCP 80 and 443, permit TCP 22
only from named administrative source addresses, and contain no inbound rule
for 6200. See
[DigitalOcean firewall rules](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/).

Install and verify the DigitalOcean metrics agent. Configure notified
resource alerts for sustained CPU, memory, disk, and load pressure. See the
[DigitalOcean monitoring quickstart](https://docs.digitalocean.com/products/monitoring/getting-started/quickstart/).

### Public-routing preparation

Prefer the existing Reserved IP when one is already attached to the old
Droplet. Reassignment avoids waiting for recursive DNS caches and provides
the same operation in reverse for rollback. DigitalOcean documents both
control-panel and API/CLI reassignment in
[How to reassign Reserved IPs](https://docs.digitalocean.com/products/networking/reserved-ips/how-to/modify/).

If there is no existing Reserved IP, use DNS:

- lower the relevant A/AAAA record TTL to `300` at least one full previous
  TTL before the cutover, and preferably 24 hours before;
- confirm authoritative DNS serves the lower TTL before the window;
- record the old address and exact reversal command; and
- do not claim instant rollback, because caches may retain either address for
  up to the applicable TTL.

DigitalOcean's DNS guidance explains that TTL controls resolver caching and
recommends 300 or 600 seconds for records expected to change; see
[DNS record management](https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/#time-to-live-ttl-guidance).

### Cutover window

The cutover runs during a declared low-traffic window:

1. Announce the maintenance window.
2. Block new public requests to the old application at its existing edge or
   Cloud Firewall without changing its files.
3. Wait at least five seconds for the old release's debounced App Attest save
   to finish.
4. Stop the old proxy through its existing supervisor and wait for it to
   exit. Leave its configuration, release checkout, runtime, and state in
   place.
5. Validate the final App Attest JSON before calculating its count, require
   both the pre-stop floor and final count to be decimal integers, and require
   the final count to be at least the floor. If any check fails, atomically
   restore and verify the safety copy, restart the old service, restore
   old-host ingress, and abort before routing.
6. Persist the valid final store's checksum and numeric count.
7. Copy the exact final store through a unique same-directory temporary file,
   atomically replace the new destination, and verify final JSON, checksum,
   ownership, mode, and count.
8. Start the production systemd service for the first time only after the
   aggregate transfer gate; start Caddy and require loopback health.
9. Reassign the existing Reserved IP, or update DNS to the new Droplet.
10. Require public HTTPS health, WSS upgrade, a complete MUD session, correct
    forwarded client attribution, and the unchanged final App Attest key
    count.
11. Exercise a mandatory assertion from an already-registered production
    client after routing but before acceptance. A new registration does not
    satisfy the preservation test.
12. Record acceptance evidence and start the old-Droplet retention clock.

Active sessions do not survive this sequence. There is no cross-host session
handoff. Every connected player is disconnected at the switch, and all
in-memory resume buffers are lost. The low-traffic window is the explicit
user-visible cost of the cutover model. MWP-96-capable releases send
WebSocket close code `1001` with `Server restarting`; the currently deployed
v3.1.0 release predates that behavior, so the production cutover must not
promise that every legacy connection receives the close frame.

In the DNS path, clients holding the old address may see connection failures
until their cached record expires because the old service is deliberately
stopped after the final state copy.

### Infrastructure rollback

The old Droplet is a rollback target only because it remains functional and
the reversal is pre-staged.

If acceptance fails before the new host receives public traffic:

1. stop the new services;
2. reassign the Reserved IP to the old Droplet, or restore the old DNS value;
3. start the old service; and
4. verify health and a complete client session.

If the new host has received public traffic, its App Attest store may contain
new registrations or higher counters. Before restarting the old service:

1. stop the new proxy and wait for its state flush;
2. validate its JSON object, require a numeric count, and record its checksum,
   count, numeric owner, and numeric mode;
3. transfer it into a same-directory mode-`0600` unique temporary file on the
   old filesystem, leaving the live store untouched on partial transfer;
4. validate the temporary JSON, count, and checksum, apply the old path's
   recorded numeric owner and mode, and atomically rename it over the old
   configured path;
5. verify the final old path's JSON, count, checksum, owner, and mode; and
6. only then reverse public routing and start the old service.

The deployed v3.1.0 loader accepts the v4 store's additive `lastUsedAt` field,
so this reverse copy preserves registrations and assertion counters without
a format conversion. The private cutover record must still verify this claim
against the actual rollback release before the window.

The production owner retains the powered-on old Droplet for seven calendar
days after successful cutover, with only its legacy proxy service stopped and
its configuration and state intact. The owner deletes it after all of these
conditions hold:

- the new deployment has remained healthy for seven days;
- automated and file-level backups have completed successfully;
- a file-level restore has been tested;
- no cutover incident remains open; and
- the native release-level offline rollback has been exercised.

At deletion, remove the old Droplet and its residual production keys. Do not
delete or unassign a Reserved IP that has moved to the new host. The deletion
date and operator are recorded before the cutover; an unowned or undated
retention promise is not acceptable.

## Verification

### Clean-VM verification

Run the implementation on a fresh `ubuntu-26-04-x64` Droplet or equivalent
clean Ubuntu 26.04 LTS x64 VM:

1. provision Bun 1.3.14 under the versioned runtime path;
2. install two consecutive test releases with frozen production
   dependencies;
3. activate the older release and verify it;
4. activate the newer release through the atomic symlink swap and verify it;
5. disable artifact-network access;
6. roll back to the older release and verify it without any download or
   install step;
7. exercise graceful shutdown with a real WebSocket-to-mock-MUD session; and
8. repeat with an App Attest fixture store, checking that its key count
   survives upgrade and rollback.

Run the verification block as root. In particular, `ss -p` only reports
process information to a sufficiently privileged caller. The verification
records:

```bash
set -euo pipefail

readlink -f /opt/mud-web-proxy/current
find /opt/mud-web-proxy/releases -maxdepth 1 -mindepth 1 -type d -print
find /opt/mud-web-proxy/runtimes/bun -maxdepth 1 -mindepth 1 -type d -print
stat -c '%a %U:%G %n' /etc/mud-web-proxy.env
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy-deploy
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy-deploy/previous-release
NONEMPTY_ENV_VALUE_RE="(\"[^\"]+\"|'[^']+'|[^[:space:]#'\"][^#]*)"
if grep -Eq "^APPATTEST_BUNDLE_ID=${NONEMPTY_ENV_VALUE_RE}$" \
  /etc/mud-web-proxy.env &&
  grep -Eq "^APPATTEST_TEAM_ID=${NONEMPTY_ENV_VALUE_RE}$" \
    /etc/mud-web-proxy.env; then
  stat -c '%a %U:%G %n' /var/lib/mud-web-proxy/attested-keys.json
fi
/opt/mud-web-proxy/current/runtime/bin/bun --version
ss -ltnp | grep ':6200'
systemctl is-active mud-web-proxy caddy do-agent
```

Expected results:

- environment mode `640`, owner `root:mud-web-proxy`;
- state directory mode `700`, owner
  `mud-web-proxy:mud-web-proxy`;
- deployment-record directory mode `700`, owner `root:root`;
- rollback-record mode `600`, owner `root:root`;
- when both identifiers are configured, App Attest store mode `600` with owner
  `mud-web-proxy:mud-web-proxy`;
- active Bun version equal to the active release's `.bun-version`;
- port 6200 bound only to `127.0.0.1`;
- no public Cloud Firewall rule for 6200;
- health returns 200 when ready and 503 during drain;
- the newer release activates through one `current` swap; and
- offline rollback restores the older application and its matching Bun
  runtime.

### Spec acceptance

MWP-104 is satisfied when:

- every native path has an owner, mode, mutability, backup, and retention
  contract;
- Ubuntu 26.04 LTS x64 is the sole clean-VM target and the reason is explicit;
- Bun 1.3.14 provisioning and multi-version offline rollback are specified;
- the loopback TLS boundary omits
  `ALLOW_INSECURE_INBOUND_NO_TLS`;
- App Attest state transfer is mandatory and key-count preserving;
- transferred and deliberately omitted data are exhaustive;
- session loss and the low-traffic window are explicit;
- Reserved-IP and DNS cutover/rollback paths are concrete and pre-staged;
- the old Droplet has a named owner and a seven-day deletion deadline; and
- upgrade and rollback are verified on a clean Ubuntu 26.04 VM.

## Rejected alternatives

### In-place conversion of the existing Droplet

Rejected because it makes the unknown legacy operating system, packages,
filesystem residue, and mutable checkout part of the new deployment's trust
boundary. It would also require a second migration procedure that the chosen
cutover path does not exercise.

### Ubuntu 24.04 and 26.04 verification matrix

Rejected because no MWP-104 installation procedure runs on the old host.
Testing 24.04 would prove compatibility for a deployment target the project
does not support, without reducing cutover risk.

### One mutable global Bun installation

Rejected because upgrading it can make a retained release unstartable and
turn nominal offline rollback into a network-dependent repair.

### Bun embedded separately in every release

Rejected because identical runtime binaries would be duplicated across
releases. Versioned host runtimes preserve the release/runtime association
without duplication.

### Copying old TLS material

Rejected because Caddy reissues certificates on the new host. Copying
`cert.pem`, `privkey.pem`, or old ACME state would carry private material
forward without providing release or rollback value.

### DNS-only rollback when a Reserved IP already exists

Rejected because it introduces cache delay where an already-provisioned
reassignable address provides a faster, symmetric switch.
