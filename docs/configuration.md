# Configuration reference

Every setting is an environment variable, read once at startup in
[`src/runtime-config.ts`](../src/runtime-config.ts). Except where explicitly
noted, parsing is strict: a value that is present but unparseable aborts the
process rather than falling back to the default, and a retired variable aborts
with the name of its replacement. Nothing is re-read while the process runs, so
a change requires a restart.

Defaults below are the values the proxy uses when the variable is unset. They
are the ones in `src/runtime-config.ts`; `scripts/check-config-docs.ts` fails
CI when a variable exists there and not here, so this list cannot silently fall
behind the code. It can still fall behind on _description_ — if a default here
disagrees with the source, the source is right.

The background-push values are the exception to where the default is applied:
the parser leaves an unset runtime value unset, and the scheduler then uses the
documented value as its default.

Boolean variables accept `1`, `true`, `yes`, `on` and `0`, `false`, `no`, `off`,
case-insensitively. Anything else is a startup error.

## Listener

| Variable    | Type    | Default     | Required when | Description                              |
| ----------- | ------- | ----------- | ------------- | ---------------------------------------- |
| `BIND_HOST` | string  | `127.0.0.1` | Never         | Address the WebSocket listener binds to. |
| `WS_PORT`   | integer | `6200`      | Never         | Port the WebSocket listener binds to.    |

Binding to loopback and terminating TLS in a reverse proxy is the supported
production layout. `BIND_HOST` is also the signal that decides whether a
plaintext listener needs acknowledgement — see `ALLOW_INSECURE_INBOUND_NO_TLS`.

## Inbound TLS

| Variable                        | Type                | Default         | Required when                                       | Description                                                                                      |
| ------------------------------- | ------------------- | --------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `INBOUND_TLS_MODE`              | `required` or `off` | `required`      | Never                                               | Controls whether the listener requires TLS or serves plaintext.                                  |
| `TLS_CERT_PATH`                 | path                | `./cert.pem`    | `INBOUND_TLS_MODE=required`                         | Certificate path.                                                                                |
| `TLS_KEY_PATH`                  | path                | `./privkey.pem` | `INBOUND_TLS_MODE=required`                         | Private-key path.                                                                                |
| `ALLOW_INSECURE_INBOUND_NO_TLS` | boolean             | `false`         | Must be `true` for plaintext on a non-loopback bind | Explicitly acknowledges that plaintext exposes credentials unless a trusted edge terminates TLS. |

The certificate and key are checked as a pair at startup, not merely for
existence: a certificate renewed without its key is readable, present, and
fails at the first handshake, which turns an operator error into an outage.

When the process is started from its own `dist` directory and neither path is
set explicitly, the parent directory is searched — a compiled server keeps its
certificates beside the project, not beside the bundle. An explicit path is
never second-guessed.

## Telnet target and target policy

| Variable                  | Type                                 | Default             | Required when           | Description                                                                 |
| ------------------------- | ------------------------------------ | ------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `TN_HOST`                 | hostname                             | `muds.maldorne.org` | Never                   | Default upstream host.                                                      |
| `TN_PORT`                 | integer                              | `5010`              | Never                   | Default upstream port.                                                      |
| `TARGET_MODE`             | `fixed`, `allowlist`, or `arbitrary` | `fixed`             | Never                   | Controls which targets a client may name.                                   |
| `ALLOWED_TARGETS`         | comma-separated `host:port` list     | empty               | `TARGET_MODE=allowlist` | Allowed targets; malformed entries are ignored.                             |
| `ARBITRARY_ALLOWED_PORTS` | comma-separated ports/ranges         | empty               | `TARGET_MODE=arbitrary` | Allowed ports and ranges for arbitrary targets, for example `23,4000-4100`. |
| `MUD_TLS_MODE`            | `plain`, `required`, or `prefer`     | `prefer`            | Never                   | Controls how the proxy connects to the upstream MUD.                        |

