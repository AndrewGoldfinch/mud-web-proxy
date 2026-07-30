# Configuration reference

Every setting is an environment variable, read once at startup in
[`src/runtime-config.ts`](../src/runtime-config.ts). Parsing is strict: a value
that is present but unparseable aborts the process rather than falling back to
the default, and a retired variable aborts with the name of its replacement.
Nothing is re-read while the process runs, so a change requires a restart.

Defaults below are the values the proxy uses when the variable is unset. They
are the ones in `src/runtime-config.ts`; `scripts/check-config-docs.ts` fails
CI when a variable exists there and not here, so this list cannot silently fall
behind the code. It can still fall behind on _description_ — if a default here
disagrees with the source, the source is right.

Boolean variables accept `1`, `true`, `yes`, `on` and `0`, `false`, `no`, `off`,
case-insensitively. Anything else is a startup error.

## Listener

| Variable    | Description                              | Default     |
| ----------- | ---------------------------------------- | ----------- |
| `BIND_HOST` | Address the WebSocket listener binds to. | `127.0.0.1` |
| `WS_PORT`   | Port the WebSocket listener binds to.    | `6200`      |

Binding to loopback and terminating TLS in a reverse proxy is the supported
production layout. `BIND_HOST` is also the signal that decides whether a
plaintext listener needs acknowledgement — see `ALLOW_INSECURE_INBOUND_NO_TLS`.

## Inbound TLS

| Variable                        | Description                                                                                                    | Default         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------- |
| `INBOUND_TLS_MODE`              | `required` or `off`. `required` refuses to start unless both paths below point at readable, matching material. | `required`      |
| `TLS_CERT_PATH`                 | Certificate path.                                                                                              | `./cert.pem`    |
| `TLS_KEY_PATH`                  | Private key path.                                                                                              | `./privkey.pem` |
| `ALLOW_INSECURE_INBOUND_NO_TLS` | Acknowledge a plaintext listener. Required when `INBOUND_TLS_MODE=off` and `BIND_HOST` is not loopback.        | `false`         |

The certificate and key are checked as a pair at startup, not merely for
existence: a certificate renewed without its key is readable, present, and
fails at the first handshake, which turns an operator error into an outage.

When the process is started from its own `dist` directory and neither path is
set explicitly, the parent directory is searched — a compiled server keeps its
certificates beside the project, not beside the bundle. An explicit path is
never second-guessed.

## Telnet target and target policy

| Variable                  | Description                                                                                   | Default             |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| `TN_HOST`                 | Default upstream host.                                                                        | `muds.maldorne.org` |
| `TN_PORT`                 | Default upstream port.                                                                        | `5010`              |
| `TARGET_MODE`             | `fixed`, `allowlist`, or `arbitrary`. Controls which targets a client may name.               | `fixed`             |
| `ALLOWED_TARGETS`         | Comma-separated `host:port` entries. Required and must parse when `TARGET_MODE=allowlist`.    | _(empty)_           |
| `ARBITRARY_ALLOWED_PORTS` | Comma-separated ports and ranges, e.g. `23,4000-4100`. Required when `TARGET_MODE=arbitrary`. | _(empty)_           |
| `MUD_TLS_MODE`            | `prefer`, `required`, or `plain`. How the proxy connects upstream.                            | `prefer`            |

`TARGET_MODE=arbitrary` lets the client name the host, which is an open SSRF
relay without authentication, so it requires `AUTH_MODE=shared-secret` and
refuses to start otherwise. `TARGET_MODE=allowlist` with an empty or
unparseable `ALLOWED_TARGETS` is a startup error rather than a permissive
fallback.

`MUD_TLS_MODE` defaults to `prefer` — attempt TLS, fall back to plaintext —
because that is the historical behaviour. Defaulting to `plain` would silently
stop attempting TLS against every MUD that supports it. Use `required` to
refuse plaintext upstream entirely.

## Authentication

| Variable                  | Description                                                                                         | Default   |
| ------------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| `AUTH_MODE`               | `shared-secret` or `none`.                                                                          | `none`    |
| `PROXY_SHARED_SECRET`     | The secret. At least 32 bytes when `AUTH_MODE=shared-secret`; shorter is a startup error.           | _(empty)_ |
| `AUTH_ALLOW_QUERY_SECRET` | Also accept the secret as a `?secret=` query parameter.                                             | `false`   |
| `REQUIRE_APP_AUTH`        | Require an App Attest assertion on every upgrade. Refuses to start unless App Attest is configured. | `false`   |

Browsers cannot set headers on a WebSocket handshake, which is the only reason
`AUTH_ALLOW_QUERY_SECRET` exists. It puts the secret in access logs and
referrer headers, so it is opt-in.

