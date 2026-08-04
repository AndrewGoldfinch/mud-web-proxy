# MWP-135 Shared MUD Transport Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Make typed and legacy upstream connections share one abortable
TLS/plain transport state machine so `MUD_TLS_MODE` is enforced consistently,
including a 4-second TLS-handshake deadline and at-most-once `prefer`
fallback.

**Architecture:** Add a functional connector in `src/mud-transport.ts` that
owns provisional sockets and hands a final connected socket to its caller
synchronously. Migrate `Session` and legacy `initT()` onto that connector while
leaving their framing, Telnet handlers, authorization, capacity accounting,
and post-handoff lifecycles separate. Use caller-owned `AbortController`
instances to make provisional sockets cancellable and, on the legacy path, to
latch duplicate connect frames before the first `await`.

**Tech Stack:** TypeScript ES modules, Bun test runner, Node `net`/`tls`, `ws`,
OpenSSL for ephemeral E2E certificates, ESLint with type-aware test linting,
Prettier, GitHub Actions.

**Global Constraints:**

- Follow strict red-green-refactor sequencing. Each behavioral step starts
  with a test that fails for the stated reason; never weaken an assertion to
  obtain green.
- Keep requested host and validated dial address separate. TLS SNI uses the
  requested host; every socket dial uses only the validated address.
- `required` must have no code path to `net.createConnection()`.
- `prefer` may open no more than one plaintext fallback and only after a
  classified TLS negotiation failure, pre-handshake close, or the dedicated
  handshake deadline.
- The connector owns provisional sockets. A consumer sees exactly one final
  connected socket through the synchronous `onConnected` callback.
- Keep `PROTOCOL_NEGOTIATION_TIMEOUT_MS = 12_000` consumer-owned and distinct
  from the new private 4,000-millisecond TLS-handshake deadline.
- Do not add configuration, migration, or general documentation. Version 4 is
  the first public release.
- Do not delete or repair the production-dead `srv.newSocket()` call path.
- Do not correct unrelated stale comments or adjacent defects.
- Every new source file needs an SPDX header in its first 30 lines.
- Tests are included in type-aware ESLint as of `012f6b1`; test helpers and
  monkeypatches must be lint-clean, not merely runnable.
- After each task, inspect `git diff --check`, the focused test output, and the
  staged diff before committing only the files named by that task.

---

### Task 1: Extract transport policy and add the shared connector success paths

**Files:**

- Create: `src/mud-transport.ts`
- Modify: `src/session.ts`
- Create: `tests/mud-transport.test.ts`
- Modify: `tests/mud-tls-mode.test.ts`
- Modify: `tests/tls-servername.test.ts`

**Step 1: Move the policy-helper tests to the future owner**

Change imports in `tests/mud-tls-mode.test.ts` and
`tests/tls-servername.test.ts` from `../src/session.js` to
`../src/mud-transport.js`. Do not change their assertions. Run:

```bash
bun test tests/mud-tls-mode.test.ts tests/tls-servername.test.ts
```

Expected red: module resolution fails because `src/mud-transport.ts` does not
exist. This proves the tests are actually routed to the new policy owner.

**Step 2: Create the transport module with the existing policy helpers**

Create `src/mud-transport.ts` with the GPL SPDX header, the existing
classification constants and helpers moved byte-for-byte where possible, and
this public contract:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later

import net from 'net';
import tls from 'tls';
import type { MudTlsMode } from './runtime-config';
import type { TelnetSocket } from './types';
import { parseIPv4 } from './wsproxy-utils';

const TLS_HANDSHAKE_CLOSE =
  /socket disconnected before secure tls connection was established/;

const TLS_DIAGNOSTICS = [
  'wrong version number',
  'packet length',
  'unable to verify',
  'certificate',
  'ssl routines',
  'tls_process',
  'tlsv1',
  'sslv3',
  'alert handshake failure',
  'unsupported protocol',
  'no cipher',
  'decryption failed',
  'bad record mac',
];

const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export type TlsFallbackTrigger = 'error' | 'close';
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

export const isTlsNegotiationError = (err: Error): boolean => {
  const message = err.message.toLowerCase();
  if (TLS_HANDSHAKE_CLOSE.test(message)) return true;

  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSPORT_CODES.has(code)) return false;

  return TLS_DIAGNOSTICS.some((pattern) => message.includes(pattern));
};

export const shouldAttemptTls = (mode: MudTlsMode): boolean =>
  mode !== 'plain';

export const shouldFallBackToPlain = (
  mode: MudTlsMode,
  trigger: TlsFallbackTrigger,
  err?: Error,
): boolean => {
  if (mode !== 'prefer') return false;
  if (trigger === 'close') return true;
  return err ? isTlsNegotiationError(err) : false;
};