`TARGET_MODE=arbitrary` lets the client name the host. Without enforced
authentication it is an open relay, so startup rejects it unless either
`AUTH_MODE=shared-secret` or `REQUIRE_APP_AUTH=true` enforces authentication.
Reserved-network rejection still applies. `TARGET_MODE=allowlist` with zero
valid `host:port` entries in `ALLOWED_TARGETS` is a startup error rather than a
permissive fallback. Malformed entries are ignored, so a mixed list starts with
only its valid entries; a typo can silently remove an intended target and cause
connections to it to be denied.

`TARGET_MODE=arbitrary` requires `ARBITRARY_ALLOWED_PORTS` to contain a
non-empty list item, but startup does not verify that any item is a valid port
or range. Malformed items and ranges are ignored during enforcement. This fails
closed—an entirely malformed list permits no ports—but a typo can leave the
proxy running while denying intended targets.

`MUD_TLS_MODE` defaults to `prefer` — attempt TLS, fall back to plaintext —
because that is the historical behaviour. Defaulting to `plain` would silently
stop attempting TLS against every MUD that supports it. Use `required` to
refuse plaintext upstream entirely: `prefer` is downgradeable by an active
network attacker who can make the TLS attempt fail.

## Authentication

| Variable                  | Type                      | Default | Required when                                   | Description                                                       |
| ------------------------- | ------------------------- | ------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `AUTH_MODE`               | `none` or `shared-secret` | `none`  | Never                                           | Selects whether WebSocket upgrades require the shared secret.     |
| `PROXY_SHARED_SECRET`     | secret string             | empty   | `AUTH_MODE=shared-secret`                       | Shared secret; startup enforces at least 32 UTF-16 code units.    |
| `AUTH_ALLOW_QUERY_SECRET` | boolean                   | `false` | Never                                           | Also accepts the shared secret in the `?secret=` query parameter. |
| `REQUIRE_APP_AUTH`        | boolean                   | `false` | Never; `true` requires App Attest configuration | Requires a valid App Attest assertion on every upgrade.           |

Browsers cannot set headers on a WebSocket handshake, which is the only reason
`AUTH_ALLOW_QUERY_SECRET` exists. Setting it to `true` can place the secret in
URLs, access logs, and referrer headers, so it is opt-in.

Startup measures `PROXY_SHARED_SECRET` with JavaScript string length, which is
UTF-16 code units rather than bytes. Use 32 or more ASCII characters so the
threshold is unambiguous.

`REQUIRE_APP_AUTH` without App Attest configured is not a stricter posture but
a closed door — every upgrade would be rejected for headers the client has no
way to obtain — so that combination aborts at startup.

## Origin checking

| Variable               | Type                          | Default | Required when | Description                                                                         |
| ---------------------- | ----------------------------- | ------- | ------------- | ----------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`      | comma-separated exact origins | empty   | Never         | Exact allowed origins, for example `https://app.example.com`; empty means no check. |
| `ALLOW_MISSING_ORIGIN` | boolean                       | `false` | Never         | Accepts upgrades with no `Origin` header, such as native clients.                   |

Entries must be scheme + host + optional port. A `*` wildcard is rejected at
startup rather than accepted as "allow everything", as is any malformed entry.
Origin checking limits browser contexts; it is not authentication.

## Trusted proxies

| Variable              | Type                                             | Default | Required when | Description                                                                              |
| --------------------- | ------------------------------------------------ | ------- | ------------- | ---------------------------------------------------------------------------------------- |
| `TRUSTED_PROXY_CIDRS` | `true`, `false`, or comma-separated IP/CIDR list | `false` | Never         | Identifies peers whose forwarded client-address headers are honoured; `true` trusts all. |

A malformed entry aborts startup. Accepting it and matching nothing would leave
forwarded headers unhonoured, collapsing every client onto the proxy's own
address and tripping per-IP limits service-wide — while reading as configured.
Trusting arbitrary forwarded headers permits identity spoofing and defeats
per-IP session and message-rate limits.

## Session limits

