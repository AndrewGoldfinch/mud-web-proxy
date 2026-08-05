# MWP-112 Security Model Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a source-verified security and threat model for v4, link it
from the README, and transfer uncovered regression and disclosure-policy work
to the correct Linear issues.

**Architecture:** Add one authoritative operator-facing document at
`docs/security.md`. Organize it as a security-boundary narrative followed by an
evidence ledger that maps material claims to implementation, direct regression
evidence, and Phase 4 gaps; keep exact setting metadata in
`docs/configuration.md` rather than duplicating it.

**Tech Stack:** Markdown, TypeScript source and Bun tests as evidence, Bun-based
repository quality gates, Linear issue comments for cross-ticket handoff.

## Global Constraints

- v4 is the first public release; do not add migration documentation.
- Add no runtime, configuration, test, or deployment changes.
- Add no root `SECURITY.md`; MWP-116 owns vulnerability-reporting policy.
- Add no missing regression tests; record uncovered claims on MWP-122.
- Source behavior wins over existing prose.
- If source verification finds a production defect that makes an intended
  security claim false, stop and surface it for an explicit scope decision.
- Origin checking is browser hardening, never authentication.
- Shared-secret authentication controls access but does not encrypt traffic or
  identify individual users.
- `TARGET_MODE=arbitrary` is authenticated and port-bounded, but intentionally
  permits client-selected destinations.
- `MUD_TLS_MODE=prefer` is downgradeable; `required` fails closed. Enumerate
  all four `prefer` downgrade triggers — classified TLS negotiation error,
  peer close during the handshake, the four-second handshake deadline, and
  certificate validation failure — and say plainly that the last covers the
  untrusted and self-signed certificates most MUDs present.
- Since MWP-135 the mode governs typed and legacy connections identically
  through one shared transport; do not describe upstream TLS as a typed-protocol
  property.
- `required` has no per-target relaxation and no custom-CA, pinning, or
  `rejectUnauthorized` setting, so it works only against runtime-trusted
  certificates.
- App Attest is experimental and has not received an independent security
  review.
- Resource limits bound specific exhaustion paths; they do not make the service
  denial-of-service proof.
- Malicious MUD output is untrusted data passed to clients, not sanitized
  trusted content.

---

### Task 1: Write the source-verified security and threat model

**Files:**

- Create: `docs/security.md`
- Read: `docs/configuration.md`
- Read: `src/runtime-config.ts`
- Read: `src/target-policy.ts`
- Read: `src/wsproxy-utils.ts`
- Read: `src/session-integration.ts`
- Read: `src/session-manager.ts`
- Read: `src/session.ts`
- Read: `src/mud-transport.ts`
- Read: `src/message-rate-limit.ts`
- Read: `src/heartbeat.ts`
- Read: `src/telnet-parser.ts`
- Read: `src/circular-buffer.ts`
- Read: `src/app-attest.ts`
- Read: `wsproxy.ts`
- Read: `Caddyfile`
- Read: `compose.yaml`
- Read: `config/mud-web-proxy.env.systemd.example`
- Read: `deploy/caddy/Caddyfile.example`
- Read: `docs/deployment/compose.md`
- Read: `docs/deployment/systemd.md`

**Interfaces:**

- Consumes: the approved design at
  `docs/superpowers/specs/2026-08-04-mwp-112-security-model-design.md` and the
  live v4 behavior in the files above.
- Produces: `docs/security.md`, the sole technical security-model source that
  README and the future MWP-116 `SECURITY.md` will reference.

- [ ] **Step 1: Re-establish the implementation and test evidence map**

Run these read-only searches from the worktree root:

```bash
rg -n 'TARGET_MODE|ALLOWED_TARGETS|ARBITRARY_ALLOWED_PORTS|MUD_TLS_MODE' \
  src/runtime-config.ts src/target-policy.ts src/session-integration.ts
# MWP-135 moved every TLS decision here; the mode is only read elsewhere.
rg -n 'shouldAttemptTls|shouldFallBackToPlain|TLS_DIAGNOSTICS|TLS_HANDSHAKE_TIMEOUT_MS|sniServerName' \
  src/mud-transport.ts
rg -n 'AUTH_MODE|PROXY_SHARED_SECRET|ALLOWED_ORIGINS|ALLOW_MISSING_ORIGIN' \
  src/runtime-config.ts src/wsproxy-utils.ts wsproxy.ts
rg -n 'TRUSTED_PROXY_CIDRS|resolveClientAddress|isTrustedPeer' \
  src/runtime-config.ts src/wsproxy-utils.ts wsproxy.ts compose.yaml \
  Caddyfile config/mud-web-proxy.env.systemd.example \
  deploy/caddy/Caddyfile.example
rg -n 'MAX_SESSIONS|MAX_MESSAGES|MAX_SUBNEGOTIATION|OUTPUT_BUFFER|HEARTBEAT' \
  src/runtime-config.ts src/session-manager.ts src/message-rate-limit.ts \
  src/telnet-parser.ts src/circular-buffer.ts src/heartbeat.ts wsproxy.ts
rg -n 'APPATTEST|REQUIRE_APP_AUTH|NONCE|MAX_ATTESTED_KEYS|ATTESTED_KEY_TTL' \
  src/runtime-config.ts src/app-attest.ts wsproxy.ts
```

Expected: every proposed control has a visible parser or deployment input and
an enforcement point. If a documented protection has no enforcement point, do
not continue to prose; report the discrepancy under the global stop condition.

- [ ] **Step 2: Create the document with the approved operator narrative**

Create `docs/security.md` with these exact top-level sections:

```markdown
# Security model and threat model

## What the proxy does

## Security boundaries and data flow

## Target policy

## Authentication and Origin checking

## Trusted proxies and client identity

## Resource limits

## TLS boundaries

## In-scope and out-of-scope threats

## Known limitations and residual risks

## Evidence and regression-coverage ledger
```

The introduction must say bluntly that the service opens outbound TCP
connections and relays bytes bidirectionally on behalf of remote clients. It
must link to `configuration.md` for types, defaults, accepted values, and
conditional requirements instead of recreating the 52-row reference.

- [ ] **Step 3: Document the boundaries and control semantics**

Write the first seven narrative sections so they contain all of these concrete
claims:

```markdown
- Browser or native client -> edge/application listener -> mud-web-proxy ->
  selected MUD is the primary data path.
- Caddy terminates public HTTPS/WSS in the supported Compose and systemd
  topologies; their Caddy-to-proxy hop is deliberately plaintext and restricted
  to an internal network or loopback respectively.
- Direct application-managed TLS is a distinct topology; required mode validates
  usable, matching certificate material at startup.
- Fixed mode permits only TN_HOST:TN_PORT. Allowlist mode permits only exact
  operator entries and may deliberately name a private target. Arbitrary mode
  permits client-selected hosts only on configured ports, requires enforced
  authentication, rejects reserved resolution results, resolves once, and dials
  the validated address.
- Shared-secret mode is a service-wide bearer credential. Header transport is
  preferred; query-string transport is opt-in because URLs leak into logs and
  intermediaries. It is access control, not encryption or user identity.
- Origin checks constrain browser callers only. Native clients can choose their
  Origin value, so Origin is never an authentication control.
- Forwarded client-address headers are ignored unless the immediate peer is
  trusted. Blanket trust permits spoofing and invalidates per-IP accounting.
- Compose trusts only 172.28.0.0/24 and replaces inbound forwarding headers;
  systemd trusts only 127.0.0.1 and its Caddy template also replaces them.
- Session, pending-dial, global, message-rate, Telnet subnegotiation, replay
  buffer, heartbeat, App Attest route, nonce-store, and key-store bounds mitigate
  distinct exhaustion paths. They are not a general DoS guarantee.
- Client-to-proxy TLS and proxy-to-MUD TLS are independent. Outbound plain never
  attempts TLS; prefer attempts TLS and may downgrade only after classified TLS
  negotiation failures; required never falls back to plaintext.
```

For each default with a security consequence, explain both its rationale and
the consequence of loosening it. Cover at least this inventory:

