# MWP-115 App Attest and Push Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `docs/app-attest-and-push.md`, linked from the README and the
security model.

## Global Constraints

- No runtime, configuration, or test change.
- Separate local attestation verification from APNS egress. Do not write
  "sends data to Apple" over both.
- No legal advice. Name what the operator holds; do not interpret regulation.
- Every storage claim comes from source or from a run, not from the issue.

---

### Task 1: Write the document

- [ ] **Step 1: Purpose and irrelevance**

Say up front that both features exist for one iOS client and that a generic
MUD proxy deployment should leave them off.

- [ ] **Step 2: Off by default, and what enabling looks like**

Both `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID` are required; one alone is a
startup error. `/attest/*` returns 404 when disabled — verified.

- [ ] **Step 3: Experimental status, in the body**

No independent cryptographic review. State what an operator should not rely on
it for, and recommend pairing with `AUTH_MODE=shared-secret`.

- [ ] **Step 4: Data flows, separated**

App Attest verifies locally against the bundled Apple root CA and sends Apple
nothing. APNS is the only Apple egress. Enumerate stored state, caps, and TTLs.

- [ ] **Step 5: Privacy implications**

Attested key identifiers versus push tokens. Push tokens are device
identifiers; holding them is a correlation capability.

- [ ] **Step 6: Operational requirements and purge**

Apple developer account, key, identifiers, how to supply them without baking
them into an image or the repository. Then disable-and-purge.

---

### Task 2: Verify the purge instructions

- [ ] **Step 1: Enable, produce state, disable, purge**

Run the proxy with App Attest enabled, confirm the state path, stop it, follow
the document's purge steps verbatim, and confirm no residual state.

- [ ] **Step 2: Confirm the routes are gone after disabling**

`/attest/challenge` must return 404 again.

---

### Task 3: Link and publish

- [ ] **Step 1: README and security model links**
- [ ] **Step 2: `bun run preflight` and a link check**
- [ ] **Step 3: Scope check**