export const sniServerName = (host: string): string | undefined => {
  const bare = host.startsWith('::ffff:') ? host.slice(7) : host;
  if (!host || parseIPv4(bare) || host.includes(':')) return undefined;
  return host;
};
```

Remove the moved constants, type, helpers, `parseIPv4` import, and their
comments from `src/session.ts`. Temporarily import `shouldAttemptTls`,
`shouldFallBackToPlain`, and `sniServerName` from `./mud-transport` so the old
`Session.connect()` remains green until Task 3. Its `net` and `tls` imports
also remain until that migration.

Run:

```bash
bun test tests/mud-tls-mode.test.ts tests/tls-servername.test.ts
```

Expected green: all existing classification and SNI cases pass unchanged.

**Step 3: Add success-path connector tests**

In `tests/mud-transport.test.ts`, create a small event-emitting socket double
that records `destroy()` and can emit `connect`, `secureConnect`, `error`, and
`close`. Save the original `net.createConnection` and `tls.connect`; restore
both in `afterEach`, along with any timer monkeypatch introduced later.

Add three tests with exact call-count and identity assertions:

1. `plain` calls `net.createConnection(port, dialAddress)` once, never calls
   `tls.connect`, does not invoke `onDowngrade`, and invokes `onConnected`
   exactly once with the emitted TCP socket and
   `{ transport: 'plain', downgraded: false }`.
2. `prefer` calls `tls.connect` once, never calls `net.createConnection`, and
   hands off only after `secureConnect` with
   `{ transport: 'tls', downgraded: false }`.
3. TLS dials `dialAddress` but supplies
   `{ servername: sniServerName(requestedHost) }`; use distinct values such as
   `requestedHost: 'mud.example'` and `dialAddress: '203.0.113.7'` so swapping
   the fields cannot pass.

Use an already-created caller controller in every test:

```typescript
const controller = new AbortController();
const connected: ConnectedMudTransport[] = [];
const downgrades: string[] = [];

const pending = connectMudTransport({
  requestedHost: 'mud.example',
  dialAddress: '203.0.113.7',
  port: 4000,
  mode: 'prefer',
  signal: controller.signal,
  onDowngrade: (reason) => downgrades.push(reason),
  onConnected: (connection) => connected.push(connection),
});
```

Run:

```bash
bun test tests/mud-transport.test.ts
```

Expected red: `connectMudTransport` is not exported or implemented. The
failure must occur in the new connector tests, not in test setup.

**Step 4: Implement only plain and TLS-success connection paths**

Add the exported function. Its initial state must include one provisional
socket and one settled guard. The successful handoff helper must remove only
connector-owned listeners, synchronously invoke `onConnected`, and resolve
only after the callback returns. Task 2 adds callback-failure cleanup and
cancellation after their regressions exist.

Use Node's positional APIs consistently with current code:

```typescript
const plainSocket = net.createConnection(
  options.port,
  options.dialAddress,
) as TelnetSocket;

