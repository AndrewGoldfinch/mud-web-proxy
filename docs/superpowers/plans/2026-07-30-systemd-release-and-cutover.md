# Systemd Release and New-Droplet Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and continuously check the native systemd filesystem,
upgrade, rollback, backup, and new-Droplet cutover contracts defined by
MWP-104.

**Architecture:** Two public operator documents separate the stable native
deployment model from the one-time legacy-host cutover. A focused Bun test
asserts the safety-critical documentation invariants without attempting to
implement the systemd unit owned by MWP-105 or the release artifact owned by
MWP-103.

**Tech Stack:** Markdown, Bun 1.3.14, `bun:test`, Ubuntu 26.04 LTS, systemd,
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
- Retain the active release plus two verified previous releases and every Bun
  runtime they reference.
- `/etc/mud-web-proxy.env` is `0640 root:mud-web-proxy`.
- `/var/lib/mud-web-proxy` is `0700
mud-web-proxy:mud-web-proxy`.
- `/var/lib/mud-web-proxy/attested-keys.json` is `0600
mud-web-proxy:mud-web-proxy`.
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
- Active WebSocket, Telnet, and resumable sessions do not survive cutover.
- Prefer an existing DigitalOcean Reserved IP; otherwise lower DNS TTL to
  `300` before cutover.
- The production owner retains the stopped old Droplet for seven calendar
  days after acceptance, then deletes it only after the documented exit
  criteria pass.
- MWP-104 documents and statically verifies the contract. MWP-105 owns the
  real systemd/Caddy clean-host test, and MWP-103 owns two-release install and
  offline rollback testing with published artifacts.

---

### Task 1: Publish the native systemd deployment guide

**Files:**

- Create: `docs/deployment/systemd.md`
- Create: `tests/systemd-deployment-contract.test.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: `.bun-version`, `package.json#engines.bun`,
  `docs/configuration.md`, and the approved MWP-104 design.
- Produces: public native deployment contract at
  `docs/deployment/systemd.md`.
- Produces: `native systemd deployment documentation` contract tests.
- Produces: README link `docs/deployment/systemd.md`.

- [ ] **Step 1: Write the failing native-guide contract tests**

Create `tests/systemd-deployment-contract.test.ts`:

````typescript
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const readRoot = (name: string): string =>
  readFileSync(path.join(repoRoot, name), 'utf8');

const fencedBlockAfter = (source: string, marker: string): string => {
  const markerAt = source.indexOf(marker);
  if (markerAt === -1) return '';
  const fenceAt = source.indexOf('```', markerAt);
  if (fenceAt === -1) return '';
  const bodyAt = source.indexOf('\n', fenceAt) + 1;
  const endAt = source.indexOf('```', bodyAt);
  return endAt === -1 ? '' : source.slice(bodyAt, endAt);
};

describe('native systemd deployment documentation', () => {
  test('fixes the filesystem, runtime, and static-user contracts', () => {
    const guide = readRoot('docs/deployment/systemd.md');

    for (const required of [
      '/opt/mud-web-proxy/releases/$RELEASE_VERSION',
      '/opt/mud-web-proxy/current',
      '/opt/mud-web-proxy/runtimes/bun/$BUN_VERSION',
      'runtime -> ../../runtimes/bun/$BUN_VERSION',
      '/etc/mud-web-proxy.env',
      '/var/lib/mud-web-proxy/attested-keys.json',
      'StateDirectory=mud-web-proxy',
      'StateDirectoryMode=0700',
      'UMask=0077',
      'DynamicUser=yes is forbidden',
    ]) {
      expect(guide).toContain(required);
    }

    expect(guide).toContain('0640 root:mud-web-proxy');
    expect(guide).toContain('0700 mud-web-proxy:mud-web-proxy');
    expect(guide).toContain('0600 mud-web-proxy:mud-web-proxy');
  });

  test('keeps the native listener loopback-only without the Compose acknowledgement', () => {
    const guide = readRoot('docs/deployment/systemd.md');
    const environment = fencedBlockAfter(
      guide,
      'The native environment must begin with this boundary:',
    );

    expect(environment).toContain('BIND_HOST=127.0.0.1');
    expect(environment).toContain('WS_PORT=6200');
    expect(environment).toContain('INBOUND_TLS_MODE=off');
    expect(environment).toContain('TARGET_MODE=fixed');
    expect(environment).toContain(
      'ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json',
    );
    expect(environment).not.toContain('ALLOW_INSECURE_INBOUND_NO_TLS=');
    expect(environment).not.toContain('TLS_CERT_PATH=');
    expect(environment).not.toContain('TLS_KEY_PATH=');
  });

  test('makes upgrade and rollback deterministic and offline', () => {
    const guide = readRoot('docs/deployment/systemd.md');

    expect(guide).toContain(
      'active release and the two most recent verified previous releases',
    );
    expect(guide).toContain('bun install --frozen-lockfile --production');
    expect(guide).toContain('ln -s "releases/$RELEASE_VERSION"');
    expect(guide).toContain('mv -Tf');
    expect(guide).toContain('Rollback performs no download');
    expect(guide).toContain("ss -ltnp | grep ':6200'");
    expect(guide).toContain('640 root:mud-web-proxy');
  });

  test('README links to the native deployment guide', () => {
    expect(readRoot('README.md')).toContain(
      '[Native systemd deployment](docs/deployment/systemd.md)',
    );
  });
});
````

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
bun test tests/systemd-deployment-contract.test.ts
```

Expected: FAIL because `docs/deployment/systemd.md` does not exist and the
README has no native-deployment link.

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

## Atomic activation

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
```

