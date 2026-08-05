# Security model and threat model

mud-web-proxy opens outbound TCP connections and relays bytes bidirectionally
on behalf of remote clients. That is the whole product, and it is the root of
every consideration below. Whether an installation is a MUD gateway or a
general-purpose open relay is decided entirely by configuration.

This document explains what the built-in controls actually do, what they do
not do, and what an operator accepts by loosening each default. It is the
authoritative technical security reference for v4.

Exact types, defaults, accepted values, and conditional requirements live in
[`configuration.md`](configuration.md); this document does not restate that
table. Deployment specifics live in [`deployment/compose.md`](deployment/compose.md)
and [`deployment/systemd.md`](deployment/systemd.md).

## What the proxy does

A client opens a WebSocket to the proxy and asks it to connect to a MUD. The
proxy validates the request against its target policy, dials TCP to the
resolved address, and forwards bytes in both directions until one side hangs
up. It speaks the Telnet option protocol upstream and frames MUD output for
the client downstream.

Two consequences follow directly:

- **The proxy is an outbound connection source.** Every request a client makes
  becomes a TCP connection originating from the proxy's host and IP address. A
  permissive target policy makes that host a relay for whatever the client
  wants to reach, including hosts inside the operator's own network.
- **MUD output is untrusted input.** The proxy relays what the MUD sends. It
  does not sanitize game output, and it cannot: escape sequences, markup, and
  protocol payloads are what a MUD client is supposed to receive. Safe
  rendering is the consuming client's responsibility.

## Security boundaries and data flow

The primary data path is:

```
browser or native client
  -> edge listener (Caddy) or the application listener directly
  -> mud-web-proxy
  -> selected MUD
```

Each arrow is a distinct trust boundary with a distinct owner.

**Client to edge.** In both supported topologies Caddy terminates public
HTTPS/WSS. Certificates, protocol versions, and public exposure are Caddy's,
not the application's.

**Edge to application.** This hop is deliberately plaintext in both supported
topologies and is confined by the network rather than by TLS. Under Compose it
runs on an internal Docker network; under systemd it runs on loopback. The
application listens with `INBOUND_TLS_MODE=off` and the explicit
`ALLOW_INSECURE_INBOUND_NO_TLS` acknowledgement, which exists so that plaintext
is never the result of an oversight.

**Direct application-managed TLS** is a third, separate topology. There
`INBOUND_TLS_MODE=required` applies and startup validates that the configured
certificate and key are present, readable, well-formed, and a matching pair —
a broken pair aborts the process rather than falling back to plaintext.