| Variable                  | Type             | Default | Required when | Description                                                        |
| ------------------------- | ---------------- | ------- | ------------- | ------------------------------------------------------------------ |
| `SESSION_TIMEOUT_HOURS`   | positive integer | `24`    | Never         | Idle lifetime of a resumable session.                              |
| `MAX_SESSIONS_PER_DEVICE` | positive integer | `5`     | Never         | Concurrent sessions per device identifier.                         |
| `MAX_SESSIONS_PER_IP`     | positive integer | `10`    | Never         | Concurrent sessions per client address.                            |
| `MAX_SESSIONS_GLOBAL`     | positive integer | unset   | Never         | Concurrent sessions across the process; unset means no global cap. |
| `RESUME_GRACE_MINUTES`    | positive integer | `45`    | Never         | How long a session with no attached client keeps its slot.         |

All must be positive integers when set. Sessions and resume state are
memory-local and are lost on restart. Raising session limits increases
per-client memory and connection exposure.

`RESUME_GRACE_MINUTES` is what makes the limits above meaningful. Terminating a
client's socket does not free its session — the session is deliberately kept
alive so a client can resume — so without a grace window a dead session holds
its slot until `SESSION_TIMEOUT_HOURS`, and the caps end up bounding live
clients while dead sessions accumulate underneath.

The default is deliberately longer than the silent-push interval (20 minutes),
because a backgrounded mobile client is indistinguishable from a dead one. It
tolerates one lost push before the session is reclaimed. Shortening it below
the push interval will reclaim sessions before the push that would have woken
them, breaking resume for backgrounded clients.

## Message rate

| Variable                         | Type             | Default | Required when | Description                                       |
| -------------------------------- | ---------------- | ------- | ------------- | ------------------------------------------------- |
| `MAX_MESSAGES_PER_SECOND`        | positive integer | `60`    | Never         | Inbound frames per second for one connection.     |
| `MAX_MESSAGES_PER_SECOND_PER_IP` | positive integer | `240`   | Never         | Inbound frames per second for one client address. |

The session limits bound how many connections a client may hold; these bound how
fast it may talk through them. Without them a client inside every connection cap
could send frames as fast as the socket allowed — and because each `input` frame
becomes a telnet write, the first casualty is the upstream MUD, whose own flood
protection sees a single abusive address: this proxy's.

Authentication does not substitute for this. `AUTH_MODE=shared-secret` proves a
client is entitled to connect, not that it is behaving.

Both dimensions apply, because either alone is trivially defeated: a
per-connection limit is bypassed by opening several connections, and a
per-address limit alone throttles a legitimate multi-session user as though they
were one noisy client. `MAX_MESSAGES_PER_SECOND_PER_IP` must therefore be at
least `MAX_MESSAGES_PER_SECOND`, and startup fails otherwise — below it, a single
connection could never reach its own allowance and the per-connection limit would
be dead configuration.

The narrower limit is keyed on the **connection**, not the session, so both wire
protocols get both dimensions: a legacy raw-telnet connection has no resumable
session, and keying on one would have left legacy traffic bound only by the
address allowance. It is also checked first, so a frame refused for exceeding a
connection's own allowance does not consume the address budget its siblings
share — addresses are shared routinely by NAT, and one abusive client should not
throttle innocent players behind the same address.

The address is the server-derived one, after `TRUSTED_PROXY_CIDRS` is applied.
Keying on anything the client supplies would make the limit advisory.

Over the limit, the frame is dropped and the client is sent one
`rate_limited` error **per window**, not per dropped frame — replying to every
one would amplify outbound traffic during exactly the flood being damped. The
rejection names which dimension was hit, so an operator investigating is not
sent after the wrong client.

Defaults are far above a human at a keyboard and above what a well-behaved MUD
client sends. Measured: a client sending 8 commands per second is never
throttled, while 300 frames sent in a tight loop against a 10/second allowance
delivers 9 and produces one notice.

Raising either rate limit increases per-client CPU, traffic, and upstream MUD
resource exposure.

## Shutdown

| Variable               | Type             | Default | Required when | Description                                                         |
| ---------------------- | ---------------- | ------- | ------------- | ------------------------------------------------------------------- |
| `SHUTDOWN_GRACE_MS`    | positive integer | `3000`  | Never         | Time spent unready before anything is closed.                       |
| `SHUTDOWN_DEADLINE_MS` | positive integer | `15000` | Never         | Absolute budget for the whole drain; the process then exits anyway. |

