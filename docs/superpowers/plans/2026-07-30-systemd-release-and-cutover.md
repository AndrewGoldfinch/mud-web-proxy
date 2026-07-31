# Systemd Release and New-Droplet Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and continuously check the native systemd filesystem,
upgrade, rollback, backup, and new-Droplet cutover contracts defined by
MWP-104.

**Architecture:** Two public operator documents separate the stable native
deployment model from the one-time legacy-host cutover. The approved
documentation-only exception omits Markdown exact-string tests; formatter,
rendered-link, configuration-documentation, exact-runtime repository, and
tracked-diff gates verify the change without attempting to implement the
systemd unit owned by MWP-105 or release artifact owned by MWP-103.

**Tech Stack:** Markdown, Bun 1.3.14, Ubuntu 26.04 LTS, systemd,
DigitalOcean Droplets, Caddy.

## Global Constraints

- The canonical native host is a new DigitalOcean
  `ubuntu-26-04-x64` Droplet; Ubuntu 24.04 and in-place conversion are out of
  scope.
- The application root is `/opt/mud-web-proxy`.
- Immutable releases live at
  `/opt/mud-web-proxy/releases/$RELEASE_VERSION`.
- `/opt/mud-web-proxy/current` is the only activation symlink.
- Versioned Bun runtimes live at
  `/opt/mud-web-proxy/runtimes/bun/$BUN_VERSION`.
- The initial runtime is exactly Bun `1.3.14`.
- Every release contains `.bun-version` and a relative
  `runtime -> ../../runtimes/bun/$BUN_VERSION` symlink.
- Retain the active release, the release named by the non-empty root-only
  rollback record, two verified previous releases, and every Bun runtime they
  reference.
- `/etc/mud-web-proxy.env` is `0640 root:mud-web-proxy`.
- `/var/lib/mud-web-proxy` is `0700
mud-web-proxy:mud-web-proxy`.
- `/var/lib/mud-web-proxy/attested-keys.json` is `0600
mud-web-proxy:mud-web-proxy`.
- `/var/lib/mud-web-proxy-deploy` is `0700 root:root`, and its persistent
  `previous-release` record is `0600 root:root`.
- MWP-105 must use a static `mud-web-proxy` account,
  `StateDirectory=mud-web-proxy`, `StateDirectoryMode=0700`, `UMask=0077`,
  and must not use `DynamicUser=yes`.
- The native environment uses `BIND_HOST=127.0.0.1`,
  `WS_PORT=6200`, `INBOUND_TLS_MODE=off`, and `TARGET_MODE=fixed`.
- The native environment must omit `ALLOW_INSECURE_INBOUND_NO_TLS`,
  `TLS_CERT_PATH`, and `TLS_KEY_PATH`.
- App Attest is enabled in the current production deployment.
- App Attest migration requires both a validated pre-stop safety copy and a
  valid post-stop final copy whose key count is not below the safety-copy
  floor.
- A corrupt or smaller final store restores the safety copy and aborts before
  public routing changes.
- Safety restore and post-traffic reverse transfer use verified
  same-directory temporary files plus atomic rename; partial transfer never
  overwrites the old live path.
- Active WebSocket, Telnet, and resumable sessions do not survive cutover.
- Prefer an existing DigitalOcean Reserved IP; otherwise lower DNS TTL to
  `300` before cutover.
- The production owner retains the powered-on old Droplet for seven calendar
  days after acceptance with only its legacy proxy service stopped and its
  configuration and state intact, then deletes it only after the documented
  exit criteria pass.
- MWP-104 documents and statically verifies the contract. MWP-105 owns the
  real systemd/Caddy clean-host test, and MWP-103 owns two-release install and
  offline rollback testing with published artifacts.

---

### Task 1: Publish the native systemd deployment guide

**Files:**

- Create: `docs/deployment/systemd.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: `.bun-version`, `package.json#engines.bun`,
  `docs/configuration.md`, and the approved MWP-104 design.
- Produces: public native deployment contract at
  `docs/deployment/systemd.md`.
- Produces: README link `docs/deployment/systemd.md`.

- [ ] **Step 1: Confirm the documentation-only verification boundary**

