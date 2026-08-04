# MWP-134 Legacy Required-TLS Fail-Closed Design

## Goal

Close the urgent fail-open in the legacy connection path without attempting
the larger transport refactor. When an operator sets
`MUD_TLS_MODE=required`, a legacy client must be rejected before the proxy
authorizes or dials an upstream target. No plaintext upstream connection may
be attempted.

This stopgap does not make legacy connections TLS-capable. The shared
transport connector is separate work tracked by MWP-135.

## Context and root cause

The active legacy `{connect: ...}` path and the typed session path share target
authorization but not transport selection:

1. `wsproxy.ts` parses a legacy connect frame and calls
   `srv.openLegacyConnection()`.
2. `openLegacyConnection()` delegates target policy, capacity reservation,
   and DNS-rebinding protection to `SessionIntegration.authorizeConnect()`.
3. On success it calls `srv.initT()` with the validated dial address.
4. `initT()` unconditionally calls `net.createConnection()`.
5. The TLS state machine that reads `MUD_TLS_MODE` exists only in
   `Session.connect()`.

The result is a security-policy violation: legacy traffic is sent over
plaintext even when the operator explicitly required upstream TLS.

The complete correction requires one shared transport connector. That work
also needs settled-socket-only handoff, independent SNI and dial-address
inputs, a TLS-handshake deadline, reachable cancellation, injected logging,
and focused state-machine tests. Shipping that state machine under an Urgent
label would increase the time and regression risk of closing the narrow
fail-open. MWP-134 therefore fails closed first; MWP-135 implements transport
parity afterward.

## Scope

### In scope

1. Reject a legacy connect at the beginning of
   `srv.openLegacyConnection()` when `runtimeConfig.mudTlsMode` is
   `required`.
2. Send the rejection using the existing legacy base64 framing and close the
   client through `srv.rejectLegacy()`.
3. Add one process-level regression proving the rejection text, downstream
   socket closure, and absence of any upstream connection attempt.
4. Extend the mock MUD with a cumulative accepted-connection counter so a
   short-lived connection cannot escape the assertion.
5. Describe the fix precisely in the PR title and release-note line.

### Out of scope

- Adding TLS support to legacy connections.
- Changing legacy behavior under `MUD_TLS_MODE=plain` or
  `MUD_TLS_MODE=prefer`.
- Moving TLS/plain selection out of `Session.connect()`.
- Adding a TLS-handshake deadline or cancellation handle. Those belong to
  MWP-135 because MWP-134 never starts a TLS handshake.
- Changing `srv.initT()`, the typed session path, target authorization,
  capacity accounting, Telnet negotiation, or data framing.
- Removing or repairing `srv.newSocket()`. Current static references show
  that helper is not wired into the production WebSocket server; tests call
  it directly. It remains untouched.
- Operator configuration, migration, or security-documentation changes. The
  existing configuration reference already states the intended proxy-wide
  contract, and MWP-112 remains paused until MWP-135 makes it true for
  `prefer` as well.

## Runtime behavior

`srv.openLegacyConnection()` will begin with this policy decision, before its
existing `s.ts || sessionIntegration.hasSession(s)` duplicate guard:

- If `runtimeConfig.mudTlsMode === 'required'`, call
  `srv.rejectLegacy(s, reason)` and return.
- The exact reason is:
  `Legacy connections are unavailable when MUD_TLS_MODE=required.`
- Otherwise, continue through the existing function without modification.

The ordering is deliberate. Required mode cannot produce a valid legacy
upstream connection, so the function must reject before duplicate detection,
target authorization, pending-dial reservation, DNS resolution, established
capacity accounting, or `initT()`. A typed session that subsequently sends a
legacy connect frame may receive the policy message instead of the duplicate
message; that edge case does not weaken either policy and does not justify
moving the security check later.

`srv.rejectLegacy()` remains unchanged. It writes the reason as bare base64,
which is the only framing legacy clients understand, and calls
`srv.closeSocket()` after `SOCKET_CLOSE_DELAY_MS`, currently 500 milliseconds.

The mode behavior after this PR is intentionally asymmetric:

| Mode       | Typed session                        | Legacy connection                                  |
| ---------- | ------------------------------------ | -------------------------------------------------- |
| `plain`    | Plain TCP                            | Plain TCP, unchanged                               |
| `prefer`   | TLS first with classified fallback   | Plain TCP without a TLS attempt, unchanged         |
| `required` | TLS only; failure does not fall back | Rejected before authorization or any upstream dial |

