# Parse protocol hardening — MWP-90 + MWP-91

Design doc. Written 2026-07-28 against `develop` at `038feb6`.

- MWP-90 — Restore the legacy connect protocol under identical policy and auth
- MWP-91 — Return `invalid_request` for malformed JSON instead of forwarding it
  to the MUD

Both issues rewrite the same twenty-two lines of `parse()`. They ship as one
worktree and one PR closing both.

## Why one change

`parse()` (`wsproxy.ts:1902`) delegates to
`SessionIntegration.parseNewMessage`, which returns a `boolean`. That boolean
conflates two unrelated outcomes:

- "not my message — forward it to the MUD", correct for ordinary player typing
- "my message, but I could not handle it", which must never reach the MUD

The conflation is both bugs. MWP-91 is the general fix. MWP-90 is one message
shape that must stop falling into the same hole. Widening the return contract
fixes both; fixing either alone means writing the other's dispatcher and
throwing it away.

The tickets say so themselves. MWP-90 item 1 requires that a partially matching
legacy object become an `invalid_request` rather than falling through, which is
MWP-91's machinery. MWP-91 item 2 defines a recognized shape as an object
carrying `type` **or a legacy connect object**, which is MWP-90's deliverable.

## Current behaviour

```ts
parse: function (s: SocketExtended, d: Buffer): number {
  if (d[0] !== '{'.charCodeAt(0)) return 0;
  try {
    const msg = d.toString();
    const parsed = JSON.parse(msg);
    if (parsed && parsed.type) {
      const handled = sessionIntegration.parseNewMessage(s, d);
      if (handled) return 1;
    } else if (parsed) {
      srv.logError(formatMissingTypeLogMessage(parsed, d.length, msg), s, 'parse');
    }
  } catch (_err) {
    // Invalid JSON, forward to MUD
  }
  return 0;
}
```

The caller at `wsproxy.ts:1874` forwards to the MUD on a `0` return. Three
paths reach `return 0` when they should not:

1. `parsed.type` is set but `parseNewMessage` returns `false` — an unknown
   type. The blob is typed into the game.
2. `parsed` has no `type`. Logged, then typed into the game. This is where a
   legacy `{host, port, connect}` message goes today.
3. Any recognized message with a malformed field, since validation does not
   exist.

### The legacy path is absent, not merely unreachable

`docs/open-source-plan.md` describes the legacy path as "currently not reached
by the main parser". It is stronger than that:

- `initT` (`wsproxy.ts:1979`) reads `s.host || srv.tn_host`, but `s.host` and
  `s.port` are never assigned anywhere in `wsproxy.ts`. It always uses the
  default target.
- `initT`'s only caller is `newSocket`, which is never called in production
  code — only from tests.
- `initT` carries its own `validateTarget` call with plaintext error output,
  separate from `handleConnect`'s. Two policy implementations already exist.

`tests/client-request.test.ts:127` contains `if (req.connect) srv.initT(s);`
inside a **mock** `parse`. The suite has been asserting against a legacy
dispatcher the production parser never had, which is why the gap survived.

### Three declared message types already fall through

`ClientMessage` (`src/types/index.ts:215`) includes `ChallengeRequest`,
`AttestRequest`, and `AssertionRequest`. `parseNewMessage`'s switch handles only
`connect`, `resume`, `activityToken`, `syncAck`, `input`, `naws`, and
`disconnect`. App Attest is HTTP-routed (`/attest/challenge`,
`/attest/register`), so those three types have no WebSocket handler and hit
`default: return false` — a live instance of MWP-91 using officially declared
types.

## Design

### 1. The contract

```ts
type ParseOutcome =
  | { kind: 'handled' }
  | { kind: 'not-ours' }
  | { kind: 'invalid'; code: string; field?: string; reason: string };
```

`parseNewMessage` returns `ParseOutcome` instead of `boolean`.

### 2. `parse()` becomes a three-way switch

| Input                 | Outcome               | Returns | Reaches MUD |
| --------------------- | --------------------- | ------- | ----------- |
| First byte is not `{` | —                     | 0       | yes         |
| `JSON.parse` throws   | —                     | 0       | yes         |
| `handled`             | dispatch              | 1       | no          |
| `not-ours`            | —                     | 0       | yes         |
| `invalid`             | emit error per flavor | **1**   | **no**      |

The `invalid` branch returning `1` is the fix. It is what stops the caller at
`wsproxy.ts:1874` from forwarding.

The first two rows are the hot path for every keystroke and stay
allocation-free: the byte check happens before any string conversion, and a
`JSON.parse` failure still means raw input. This preserves MWP-91's criterion
that ordinary player input reaches the MUD unchanged, including input that
happens to begin with `{`.

