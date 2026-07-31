# New-Droplet production cutover

## Scope

This runbook moves production from the legacy PM2/git-checkout host to a new
Ubuntu 26.04 LTS x64 Droplet. It consumes the native host layout in
[Native systemd deployment](systemd.md); MWP-103 supplies the verified release
and MWP-105 supplies the systemd and Caddy files. MWP-106 owns execution of the
production cutover. This runbook does not convert the old host in place.

Complete the private cutover record before the window. Do not put production
hostnames, addresses, Droplet IDs, secret values, resolved legacy paths, or
legacy supervisor commands in this repository.

## Known production facts

- The current production health endpoint reported v3.1.0 during the
  2026-07-30 design review.
- App Attest is enabled in the current production deployment because
  `/attest/challenge` returned 200.
- v3.1.0 writes its key store non-atomically: it truncates and rewrites the
  live file.
- v3.1.0 debounces saves for exactly two seconds.
- v3.1.0 accepts and re-serializes the additive v4 `lastUsedAt` field.

App Attest is not optional for this cutover. Established clients retain their
`keyId`; an empty or lost store causes them to fail with `Unknown key` rather
than automatically register again.

## Transfer inventory

Transfer only:

- semantically migrated environment configuration;
- referenced non-TLS secret files, currently the APNS signing key when
  enabled; and
- the App Attest key store.

The new environment is a semantic migration, not a copy of the old file.
Build it from the [configuration reference](../configuration.md), retaining
the required production values while applying the native boundary from
`systemd.md`:

```text
BIND_HOST=127.0.0.1
WS_PORT=6200
INBOUND_TLS_MODE=off
TARGET_MODE=fixed
ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
```

`ALLOW_INSECURE_INBOUND_NO_TLS`, `TLS_CERT_PATH`, and `TLS_KEY_PATH` must be
absent. Caddy owns inbound TLS. Place `/etc/mud-web-proxy.env` and any
referenced APNS key in the ownership and modes required by `systemd.md`.

## Deliberately excluded data

Do not transfer or restore as application state:

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

Caddy obtains new certificates on the new host. Do not copy old TLS material
or certificate private keys.

## Private cutover record

Store this encrypted administrative record outside the repository. It must
contain no placeholders at window start:

- resolved old App Attest path;
- old and new Droplet IDs;
- routing mechanism, plus previous A/AAAA values and TTL when DNS is used;
- active and rollback release identifiers and artifact checksum;
- pre-stop and final App Attest source path, SHA-256, JSON object key count,
  numeric owner, and numeric mode;
- any post-traffic reverse-copy source path, SHA-256, JSON object key count,
  numeric owner, and numeric mode;
- cutover operator and cutover timestamps;
- exact old-supervisor restart command;
- exact ingress block and restore commands;
- exact routing forward and reverse commands;
- retention deadline; and
- deletion owner.

The record must also state that the rollback release accepts and re-serializes
the additive `lastUsedAt` field. This repository defines the fields but
contains none of their production values.

## Pre-stage the new host

Before a declared low-traffic window, the production owner must:

1. Create an Ubuntu 26.04 LTS x64 Droplet with automated backups enabled.
   If an existing Reserved IP is used, create it in the same datacenter.
2. Apply the production Cloud Firewall: public TCP 80/443, TCP 22 only from
   administrative sources, and no public rule for 6200.
3. Install and verify the monitoring agent and notified CPU, memory, disk,
   and load alerts.
4. Install the exact versioned Bun runtime, Bun 1.3.14, and verify the
   release-local runtime reports that exact version. Do not use an unversioned
   system Bun.
5. Install the verified MWP-103 release and the MWP-105 systemd/Caddy files
   according to `systemd.md`. Verify artifact checksum and provenance before
   extraction, install the unit, and keep both the proxy and Caddy inactive.
   Record both service states and require each to be exactly `inactive`:

   ```bash
   PROXY_STATE="$(systemctl is-active mud-web-proxy || true)"
   [[ "$PROXY_STATE" == "inactive" ]]
   CADDY_STATE="$(systemctl is-active caddy || true)"
   [[ "$CADDY_STATE" == "inactive" ]]
   ```

   Run only `Atomic current-link activation`. After the link swap, record both
   service states again and require each to be exactly `inactive`:

   ```bash
   PROXY_STATE="$(systemctl is-active mud-web-proxy || true)"
   [[ "$PROXY_STATE" == "inactive" ]]
   CADDY_STATE="$(systemctl is-active caddy || true)"
   [[ "$CADDY_STATE" == "inactive" ]]
   ```

   `Apply an activated release` is forbidden until the final App Attest
   transfer gate.

