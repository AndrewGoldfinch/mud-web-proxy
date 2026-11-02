# Move production from Ubuntu 26.04 to Debian 13

## Scope

Production runs the native systemd layout on an Ubuntu 26.04 Droplet. This
runbook moves it to a fresh Debian 13 Droplet (`debian-13-x64`). On 2026-11-02,
Ubuntu's kernel was still unpatched for CVE-2026-98432, a remotely triggerable
use-after-free in IPv4 TCP SYNACK handling (CVSS 9.8). Debian had shipped the
fix in DSA-6568-1, kernel `6.12.113-1`, on 2026-10-16.

Only the operating system and the Droplet change:

| Stays the same                                    | Changes                                   |
| ------------------------------------------------- | ----------------------------------------- |
| Release version and Bun runtime                   | Droplet, kernel, systemd 259 → 257, glibc |
| `/etc/mud-web-proxy.env` (except rotated secrets) | TLS certificate and key (reissued)        |
| Rendered `/etc/caddy/Caddyfile`                   | `mud-web-proxy` numeric UID and GID       |
| App Attest store contents                         | Secrets you choose to rotate (see below)  |

This is **not** a runtime migration. The 2026-08-02 cutover was rolled back
because it also moved from Node to Bun, nobody treated it as a runtime change,
and no rehearsal exercised App Attest under Bun. Here both sides run the same
Bun, so don't upgrade the release in the same window. Install the version
the old host runs, and upgrade later as a separate change.

This page reuses the gates in
[New-Droplet production cutover](new-droplet-cutover.md) rather than copying
them. Where it says to run a block from that runbook, run it unchanged, with
the variable values given here. Where the two disagree, this page wins for this
move, because that runbook assumes a legacy PM2 source host.

Keep production hostnames, addresses, Droplet IDs, and secret values out of
this repository, as before.

## Hard prerequisites

Don't schedule the window until all of these hold:

1. **Debian 13 host acceptance passed on real Droplets.** Run the measure and
   verify procedures in [Systemd acceptance](systemd-acceptance.md) on two
   clean `debian-13-x64` Droplets. Commit the measured
   `tests/deployment/systemd-security-baseline.json`. The committed file must
   no longer carry a `provenance` field, because that field marks the offline
   estimate used before any live run.
2. **No evidence that the old host was compromised.** It sat exposed to a
   remote root-level kernel bug, and a working exploit was reported. If logs,
   unexpected processes, unfamiliar SSH keys, or unexplained App Attest
   entries suggest an intrusion, stop. Handle it as an incident, not a move.