On `SIGINT`/`SIGTERM` the proxy drains in order: become unready so `/health`
returns 503 and new upgrades are rejected, wait `SHUTDOWN_GRACE_MS`, stop the
heartbeat sweep, close client connections with a WebSocket close frame, close
telnet sockets and sessions, flush persisted App Attest state, then close the
listener and release the port.

`SHUTDOWN_GRACE_MS` is the step operators most often want to change, and the one
most often omitted. Nothing is closed during it — the point is to stay up,
already reporting unhealthy, long enough for a load balancer or orchestrator to
stop routing new traffic. Set it to at least the interval between health checks,
or clients will be sent to a process that has stopped accepting them.

Startup requires `SHUTDOWN_DEADLINE_MS > SHUTDOWN_GRACE_MS`; otherwise the
deadline would expire before the ordered close and persistence steps can run.

Repeated signals are ignored rather than restarting the drain, so a second
`SIGTERM` cannot reset the deadline and keep the process alive.

> **Sessions and resume state are memory-local and are lost on restart.** There
> is no persistence: every connected player is disconnected and cannot resume,
> and any unsent buffered output is gone. This is worth knowing when scheduling
> restarts — prefer quiet hours, and expect players to reconnect rather than
> resume.

## Telnet byte caps

| Variable                   | Type             | Default | Required when | Description                                           |
| -------------------------- | ---------------- | ------- | ------------- | ----------------------------------------------------- |
| `MAX_SUBNEGOTIATION_BYTES` | positive integer | `65536` | Never         | Cap on one telnet subnegotiation payload.             |
| `OUTPUT_BUFFER_BYTES`      | positive integer | `51200` | Never         | Per-session output buffer retained for resume replay. |

The telnet parser is stateful across TCP chunks, which is what lets it handle
an `IAC` sequence split over a packet boundary. It is also what made an
unterminated subnegotiation a memory sink: a MUD that sends `IAC SB <option>`
and then never sends `IAC SE` grew the accumulator for as long as it kept
talking. Measured before the cap, 12.5 MiB streamed produced 435 MiB of RSS —
roughly 35x, because the accumulator holds one JavaScript number per byte.

In `TARGET_MODE=arbitrary` the MUD is chosen by the client, so this is memory a
client can make the server allocate on demand, per session.

On overflow the whole sequence is **discarded** and the parser consumes to the
real `IAC SE` before resuming. It is not truncated and delivered: a truncated
GMCP payload is invalid at best and misleading at worst, and treating the
remaining payload as text would show the player binary. Overflow is logged once
per sequence with the option code — per byte, the logging would itself be the
denial of service.

The default is above what real MUDs send. Aardwolf, Achaea and Discworld all
push large MSDP/GMCP payloads, and a cap that breaks a legitimate game is a
worse outcome than the memory it saves.

Raising either the telnet payload cap or output buffer limit increases the
memory a client or client-selected upstream can make the process retain.

## WebSocket liveness

| Variable                   | Type             | Default | Required when | Description                                                 |
| -------------------------- | ---------------- | ------- | ------------- | ----------------------------------------------------------- |
| `WS_HEARTBEAT_ENABLED`     | boolean          | `true`  | Never         | Ping connected clients and reclaim slots from silent peers. |
| `WS_HEARTBEAT_INTERVAL_MS` | positive integer | `30000` | Never         | How often to ping.                                          |
| `WS_HEARTBEAT_TIMEOUT_MS`  | positive integer | `90000` | Never         | Silence beyond this terminates the connection.              |

These are what reclaim capacity from connections that are gone but not closed
— a closed laptop lid, or a NAT that dropped its mapping without telling
either end. Without them such a connection holds its session slot until
`SESSION_TIMEOUT_HOURS` elapses, so the limits above bound live clients while
dead ones accumulate underneath.