const tlsSocket = tls.connect(options.port, options.dialAddress, {
  servername: sniServerName(options.requestedHost),
}) as unknown as TelnetSocket;
```

Do not use `removeAllListeners()`: it can erase consumer handlers during or
after handoff. Record each connector listener and remove those exact
listeners.

Run:

```bash
bun test tests/mud-transport.test.ts
bun test tests/mud-tls-mode.test.ts tests/tls-servername.test.ts
bun run typecheck
bun run lint
```

Expected green: success-path connector tests and moved helper tests pass;
typecheck and lint have zero errors.

**Step 5: Inspect and commit**

```bash
git diff --check
git status --short
git diff -- src/mud-transport.ts src/session.ts tests/mud-transport.test.ts tests/mud-tls-mode.test.ts tests/tls-servername.test.ts
git add src/mud-transport.ts src/session.ts tests/mud-transport.test.ts tests/mud-tls-mode.test.ts tests/tls-servername.test.ts
git diff --cached --check
git commit -m "feat: add shared MUD transport connector"
```

---

### Task 2: Complete fallback, deadline, abort, and exact-once semantics

**Files:**

- Modify: `src/mud-transport.ts`
- Modify: `tests/mud-transport.test.ts`

**Step 1: Add classified fallback and no-fallback tests**

Add table-driven or individually named tests proving:

- `prefer` falls back exactly once after a classified TLS error.
- `prefer` falls back exactly once after close before `secureConnect`.
- The TLS socket is destroyed before the plain socket is created.
- `onDowngrade` is called once and only the final plain socket is handed off
  with `{ transport: 'plain', downgraded: true }`.
- Emitting TLS `error` followed by `close`, plus repeated copies of either,
  still creates exactly one plain socket and invokes callbacks at most once.
- A generic `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`,
  `EAI_AGAIN`, `EHOSTUNREACH`, or `ENETUNREACH` rejects without downgrade and
  without calling `net.createConnection()`.
- Failure of the fallback plain socket rejects and cannot start a third dial.
- `required` rejects on error and pre-handshake close without any plaintext
  dial and uses the stable policy text.

For the special Node handshake-close diagnostic, include one error whose
`code` is `ECONNRESET` but whose message contains
`socket disconnected before secure TLS connection was established`; it must
fall back in `prefer`. Include an ordinary `ECONNRESET` beside it; it must not.

Run:

```bash
bun test tests/mud-transport.test.ts
```

Expected red: the first classified error/close rejects or hangs because Task
1 implemented only success paths.

**Step 2: Implement the single fallback transition**

Add one guarded transition that performs these operations in order:

1. Return immediately if the connector is settled or plaintext was already
   attempted.
2. Mark plaintext attempted before invoking any callback.
3. Clear the TLS-handshake timer if present.
4. Remove only connector-owned TLS listeners.
5. Destroy the TLS socket.
6. Invoke `onDowngrade(reason)` once.
7. Start exactly one plain connection.

Use `shouldFallBackToPlain(options.mode, trigger, error)` as the only
error/close classifier. Required-mode failures must be wrapped with stable
messages, preserving the underlying failure via `Error`'s `cause` where an
error exists:

```typescript
new Error(
  'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.',
  { cause: err },
);
```

Run the focused test file. Expected green: all fallback and generic-failure
cases pass, including exact call counts under repeated events.

**Step 3: Add deterministic handshake-deadline tests**

Do not sleep four seconds. Save `globalThis.setTimeout` and
`globalThis.clearTimeout`, then install typed stubs that capture the callback
and delay. Assert:

- no handshake timer exists immediately after `tls.connect()`;
- the TLS socket's TCP `connect` event arms exactly one timer with `4_000`;
- `secureConnect`, error, close, abort, and every terminal path clear it;
- firing the captured callback in `prefer` destroys TLS, logs one downgrade,
  and opens exactly one plain fallback;
- firing it in `required` destroys TLS, opens no plaintext socket, and rejects
  with exactly:
  `MUD_TLS_MODE=required: TLS handshake timed out after 4000ms and plaintext fallback is not permitted.`

Run:

```bash
bun test tests/mud-transport.test.ts -t "handshake"
```

Expected red: no 4,000-millisecond timer is armed.

**Step 4: Implement the private deadline**

Add only this internal constant:

```typescript
const TLS_HANDSHAKE_TIMEOUT_MS = 4_000;
```

Arm it from the TLS socket's `connect` listener, not at `tls.connect()` call
time. Do not export it and do not refer to
`PROTOCOL_NEGOTIATION_TIMEOUT_MS`. Treat expiry as an allowed prefer downgrade
trigger owned by the state machine, while required expiry is terminal.

Run all connector tests. Expected green with no real four-second waits.

**Step 5: Add abort and callback-ownership tests**

Add exact-once tests for:

- already-aborted signal: zero TLS/TCP dials;
- abort during provisional TLS: socket destroyed, timer cleared, zero
  downgrade, zero fallback, zero handoff, one rejection;
- abort during provisional plain connection: socket destroyed, zero handoff,
  one rejection;
- abort during a provisional fallback socket: both attempts remain bounded at
  one each and no handoff occurs;
- `onConnected` throwing: the connected final socket is destroyed and the
  connector rejects with that thrown error;
- abort after successful handoff: the connector no longer owns or destroys
  the final socket.

Run:

```bash
bun test tests/mud-transport.test.ts -t "abort|throws"
```

Expected red: provisional sockets survive abort or the callback exception
leaves a live socket.

**Step 6: Implement cancellation and callback-failure cleanup**

Register one signal listener with `{ once: true }`. On abort, settle before
destroying the provisional socket so synchronous/repeated events are inert.
Remove the abort listener before successful handoff. If `onConnected` throws,
destroy the final socket and reject. Use the exact abort message:

```text
MUD transport connection aborted
```

Run:

```bash
bun test tests/mud-transport.test.ts
bun run typecheck
bun run lint
```

Expected green: the complete connector state matrix passes with zero lint or
type errors.

**Step 7: Inspect and commit**

```bash
git diff --check
git diff -- src/mud-transport.ts tests/mud-transport.test.ts
git add src/mud-transport.ts tests/mud-transport.test.ts
git diff --cached --check
git commit -m "fix: complete MUD TLS fallback lifecycle"
```

---

### Task 3: Route typed sessions through the shared connector

**Files:**

- Modify: `src/session.ts`
- Modify: `tests/session-lifecycle.test.ts`

**Step 1: Add typed-consumer cancellation and handoff regressions**

Adapt the existing monkeypatched `net.createConnection`/`tls.connect` tests so
they exercise `Session` as a connector consumer rather than expecting
Session's old internal state machine. Keep consumer-level assertions for:

- a successful final socket becomes `session.telnet`;
- `session.telnetConnected` is true when `connect()` resolves;
- a prefer downgrade records `session.tlsDowngraded === true`;
- final-socket data/error/close behavior remains attached.

Add a stalled TLS case:

1. Create a `Session` in `prefer` mode.
2. Call `connect()` without emitting `secureConnect`.
3. Call `session.close()`.
4. Assert the provisional TLS socket is destroyed.
5. Assert `connect()` rejects with `MUD transport connection aborted`.
6. Assert no plaintext fallback was opened.

Run:

```bash
bun test tests/session-lifecycle.test.ts
```

Expected red: the stalled Session still depends on the old `closing` field or
the newly written consumer expectations cannot observe connector ownership.

**Step 2: Replace `Session.connect()` with connector delegation**

In `src/session.ts`:

- remove `net`, `tls`, and all no-longer-needed helper imports;
- import `connectMudTransport` from `./mud-transport`;
- delete `private closing = false` and every reset, read, and write of
  `closing`;
- add `private connectAbortController?: AbortController`;
- preserve explicit-plain INFO logging outside `onDowngrade`;
- preserve prefer-downgrade WARN logging in the callback;
- clear only the exact controller created by that `connect()` call.

The core shape is:

```typescript
async connect(): Promise<void> {
  const controller = new AbortController();
  this.connectAbortController = controller;

  if (this.tlsMode === 'plain') {
    // eslint-disable-next-line no-console
    console.log(
      `[session] INFO MUD_TLS_MODE=plain, using plain TCP for ${this.mudHost}:${this.mudPort}`,
    );
  }

  try {
    await connectMudTransport({
      requestedHost: this.mudHost,
      dialAddress: this.dialAddress,
      port: this.mudPort,
      mode: this.tlsMode,
      signal: controller.signal,
      onDowngrade: (reason) => {
        // eslint-disable-next-line no-console
        console.log(
          `[session] WARN ${reason}, using plain TCP for ${this.mudHost}:${this.mudPort}`,
        );
      },
      onConnected: ({ socket, downgraded }) => {
        this.telnet = socket;
        this.tlsDowngraded = downgraded;
        this.setupTelnetHandlers();
        this.telnetConnected = true;
        if (this.connectAbortController === controller) {
          this.connectAbortController = undefined;
        }
      },
    });
  } finally {
    if (this.connectAbortController === controller) {
      this.connectAbortController = undefined;
    }
  }
}
```

Change the helper signature to `private setupTelnetHandlers(): void` and
remove its `onConnectError(err)` call. Connection setup is complete at
handoff; `setupTelnetHandlers()` remains the single owner that invokes
`onErrorCallback` for post-handoff socket errors.

Remove the `connect` listener from `setupTelnetHandlers()`. The connector
hands the socket over only after `connect`/`secureConnect`, so that event
cannot fire again; set `telnetConnected` directly in the handoff.

At the start of `close()` add:

```typescript
const pendingController = this.connectAbortController;
this.connectAbortController = undefined;
pendingController?.abort();
```

Then retain the existing client and handed-off Telnet cleanup.

**Step 3: Verify no write-only `closing` field survives**

Run:

```bash
rg -n "\bclosing\b|connectAbortController|connectMudTransport" src/session.ts tests/session-lifecycle.test.ts
bun test tests/session-lifecycle.test.ts
bun test tests/mud-transport.test.ts tests/mud-tls-mode.test.ts tests/tls-servername.test.ts
bun run typecheck
bun run lint
bun run check:defect-classes
```

Expected: `closing` has zero matches in `src/session.ts`; typed tests prove
abort and final handoff; all checks pass.

**Step 4: Inspect and commit**

```bash
git diff --check
git diff -- src/session.ts tests/session-lifecycle.test.ts
git add src/session.ts tests/session-lifecycle.test.ts
git diff --cached --check
git commit -m "refactor: route typed sessions through shared transport"
```

---

### Task 4: Route legacy connections through the connector

**Files:**

- Modify: `src/types/index.ts`
- Modify: `wsproxy.ts`
- Modify: `tests/e2e/legacy-protocol.test.ts`

**Step 1: Write the legacy prefer/required red tests first**

In `tests/e2e/legacy-protocol.test.ts`, define dedicated constants:

```typescript
const PREFER_PROXY_PORT = 6327;
const PREFER_MUD_PORT = 6328;
const STALL_PROXY_PORT = 6329;
const STALL_MUD_PORT = 6330;
const LEGACY_REQUIRED_REJECTION =
  'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.';
