# MWP-122 Security Regression Suite Implementation Plan

**Goal:** Close the three demonstrated gaps; record the remainder.

## Global Constraints

- No production behaviour change. These are tests.
- Every new test must be shown to fail when its protection is removed.
- Do not duplicate coverage the audit found already working.

---

### Task 1: Pin DNS-rebinding non-re-resolution

- [ ] **Step 1** In `tests/connect-path-dns.test.ts`, add a test whose resolver
      returns a **different** address on each call and counts invocations.
      Assert the dialled address is the first answer and the resolver was
      called exactly once.
- [ ] **Step 2** Prove it fails: make the connect path re-resolve, confirm red,
      revert.

### Task 2: Pin the constant-time comparison

- [ ] **Step 1** Add a test asserting the shared-secret comparison path uses
      `crypto.timingSafeEqual` — spy on it and assert it was called during a
      comparison.
- [ ] **Step 2** Prove it fails: swap the implementation for `===`, confirm
      red, revert.

### Task 3: Add the Compose deployment contract test

- [ ] **Step 1** `tests/deployment/compose-contract.test.ts`, mirroring
      `systemd-contract.test.ts`: assert `compose.yaml` sets
      `TRUSTED_PROXY_CIDRS` to the pinned stack subnet and not something wider,
      and that `Caddyfile` **sets** rather than appends `X-Forwarded-For` and
      `X-Real-IP`.
- [ ] **Step 2** Prove it fails: widen the CIDR and switch a `header_up` to an
      appending form, confirm red, revert.

### Task 4: Verify and hand off the remainder

- [ ] **Step 1** `bun run preflight:full`
- [ ] **Step 2** Comment on MWP-122 with the audit table and the three items
      deliberately left open, so the issue is not closed as if complete.
