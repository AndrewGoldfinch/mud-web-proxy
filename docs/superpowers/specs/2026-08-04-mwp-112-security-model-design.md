# MWP-112 Security Model Documentation Design

## Goal

Publish one authoritative security model for the first public v4 release. The
document must tell operators what the proxy protects, which boundaries remain
their responsibility, how each security-relevant configuration choice changes
exposure, and which claims are backed by existing regression tests.

The document is explanatory, not normative code. Runtime behavior and current
deployment topology remain the sources of truth. If source verification finds
that a proposed claim is false because of a production defect, implementation
must stop and surface that defect rather than hiding a runtime fix inside this
documentation task.

## Context

Security behavior is currently distributed across `src/runtime-config.ts`,
target-policy and authentication helpers, the application root in
`wsproxy.ts`, deployment manifests, tests, and configuration prose. Operators
can discover individual controls, but there is no coherent account of:

- the browser, proxy, MUD server, reverse proxy, and operator trust boundaries;
- the guarantees and non-guarantees of target policy, authentication, Origin
  checking, trusted-proxy handling, TLS modes, and resource limits;
- the threats intentionally accepted by each operating mode;
- residual risks such as downgradeable outbound TLS and untrusted MUD output;
- the existing regression evidence for security claims.

MWP-112 will consolidate that account without duplicating the complete
environment-variable reference in `docs/configuration.md`.

## Scope

### In scope

1. Add `docs/security.md` as the authoritative security-model and threat-model
   document.
2. Add a prominent README link to that document.
3. Verify every claim against current source, deployment configuration, and
   tests.
4. Add an evidence ledger mapping security claims to implementation and
   existing regression coverage.
5. Record uncovered regression claims on MWP-122 for Phase 4 ownership.
6. Record on MWP-116 that its future public `SECURITY.md` must link to
   `docs/security.md` rather than creating a second security model.

### Out of scope

- Runtime, configuration, test, or deployment changes.
- New regression tests for uncovered security claims; those belong to MWP-122.
- Vulnerability-reporting policy or disclosure instructions; those belong to
  the future `SECURITY.md` in MWP-116.
- Migration documentation. v4 is this project's first public release.
- A security audit, penetration-test report, compliance claim, or guarantee
  that the service is denial-of-service proof.
- Repeating all 52 active settings already maintained in
  `docs/configuration.md`.

## Chosen documentation approach

Use a single operator narrative followed by an evidence ledger.

The narrative explains the system and its tradeoffs in the order an operator
needs them. The ledger makes every important claim traceable to source and
tests without forcing readers to reconstruct the architecture from a large
threat matrix. This is simpler and less prone to drift than splitting the
material between `security.md` and `threat-model.md`.

Two alternatives were rejected:

1. A threat-matrix-first document would be mechanically complete but difficult
   for operators to read and would repeat the same controls across many rows.
2. Separate security-model and threat-model files would create ambiguous
   ownership and duplicate descriptions of the same boundaries.

No diagram is planned. The data path is linear enough to state precisely in
text, and a diagram would add another representation that must stay synchronized
with the implementation.

## Document architecture

`docs/security.md` will contain these sections in order:

1. **What the proxy does** — describes the WebSocket-to-Telnet role and the
   security decisions the proxy actually makes.
2. **Security boundaries and data flow** — identifies the browser or native
   client, reverse proxy, mud-web-proxy process, MUD endpoint, and external
   Apple services when enabled. It states which hops may be plaintext or TLS.
3. **Target policy** — explains fixed, allowlist, and arbitrary destination
   modes, port bounds, startup validation, and the authentication requirement
   for arbitrary destinations.
4. **Authentication and Origin checking** — distinguishes shared-secret and
   App Attest access controls from the browser-only hardening provided by
   Origin checks.
5. **Trusted proxies and client identity** — explains when forwarded addresses
   are accepted, why the trust boundary must be narrow, and where source-based
   limits depend on correct identity attribution.
6. **Resource limits** — covers connection, session, message, Telnet payload,
   heartbeat, challenge, and state-store bounds by threat class rather than
   restating every configuration row.
7. **TLS boundaries** — separates client-to-proxy TLS from proxy-to-MUD TLS and
   states the behavior of `plain`, `prefer`, and `required` modes, including
   the four conditions under which `prefer` downgrades, the fact that one of
   them is ordinary certificate-validation failure, and that the mode governs
   both wire protocols identically.
8. **In-scope and out-of-scope threats** — states what the built-in controls
   mitigate and which protections require deployment infrastructure or the
   client application.
9. **Known limitations and residual risks** — names accepted risks explicitly,
   including downgradeable preferred TLS, the absence of any upstream
   certificate-trust configuration, bearer-secret handling, experimental
   App Attest, malicious MUD output, and availability limits.
10. **Evidence and regression-coverage ledger** — maps each claim to current
    source and tests and identifies Phase 4 gaps.

The document will link to `docs/configuration.md` for exact setting types,
defaults, and conditional requirements. It will link to deployment guidance
where a guarantee depends on Caddy, Compose, systemd, or provider firewalls.

## Claim and evidence rules

Source behavior wins over existing prose. Each security claim will be checked
against its implementation path before inclusion. The ledger will use this
shape:

| Claim or control | Source implementation | Existing regression evidence | Phase 4 gap |
| ---------------- | --------------------- | ---------------------------- | ----------- |
| Concise claim    | Repository path       | Test path or `None found`    | Gap or `—`  |

Paths must name tracked files that exist at review time. Tests count as
regression evidence only when their assertions actually exercise the stated
claim; a matching filename or incidental setup is insufficient. Missing test
coverage is disclosed in the final column and transferred to MWP-122 rather
than filled with a brittle documentation-prose test.