6. Semantically migrate the environment and referenced non-TLS secret files
   as described in the transfer inventory.
7. Resolve the legacy App Attest path, take the validated pre-stop safety
   copy, and record the required metadata. Defer the final copy until the old
   service is quiescent.
8. Validate the systemd and Caddy configuration while keeping the production
   systemd service stopped. Any pre-window application-health check must use
   an isolated foreground verification process and configuration with a
   disposable App Attest state path. It must not use or mutate production App
   Attest state. The production systemd service must not start until the
   validated post-stop final store is installed. Do not send production traffic
   to the new host yet.

Record the old and new Droplet IDs, routing mechanism, releases, artifact
checksum, App Attest metadata, operator, and recorded rollback commands before
the window.

## Take the App Attest safety copy

Use encrypted administrative staging. The staging directory must be mode
`0700` and every staged file must be mode `0600`; `umask 077` below enforces
the latter for newly created files. This is the **validated pre-stop safety
copy**. Its JSON object key count is the **key-count floor**.

```bash
set -euo pipefail
umask 077

OLD_HOST=production-old
OLD_KEYS_PATH=/resolved/on-old-host/attested-keys.json
STAGING_DIR="$PWD/cutover-private"
PRE_STOP_STORE="$STAGING_DIR/attested-keys.pre-stop.json"

: "${OLD_HOST:?}"
: "${OLD_KEYS_PATH:?}"
mkdir -p "$STAGING_DIR"
chmod 0700 "$STAGING_DIR"
[[ ! -L "$STAGING_DIR" ]]
[[ "$(stat -c '%a' "$STAGING_DIR")" == "700" ]]

PRE_STOP_TEMP=
cleanup() {
  if [[ -n "$PRE_STOP_TEMP" ]]; then
    rm -f -- "$PRE_STOP_TEMP" || true
  fi
}
trap cleanup EXIT

PRE_STOP_TEMP="$(mktemp "$STAGING_DIR/.attested-keys.pre-stop.XXXXXX")"
chmod 0600 "$PRE_STOP_TEMP"
ssh "$OLD_HOST" "sudo cat '$OLD_KEYS_PATH'" >"$PRE_STOP_TEMP"

jq -e 'type == "object"' "$PRE_STOP_TEMP" >/dev/null
PRE_STOP_FLOOR="$(jq -er 'length' "$PRE_STOP_TEMP")"
[[ "$PRE_STOP_FLOOR" =~ ^[0-9]+$ ]]
PRE_STOP_SHA256="$(sha256sum "$PRE_STOP_TEMP" | awk '{print $1}')"
[[ "$PRE_STOP_SHA256" =~ ^[0-9a-f]{64}$ ]]
PRE_STOP_STAT="$(
  ssh "$OLD_HOST" "sudo stat -c '%u %g %a' '$OLD_KEYS_PATH'"
)"
read -r PRE_STOP_UID PRE_STOP_GID PRE_STOP_MODE PRE_STOP_EXTRA \
  <<<"$PRE_STOP_STAT"
[[ "$PRE_STOP_UID" =~ ^[0-9]+$ ]]
[[ "$PRE_STOP_GID" =~ ^[0-9]+$ ]]
[[ "$PRE_STOP_MODE" =~ ^[0-7]{3,4}$ ]]
[[ -z "${PRE_STOP_EXTRA:-}" ]]

mv -Tf -- "$PRE_STOP_TEMP" "$PRE_STOP_STORE"
PRE_STOP_TEMP=
printf '%s\n' "$PRE_STOP_FLOOR" \
  >"$STAGING_DIR/attested-keys.pre-stop.count"
printf '%s\n' "$PRE_STOP_SHA256" \
  >"$STAGING_DIR/attested-keys.pre-stop.sha256"
printf '%s %s %s\n' \
  "$PRE_STOP_UID" "$PRE_STOP_GID" "$PRE_STOP_MODE" \
  >"$STAGING_DIR/attested-keys.pre-stop.stat"
printf '%s\n' "$OLD_KEYS_PATH" \
  >"$STAGING_DIR/attested-keys.pre-stop.path"
chmod 0600 "$PRE_STOP_STORE" "$STAGING_DIR"/attested-keys.pre-stop.*
```

If JSON validation fails, the copy may have intersected v3.1.0's
truncate-and-write window. The strict block exits without replacing an
existing validated safety copy. Wait and repeat the complete block. Never
accept an invalid copy. The numeric UID, GID, and mode record is the authority
if the safety copy must be restored. The floor must match `^[0-9]+$`.