**Application to MUD.** Governed by `MUD_TLS_MODE` and independent of every
inbound decision. See [TLS boundaries](#tls-boundaries).

### Defaults and what loosening them accepts

Every v4 default below was chosen for a security reason. Changing one is
legitimate; doing so unaware of the consequence is the failure this table
exists to prevent.

| Default                                                       | Why it is the default                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BIND_HOST=127.0.0.1`                                         | Keeps the application listener off public interfaces in the supported edge-termination topology. Binding elsewhere exposes the application directly and is what makes the inbound-TLS acknowledgement mandatory.                                                                                                   |
| `INBOUND_TLS_MODE=required`                                   | Prevents silent plaintext when the application is exposed directly. Non-loopback plaintext requires `ALLOW_INSECURE_INBOUND_NO_TLS`, so it is always a deliberate act.                                                                                                                                             |
| `TARGET_MODE=fixed`                                           | Prevents a default installation from becoming a general outbound relay. Widening it is the single highest-consequence change in this document.                                                                                                                                                                     |
| `MUD_TLS_MODE=prefer`                                         | Preserves compatibility with the plaintext MUDs that dominate the ecosystem while still attempting TLS. It accepts a downgrade that an active network attacker can force. `required` refuses that, at the cost of only working against runtime-trusted certificates.                                               |
| `AUTH_MODE=none`                                              | Does not protect access at all. It is tolerable only where target policy and network exposure are constrained by other means. It is rejected outright when combined with `TARGET_MODE=arbitrary`.                                                                                                                  |
| `AUTH_ALLOW_QUERY_SECRET=false`                               | Keeps the bearer secret out of URLs, access logs, browser history, and referrer headers. Enabling it exists only because browsers cannot set headers on a WebSocket handshake.                                                                                                                                     |
| empty `ALLOWED_ORIGINS`                                       | Applies no Origin restriction, for compatibility with native clients. Browser deployments should list exact origins. Wildcards are rejected at startup rather than honoured.                                                                                                                                       |
| `ALLOW_MISSING_ORIGIN=false`                                  | Prevents a configured Origin policy from being bypassed by simply omitting the header. Setting it true is an explicit relaxation for native clients, which are then gated only by `AUTH_MODE`.                                                                                                                     |
| `TRUSTED_PROXY_CIDRS=false`                                   | Ignores client-spoofable forwarding headers entirely. Any value wider than the actual reverse proxy lets clients choose their own apparent address.                                                                                                                                                                |
| sessions: `5` per device, `10` per IP, no global cap          | Bounds ordinary per-client abuse while preserving compatibility. The absent global cap is the notable gap: production operators should set `MAX_SESSIONS_GLOBAL` to match host capacity, because per-IP limits alone do not bound a distributed client population.                                                 |
| messages: `60` per connection, `240` per address              | Both sit far above human typing and above what a well-behaved client batches. The address budget is deliberately the larger, so a legitimate multi-session user is not throttled as though they were one noisy connection. Startup rejects a per-address value below the per-connection one as dead configuration. |
| `MAX_SUBNEGOTIATION_BYTES=65536`, `OUTPUT_BUFFER_BYTES=51200` | Bound per-session memory while retaining legitimate Telnet protocol payloads and enough replay history to resume. A hostile MUD cannot grow either without bound.                                                                                                                                                  |
| heartbeat enabled, `30000` ms interval, `90000` ms timeout    | Reclaims sockets whose peer has vanished without a close, while tolerating two missed pings. Startup rejects a timeout at or below the interval, which would reap every peer.                                                                                                                                      |
| `ENABLE_DIAGNOSTICS=false`, empty `ADMIN_TOKEN`               | Avoids exposing operational state. When enabled, diagnostics accept the admin token only.                                                                                                                                                                                                                          |
| App Attest and APNS disabled                                  | Avoids an experimental verifier and Apple-bound device data unless explicitly configured. Half-configuration is a startup error, not a partially enabled feature.                                                                                                                                                  |

## Target policy

`TARGET_MODE` decides which destinations a client may name. It is not a
boolean, and the removed `ONLY_ALLOW_DEFAULT_SERVER` setting now fails startup
rather than being silently ignored.

**`fixed`** (default) permits exactly `TN_HOST:TN_PORT`. A client that names
anything else is denied. Host comparison normalizes case and a trailing dot,
so the check cannot be evaded by spelling.

**`allowlist`** permits only exact operator-supplied `host:port` entries. An
entry may deliberately name a private address, because an operator naming an
internal MUD is expressing intent that a client cannot forge. A list with no
valid entries is a startup error rather than a permissive fallback, and
malformed entries are ignored — so a typo silently removes an intended target
rather than adding an unintended one.

**`arbitrary`** permits client-selected hosts, and is the mode that can turn
the host into a relay. It is constrained on four axes at once:

- it refuses to start without `ARBITRARY_ALLOWED_PORTS`;
- it refuses to start without enforced authentication, either
  `AUTH_MODE=shared-secret` or `REQUIRE_APP_AUTH=true`;
- the hostname is resolved once and every returned address is checked against
  reserved networks, so a client cannot reach loopback, link-local, or private
  ranges through a public name;
- the proxy then dials **the validated address**, not the name. Re-resolving
  between validation and connect is the DNS-rebinding hole, and not doing so
  is what closes it.

Capacity is reserved before any DNS or TCP work, so a client cannot issue many
concurrent connect frames and pass every limit check while nothing has yet
been counted.

Both wire protocols — the typed JSON protocol and the legacy `{connect}`
protocol — go through this same authorization path. They deliberately do not
share a data plane, but sharing policy is what stops one protocol from drifting
into a weaker check than the other.

## Authentication and Origin checking

**Shared secret.** `AUTH_MODE=shared-secret` requires a bearer credential on
the WebSocket upgrade. It is a single service-wide secret: it establishes that
a caller is entitled to use the service, and nothing else. It does not identify
individual users, does not encrypt anything, and does not authorize a
particular MUD destination — target policy does that, separately. Startup
enforces a minimum of 32 UTF-16 code units. Comparison is constant-time, so a
wrong secret cannot be discovered by timing, and failed-authentication
bookkeeping is bounded so it cannot itself be used to exhaust memory.

Header transport is preferred. `AUTH_ALLOW_QUERY_SECRET=true` additionally
accepts the secret in the query string, and exists only because browsers
cannot set headers on a WebSocket handshake. URLs reach access logs, proxy
logs, browser history, and referrer headers, so this is opt-in.

**App Attest.** `REQUIRE_APP_AUTH=true` requires a valid Apple App Attest
assertion on every upgrade. It is **experimental and has not received an
independent cryptographic review.** Treat it as defence in depth paired with
`AUTH_MODE=shared-secret`, not as a control to rely on alone. It is disabled by
default; configuring only one of `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID`
is a startup error rather than a half-enabled feature, and enabling
`REQUIRE_APP_AUTH` without App Attest configured is refused because it would
read as a stricter posture while enforcing nothing.

**Origin checking is browser hardening, never authentication.** `ALLOWED_ORIGINS`
constrains which web origins a browser will let connect. A native client sets
whatever Origin value it likes, so the check binds only callers that are
already honouring the browser security model. Matching is case-insensitive on
scheme and host, ignores a trailing slash, and rejects same-prefix impostors;
wildcards are refused at startup. Never treat a passing Origin check as
evidence of who the caller is.

## Trusted proxies and client identity

Per-IP limits, per-IP capacity accounting, and every log line keyed on client
address all depend on the proxy knowing the real client address. Behind a
reverse proxy that address arrives in a header, and headers are client-writable.

`TRUSTED_PROXY_CIDRS` defaults to `false`: forwarded headers are ignored and
the immediate peer address is used. When set, forwarded headers are honoured
**only** when the immediate peer is inside the trust list, and the walk back
through the forwarding chain stops at the first untrusted hop.

Setting this too broadly is the failure mode. Trusting a wide range — or `true`
— lets any client inside it present its own `X-Forwarded-For` and be believed.
The consequences are not limited to bad log data: per-IP session limits, the
per-address message-rate budget, and pending-dial reservations all become
unenforceable, because the attacker chooses the key they are counted under.

The supported topologies scope this narrowly, and both replace rather than
append the forwarding headers at the edge:

- **Compose** trusts `172.28.0.0/24`, the pinned subnet of that stack alone,
  not the whole `172.16.0.0/12` private range. Its Caddyfile sets
  `X-Forwarded-For` and `X-Real-IP` to the real peer, discarding anything the
  client sent.
- **systemd** trusts `127.0.0.1` only, and the shipped Caddy template overwrites
  both headers the same way.

Caddy's default behaviour is to _append_ to a client-supplied
`X-Forwarded-For`. Under that default a client can prepend a forged address and
the proxy, trusting the hop, reads the forged value. Replacement is therefore
part of the security contract of the deployment, not a stylistic choice.

## Resource limits

Each limit bounds a specific exhaustion path. Together they are not a
denial-of-service guarantee: a volumetric attack that exhausts the host,
the reverse proxy, or the network link acts before any of these can.

| Bound                                        | Exhaustion path it addresses                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| per-device and per-IP session caps           | One client population monopolising session slots.                                                                                                                   |
| pending-dial reservations                    | Concurrent connect frames all passing limit checks during the window before anything has been counted as established.                                               |
| global session cap (unset by default)        | Total sessions exceeding host capacity regardless of source distribution.                                                                                           |
| clientless-session reaping                   | Detached sessions accumulating after clients disappear. Capacity stays accounted for during the resume window, then is released.                                    |
| per-connection and per-address message rates | Frame floods, from one connection or spread across several from the same address.                                                                                   |
| Telnet subnegotiation cap                    | A hostile or broken MUD growing an unterminated subnegotiation without bound.                                                                                       |
| output buffer cap                            | Replay history growing without bound; an over-large chunk is refused rather than evicting useful history.                                                           |
| heartbeat                                    | Half-open sockets held by peers that vanished without closing.                                                                                                      |
| App Attest challenge and key stores          | Nonce issuance and attested-key registration as memory-growth vectors; both are capped and time-bounded, and saturation evicts oldest rather than refusing service. |
| shutdown deadline                            | A hung teardown step blocking process exit indefinitely.                                                                                                            |

## TLS boundaries

**Client-to-proxy TLS and proxy-to-MUD TLS are independent.** Neither implies
the other. A deployment can be flawless on the browser side and entirely
plaintext upstream.

`MUD_TLS_MODE` governs the upstream hop, and since one shared transport
connector serves both wire protocols, it governs typed and legacy connections
identically. This was not always so: before v4 shipped, legacy connections
ignored the setting and were always plaintext.

**`plain`** never attempts TLS. This is not a downgrade; it is a configured
choice, and it is logged as such.

**`prefer`** (default) attempts TLS and falls back to plaintext **at most
once**, on any of four triggers:

1. a classified TLS negotiation error — evidence the peer does not speak TLS;
2. the peer closing the connection during the handshake, which is how a
   plaintext server typically answers a ClientHello;
3. the four-second TLS handshake deadline expiring, which bounds a peer that
   accepts TCP and then ignores the ClientHello;
4. **certificate validation failure.**

The fourth deserves emphasis. Very few MUDs present a certificate signed by a
publicly trusted authority, so an untrusted or self-signed certificate — and
therefore a downgrade to plaintext — is the _common_ outcome against a
TLS-capable MUD, not an edge case. `prefer` is downgradeable by an active
network attacker for the same reason: any of these four conditions can be
induced by someone on the path.

Errors that are not evidence about TLS — `ECONNREFUSED`, `ENOTFOUND`, and other
transport codes — fail the connection rather than triggering a fallback. An
unclassifiable error is treated as not-evidence and does not permit plaintext.

**`required`** refuses plaintext under every one of those four conditions,
including the handshake deadline. There is no per-target exception.

The four-second handshake deadline is distinct from the twelve-second Telnet
negotiation timer, which starts only after a connection is established and has
nothing to do with transport selection.

Certificate identity is checked against the hostname the client requested, not
the address dialled, so validation still means something in `arbitrary` mode
where the two differ. A target given as a bare IP literal is dialled without
SNI, because an IP is not a valid server name.

## In-scope and out-of-scope threats

**In scope:**

- unauthenticated or malicious remote clients;
- authenticated clients attempting prohibited targets or resource exhaustion;
- spoofed forwarding headers and hostile browser origins;
- active network attackers on plaintext or downgradeable hops;
- malicious or compromised MUD servers sending hostile protocol data.

**Out of scope:**

- a hostile operator, or compromise of the host the proxy runs on;
- client-side rendering vulnerabilities in the consuming MUD client;
- independent cryptographic assurance for the experimental App Attest verifier
  — its implementation has not been reviewed, and no claim is made that attacks
  against it are absent;
- volumetric attacks that exhaust the host, reverse proxy, or network before
  process-level limits can act.

**Who owns which mitigation:**

- _mud-web-proxy_ owns runtime target authorization, configured
  application-level authentication, Origin policy, protocol caps, session and
  rate limits, and outbound TLS-mode behaviour.
- _The reverse proxy and host_ own public TLS termination, forwarding-header
  replacement, network exposure, and process isolation.
- _Operators_ own secret distribution, policy selection, certificates, trusted
  proxy ranges, and destination allowlists.
- _Client applications_ own safe rendering and handling of untrusted MUD data.

A control listed under one owner is not provided by the others. In particular,
nothing in the application substitutes for a correctly configured edge.

## Known limitations and residual risks

- **Sessions and limiter state are memory-local.** One process is one replica.
  There is no distributed coordination and no shared quota, so running more
  than one replica multiplies every limit by the replica count.
- **Restarts discard state.** Sessions, resume buffers, and rate-limiter
  windows do not survive a restart.
- **Shared secrets identify entitlement, not users.** There is no per-user
  credential, no revocation of an individual client, and no audit trail tying
  activity to a person.
- **Preferred outbound TLS is downgradeable**, and in practice downgrades
  against most TLS-capable MUDs because of certificate trust — see
  [TLS boundaries](#tls-boundaries).
- **There is no upstream certificate-trust configuration.** No custom CA, no
  certificate pinning, and no `rejectUnauthorized` control. `MUD_TLS_MODE=required`
  therefore succeeds only against certificates already trusted by the runtime's
  CA store, which few MUDs have. `NODE_EXTRA_CA_CERTS` is a Node runtime
  mechanism an operator may apply to the process; it is not a feature of this
  proxy and is not tested as one.
- **App Attest is experimental and unreviewed.** Pair it with shared-secret
  authentication rather than relying on it alone.
- **Untrusted MUD output is relayed verbatim** and must be rendered safely by
  the client.
- **No global session cap by default.** Per-IP limits do not bound a
  distributed client population; set `MAX_SESSIONS_GLOBAL` in production.

## Evidence and regression-coverage ledger

Every material claim above maps to an implementation path and, where one
exists, to a regression test whose assertions directly exercise it. A test
appears in the third column only after its assertions were read and confirmed;
otherwise the row reads `None found` and names the missing coverage. Gaps are
tracked on MWP-122.

| Claim or control                                                                                                                     | Source implementation                                                         | Existing regression evidence                                                                                                                                                                    | Phase 4 gap                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Inbound TLS fails closed; non-loopback plaintext needs acknowledgement; broken certificate material aborts startup                   | `src/runtime-config.ts`, `wsproxy.ts`                                         | `tests/config-security-guards.test.ts`, `tests/inbound-tls-material.test.ts`                                                                                                                    | —                                                                                                     |
| Fixed and allowlist targets deny anything not explicitly permitted, including case and trailing-dot variants                         | `src/runtime-config.ts`, `src/target-policy.ts`, `src/session-integration.ts` | `tests/target-policy-modes.test.ts`, `tests/config-security-guards.test.ts`                                                                                                                     | —                                                                                                     |
| Arbitrary targets require enforced auth and allowed ports, reject reserved resolution results, and dial the validated address        | `src/runtime-config.ts`, `src/target-policy.ts`, `src/session-integration.ts` | `tests/target-mode-guard.test.ts`, `tests/target-policy-modes.test.ts`, `tests/connect-path-dns.test.ts`                                                                                        | —                                                                                                     |
| Shared-secret upgrade authorization, query opt-in, and bounded failed-auth tracking                                                  | `src/wsproxy-utils.ts`, `wsproxy.ts`                                          | `tests/shared-secret-auth.test.ts`, `tests/config-security-guards.test.ts`                                                                                                                      | —                                                                                                     |
| Secret comparison is constant-time                                                                                                   | `src/wsproxy-utils.ts`                                                        | `None found`                                                                                                                                                                                    | Replacing `timingSafeEqual` with `===` passes the entire suite; nothing pins the comparison primitive |
| Exact Origin policy, wildcard rejection, and missing-Origin behaviour                                                                | `src/runtime-config.ts`, `src/wsproxy-utils.ts`, `wsproxy.ts`                 | `tests/origin-checking.test.ts`                                                                                                                                                                 | —                                                                                                     |
| Forwarded identity is accepted only from configured peers, and per-IP accounting follows it                                          | `src/runtime-config.ts`, `src/wsproxy-utils.ts`, `wsproxy.ts`                 | `tests/trusted-proxy.test.ts`, `tests/trusted-proxy-config.test.ts`, `tests/trusted-proxy-startup.test.ts`, `tests/ip-counting.test.ts`                                                         | —                                                                                                     |
| The systemd topology keeps plaintext on loopback behind one trusted hop and overwrites both client-IP headers                        | `config/mud-web-proxy.env.systemd.example`, `deploy/caddy/Caddyfile.example`  | `tests/deployment/systemd-contract.test.ts`                                                                                                                                                     | —                                                                                                     |
| The Compose topology trusts only `172.28.0.0/24` and its Caddyfile replaces the forwarding headers                                   | `compose.yaml`, `Caddyfile`                                                   | `None found`                                                                                                                                                                                    | No Compose deployment contract test; the systemd equivalent has one, Compose does not                 |
| Pending, per-IP, per-device, global, and clientless-session capacity is bounded and released                                         | `src/session-manager.ts`, `src/session-integration.ts`                        | `tests/pending-dial-reservation.test.ts`, `tests/dial-reservation-handoff.test.ts`, `tests/ip-counting.test.ts`, `tests/global-session-cap.test.ts`, `tests/clientless-session-reaping.test.ts` | —                                                                                                     |
| Per-connection and per-address frame rates are both enforced with bounded bookkeeping                                                | `src/message-rate-limit.ts`, `wsproxy.ts`                                     | `tests/message-rate-limit.test.ts`                                                                                                                                                              | —                                                                                                     |
| Telnet subnegotiation and resume history have byte caps                                                                              | `src/telnet-parser.ts`, `src/circular-buffer.ts`, `src/session.ts`            | `tests/telnet-subneg-cap.test.ts`, `tests/circular-buffer-cap.test.ts`                                                                                                                          | —                                                                                                     |
| Heartbeat reclaims silent peers exactly once                                                                                         | `src/heartbeat.ts`, `wsproxy.ts`                                              | `tests/heartbeat.test.ts`                                                                                                                                                                       | —                                                                                                     |
| Required MUD TLS never downgrades; preferred TLS falls back at most once on a classified trigger; both protocols share one connector | `src/mud-transport.ts`, `src/session.ts`, `wsproxy.ts`                        | `tests/mud-transport.test.ts`, `tests/mud-tls-mode.test.ts`, `tests/tls-servername.test.ts`, `tests/session-lifecycle.test.ts`, `tests/e2e/legacy-protocol.test.ts`                             | —                                                                                                     |
| Diagnostics are disabled by default and accept the admin token only when enabled                                                     | `src/runtime-config.ts`, `src/wsproxy-utils.ts`, `wsproxy.ts`                 | `tests/open-source-regressions.test.ts`, `tests/wsproxy-utils.test.ts`                                                                                                                          | —                                                                                                     |
| Logs redact configured secrets and neutralize hostile control text                                                                   | `src/log-redaction.ts`, `wsproxy.ts`                                          | `tests/log-redaction.test.ts`                                                                                                                                                                   | —                                                                                                     |
| App Attest is optional, required-auth configuration fails closed, challenge and key state is bounded, bypass names are inert         | `src/runtime-config.ts`, `src/app-attest.ts`, `wsproxy.ts`                    | `tests/app-attest-optional.test.ts`, `tests/attest-route-gating.test.ts`, `tests/app-attest-nonce.test.ts`, `tests/app-attest-store-bounds.test.ts`, `tests/app-attest-writable-state.test.ts`  | No test asserts the verifier's cryptographic correctness; it remains unreviewed                       |
| Ordered shutdown has an absolute deadline and flushes state                                                                          | `src/shutdown.ts`, `wsproxy.ts`                                               | `tests/shutdown.test.ts`                                                                                                                                                                        | —                                                                                                     |

The `ONLY_ALLOW_DEFAULT_SERVER` cases in `tests/security.test.ts` are **not**
evidence for the v4 target-policy contract. That setting was removed and now
fails startup; those cases exercise a shape that no longer exists.