```

Create a prefer-mode plaintext mock/proxy pair with matching
`TN_HOST: 'localhost'` and `TN_PORT`. Add one legacy round-trip test that:

- snapshots `getAcceptedConnectionCount()`;
- sends one legacy connect frame;
- polls until the mock reports exactly two additional raw accepts;
- asserts the WebSocket is still open;
- sends `legacy-prefer-probe\r\n` and waits until the mock records it;
- provokes/collects a response and asserts every player frame is bare base64,
  never a typed JSON envelope;
- asserts the cumulative count remains exactly `before + 2`.

Revise the required-mode legacy test. It must now assert exactly one TLS
attempt (`before + 1`), the new required policy string in decoded legacy
framing, and WebSocket closure. Keep the typed discriminator and its exact
single accepted connection plus JSON `connection_failed` assertion.

Run:

```bash
bun test tests/e2e/legacy-protocol.test.ts
```

Expected red:

- prefer receives only one raw plaintext connection because legacy still
  bypasses TLS; and
- required receives zero connections because the MWP-134 stopgap rejects
  before dialing.

These exact counters are the red proof. Do not proceed if failure instead
comes from target-policy denial, port collision, or test setup.

**Step 2: Add provisional-transport ownership to both duplicated shapes**

Add the same field and comment to `src/types/index.ts` and `wsproxy.ts`:

```typescript
/** Owns an upstream dial until the final socket is handed off. */
pendingMudTransport?: AbortController;
```

Do not consolidate the two interfaces in this issue.

**Step 3: Give the authorized legacy dial a caller-owned controller**

Remove the MWP-134 early required-mode rejection. Keep the existing
`s.ts || sessionIntegration.hasSession(s)` guard for this first migration
step. After an allowed authorization decision and before capacity conversion,
create and store the controller that `initT()` will consume:

```typescript
const controller = new AbortController();
s.pendingMudTransport = controller;
```

Retain the existing established-capacity ordering and pass the validated
`decision.dialAddress` to `initT()`. Task 5 deliberately moves controller
creation before authorization and teaches the guard/close path about it; that
separate red-green step proves the race and cancellation wiring instead of
assuming them as incidental parts of this migration.

**Step 4: Replace raw legacy dialing in `initT()`**

Import `connectMudTransport` into `wsproxy.ts`. `initT()` reads the controller
stored by `openLegacyConnection()` and creates one only for the existing
production-dead direct caller:

```typescript
const controller = s.pendingMudTransport ?? new AbortController();
s.pendingMudTransport = controller;
```

Leave `s.ts` undefined until `onConnected`. Call the connector with both
address fields:

```typescript
void connectMudTransport({
  requestedHost: host,
  dialAddress: dialAddress || host,
  port,
  mode: runtimeConfig.mudTlsMode,
  signal: controller.signal,
  onDowngrade: (reason) => {
    srv.logWarn(`${reason}, using plain TCP for ${host}:${port}`, s, 'telnet');
  },
  onConnected: ({ socket }) => {
    s.ts = socket;
    if (s.pendingMudTransport === controller) {
      s.pendingMudTransport = undefined;
    }
    // Install send, log, arm negotiation timer, then attach final handlers.
  },
}).catch((err: unknown) => {
  // Abort is already being handled by closeSocket; do not send/schedule twice.
  if (controller.signal.aborted) return;
  if (s.pendingMudTransport === controller) {
    s.pendingMudTransport = undefined;
  }
  const error = err instanceof Error ? err : new Error(String(err));
  srv.logError(`telnet error: ${error.toString()}`, s, 'telnet');
  const message =
    runtimeConfig.mudTlsMode === 'required'
      ? error.message
      : 'Error: maybe the mud server is down?';
  srv.rejectLegacy(s, message);
});
```

Inside `onConnected`, move the current `send` implementation unchanged. Log
the connection, then arm `PROTOCOL_NEGOTIATION_TIMEOUT_MS` immediately; do
not register a future `connect` listener because the final socket has already
connected. Attach the existing `data`, `timeout`, `close`, and `error`
handlers to only this final socket.

Pre-handoff rejection has no socket error handler. The single promise catch
must call `rejectLegacy()` exactly once on every non-abort failure. That call
is responsible for sending the selected player message and scheduling
`closeSocket()` after `SOCKET_CLOSE_DELAY_MS`, which closes the WebSocket and
decrements `legacyCountedIp`.

Required failures must never use the generic “MUD may be down” text.

**Step 5: Run the first legacy green loop**

```bash
bun test tests/e2e/legacy-protocol.test.ts
bun test tests/mud-transport.test.ts tests/session-lifecycle.test.ts
bun run typecheck
bun run lint
```

Expected green: prefer opens exactly TLS probe + one plaintext fallback and
relays data; required opens exactly one TLS attempt, never plain, emits the
policy message, and closes; typed required behavior remains distinct.

**Step 6: Inspect and commit the consumer migration**

```bash
git diff --check
git diff -- src/types/index.ts wsproxy.ts tests/e2e/legacy-protocol.test.ts
git add src/types/index.ts wsproxy.ts tests/e2e/legacy-protocol.test.ts
git diff --cached --check
git commit -m "fix: route legacy sessions through shared transport"
```

---

### Task 5: Prove live abort and duplicate-dial behavior under a stalled handshake

**Files:**

- Modify: `src/types/index.ts`
- Modify: `wsproxy.ts`
- Modify: `tests/e2e/legacy-protocol.test.ts`

**Step 1: Add a raw handshake-stall fixture**

Within the E2E file, use `net.createServer()` on `STALL_MUD_PORT`. On each raw
accept:

- increment a cumulative counter;
- add the socket to an active set;
- remove it from the set on close;
- send no bytes, so TLS never reaches `secureConnect`.

Start a dedicated proxy at `STALL_PROXY_PORT` with:

```typescript
{
  TN_HOST: 'localhost',
  TN_PORT: STALL_MUD_PORT.toString(),
  MUD_TLS_MODE: 'prefer',
}
```

The fixture's teardown must destroy any active sockets and await server close
so later suites cannot inherit the port.

**Step 2: Add client-close cancellation test**

Test this sequence:

1. Send one legacy connect.
2. Poll until the stall server has accepted exactly one socket.
3. Close the client WebSocket before the 4-second deadline.
4. Poll until the upstream active set becomes empty, with a deadline shorter
   than 4 seconds measured from client close.
5. Assert cumulative accepts remain exactly one.

Run:

```bash
bun test tests/e2e/legacy-protocol.test.ts -t "stalled handshake"
```

Expected red: `closeSocket()` has no route to the provisional socket while
`s.ts` is undefined. The upstream remains active until the handshake deadline,
after which prefer may open a second plaintext connection.

**Step 3: Add same-turn duplicate-frame test**

Against the same stalled fixture, send two valid legacy connect frames without
awaiting between them. Assert:

- exactly one raw upstream connection is accepted;
- decoded legacy output includes `already has a session`;
- the client WebSocket closes;
- the active upstream set reaches zero; and
- cumulative accepts increase by exactly one for this test.

Run:

```bash
bun test tests/e2e/legacy-protocol.test.ts -t "duplicate|stalled"
```

Expected red: both frames pass the old `s.ts` guard before either asynchronous
authorization path reaches `initT()`, producing more than one upstream accept.

**Step 4: Move the controller latch before authorization**

In `openLegacyConnection()`, replace the guard and create the controller
synchronously before the first `await`:

```typescript
if (s.ts || s.pendingMudTransport || sessionIntegration.hasSession(s)) {
  srv.rejectLegacy(s, 'This connection already has a session');
  return;
}