| Default                                                          | Required rationale                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BIND_HOST=127.0.0.1`                                            | Keeps the application listener off public interfaces in the supported edge-termination topology.                                                                                                                                                                                                                                                 |
| `INBOUND_TLS_MODE=required`                                      | Prevents silent plaintext when the application is exposed directly; non-loopback plaintext needs explicit acknowledgement.                                                                                                                                                                                                                       |
| `TARGET_MODE=fixed`                                              | Prevents the default installation from becoming a general outbound relay.                                                                                                                                                                                                                                                                        |
| `MUD_TLS_MODE=prefer`                                            | Preserves compatibility while still attempting TLS, but downgrades on negotiation failure, peer close, handshake-deadline expiry, or certificate validation failure — the last covering the self-signed certificates most MUDs present. `required` refuses every one of those, at the cost of only working against runtime-trusted certificates. |
| `AUTH_MODE=none`                                                 | Does not protect access; it is tolerable only when target and network exposure are otherwise intentionally constrained.                                                                                                                                                                                                                          |
| `AUTH_ALLOW_QUERY_SECRET=false`                                  | Keeps the bearer secret out of URLs and common access-log/referrer paths.                                                                                                                                                                                                                                                                        |
| empty `ALLOWED_ORIGINS`                                          | Applies no Origin restriction for compatibility; browser deployments should configure exact origins.                                                                                                                                                                                                                                             |
| `ALLOW_MISSING_ORIGIN=false`                                     | Prevents a configured Origin policy from being bypassed by simply omitting the header; native-client support is an explicit relaxation.                                                                                                                                                                                                          |
| `TRUSTED_PROXY_CIDRS=false`                                      | Ignores client-spoofable forwarding headers by default.                                                                                                                                                                                                                                                                                          |
| session defaults `5` per device, `10` per IP, no global cap      | Bounds common per-client abuse while preserving compatibility; production operators should set the global cap to match host capacity.                                                                                                                                                                                                            |
| message defaults `60` per connection and `240` per IP            | Sit above human/client traffic while bounding frame floods across one or several connections.                                                                                                                                                                                                                                                    |
| `MAX_SUBNEGOTIATION_BYTES=65536` and `OUTPUT_BUFFER_BYTES=51200` | Bound per-session memory while retaining legitimate MUD protocol payloads and resume history.                                                                                                                                                                                                                                                    |
| heartbeat enabled at `30000`/`90000` ms                          | Reclaims dead sockets while tolerating missed pings.                                                                                                                                                                                                                                                                                             |
| diagnostics disabled                                             | Avoids exposing operational state unless explicitly enabled and bearer-authorized.                                                                                                                                                                                                                                                               |
| App Attest and APNS disabled                                     | Avoids experimental verification and Apple-bound device data unless explicitly configured.                                                                                                                                                                                                                                                       |

- [ ] **Step 4: State the threat model and limitations without marketing language**

The threat section must identify these actors and ownership boundaries:

```markdown
In scope:

- unauthenticated or malicious remote clients;
- authenticated clients attempting prohibited targets or resource exhaustion;
- spoofed forwarding headers and hostile browser origins;
- active network attackers on plaintext or downgradeable hops;
- malicious or compromised MUD servers sending hostile protocol data.

Out of scope:

- a hostile operator or host compromise;
- client-side rendering vulnerabilities in the consuming MUD client;
- independent cryptographic assurance for the experimental App Attest verifier;
- volumetric attacks that exhaust the host, reverse proxy, or network before
  process-level limits can act.

Operator/architecture limitations:

- sessions and rate-limit state are memory-local;
- one process is one replica, with no distributed coordination or shared quota;
- restarts discard sessions, resume buffers, and limiter state;
- shared secrets identify entitlement, not individual users;
- preferred outbound TLS is downgradeable and many MUDs remain plaintext;
- untrusted MUD output is relayed to clients and must be rendered safely there.
```

Do not claim that App Attest attacks are absent. State that the implementation
is experimental and independently unreviewed, and recommend pairing it with
the shared-secret mode rather than relying on it alone.

- [ ] **Step 5: Add the evidence and regression-coverage ledger**

Use this exact column contract:

```markdown
| Claim or control | Source implementation | Existing regression evidence | Phase 4 gap |
| ---------------- | --------------------- | ---------------------------- | ----------- |
```

Build ledger rows from this verified candidate map. A test may remain in the
third column only after reading its assertions and confirming it directly
exercises the claim. Otherwise write `None found` and name the missing
regression in the Phase 4 column.

| Claim group                                                                                                                  | Implementation candidates                                                                                 | Regression candidates                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound TLS fails closed and plaintext requires acknowledgement                                                              | `src/runtime-config.ts`, `wsproxy.ts`                                                                     | `tests/config-security-guards.test.ts`, `tests/inbound-tls-material.test.ts`                                                                                                                    |
| Fixed and allowlist targets deny anything not explicitly permitted                                                           | `src/runtime-config.ts`, `src/target-policy.ts`, `src/session-integration.ts`                             | `tests/target-policy-modes.test.ts`, `tests/config-security-guards.test.ts`                                                                                                                     |
| Arbitrary targets require auth, allowed ports, public resolution, and one validated dial address                             | `src/runtime-config.ts`, `src/target-policy.ts`, `src/session-integration.ts`                             | `tests/target-mode-guard.test.ts`, `tests/target-policy-modes.test.ts`, `tests/connect-path-dns.test.ts`                                                                                        |
| Shared-secret upgrade authorization, query opt-in, constant-time equality, and bounded failed-auth tracking                  | `src/wsproxy-utils.ts`, `wsproxy.ts`                                                                      | `tests/shared-secret-auth.test.ts`, `tests/config-security-guards.test.ts`                                                                                                                      |
| Exact Origin policy and missing-Origin behavior                                                                              | `src/runtime-config.ts`, `src/wsproxy-utils.ts`, `wsproxy.ts`                                             | `tests/origin-checking.test.ts`                                                                                                                                                                 |
| Forwarded identity is accepted only from configured peers                                                                    | `src/runtime-config.ts`, `src/wsproxy-utils.ts`, `wsproxy.ts`                                             | `tests/trusted-proxy.test.ts`, `tests/trusted-proxy-config.test.ts`, `tests/trusted-proxy-startup.test.ts`, `tests/ip-counting.test.ts`                                                         |
| Supported Caddy topologies replace forwarding headers and narrowly scope trust                                               | `Caddyfile`, `compose.yaml`, `config/mud-web-proxy.env.systemd.example`, `deploy/caddy/Caddyfile.example` | `tests/deployment/systemd-contract.test.ts`; record the absent Compose contract separately if still absent                                                                                      |
| Pending, per-IP, per-device, global, and clientless-session capacity is bounded and released                                 | `src/session-manager.ts`, `src/session-integration.ts`                                                    | `tests/pending-dial-reservation.test.ts`, `tests/dial-reservation-handoff.test.ts`, `tests/ip-counting.test.ts`, `tests/global-session-cap.test.ts`, `tests/clientless-session-reaping.test.ts` |
| Per-connection and per-address frame rates are both enforced with bounded bookkeeping                                        | `src/message-rate-limit.ts`, `wsproxy.ts`                                                                 | `tests/message-rate-limit.test.ts`                                                                                                                                                              |
| Telnet subnegotiation and resume history have byte caps                                                                      | `src/telnet-parser.ts`, `src/circular-buffer.ts`, `src/session.ts`                                        | `tests/telnet-subneg-cap.test.ts`, `tests/circular-buffer-cap.test.ts`                                                                                                                          |
| Heartbeat reclaims silent peers                                                                                              | `src/heartbeat.ts`, `wsproxy.ts`                                                                          | `tests/heartbeat.test.ts`                                                                                                                                                                       |
| Required MUD TLS never downgrades; preferred TLS has classified fallback                                                     | `src/session.ts`                                                                                          | `tests/mud-tls-mode.test.ts`, `tests/session-lifecycle.test.ts`                                                                                                                                 |
| Diagnostics are disabled by default and require the admin token when enabled                                                 | `src/runtime-config.ts`, `src/wsproxy-utils.ts`, `wsproxy.ts`                                             | `tests/open-source-regressions.test.ts`, `tests/wsproxy-utils.test.ts`                                                                                                                          |
| Logs redact configured secrets and neutralize hostile control text                                                           | `src/log-redaction.ts`, `wsproxy.ts`                                                                      | `tests/log-redaction.test.ts`                                                                                                                                                                   |
| App Attest is optional, required-auth configuration fails closed, challenge/key state is bounded, and bypass names are inert | `src/runtime-config.ts`, `src/app-attest.ts`, `wsproxy.ts`                                                | `tests/app-attest-optional.test.ts`, `tests/attest-route-gating.test.ts`, `tests/app-attest-nonce.test.ts`, `tests/app-attest-store-bounds.test.ts`, `tests/app-attest-writable-state.test.ts`  |
| Ordered shutdown has an absolute deadline and flushes state                                                                  | `src/shutdown.ts`, `wsproxy.ts`                                                                           | `tests/shutdown.test.ts`                                                                                                                                                                        |

Do not use the obsolete `ONLY_ALLOW_DEFAULT_SERVER` cases in
`tests/security.test.ts` as evidence for the v4 target-policy contract. Current
source paths and direct v4 tests take precedence over legacy test names.

- [ ] **Step 6: Verify ledger paths and document coverage**

Run:

```bash
for path in \
  src/runtime-config.ts src/target-policy.ts src/wsproxy-utils.ts \
  src/session-integration.ts src/session-manager.ts src/session.ts \
  src/message-rate-limit.ts src/heartbeat.ts src/telnet-parser.ts \
  src/circular-buffer.ts src/app-attest.ts src/log-redaction.ts \
  src/shutdown.ts wsproxy.ts Caddyfile compose.yaml \
  config/mud-web-proxy.env.systemd.example \
  deploy/caddy/Caddyfile.example \
  tests/config-security-guards.test.ts tests/inbound-tls-material.test.ts \
  tests/target-policy-modes.test.ts tests/target-mode-guard.test.ts \
  tests/connect-path-dns.test.ts tests/shared-secret-auth.test.ts \
  tests/origin-checking.test.ts tests/trusted-proxy.test.ts \
  tests/trusted-proxy-config.test.ts tests/trusted-proxy-startup.test.ts \
  tests/ip-counting.test.ts tests/pending-dial-reservation.test.ts \
  tests/dial-reservation-handoff.test.ts tests/global-session-cap.test.ts \
  tests/clientless-session-reaping.test.ts tests/message-rate-limit.test.ts \
  tests/telnet-subneg-cap.test.ts tests/circular-buffer-cap.test.ts \
  tests/heartbeat.test.ts tests/mud-tls-mode.test.ts \
  tests/session-lifecycle.test.ts tests/open-source-regressions.test.ts \
  tests/wsproxy-utils.test.ts tests/log-redaction.test.ts \
  tests/app-attest-optional.test.ts tests/attest-route-gating.test.ts \
  tests/app-attest-nonce.test.ts tests/app-attest-store-bounds.test.ts \
  tests/app-attest-writable-state.test.ts tests/shutdown.test.ts; do
  test -f "$path" || { echo "missing ledger path: $path"; exit 1; }