Do not add a Markdown exact-string test. Record the approved exception and
use the existing exact-runtime unit suite, tracked-file Prettier check,
rendered-link audit, configuration-documentation check, and diff checks as
the verification boundary.

- [ ] **Step 2: Run the clean exact-runtime baseline**

Put the exact Bun 1.3.14 toolchain directory first in `PATH`, then run the
existing unit suite before changing the documents. Record the test count and
zero-failure result.

- [ ] **Step 3: Write the platform and layout sections**

Create `docs/deployment/systemd.md` with this exact heading order:

```markdown
# Native systemd deployment

## Scope and implementation status

## Supported host

## Filesystem layout

## Ownership, modes, and static service identity

## Versioned Bun runtime

## Native environment

## Installing a release

## Atomic current-link activation

## Apply an activated release

## Offline rollback

## Retention and pruning

## Backup-required and disposable data

## DigitalOcean firewall, monitoring, and backups

## Verification

## Responsibilities of follow-up tickets
```

Under `Scope and implementation status`, state that this is MWP-104's
normative layout and operations contract. Do not claim the unit or bundle
already exists: MWP-105 supplies the systemd/Caddy files and MWP-103 supplies
the release bundle.

Under `Supported host`, name only Ubuntu 26.04 LTS x64 and
`ubuntu-26-04-x64`. Explain that the old host release is irrelevant because
the selected strategy is new-host cutover, not in-place conversion. Preserve
the Ubuntu and DigitalOcean source links from the design.

Copy this layout literally:

```text
/opt/mud-web-proxy/
├── current -> releases/$RELEASE_VERSION
├── releases/
│   └── $RELEASE_VERSION/
│       ├── .bun-version
│       ├── VERSION
│       ├── config/apple-app-attest-root-ca.pem
│       ├── dist/wsproxy.js
│       ├── node_modules/
│       ├── package.json
│       ├── bun.lock
│       └── runtime -> ../../runtimes/bun/$BUN_VERSION
└── runtimes/bun/$BUN_VERSION/bin/bun
/etc/mud-web-proxy.env
/etc/mud-web-proxy/
/var/lib/mud-web-proxy/attested-keys.json
/var/lib/mud-web-proxy-deploy/
└── previous-release
```

Add the complete ownership table from the approved spec. Follow it with these
plain-text verification summaries so operators can compare `stat` output
without translating the table:

```text
/etc/mud-web-proxy.env: 0640 root:mud-web-proxy
/var/lib/mud-web-proxy: 0700 mud-web-proxy:mud-web-proxy
/var/lib/mud-web-proxy/attested-keys.json: 0600 mud-web-proxy:mud-web-proxy
/var/lib/mud-web-proxy-deploy: 0700 root:root
/var/lib/mud-web-proxy-deploy/previous-release: 0600 root:root
```

Then add these literal requirements:

```text
StateDirectory=mud-web-proxy
StateDirectoryMode=0700
UMask=0077
DynamicUser=no
```

State `DynamicUser=yes is forbidden`. Explain `/var/lib/private` relocation,
transient UID ownership, and pre-seeded-state incompatibility. Cite only the
official Ubuntu 26.04/Resolute `systemd.exec` page. State precisely that
systemd sets the innermost state directory's owner and configured mode,
recursively changes ownership only when that directory initially has the
wrong owner/group, leaves child ownership untouched when the directory owner
already matches, and does not infer or repair the JSON file's `0600` mode.
Require independent pre-start directory and file verification.

- [ ] **Step 4: Write the Bun and native-environment sections**

Document exact Bun installation as:

1. read `$RELEASE_DIR/.bun-version`;
2. require an exact `x.y.z`;
3. require equality with `package.json#engines.bun`;
4. download that exact official release asset;
5. verify the asset's published SHA-256;
6. install it under
   `/opt/mud-web-proxy/runtimes/bun/$BUN_VERSION`; and
7. require
   `/opt/mud-web-proxy/runtimes/bun/$BUN_VERSION/bin/bun --version`
   to print `$BUN_VERSION`.

State that Bun's global package-download cache is disposable installer state,
not immutable release content, backup data, or a rollback dependency.

Introduce the environment with this exact sentence and block:

````markdown
The native environment must begin with this boundary:

```text
BIND_HOST=127.0.0.1
WS_PORT=6200
INBOUND_TLS_MODE=off
TARGET_MODE=fixed
ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
```
````

Immediately state that `ALLOW_INSECURE_INBOUND_NO_TLS`, `TLS_CERT_PATH`, and
`TLS_KEY_PATH` must be absent. Explain that the acknowledgement is required
only off loopback and that Caddy, not the application, owns inbound TLS.

- [ ] **Step 5: Write the release, rollback, retention, and backup procedures**

The install procedure must use:

```bash
set -euo pipefail

RELEASE_VERSION="$(cat VERSION)"
BUN_VERSION="$(cat .bun-version)"
BUN="/opt/mud-web-proxy/runtimes/bun/$BUN_VERSION/bin/bun"
"$BUN" install --frozen-lockfile --production
ln -s "../../runtimes/bun/$BUN_VERSION" runtime
```

State that these commands run inside the newly extracted release before it is
made immutable. Archive checksum and provenance verification precede
extraction; bundle, dependency, runtime, ownership, and mode validation
precede activation. Health, WSS, and mock-MUD validation follow activation
and gate acceptance.

The guide's `Atomic current-link activation` block must be a complete root-run
Bash procedure with `set -euo pipefail`. It is service-neutral and must never
start, stop, or restart a service. It must:

1. accept only a safe basename `RELEASE_VERSION`;
2. prove the resolved release is a direct child of `releases/`;
3. validate `VERSION`, `node_modules`, `dist/wsproxy.js`, `.bun-version`,
   `package.json#engines.bun`, the relative runtime symlink, and the runtime's
   reported version;
4. validate the existing `current` target when present;
5. atomically persist that target in the root-only mode-`0600`
   `/var/lib/mud-web-proxy-deploy/previous-release` record before activation;
6. create a unique temporary directory under `/opt/mud-web-proxy`, create the
   temporary symlink inside it, and clean it through an `EXIT` trap;
7. atomically rename that unique same-filesystem symlink over `current`.

The separate `Apply an activated release` block must restart the service and
run health, WSS, and mock-MUD acceptance only after the complete current-link
activation block exits zero.

An initial activation may persist an empty record to mean that no prior
release exists. It does not satisfy production's tested-rollback requirement.

The rollback section must start with the literal sentence:

```text
Rollback performs no download, dependency installation, or package-manager resolution.
```

Then show a complete strict rollback procedure that reads and validates the
persistent record, repeats the direct-child and full release/runtime
validation, uses a trap-cleaned unique same-filesystem temporary symlink,
atomically reverses `current`. The separate `Apply an activated release` phase
restarts only after the rename and follows with `/health`, WSS, and mock-MUD
validation. It performs no download or installation. Retain the active
release, the recorded rollback release, the two most recent verified previous
releases, every referenced Bun runtime, and installed `node_modules`.

The backup section must exhaustively divide:

- encrypted, off-host `/etc/mud-web-proxy.env`;
- referenced APNS key material;
- App Attest state;
- `/var/lib/mud-web-proxy-deploy/previous-release`;
- DigitalOcean machine-level backup;
- immutable retained releases needed only for rollback; and
- disposable Git checkout, PM2 state, old Bun, Bun cache, private TLS
  material, logs, `chat.json`, and in-memory state.

Require a file-level backup before every upgrade and at least daily, plus a
tested restore on a non-production host. DigitalOcean automated backups are
an additional machine-recovery layer, not a replacement.

- [ ] **Step 6: Add the DigitalOcean and root verification sections**

Document:

- public TCP 80/443;
- TCP 22 only from administrative sources;
- no public rule for 6200;
- DigitalOcean metrics agent plus CPU, memory, disk, and load alerts;
- automated Droplet backups plus separate encrypted file backups; and
- Caddy certificate reissuance instead of old TLS-key transfer.

Prefix the verification block with `Run these commands as root:` and include:

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

Document expected mode/owner values and loopback-only `127.0.0.1:6200`.

- [ ] **Step 7: Link the guide from the README**

After the Docker image section in `README.md`, add:

```markdown
### Native systemd deployment

The preferred single-VM deployment uses immutable releases, a versioned Bun
runtime, a hardened systemd service on loopback, and host Caddy for HTTPS/WSS.
See [Native systemd deployment](docs/deployment/systemd.md). The systemd unit
and native release bundle land in MWP-105 and MWP-103 respectively; the guide
already defines the filesystem and operational contract they must implement.
```

Scope the existing certificate instructions to direct application-managed
TLS. State that native host Caddy and the Compose edge path set
`INBOUND_TLS_MODE=off` and omit `TLS_CERT_PATH` and `TLS_KEY_PATH`.

- [ ] **Step 8: Run the document checks**

Run:

```bash
git ls-files -z | xargs -0 prettier --check --ignore-unknown
bun run check:bun-version
git diff --check
```

Also run the fence-aware rendered-local-link audit over all tracked Markdown
files and require zero missing targets.

Expected:

```text
All matched files use Prettier code style!
check-bun-version: all sources pin Bun 1.3.14.
0 missing rendered local links
```

- [ ] **Step 9: Commit the native deployment guide**

```bash
git add README.md docs/deployment/systemd.md
git commit -m "docs: add native systemd deployment guide (MWP-104)"
```

---

### Task 2: Publish the new-Droplet cutover and rollback runbook

**Files:**

- Create: `docs/deployment/new-droplet-cutover.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: the static layout and environment defined by
  `docs/deployment/systemd.md`.
- Produces: public cutover runbook at
  `docs/deployment/new-droplet-cutover.md`.
- Produces: README link `docs/deployment/new-droplet-cutover.md`.

- [ ] **Step 1: Preserve the documentation-only verification boundary**

Do not add a Markdown exact-string test. Verify the runbook through operator
procedure review, tracked-file formatting, rendered links, the existing
exact-runtime suite, and the final diff/ambiguity audits.

- [ ] **Step 2: Audit the approved cutover inputs**

Re-read the approved design, native guide, current App Attest persistence
behavior, and live MWP-106 handoff before writing the runbook. Keep production
values and observed private commands out of the repository.

- [ ] **Step 3: Create the runbook structure and transfer inventory**

Create `docs/deployment/new-droplet-cutover.md` with this exact heading order:

```markdown
# New-Droplet production cutover

## Scope

## Known production facts

## Transfer inventory

## Deliberately excluded data

## Private cutover record

## Pre-stage the new host

## Take the App Attest safety copy

## Prepare public routing

## Cutover window

## Failure before routing changes

## Acceptance

## Infrastructure rollback

