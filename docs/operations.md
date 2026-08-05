# Operations

Running mud-web-proxy after it is installed: what to check, what to expect
when you change it, and what to do when it refuses to start.

Installing it is [`deployment/systemd.md`](deployment/systemd.md) or
[`deployment/compose.md`](deployment/compose.md). What each setting means is
[`configuration.md`](configuration.md). Why the defaults are what they are is
[`security.md`](security.md). This document does not repeat those; it links
them, so there is one copy of each procedure to keep correct.

## Before you start

Three facts decide how you operate this service. None of them are obvious from
watching it run.

**Every restart drops every active session.** Sessions, replay buffers, and
rate-limiter windows live in process memory. There is no persistence layer and
no handover. A restart, an upgrade, and a rollback all disconnect every
connected player, and clients reconnect from scratch. Schedule changes off-peak
and expect a reconnect storm immediately afterwards — that is the system
working, not failing.

**One process is one replica.** There is no distributed coordination and no
shared quota. Running a second instance does not halve the load per instance;
it doubles every limit, because each process counts only its own sessions and
its own per-IP totals.

**The proxy dials outbound on behalf of remote clients.** What it will dial is
decided entirely by `TARGET_MODE`. Before widening it, read
[`security.md`](security.md#target-policy).

## Which deployment am I running?

| If this is true                                 | You are running | Procedures live in                               |
| ----------------------------------------------- | --------------- | ------------------------------------------------ |
| `systemctl status mud-web-proxy` returns a unit | Bun + systemd   | [`deployment/systemd.md`](deployment/systemd.md) |
| `docker compose ps` lists `proxy` and `caddy`   | Docker Compose  | [`deployment/compose.md`](deployment/compose.md) |

Both put Caddy in front. Caddy terminates public HTTPS/WSS; the application
itself listens plaintext, on loopback under systemd and on an internal Docker
network under Compose. If you are exposing the application directly instead,
that is a third topology and `INBOUND_TLS_MODE=required` applies to it.

## Health and diagnostics

`/health` is unauthenticated and always available. Observed responses:

| State    | Status | Body                                           |
| -------- | ------ | ---------------------------------------------- |
| Serving  | `200`  | `{"status":"healthy","version":"4.0.0-rc.9"}`  |
| Draining | `503`  | `{"status":"draining","version":"4.0.0-rc.9"}` |

`version` is the package version of the running build — the one thing that
tells you which release is actually live, as opposed to which one you think you
deployed. Check it after every upgrade and every rollback.

The `503` appears the moment shutdown begins and persists through the drain, so
a load balancer or uptime check sees the instance leave rotation before
connections close. Shutdown then runs in a fixed order, each step logged:

```
shutdown: close client connections
shutdown: close telnet sockets and sessions
shutdown: close listener
shutdown: flush attested keys
shutdown: completed
```

If you see `shutdown: completed` you lost nothing that was flushable. If the
process was killed before it, attested-key registrations since the last flush
are gone.

**Diagnostics are a separate thing and are off by default.** `ENABLE_DIAGNOSTICS`
turns them on and `ADMIN_TOKEN` is then required on every request; there is no
unauthenticated diagnostic surface. Leave them off unless you are actively
investigating, and unset the token afterwards.

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

**Compose.** Both services use the `json-file` driver, capped in `compose.yaml`
at `max-size: 10m` and `max-file: 5` — about 50 MB per service, then oldest-out.

```bash
docker compose logs -f proxy
docker compose logs --since 1h caddy
```

That cap is deliberate. The default `json-file` configuration keeps every byte
forever, and filling the host disk with logs is the most common way a small
self-hosted deployment dies, months after anyone last touched it.

**What is and is not recorded.** `LOG_LEVEL` defaults to `info` and accepts
`debug`, `warn`, and `error`. Configured secrets are redacted wherever they
appear, and hostile control sequences in client-supplied values are neutralised
before writing, so a malicious target hostname cannot forge log lines. Player
input is logged by byte count, never content — password-mode detection is
best-effort, so the shape is logged rather than the keystrokes. `LOG_LEVEL=debug`
adds message shape and field-level diagnostics; it does not add message content.

## Certificate renewal

Caddy obtains and renews certificates automatically. You do not run a renewal
command; you make sure Caddy can still do its job.

**What must survive.** Under Compose, issued certificates and the ACME account
key live in the `caddy_data` named volume. Under systemd, they live in Caddy's
own data directory. Lose either and Caddy re-issues from scratch on next start,
which counts against Let's Encrypt rate limits — the failure mode is not "no
certificate now", it is "no certificate for a week" if you trip the limit while
debugging.

**When renewal fails, check in this order:**

1. Is inbound TCP 80 reachable from the internet? The HTTP-01 challenge needs
   it even though your traffic is on 443. A firewall rule allowing only 443 is
   the most common cause.
2. Does the domain still resolve to this host? A moved A record fails renewal
   silently, weeks before the certificate actually expires.
3. Is the data volume or directory intact and writable?
4. `docker compose logs caddy` or `journalctl -u caddy` — Caddy states the ACME
   error plainly.

Set an expiry alert rather than relying on noticing. A renewal that has been
failing for sixty days looks identical to a healthy one right up until it does
not.

## Routine changes

Both paths have a procedure already written; this section states only what
those procedures assume you know.

**Every upgrade and every rollback drops all active sessions.** There is no
drain-and-handover. The `/health` `version` field is how you confirm which
build is live afterwards.

- **systemd** — the atomic `current` symlink swap, with offline rollback to the
  retained previous release: [`deployment/systemd.md`](deployment/systemd.md#atomic-current-link-activation).
- **Compose** — pin by digest and re-pin to upgrade:
  [`deployment/images.md`](deployment/images.md#upgrading-a-pinned-deployment).

Configuration changes need a restart to take effect: every setting is read once
at startup. An invalid value aborts the process rather than being ignored, so a
bad edit takes the service down at restart, not silently at some later point.
Validate before restarting, on the host, with the service's own environment:

```bash
# systemd — parse the real env file without starting the listener
sudo -u mud-web-proxy env $(grep -v '^#' /etc/mud-web-proxy.env | xargs) \
  WS_PORT=0 bun /opt/mud-web-proxy/current/dist/wsproxy.js
```

A clean startup line means the configuration parses; `Ctrl-C` and restart
normally. A `Configuration errors:` block means see [Troubleshooting](#troubleshooting).

## Backup and restore

What to back up and what is disposable is enumerated in
[`deployment/systemd.md`](deployment/systemd.md#backup-required-and-disposable-data).
In short: the environment file, APNS key material, App Attest state, and the
retained previous release. Everything else is rebuildable.

Two things that document states and that are easy to skip:

- **Take a file-level backup before every upgrade**, not only daily. The
  upgrade is when you need it.
- **Provider snapshots are a machine-recovery layer, not a backup.** They
  restore a host; they do not give you a file back.

**Test the restore.** An untested restore procedure is a guess. Restore onto a
throwaway host, start the service, and confirm `/health` reports the expected
`version` — not merely that files appeared.

## Capacity and sizing

The defaults are conservative and the measured production profile is well
inside them. From 24 hours of real traffic on a 1 GB droplet:

| Resource         | Observed        | Limit              |
| ---------------- | --------------- | ------------------ |
| Memory           | 139 MB peak 153 | `MemoryHigh=384M`  |
| File descriptors | 13              | `LimitNOFILE=1024` |
| Tasks            | 4               | 128                |

`memory.events` was entirely zero — no `high` pressure events at all. The
descriptor budget was sized assuming 200 sessions at four descriptors each and
real concurrency never approached it.

Sizing follows from three settings, all in [`configuration.md`](configuration.md):

- `MAX_SESSIONS_GLOBAL` is **unset by default**, meaning no global bound. Per-IP
  limits do not constrain a distributed client population, so set this in
  production to whatever your host can actually hold.
- `OUTPUT_BUFFER_BYTES` (default 51200) is per session. Multiply it by your
  expected concurrent sessions for the replay-history floor.
- `MAX_SESSIONS_PER_IP` (default 10) and `MAX_SESSIONS_PER_DEVICE` (default 5)
  bound one client, not the service.

Raising a limit is a decision about what you are willing to absorb; each one's
tradeoff is stated in [`security.md`](security.md#resource-limits).

## Troubleshooting

### Startup refuses

Every setting is validated at startup and an invalid one aborts the process.
Failures are reported together under a `Configuration errors:` header, so fix
all listed lines before restarting rather than one at a time.

Each message below is the literal text the process prints.

**Retired settings.** These were removed; the process refuses rather than
ignoring them, because silently ignoring a security setting is how a protection
disappears unnoticed.

| Message begins                                         | Remedy                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `ONLY_ALLOW_DEFAULT_SERVER has been removed.`          | Use `TARGET_MODE=fixed` (the default) for one target, or `allowlist`/`arbitrary`.           |
| `DISABLE_TLS has been removed.`                        | Use `INBOUND_TLS_MODE=off`, which is permitted only when `BIND_HOST` is loopback.           |
| `ALLOW_INSECURE_PRODUCTION_NO_TLS has been removed.`   | Use `INBOUND_TLS_MODE=off` (loopback only) or `required` with valid material.               |
| `TRUST_PROXY has been renamed to TRUSTED_PROXY_CIDRS.` | Rename it. The old name is not honoured.                                                    |
| `ALLOW_MTLS_FALLBACK has been removed.`                | Client certificates are gone. Use `AUTH_MODE=shared-secret` for clients that cannot attest. |
| `MTLS_CLIENT_CA_PATH has been removed`                 | Remove it; the proxy no longer requests client certificates.                                |

**Target policy.**

| Message                                                                                         | Cause and remedy                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `TARGET_MODE=allowlist requires ALLOWED_TARGETS to contain at least one valid host:port entry.` | The list is empty or every entry is unparseable. Note malformed entries are _ignored_, so one typo can empty a list that looks populated. |
| `TARGET_MODE=arbitrary requires ARBITRARY_ALLOWED_PORTS to be set`                              | Set the allowed ports, for example `23,4000-4100`.                                                                                        |
| `TARGET_MODE=arbitrary requires AUTH_MODE=shared-secret or REQUIRE_APP_AUTH=true.`              | Arbitrary mode without authentication is an open relay. Enable one, or use a narrower `TARGET_MODE`.                                      |

**Authentication.**

| Message                                                           | Cause and remedy                                                                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_MODE=shared-secret requires PROXY_SHARED_SECRET to be set.` | Set the secret.                                                                                                                                                                                          |
| `PROXY_SHARED_SECRET must be at least 32 UTF-16 code units`       | The message reports the current length. Generate a longer one.                                                                                                                                           |
| `REQUIRE_APP_AUTH=true requires App Attest to be configured.`     | Set `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID`, or unset `REQUIRE_APP_AUTH`.                                                                                                                          |
| `App Attest is partially configured:`                             | One identifier is set and the other is missing. Set both, or neither.                                                                                                                                    |
| `App Attest is enabled but its state directory is not writable:`  | Registrations would be accepted and lost on first flush. Under Docker mount a writable volume at the **directory**, never at `attested-keys.json` inside it. Natively, fix the service user's ownership. |

**Listener and TLS.**

| Message                                                                                         | Cause and remedy                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INBOUND_TLS_MODE=off on BIND_HOST=… is not allowed without explicit acknowledgement.`          | You are serving plaintext on a non-loopback address. Either put Caddy in front and bind loopback, or set `ALLOW_INSECURE_INBOUND_NO_TLS=true` deliberately, or use `INBOUND_TLS_MODE=required`. |
| `TLS certificate not found at …` / `TLS key not found at …`                                     | Path is wrong or the file is absent. Both must exist under `required`.                                                                                                                          |
| `TLS certificate at … is not a valid certificate:` / `TLS key at … is not a valid private key:` | Malformed or empty PEM. An empty file gives the same `NO_START_LINE` error as a corrupt one.                                                                                                    |
| `TLS key at … could not be read:`                                                               | Permissions. The service user must be able to read it.                                                                                                                                          |
| `TLS certificate at … does not match the private key at …`                                      | Mismatched pair — usually a half-finished renewal that replaced one file.                                                                                                                       |

**Limits.**

| Message                                                                           | Cause and remedy                                                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `MAX_SESSIONS_GLOBAL must be a positive integer when set`                         | `0` is not "unlimited". Leave it unset for no global bound.                                                    |
| `WS_HEARTBEAT_TIMEOUT_MS (…) must be greater than WS_HEARTBEAT_INTERVAL_MS (…)`   | Otherwise every peer is reclaimed before it can answer a ping.                                                 |
| `MAX_MESSAGES_PER_SECOND_PER_IP (…) must be at least MAX_MESSAGES_PER_SECOND (…)` | Otherwise one connection can never reach its own allowance and the per-connection limit is dead configuration. |

**Origins and proxies.**

| Message                                         | Cause and remedy                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS contains "*" wildcard.`        | Wildcards are refused. List exact origins. Leaving the variable unset applies no restriction at all. |
| `ALLOWED_ORIGINS contains malformed entry "…".` | Expected scheme, host, and optional port, e.g. `https://app.example.com:8443`.                       |
| `TRUSTED_PROXY_CIDRS contains invalid entry: …` | Expected addresses or CIDR ranges, or `true`/`false`.                                                |

### It started, but something is wrong

| Symptom                                                                    | Likely cause                                                                                                                                   | What to do                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Every client shares one apparent IP; per-IP limits trip almost immediately | `TRUSTED_PROXY_CIDRS` is unset behind a reverse proxy, so the proxy sees only Caddy's address                                                  | Set it to the proxy's address exactly — `127.0.0.1` for systemd, `172.28.0.0/24` for Compose. Never `true`.                    |
| Clients are rejected with a target message they did not expect             | `TARGET_MODE` is narrower than the client assumes, or an `ALLOWED_TARGETS` typo silently dropped an entry                                      | Malformed allowlist entries are ignored, not reported. Re-read the list character by character.                                |
| Upstream connections fail only under `MUD_TLS_MODE=required`               | The MUD's certificate is not trusted by the runtime CA store. Most MUDs are self-signed                                                        | There is no custom-CA or pinning setting. Either the MUD gets a trusted certificate, or use `prefer` and accept the downgrade. |
| Traffic is plaintext upstream despite `MUD_TLS_MODE=prefer`                | `prefer` falls back on negotiation failure, peer close, a 4-second handshake deadline, **or certificate validation failure** — the common case | Expected behaviour. The downgrade is logged at WARN with its reason. Use `required` to refuse it.                              |
| All players disconnect at once, then reconnect                             | The process restarted. Sessions are memory-local                                                                                               | Confirm with `/health` `version` and the journal. This is not a bug.                                                           |
| `/health` returns `503` and stays there                                    | Shutdown began and did not finish, or the process is wedged mid-drain                                                                          | Check for `shutdown: completed`. If absent past the deadline, the supervisor will kill it; investigate what blocked.           |
| Certificate expired without warning                                        | Renewal has been failing silently                                                                                                              | See [Certificate renewal](#certificate-renewal). Check port 80 reachability first.                                             |
| Diagnostics endpoints return 401                                           | `ENABLE_DIAGNOSTICS` is on but `ADMIN_TOKEN` was not sent, or is wrong                                                                         | There is no unauthenticated diagnostic surface by design.                                                                      |