## Prepare public routing

Prefer the existing Reserved IP when one is attached to the old Droplet. The
new Droplet must be in the same datacenter. Record the old and new Droplet IDs
and the exact forward and reverse reassignment commands. Reassign only after
new-host loopback health is accepted.

When no existing Reserved IP is available, use DNS instead:

- lower the relevant A/AAAA record TTL to `300` at least one full previous
  TTL before the window, preferably 24 hours before;
- verify the authoritative answer serves the lower TTL before the window;
- record the previous A/AAAA values and exact reversal command; and
- treat rollback as bounded by resolver caches, not instant.

## Cutover window

Announce a low-traffic maintenance window. Active sessions do not survive
cutover. Every player disconnects and all in-memory resume buffers are lost.
The current v3.1.0 release predates the v4 `1001 / Server restarting` close
frame, so do not promise that legacy connections receive it.

Before changing public routing:

1. Block new public requests at the old edge or Cloud Firewall using the
   exact pre-recorded ingress command.
2. While the old proxy continues running, wait at least five seconds, longer
   than the two-second debounced save.
3. Stop the old supervisor using the exact pre-recorded command and wait for
   process exit.
4. Copy the post-stop store to private staging:

   ```bash
   set -euo pipefail
   umask 077

   : "${OLD_HOST:?}"
   : "${OLD_KEYS_PATH:?}"
   : "${STAGING_DIR:?}"
   FINAL_STORE="$STAGING_DIR/attested-keys.post-stop.json"
   FINAL_TEMP=
   cleanup() {
     if [[ -n "$FINAL_TEMP" ]]; then
       rm -f -- "$FINAL_TEMP" || true
     fi
   }
   trap cleanup EXIT

   PRE_STOP_FLOOR="$(
     <"$STAGING_DIR/attested-keys.pre-stop.count"
   )"
   [[ "$PRE_STOP_FLOOR" =~ ^[0-9]+$ ]]

   FINAL_TEMP="$(mktemp "$STAGING_DIR/.attested-keys.post-stop.XXXXXX")"
   chmod 0600 "$FINAL_TEMP"
   ssh "$OLD_HOST" "sudo cat '$OLD_KEYS_PATH'" >"$FINAL_TEMP"

   jq -e 'type == "object"' "$FINAL_TEMP" >/dev/null
   POST_STOP_COUNT="$(jq -er 'length' "$FINAL_TEMP")"
   [[ "$POST_STOP_COUNT" =~ ^[0-9]+$ ]]
   ((POST_STOP_COUNT >= PRE_STOP_FLOOR))
   POST_STOP_SHA256="$(sha256sum "$FINAL_TEMP" | awk '{print $1}')"
   [[ "$POST_STOP_SHA256" =~ ^[0-9a-f]{64}$ ]]
   POST_STOP_STAT="$(
     ssh "$OLD_HOST" "sudo stat -c '%u %g %a' '$OLD_KEYS_PATH'"
   )"
   read -r POST_STOP_UID POST_STOP_GID POST_STOP_MODE POST_STOP_EXTRA \
     <<<"$POST_STOP_STAT"
   [[ "$POST_STOP_UID" =~ ^[0-9]+$ ]]
   [[ "$POST_STOP_GID" =~ ^[0-9]+$ ]]
   [[ "$POST_STOP_MODE" =~ ^[0-7]{3,4}$ ]]
   [[ -z "${POST_STOP_EXTRA:-}" ]]

   mv -Tf -- "$FINAL_TEMP" "$FINAL_STORE"
   FINAL_TEMP=
   printf '%s\n' "$POST_STOP_COUNT" \
     >"$STAGING_DIR/attested-keys.post-stop.count"
   printf '%s\n' "$POST_STOP_SHA256" \
     >"$STAGING_DIR/attested-keys.post-stop.sha256"
   printf '%s %s %s\n' \
     "$POST_STOP_UID" "$POST_STOP_GID" "$POST_STOP_MODE" \
     >"$STAGING_DIR/attested-keys.post-stop.stat"
   printf '%s\n' "$OLD_KEYS_PATH" \
     >"$STAGING_DIR/attested-keys.post-stop.path"
   chmod 0600 "$FINAL_STORE" "$STAGING_DIR"/attested-keys.post-stop.*
   ```

This block validates JSON before calculating its count, requires both counts
to be decimal integers, persists the final count, and accepts the final file
only after every gate passes. If it exits nonzero, run **Failure before routing
changes** immediately and abort the window. Do not run any new-host install,
service-start, or routing command with an invalid or smaller final store.