const controller = new AbortController();
s.pendingMudTransport = controller;
```

Remove the post-authorization controller creation added in Task 4. On every
denial or caught authorization failure, clear only the exact controller:

```typescript
if (s.pendingMudTransport === controller) {
  s.pendingMudTransport = undefined;
}
```

If authorization throws, log the detailed error through the existing
redacted telnet logger, call `rejectLegacy()` once with the generic legacy
connection message, and return. If the client closes while authorization is
pending and an allowed decision later arrives, detect
`controller.signal.aborted`, call `releasePendingDial(decision.ip)`, and return
before `legacyCountedIp` is set or incremented.

Update the field comment in both `SocketExtended` declarations to its final
contract:

```typescript
/**
 * Owns and latches an upstream dial until the final socket is handed off.
 * closeSocket aborts it when a legacy WebSocket closes during setup.
 */
pendingMudTransport?: AbortController;
```

**Step 5: Abort provisional transport from `closeSocket()`**

Before handed-off Telnet cleanup, add:

```typescript
if (!s.ts && s.pendingMudTransport) {
  const controller = s.pendingMudTransport;
  s.pendingMudTransport = undefined;
  controller.abort();
}
```

Keep capacity release guarded by `legacyCountedIp` exactly as it is. The
connector rejection sees the aborted signal and must not send a second message
or schedule another close.

**Step 6: Run the green loop**

```bash
bun test tests/e2e/legacy-protocol.test.ts -t "duplicate|stalled"
bun test tests/e2e/legacy-protocol.test.ts
bun test tests/mud-transport.test.ts tests/session-lifecycle.test.ts
bun run typecheck
bun run lint
```

Expected green: client close destroys the provisional upstream before four
seconds with exactly one accept; same-turn duplicate frames produce one dial,
legacy rejection, WebSocket close, and zero active upstream sockets.

**Step 7: Verify and commit**

```bash
bun test tests/e2e/legacy-protocol.test.ts
bun run lint
git diff --check
git diff -- src/types/index.ts wsproxy.ts tests/e2e/legacy-protocol.test.ts
git add src/types/index.ts wsproxy.ts tests/e2e/legacy-protocol.test.ts
git diff --cached --check
git commit -m "fix: latch and abort pending legacy transports"
```

The eventual PR body must explicitly call this race pre-existing: `s.ts` was
already an unsound post-`await` latch, and final-only handoff widens it through
TCP/TLS setup. Fixing it here prevents two authorized dials, double IP
increments, socket overwrite, and an orphaned upstream connection.

---

### Task 6: Add a trusted real-TLS legacy round trip

**Files:**

- Modify: `tests/e2e/mock-mud.ts`
- Modify: `tests/e2e/proxy-launcher.ts`
- Modify: `tests/e2e/legacy-protocol.test.ts`

**Step 1: Make the mock count raw accepts and optionally serve TLS**

Import `tls` in `tests/e2e/mock-mud.ts` and add this optional config field:

```typescript
tls?: {
  key: Buffer;
  cert: Buffer;
};
```

Keep `private server: net.Server | null`; `tls.Server` extends `net.Server`.
In `start()`, choose the server without changing the existing data plane:

```typescript
this.server = this.config.tls
  ? tls.createServer(this.config.tls, (socket) => {
      this.handleConnection(socket);
    })
  : net.createServer((socket) => {
      this.handleConnection(socket);
    });

