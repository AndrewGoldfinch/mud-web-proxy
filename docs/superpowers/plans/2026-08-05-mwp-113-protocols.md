# MWP-113 Client Protocol Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `docs/protocols.md` as the wire contract, verified by writing
a client from it.

**Architecture:** One new document, one deprecation note on the stale guide,
one README link. The proof is a working client, not a review.

## Global Constraints

- Every shape comes from the implementation, not from the issue's summary.
- If the document and the implementation disagree, stop and surface it.
- No runtime, configuration, or test change.
- Do not rewrite `docs/mud-proxy-guide.md` or `docs/ios-client-integration.md`.
- The verification client is scratch and is not committed. Regression coverage
  belongs to MWP-122.

---

### Task 1: Write `docs/protocols.md`

**Files:**

- Create: `docs/protocols.md`
- Read: `src/client-protocol.ts`, `src/session-integration.ts`,
  `src/types/index.ts`, `src/circular-buffer.ts`, `src/session.ts`,
  `src/protocol-constants.ts`, `wsproxy.ts`

- [ ] **Step 1: Connection and upgrade**

URL shape, Origin behaviour, both shared-secret transports (header preferred,
query opt-in via `AUTH_ALLOW_QUERY_SECRET`), and what each rejection looks like
on the wire — an upgrade rejection is an HTTP status, not a JSON envelope, and
a client author needs to know which failures happen before the socket opens.

- [ ] **Step 2: Typed protocol, both directions**

All seven client message types and all seven server envelopes. For each: every
field, its type, its bounds, whether it is required, and an example. Bounds
come from `src/client-protocol.ts` — port 1-65535, window dimensions 1-65535,
type names capped at 32 characters.

- [ ] **Step 3: Legacy protocol**

The `{ host, port, connect }` message, base64 framing in both directions, and
the exact rejection strings a legacy client receives. Mark it **supported but
frozen**: no new capabilities, new clients use the typed protocol.

- [ ] **Step 4: Errors**

The five codes — `invalid_request`, `invalid_resume`, `session_expired`,
`connection_failed`, `rate_limited` — with the conditions producing each, and
the `{type, code, field?, message}` shape. `field` is what lets a client
distinguish "my message was malformed" from "the MUD is down".

- [ ] **Step 5: Telnet pass-through and limits**

Which options the proxy negotiates on the client's behalf, how GMCP and MSDP
payloads surface as typed envelopes, and the caps: message rates,
subnegotiation bytes, output buffer bytes, heartbeat interval and timeout, and
what a client observes on exceeding each.

- [ ] **Step 6: Session lifecycle and resume**

Connect, resume, disconnect. State the resume contract exactly:

- `lastSeq` is the highest sequence **already received**; replay resumes
  **strictly after** it.
- `lastSeq: 0` replays the whole buffer.
- Replayed frames carry `replayed: true`; live frames do not.
- Sequences are per-session, monotonic, and do not reset on resume.
- An evicted `lastSeq` resumes at the oldest surviving chunk with **no error
  and no gap indication** — a known limitation a client cannot detect.
- Resume state does not survive a server restart.

- [ ] **Step 7: Parity guarantee**

Both protocols enforce identical target policy, authentication, and limits.
State it as a contract; it is what the Phase 1 and MWP-135 work bought.

---

### Task 2: Deprecate the stale guide and link the new one

**Files:**

- Modify: `docs/mud-proxy-guide.md`, `README.md`

- [ ] **Step 1: Deprecation note**

A short block at the very top of `docs/mud-proxy-guide.md` stating that it
predates the v4 architecture, that `protocols.md` is the authoritative wire
contract, and that it is retained for context rather than as guidance. Change
nothing else in the file.

- [ ] **Step 2: README link**

Add `protocols.md` to the documentation table. That table now also carries the
community-health rows, so insert rather than restructure.

---

### Task 3: Write a client from the document alone

- [ ] **Step 1: Write it without reading the source**

In the scratch directory, write a minimal client using **only**
`docs/protocols.md`. Do not open `wsproxy.ts` or `session-integration.ts` while
writing it. The moment something cannot be determined from the document, record
it as a gap.

- [ ] **Step 2: Run it against the mock MUD, both protocols**

Start the mock and a proxy, then:

- typed: connect, receive `session`, send `input`, receive `data`, disconnect;
- legacy: `{connect:1, host, port}`, receive base64, send raw text.

- [ ] **Step 3: Fix every gap, then re-run from scratch**

A document that needed a correction is not proven until a client written from
the corrected version works. Record what was missing — those gaps are the
document's real defects and belong in the PR.

---

### Task 4: Verify and publish

- [ ] **Step 1: Links and gates**

```bash
bun run preflight
```

Plus a local-link check over `README.md`, `docs/protocols.md`, and
`docs/mud-proxy-guide.md`.

- [ ] **Step 2: Scope**

```bash
git diff --name-only origin/main...HEAD
```

Expected: `docs/protocols.md`, `docs/mud-proxy-guide.md`, `README.md`, and this
issue's design and plan artifacts. Nothing else.