done

rg -n '^## ' docs/security.md
rg -n 'fixed|allowlist|arbitrary|Origin|shared-secret|App Attest|trusted|TLS|resource|memory-local|single replica|untrusted' docs/security.md
```

Expected: the file check prints nothing and exits zero; the heading search
shows all ten approved sections; the term search points to concrete prose, not
only ledger cells.

- [ ] **Step 7: Format, inspect, and commit the security document**

Run:

```bash
bunx prettier --write docs/security.md
bun run format
git diff --check
git diff -- docs/security.md
```

Expected: formatting and whitespace checks pass. The diff contains one new
operator document with no claims that exceed the source evidence.

Then commit only the document:

```bash
git add -- docs/security.md
git diff --cached --check
git diff --cached --stat
git commit -m "docs: publish v4 security model"
```

### Task 2: Link the README and independently audit the completed document

**Files:**

- Modify: `README.md:182-214`
- Read: `docs/security.md`
- Read: `docs/configuration.md`
- Read: all implementation and test paths named by the ledger

**Interfaces:**

- Consumes: the authoritative `docs/security.md` from Task 1.
- Produces: a prominent README entry point and a claim-by-claim audit of the
  complete repository documentation change.

- [ ] **Step 1: Add the prominent README link**

Immediately after the opening Configuration paragraph, add this sentence:

```markdown
Read the [security model and threat model](docs/security.md) before changing
target policy, authentication, trusted-proxy, TLS, or resource-limit settings;
it explains which protections each default provides and what loosening it
exposes.
```

Keep the existing link to `docs/configuration.md` for the exhaustive variable
reference. Do not add a `SECURITY.md` link that cannot resolve yet.

- [ ] **Step 2: Check every local Markdown link mechanically**

Run:

```bash
bun -e '
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