Install and verify the valid final store before the first service start. This
single strict block is the aggregate checksum/count pre-start gate. It writes
through a mode-`0600` unique temporary file in the state directory, validates
the temporary copy, atomically renames it over the configured destination,
verifies the final destination, and starts services only after every
comparison succeeds:

```bash
set -euo pipefail
umask 077

NEW_HOST=production-new
STATE_DIR=/var/lib/mud-web-proxy
REMOTE_FINAL_STORE="$STATE_DIR/attested-keys.json"
FINAL_STORE="$STAGING_DIR/attested-keys.post-stop.json"

: "${NEW_HOST:?}"
: "${STAGING_DIR:?}"
[[ -f "$FINAL_STORE" && ! -L "$FINAL_STORE" ]]
jq -e 'type == "object"' "$FINAL_STORE" >/dev/null
LOCAL_FINAL_COUNT="$(jq -er 'length' "$FINAL_STORE")"
RECORDED_FINAL_COUNT="$(
  <"$STAGING_DIR/attested-keys.post-stop.count"
)"
PRE_STOP_FLOOR="$(
  <"$STAGING_DIR/attested-keys.pre-stop.count"
)"
[[ "$LOCAL_FINAL_COUNT" =~ ^[0-9]+$ ]]
[[ "$RECORDED_FINAL_COUNT" =~ ^[0-9]+$ ]]
[[ "$PRE_STOP_FLOOR" =~ ^[0-9]+$ ]]
[[ "$LOCAL_FINAL_COUNT" == "$RECORDED_FINAL_COUNT" ]]
((LOCAL_FINAL_COUNT >= PRE_STOP_FLOOR))

LOCAL_FINAL_SHA256="$(sha256sum "$FINAL_STORE" | awk '{print $1}')"
RECORDED_FINAL_SHA256="$(
  <"$STAGING_DIR/attested-keys.post-stop.sha256"
)"
[[ "$LOCAL_FINAL_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$RECORDED_FINAL_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$LOCAL_FINAL_SHA256" == "$RECORDED_FINAL_SHA256" ]]

ssh "$NEW_HOST" \
  "sudo install -d -o mud-web-proxy -g mud-web-proxy -m 0700 '$STATE_DIR'"
[[ "$(ssh "$NEW_HOST" \
  "sudo stat -c '%a %U:%G' '$STATE_DIR'")" \
  == "700 mud-web-proxy:mud-web-proxy" ]]

REMOTE_INSTALL_TEMP=
NEW_SERVICES_MAY_BE_RUNNING=0
cleanup() {
  status=$?
  if [[ -n "$REMOTE_INSTALL_TEMP" ]]; then
    ssh "$NEW_HOST" "sudo rm -f -- '$REMOTE_INSTALL_TEMP'" || true
  fi
  if ((status != 0 && NEW_SERVICES_MAY_BE_RUNNING == 1)); then
    ssh "$NEW_HOST" \
      'sudo systemctl stop mud-web-proxy caddy' || true
  fi
  return "$status"
}
trap cleanup EXIT

REMOTE_INSTALL_TEMP="$(
  ssh "$NEW_HOST" \
    "sudo mktemp -p '$STATE_DIR' '.attested-keys.install.XXXXXX'"
)"
[[ "$(dirname -- "$REMOTE_INSTALL_TEMP")" == "$STATE_DIR" ]]
ssh "$NEW_HOST" \
  "sudo chmod 0600 '$REMOTE_INSTALL_TEMP' &&
   sudo tee '$REMOTE_INSTALL_TEMP' >/dev/null" \
  <"$FINAL_STORE"

REMOTE_TEMP_COUNT="$(
  ssh "$NEW_HOST" "sudo cat '$REMOTE_INSTALL_TEMP'" |
    jq -er 'if type == "object" then length else error("not object") end'
)"
REMOTE_TEMP_SHA256="$(
  ssh "$NEW_HOST" "sudo cat '$REMOTE_INSTALL_TEMP'" |
    sha256sum | awk '{print $1}'
)"
[[ "$REMOTE_TEMP_COUNT" =~ ^[0-9]+$ ]]
[[ "$REMOTE_TEMP_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$REMOTE_TEMP_COUNT" == "$LOCAL_FINAL_COUNT" ]]
[[ "$REMOTE_TEMP_SHA256" == "$LOCAL_FINAL_SHA256" ]]

ssh "$NEW_HOST" \
  "sudo chown mud-web-proxy:mud-web-proxy '$REMOTE_INSTALL_TEMP' &&
   sudo chmod 0600 '$REMOTE_INSTALL_TEMP' &&
   sudo mv -Tf -- '$REMOTE_INSTALL_TEMP' '$REMOTE_FINAL_STORE'"
REMOTE_INSTALL_TEMP=

REMOTE_FINAL_COUNT="$(
  ssh "$NEW_HOST" "sudo cat '$REMOTE_FINAL_STORE'" |
    jq -er 'if type == "object" then length else error("not object") end'
)"
REMOTE_FINAL_SHA256="$(
  ssh "$NEW_HOST" "sudo cat '$REMOTE_FINAL_STORE'" |
    sha256sum | awk '{print $1}'
)"
REMOTE_FINAL_STAT="$(
  ssh "$NEW_HOST" \
    "sudo stat -c '%a %U:%G' '$REMOTE_FINAL_STORE'"
)"
[[ "$REMOTE_FINAL_COUNT" =~ ^[0-9]+$ ]]
[[ "$REMOTE_FINAL_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$REMOTE_FINAL_COUNT" == "$LOCAL_FINAL_COUNT" ]]
[[ "$REMOTE_FINAL_SHA256" == "$LOCAL_FINAL_SHA256" ]]
[[ "$REMOTE_FINAL_STAT" == "600 mud-web-proxy:mud-web-proxy" ]]

NEW_SERVICES_MAY_BE_RUNNING=1
ssh "$NEW_HOST" 'sudo systemctl start mud-web-proxy caddy'
ssh "$NEW_HOST" \
  'curl --fail --silent --show-error http://127.0.0.1:6200/health >/dev/null'
POST_START_COUNT="$(
  ssh "$NEW_HOST" "sudo cat '$REMOTE_FINAL_STORE'" |
    jq -er 'if type == "object" then length else error("not object") end'
)"
[[ "$POST_START_COUNT" =~ ^[0-9]+$ ]]
[[ "$POST_START_COUNT" == "$LOCAL_FINAL_COUNT" ]]
NEW_SERVICES_MAY_BE_RUNNING=0
trap - EXIT
```