Add the complete ownership table from the approved spec. Follow it with these
plain-text verification summaries so operators can compare `stat` output
without translating the table:

```text
/etc/mud-web-proxy.env: 0640 root:mud-web-proxy
/var/lib/mud-web-proxy: 0700 mud-web-proxy:mud-web-proxy
/var/lib/mud-web-proxy/attested-keys.json: 0600 mud-web-proxy:mud-web-proxy
```

Then add these literal requirements:

```text
StateDirectory=mud-web-proxy
StateDirectoryMode=0700
UMask=0077
DynamicUser=no
```

State `DynamicUser=yes is forbidden`. Explain `/var/lib/private` relocation,
transient UID ownership, pre-seeded-state incompatibility, and systemd's
recursive owner/mode correction at service start. Require the installer to
create the directory correctly before first start so verification does not
merely observe systemd repairing it.

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

The activation procedure must record the previous target and use one
same-filesystem symlink rename:

```bash
INSTALL_ROOT=/opt/mud-web-proxy
: "${RELEASE_VERSION:?set RELEASE_VERSION to the verified release identifier}"
RELEASE_DIR="$INSTALL_ROOT/releases/$RELEASE_VERSION"
test "$(cat "$RELEASE_DIR/VERSION")" = "$RELEASE_VERSION"
PREVIOUS_TARGET=
if [[ -L "$INSTALL_ROOT/current" ]]; then
  PREVIOUS_TARGET="$(readlink "$INSTALL_ROOT/current")"
fi
sudo ln -s "releases/$RELEASE_VERSION" "$INSTALL_ROOT/.current.new"
sudo mv -Tf "$INSTALL_ROOT/.current.new" "$INSTALL_ROOT/current"
sudo systemctl restart mud-web-proxy
```

The operator sets `RELEASE_VERSION` from the already verified extracted
directory. The equality check against its `VERSION` file must succeed before
the symlink is changed.

The rollback section must start with the literal sentence:

```text
Rollback performs no download, dependency installation, or package-manager resolution.
```

Then show an atomic symlink reversal, service restart, `/health`, WSS, and
mock-MUD validation. Retain the active release and the two most recent
verified previous releases plus every referenced Bun runtime and installed
`node_modules`.

The backup section must exhaustively divide:

- encrypted, off-host `/etc/mud-web-proxy.env`;
- referenced APNS key material;
- App Attest state;
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
readlink -f /opt/mud-web-proxy/current
find /opt/mud-web-proxy/releases -maxdepth 1 -mindepth 1 -type d -print
find /opt/mud-web-proxy/runtimes/bun -maxdepth 1 -mindepth 1 -type d -print
stat -c '%a %U:%G %n' /etc/mud-web-proxy.env
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy/attested-keys.json
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

- [ ] **Step 8: Run the focused test and document checks**

Run:

```bash
bun test tests/systemd-deployment-contract.test.ts \
  -t "native systemd deployment documentation"
bun run format
bun run check:bun-version
git diff --check
```

Expected:

```text
4 pass
All matched files use Prettier code style!
check-bun-version: all sources pin Bun 1.3.14.
```

- [ ] **Step 9: Commit the native deployment guide**

```bash
git add README.md docs/deployment/systemd.md \
  tests/systemd-deployment-contract.test.ts
git commit -m "docs: add native systemd deployment guide (MWP-104)"
```

---

### Task 2: Publish the new-Droplet cutover and rollback runbook

**Files:**

