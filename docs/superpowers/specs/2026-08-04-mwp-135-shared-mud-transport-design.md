# MWP-135 Shared MUD Transport Design

## Goal

Make `MUD_TLS_MODE` govern every live upstream MUD connection by moving
TLS/plain transport selection into one connector shared by typed sessions and
legacy clients. The connector must preserve the consumers' separate protocol
and lifecycle behavior while enforcing four properties:

1. a consumer receives only the final connected socket;
2. `required` can never open or fall back to plaintext;
3. `prefer` can fall back at most once and only for an allowed trigger; and
4. closing either consumer during connection setup destroys the provisional
   upstream socket.

This completes the transport capability that MWP-134 deliberately deferred.
It makes the existing proxy-wide `MUD_TLS_MODE` documentation true without
changing the setting or adding a migration mechanism.

## Context and root cause

The proxy currently shares target authorization but not upstream transport:

1. Typed connects pass through `SessionIntegration.dialSession()` and then
   `Session.connect()`.
2. `Session.connect()` implements TLS selection, SNI, classified
   `prefer`-mode fallback, and `required`-mode refusal.
3. Legacy connects pass through the same `authorizeConnect()` policy but then
   call `srv.initT()`.
4. `initT()` calls `net.createConnection()` directly and never reads
   `MUD_TLS_MODE`.

MWP-134 closed the urgent required-mode fail-open by rejecting every legacy
connect before authorization or dial. That stopgap prevents plaintext but
also prevents a legacy client from reaching a TLS-capable MUD. It leaves
`prefer` legacy traffic permanently plaintext.

Moving legacy clients into `Session` is not a valid correction. `Session`
owns typed JSON envelopes, persistent credentials, buffering, resume, and
notification lifecycle. Legacy clients consume bare base64 frames and have no
session token. Transport policy is the shared concern; the consumers' data
planes are intentionally different.

## Scope

### In scope

1. Add one transport module used by `Session.connect()` and `srv.initT()`.
2. Move TLS attempt/fallback classification and SNI selection out of
   `session.ts` into that module.
3. Add a dedicated 4,000-millisecond TLS-handshake deadline.
4. Give each consumer a caller-owned `AbortController` whose signal is passed
   to the connector.
5. Hand the final socket to the consumer synchronously and exactly once.
6. Remove the MWP-134 legacy required-mode stopgap after legacy TLS is wired.
7. Preserve typed and legacy framing, Telnet behavior, capacity accounting,
   logging layers, and post-connect lifecycle.
8. Add transport unit coverage and process-level legacy regressions.
9. State the default-`prefer` behavior and latency change in the PR and
   release-note text.
10. Close the pre-existing duplicate-legacy-dial race by using the pending
    transport controller as a synchronous latch before target authorization.

### Out of scope

- Changing target authorization, DNS-rebinding protection, authentication,
  or capacity limits.
- Combining typed and legacy session/data-plane implementations.
- Adding an operator-configurable handshake timeout.
- Reusing or renaming `PROTOCOL_NEGOTIATION_TIMEOUT_MS`.
- Changing the default `MUD_TLS_MODE`.
- Adding configuration, migration, or general documentation. Version 4 is the
  first public release, and the existing configuration reference already
  states the intended proxy-wide behavior.
- Deleting or repairing `srv.newSocket()`. Static reachability still shows it
  is not wired into the production WebSocket server. It remains in place and
  mechanically calls the updated `initT()`.
- Correcting the stale pre-existing comment in
  `tests/e2e/legacy-protocol.test.ts` that says the mock sends no greeting.
- Adding an application setting for a private CA, certificate pinning, or
  `rejectUnauthorized`. MWP-112 must document that separate trust-store gap.

## Chosen architecture

Create `src/mud-transport.ts` with an SPDX header in its first 30 lines. It is
a functional connection state machine, not a class and not a second session
layer.

The public contract is:

```typescript
export type MudTransportKind = 'plain' | 'tls';

export interface ConnectedMudTransport {
  socket: TelnetSocket;
  transport: MudTransportKind;
  downgraded: boolean;
}

export interface MudTransportOptions {
  requestedHost: string;
  dialAddress: string;
  port: number;
  mode: MudTlsMode;
  signal: AbortSignal;
  onDowngrade: (reason: string) => void;
  onConnected: (connection: ConnectedMudTransport) => void;
}

export function connectMudTransport(
  options: MudTransportOptions,
): Promise<void>;
```

The caller creates and retains the `AbortController`; the connector receives
only its signal. The connector owns every socket until it invokes
`onConnected`. It invokes that callback synchronously once, after the final
transport has connected, so the consumer can attach its long-lived error,
close, and data handlers before the event loop runs again. The promise
resolves only after the callback returns.

Returning the socket only through a promise was rejected. `await` introduces
a microtask gap after connection but before consumer handler attachment. A
temporary error guard could bridge it, but that cleanup ordering would be
subtle in precisely the part of the design where handler order determines
whether `prefer` works. A callback makes the handoff atomic and explicit.

A `MudTransportDial` class with separate `connected` and `abort` methods was
also rejected. `AbortController` already expresses cancellation ownership;
the class would add lifecycle API without adding a capability.

## Transport state machine

The connector tracks one current provisional socket, one optional handshake
deadline, whether plaintext has been tried, and whether it has settled. Every
transition removes only the connector's listeners and clears the deadline
before destroying, replacing, rejecting, or handing off a socket. The settled
guard makes a later error-plus-close sequence inert.

### Plain mode

1. Call `net.createConnection(port, dialAddress)` once.
2. Treat the TCP socket as provisional until its `connect` event.
3. On `connect`, hand it off as
   `{ transport: 'plain', downgraded: false }`.
4. An error, close before connect, synchronous dial exception, or abort rejects
   without any other dial.
5. Do not call `onDowngrade`; explicit plaintext is not a downgrade.

### Prefer mode

1. Call `tls.connect(port, dialAddress, { servername })`, where `servername`
   is derived from `requestedHost`, not `dialAddress`.
2. On the TLS socket's TCP `connect` event, arm the internal handshake
   deadline for exactly 4,000 milliseconds.
3. On `secureConnect`, clear the deadline and hand the socket off as
   `{ transport: 'tls', downgraded: false }`.
4. On a classified TLS negotiation error, close before `secureConnect`, or
   handshake deadline:
   - remove the TLS connection listeners;
   - clear the deadline;
   - destroy the provisional TLS socket;
   - mark the connection downgraded;
   - call `onDowngrade(reason)` exactly once; and
   - call `net.createConnection()` exactly once.
5. Hand the fallback socket off on TCP `connect` as
   `{ transport: 'plain', downgraded: true }`.
