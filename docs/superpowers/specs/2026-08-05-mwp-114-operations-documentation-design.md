# MWP-114 Operations Documentation Design

## Goal

Give an operator who has installed mud-web-proxy a single day-two entry point:
how to run it, what to check when it misbehaves, and what every fail-fast
startup error means. Publish it at `docs/operations.md`.

## The issue's premise has drifted

MWP-114 was written on 2026-07-28 and says of upgrade, rollback, certificate
renewal, backup, restore, and diagnosis: **"None of that is written down."**
That was true then. It is substantially false now. MWP-104, MWP-105, and
MWP-106 landed 2,200 lines of deployment documentation in between:

| Existing document                        | Lines | Already covers                                                                                                                                                                                                                      |
| ---------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/deployment/systemd.md`             | 759   | Filesystem layout, service identity, installing a release, atomic current-link activation, offline rollback, retention and pruning, backup-required versus disposable data, provider firewall/monitoring/backups, operator commands |
| `docs/deployment/new-droplet-cutover.md` | 1088  | Full cutover runbook, sizing, retention                                                                                                                                                                                             |
| `docs/deployment/compose.md`             | 247   | Quickstart, configuration, App Attest state, volumes, health/restarts/logs, operations                                                                                                                                              |
| `docs/deployment/images.md`              | 139   | Tag policy, digest verification and pinning, upgrading a pinned deployment                                                                                                                                                          |
| `docs/deployment/systemd-acceptance.md`  | 314   | Acceptance measurement and evidence review                                                                                                                                                                                          |
| `docs/configuration.md`                  | 402   | Every variable, with the memory-local session note                                                                                                                                                                                  |

Writing MWP-114's nine sections as originally scoped would restate upgrade,
rollback, backup, and restore procedures that `systemd.md` already owns in
greater operational detail. This project has twice been burned by a claim
duplicated in prose drifting from the thing it described, and has twice built a
gate in response (`CI_JOB_COVERAGE`, `check:config-docs`). Producing a second
copy of the rollback procedure would be a third instance, not a mitigation.

The issue's other premise — that `docs/mud-proxy-guide.md` "predates the v4
architecture" — is true but misattributed. That file is an iOS client
implementation guide covering the session model, Telnet handling, and both wire
formats. Its staleness belongs to **MWP-113** (document the typed and legacy
client protocols), not here.

## What is genuinely missing

Verified by searching every deployment document and the configuration
reference:

| MWP-114 item                     | Status today                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Troubleshooting                  | **Absent.** The string "troubleshoot" appears in no deployment document.                                    |
| Log rotation and retention       | **Absent.** "rotation" appears nowhere.                                                                     |
| Certificate renewal              | **Partial.** `compose.md` mentions renewal; the systemd path does not cover it at all.                      |
| Health and diagnostics semantics | **Scattered** across four documents; no single statement of what each field means.                          |
| Capacity sizing                  | **Scattered**; no guidance converting limits into host sizing.                                              |
| Memory-local sessions            | **Buried.** Stated only in `configuration.md`, not where an operator planning an upgrade window would look. |
| Deployment walkthroughs          | Covered in full by `deployment/*.md`.                                                                       |
| Upgrade and rollback             | Covered by `systemd.md` and `images.md`.                                                                    |
| Backup and restore               | Covered by `systemd.md` ("Backup-required and disposable data").                                            |

## Chosen architecture

`docs/operations.md` is the **day-two entry point**. It owns what nothing owns
and routes to what is already owned. The seam:

- `deployment/*.md` own **installing and changing** the system — day one.
- `operations.md` owns **running and diagnosing** it — day two.
- `configuration.md` owns variable metadata.
- `security.md` owns trust boundaries and residual risk.

Sections, in order:

```markdown
# Operations

## Before you start

## Which deployment am I running?

## Health and diagnostics

## Logs

## Certificate renewal

## Routine changes

## Backup and restore

## Capacity and sizing

## Troubleshooting
```

`Routine changes` and `Backup and restore` are deliberately short: they state
the operational consequences that the procedure documents do not — above all
that **every upgrade and every rollback drops all active sessions** — and then
link to the authoritative procedure rather than restating it.

`Troubleshooting` is the bulk of the new content and the reason this document
exists.

## The troubleshooting contract

The acceptance criterion "every fail-fast startup error has a troubleshooting
entry with a remedy" is a claim about a set, and sets drift. `src/runtime-config.ts`
currently has 28 `errors.push` sites spanning two classes:

- **Retired variables** — `ONLY_ALLOW_DEFAULT_SERVER`, `DISABLE_TLS`,
  `ALLOW_INSECURE_PRODUCTION_NO_TLS`, `TRUST_PROXY`, `ALLOW_MTLS_FALLBACK`,
  `MTLS_CLIENT_CA_PATH`. Each aborts startup and names its replacement.
- **Validation failures** — allowlist with no valid entries, arbitrary without
  ports, arbitrary without enforced authentication, shared-secret without a
  secret or below 32 code units, `REQUIRE_APP_AUTH` without App Attest, App
  Attest half-configured, unwritable attested-key directory, non-loopback
  plaintext without acknowledgement, heartbeat timeout below interval,
  per-address message rate below per-connection.

Each entry states the symptom as the operator sees it — the literal aborted
startup line — then the cause, then the remedy.

**Recommendation, for explicit decision:** add `check:ops-docs`, a script that
fails the build when a `errors.push` message in `src/runtime-config.ts` has no
corresponding troubleshooting entry. This is the same executable-data pattern
as `check:config-docs`, and it converts the acceptance criterion from a claim
into a gate.

The tradeoff: it adds a script and a CI gate to a documentation issue, and it
needs a stable key linking message to entry, which means the error strings gain
a light coupling to the document. The alternative is a prose claim that is true
on the day it is written. Given this project's history, the gate is worth it —
but it is scope beyond the issue as filed, so it is called out here rather than
assumed.

## Verification and the host constraint

Most of this document is verifiable locally:

- every fail-fast error can be provoked by starting the process with the
  offending environment and capturing the actual output;
- `/health` shape and the draining 503 are assertable against a running
  process;
- the Compose path runs locally under Docker, which `preflight:full` already
  exercises;
- `tests/deployment/systemd-contract.test.ts` pins the systemd unit's shape.

What is **not** verifiable locally is the acceptance criterion "upgrade,
rollback, certificate renewal, backup, and restore are documented **and
tested**": those need a real host, and neither existing droplet is eligible.
`589287826` serves production at `mud-proxy.kingfrat.com`; `550847252` is the
stopped rollback target retained until 2026-08-09. The verification procedure
is destructive by design — it includes rolling back, restoring, and
deliberately triggering three misconfigurations — so it requires a disposable
host.

Every claim written from a procedure that has not been executed on a host is
marked as such in the document until it has been. The document does not assert
a tested restore it has not performed; an untested restore procedure is a
guess, and the issue says so itself.

## Out of scope

- Rewriting or retiring `docs/mud-proxy-guide.md`; that belongs to MWP-113.
- Restating install, activation, rollback, backup, or cutover procedures that
  `deployment/*.md` already own.
- Any runtime, configuration, or deployment behaviour change. If writing the
  troubleshooting table exposes a startup error whose message does not match
  what the code does, stop and surface it rather than documenting the
  discrepancy as intended behaviour.
- A root `SECURITY.md` or migration guide.

## Success criteria

- `docs/operations.md` exists with the nine sections above and is linked from
  the README.
- Every one of the 28 fail-fast startup errors has an entry with symptom,
  cause, and remedy, and each entry's symptom text matches the string the code
  actually emits.
- The memory-local session limitation appears in `Before you start`, not only
  in a table cell.
- Health and diagnostics behaviour matches the implementation, including the
  draining 503 and the admin-token requirement.
- No procedure that `deployment/*.md` owns is restated; each is linked.
- Any step not executed against a host is labelled unverified, and the PR
  states which acceptance criteria remain open.