- Create: `docs/deployment/new-droplet-cutover.md`
- Modify: `tests/systemd-deployment-contract.test.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: the static layout and environment defined by
  `docs/deployment/systemd.md`.
- Produces: public cutover runbook at
  `docs/deployment/new-droplet-cutover.md`.
- Produces: App Attest preservation, routing, session-loss, and retention
  contract tests.
- Produces: README link `docs/deployment/new-droplet-cutover.md`.

- [ ] **Step 1: Add the failing cutover contract tests**

Append to `tests/systemd-deployment-contract.test.ts`:

```typescript
describe('new-Droplet cutover documentation', () => {
  test('protects the legacy non-atomic App Attest store', () => {
    const runbook = readRoot('docs/deployment/new-droplet-cutover.md');

    for (const required of [
      'App Attest is enabled in the current production deployment',
      'validated pre-stop safety copy',
      'key-count floor',
      'wait at least five seconds',
      'two-second debounced save',
      'post-stop store',
      'restore the safety copy',
      'abort the cutover window',
      'Public routing has not changed',
    ]) {
      expect(runbook).toContain(required);
    }
  });

  test('preserves App Attest state in both cutover directions', () => {
    const runbook = readRoot('docs/deployment/new-droplet-cutover.md');

    expect(runbook).toContain('/var/lib/mud-web-proxy/attested-keys.json');
    expect(runbook).toContain('jq -e \'type == "object"\'');
    expect(runbook).toContain("jq 'length'");
    expect(runbook).toContain('sha256sum');
    expect(runbook).toContain('already-registered production client');
    expect(runbook).toContain('copy the new host store back to the old host');
    expect(runbook).toContain('lastUsedAt');
  });

  test('pre-stages routing, disruption, and old-host deletion', () => {
    const runbook = readRoot('docs/deployment/new-droplet-cutover.md');

    expect(runbook).toContain('existing Reserved IP');
    expect(runbook).toContain('same datacenter');
    expect(runbook).toContain('TTL to `300`');
    expect(runbook).toContain('preferably 24 hours before');
    expect(runbook).toContain('Active sessions do not survive cutover');
    expect(runbook).toContain('seven calendar days');
    expect(runbook).toContain('production owner');
  });

  test('README links to the cutover runbook', () => {
    expect(readRoot('README.md')).toContain(
      '[New-Droplet cutover runbook](docs/deployment/new-droplet-cutover.md)',
    );
  });
});
```

- [ ] **Step 2: Run the cutover tests and confirm the red state**

Run:

```bash
bun test tests/systemd-deployment-contract.test.ts \
  -t "new-Droplet cutover documentation"
```

Expected: FAIL because the cutover runbook and README link do not exist.

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

Use shell variables rather than example production identifiers:

```bash
OLD_HOST=production-old
OLD_KEYS_PATH=/resolved/on-old-host/attested-keys.json
STAGING_DIR="$PWD/cutover-private"

umask 077
mkdir -p "$STAGING_DIR"
ssh "$OLD_HOST" "sudo cat '$OLD_KEYS_PATH'" \
  >"$STAGING_DIR/attested-keys.pre-stop.json"
jq -e 'type == "object"' \
  "$STAGING_DIR/attested-keys.pre-stop.json" >/dev/null
jq 'length' "$STAGING_DIR/attested-keys.pre-stop.json" \
  >"$STAGING_DIR/attested-keys.pre-stop.count"
sha256sum "$STAGING_DIR/attested-keys.pre-stop.json" \
  >"$STAGING_DIR/attested-keys.pre-stop.sha256"
ssh "$OLD_HOST" "sudo stat -c '%u %g %a' '$OLD_KEYS_PATH'" \
  >"$STAGING_DIR/attested-keys.pre-stop.stat"
```

Call this the `validated pre-stop safety copy` and its count the
`key-count floor`. If JSON validation fails because the copy intersected
v3.1.0's truncate-and-write window, wait and repeat; never retain an invalid
safety copy. The numeric UID, GID, and mode record is the authority used if
the safety copy must be restored.

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
7. require post-stop count greater than or equal to the pre-stop floor; and
8. calculate and record SHA-256; and
9. record the resolved source path plus numeric owner and mode.

Validate and compare in two phases so an invalid final file is never passed
to `jq 'length'`:

```bash
FINAL_STORE="$STAGING_DIR/attested-keys.post-stop.json"
FINAL_STORE_VALID=true

if ! jq -e 'type == "object"' "$FINAL_STORE" >/dev/null; then
  FINAL_STORE_VALID=false
else
  PRE_STOP_FLOOR="$(
    cat "$STAGING_DIR/attested-keys.pre-stop.count"
  )"
  POST_STOP_COUNT="$(jq 'length' "$FINAL_STORE")"
  if (( POST_STOP_COUNT < PRE_STOP_FLOOR )); then
    FINAL_STORE_VALID=false
  fi
fi
```

If `FINAL_STORE_VALID` is not `true`, restore the recorded file exactly:

```bash
read -r OLD_KEYS_UID OLD_KEYS_GID OLD_KEYS_MODE \
  <"$STAGING_DIR/attested-keys.pre-stop.stat"