6. A generic transport failure such as ordinary `ECONNREFUSED`,
   `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, or
   `ENETUNREACH` rejects without plaintext fallback.
7. Failure of the single plaintext fallback rejects. It never starts another
   TLS or plaintext attempt.

The existing TLS diagnostic classification, including Node's
"disconnected before secure TLS connection was established" exception to
the generic `ECONNRESET` rule, moves unchanged from `session.ts`.

### Required mode

Required mode performs the same TLS dial, SNI selection, and deadline setup as
`prefer`, but no failure transition can call the plaintext dial:

- a TLS error rejects;
- close before `secureConnect` rejects;
- the handshake deadline destroys the TLS socket and rejects; and
- abort destroys the TLS socket and rejects.

The connector wraps required-mode connection failures in policy-specific
errors. Stable user-facing messages include:

```text
MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.
MUD_TLS_MODE=required: TLS handshake timed out after 4000ms and plaintext fallback is not permitted.
```

The underlying error remains available for server logging, but the stable
policy text does not depend on Node's platform-specific TLS diagnostics.

## Handshake deadline

Define a module-private `TLS_HANDSHAKE_TIMEOUT_MS = 4_000`. It is neither an
environment variable nor an alias of
`PROTOCOL_NEGOTIATION_TIMEOUT_MS = 12_000`.

The handshake deadline starts on the TLS socket's TCP `connect` event rather
than when `tls.connect()` is called. It therefore bounds a peer that accepted
TCP and then ignored the ClientHello. TCP establishment remains governed by
the operating system's connection behavior and error events.

The deadline is cleared on secure connection, failure transition, abort, and
every terminal path. In `prefer`, expiry is an explicit allowed downgrade
trigger even though a generic `ETIMEDOUT` transport error is not. In
`required`, expiry is always terminal.

The 12-second Telnet negotiation timer remains consumer-owned. It begins only
after the connector hands off a connected socket and does not affect TLS
selection.

## Cancellation and ownership

### Connector

The connector registers one abort listener with `{ once: true }`. If the
signal is already aborted, it rejects without dialing. If it becomes aborted
while a socket is provisional, the connector:

1. marks the operation settled;
2. removes its socket and signal listeners;
3. clears the handshake deadline;
4. destroys the provisional socket;
5. suppresses downgrade logging and fallback; and
6. rejects once with `MUD transport connection aborted`.

Before successful handoff, the connector removes its abort and handshake
listeners. It invokes `onConnected` synchronously. If the callback throws, the
connector destroys the newly connected socket and rejects so no live socket
is left unowned.

### Typed session

`Session.connect()` creates an `AbortController`, stores it on the `Session`,
and passes its signal to the connector before any dial. Its handoff callback:

1. assigns the final socket to `this.telnet`;
2. copies the result's `downgraded` value to `this.tlsDowngraded`;
3. attaches the existing Telnet data, error, and close handlers;
4. sets `telnetConnected`; and
5. clears the stored controller.

`Session.close()` aborts and clears a pending controller before closing an
already handed-off Telnet socket. Delete the `closing` field and every read,
reset, and write of it. Once the controller owns connection cancellation, the
field has no readers; retaining the write in `close()` would create the same
write-only private-field defect that the repository gates already reject.

### Legacy connection

Both `SocketExtended` declarations gain an optional
`pendingMudTransport?: AbortController` so their duplicated shape remains
aligned. This field is both cancellation owner and duplicate-connect latch.

`openLegacyConnection()` must not wait until `initT()` to set it. Its current
`s.ts || sessionIntegration.hasSession(s)` guard precedes an asynchronous
`authorizeConnect()` call, so two connect frames delivered in one turn can
both pass before `s.ts` exists. Settled-socket-only handoff would widen that
pre-existing race through TCP establishment and as much as four seconds of
TLS negotiation.

The live path therefore:

1. rejects when `s.ts`, `s.pendingMudTransport`, or a typed session exists;
2. creates and stores the controller synchronously, before the first `await`;
3. calls `authorizeConnect()`;
4. clears the exact controller on every pre-dial denial or failure;
5. after authorization, checks whether client closure aborted the controller;
6. if aborted, releases any pending-dial reservation and returns before
   established capacity is incremented; and
7. otherwise converts capacity and passes the already stored controller into
   `initT()` through the socket field.

`initT()` reads the existing controller. Its production-dead direct caller
may still reach it without one, so `initT()` creates and stores a controller
only as a fallback for that call shape. Until successful handoff, `s.ts`
remains `undefined`.

`srv.closeSocket()` keeps its existing handed-off socket behavior. When
`s.ts` is absent and a pending controller exists, it aborts and clears the
controller before closing the WebSocket and releasing capacity. This makes
client closure during TLS negotiation reach the only object that owns the
provisional socket.

The handoff callback assigns `s.ts` and clears the pending controller before
attaching the legacy handlers. A rejected aborted operation does not send a
second player-visible error or schedule a second close.

The PR body must identify the duplicate-connect race as pre-existing and
explain why fixing it belongs here: the connector removes `s.ts` as an
in-flight latch and materially widens the old race window. This is not a
general parser or capacity refactor.

## Consumer integration

### Typed `Session`

`Session` keeps its data parsing, buffering, resume, close observers, and JSON
error envelope. It no longer imports `net` or `tls`; it delegates the dial to
`connectMudTransport()`.

The typed `onDowngrade` callback preserves the existing conspicuous
`[session] WARN ... using plain TCP` message. Explicit `plain` mode retains
its existing informational plaintext log outside `onDowngrade`, because a
configured plaintext connection is not a downgrade.

`Session.setupTelnetHandlers()` remains responsible only for the final
socket. Any `connect` listener that can no longer fire after settled handoff
is removed; `telnetConnected` is set directly during handoff.

### Legacy `initT`

The MWP-134 early check in `openLegacyConnection()` is removed. Authorization,
reservation handoff, `s.host`, `s.port`, and the validated
`decision.dialAddress` continue into `initT()`, with the new synchronous
pending-controller latch described above.

The connector receives:

- `requestedHost`: the authorized requested host stored in `s.host`;
- `dialAddress`: the already validated address from `authorizeConnect()`;
- `port`: the authorized port;
- `mode`: `runtimeConfig.mudTlsMode`; and
- an `onDowngrade` callback using `srv.logWarn(..., s, 'telnet')`.

Legacy connection initialization currently relies on both the
`net.createConnection` callback and a later `.on('connect')` listener. Neither
can remain as a future event: the connector hands off only after `connect` or
`secureConnect` has occurred. The handoff callback therefore immediately:

1. assigns `s.ts`;
2. installs `send`;
3. logs the connected target;
4. arms the 12-second Telnet negotiation timer; and
5. attaches the existing data, timeout, close, and error handlers.

This preserves the legacy data plane while preventing a pre-fallback TLS
socket's close handler from scheduling `closeSocket()` and killing the client
before plaintext is attempted.

### Legacy connection errors

Connection failure before handoff is handled by the connector promise:

- required-mode failures are sent through `rejectLegacy()` using the stable
  policy-specific error text;
- non-required failures retain the existing player message
  `Error: maybe the mud server is down?`; and
- all detailed failures are logged through the existing redacted
  `srv.logError(..., 'telnet')` layer.

For every non-abort rejection, that one promise rejection handler calls
`rejectLegacy()` exactly once. `rejectLegacy()` sends the selected legacy
message and schedules `closeSocket(s)` after the existing
`SOCKET_CLOSE_DELAY_MS`. That scheduled close is load-bearing: it closes the
player WebSocket and decrements `legacyCountedIp`. Pre-handoff there is no
socket `.on('error')` handler to do either job. The aborted path sends nothing
and schedules nothing because `closeSocket()` is already executing.

After handoff, existing legacy close/error behavior remains in force.

## Capacity and authorization invariants

Target policy and the pending-versus-established capacity model remain
unchanged. The connector requires these sequencing rules:

- `authorizeConnect()` still produces the distinct requested host and
  validated dial address.
- Typed sessions keep their pending reservation until the connector resolves,
  increment established capacity, then release the reservation. Failure or
  abort releases the pending reservation through the existing catch path.
- Legacy connections still convert the pending reservation to
  `legacyCountedIp` before `initT()`. A non-abort connection failure calls
  `rejectLegacy()` exactly once, whose delayed `closeSocket()` decrements the
  established count exactly once. Client-driven abort is initiated by
  `closeSocket()` itself and therefore needs no second scheduled close.
- A client that closes while authorization is pending aborts the latch. If
  authorization subsequently returns an allowed decision, the path releases
  its pending reservation and returns before creating `legacyCountedIp`.
- Neither consumer re-resolves `requestedHost`; all socket calls use
  `dialAddress`.

## Test design

### Transport unit tests

Add `tests/mud-transport.test.ts`, following the existing pattern that
monkeypatches `tls.connect` and `net.createConnection` with event-emitting
mock sockets. Restore every patched global/module function after each test.

The file proves:

1. `plain` opens one TCP socket, opens no TLS socket, and hands off once.
2. `prefer` TLS success opens no plaintext socket.
3. TLS dials `dialAddress` while presenting SNI derived from
   `requestedHost`.
4. A classified TLS error and a pre-handshake close each destroy the
   provisional TLS socket, log once, open one plaintext fallback, and expose
   only the final socket.
5. Error-plus-close races and repeated events cannot open a second fallback or
   invoke either callback twice.
6. Generic transport errors reject without downgrade.
7. Required-mode error, close, and deadline paths open no plaintext socket.
8. The deadline is armed with exactly 4,000 milliseconds on TCP `connect`,
   not before it, and is independent of Telnet negotiation.
9. Abort during TLS and plain connection setup destroys the provisional
   socket, suppresses logging/fallback/handoff, and rejects once.
10. A throwing `onConnected` callback destroys the connected socket and
    rejects.

Bun's current fake-timer compatibility does not advance timers, so the
deadline tests must not sleep for four seconds. They temporarily stub
`globalThis.setTimeout`, capture the requested delay, and invoke the callback
under test control. Production does not gain a timeout-injection option merely
to support tests.

The existing `tests/mud-tls-mode.test.ts` and
`tests/tls-servername.test.ts` update their imports to the new transport
module. Focused `Session` tests retain consumer-level proof of final-socket
handoff and add proof that `Session.close()` aborts a stalled connection.

### Process-level legacy regressions

Extend `tests/e2e/legacy-protocol.test.ts` with isolated proxy/MUD pairs and
explicit TLS modes. Existing general legacy coverage remains on the launcher's
`plain` default, so its behavior and timing do not change.

The mock's cumulative accepted-connection counter must count raw TCP accepts,
including connections that never finish a TLS handshake. A `tls.Server`
listener passed to `tls.createServer()` runs on `secureConnection`, which is
too late for this invariant. Move the cumulative increment from
`handleConnection()` to the server's raw `connection` event and remove the old
increment so plaintext behavior is unchanged and TLS attempts are not double
counted. [Node's TLS documentation](https://nodejs.org/api/tls.html#event-connection)
specifies that `tls.Server` emits `connection` before the TLS handshake
begins.

#### Prefer against a plaintext MUD

Use dedicated ports 6327 and 6328. Start the existing plaintext mock with
`MUD_TLS_MODE=prefer`, a matching `TN_HOST=localhost`, and its exact
`TN_PORT`. For one legacy connect:

1. the cumulative accepted-connection counter increases by exactly two: one
   TLS probe and one plaintext fallback;
2. the client WebSocket remains open after the provisional TLS socket closes;
3. raw player input reaches the MUD; and
4. MUD output reaches the player in legacy base64 framing, not a typed JSON
   envelope.

The exact cumulative count proves there is no second fallback dial.

#### Prefer against a trusted TLS MUD

Use dedicated ports 6331 and 6332. Extend `MockMUDServer` with optional TLS
key/certificate material; `start()` uses `tls.createServer()` when it is
present and passes the resulting `TLSSocket` to the existing
`handleConnection()` data plane after a successful handshake. Plain mocks
continue to use `net.createServer()`.

Generate a one-day localhost certificate and private key in a temporary
directory with `openssl`, including `DNS:localhost` in the subject alternative
name. Do not commit private-key material. Extend `ProxyConfig` and
`startTestProxy()` to pass an optional `NODE_EXTRA_CA_CERTS` path into the
spawned proxy, then point it at the generated certificate. The proxy process
must genuinely trust the test certificate; disabling verification is not an
acceptable test setup.

One legacy `prefer` connection must:

1. increase the raw accepted-connection counter by exactly one;
2. keep one secure mock client connected;
3. deliver a raw player command through the proxy to the TLS mock; and
4. return the MUD response in legacy base64 framing, never a typed JSON
   envelope.

The exact count is essential. The unchanged fallback classifier treats
`certificate` and `unable to verify` diagnostics as downgrade triggers. If the
proxy does not trust the certificate, it will attempt plaintext after TLS;
the raw counter becomes two and the test fails instead of vacuously proving
only fallback. Counting raw `connection` events ensures the second attempt is
observed even though plaintext cannot complete a TLS handshake.

#### Required against a plaintext MUD

Keep the existing dedicated ports 6325 and 6326, but replace the MWP-134
stopgap expectation. One legacy connect must:

1. increase the cumulative accepted count by exactly one TLS connection;
2. receive the required-mode policy failure in legacy framing;
3. close the client WebSocket; and
4. open no plaintext fallback.

The typed discriminator against the same proxy continues to require exactly
one accepted TLS connection, a JSON `connection_failed` envelope, and no
legacy rejection framing.

#### Client closure during a stalled handshake

Use dedicated ports 6329 and 6330. A small TCP test server accepts a connection
but sends nothing, so the TLS handshake remains pending. The test:

1. starts a `prefer` proxy pointed at that server;
2. opens a legacy connect and waits until exactly one upstream socket is
   accepted;
3. closes the client WebSocket before the 4-second deadline;
4. observes the accepted upstream socket close before the deadline; and
5. asserts the cumulative accepted count remains one, proving abort did not
   trigger plaintext fallback.

This process test proves the consumer wiring from `closeSocket()` to the
stored controller. The connector unit test alone cannot prove that the live
legacy path retained a reachable abort handle.

#### Duplicate legacy frames during authorization

Against the handshake-stall fixture, send two valid legacy connect frames in
the same turn. The unfixed code permits two authorization/dial paths because
`s.ts` is still absent. The fixed path must accept exactly one raw upstream
connection, reject the duplicate in legacy framing, close the client, and
leave zero active upstream sockets. This test makes the synchronous pending
controller a behavioral contract rather than an untested field.

## Release-note contract

The PR title must use a `fix:` prefix because this corrects live transport
policy, not documentation. The PR body and release-note line must state:

> Legacy connections now use the shared `MUD_TLS_MODE` transport. The default
> `prefer` mode attempts TLS first and falls back to plaintext at most once
> when the peer appears plaintext, the handshake deadline expires, or TLS
> negotiation/certificate validation fails—including an untrusted or
> self-signed certificate. Plaintext-only MUDs may incur up to four seconds of
> handshake latency before fallback. `required` never opens plaintext.

Do not describe the deadline as Telnet negotiation and do not imply that
fallback is possible under `required`.

## Verification

Implementation follows test-driven development. Each state-machine or
consumer change begins with a focused failing regression whose failure proves
the intended defect, followed by the minimum production change.

Focused loops:

```bash
bun test tests/mud-transport.test.ts
bun test tests/mud-tls-mode.test.ts tests/tls-servername.test.ts tests/session-lifecycle.test.ts
bun test tests/e2e/legacy-protocol.test.ts
```

Repository verification:

```bash
bun run preflight:full
```

`preflight:full` is the sole repository-level gate list. It derives its
coverage from `scripts/preflight.sh`; this design does not duplicate that
evolving list. GitHub CI must be watched to terminal state after publication.

## Success criteria

MWP-135 is complete when:

- typed and legacy consumers call the same transport state machine;
- consumers receive exactly one final connected socket and never a
  provisional TLS socket;
- requested host and validated dial address remain distinct through TLS SNI
  and socket dialing;
- the TLS handshake deadline is independently named and exactly 4,000
  milliseconds;
- caller-owned cancellation destroys every provisional socket and settles
  once;
- the pending controller latches a legacy connect before authorization, so
  duplicate frames cannot create two dials or overwrite `s.ts`;
- legacy WebSocket closure during a stalled handshake reaches that
  cancellation path;
- `required` cannot call the plaintext dial under error, close, deadline, or
  abort;
- `prefer` falls back only for an allowed trigger and at most once;
- provisional TLS failure cannot close the legacy WebSocket before fallback;
- required-mode legacy failures name the TLS policy rather than claiming only
  that the MUD may be down;
- typed and legacy framing, Telnet negotiation, logging, authorization, and
  capacity accounting remain intact;
- a real trusted `TLSSocket` carries a complete legacy command/response round
  trip with exactly one raw upstream connection;
- `srv.newSocket()` remains present and production-dead;
- the PR/release wording calls out the default-`prefer` TLS-first behavior and
  bounded latency change; and
- all focused tests, `preflight:full`, and GitHub CI pass.

After MWP-135 lands, MWP-112 is unblocked and can complete the security model
without qualifying `MUD_TLS_MODE` by client protocol. MWP-112 inherits one
explicit residual trust-store gap: the proxy has no first-class custom-CA,
pinning, or `rejectUnauthorized` configuration. `required` therefore works by
default only for MUD certificates trusted by the runtime's public CA store;
runtime-level mechanisms such as `NODE_EXTRA_CA_CERTS` can extend trust, but
there is no proxy setting for them. The security model must state that
limitation rather than discovering it during documentation work.