## Old-Droplet retention and deletion
```

Under `Known production facts`, state:

- the current production health endpoint reported v3.1.0 during the
  2026-07-30 design review;
- App Attest is enabled because `/attest/challenge` returned 200;
- v3.1.0 writes its key store non-atomically;
- v3.1.0 debounces saves for exactly two seconds; and
- v3.1.0 accepts and re-serializes the additive v4 `lastUsedAt` field.

Do not publish the production hostname, IP, Droplet ID, secrets, or resolved
legacy file path. Those values belong in the private cutover record.

Require the private record to contain the resolved old App Attest path, old
and new Droplet IDs, routing mechanism, previous A/AAAA values and TTL when
DNS is used, active and rollback release identifiers, artifact checksum,
pre-stop and final App Attest metadata, cutover operator, cutover timestamps,
exact old-supervisor restart command, exact ingress block/restore commands,
exact routing forward/reverse commands, retention deadline, and deletion
owner. The repository document defines these fields but contains none of
their production values.

The transfer inventory is exactly:

- semantically migrated environment configuration;
- referenced non-TLS secret files, currently the APNS signing key when
  enabled; and
- the App Attest key store.

The excluded inventory is exactly the list from the approved spec, including
old TLS material and `chat.json`.

- [ ] **Step 4: Document the recoverable pre-stop snapshot**

Use shell variables rather than real production identifiers. The public block
must use `set -euo pipefail`, mode-`0700` encrypted staging, `umask 077`, a
mode-`0600` unique local temporary file, and trap cleanup. An SSH or JSON
failure must leave any previously validated safety copy untouched.

Call this the `validated pre-stop safety copy` and its count the
`key-count floor`. If JSON validation fails because the copy intersected
v3.1.0's truncate-and-write window, wait and repeat the full procedure; never
accept an invalid safety copy. Validate the JSON object before accepting its
count, checksum, path, or numeric owner/mode metadata. Require the floor to
match `^[0-9]+$`. The numeric UID, GID, and mode record is the authority used
if the safety copy must be restored.

Require encrypted administrative staging, mode `0700` for the directory, and
mode `0600` for the files.

- [ ] **Step 5: Document the final-state validation and failure branch**

The cutover sequence before public routing changes is:

1. block new public requests at the old edge or Cloud Firewall;
2. wait at least five seconds;
3. stop the old supervisor and wait for process exit;
4. copy the post-stop store to private staging;
5. require `jq -e 'type == "object"'`;
6. calculate the post-stop `jq 'length'`;
7. require the floor and post-stop count to match `^[0-9]+$`;
8. require post-stop count greater than or equal to the pre-stop floor;
9. calculate and record SHA-256 and persist the final count; and
10. record the resolved source path plus numeric owner and mode.

The final-state block must use `set -euo pipefail`, a unique mode-`0600`
staging temporary file, and trap cleanup. Before the first new-service start
attempt, install an `EXIT` trap that preserves the original nonzero status and
stops both `mud-web-proxy.service` and Caddy after any new-service start,
loopback-health, or post-start App Attest-count failure. Validate the JSON
object before calculating its count. A failed SSH, parse, numeric-count,
floor, checksum, or metadata gate must exit nonzero before accepting the
final store.

If final validation fails, stop both new services and verify that both are
inactive before any old-host state restoration, old-supervisor restart,
old-ingress restoration, or routing reversal. Then the safety-restore
procedure must validate the local safety JSON, count, and checksum, create a
same-directory mode-`0600` unique temporary file on the old filesystem,
transfer into that file, and validate its JSON/count/checksum before
replacement. Apply the recorded numeric owner and mode, atomically rename it
over the configured path, and verify the final destination's JSON, count,
checksum, owner, and mode. A partial SSH transfer must leave the live file
untouched.

Only after final-destination verification and that new-service containment,
run the exact old-supervisor restart and old-ingress restoration commands
recorded during pre-stage, verify old-host health, and abort the window. The
runbook must not guess whether the legacy supervisor is PM2, systemd, or
another wrapper; the private record supplies the observed production commands.

State immediately after the branch: `Public routing has not changed at this
point.`

- [ ] **Step 6: Document installation on the new host and acceptance**

Under `Pre-stage the new host`, require Ubuntu 26.04 LTS x64, automated
backups, the monitoring agent and alerts, the production Cloud Firewall, the
exact versioned Bun runtime, verified MWP-103 release, MWP-105 systemd/Caddy
files, semantically migrated configuration, and referenced non-TLS secrets.
Require systemd and Caddy configuration validation before the cutover window.
Any pre-window application-health check must use an isolated foreground
process, a disposable App Attest state path, and non-production
configuration. Require the production proxy to be inactive before and after
the service-neutral `Atomic current-link activation` pre-stage operation.
Keep it stopped and do not run `Apply an activated release` until the post-stop
final store passes the aggregate pre-start gate; do not send production traffic
to the new host yet.

Create the state directory and install the final store before first service
start through a unique same-directory mode-`0600` temporary file. Validate
local recorded JSON/count/checksum and the floor, validate the remote
temporary JSON/count/checksum, atomically rename it over the configured
destination, and verify the final destination's JSON/count/checksum/owner/mode.

Put all checksum and count comparisons in one strict aggregate pre-start
block. Start the production systemd service and Caddy in that same block only
after every gate passes, require loopback health, and require the unchanged
JSON-object count after start. From the first start attempt, an `EXIT` trap
must preserve the original nonzero status and stop both new services after a
start, loopback-health, or post-start count failure. Execute the private
routing-forward command only after the aggregate block exits zero. Perform
public `/health`, WSS, a complete MUD session, correct forwarded client
attribution, and the mandatory assertion from an already-registered
production client after public routing but before acceptance.

Use the literal sentence `Active sessions do not survive cutover.` Explain
that all players disconnect and resume buffers are lost. Select a low-traffic
window and do not promise v3.1.0 sends the v4 `1001 / Server restarting`
frame.

- [ ] **Step 7: Document routing, infrastructure rollback, and deletion**

For an existing Reserved IP:

- require the new Droplet in the same datacenter;
- record old/new Droplet IDs and exact forward/reverse commands;
- reassign only after new-host loopback health; and
- reverse the assignment on rollback.

For DNS:

- lower TTL to `300` at least one previous TTL and preferably 24 hours before;
- verify the authoritative answer before the window;
- record previous A/AAAA values and reversal commands; and
- state rollback is bounded by resolver caches rather than instant.

If rollback occurs after the new host served traffic, stop and flush the new
proxy, stop Caddy, and verify that both new services are inactive before any
old-host state mutation, routing reversal, or old-service restart. Then
validate and persist the new store's JSON object, numeric count, checksum,
numeric owner, and numeric mode, and copy it to a mode-`0600` same-directory
unique temporary file on the old filesystem. Validate the temporary file,
apply the original recorded old-path owner/mode, atomically rename it over the
old configured path, and verify the final destination's
JSON/count/checksum/owner/mode. Reverse routing or restart the old service
only after that block exits zero. Explain why this preserves new registrations
and assertion counters and why v3.1.0 round-trips `lastUsedAt`.

Retain the powered-on old host for seven calendar days with only its legacy
proxy service stopped and its configuration and state intact. Assign deletion
to the production owner. Require all five exit criteria before deletion:

1. the new deployment has remained healthy for seven days;
2. automated and file-level backups completed successfully;
3. a file-level restore was tested;
4. no cutover incident remains open; and
5. native release-level offline rollback was exercised.

At deletion, remove the Droplet and its residual production keys, retain any
Reserved IP now attached to the new host, and record the operator and time.

- [ ] **Step 8: Add the README runbook link**

Extend the native deployment README section with:

```markdown
Migration from the legacy PM2/git-checkout host uses a new Ubuntu 26.04
Droplet rather than an in-place conversion. Follow the
[New-Droplet cutover runbook](docs/deployment/new-droplet-cutover.md);
App Attest state preservation is mandatory for the current production
deployment.
```

- [ ] **Step 9: Run the full repository and document checks**

Run:

```bash
bun run test
bun run lint
bun run typecheck
bun run build
bun run check:bun-version
bun run check:config-docs
git ls-files -z | xargs -0 prettier --check --ignore-unknown
git diff --check
```

Also run the fence-aware rendered-local-link audit and require zero missing
targets.

Expected:

- full unit suite exits `0`;
- lint, typecheck, build, formatting, Bun pin, configuration documentation,
  rendered-link, and diff checks all exit `0`.

- [ ] **Step 10: Commit the cutover runbook**

```bash
git add README.md docs/deployment/new-droplet-cutover.md
git commit -m "docs: add new-Droplet cutover runbook (MWP-104)"
```

---

### Task 3: Transfer executable obligations to downstream Linear tickets

**Required skill:** `linear:linear`

**Files:**

- No repository files.
- Update Linear issues: MWP-103, MWP-104, MWP-105, and MWP-106.

**Interfaces:**

- Consumes: both public deployment documents and their passing document and
  repository gates.
- Produces: downstream ticket requirements that cannot decay into a closed
  design ticket.

- [ ] **Step 1: Re-fetch all four issues before mutation**

Read MWP-103, MWP-104, MWP-105, and MWP-106 with relations included. Confirm
their titles and current statuses before updating descriptions.

- [ ] **Step 2: Add the release/runtime handoff to MWP-103**

Add these explicit requirements to MWP-103:

- bundle `.bun-version`;
- require exact equality with `package.json#engines.bun`;
- install production dependencies with that exact versioned runtime;
- create the release-local relative `runtime` symlink before activation;
- retain installed `node_modules` and referenced runtimes for every retained
  rollback release; and