3. **A decision on every secret in the [rotation table](#secret-rotation).**
   Record each decision in the private record.

## Read the old host

Run this read-only block at planning time, and again at the start of the
window. Record the output in the private record.

```bash
OLD_HOST=production-old
: "${OLD_HOST:?}"
ssh "$OLD_HOST" 'sudo bash -s' <<'EOF'
set -euo pipefail
. /etc/os-release
echo "os=$ID $VERSION_ID kernel=$(uname -r)"
echo "current=$(readlink -f /opt/mud-web-proxy/current)"
echo "version=$(cat /opt/mud-web-proxy/current/VERSION)"
echo "previous=$(cat /var/lib/mud-web-proxy-deploy/previous-release)"
pid="$(systemctl show -p MainPID --value mud-web-proxy)"
echo "exe=$(readlink -f "/proc/$pid/exe")"
echo "proxy=$(systemctl is-active mud-web-proxy) caddy=$(systemctl is-active caddy)"
stat -c 'store=%u %g %a %s bytes' /var/lib/mud-web-proxy/attested-keys.json
systemctl list-unit-files 'mud-web-proxy*' --no-legend
EOF
ssh "$OLD_HOST" 'sudo cat /var/lib/mud-web-proxy/attested-keys.json' |
  jq -er '"keys=\(length)"'
```

The key count runs on the workstation, because `jq` may not be installed on
the old host.

`exe` must resolve under `/opt/mud-web-proxy/runtimes/bun/`. If it doesn't,
production isn't running the layout this page assumes. Stop and find out what
is running. That check exists because `ps` once reported the wrong runtime.

The store line should read `<uid> <gid> 600`. The UID and GID are whatever
`systemd-sysusers` picked on that host. The new host will almost certainly pick
different numbers, which is fine: every install step on the new host sets
ownership by name, and the reverse transfer uses the recorded old numbers.

## Private record

Keep the list in
[New-Droplet production cutover](new-droplet-cutover.md#private-cutover-record),
with these differences:

- **Old App Attest path:** fixed at `/var/lib/mud-web-proxy/attested-keys.json`.
- **Old supervisor and ingress commands:** these are now the standard native
  units, so this page states them. Ingress block: `systemctl stop caddy`.
  Supervisor stop: `systemctl stop mud-web-proxy`. Restart and restore:
  `systemctl start mud-web-proxy`, then `systemctl start caddy`.
- **Add:** the old host's release version, `previous-release` value, and Bun
  runtime path, as read above.
- **Add:** the exact command that moves the old Droplet onto an
  administrative-only Cloud Firewall, and the command that reverses it. See
  [Retention](#retention-and-deletion).
- **Add:** each secret-rotation decision, and who revokes the old APNS key
  and when.
- **Drop:** the `lastUsedAt` compatibility claim for a v3.1.0 rollback
  target. The rollback target is the old host running the same v4 release.

## Secret rotation

The old host's secrets were on a machine exposed to a remote root-level bug.
Without evidence of compromise this is hygiene, not a response. Rotate what is
invisible to users, and decide the rest explicitly.

| Secret                                            | Recommendation                                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TLS private key                                   | Rotated automatically. The new host's Caddy issues its own certificate. Don't copy `/var/lib/caddy` from the old host.                                                                                                   |
| APNS signing key (`APNS_KEY_PATH`, `APNS_KEY_ID`) | Rotate. Create a new key in the Apple Developer account and install it on the new host only. Revoke the old key when the old Droplet is deleted, not before: rollback runs the old host with the old key.                |
| `ADMIN_TOKEN`, `APNS_TEST_SECRET`                 | Rotate. Only operators hold them. Update anything that calls the diagnostics or push-test endpoints.                                                                                                                     |
| `PROXY_SHARED_SECRET`                             | Only when `AUTH_MODE=shared-secret` and every client holding it can be updated. Otherwise record the decision not to rotate it.                                                                                          |
| App Attest store                                  | Not a secret: it holds device public keys and counters, and it moves unchanged. A root-level intruder could have added entries, and nothing in the store tells those apart. This is the residual risk of prerequisite 2. |

## Pre-stage the new host

Before the window:

1. Create the Droplet, firewall, monitoring, prerequisites, and patching
   exactly as steps 1 to 4 of
   [Pre-stage the new host](new-droplet-cutover.md#pre-stage-the-new-host)
   describe. Use the same datacenter as the old Droplet if production uses a
   Reserved IP.
2. Confirm the running kernel carries the CVE-2026-98432 fix. Reboot first if
   `/var/run/reboot-required` exists:

   ```bash
   set -euo pipefail
   running="$(uname -v | sed -nE 's/.*Debian ([^ ]+) .*/\1/p')"
   [[ -n "$running" ]]
   dpkg --compare-versions "$running" ge 6.12.113-1
   echo "running Debian kernel $running"
   ```

3. Install the old host's `version` release, and its `previous` release when
   that value is non-empty, each with its own `.bun-version` runtime. Follow
   [Install a release](systemd.md#install-a-release). Download each bundle from
   GitHub and verify its checksum and provenance. **Never copy `/opt` from the
   old host.** The published bundle can be verified; files from an exposed
   host can't.
4. Install the identity, unit, and Caddy package as
   [Install the native operator files](systemd.md#install-the-native-operator-files)
   describes, up to the point where it renders the environment and Caddyfile.
   Skip that rendering step. Steps 5 and 6 replace it.
5. Bring the environment across through private staging, apply the rotations
   you decided on, and check that no variable was dropped. Run this from the
   administrative workstation:

   ```bash
   set -euo pipefail
   umask 077
   : "${OLD_HOST:?}"
   NEW_HOST=production-new
   STAGING_DIR="$PWD/cutover-private"
   : "${NEW_HOST:?}"
   : "${EDITOR:?}"
   mkdir -p "$STAGING_DIR"
   chmod 0700 "$STAGING_DIR"
   [[ "$(stat -c '%a' "$STAGING_DIR")" == "700" ]]

   OLD_ENV="$STAGING_DIR/mud-web-proxy.env.old"
   NEW_ENV="$STAGING_DIR/mud-web-proxy.env.new"
   ssh "$OLD_HOST" 'sudo cat /etc/mud-web-proxy.env' >"$OLD_ENV"
   cp -- "$OLD_ENV" "$NEW_ENV"
   "$EDITOR" "$NEW_ENV"   # rotated values only; change nothing else

   diff <(grep -E '^[A-Z_]+=' "$OLD_ENV" | cut -d= -f1 | sort) \
     <(grep -E '^[A-Z_]+=' "$NEW_ENV" | cut -d= -f1 | sort)

   REMOTE_TEMP="$(ssh "$NEW_HOST" 'sudo mktemp /root/.mud-web-proxy.env.XXXXXX')"
   ssh "$NEW_HOST" "sudo tee '$REMOTE_TEMP' >/dev/null" <"$NEW_ENV"
   ssh "$NEW_HOST" \
     "sudo install -o root -g mud-web-proxy -m 0640 '$REMOTE_TEMP' /etc/mud-web-proxy.env &&
      sudo rm -f -- '$REMOTE_TEMP'"
   [[ "$(ssh "$NEW_HOST" "sudo sha256sum /etc/mud-web-proxy.env" | awk '{print $1}')" \
     == "$(sha256sum "$NEW_ENV" | awk '{print $1}')" ]]
   [[ "$(ssh "$NEW_HOST" "sudo stat -c '%a %U:%G' /etc/mud-web-proxy.env")" \
     == "640 root:mud-web-proxy" ]]
   ```

   `diff` must print nothing. In particular, `TARGET_MODE`,
   `ARBITRARY_ALLOWED_PORTS`, and the App Attest settings must survive
   unchanged. See
   [Carry the target policy across unchanged](new-droplet-cutover.md#carry-the-target-policy-across-unchanged).

   If APNS is enabled, install the key file at the path `APNS_KEY_PATH` names,
   `0640 root:mud-web-proxy`. Use the new key if you rotated it. Otherwise copy
   the old file through the same staging directory.

6. Copy the old host's rendered `/etc/caddy/Caddyfile` the same way. Install it
   `0644 root:root`, run `caddy validate --config /etc/caddy/Caddyfile`, and
   leave Caddy stopped. Then run the ownership and mode check that ends
   [Install the native operator files](systemd.md#install-the-native-operator-files).
7. If the old host runs the release canary timer, install it the same way. See
   [Release canary](systemd.md#release-canary).
8. Activate the releases **without starting anything**: run only
   [Atomic current-link activation](systemd.md#atomic-current-link-activation),
   first for `previous` (an initial activation), then for `version`. The new
   host's `previous-release` then matches the old host's, and
   [Offline rollback](systemd.md#offline-rollback) works on day one. Then
   confirm that both services are still `inactive`, using the check in
   step 6 of
   [Pre-stage the new host](new-droplet-cutover.md#pre-stage-the-new-host).
9. Take the App Attest safety copy. Run
   [Take the App Attest safety copy](new-droplet-cutover.md#take-the-app-attest-safety-copy)
   with:

   ```bash
   OLD_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
   STAGING_DIR="$PWD/cutover-private"
   ```

10. Prepare routing as
    [Prepare public routing](new-droplet-cutover.md#prepare-public-routing)
    describes. A Reserved IP is strongly preferred. The new certificate is
    issued over HTTP-01, so it can't be issued until traffic for the hostname
    reaches the new host. A Reserved IP makes that a seconds-long gap. With
    DNS, the gap is at least one TTL.

## Cutover window

Announce the window. Every session disconnects.

### 1. Stop the old service first, then its edge

This order differs from the legacy runbook on purpose. v4's shutdown makes the
service unready, drains, sends clients `1001 Server restarting`, closes the
listener, and **then** flushes the App Attest store. Stopping the proxy while
Caddy is still up lets clients receive that close frame. Once the proxy is down,
nothing else writes the store.

```bash
set -euo pipefail
: "${OLD_HOST:?}"
STOP_EPOCH="$(date -u +%s)"
ssh "$OLD_HOST" \
  'sudo systemctl stop mud-web-proxy &&
   ! systemctl is-active --quiet mud-web-proxy'
# src/shutdown.ts logs `shutdown: ${reason}`, where reason is `completed` or
# `deadline`. Only `completed` guarantees the flush step ran to the end.
SHUTDOWN_LOG="$(
  ssh "$OLD_HOST" \
    "sudo journalctl -u mud-web-proxy --since '@$STOP_EPOCH' --no-pager -o cat"
)"
[[ "$SHUTDOWN_LOG" == *"shutdown: completed"* ]]
[[ "$SHUTDOWN_LOG" != *"flush attested keys failed"* ]]
ssh "$OLD_HOST" \
  'sudo systemctl stop caddy &&
   ! systemctl is-active --quiet caddy'
```

If the shutdown checks fail, the store may be missing the last few seconds of
registrations. Don't continue. Start the old service again (`systemctl start
mud-web-proxy`, then `systemctl start caddy`), confirm health, and reschedule.

### 2. Copy and install the final store

Run the post-stop copy (step 4 of
[Cutover window](new-droplet-cutover.md#cutover-window)), then the install,
start, and loopback-health block that follows it, with the same
`OLD_KEYS_PATH`, `STAGING_DIR`, and `NEW_HOST`. Skip that runbook's steps 1 to 3. The previous section replaced them.

The install block starts Caddy alongside the proxy. Caddy's first ACME attempt
fails because the hostname still routes to the old host. That is expected and
harmless, since no public traffic reaches the new host yet.

If either block exits nonzero, go to
[Failure before routing](#failure-before-routing).

### 3. Route, then let Caddy issue

Run the recorded routing-forward command. Then restart Caddy, so that it
retries issuance immediately instead of waiting out its backoff, and wait for a
publicly trusted certificate:

```bash
set -euo pipefail
: "${NEW_HOST:?}"
: "${PROXY_HOSTNAME:?}"
ssh "$NEW_HOST" 'sudo systemctl restart caddy'
for _ in $(seq 1 36); do
  curl --fail --silent --max-time 5 \
    "https://$PROXY_HOSTNAME/health" >/dev/null && break
  sleep 5
done
curl --fail --silent --show-error "https://$PROXY_HOSTNAME/health"
```

The final `curl` validates the certificate against the system trust store, so a
zero exit means real issuance, not a self-signed fallback. If it still fails
after three minutes, read `journalctl -u caddy` on the new host. The usual
causes are port 80 closed in the Cloud Firewall, or routing not having moved.
With DNS routing, pin the check to the new address with
`--resolve "$PROXY_HOSTNAME:443:<new address>"`. Caddy itself still depends on
Let's Encrypt seeing the new record.

### 4. Accept

Apply every gate in [Acceptance](new-droplet-cutover.md#acceptance) unchanged,
including `missing == 0` from
[Prove that the store actually moved](new-droplet-cutover.md#prove-that-the-store-actually-moved).
That proof matters as much here as it did before: registration stays open, so a
host with an empty store looks healthy.

Then run
[Production resource observation](new-droplet-cutover.md#production-resource-observation).
This is the first production traffic on Debian 13 and systemd 257, so treat the
24-hour reading as a gate, not paperwork.

## Failure before routing

Stop both new services and confirm they are inactive before touching the old
host:

```bash
: "${NEW_HOST:?}"
ssh "$NEW_HOST" \
  'sudo systemctl stop mud-web-proxy caddy &&
   ! systemctl is-active --quiet mud-web-proxy &&
   ! systemctl is-active --quiet caddy'
```

Unlike v3.1.0, v4 writes the store atomically and flushes it on a clean stop,
so after step 1 the old host's live file is normally intact and newer than the
safety copy. Restoring the safety copy over it would discard every registration
made since that copy. Check the live file first:

```bash
set -euo pipefail
: "${OLD_HOST:?}"
: "${STAGING_DIR:?}"
FLOOR="$(<"$STAGING_DIR/attested-keys.pre-stop.count")"
[[ "$FLOOR" =~ ^[0-9]+$ ]]
LIVE_COUNT="$(
  ssh "$OLD_HOST" 'sudo cat /var/lib/mud-web-proxy/attested-keys.json' |
    jq -er 'if type == "object" then length else error("not object") end'
)"
[[ "$LIVE_COUNT" =~ ^[0-9]+$ ]]
((LIVE_COUNT >= FLOOR)) && echo "old live store intact: $LIVE_COUNT keys"
```

- **It exits zero:** leave the file alone.
- **It fails:** run the restore block from
  [Failure before routing changes](new-droplet-cutover.md#failure-before-routing-changes)
  with `OLD_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json`.

Then on the old host run `systemctl start mud-web-proxy`, wait for
`curl --fail http://127.0.0.1:6200/health`, run `systemctl start caddy`, and
check public health and a complete session. Routing never moved, so nothing
else needs undoing.

## Rollback after routing

Rollback puts production back on the unpatched Ubuntu kernel. Use it for an
application-level failure on the new host, and plan the next attempt within
days, not weeks.

1. Run the new-host stop gate in
   [Infrastructure rollback](new-droplet-cutover.md#infrastructure-rollback).
2. If the new host served public traffic, run the reverse-transfer block from
   the same section, with `OLD_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json`.
   It restores ownership from the old host's recorded numeric UID and GID, which
   is what the old host needs.
3. If the old Droplet was already moved to the administrative-only firewall,
   reverse that first.
4. Run the routing-reverse command. On the old host run
   `systemctl enable --now mud-web-proxy`, wait for loopback health, then run
   `systemctl enable --now caddy`. The old host still holds its own valid
   certificate, so there is no TLS gap on the way back.
5. Verify public health, WSS, and a complete MUD session.

## Retention and deletion

The seven-day retention and the five deletion conditions in
[Old-Droplet retention and deletion](new-droplet-cutover.md#old-droplet-retention-and-deletion)
still apply. Two things change, because the old host is the vulnerable one:

- **Isolate it once acceptance passes.** Move the old Droplet to a Cloud
  Firewall that allows only administrative SSH, with no public 80 or 443. Then
  run `systemctl disable mud-web-proxy caddy` on it, so that a reboot during
  retention doesn't bring the old edge back on its own public address. Leave the
  Droplet powered on with its state untouched. Rollback step 4 re-enables both
  units.
- **Let Ubuntu patch it if it can.** If Ubuntu publishes the kernel fix during
  retention, unattended upgrades may install it. That is fine. Don't reboot the
  old host just to pick it up unless you need it as a rollback target.

At deletion, revoke the old APNS key if you rotated it, along with any other
rotated credential whose old value only the old host still used. Record who did
it and when.