### 3. Recognition

A new module, `src/client-protocol.ts`, owns shape recognition and field
validation. It has no socket dependency, so it is unit-testable directly.

| Shape                                     | Outcome                          |
| ----------------------------------------- | -------------------------------- |
| `type` present, known value, fields valid | dispatch                         |
| `type` present, known value, bad field    | `invalid`, names type and field  |
| `type` present, unknown value             | `invalid`                        |
| `connect` present, no `type`              | legacy — validate `host`, `port` |
| `connect` present, bad `host` or `port`   | `invalid`                        |
| Object with neither `type` nor `connect`  | `not-ours`, forwarded            |

Legacy validation: `host` optional, non-empty string when present; `port`
optional, integer 1–65535 when present.

**`{connect: 1}` with no host or port is valid** and means the default target.
This matches `initT`'s `s.host || srv.tn_host` fallback and the existing mock at
`tests/client-request.test.ts:127`. It composes correctly with the target modes
introduced in Phase 1: a bare connect resolves to `TN_HOST`/`TN_PORT` and is
then subject to the same `validateTarget` as any other target, so under
`allowlist` it is denied unless `TN_HOST` is itself listed. That is the correct
outcome, not a special case.

**Unknown extra fields are ignored, not rejected.** MWP-91 item 3 permits
either. Rejecting would break v3 clients that send extra fields, for no security
gain — the fields are never read.

### 4. Shared policy, separate data planes

**This section was revised after code review. The original design routed the
legacy protocol through the session stack, with `ctx.flavor` differing in
"exactly two things" — the success frame and the error rendering. That was
wrong, and four P1 review findings all traced to it.**

The session stack's _data plane_ and _lifecycle_ are themselves
typed-protocol concepts. A legacy client cannot consume any of them:

- **Input.** `forward()` writes to `s.ts`. The session path never sets `s.ts`,
  so every raw player command from a legacy client was silently dropped.
- **Output.** `processMudData` broadcasts `{"type":"data","seq":…}` envelopes.
  Legacy clients decode bare base64, so those envelopes would be printed into
  the player's terminal — the exact failure MWP-91 exists to prevent.
- **Lifecycle.** Sessions survive disconnect for resume, addressed by a token
  the legacy client never receives. Its MUD connection would be orphaned until
  the session timeout, since nothing could reclaim it.
- **Accounting.** Established IP capacity was gated on `deviceToken`, which a
  legacy client never has, so `maxPerIP` never applied to it.

So the seam moves. **Policy is shared; the data plane is not.**

`authorizeConnect(socket, ctx)` is the one policy path, called by both
protocols:

`validateTarget` → `enforceConnectionLimits` → `reservePendingDial` → DNS
resolve (arbitrary only) → decision. On success the caller owns the
reservation and must release it.

```ts
type ConnectDecision =
  | {
      allowed: true;
      host: string;
      port: number;
      dialAddress: string;
      ip: string;
    }
  | { allowed: false; code: string; reason: string };
```

It returns synchronously except in arbitrary mode, where the rebinding guard
must await DNS. That is deliberate: validation and limits resolved
synchronously before extraction, and deferring a rejection to a later
microtask changes when a caller — or a test — can observe it.

Each protocol then dials on its own stack:

|               | typed                                 | legacy                                       |
| ------------- | ------------------------------------- | -------------------------------------------- |
| dial          | session stack (`openTelnetSession`)   | raw telnet (`initT`, sets `s.ts`)            |
| output        | `{"type":"data","seq":…,"payload":…}` | bare base64                                  |
| input         | `{"type":"input","text":…}`           | raw bytes via `forward()`                    |
| success frame | `{"type":"session",…}`                | none                                         |
| rejection     | `sendError` JSON                      | base64 plaintext, then close                 |
| resume        | yes                                   | none — close tears the MUD connection down   |
| IP capacity   | owned by the `Session`                | `legacyCountedIp`, released in `closeSocket` |

`initT` no longer runs its own `validateTarget`. Two implementations of one
policy is precisely the drift MWP-90 exists to prevent, so callers must
authorize first, and `openLegacyConnection` does.

Rejecting a second connect is checked per stack: `s.ts` for legacy,
`findByWebSocket` for typed.

Two bugs surfaced only once the legacy path became reachable, both fixed here:
`closeSocket` called `s.terminate()` — rebound at connection time to close the
_WebSocket_ — so the telnet socket was never destroyed; and `sendClient` reads
`s.ttype`, which `initT` has not created when a connect is refused before
dialling, so rejections write base64 directly instead.

### 5. Authentication

