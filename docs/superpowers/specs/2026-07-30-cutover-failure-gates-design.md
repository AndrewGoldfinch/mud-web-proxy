# MWP-104 cutover failure gates

**Status:** Approved in conversation on 2026-07-30

## Problem

Two P1 review findings arrived on PR #88 after it had merged:

1. The new-Droplet pre-stage procedure tells the operator to follow the
   general atomic-activation procedure. That procedure ends with
   `systemctl restart mud-web-proxy`, which starts an inactive unit before the
   final production App Attest store is installed.
2. The final-state gate starts the new proxy and Caddy before checking
   loopback health and the post-start key count. A failure in either later
   check exits the block without guaranteeing that the new services stop
   before the old host is restored.

Both defects violate the cutover's single-active-production-instance
invariant. They are documentation defects today, but MWP-106 will execute
these commands against production.

## Scope

The follow-up changes only the native activation and cutover failure
procedures needed to close those findings. It updates:

- `docs/deployment/systemd.md`;
- `docs/deployment/new-droplet-cutover.md`;
- the MWP-104 design specification;
- the MWP-104 implementation plan; and
- MWP-106's Linear handoff.

It does not implement MWP-103 release publishing, the MWP-105 unit, or the
MWP-106 production cutover.

## Design

### Separate link activation from process activation

The native deployment guide will define atomic activation as two explicit
phases:

1. validate the release and runtime, persist the previous-release record,
   and atomically replace `/opt/mud-web-proxy/current`; then
2. restart the service and run acceptance checks.

The first phase never starts, stops, or restarts a service. Normal upgrades
run both phases in order.

Pre-staging runs only the first phase. It requires
`mud-web-proxy.service` to be inactive before the link swap and verifies that
it remains inactive afterward. The operator must not run the second phase
until the final App Attest store has passed the aggregate transfer gate.

This is preferable to a `NO_RESTART` flag in one monolithic block: the
dangerous action is structurally absent from the pre-stage procedure rather
than controlled by a value an operator can omit or mistype.

### Stop new services automatically on a failed final gate

The final-state block will treat the new proxy and Caddy as possibly running
immediately before attempting to start them. Its `EXIT` trap will preserve
the original nonzero status and attempt to stop both services whenever any
start, health, or post-start state check fails.

The trap is immediate containment, not the sole proof. The
failure-before-routing procedure will begin by stopping both new services and
verifying that neither is active. No old-host state restore, old-service
restart, ingress restoration, or routing reversal may run before that
verification succeeds.

On full success, the final-state block disarms the failure trap only after
loopback health and the post-start App Attest count pass. Public routing
remains forbidden until the complete block exits zero.

The redundant stop in the explicit failure procedure is deliberate. It
covers an interrupted local shell, a failed trap SSH call, and an operator
who starts the documented recovery procedure independently.

### Keep all handoffs consistent

The specification and implementation plan will record the same two-phase
activation and new-service containment invariants. MWP-106 will receive the
same requirements in Linear so the production ticket cannot rely only on a
cross-reference to merged prose.

MWP-104 remains In Progress until the follow-up merges. The original PR #88
threads will be answered with the follow-up PR and resolved only after the
fix is present on its branch.

## Verification

The implementation begins with a targeted semantic audit that fails on the
merged PR #88 text:

- the pre-stage path reaches a service restart through the referenced
  activation procedure; and
- the failure-before-routing path does not first prove both new services
  inactive.

After the edits:

- every changed Bash block passes `bash -n`;
- the section-aware audit confirms pre-staging uses only the no-service-action
  phase;
- the final-state trap covers start, health, and post-start count failures;
- the recovery procedure stops and verifies both new services inactive before
  any old-host mutation or restart;
- all affected documents and MWP-106 state the same ordering;
- repository tests, lint, typecheck, build, Bun-pin validation,
  configuration-documentation validation, formatting, and
  `git diff --check` pass.

No permanent exact-string test over human-facing Markdown will be added. That
would be brittle under harmless prose changes and would reverse the prior
review decision. The executable shell syntax and section-level semantic audit
provide review evidence without making exact wording an API.

## Rejected alternatives

### Add a conditional restart flag

Rejected because the safe path would depend on an operator setting the flag
correctly. The pre-stage procedure must make premature start unrepresentable.

### Defer the `current` link swap to the cutover window

Rejected because it prevents complete pre-window validation of the installed
layout and lengthens the outage. A link-only activation provides the same
safety while leaving the unit stopped.

### Rely only on the explicit recovery procedure

Rejected because the new services would remain running between final-gate
failure and manual recovery. The automatic trap reduces that window, while
the explicit stop-and-verify gate provides the authoritative recovery
precondition.