ssh "$OLD_HOST" \
  "sudo tee '$OLD_KEYS_PATH' >/dev/null &&
   sudo chown '$OLD_KEYS_UID:$OLD_KEYS_GID' '$OLD_KEYS_PATH' &&
   sudo chmod '$OLD_KEYS_MODE' '$OLD_KEYS_PATH'" \
  <"$STAGING_DIR/attested-keys.pre-stop.json"
```

Then run the exact old-supervisor restart and old-ingress restoration
commands recorded during pre-stage, verify old-host health, and abort the
window. The runbook must not guess whether the legacy supervisor is PM2,
systemd, or another wrapper; the private record supplies the observed
production commands.

State immediately after the branch: `Public routing has not changed at this
point.`

- [ ] **Step 6: Document installation on the new host and acceptance**

Under `Pre-stage the new host`, require Ubuntu 26.04 LTS x64, automated
backups, the monitoring agent and alerts, the production Cloud Firewall, the
exact versioned Bun runtime, verified MWP-103 release, MWP-105 systemd/Caddy
files, semantically migrated configuration, and referenced non-TLS secrets.
Require loopback application health plus systemd and Caddy validation before
the cutover window; do not send production traffic to the new host yet.

Create the state directory and install the final store before first service
start:

```bash
NEW_HOST=production-new
FINAL_STORE="$STAGING_DIR/attested-keys.post-stop.json"

ssh "$NEW_HOST" \
  'sudo install -d -o mud-web-proxy -g mud-web-proxy -m 0700 /var/lib/mud-web-proxy'
ssh "$NEW_HOST" \
  'sudo tee /var/lib/mud-web-proxy/attested-keys.json >/dev/null &&
   sudo chown mud-web-proxy:mud-web-proxy /var/lib/mud-web-proxy/attested-keys.json &&
   sudo chmod 0600 /var/lib/mud-web-proxy/attested-keys.json' \
  <"$FINAL_STORE"
```

Verify local and remote checksums and key counts before start. After start,
require the final key count again, public `/health`, WSS, a complete MUD
session, correct forwarded client attribution, and an assertion from an
already-registered production client.

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
proxy, then copy the new host store back to the old host before restarting
it. Explain why this preserves new registrations and assertion counters and
why v3.1.0 round-trips `lastUsedAt`.

Retain the stopped old host for seven calendar days. Assign deletion to the
production owner. Require all five exit criteria before deletion:

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

- [ ] **Step 9: Run the focused and full repository checks**

Run:

```bash
bun test tests/systemd-deployment-contract.test.ts
bun run test
bun run lint
bun run typecheck
bun run build
bun run format
bun run check:bun-version
bun run check:config-docs
git diff --check
```

Expected:

- `8 pass` in the focused contract file;
- full unit suite exits `0`;
- lint, typecheck, build, formatting, Bun pin, configuration documentation,
  and diff checks all exit `0`.

- [ ] **Step 10: Commit the cutover runbook**

```bash
git add README.md docs/deployment/new-droplet-cutover.md \
  tests/systemd-deployment-contract.test.ts
git commit -m "docs: add new-Droplet cutover runbook (MWP-104)"
```

---

### Task 3: Transfer executable obligations to downstream Linear tickets

**Required skill:** `linear:linear`

**Files:**

- No repository files.
- Update Linear issues: MWP-103, MWP-104, MWP-105, and MWP-106.

**Interfaces:**

- Consumes: both public deployment documents and their passing contract test.
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

Add:

- validated pre-stop App Attest safety copy and key-count floor;
- five-second quiescence;
- post-stop parse and count validation;
- restore-and-abort branch before routing changes;
- mandatory final state transfer and existing-client assertion;
- Reserved-IP-first or pre-lowered DNS routing;
- explicit session loss;
- reverse state copy before rollback after public traffic; and
- seven-day old-host retention with production-owner deletion.

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
bun run format
bun run check:config-docs
git diff --check
```

Expected Bun version: `1.3.14`. Every command exits `0`.

- [ ] **Step 2: Review the changed-file boundary**

Run:

```bash
git status --short
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- \
  README.md \
  docs/deployment/systemd.md \
  docs/deployment/new-droplet-cutover.md \
  tests/systemd-deployment-contract.test.ts
```

Expected: no source, runtime, Docker, workflow, dependency, or lockfile
change.

- [ ] **Step 3: Scan for ambiguity and stale deployment ownership**

Run:

```bash
rg -n 'TBD|TODO|FIXME|DynamicUser=yes|ALLOW_INSECURE_INBOUND_NO_TLS' \
  README.md docs/deployment tests/systemd-deployment-contract.test.ts
rg -n 'MWP-103|MWP-104|MWP-105|MWP-106' \
  README.md docs/deployment
```

Expected:

- no placeholders;
- `DynamicUser=yes` appears only in explicit prohibition;
- `ALLOW_INSECURE_INBOUND_NO_TLS` appears only in native-path omission
  guidance and tests, never as an assignment;
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