this.server.on('connection', () => {
  this.acceptedConnectionCount += 1;
});
```

Remove the increment from the first line of `handleConnection()`. This makes
the counter cumulative over raw TCP accepts for both plain and TLS servers;
on TLS it counts before the handshake, so a failed TLS probe followed by a
plaintext downgrade is visible as two even though neither reaches
`secureConnection`.

Run the existing mock tests before adding the TLS E2E:

```bash
bun test tests/e2e/mock-mud.test.ts tests/e2e/legacy-protocol.test.ts
```

Expected green: moving the hook changes no plaintext counts or active-client
behavior.

**Step 2: Add the test-only CA field without forwarding it yet**

Extend `ProxyConfig` in `tests/e2e/proxy-launcher.ts`:

```typescript
NODE_EXTRA_CA_CERTS?: string;
```

Do not put it in the spawned environment yet. This intentional intermediate
state lets the real TLS round-trip test prove it fails when the child process
does not trust the generated certificate.

**Step 3: Add the trusted TLS setup and failing round-trip test**

In `tests/e2e/legacy-protocol.test.ts`, add dedicated ports:

```typescript
const TLS_PROXY_PORT = 6331;
const TLS_MUD_PORT = 6332;
```

Use `mkdtempSync`/`rmSync` from `fs`, `tmpdir` from `os`, and `path` to create
a temporary directory. Use `Bun.spawnSync` to run OpenSSL and generate a
one-day RSA-2048 localhost key/certificate with SAN `DNS:localhost`:

```typescript
const result = Bun.spawnSync([
  'openssl',
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-days',
  '1',
  '-subj',
  '/CN=localhost',
  '-addext',
  'subjectAltName=DNS:localhost',
  '-keyout',
  keyPath,
  '-out',
  certPath,
]);
expect(result.exitCode).toBe(0);
```

Read the key/cert into `Buffer`s and start `MockMUDServer` with its TLS option.
Start the proxy in `prefer` mode with matching host/port and
`NODE_EXTRA_CA_CERTS: certPath`. Ensure the temp directory is removed only
after the proxy process has stopped, because Node reads the CA in that child
process.

Write one test that:

1. snapshots the raw accepted counter;
2. opens one legacy connection;
3. waits for exactly one additional raw accept and one secure mock client;
4. sends a unique raw command and waits until the mock records it;
5. collects the mock response and proves legacy base64 framing, not typed
   JSON; and
6. reasserts the raw count is exactly `before + 1` after the round trip.

Run:

```bash
bun test tests/e2e/legacy-protocol.test.ts -t "trusted TLS"
```

Expected red: certificate validation causes prefer downgrade because the
launcher accepts but does not forward `NODE_EXTRA_CA_CERTS`; the raw accepted
count becomes two. The test must not pass by merely observing data over
fallback.

**Step 4: Forward the CA path and make the real TLS test green**

In `startTestProxy()`, forward the value only when supplied:

```typescript
...(extraEnv?.NODE_EXTRA_CA_CERTS
  ? { NODE_EXTRA_CA_CERTS: extraEnv.NODE_EXTRA_CA_CERTS }
  : {}),