MWP-90's acceptance criterion requires the legacy path to enforce identical
target policy, **authentication**, and limits.

Authentication needs no work here, and that is a design conclusion rather than
an omission. MWP-85 item 7 placed the shared-secret check at the WebSocket
upgrade (`wsproxy.ts`, upgrade handler), checked once, not per message type. A
legacy client holding a WebSocket has therefore already passed authentication by
construction — there is no second code path that could drift.

The criterion is currently **vacuous**, because the legacy path does not exist
to be tested. Restoring it makes the assertion meaningful, so this change must
add the test that proves it: under `AUTH_MODE=shared-secret`, a legacy connect
with absent or wrong credentials is rejected at the upgrade with 401 and
allocates no session and no connection-limit capacity.

### 6. Log level for the `not-ours` path

`formatMissingTypeLogMessage` already logs shape only — `bytes=N keys=a,b,c`,
capped at ten keys, with `_rawMessage` unused. MWP-91 item 4's concern about
full client message content being logged is already addressed.

The **level** is the open question. `wsproxy.ts:1912` calls `srv.logError`.
Under the new contract that branch is reclassified: it is no longer an anomaly
but the legitimate path for player input that happens to be a JSON object. Left
alone, every such keystroke emits an ERROR.

This change downgrades it to debug. The scope boundary with MWP-94 is
deliberate: MWP-94 owns log _content_ (item 2 — "logs shape, never content", and
central redaction). It does not address level. The level regression is created
by this change, so it is fixed here, in one line.

### 7. Testing

**Unit — `tests/client-protocol.test.ts`.** The recognition table above, plus
field validation per type: valid, malformed, unknown type, wrong field type,
out-of-bounds port, and non-JSON input that superficially resembles JSON.

**Parity — table-driven.** For each of `fixed`, `allowlist`, and `arbitrary`,
crossed with an allowed and a disallowed target, assert the typed and legacy
protocols return the same allow/deny decision. This is the test MWP-90 calls
"the one that matters". Driving it through `openTelnetSession` rather than six
live-server round trips is the reason the recognition layer is a separate
module.

**Process-level — `tests/e2e/`, `USE_MOCK_MUD=1`.** Real WebSocket against a
real server instance:

- a legacy `{host, port, connect}` message opens a telnet session
- a control message with a typo'd field never appears in the mock MUD's
  received-input log
- a second connect is rejected on both protocols
- under `AUTH_MODE=shared-secret`, a legacy connect without credentials is
  rejected with 401 (section 5)

**Regression.** `{type:'challenge'}` over WebSocket returns `invalid_request`
rather than being forwarded.

Verification: `bun run test` and `bun run test:mock`.

## Risks

**Unknown `type` becoming an error is a wire-protocol behaviour change.** Seven
types are handled today; anything outside that set is currently ignored
silently and will now produce an `invalid_request`. This matches MWP-91's
wording, but MWP-91 was written without checking what the client actually
sends.

Repo evidence narrows this. The client→server types documented in
`docs/session-integration-guide.md` and exercised in `tests/e2e/` are
`connect`, `resume`, `input`, `naws`, and `disconnect`, plus `activityToken`
and `syncAck`, which the proxy advertises through the
`capabilities: ['activityToken', 'syncAck', 'echoState']` frame and the client
therefore sends only after opting in. That is exactly the seven handled types,
with nothing outside the set. (`challenge`/`attest`/`assert` are declared in
`ClientMessage` but are HTTP-routed, never sent over the socket.)

MUDBasher is external to this repository, so this evidence is strong but not
conclusive. **Confirm against the client before merging.** If it sends anything
outside the seven — including forward-compatibility probes — this becomes a
breaking change needing either a client fix first or an ignore-list for
known-benign types, and the ignore-list would change the recognition table in
section 3.

**Merge conflict.** PR #38 (the `process.env` sweep, +127/−72 across ~29 sites
in `wsproxy.ts` plus `runtime-config.ts`) merged as `038feb6`. This worktree
branches from that commit, so the conflict is resolved rather than deferred.
PR #36 (`feat/mud-tls-mode`) also merged, at 23:20:08Z; `mudTlsMode` is read at
`src/session-integration.ts:334`, inside the block `openTelnetSession` extracts,
and that read must survive the extraction.

## Out of scope

`initT` and `newSocket` are dead before this change, not orphaned by it, so
they are left alone. Once legacy connect routes through the session stack they
remain dead and become deletable, along with the `initT` coverage in
`tests/socket-management.test.ts` and `tests/client-request.test.ts`. Worth a
follow-up ticket; not this PR.

Central log redaction and the client-debug-toggle audit stay with MWP-94.