- verify two published releases plus offline rollback without downloads.

Do not make MWP-103 bundle a duplicate Bun binary inside every release.

- [ ] **Step 3: Add the static-user and state handoff to MWP-105**

Add these exact requirements to MWP-105:

```text
User=mud-web-proxy
Group=mud-web-proxy
DynamicUser=no
StateDirectory=mud-web-proxy
StateDirectoryMode=0700
UMask=0077
```

State that `DynamicUser=yes` is forbidden because `/var/lib/private`
relocation and transient ownership conflict with the pre-seeded App Attest
store. Require:

```text
ExecStart=/opt/mud-web-proxy/current/runtime/bin/bun /opt/mud-web-proxy/current/dist/wsproxy.js
```

Also preserve the loopback environment and the absence of
`ALLOW_INSECURE_INBOUND_NO_TLS`.

- [ ] **Step 4: Add the production cutover obligations to MWP-106**

Add this exact production order:

1. block new public ingress to the old application;
2. wait at least five seconds while the old proxy still runs;
3. stop the legacy proxy and wait for process exit;
4. validate post-stop JSON and require its count not below the pre-stop floor;
5. restore and abort before routing on failure;
6. transfer and verify final state before the first production systemd-service
   start;
7. change public routing only after new-host loopback health; and
8. perform the established-client assertion after public routing but before
   acceptance.