`WS_HEARTBEAT_TIMEOUT_MS` must be greater than `WS_HEARTBEAT_INTERVAL_MS`, and
startup fails otherwise: at or below the interval, every peer is reclaimed
before it can answer a ping. The default leaves room for two lost pings before
a live client is dropped.

Turning the heartbeat off is supported but logs a warning, because the
connection limits become progressively less meaningful as dead slots
accumulate.

## Diagnostics and logging

| Variable             | Type                                | Default | Required when                          | Description                                                                    |
| -------------------- | ----------------------------------- | ------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `ENABLE_DIAGNOSTICS` | boolean                             | `false` | Never                                  | Exposes the diagnostics endpoints.                                             |
| `ADMIN_TOKEN`        | secret string                       | empty   | Required to access enabled diagnostics | Bearer token guarding enabled diagnostics endpoints.                           |
| `LOG_LEVEL`          | `debug`, `info`, `warn`, or `error` | `info`  | Never                                  | Sets the minimum emitted log level.                                            |
| `NO_COLOR`           | literal `1` or unset                | unset   | Never                                  | Set to exactly `1` to disable ANSI colour in logs; any other value is ignored. |

`LOG_LEVEL=debug` enables structured diagnostics such as message shape, field
names, and byte counts; it does not log session payload content. Raw binary
dumps are guarded by the separate internal `srv.debug` flag, which is hardcoded
to `false` and is not an environment setting.

## App Attest (optional, off by default)

