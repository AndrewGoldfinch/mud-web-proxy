# New-Droplet production cutover

## Scope

This runbook moves production from the legacy PM2/git-checkout host to a new
Ubuntu 26.04 LTS x64 Droplet. It consumes the native host layout in
[Native systemd deployment](systemd.md); MWP-103 supplies the verified release
and MWP-105 supplies the systemd and Caddy files. It does not convert the old
host in place.

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
   extraction, then follow its immutable-release and atomic-activation rules.
6. Semantically migrate the environment and referenced non-TLS secret files
   as described in the transfer inventory.
7. Resolve the legacy App Attest path, take the validated pre-stop safety
   copy, and record the required metadata. Defer the final copy until the old
   service is quiescent.
8. Validate new-host loopback application health, systemd configuration, and
   Caddy configuration. Do not send production traffic to the new host yet.

Record the old and new Droplet IDs, routing mechanism, releases, artifact
checksum, App Attest metadata, operator, and recorded rollback commands before
the window.

## Take the App Attest safety copy

Use encrypted administrative staging. The staging directory must be mode
`0700` and every staged file must be mode `0600`; `umask 077` below enforces
the latter for newly created files. This is the **validated pre-stop safety
copy**. Its JSON object key count is the **key-count floor**.

```bash
OLD_HOST=production-old
OLD_KEYS_PATH=/resolved/on-old-host/attested-keys.json
STAGING_DIR="$PWD/cutover-private"

umask 077
mkdir -p "$STAGING_DIR"
chmod 0700 "$STAGING_DIR"
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

If JSON validation fails, the copy may have intersected v3.1.0's
truncate-and-write window. Wait and repeat the complete copy. Never retain an
invalid safety copy. The numeric UID, GID, and mode record is the authority if
the safety copy must be restored.

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
2. Wait at least five seconds, longer than the two-second debounced save.
3. Stop the old supervisor using the exact pre-recorded command and wait for
   process exit.
4. Copy the post-stop store to private staging:

   ```bash
   FINAL_STORE="$STAGING_DIR/attested-keys.post-stop.json"
   ssh "$OLD_HOST" "sudo cat '$OLD_KEYS_PATH'" >"$FINAL_STORE"
   ```

5. Validate and compare in two phases. An invalid final file must never be
   passed to `jq 'length'`:

   ```bash
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

6. If valid, calculate and record SHA-256, the resolved source path, numeric
   owner and mode, and the post-stop count:

   ```bash
   sha256sum "$FINAL_STORE" >"$STAGING_DIR/attested-keys.post-stop.sha256"
   ssh "$OLD_HOST" "sudo stat -c '%u %g %a' '$OLD_KEYS_PATH'" \
     >"$STAGING_DIR/attested-keys.post-stop.stat"
   ```

If final validation fails, follow **Failure before routing changes**. Do not
install an invalid or smaller final store on the new host.

Install the valid final store before the first service start:

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

Before start, verify the local and remote checksums and key counts match the
valid final store, and verify the remote ownership and modes:

```bash
LOCAL_FINAL_SHA256="$(cut -d ' ' -f1 "$STAGING_DIR/attested-keys.post-stop.sha256")"
REMOTE_FINAL_SHA256="$(
  ssh "$NEW_HOST" \
    "sudo sha256sum /var/lib/mud-web-proxy/attested-keys.json | cut -d ' ' -f1"
)"
LOCAL_FINAL_COUNT="$(jq 'length' "$FINAL_STORE")"
REMOTE_FINAL_COUNT="$(
  ssh "$NEW_HOST" \
    "sudo jq 'length' /var/lib/mud-web-proxy/attested-keys.json"
)"

test "$LOCAL_FINAL_SHA256" = "$REMOTE_FINAL_SHA256"
test "$LOCAL_FINAL_COUNT" = "$REMOTE_FINAL_COUNT"
test "$(ssh "$NEW_HOST" \
  "sudo stat -c '%a %U:%G' /var/lib/mud-web-proxy/attested-keys.json")" \
  = '600 mud-web-proxy:mud-web-proxy'
```

Start the new proxy and Caddy, then require loopback health before executing
the recorded routing-forward command. After start, again require a JSON object
and the same final key count before accepting public traffic.

## Failure before routing changes

If `FINAL_STORE_VALID` is not `true`, restore the safety copy using its
recorded numeric owner and mode:

```bash
read -r OLD_KEYS_UID OLD_KEYS_GID OLD_KEYS_MODE \
  <"$STAGING_DIR/attested-keys.pre-stop.stat"
ssh "$OLD_HOST" \
  "sudo tee '$OLD_KEYS_PATH' >/dev/null &&
   sudo chown '$OLD_KEYS_UID:$OLD_KEYS_GID' '$OLD_KEYS_PATH' &&
   sudo chmod '$OLD_KEYS_MODE' '$OLD_KEYS_PATH'" \
  <"$STAGING_DIR/attested-keys.pre-stop.json"
```

Then run the exact old-supervisor restart command and exact old-ingress
restoration command recorded during pre-stage, verify old-host health, and
abort the cutover window. Do this before any routing change. Do not infer
whether the legacy supervisor is PM2, systemd, or another wrapper.

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
- an assertion from an already-registered production client succeeds when one
  is available. Do not use a new registration as the preservation test.

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
new registrations or higher assertion counters. Before restarting the old
service:

1. Stop the new proxy and wait for its state flush.
2. Validate and record the new store's SHA-256 and JSON object key count.
3. Copy the new host store back to the old host's configured path.
4. Restore the old path's original numeric ownership and mode.
5. Only then reverse public routing, restart the old service, restore old
   ingress, and verify health and a complete client session.

The v3.1.0 loader accepts and re-serializes the additive `lastUsedAt` field,
so this reverse copy preserves new registrations and assertion counters
without format conversion. The private cutover record must verify that claim
against the actual rollback release before the window.

## Old-Droplet retention and deletion

The production owner retains the stopped old Droplet for seven calendar days
after successful cutover. The private record assigns the deletion owner and
retention deadline. Delete the old Droplet only when all of these conditions
hold:

1. The new deployment has remained healthy for seven days.
2. Automated and file-level backups completed successfully.
3. A file-level restore was tested.
4. No cutover incident remains open.
5. Native release-level offline rollback was exercised.

At deletion, remove the old Droplet and its residual production keys. Do not
delete or unassign a Reserved IP that has moved to the new host. Record the
deletion operator and time.
