# MWP-116 Community Health Files Design

## Goal

Add the files a public repository needs before strangers arrive: a private
disclosure channel, support routing, contribution instructions, a changelog,
ownership, and issue/PR templates. None of them exist today — `.github/`
contains only `dependabot.yml` and `workflows/`.

The issue is prescriptive about _what_ to create. This note records only the
decisions it leaves open.

## Decision 1: response timelines are the maintainer's commitment, not mine

`SECURITY.md` publishes a promise to strangers. The issue requires "expected
acknowledgement and fix timelines you can actually meet as a single
maintainer", which is a commitment only the maintainer can make.

Proposed, deliberately conservative for one person with no on-call rotation:

| Stage                  | Commitment                                             |
| ---------------------- | ------------------------------------------------------ |
| Acknowledgement        | within 7 days                                          |
| Initial assessment     | within 14 days                                         |
| Fix or mitigation plan | communicated with the assessment; no fixed fix-by date |
| Public disclosure      | coordinated, after a fix ships or 90 days              |

No fixed fix-by date is offered on purpose. A single maintainer cannot honour
"critical within 72 hours", and a published timeline that gets missed is worse
than a modest one that is kept.

**These numbers require the maintainer's explicit confirmation before merge.**
They are written into the file rather than left as placeholders so the document
is reviewable as it will actually read, but they are not mine to commit to.

## Decision 2: what is explicitly unsupported

The issue names PM2, direct exposure without a reverse proxy, and multi-replica
deployments. All three are already established elsewhere in the repository and
are restated in `SUPPORT.md` as scope, not as new policy:

- **PM2** — removed from the supported matrix; the native path is systemd.
- **Direct exposure without a reverse proxy** — both supported topologies put
  Caddy in front. Running the application on a public interface is a third
  topology requiring `INBOUND_TLS_MODE=required`, and is not what the
  deployment documents cover.
- **Multi-replica** — sessions and limiter state are memory-local. A second
  replica multiplies every limit rather than sharing them. This is stated in
  `docs/security.md` and `docs/operations.md`; `SUPPORT.md` points there.

## Decision 3: App Attest severity scope

`SECURITY.md` must state that App Attest is experimental and out of scope for
severity ratings. It should **link** `docs/security.md` for the reasoning
rather than restate it, matching the handoff already recorded on this issue
from MWP-112: `docs/security.md` is the authoritative technical model and
`SECURITY.md` is disclosure policy.

## Changelog scope

`CHANGELOG.md` starts at v4.0.0 in Keep a Changelog format. The breaking
configuration changes are the six retired variables, which are authoritative in
`RETIRED_ENV_VARS` (`scripts/check-config-docs.ts:81`) and each abort startup
naming their replacement:

| Retired                            | Replacement                                          |
| ---------------------------------- | ---------------------------------------------------- |
| `ONLY_ALLOW_DEFAULT_SERVER`        | `TARGET_MODE`                                        |
| `DISABLE_TLS`                      | `INBOUND_TLS_MODE=off`                               |
| `ALLOW_INSECURE_PRODUCTION_NO_TLS` | `INBOUND_TLS_MODE` + `ALLOW_INSECURE_INBOUND_NO_TLS` |
| `TRUST_PROXY`                      | `TRUSTED_PROXY_CIDRS`                                |
| `ALLOW_MTLS_FALLBACK`              | removed; use `AUTH_MODE=shared-secret`               |
| `MTLS_CLIENT_CA_PATH`              | removed with the above                               |

v4 is the first public release, so the entry describes what v4 _is_ rather than
a migration from a public predecessor. No migration guide — the same constraint
every specification in this project carries.

## No Code of Conduct

Deliberate, per the issue: an unenforced CoC promises a response nobody is
committed to giving. Revisit when there is a monitored enforcement contact.

## Repository settings

Two changes are settings rather than commits:

- **Discussions** — currently disabled; the issue-form `config.yml` routes
  questions there, so it must be enabled or that link dead-ends.
- **Private vulnerability reporting** — must be enabled or `SECURITY.md`
  directs researchers at a channel that does not accept reports.

Issues are already enabled. Both changes are reversible and are made through
the API, and are reported explicitly rather than folded silently into the PR.

## Success criteria

- All six files plus issue forms and a PR template exist.
- `SECURITY.md` directs to private reporting and links `docs/security.md`.
- The issue-form config routes security reports away from public issues.
- `CHANGELOG.md` names every retired variable and its replacement.
- Discussions and private vulnerability reporting are enabled and verified.
- The published timelines are ones the maintainer has confirmed.