`REQUIRE_APP_AUTH` without App Attest configured is not a stricter posture but
a closed door — every upgrade would be rejected for headers the client has no
way to obtain — so that combination aborts at startup.

## Origin checking

| Variable               | Description                                                                          | Default             |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------- |
| `ALLOWED_ORIGINS`      | Comma-separated exact origins, e.g. `https://app.example.com`. Unset means no check. | _(empty, no check)_ |
| `ALLOW_MISSING_ORIGIN` | Accept upgrades that carry no `Origin` header, such as native clients.               | `false`             |

Entries must be scheme + host + optional port. A `*` wildcard is rejected at
startup rather than accepted as "allow everything", as is any malformed entry.

## Trusted proxies

| Variable              | Description                                                                                     | Default |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| `TRUSTED_PROXY_CIDRS` | `true`, `false`, or comma-separated addresses/CIDR ranges whose forwarded headers are honoured. | `false` |

A malformed entry aborts startup. Accepting it and matching nothing would leave
forwarded headers unhonoured, collapsing every client onto the proxy's own
address and tripping per-IP limits service-wide — while reading as configured.

## Session limits

| Variable                  | Description                                                        | Default           |
| ------------------------- | ------------------------------------------------------------------ | ----------------- |
| `SESSION_TIMEOUT_HOURS`   | Idle lifetime of a resumable session.                              | `24`              |
| `MAX_SESSIONS_PER_DEVICE` | Concurrent sessions per device identifier.                         | `5`               |
| `MAX_SESSIONS_PER_IP`     | Concurrent sessions per client address.                            | `10`              |
| `MAX_SESSIONS_GLOBAL`     | Concurrent sessions across the process. Unset means no global cap. | _(unset, no cap)_ |

| `RESUME_GRACE_MINUTES` | How long a session with no attached client keeps its slot. | `45` |

All must be positive integers when set. Sessions and resume state are
memory-local and are lost on restart.

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

| Variable                         | Description                                       | Default |
| -------------------------------- | ------------------------------------------------- | ------- |
| `MAX_MESSAGES_PER_SECOND`        | Inbound frames per second for one session.        | `60`    |
| `MAX_MESSAGES_PER_SECOND_PER_IP` | Inbound frames per second for one client address. | `240`   |

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

## Shutdown

| Variable               | Description                                                         | Default |
| ---------------------- | ------------------------------------------------------------------- | ------- |
| `SHUTDOWN_GRACE_MS`    | Time spent unready, before anything is closed.                      | `3000`  |
| `SHUTDOWN_DEADLINE_MS` | Absolute budget for the whole drain; the process then exits anyway. | `15000` |

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

Repeated signals are ignored rather than restarting the drain, so a second
`SIGTERM` cannot reset the deadline and keep the process alive.

> **Sessions and resume state are memory-local and are lost on restart.** There
> is no persistence: every connected player is disconnected and cannot resume,
> and any unsent buffered output is gone. This is worth knowing when scheduling
> restarts — prefer quiet hours, and expect players to reconnect rather than
> resume.

## Telnet byte caps

| Variable                   | Description                                           | Default |
| -------------------------- | ----------------------------------------------------- | ------- |
| `MAX_SUBNEGOTIATION_BYTES` | Cap on one telnet subnegotiation payload.             | `65536` |
| `OUTPUT_BUFFER_BYTES`      | Per-session output buffer retained for resume replay. | `51200` |

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

## WebSocket liveness

| Variable                   | Description                                                 | Default |
| -------------------------- | ----------------------------------------------------------- | ------- |
| `WS_HEARTBEAT_ENABLED`     | Ping connected clients and reclaim slots from silent peers. | `true`  |
| `WS_HEARTBEAT_INTERVAL_MS` | How often to ping.                                          | `30000` |
| `WS_HEARTBEAT_TIMEOUT_MS`  | Silence beyond this terminates the connection.              | `90000` |

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

| Variable             | Description                                                                    | Default   |
| -------------------- | ------------------------------------------------------------------------------ | --------- |
| `ENABLE_DIAGNOSTICS` | Expose the diagnostics endpoints.                                              | `false`   |
| `ADMIN_TOKEN`        | Bearer token guarding those endpoints.                                         | _(empty)_ |
| `LOG_LEVEL`          | `debug`, `info`, `warn`, or `error`.                                           | `info`    |
| `NO_COLOR`           | Set to exactly `1` to disable ANSI colour in logs. Any other value is ignored. | _(unset)_ |

`LOG_LEVEL=debug` logs session content. Password input is omitted from logs in
every mode, via telnet ECHO negotiation.

## App Attest (optional, off by default)