Do not execute the recorded routing-forward command unless this entire block
exits zero. Thus a failed JSON, numeric-count, checksum, ownership, mode,
service-start, loopback-health, or post-start count gate cannot be masked by a
later command. A nonzero service-start or later gate automatically attempts to
stop both new services; the explicit recovery precondition remains
authoritative.

## Failure before routing changes

If final validation fails, restore the safety copy with this strict procedure.
It validates the local copy and its records, transfers into a unique
same-directory mode-`0600` temporary file on the old filesystem, validates the
temporary file, applies the recorded numeric owner and mode, atomically
renames it over the configured path, and verifies the final destination.
An interrupted SSH transfer leaves the live old-host store untouched:

The procedure first stops and verifies inactivity of both new-host services.
Failure of that precondition aborts recovery before any old-host mutation,
restart, ingress restoration, or routing reversal.

```bash
set -euo pipefail
umask 077

NEW_HOST=production-new
: "${NEW_HOST:?}"
: "${OLD_HOST:?}"
: "${OLD_KEYS_PATH:?}"
: "${STAGING_DIR:?}"
ssh "$NEW_HOST" \
  'sudo systemctl stop mud-web-proxy caddy &&
   ! systemctl is-active --quiet mud-web-proxy &&
   ! systemctl is-active --quiet caddy'
SAFETY_STORE="$STAGING_DIR/attested-keys.pre-stop.json"
SAFETY_COUNT_RECORD="$STAGING_DIR/attested-keys.pre-stop.count"
SAFETY_SHA_RECORD="$STAGING_DIR/attested-keys.pre-stop.sha256"
SAFETY_STAT_RECORD="$STAGING_DIR/attested-keys.pre-stop.stat"
OLD_KEYS_DIR="$(dirname -- "$OLD_KEYS_PATH")"

[[ -f "$SAFETY_STORE" && ! -L "$SAFETY_STORE" ]]
jq -e 'type == "object"' "$SAFETY_STORE" >/dev/null
SAFETY_COUNT="$(jq -er 'length' "$SAFETY_STORE")"
RECORDED_SAFETY_COUNT="$(<"$SAFETY_COUNT_RECORD")"
[[ "$SAFETY_COUNT" =~ ^[0-9]+$ ]]
[[ "$RECORDED_SAFETY_COUNT" =~ ^[0-9]+$ ]]
[[ "$SAFETY_COUNT" == "$RECORDED_SAFETY_COUNT" ]]
SAFETY_SHA256="$(sha256sum "$SAFETY_STORE" | awk '{print $1}')"
RECORDED_SAFETY_SHA256="$(<"$SAFETY_SHA_RECORD")"
[[ "$SAFETY_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$RECORDED_SAFETY_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$SAFETY_SHA256" == "$RECORDED_SAFETY_SHA256" ]]
read -r OLD_KEYS_UID OLD_KEYS_GID OLD_KEYS_MODE OLD_KEYS_EXTRA \
  <"$SAFETY_STAT_RECORD"
[[ "$OLD_KEYS_UID" =~ ^[0-9]+$ ]]
[[ "$OLD_KEYS_GID" =~ ^[0-9]+$ ]]
[[ "$OLD_KEYS_MODE" =~ ^[0-7]{3,4}$ ]]
[[ -z "${OLD_KEYS_EXTRA:-}" ]]

REMOTE_RESTORE_TEMP=
cleanup() {
  if [[ -n "$REMOTE_RESTORE_TEMP" ]]; then
    ssh "$OLD_HOST" "sudo rm -f -- '$REMOTE_RESTORE_TEMP'" || true
  fi
}
trap cleanup EXIT

REMOTE_RESTORE_TEMP="$(
  ssh "$OLD_HOST" \
    "sudo mktemp -p '$OLD_KEYS_DIR' '.attested-keys.restore.XXXXXX'"
)"
[[ "$(dirname -- "$REMOTE_RESTORE_TEMP")" == "$OLD_KEYS_DIR" ]]
ssh "$OLD_HOST" \
  "sudo chmod 0600 '$REMOTE_RESTORE_TEMP' &&
   sudo tee '$REMOTE_RESTORE_TEMP' >/dev/null" \
  <"$SAFETY_STORE"

REMOTE_RESTORE_COUNT="$(
  ssh "$OLD_HOST" "sudo cat '$REMOTE_RESTORE_TEMP'" |
    jq -er 'if type == "object" then length else error("not object") end'
)"
REMOTE_RESTORE_SHA256="$(
  ssh "$OLD_HOST" "sudo cat '$REMOTE_RESTORE_TEMP'" |
    sha256sum | awk '{print $1}'
)"
[[ "$REMOTE_RESTORE_COUNT" =~ ^[0-9]+$ ]]
[[ "$REMOTE_RESTORE_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$REMOTE_RESTORE_COUNT" == "$SAFETY_COUNT" ]]
[[ "$REMOTE_RESTORE_SHA256" == "$SAFETY_SHA256" ]]

ssh "$OLD_HOST" \
  "sudo chown '$OLD_KEYS_UID:$OLD_KEYS_GID' '$REMOTE_RESTORE_TEMP' &&
   sudo chmod '$OLD_KEYS_MODE' '$REMOTE_RESTORE_TEMP' &&
   sudo mv -Tf -- '$REMOTE_RESTORE_TEMP' '$OLD_KEYS_PATH'"
REMOTE_RESTORE_TEMP=

RESTORED_COUNT="$(
  ssh "$OLD_HOST" "sudo cat '$OLD_KEYS_PATH'" |
    jq -er 'if type == "object" then length else error("not object") end'
)"
RESTORED_SHA256="$(
  ssh "$OLD_HOST" "sudo cat '$OLD_KEYS_PATH'" |
    sha256sum | awk '{print $1}'
)"
RESTORED_STAT="$(
  ssh "$OLD_HOST" "sudo stat -c '%u %g %a' '$OLD_KEYS_PATH'"
)"
[[ "$RESTORED_COUNT" =~ ^[0-9]+$ ]]
[[ "$RESTORED_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$RESTORED_COUNT" == "$SAFETY_COUNT" ]]
[[ "$RESTORED_SHA256" == "$SAFETY_SHA256" ]]
[[ "$RESTORED_STAT" == \
  "$OLD_KEYS_UID $OLD_KEYS_GID $OLD_KEYS_MODE" ]]
```