App Attest is experimental: the verification in `src/app-attest.ts` is a
from-scratch implementation of Apple's format and has not had independent
cryptographic review. A verifier that is too permissive still accepts every
genuine client, so the failure mode is silent. Pair it with
`AUTH_MODE=shared-secret` rather than relying on it alone. See
[the open-source plan](open-source-plan.md#optional-apple-features-privacy-and-status)
for the privacy implications of enabling it.

| Variable              | Type   | Default                     | Required when                                                | Description                                 |
| --------------------- | ------ | --------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `APPATTEST_BUNDLE_ID` | string | empty                       | Set together with `APPATTEST_TEAM_ID` to enable App Attest   | iOS bundle identifier.                      |
| `APPATTEST_TEAM_ID`   | string | empty                       | Set together with `APPATTEST_BUNDLE_ID` to enable App Attest | Apple team identifier.                      |
| `ATTESTED_KEYS_PATH`  | path   | `config/attested-keys.json` | Never                                                        | Where registered device keys are persisted. |

Both identifiers are required together — verification uses the bundle ID for
the `rpIdHash` and the team ID for the App ID the attestation nonce is bound
to. Setting one without the other aborts startup. There is no separate enable
flag, so the configuration and the state cannot disagree.

**Startup also aborts when App Attest is enabled but the directory containing
`ATTESTED_KEYS_PATH` is not writable.** This validation prevents the otherwise
misleading failure mode: without it, an enabled-but-unwritable proxy could
start, pass its health check, log `App Attest ENABLED`, then lose the first
registration at flush. The container case is concrete — the image creates
`/var/lib/mud-web-proxy`, so the directory exists, but with a read-only root and
no volume mounted over it every write returns `EROFS`.

The **directory** is checked, not the file: on a first run the file does not
exist yet, and persistence stages a sibling file beside it before renaming it
into place. That is also why the fix is always to mount the directory —
mounting `attested-keys.json` itself breaks every write for the same reason.

`ATTESTED_KEYS_PATH` contains attested keys, which are device-derived data, and
holds a durable record of which devices have used this server and roughly when.
Entries are reclaimed after 90 days of inactivity, which bounds retention
rather than eliminating it.

## APNS push (optional, off by default)

Configuring push sends APNS device tokens, which are device-derived data, to
Apple with every push. APNS alert snippets transit Apple's infrastructure.
Silent and Live Activity pushes reveal connection timing even when they carry
no text. None of this happens with APNS unconfigured, which is the default.

| Variable           | Type                      | Default   | Required when                                            | Description                             |
| ------------------ | ------------------------- | --------- | -------------------------------------------------------- | --------------------------------------- |
| `APNS_KEY_PATH`    | path                      | empty     | Set with all four APNS identity variables to enable push | Path to the APNS signing key.           |
| `APNS_KEY_ID`      | string                    | empty     | Set with all four APNS identity variables to enable push | Key identifier.                         |
| `APNS_TEAM_ID`     | string                    | empty     | Set with all four APNS identity variables to enable push | Apple team identifier.                  |
| `APNS_TOPIC`       | string                    | empty     | Set with all four APNS identity variables to enable push | Push topic, normally the bundle ID.     |
| `APNS_ENVIRONMENT` | `sandbox` or `production` | `sandbox` | Never                                                    | Selects the Apple push environment.     |
| `APNS_TEST_SECRET` | secret string             | empty     | Required to use the APNS test endpoint                   | Secret guarding the push test endpoint. |

The first four are all-or-nothing: setting some but not all aborts startup and
names the missing ones. Partial configuration used to produce a "configured"
push manager that failed every send at Apple with a 4xx nobody was watching
for.

## Background push tuning

These apply only when APNS is configured. All are optional integers. When a
parsed runtime value is unset, `BackgroundPushScheduler` uses the value shown
below as its scheduler default.

| Variable                              | Type    | Default   | Required when | Description                                                 |
| ------------------------------------- | ------- | --------- | ------------- | ----------------------------------------------------------- |
| `SILENT_PUSH_INTERVAL_MS`             | integer | `1200000` | Never         | Minimum gap between silent pushes to a device (20 minutes). |
| `ACTIVITY_PUSH_INTERVAL_MS`           | integer | `120000`  | Never         | Minimum gap between Live Activity updates (2 minutes).      |
| `ACTIVITY_PUSH_ACK_TIMEOUT_MS`        | integer | `15000`   | Never         | How long to wait for a client acknowledgement (15 seconds). |
| `ACTIVITY_PUSH_FALLBACK_COOLDOWN_MS`  | integer | `60000`   | Never         | Initial cooldown and backoff after a successful fallback.   |
| `ACTIVITY_PUSH_FALLBACK_MAX_PER_HOUR` | integer | `6`       | Never         | Cap on fallback silent pushes per device per hour.          |
| `ACTIVITY_PUSH_MAX_SNIPPET_LENGTH`    | integer | `100`     | Never         | Characters of MUD output carried in a Live Activity update. |

`ACTIVITY_PUSH_FALLBACK_COOLDOWN_MS` does not delay the first fallback after
the acknowledgement timeout; that fallback is immediately eligible subject to
the silent-push interval, hourly cap, and other gates. After a successful
fallback silent push, the value initializes the cooldown and exponential
backoff before another fallback may be sent.

`ACTIVITY_PUSH_MAX_SNIPPET_LENGTH` bounds how much Live Activity text reaches
Apple. It does not change who can see it.

## Rejected retired names

These are not v4 configuration settings. Assigning any of them aborts startup.

| Variable                           | Replacement or disposition                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `ONLY_ALLOW_DEFAULT_SERVER`        | Use `TARGET_MODE=fixed` (the default), `allowlist`, or `arbitrary`.               |
| `DISABLE_TLS`                      | Use `INBOUND_TLS_MODE=off`; non-loopback plaintext also requires acknowledgement. |
| `ALLOW_INSECURE_PRODUCTION_NO_TLS` | Use `INBOUND_TLS_MODE=off`, or `required` with valid certificate and key paths.   |
| `TRUST_PROXY`                      | Use `TRUSTED_PROXY_CIDRS`.                                                        |
| `ALLOW_MTLS_FALLBACK`              | Use `AUTH_MODE=shared-secret` for clients that cannot attest.                     |
| `MTLS_CLIENT_CA_PATH`              | Removed with mTLS fallback; the proxy no longer requests client certificates.     |

Two older App Attest diagnostic bypass names are deliberately inert rather
than rejected: `APPATTEST_ALLOW_ASSERTION_BYPASS` and
`APPATTEST_DIAG_CROSSKEY`. The runtime no longer reads either name, so assigning
one has no effect and App Attest verification remains enabled.