Also preserve the validated pre-stop safety copy, Reserved-IP-first or
pre-lowered-DNS routing, explicit session loss, verified reverse state copy
before rollback after public traffic, and service-only seven-day old-host
retention with production-owner deletion.

- [ ] **Step 5: Correct MWP-104's verification ownership**

MWP-104 is a design/documentation prerequisite, so it cannot honestly run the
final MWP-105 unit or consume the not-yet-published MWP-103 bundle. Replace
the impossible clean-VM acceptance wording with:

- MWP-104 statically verifies the documented path, ownership, environment,
  upgrade, rollback, and cutover invariants;
- MWP-105 verifies the real unit, StateDirectory behavior, loopback bind,
  Caddy path, and graceful shutdown on clean Ubuntu 26.04; and
- MWP-103 verifies two published native releases and offline rollback on that
  host.

Keep Ubuntu 26.04 x64 as the sole clean-host baseline.

- [ ] **Step 6: Re-fetch and verify the mutations**

Require each ticket to contain its transferred requirements. Add an MWP-104
comment linking the two repository documents and the implementation PR once
the PR exists.

---

### Task 4: Final verification and review handoff

**Required skill:** `superpowers:requesting-code-review`

**Files:**

- Verify only; do not make unrelated cleanup changes.

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces: review-ready MWP-104 branch with repository and Linear evidence.

- [ ] **Step 1: Run the exact-runtime repository gate**

Run under Bun 1.3.14:

```bash
bun --version
bun run check:bun-version
bun run test
bun run lint
bun run typecheck
bun run build
bun run check:config-docs
git ls-files -z | xargs -0 prettier --check --ignore-unknown
git diff --check
```

Run the fence-aware rendered-local-link audit as part of this gate. Expected
Bun version: `1.3.14`; every command exits `0` and no rendered local link is
missing. While SDD scratch exists, format all tracked files with Prettier
rather than changing `.prettierignore`; the controller runs package-wide
formatting after scratch deletion.

- [ ] **Step 2: Review the changed-file boundary**

Run:

```bash
git status --short
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- \
  README.md \
  docs/deployment/systemd.md \
  docs/deployment/new-droplet-cutover.md
```

Expected: no source, runtime, Docker, workflow, dependency, or lockfile
change.

- [ ] **Step 3: Scan for ambiguity and stale deployment ownership**

Run:

```bash
rg -n 'TBD|TODO|FIXME|DynamicUser=yes|ALLOW_INSECURE_INBOUND_NO_TLS' \
  README.md docs/deployment
rg -n 'MWP-103|MWP-104|MWP-105|MWP-106' \
  README.md docs/deployment
```

Expected:

- no placeholders;
- `DynamicUser=yes` appears only in explicit prohibition;
- `ALLOW_INSECURE_INBOUND_NO_TLS` appears only in native-path omission
  guidance, never as a native-path assignment;
- downstream ownership matches the approved design.

- [ ] **Step 4: Request code review**

Review against:

- the approved MWP-104 spec;
- both review amendments;
- the MWP-104 Linear acceptance criteria;
- the downstream handoffs in MWP-103, MWP-105, and MWP-106; and
- the changed-file boundary.

Resolve substantive findings, rerun Task 4 Step 1, then publish the branch for
review.