The ledger is not a line-by-line inventory. It groups claims at the level at
which a regression could invalidate an operator assumption: for example,
target authorization, required-TLS fail-closed behavior, forwarded-client
identity, per-message limits, and bounded App Attest stores.

## Required security wording

The final document must preserve these distinctions:

- Origin checking is browser hardening, never authentication.
- Shared-secret authentication controls access but does not encrypt traffic or
  identify individual users.
- `TARGET_MODE=arbitrary` is authenticated and port-bounded, but intentionally
  permits client-selected destinations.
- `MUD_TLS_MODE=prefer` is downgradeable; `required` fails closed. The
  document must enumerate all four `prefer` downgrade triggers — a classified
  TLS negotiation error, the peer closing during the handshake, the
  four-second handshake deadline expiring, and certificate validation failure
  — and must say plainly that the last of these covers the untrusted and
  self-signed certificates that most MUDs present. Stating only "falls back
  when the MUD does not speak TLS" would understate the exposure in the
  direction that matters.
- Since MWP-135 the mode governs typed and legacy connections identically,
  through one shared transport. The document must not describe upstream TLS
  as a property of the typed protocol; that was true before v4 shipped and is
  the defect MWP-134 and MWP-135 closed.
- `required` refuses plaintext under every one of those triggers, including
  the handshake deadline, and there is no configuration that relaxes it for a
  single target.
- App Attest is experimental and has not received an independent security
  review.
- Resource limits bound specific exhaustion paths; they do not make the
  service denial-of-service proof.
- Malicious MUD output is untrusted data passed to clients, not sanitized
  trusted content.

The prose must also avoid implying that:

- TLS exists on a hop where the selected topology or mode permits plaintext;
- trusted proxy headers are safe from arbitrary internet peers;
- authentication authorizes a specific MUD destination unless target policy
  also does so;
- a process-level limit replaces host, reverse-proxy, or network-level
  controls;
- `MUD_TLS_MODE=required` is a practical setting for an arbitrary MUD. There
  is no custom-CA, certificate-pinning, or `rejectUnauthorized` setting, so it
  succeeds only against certificates the runtime CA store already trusts —
  which few MUDs have. `NODE_EXTRA_CA_CERTS` is a Node runtime mechanism the
  operator may apply to the process; it is not a feature of this proxy and
  must not be presented as one;
- App Attest is required or enabled in the default deployment.

## Threat-model boundaries

The threat model will cover unauthenticated or malicious clients attempting to
reach prohibited targets, spoof client identity, exceed bounded resources, or
reuse authentication material; network attackers on plaintext or downgradeable
hops; and malicious or compromised MUD endpoints sending hostile protocol data
to downstream clients.

The document will distinguish mitigation ownership:

- mud-web-proxy owns runtime target authorization, configured application-level
  authentication, Origin policy, protocol caps, session limits, and outbound
  TLS-mode behavior;
- the reverse proxy and host own public TLS termination, header replacement,
  network exposure, process isolation, and upstream traffic controls;
- operators own secret distribution, policy selection, certificates, trusted
  proxy ranges, and destination allowlists;
- client applications own safe rendering and handling of untrusted MUD data.

This boundary prevents the document from claiming defenses that only exist in
one deployment example.

## Cross-ticket ownership

MWP-112 may discover missing test coverage but will not implement it. Before
the documentation PR is complete, MWP-122 will receive a concise Linear note
listing each ledger row whose Phase 4 gap is not `—`, with a link back to
MWP-112.

MWP-116 owns the eventual repository-root `SECURITY.md` and vulnerability
reporting instructions. It will receive a Linear note requiring that file to
link to `docs/security.md` as the authoritative technical security model.
MWP-112 will not create a placeholder `SECURITY.md`.

## Discrepancy handling

During claim verification:

1. If implementation and prose differ, document the verified implementation
   and correct only the security-model or README prose in this task.
2. If the behavior is secure but lacks direct regression evidence, record a
   Phase 4 gap for MWP-122.
3. If the implementation has a production defect that makes an intended
   security claim false, stop implementation and surface the defect for an
   explicit scope decision. Do not combine the fix with the docs PR.
4. If behavior cannot be established from source and tests, omit the claim or
   state the uncertainty; do not infer a guarantee from variable names.

## Verification strategy

The implementation phase will:

1. Inspect every security-relevant section in `docs/configuration.md` and trace
   it through runtime parsing to its enforcement point.
2. Verify every implementation and test path in the evidence ledger exists and
   supports the adjacent claim.
3. Check all new relative Markdown links.
4. Independently review the completed document claim by claim against source.
5. Run the repository quality gates:

   - `bun run format`
   - `bun run check:config-docs`
   - `bun run check:defect-classes`
   - `bun run typecheck`
   - `bun run lint`
   - `bun run test:unit`
   - `bun run build`

No automated test will assert exact documentation prose. Such a test would
freeze wording without proving runtime behavior.

## Planned repository changes

- Add `docs/security.md`.
- Modify `README.md` only to add a prominent link and short description.

The Linear notes on MWP-122 and MWP-116 are workflow updates, not repository
changes. No other tracked file should change.

## Success criteria

MWP-112 is complete when:

- an operator can identify every relevant trust boundary and the security
  consequence of each major operating mode;
- the document separates access control, target authorization, transport
  security, source attribution, resource bounding, and client-side trust;
- limitations and accepted risks are explicit rather than implied by omission;
- every material security claim has a verified source path and either direct
  regression evidence or a named Phase 4 gap;
- MWP-122 and MWP-116 contain the agreed follow-up ownership notes;
- the README points prominently to the authoritative security model;
- repository quality gates pass; and
- the diff contains no runtime, configuration, test, deployment, migration, or
  vulnerability-policy changes.
