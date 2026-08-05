# MWP-113 Client Protocol Documentation Design

## Goal

Publish `docs/protocols.md` as the wire contract for external client authors.
v4 supports both protocols, which makes them a public interface with a
compatibility promise attached, and neither is currently documented as a
contract.

The issue is prescriptive about content, including an exact resume contract to
state. This note records only what it leaves open.

## Decision 1: derive every shape from source, cite nothing from the issue

The issue summarises the message set, but the acceptance criterion is
"documented behavior matches the implementation, verified against the code
rather than assumed". Every field, code, and bound in the document comes from
reading the implementation. What that produced:

**Client → server**, from `KNOWN_TYPES` (`src/client-protocol.ts:50`):
`connect`, `resume`, `activityToken`, `syncAck`, `input`, `naws`, `disconnect`.

**Server → client**, from the envelopes constructed in
`src/session-integration.ts`: `session`, `resumed`, `data`, `gmcp`, `echo`,
`error`, `disconnected`. (`connect` and `debugAlert` also appear as string
literals in the codebase but are not client-facing session envelopes; the
document covers only what a client receives.)

**Error codes**, from the `sendError` call sites and the `ConnectDecision`
shape: `invalid_request`, `invalid_resume`, `session_expired`,
`connection_failed`, `rate_limited`.

## Decision 2: `docs/mud-proxy-guide.md` gets a pointer, not a rewrite

MWP-114's design recorded that this 412-line file "predates the v4
architecture" and that its staleness belongs here. It is an implementation
guide for one iOS client, covering the session model, telnet handling, and both
wire formats — overlapping this document without agreeing with it.

Rewriting it is a separate effort and deleting it loses context that has not
been re-derived. **It gets a deprecation note at the top pointing at
`protocols.md` as the authoritative contract.** A stale document that announces
its own staleness is far less dangerous than one that reads as current, and
this is the cheapest change that stops it misleading a client author.

`docs/ios-client-integration.md` stays as-is: it is explicitly client-specific
and does not claim to be the protocol contract.

## Decision 3: the verification is a real client, not a review

The issue's test is to write a minimal client from the document alone and
connect it against the mock MUD using each protocol. That is achievable and is
the plan's Task 3: a throwaway script written **only** from `protocols.md`,
without consulting `wsproxy.ts` or `session-integration.ts` while writing it.

Anything the client cannot do from the document alone is a documentation gap
and gets fixed, then the client re-run. The script is scratch, not committed —
committing it would make it a test with an owner, which is MWP-122's scope, not
this issue's.

## Resume semantics

The issue settles this and the document states it verbatim in substance:
`lastSeq` is the highest sequence the client has **already received**; replay
resumes **strictly after** it. Confirmed against
`CircularBuffer.replayAfter` (`src/circular-buffer.ts:110`), which is named for
that boundary precisely because the old inclusive name is how the off-by-one
survived review.

The four points the issue requires — `lastSeq: 0` replays everything,
`replayed: true` marks history, sequences are per-session and monotonic across
resume, and an evicted `lastSeq` silently resumes at the oldest surviving chunk
with no gap indication — are stated as a contract, with the last flagged as a
known limitation a client cannot currently detect.

## Out of scope

- Rewriting `docs/mud-proxy-guide.md` or `docs/ios-client-integration.md`.
- Any runtime, configuration, or test change. If the document and the
  implementation disagree, that is a defect to surface, not to document around.
- Committing the verification client. Regression coverage is MWP-122's.

## Success criteria

- Every client→server and server→client message is documented with fields,
  types, bounds, and an example.
- The error code list is complete and maps conditions to codes.
- Negotiated telnet options and how GMCP/MSDP payloads surface are documented.
- The legacy protocol is marked supported-but-frozen.
- Resume semantics state the boundary in both directions, the `lastSeq: 0`
  case, the `replayed` flag, and the silent-gap limitation.
- A client written from the document alone connects and exchanges data on both
  protocols against the mock MUD.
- `protocols.md` is linked from the README's documentation table.
