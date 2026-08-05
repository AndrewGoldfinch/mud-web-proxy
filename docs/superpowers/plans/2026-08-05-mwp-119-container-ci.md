# MWP-119 Container CI Implementation Plan

**Goal:** Add multi-arch build, image scanning, and a Caddy smoke test; keep
`CI_JOB_COVERAGE` honest.

## Global Constraints

- No Dockerfile or Compose behaviour change. If the smoke test finds a defect,
  surface it rather than fixing it here.
- Every new CI job gets a `CI_JOB_COVERAGE` entry; `check:defect-classes`
  enforces it.
- Docker-dependent jobs skip locally with a notice, as `container` does.
- Prove the scan gate can fail before claiming it works.

---

### Task 1: Multi-arch build

- [ ] Switch `tests/container/run.sh` to `docker buildx build` with
      `--platform` driven by an environment variable, defaulting to the host
      architecture so local runs stay fast.
- [ ] In `test.yml`, set amd64 for `pull_request` and both for tag pushes.
      Add buildx setup, QEMU only where arm64 is built, and layer caching.

### Task 2: Image scanning

- [ ] Add `tests/container/scan.sh`: build the runtime image, run Trivy,
      fail on HIGH or CRITICAL. Skip with a notice when Docker is absent.
- [ ] Add the `image-scan` job and its `CI_JOB_COVERAGE` entry.
- [ ] **Prove it fails.** Point the scan at a knowingly-vulnerable image and
      confirm non-zero exit, then revert.

### Task 3: Compose and Caddy smoke test

- [ ] Add `compose.test.yaml`: mock MUD target, Caddy internal CA, ports bound
      to loopback.
- [ ] Add `tests/compose/run.sh` asserting the upgrade through Caddy, a typed
      session, a legacy session, and real-client-address attribution.
- [ ] Add the `compose-e2e` job and its `CI_JOB_COVERAGE` entry.
- [ ] **Prove the attribution assertion fails** by switching the Caddyfile to
      an appending `header_up`, then revert.

### Task 4: Verify

- [ ] `bun run preflight:full` — must run the new jobs locally via the map.
- [ ] `check:defect-classes` passes, proving the map matches the workflow.
