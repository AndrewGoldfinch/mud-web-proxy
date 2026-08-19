# Operations

This document covers running mud-web-proxy after installation: what to check,
what to expect when you change it, and what to do when it refuses to start.

For installation, see [Native systemd deployment](deployment/systemd.md) or
[Docker Compose deployment](deployment/compose.md). For what each setting
means, see the [Configuration reference](configuration.md). For why the
defaults are what they are, see
[Security model and threat model](security.md). This document doesn't repeat
those, it links to them, so that there is one copy of each procedure to keep
correct.

## Before you start

Three facts decide how you operate this service. None of them are obvious from
watching it run.

**Every restart drops every active session.** Sessions, replay buffers, and
rate-limiter windows live in process memory. There is no persistence layer and
no handover. A restart, an upgrade, and a rollback all disconnect every
connected player, and clients reconnect from scratch. Schedule changes off-peak
and expect a reconnect storm immediately afterward. That storm is the system
working, not failing.

**One process is one replica.** There is no distributed coordination and no
shared quota. Running a second instance does not halve the load per instance;
it doubles every limit, because each process counts only its own sessions and
its own per-IP totals.

**The proxy dials outbound on behalf of remote clients.** `TARGET_MODE` alone
determines what it dials. Before you widen it, see
[Target policy](security.md#target-policy).

## Which deployment are you running?

| If this is true                                 | You are running | Procedures live in                                 |
| ----------------------------------------------- | --------------- | -------------------------------------------------- |
| `systemctl status mud-web-proxy` returns a unit | Bun and systemd | [Native systemd deployment](deployment/systemd.md) |
| `docker compose ps` lists `proxy` and `caddy`   | Docker Compose  | [Docker Compose deployment](deployment/compose.md) |

Both put Caddy in front. Caddy terminates public HTTPS and WSS; the application
itself listens plaintext, on loopback under systemd and on an internal Docker
network under Compose. If you are exposing the application directly instead,
that is a third topology and `INBOUND_TLS_MODE=required` applies to it.

## Health and diagnostics

`/health` is unauthenticated and always available. It returns the following
responses:

| State    | Status | Body                                          |
| -------- | ------ | --------------------------------------------- |
| Serving  | `200`  | `{"status":"healthy","version":"<version>"}`  |
| Draining | `503`  | `{"status":"draining","version":"<version>"}` |

`version` is the package version of the running build—the one thing that
tells you which release is actually live, as opposed to which one you think you
deployed. Check it after every upgrade and every rollback. Verified: swapping
the `current` symlink and restarting moves this field, and rolling back moves
it straight back.

One caveat is worth knowing. The build compiles the value into the
`dist/wsproxy.js` file at build time; the proxy doesn't read it from the
release directory's name or from its `package.json` file at startup. For a
correctly released bundle those always agree, because the release workflow
builds immediately before packaging. They can disagree if someone
hand-assembles a release directory or repackages a stale `dist/` directory,
and then `/health` reports the wrong version. If the version looks wrong after
an upgrade, check what is inside the bundle before you suspect the symlink:

```bash
grep -o '4\.0\.0[^"]*' /opt/mud-web-proxy/current/dist/wsproxy.js | head -1
```

The `503` appears the moment shutdown begins and persists through the drain, so
a load balancer or uptime check observes the instance leaving rotation before
connections close. Shutdown then runs in a fixed order, each step logged:

```
shutdown: close client connections
shutdown: close telnet sockets and sessions
shutdown: close listener
shutdown: flush attested keys
shutdown: completed
```

If you see `shutdown: completed`, you lost nothing that was flushable. If the
process ended before that line, attested-key registrations since the last
flush are gone.

**Diagnostics are separate, and they are off by default.** `ENABLE_DIAGNOSTICS`
turns them on, and every request then requires `ADMIN_TOKEN`. There is no
unauthenticated diagnostic surface. Leave diagnostics off unless you are
actively investigating, and unset the token afterward.

## Logs

**systemd.** Everything goes to the journal.

```bash
journalctl -u mud-web-proxy -f              # follow
journalctl -u mud-web-proxy --since '1 hour ago'
journalctl -u mud-web-proxy -p warning      # warnings and worse
```

Rotation and retention are the journal's, not the application's. The
application never writes its own log file, so there is nothing to rotate and
no logrotate config to install. If the journal is consuming too much disk, cap
it in `/etc/systemd/journald.conf` with `SystemMaxUse=`, then
`systemctl restart systemd-journald`.

**Compose.** Both services use the `json-file` driver, capped in the
`compose.yaml` file at `max-size: 10m` and `max-file: 5`. That gives about
50 MB per service, after which the oldest file is removed.

```bash
docker compose logs -f proxy
docker compose logs --since 1h caddy
```

That cap is deliberate. The default `json-file` configuration keeps every byte
forever, and filling the host disk with logs is the most common way a small
self-hosted deployment fails, months after anyone last touched it.

**What is and is not recorded.** `LOG_LEVEL` defaults to `info` and accepts
`debug`, `warn`, and `error`. Configured secrets are redacted wherever they
appear, and hostile control sequences in client-supplied values are neutralized
before writing, so a malicious target hostname can't forge log lines. Player
input is logged by byte count, never content—password-mode detection is
best-effort, so the shape is logged rather than the keystrokes. `LOG_LEVEL=debug`
adds message shape and field-level diagnostics; it does not add message content.

## Certificate renewal

Caddy obtains and renews certificates automatically. You don't run a renewal
command. Instead, you make sure that Caddy can still reach what it needs.

**What must survive.** Under Compose, issued certificates and the ACME account
key live in the `caddy_data` named volume. Under systemd, they live in Caddy's
own data directory. Lose either and Caddy re-issues from scratch on next start,
which counts against Let's Encrypt rate limits—the failure mode is not "no
certificate now", it is "no certificate for a week" if you trip the limit while
debugging.

**When renewal fails, check in this order:**

1. Check that inbound TCP port 80 is reachable from the internet. The HTTP-01
   challenge needs it even though your traffic is on 443. A firewall rule that
   allows only 443 is the most common cause.
2. Check that the domain still resolves to this host. A moved A record fails
   renewal silently, weeks before the certificate expires.
3. Check that the data volume or directory is intact and writable.
4. Run `docker compose logs caddy` or `journalctl -u caddy`. Caddy states the
   ACME error plainly.

Set an expiry alert rather than relying on someone noticing. A renewal that has
been failing for 60 days looks identical to a healthy one, right up until it
doesn't.

## Routine changes

Both paths have a procedure already written; this section states only what
those procedures assume you know.

**Every upgrade and every rollback drops all active sessions.** There is no
drain-and-handover. The `/health` `version` field is how you confirm which
build is live afterwards.

- **systemd**: the atomic `current` symlink swap, with offline rollback to the
  retained previous release. See
  [Atomic current-link activation](deployment/systemd.md#atomic-current-link-activation).
- **Compose**: pin by digest, and re-pin to upgrade. See
  [Upgrade a pinned deployment](deployment/images.md#upgrade-a-pinned-deployment).

Configuration changes need a restart to take effect: every setting is read once
at startup. An invalid value aborts the process rather than being ignored, so a
bad edit takes the service down at restart, not silently at some later point.
Validate before restarting, on the host, with the service's own environment:

```bash
# systemd — parse the real env file without starting the listener
sudo -u mud-web-proxy env $(grep -v '^#' /etc/mud-web-proxy.env | xargs) \
  WS_PORT=0 bun /opt/mud-web-proxy/current/dist/wsproxy.js
```

A clean startup line means that the configuration parses. Press `Ctrl-C` and
restart normally. If you get a `Configuration errors:` block, see
[Troubleshooting](#troubleshooting).

## Backup and restore

For what to back up and what is disposable, see
[Backup-required and disposable data](deployment/systemd.md#backup-required-and-disposable-data).
In short: the environment file, APNS key material, App Attest state, and the
retained previous release. Everything else is rebuildable.

That document states two things that are often skipped:

- **Take a file-level backup before every upgrade**, not only daily. The
  upgrade is when you need it.
- **Provider snapshots are a machine-recovery layer, not a backup.** They
  restore a host; they don't give you a file back.

**Test the restore.** An untested restore procedure is a guess. Restore onto a
throwaway host, start the service, and confirm `/health` reports the expected
`version`—not merely that files appeared.

## Capacity and sizing

The defaults are conservative, and the measured production profile sits well
inside them. The following figures come from 24 hours of real traffic on a
1 GB droplet:

| Resource         | Observed                    | Limit              |
| ---------------- | --------------------------- | ------------------ |
| Memory           | 139 MB average, 153 MB peak | `MemoryHigh=384M`  |
| File descriptors | 13                          | `LimitNOFILE=1024` |
| Tasks            | 4                           | 128                |

`memory.events` was entirely zero, with no `high` pressure events at all. The
descriptor budget assumed 200 sessions at four descriptors each, and real
concurrency never approached it.

Sizing follows from three settings, all of them in the
[Configuration reference](configuration.md):

- `MAX_SESSIONS_GLOBAL` is unset by default, which means no global bound. Per-IP
  limits don't constrain a distributed client population, so set this variable
  in production to whatever your host can hold.
- `OUTPUT_BUFFER_BYTES`, default `51200`, is per session. Multiply it by your
  expected concurrent sessions for the replay-history floor.
- `MAX_SESSIONS_PER_IP`, default `10`, and `MAX_SESSIONS_PER_DEVICE`, default
  `5`, bound one client, not the service.

Raising a limit is a decision about what you are willing to absorb. Each
tradeoff is stated in [Resource limits](security.md#resource-limits).

## Troubleshooting

### Startup refuses

Every setting is validated at startup and an invalid one aborts the process.
The proxy reports failures together under a `Configuration errors:` header, so
fix every listed line before you restart rather than one at a time.

**Two things mislead you before you even read the message.**

_The unit reports `activating`, not `failed`._ systemd restarts the service on
failure, so it cycles rather than settling. `systemctl is-active` answering
`activating` after a config change means the process is aborting and being
restarted, not that it is slow to come up.

_An unanchored `journalctl` shows you the previous attempt._ While the unit is
restart-looping the journal holds every failed start, so `--since '1 min ago'`
returns the error you already fixed, and you conclude that the fix didn't
work. Anchor to one invocation:

```bash
systemctl stop mud-web-proxy
CUR=$(journalctl -u mud-web-proxy -n 0 --show-cursor -q | sed -n 's/^-- cursor: //p')
systemctl start mud-web-proxy; sleep 3
journalctl -u mud-web-proxy --after-cursor "$CUR" -o cat
```

Each message in the following tables is the literal text that the process
prints.

**Retired settings.** These settings were removed. The process refuses to start
rather than ignoring them, because silently ignoring a security setting is how
a protection disappears unnoticed.

| Message begins                                         | Remedy                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `ONLY_ALLOW_DEFAULT_SERVER has been removed.`          | Use `TARGET_MODE=fixed` (the default) for one target, or `allowlist` or `arbitrary`.       |
| `DISABLE_TLS has been removed.`                        | Use `INBOUND_TLS_MODE=off`, which is permitted only when `BIND_HOST` is loopback.          |
| `ALLOW_INSECURE_PRODUCTION_NO_TLS has been removed.`   | Use `INBOUND_TLS_MODE=off` (loopback only) or `required` with valid material.              |
| `TRUST_PROXY has been renamed to TRUSTED_PROXY_CIDRS.` | Rename it. The old name is not honored.                                                    |
| `ALLOW_MTLS_FALLBACK has been removed.`                | Client certificates are gone. Use `AUTH_MODE=shared-secret` for clients that can't attest. |
| `MTLS_CLIENT_CA_PATH has been removed`                 | Remove it; the proxy no longer requests client certificates.                               |

**Target policy.**

| Message                                                                                         | Cause and remedy                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `TARGET_MODE=allowlist requires ALLOWED_TARGETS to contain at least one valid host:port entry.` | The list is empty or every entry is unparseable. Note that malformed entries are _ignored_, so one typo can empty a list that looks populated. |
| `TARGET_MODE=arbitrary requires ARBITRARY_ALLOWED_PORTS to be set`                              | Set the allowed ports, for example `23,4000-4100`.                                                                                             |
| `TARGET_MODE=arbitrary requires AUTH_MODE=shared-secret or REQUIRE_APP_AUTH=true.`              | Arbitrary mode without authentication is an open relay. Enable one, or use a narrower `TARGET_MODE`.                                           |

**Authentication.**

| Message                                                           | Cause and remedy                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_MODE=shared-secret requires PROXY_SHARED_SECRET to be set.` | Set the secret.                                                                                                                                                                                                        |
| `PROXY_SHARED_SECRET must be at least 32 UTF-16 code units`       | The message reports the current length. Generate a longer one.                                                                                                                                                         |
| `REQUIRE_APP_AUTH=true requires App Attest to be configured.`     | Set `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID`, or unset `REQUIRE_APP_AUTH`.                                                                                                                                        |
| `App Attest is partially configured:`                             | One identifier is set and the other is missing. Set both, or neither.                                                                                                                                                  |
| `App Attest is enabled but its state directory is not writable:`  | The proxy accepts registrations and then loses them on the first flush. Under Docker, mount a writable volume at the _directory_, never at `attested-keys.json` inside it. Natively, fix the service user's ownership. |

**Listener and TLS.**

| Message                                                                                         | Cause and remedy                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INBOUND_TLS_MODE=off on BIND_HOST=… is not allowed without explicit acknowledgement.`          | You are serving plaintext on a non-loopback address. Either put Caddy in front and bind loopback, or set `ALLOW_INSECURE_INBOUND_NO_TLS=true` deliberately, or use `INBOUND_TLS_MODE=required`. |
| `TLS certificate not found at …` / `TLS key not found at …`                                     | `TLS_CERT_PATH` or `TLS_KEY_PATH` is wrong, or the file is absent. Both must exist under `required`.                                                                                            |
| `TLS certificate at … is not a valid certificate:` / `TLS key at … is not a valid private key:` | Malformed or empty PEM. An empty file gives the same `NO_START_LINE` error as a corrupt one.                                                                                                    |
| `TLS key at … could not be read:`                                                               | Permissions. The service user must be able to read it.                                                                                                                                          |
| `TLS certificate at … does not match the private key at …`                                      | Mismatched pair—usually a half-finished renewal that replaced one file.                                                                                                                         |

**Limits.**

| Message                                                                           | Cause and remedy                                                                                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_SESSIONS_GLOBAL must be a positive integer when set`                         | `0` is not "unlimited". Leave it unset for no global bound.                                                                                 |
| `WS_HEARTBEAT_TIMEOUT_MS (…) must be greater than WS_HEARTBEAT_INTERVAL_MS (…)`   | Otherwise every peer is reclaimed before it can answer a ping.                                                                              |
| `MAX_MESSAGES_PER_SECOND_PER_IP (…) must be at least MAX_MESSAGES_PER_SECOND (…)` | Otherwise one connection can never reach its own allowance and the per-connection limit is dead configuration.                              |
| `SHUTDOWN_DEADLINE_MS (…) must be greater than SHUTDOWN_GRACE_MS (…)`             | Otherwise the absolute deadline expires during the drain and no connection closes cleanly. Raise the deadline, or shorten the grace period. |

**Origins and proxies.**

| Message                                         | Cause and remedy                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS contains "*" wildcard.`        | Wildcards are refused. List exact origins. Leaving the variable unset applies no restriction at all. |
| `ALLOWED_ORIGINS contains malformed entry "…".` | Expected a scheme, a host, and an optional port, for example `https://app.example.com:8443`.         |
| `TRUSTED_PROXY_CIDRS contains invalid entry: …` | Expected addresses or CIDR ranges, or `true` or `false`.                                             |

### It started, but something is wrong

| Symptom                                                                    | Likely cause                                                                                                                                         | What to do                                                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Every client shares one apparent IP; per-IP limits trip almost immediately | `TRUSTED_PROXY_CIDRS` is unset behind a reverse proxy, so the proxy observes only Caddy's address                                                    | Set it to the proxy's address exactly—`127.0.0.1` for systemd, `172.28.0.0/24` for Compose. Never `true`.                                 |
| Clients are rejected with a target message they didn't expect              | `TARGET_MODE` is narrower than the client assumes, or an `ALLOWED_TARGETS` typo silently dropped an entry                                            | Malformed allowlist entries are ignored, not reported. Re-read the list character by character.                                           |
| Upstream connections fail only under `MUD_TLS_MODE=required`               | The runtime CA store doesn't trust the MUD's certificate. Most MUDs are self-signed                                                                  | There is no custom-CA or pinning setting. Either get a trusted certificate for the MUD, or use `prefer` and accept the downgrade.         |
| Traffic is plaintext upstream despite `MUD_TLS_MODE=prefer`                | `prefer` falls back on negotiation failure, peer close, a 4-second handshake deadline, or _certificate validation failure_, which is the common case | Expected behavior. The downgrade is logged at WARN with its reason. Use `required` to refuse it.                                          |
| All players disconnect at once, then reconnect                             | The process restarted. Sessions are memory-local                                                                                                     | Confirm with the `/health` `version` field and the journal. This behavior is not a bug.                                                   |
| `/health` returns `503` and stays there                                    | Shutdown began and did not finish, or the process is wedged mid-drain                                                                                | Check for `shutdown: completed`. If it is absent past the deadline, the supervisor stops the process. Investigate what blocked the drain. |
| Certificate expired without warning                                        | Renewal has been failing silently                                                                                                                    | See [Certificate renewal](#certificate-renewal). Check port 80 reachability first.                                                        |
| Diagnostics endpoints return 401                                           | `ENABLE_DIAGNOSTICS` is on, but `ADMIN_TOKEN` wasn't sent, or is wrong                                                                               | There is no unauthenticated diagnostic surface by design.                                                                                 |