Only after the restore block exits zero, run the exact old-supervisor restart
command and exact old-ingress restoration command recorded during pre-stage,
verify old-host health, and abort the cutover window. Do this before any
routing change. Do not infer whether the legacy supervisor is PM2, systemd, or
another wrapper.

Public routing has not changed at this point.

## Acceptance

After new-host loopback health succeeds, execute the pre-recorded routing
forward command: reassign the Reserved IP or update DNS. Require all of the
following before accepting the cutover:

- public `/health` succeeds;
- WSS upgrades correctly;
- a complete MUD session succeeds;
- forwarded client attribution is correct;
- the App Attest store remains a JSON object with the unchanged final key
  count after service start; and
- an assertion from an already-registered production client succeeds. This is
  mandatory; a newly registered client does not satisfy the preservation test.

Record acceptance evidence, the final checksum/count, and the cutover
timestamp. Start the old-Droplet retention clock only after acceptance.

## Infrastructure rollback

The old Droplet is a rollback target only while it remains functional and the
reversal commands remain available in the private record. If acceptance fails
before new public traffic is served, stop the new services, run the recorded
routing reverse command if it was applied, restart the old service with its
recorded command, restore old ingress, and verify old-host health and a
complete client session.

If the new host has served public traffic, its App Attest store may contain
new registrations or higher assertion counters. Use this complete reverse
transfer before restarting the old service or reversing routing. It stops the
new proxy and waits for exit, records and validates the new store, then uses a
mode-`0600` unique temporary file in the old path's directory and the original
recorded numeric destination owner and mode. A partial transfer cannot replace
the old live file:

```bash
set -euo pipefail
umask 077

: "${NEW_HOST:?}"
: "${OLD_HOST:?}"
: "${OLD_KEYS_PATH:?}"
: "${STAGING_DIR:?}"
NEW_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
REVERSE_STORE="$STAGING_DIR/attested-keys.reverse.json"
OLD_KEYS_DIR="$(dirname -- "$OLD_KEYS_PATH")"
OLD_STAT_RECORD="$STAGING_DIR/attested-keys.pre-stop.stat"

ssh "$NEW_HOST" \
  'sudo systemctl stop mud-web-proxy &&
   if sudo systemctl is-active --quiet mud-web-proxy; then exit 1; fi'

REVERSE_LOCAL_TEMP=
REMOTE_REVERSE_TEMP=
cleanup() {
  if [[ -n "$REVERSE_LOCAL_TEMP" ]]; then
    rm -f -- "$REVERSE_LOCAL_TEMP" || true
  fi
  if [[ -n "$REMOTE_REVERSE_TEMP" ]]; then
    ssh "$OLD_HOST" "sudo rm -f -- '$REMOTE_REVERSE_TEMP'" || true
  fi
}
trap cleanup EXIT

REVERSE_LOCAL_TEMP="$(
  mktemp "$STAGING_DIR/.attested-keys.reverse.XXXXXX"
)"
chmod 0600 "$REVERSE_LOCAL_TEMP"
ssh "$NEW_HOST" "sudo cat '$NEW_KEYS_PATH'" >"$REVERSE_LOCAL_TEMP"
jq -e 'type == "object"' "$REVERSE_LOCAL_TEMP" >/dev/null
REVERSE_COUNT="$(jq -er 'length' "$REVERSE_LOCAL_TEMP")"
[[ "$REVERSE_COUNT" =~ ^[0-9]+$ ]]
REVERSE_SHA256="$(
  sha256sum "$REVERSE_LOCAL_TEMP" | awk '{print $1}'
)"
[[ "$REVERSE_SHA256" =~ ^[0-9a-f]{64}$ ]]
REVERSE_SOURCE_STAT="$(
  ssh "$NEW_HOST" "sudo stat -c '%u %g %a' '$NEW_KEYS_PATH'"
)"
read -r REVERSE_UID REVERSE_GID REVERSE_MODE REVERSE_EXTRA \
  <<<"$REVERSE_SOURCE_STAT"
[[ "$REVERSE_UID" =~ ^[0-9]+$ ]]
[[ "$REVERSE_GID" =~ ^[0-9]+$ ]]
[[ "$REVERSE_MODE" == "600" ]]
[[ -z "${REVERSE_EXTRA:-}" ]]
[[ "$(ssh "$NEW_HOST" \
  "sudo stat -c '%U:%G' '$NEW_KEYS_PATH'")" \
  == "mud-web-proxy:mud-web-proxy" ]]

mv -Tf -- "$REVERSE_LOCAL_TEMP" "$REVERSE_STORE"
REVERSE_LOCAL_TEMP=
printf '%s\n' "$REVERSE_COUNT" \
  >"$STAGING_DIR/attested-keys.reverse.count"
printf '%s\n' "$REVERSE_SHA256" \
  >"$STAGING_DIR/attested-keys.reverse.sha256"
printf '%s %s %s\n' "$REVERSE_UID" "$REVERSE_GID" "$REVERSE_MODE" \
  >"$STAGING_DIR/attested-keys.reverse.stat"
printf '%s\n' "$NEW_KEYS_PATH" \
  >"$STAGING_DIR/attested-keys.reverse.path"
chmod 0600 "$REVERSE_STORE" "$STAGING_DIR"/attested-keys.reverse.*

read -r OLD_KEYS_UID OLD_KEYS_GID OLD_KEYS_MODE OLD_KEYS_EXTRA \
  <"$OLD_STAT_RECORD"
[[ "$OLD_KEYS_UID" =~ ^[0-9]+$ ]]
[[ "$OLD_KEYS_GID" =~ ^[0-9]+$ ]]
[[ "$OLD_KEYS_MODE" =~ ^[0-7]{3,4}$ ]]
[[ -z "${OLD_KEYS_EXTRA:-}" ]]

REMOTE_REVERSE_TEMP="$(
  ssh "$OLD_HOST" \
    "sudo mktemp -p '$OLD_KEYS_DIR' '.attested-keys.reverse.XXXXXX'"
)"
[[ "$(dirname -- "$REMOTE_REVERSE_TEMP")" == "$OLD_KEYS_DIR" ]]
ssh "$OLD_HOST" \
  "sudo chmod 0600 '$REMOTE_REVERSE_TEMP' &&
   sudo tee '$REMOTE_REVERSE_TEMP' >/dev/null" \
  <"$REVERSE_STORE"

REMOTE_REVERSE_COUNT="$(
  ssh "$OLD_HOST" "sudo cat '$REMOTE_REVERSE_TEMP'" |
    jq -er 'if type == "object" then length else error("not object") end'
)"
REMOTE_REVERSE_SHA256="$(
  ssh "$OLD_HOST" "sudo cat '$REMOTE_REVERSE_TEMP'" |
    sha256sum | awk '{print $1}'
)"
[[ "$REMOTE_REVERSE_COUNT" =~ ^[0-9]+$ ]]
[[ "$REMOTE_REVERSE_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$REMOTE_REVERSE_COUNT" == "$REVERSE_COUNT" ]]
[[ "$REMOTE_REVERSE_SHA256" == "$REVERSE_SHA256" ]]

ssh "$OLD_HOST" \
  "sudo chown '$OLD_KEYS_UID:$OLD_KEYS_GID' '$REMOTE_REVERSE_TEMP' &&
   sudo chmod '$OLD_KEYS_MODE' '$REMOTE_REVERSE_TEMP' &&
   sudo mv -Tf -- '$REMOTE_REVERSE_TEMP' '$OLD_KEYS_PATH'"
REMOTE_REVERSE_TEMP=

REVERSED_FINAL_COUNT="$(
  ssh "$OLD_HOST" "sudo cat '$OLD_KEYS_PATH'" |
    jq -er 'if type == "object" then length else error("not object") end'
)"
REVERSED_FINAL_SHA256="$(
  ssh "$OLD_HOST" "sudo cat '$OLD_KEYS_PATH'" |
    sha256sum | awk '{print $1}'
)"
REVERSED_FINAL_STAT="$(
  ssh "$OLD_HOST" "sudo stat -c '%u %g %a' '$OLD_KEYS_PATH'"
)"
[[ "$REVERSED_FINAL_COUNT" =~ ^[0-9]+$ ]]
[[ "$REVERSED_FINAL_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$REVERSED_FINAL_COUNT" == "$REVERSE_COUNT" ]]
[[ "$REVERSED_FINAL_SHA256" == "$REVERSE_SHA256" ]]
[[ "$REVERSED_FINAL_STAT" == \
  "$OLD_KEYS_UID $OLD_KEYS_GID $OLD_KEYS_MODE" ]]
```

Only after this block exits zero, execute the private record's exact routing
reverse command, old-supervisor restart command, and old-ingress restoration
command, then verify old-host health and a complete client session. Do not
infer or publish those production commands.

The v3.1.0 loader accepts and re-serializes the additive `lastUsedAt` field,
so this reverse copy preserves new registrations and assertion counters
without format conversion. The private cutover record must verify that claim
against the actual rollback release before the window.

## Old-Droplet retention and deletion

The production owner retains the old Droplet for seven calendar days after
successful cutover. Only the legacy proxy service remains stopped: keep the
old Droplet powered on, with its configuration and state untouched, throughout
the retention window for fast rollback. The private record assigns the deletion
owner and retention deadline. Delete the old Droplet only when all of these
conditions hold:

1. The new deployment has remained healthy for seven days.
2. Automated and file-level backups completed successfully.
3. A file-level restore was tested.
4. No cutover incident remains open.
5. Native release-level offline rollback was exercised.

At deletion, remove the old Droplet and its residual production keys. Do not
delete or unassign a Reserved IP that has moved to the new host. Record the
deletion operator and time.