```

Do not disable certificate verification and do not add a production proxy
setting. Rerun:

```bash
bun test tests/e2e/legacy-protocol.test.ts -t "trusted TLS"
```

Expected green: the proxy child trusts the localhost certificate, the raw
counter rises by exactly one, and the legacy command/response traverses the
real `TLSSocket`.

**Step 5: Verify all E2E transport scenarios and commit**

```bash
bun test tests/e2e/mock-mud.test.ts
bun test tests/e2e/legacy-protocol.test.ts
bun run lint
bun run typecheck
git diff --check
git diff -- tests/e2e/mock-mud.ts tests/e2e/proxy-launcher.ts tests/e2e/legacy-protocol.test.ts
git add tests/e2e/mock-mud.ts tests/e2e/proxy-launcher.ts tests/e2e/legacy-protocol.test.ts
git diff --cached --check
git commit -m "test: cover legacy TLS transport end to end"
```

---

### Task 7: Audit scope, run repository verification, and prepare publication

**Files:**

- Modify only if verification exposes an MWP-135 defect in the files already
  named above.
- Do not add release/migration/configuration files; release wording belongs in
  the PR body/release-note field used during publication.

**Step 1: Run focused suites from smallest to largest**

```bash
bun test tests/mud-transport.test.ts
bun test tests/mud-tls-mode.test.ts tests/tls-servername.test.ts tests/session-lifecycle.test.ts
bun test tests/e2e/legacy-protocol.test.ts
```

Expected: zero failures. If a test fails, use
`superpowers:systematic-debugging`, fix only the demonstrated MWP-135 defect,
and rerun the smallest failing command before continuing.

**Step 2: Run the sole repository-level gate**

```bash
bun run preflight:full
```

Expected: exit 0 across the current repository-defined preflight. Do not
replace this command with a hand-maintained list of CI checks.

**Step 3: Perform invariant and scope scans**

```bash
rg -n "net\.createConnection|tls\.connect" src/session.ts wsproxy.ts src/mud-transport.ts
rg -n "\bclosing\b" src/session.ts
rg -n "pendingMudTransport" wsproxy.ts src/types/index.ts
rg -n "PROTOCOL_NEGOTIATION_TIMEOUT_MS|TLS_HANDSHAKE_TIMEOUT_MS" wsproxy.ts src/mud-transport.ts
rg -n "TODO|TBD|placeholder|similar to" src/mud-transport.ts tests/mud-transport.test.ts
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --check
git status --short
```

Expected:

- upstream dial calls for this feature live in `src/mud-transport.ts`, not
  `Session` or legacy `initT()`;
- `closing` has zero Session matches;
- both duplicated socket interfaces and the live legacy lifecycle use the
  pending controller;
- 4,000-millisecond handshake and 12,000-millisecond Telnet negotiation
  constants remain distinct;
- no placeholders survive in implementation or tests;
- no unrelated configuration, migration, or general documentation is in the
  branch;
- worktree is clean after any verification-fix commit.

**Step 4: Review the complete diff against the design**

```bash
git diff --find-renames origin/main...HEAD -- src/mud-transport.ts src/session.ts src/types/index.ts wsproxy.ts tests/mud-transport.test.ts tests/mud-tls-mode.test.ts tests/tls-servername.test.ts tests/session-lifecycle.test.ts tests/e2e/mock-mud.ts tests/e2e/proxy-launcher.ts tests/e2e/legacy-protocol.test.ts
```

Check every success criterion explicitly:

- one shared connector and final-only synchronous handoff;
- requested-host SNI versus validated-address dial;
- exact 4-second TLS deadline starting on TCP `connect`;
- exact-once classified prefer fallback;
- no required plaintext path;
- caller-owned abort of provisional typed and legacy sockets;
- synchronous pre-authorization legacy latch;
- non-abort pre-handoff legacy failures call `rejectLegacy()` exactly once;
- legacy capacity decrements through the scheduled `closeSocket()`;
- typed/legacy framing and Telnet timers remain consumer-specific;
- trusted real TLS command/response uses exactly one raw connection.

**Step 5: Prepare exact PR metadata**

Use a `fix:` title, for example:

```text
fix: share MUD TLS transport across legacy and typed sessions
```

Include this release-note paragraph verbatim:

> Legacy connections now use the shared `MUD_TLS_MODE` transport. The default
> `prefer` mode attempts TLS first and falls back to plaintext at most once
> when the peer appears plaintext, the handshake deadline expires, or TLS
> negotiation/certificate validation fails—including an untrusted or
> self-signed certificate. Plaintext-only MUDs may incur up to four seconds of
> handshake latency before fallback. `required` never opens plaintext.

The PR body must also state:

- MWP-134 was a required-mode fail-closed stopgap; this issue adds actual
  legacy TLS and removes that stopgap.
- The duplicate legacy connect race pre-existed this issue, but final-only
  handoff widens it, so the pending controller now latches before
  authorization.
- `srv.newSocket()` remains present and production-dead.
- MWP-112 is unblocked but inherits the trust-store limitation: there is no
  first-class custom-CA, certificate-pinning, or `rejectUnauthorized`
  setting, so `required` works by default only with certificates trusted by
  the runtime CA store. `NODE_EXTRA_CA_CERTS` is a runtime mechanism, not a
  proxy configuration feature.

**Step 6: Stop before publication unless explicitly authorized**

Use `superpowers:verification-before-completion` before claiming the branch is
ready. Then use `superpowers:requesting-code-review` and
`superpowers:finishing-a-development-branch`. Pushing, opening the PR,
modifying Linear, or merging are separate external actions and require the
user's authorization in the execution session.