for (const file of ["README.md", "docs/security.md"]) {
  const markdown = await Bun.file(file).text();
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const target = href.split("#", 1)[0];
    const absolute = resolve(dirname(file), decodeURIComponent(target));
    if (!existsSync(absolute)) {
      throw new Error(`${file}: missing local link ${href}`);
    }
  }
}
'
```

Expected: exit zero with no output.

- [ ] **Step 3: Perform the fresh claim-by-claim audit**

Read `docs/security.md` from top to bottom without relying on the Task 1 notes.
For each paragraph and ledger row, answer all four questions before proceeding:

1. Does the cited source enforce exactly this claim?
2. Does the cited test fail if that protection is removed, rather than merely
   importing or configuring the code?
3. If the test is indirect or absent, is the Phase 4 gap explicit?
4. Does the prose state the limitation or tradeoff as prominently as the
   protection?

Use these searches to catch the highest-risk overclaims:

```bash
rg -n 'secure|prevent|reject|never|always|fail|encrypt|authenticate|trusted|saniti' docs/security.md
rg -n 'Origin|shared-secret|arbitrary|prefer|required|App Attest|DoS|MUD output' docs/security.md
git diff origin/main...HEAD -- README.md docs/security.md
```

Expected: every absolute term is supported by an enforcement path; all seven
required wording distinctions from the global constraints are present. If a
runtime defect appears, stop instead of editing production code.

- [ ] **Step 4: Run the complete repository verification suite**

Run each command independently so a failure identifies its gate:

```bash
bun run format
bun run check:config-docs
bun run check:defect-classes
bun run typecheck
bun run lint
bun run test:unit
bun run build
git diff --check
```

Expected: every command exits zero; the unit suite reports 1,152 passing tests
unless `origin/main` has legitimately changed the baseline before execution.

- [ ] **Step 5: Verify scope and commit the README change**

Run:

```bash
git status --short
git diff --name-only origin/main...HEAD
git diff -- README.md
```

Expected: implementation changes are limited to `README.md` and
`docs/security.md`; the only additional branch files are the approved design
and implementation-plan artifacts under `docs/superpowers/`. There must be no
runtime, configuration, test, deployment, generated, or migration file change.

Then commit only README:

```bash
git add -- README.md
git diff --cached --check
git diff --cached --stat
git commit -m "docs: link the v4 security model"
```

### Task 3: Transfer follow-up ownership to MWP-122 and MWP-116

**Files:**

- Read: `docs/security.md`
- Modify externally: Linear MWP-122 comments
- Modify externally: Linear MWP-116 comments

**Interfaces:**

- Consumes: the final evidence ledger from Task 1 and the verified README link
  from Task 2.
- Produces: durable Phase 4 regression ownership on MWP-122 and future
  vulnerability-policy linkage ownership on MWP-116.

- [ ] **Step 1: Re-read both destination issues before changing them**

Use the Linear issue lookup for `MWP-122` and `MWP-116`, including relations.

Expected: MWP-122 remains the Phase 4 security regression suite and MWP-116
remains the Phase 3 community-health task. If ownership has changed, stop and
reconcile the destination instead of posting a misleading comment.

- [ ] **Step 2: Comment on MWP-122 with the exact uncovered ledger claims**

Post a comment headed:

```markdown
## MWP-112 security-model regression handoff
```

The comment must:

- link MWP-112 and name `docs/security.md`;
- copy every non-`—` Phase 4 gap from the final ledger as a separate bullet;
- name the associated implementation path and the strongest existing partial
  test, if any;
- distinguish missing process-level or mutation evidence from total absence of
  unit coverage;
- explicitly say that MWP-112 added no tests because regression implementation
  belongs to MWP-122.

Do not paste rows whose gap is `—`, and do not claim the current MWP-122 list is
complete if the source audit found another uncovered operator guarantee.

- [ ] **Step 3: Comment on MWP-116 with the documentation ownership rule**

Post this substantive content:

```markdown
## MWP-112 security-document ownership handoff

MWP-112 publishes `docs/security.md` as the authoritative technical security
and threat model. When MWP-116 adds the repository-root `SECURITY.md`, link to
that document for architecture, controls, and residual risks rather than
duplicating them. Keep `SECURITY.md` focused on supported versions, private
vulnerability reporting, response expectations, and disclosure scope.

v4 is the first public release, so MWP-116 must not introduce a migration-guide
dependency or describe internal pre-release history as a supported upgrade
contract.
```

- [ ] **Step 4: Verify both Linear comments**

List comments for MWP-122 and MWP-116 after posting them.

Expected: exactly one new MWP-112 handoff comment appears on each issue;
MWP-122 contains every final ledger gap, and MWP-116 names
`docs/security.md`, the future root `SECURITY.md`, and the no-migration rule.

- [ ] **Step 5: Record final branch evidence without changing issue state**

Run:

```bash
git status --short
git log --oneline --decorate origin/main..HEAD
```

Expected: the worktree is clean. The branch contains the approved design,
implementation plan, security-model document, and README-link commits. Leave
MWP-112 In Progress until its pull request is reviewed and merged.
