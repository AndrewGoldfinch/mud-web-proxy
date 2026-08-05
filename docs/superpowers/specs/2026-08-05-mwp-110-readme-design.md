# MWP-110 README Rewrite Design

## Goal

Rewrite `README.md` around "should I run this, and how?" rather than "what is
this project's history". The landing page is where an operator decides whether
to trust the software, and today it opens with a fork story.

## What is wrong with the current README

231 lines, ordered: what is this → history → motivation → features →
installation → Docker image → Compose → systemd → direct TLS → configuration →
license.

- **Security posture appears nowhere above the fold.** The one risk-adjacent
  sentence is a feature-list bullet: "To avoid abuse, default installation only
  allows connection to an specific server". An operator learns that the proxy
  dials arbitrary TCP on their behalf only by reading `configuration.md`.
- **History and motivation occupy the second and third sections**, before the
  reader knows what the thing does operationally.
- **It cites internal issue numbers** — MWP-102, MWP-103, MWP-104 — on a public
  landing page. These resolve to a private tracker and mean nothing to a
  reader.
- **PM2 survives** in one line, inside an internal cutover paragraph that
  should not be in a public README at all.
- **Three install paths compete** (bare `bun dev`, a raw `docker run`, Compose,
  systemd) with no statement of which an operator should choose.

## Chosen structure

Order is the design. Everything an operator needs to decide _whether_ to run it
comes before anything about _how_.

```markdown
# mud-web-proxy

<one-paragraph what-it-is>

## What this does on your behalf <- the risk statement, above the fold

## Requirements

## Quickstart: Docker Compose

## Quickstart: Bun + systemd

## Configuration

## Documentation

## Project lineage

## License
```

`What this does on your behalf` is the section the issue asks for and the one
the current README lacks entirely. Three facts, stated plainly:

- the proxy opens outbound TCP connections on behalf of remote clients, and
  `TARGET_MODE` is the only thing deciding where — a permissive setting makes
  the host a relay;
- sessions are memory-local and every restart drops them;
- the browser hop and the upstream hop are independent: WSS to the browser
  says nothing about the MUD link, which is usually plaintext.

Each links to `security.md` for the full treatment. This is deliberately not a
summary of the threat model — it is the three things that change an operator's
decision, and a pointer.

`Project lineage` moves to the bottom and points at `NOTICE`, which already
carries the upstream authorship and MIT-derived attribution in the form the
licence requires.

## Two quickstarts, each self-contained

The acceptance criterion is "work verbatim on a clean host with no source
edits". That rules out the current `bun dev` path (no TLS, no edge) and the raw
`docker run` example (loopback only, explicitly a test aid). Both are removed
from the landing page; the Docker-image details already live in
`deployment/images.md`.

What remains is two paths that each end in a working WSS endpoint:

- **Docker Compose** — copy `.env.compose.example`, set the domain and target,
  `docker compose up -d`.
- **Bun + systemd** — the release bundle, the unit, and Caddy.

Neither is expanded into a full walkthrough. `deployment/compose.md` and
`deployment/systemd.md` own those, and duplicating them here would create the
drift this project has repeatedly gated against.

## Links: what exists, and what cannot be linked yet

Item 6 of the issue lists nine link targets. Five do not exist:

| Target                  | Status                           |
| ----------------------- | -------------------------------- |
| configuration reference | `docs/configuration.md` — exists |
| security model          | `docs/security.md` — exists      |
| operations guide        | `docs/operations.md` — exists    |
| `LICENSE`, `NOTICE`     | exist                            |
| `SECURITY.md`           | **absent** — MWP-116             |
| `CONTRIBUTING.md`       | **absent** — MWP-116             |
| protocol docs           | **absent** — MWP-113             |
| privacy guidance        | **absent** — MWP-115             |
| migration guide         | **should not exist** — see below |

**The migration-guide requirement is stale and should be struck from the
issue.** v4 is the first public release. Every specification in this project
carries an explicit "add no migration documentation" constraint, and MWP-112's
and MWP-114's plans both restate it. There is no prior public version to
migrate from.

For the other four: no placeholder links. A link that 404s on the landing page
is worse than an absent one, and MWP-114 already established that rule. The
`Documentation` section links what exists and is structured so the missing
entries slot in without restructuring.

**Consequently the acceptance criterion "Security reporting, support,
contribution, licensing, and privacy guidance are all linked from the README"
cannot be met by this issue alone.** Licensing is covered; security reporting
and contribution need MWP-116; privacy needs MWP-115. This is stated in the PR
rather than quietly ignored, and MWP-116 already carries a note from MWP-112
about linking back to `security.md` — it should gain one about the README too.

## Verification

The issue's stated test is to hand the README to someone with no context and
have them complete a quickstart on a fresh VM. The approximation available here
is stronger than a link check and weaker than a human: **run each quickstart
verbatim on a fresh droplet**, pasting only what the README contains, and stop
at the first instruction that requires knowledge the README does not give.

Anything that cannot be completed from the README alone is a defect in the
README, not a step to be worked around with outside knowledge.

Plus the issue's own mechanical check:

```bash
rg -ni 'pm2' README.md   # must return nothing
```

## Out of scope

- Creating `SECURITY.md`, `CONTRIBUTING.md`, protocol docs, or privacy
  guidance. Those are MWP-116, MWP-113, and MWP-115.
- Any migration documentation.
- Changing deployment behaviour, configuration, or the deployment documents.
- Rewriting `docs/mud-proxy-guide.md`, which is MWP-113's.

## Success criteria

- A reader learns what the proxy does and its three sharp edges within the
  first screen, before any install command.
- Both quickstarts complete verbatim on a fresh host with no source edits and
  no outside knowledge.
- No PM2, no internal issue numbers, no pre-fork deployment story.
- Every link resolves; none is a placeholder.
- Lineage and attribution remain present, moved below the operational content
  and pointing at `NOTICE`.
- The PR states which acceptance criterion remains open and why.
