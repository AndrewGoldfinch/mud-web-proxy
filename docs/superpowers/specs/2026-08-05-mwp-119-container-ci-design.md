# MWP-119 Container CI Design

## Goal

Give the Compose path the CI coverage the systemd path already has: prove the
image builds, prove it is not shipping known-critical vulnerabilities, and
prove a WebSocket session survives Caddy.

## Most of the hardening is already asserted

An audit of `tests/container/run.sh` and `tests/docker-image-contract.test.ts`
against MWP-119's five acceptance criteria:

| Criterion                                         | Status                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Non-root                                          | **Covered** — asserts `Config.User == '10001:10001'`                                                |
| Read-only rootfs, dropped caps, no-new-privileges | **Covered** — containers run with all three and EROFS is checked                                    |
| Graceful SIGTERM                                  | **Covered** — asserts `StopSignal == SIGTERM`, shutdown verified in logs                            |
| Port 6200 not published                           | **Covered** — `--publish 127.0.0.1::6200`; MWP-122's `compose-contract` also asserts it for Compose |
| amd64 and arm64 built in CI                       | **Missing** — plain `docker build`, single arch                                                     |
| Image scanning, fail on HIGH/CRITICAL             | **Missing** — nothing anywhere                                                                      |
| Full session through Caddy, both protocols        | **Missing** — `run.sh` mentions Caddy zero times                                                    |

Item 3 is the one the issue says "matters more than it sounds", and it is
right: **nothing in CI proves the WebSocket upgrade survives the reverse
proxy.** That integration was verified by hand during MWP-110's host
acceptance and by nothing automatic.

## Decision 1: amd64 on PRs, both architectures on tags

The issue asks for both architectures on every PR. arm64 under QEMU adds
5–15 minutes to every pull request, and `release.yml` already publishes
multi-arch to GHCR on tags.

**Confirmed with the maintainer:** PRs build and test amd64; tags build both.
This catches Dockerfile breakage on every PR without paying QEMU cost on every
push, and arch-specific breakage is still caught before anything is published.
It deviates from the issue's literal wording and the PR says so.

## Decision 2: scanning fails the build

**Confirmed with the maintainer:** a HIGH or CRITICAL finding in the runtime
image fails CI. That is the issue's criterion and the point of the gate — an
image with a known critical vulnerability should not be one merge away from
being published.

The consequence is real and worth stating: a new CVE in the Bun base image will
block unrelated pull requests until the base is bumped. That pressure is
intended. If it becomes untenable, the fix is a checked-in ignore file with
justifications and expiry dates, not disabling the gate.

Scanning targets the **runtime** stage. Scanning the build stage would report
toolchain vulnerabilities that never ship.

## Decision 3: two new jobs, not extra steps on `container`

`CI_JOB_COVERAGE` in `scripts/preflight.sh` maps CI jobs to local commands and
`check:defect-classes` fails when it disagrees with the workflow's job list. It
is job-level, not step-level.

Adding CI-only steps to the existing `container` job would make preflight claim
coverage it does not have — exactly the drift the map was built to prevent. So
each new capability is its own job with its own entry:

| Job           | Local command                  |
| ------------- | ------------------------------ |
| `image-scan`  | `bash tests/container/scan.sh` |
| `compose-e2e` | `bash tests/compose/run.sh`    |

Both are Docker-dependent and skip with a notice when Docker is absent, like
`container` already does.

## The Caddy smoke test

The one genuinely new piece of verification. A `compose.test.yaml` override
brings the stack up against the mock MUD with Caddy's internal CA standing in
for ACME — a public certificate needs public DNS, which CI does not have.

It asserts:

1. the WebSocket upgrade completes **through Caddy** (`101`);
2. a session runs on the typed protocol;
3. a session runs on the legacy protocol;
4. the proxy attributes the connection to the **real client address**, not
   Caddy's — the assertion the issue singles out, and the one that catches a
   missing or appending forwarded-header configuration.

Assertion 4 is the reason this is worth building. `compose-contract.test.ts`
(MWP-122) asserts the Caddyfile is configured correctly as text; this asserts
the configuration actually produces the right attribution at runtime.

## Out of scope

- Pushing images. `release.yml` owns publication.
- Changing the Dockerfile or Compose stack. If the smoke test finds a defect,
  surface it rather than fixing it under a CI ticket.

## Success criteria

- amd64 builds on every PR; both architectures on tags.
- A HIGH/CRITICAL finding in the runtime image fails CI, demonstrated.
- A session completes through Caddy on both protocols.
- The proxy logs the real client address, not Caddy's.
- `CI_JOB_COVERAGE` lists every new job and `check:defect-classes` passes.