This table is the exact security scope of MWP-134. MWP-135 removes the
remaining `prefer` and `required` capability asymmetry.

## Test-harness change

`MockMUDServer.getClientCount()` reports only the number of currently open
clients. It cannot prove that no connection occurred: a connection that opens
and closes before the assertion returns the count to its original value.

The mock will therefore gain one cumulative counter:

- initialize it to zero on each `MockMUDServer` instance;
- increment it synchronously at the start of `handleConnection()`;
- expose it through a read-only `getAcceptedConnectionCount()` accessor;
- do not decrement it when a client disconnects or when `stop()` clears the
  active-client map.

This is observation only. It does not change the mock protocol or reset
behavior, and existing `getClientCount()` assertions remain valid. In this
controlled test the mock is already listening and accepts every proxy dial, so
an unchanged accepted-connection count proves that the proxy made no upstream
connection attempt.

## Process-level regression

The regression belongs in `tests/e2e/legacy-protocol.test.ts`, which is run by
`bun run test:e2e:mock`. Unit tests over parsing or a copied server mock cannot
prove that the live legacy path neither dials the MUD nor leaves the WebSocket
open.

The test gets a dedicated mock-MUD port and proxy port so it cannot share
process state with the existing plain-mode or shared-secret suites. Setup will:

1. start the existing plaintext mock MUD;
2. record its cumulative connection-attempt count;
3. call `startTestProxy()` with `MUD_TLS_MODE: 'required'` explicitly, because
   the launcher deliberately defaults existing E2E coverage to `plain`;
4. open a raw WebSocket and attach frame and close observers before sending
   `{ connect: 1, host: 'localhost', port: mudPort }`.

The test will then wait up to 3 seconds for the close event, comfortably longer
than `SOCKET_CLOSE_DELAY_MS`. After closure it must assert all three outcomes:

1. decoded legacy frames contain
   `Legacy connections are unavailable when MUD_TLS_MODE=required.`;
2. the client WebSocket reached the closed state rather than hanging;
3. the mock MUD's cumulative connection-attempt count is unchanged.

Asserting only the upstream count is insufficient because a broken
implementation could silently discard the connect frame and leave the player
hanging. Asserting only the message and close is insufficient because the
proxy could reject after it had already opened a plaintext connection.

The current code must fail this regression: it reaches `initT()`, increments
the mock's cumulative counter, and does not emit the required-mode rejection.

## Release-note contract

The PR title and release-note line must describe a required-mode fail-open,
not general legacy TLS support. Approved wording is:

> Fail closed for legacy connections when `MUD_TLS_MODE=required`; legacy TLS
> support and `prefer`-mode TLS-first behavior remain tracked separately.

The PR body must additionally state:

- required-mode legacy clients that connected over plaintext before this fix
  will now be rejected, including when the target MUD supports TLS;
- `prefer` deployments continue to send legacy traffic over plaintext without
  a TLS attempt until MWP-135 lands;
- `plain` behavior is unchanged.

The title or release note must not say that legacy connections now "honor
`MUD_TLS_MODE`" without those qualifications.

## Verification

Implementation will follow test-driven development: add the cumulative mock
counter and the failing process regression first, confirm that it fails for
the expected plaintext dial, then add the required-mode guard.

Focused verification:

```bash
bun test tests/e2e/legacy-protocol.test.ts
```

Repository verification:

```bash
bun run format
bun run check:defect-classes
bun run typecheck
bun run lint
bun run test:unit
bun run test:e2e:mock
bun run build
```

## Success criteria

MWP-134 is complete when:

- the required-mode guard runs before every other operation in the live
  legacy connect path;
- a legacy client receives the exact actionable rejection in legacy framing;
- that client is closed after the existing 500-millisecond delay;
- the plaintext mock proves that no upstream connection was accepted;
- `plain` and `prefer` legacy behavior is unchanged;
- no typed-session, transport-state-machine, authorization, capacity, or
  operator-documentation code changes;
- the PR and release-note wording state the fix's narrow fail-closed scope;
- all focused and repository verification commands pass.

MWP-112 remains blocked after MWP-134. Only MWP-135 makes the documented
proxy-wide TLS behavior true for legacy `prefer` connections.