App Attest is experimental: the verification in `src/app-attest.ts` is a
from-scratch implementation of Apple's format and has not had independent
cryptographic review. A verifier that is too permissive still accepts every
genuine client, so the failure mode is silent. Pair it with
`AUTH_MODE=shared-secret` rather than relying on it alone. See
[the open-source plan](open-source-plan.md#optional-apple-features-privacy-and-status)
for the privacy implications of enabling it.

| Variable              | Description                                                       | Default                     |
| --------------------- | ----------------------------------------------------------------- | --------------------------- |
| `APPATTEST_BUNDLE_ID` | iOS bundle identifier. Enables App Attest with the next variable. | _(empty, disabled)_         |
| `APPATTEST_TEAM_ID`   | Apple team identifier.                                            | _(empty, disabled)_         |
| `ATTESTED_KEYS_PATH`  | Where registered device keys are persisted.                       | `config/attested-keys.json` |

Both identifiers are required together — verification uses the bundle ID for
the `rpIdHash` and the team ID for the App ID the attestation nonce is bound
to. Setting one without the other aborts startup. There is no separate enable
flag, so the configuration and the state cannot disagree.

`ATTESTED_KEYS_PATH` holds a durable record of which devices have used this
server and roughly when. Treat it as personal data. Entries are reclaimed after
90 days of inactivity, which bounds retention rather than eliminating it.

## APNS push (optional, off by default)

Configuring push sends data to Apple: device tokens with every push, and, for
alert pushes, a snippet of MUD output that Apple can read. Silent and Live
Activity pushes reveal connection timing even when they carry no text. None of
this happens with APNS unconfigured, which is the default.

| Variable           | Description                             | Default             |
| ------------------ | --------------------------------------- | ------------------- |
| `APNS_KEY_PATH`    | Path to the APNS signing key.           | _(empty, disabled)_ |
| `APNS_KEY_ID`      | Key identifier.                         | _(empty, disabled)_ |
| `APNS_TEAM_ID`     | Apple team identifier.                  | _(empty, disabled)_ |
| `APNS_TOPIC`       | Push topic, normally the bundle ID.     | _(empty, disabled)_ |
| `APNS_ENVIRONMENT` | `sandbox` or `production`.              | `sandbox`           |
| `APNS_TEST_SECRET` | Secret guarding the push test endpoint. | _(empty)_           |

The first four are all-or-nothing: setting some but not all aborts startup and
names the missing ones. Partial configuration used to produce a "configured"
push manager that failed every send at Apple with a 4xx nobody was watching
for.

## Background push tuning

These apply only when APNS is configured. All are optional integers; unset
means the built-in default.

| Variable                              | Description                                        | Default            |
| ------------------------------------- | -------------------------------------------------- | ------------------ |
| `SILENT_PUSH_INTERVAL_MS`             | Minimum gap between silent pushes to a device.     | `1200000` (20 min) |
| `ACTIVITY_PUSH_INTERVAL_MS`           | Minimum gap between Live Activity updates.         | `120000` (2 min)   |
| `ACTIVITY_PUSH_ACK_TIMEOUT_MS`        | How long to wait for a client acknowledgement.     | `15000` (15 s)     |
| `ACTIVITY_PUSH_FALLBACK_COOLDOWN_MS`  | Cooldown before falling back to an alert push.     | `60000` (1 min)    |
| `ACTIVITY_PUSH_FALLBACK_MAX_PER_HOUR` | Cap on fallback alert pushes per device per hour.  | `6`                |
| `ACTIVITY_PUSH_MAX_SNIPPET_LENGTH`    | Characters of MUD output carried in an alert push. | `100`              |

`ACTIVITY_PUSH_MAX_SNIPPET_LENGTH` bounds how much text reaches Apple. It does
not change who can see it.

## Removed variables

Each of these aborts startup with a message naming its replacement. They are
listed so that an upgrade fails loudly instead of silently changing posture.

| Variable                           | Replacement                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `ONLY_ALLOW_DEFAULT_SERVER`        | `TARGET_MODE=fixed` (the default), or `allowlist` / `arbitrary`.                 |
| `DISABLE_TLS`                      | `INBOUND_TLS_MODE=off`, permitted on loopback only.                              |
| `ALLOW_INSECURE_PRODUCTION_NO_TLS` | `INBOUND_TLS_MODE=off`, or `required` with valid paths.                          |
| `TRUST_PROXY`                      | Renamed to `TRUSTED_PROXY_CIDRS`.                                                |
| `ALLOW_MTLS_FALLBACK`              | `AUTH_MODE=shared-secret` for clients that cannot attest.                        |
| `MTLS_CLIENT_CA_PATH`              | Removed with `ALLOW_MTLS_FALLBACK`; client certificates are no longer requested. |

The two retired App Attest bypass variables are deliberately _not_ in this
list. Ignoring a bypass fails toward the safe side — the setting is inert and
verification stays on — whereas rejecting it at startup would mean something
still reads it.
