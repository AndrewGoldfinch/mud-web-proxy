# Cutover Failure Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two post-merge P1 findings on PR #88 by making premature
service start impossible during pre-staging and making new-service shutdown a
verified prerequisite of old-host recovery.

**Architecture:** Split native activation into a service-neutral atomic
`current`-link phase and a separate process activation phase. Add both
automatic failure containment around the final new-host start and an explicit
stop-and-inactive gate at the beginning of old-host recovery.

**Tech Stack:** Markdown, Bash, systemd, SSH, Bun 1.3.14, GitHub pull-request
review threads, Linear.

## Global Constraints

- Preserve the Ubuntu 26.04 LTS x64 new-Droplet cutover model.
- Preserve the static `mud-web-proxy` user and the prohibition on
  `DynamicUser=yes`.
- Preserve the mandatory App Attest key-count floor and atomic state-transfer
  rules.
- Pre-staging must leave `mud-web-proxy.service` inactive.
- No old-host state mutation, service restart, ingress restoration, or routing
  reversal may occur until both new services are verified inactive.
- Do not add a conditional `NO_RESTART`-style escape hatch.
- Do not add a permanent exact-string test over human-facing Markdown.
- Touch only the six documentation files named in this plan plus MWP-106 in
  Linear.

---

### Task 1: Separate link activation from process activation

**Files:**

- Modify: `docs/deployment/systemd.md:141-259`
- Modify: `docs/deployment/new-droplet-cutover.md:100-131`

**Interfaces:**

- Consumes: the release/runtime validation and atomic symlink replacement
  already documented under `Atomic activation`
- Produces: a service-neutral `Atomic current-link activation` phase and a
  separate `Apply an activated release` phase

- [ ] **Step 1: Run the red semantic audit**

Run:

```bash
set -euo pipefail

SYSTEMD_LINK_PHASE="$(
  sed -n \
    '/^## Atomic current-link activation$/,/^### Apply an activated release$/p' \
    docs/deployment/systemd.md
)"
PRE_STAGE="$(
  sed -n \
    '/^## Pre-stage the new host$/,/^## Take the App Attest safety copy$/p' \
    docs/deployment/new-droplet-cutover.md
)"

[[ -n "$SYSTEMD_LINK_PHASE" ]]
! grep -Eq 'systemctl (start|stop|restart)' <<<"$SYSTEMD_LINK_PHASE"
grep -Fq 'Atomic current-link activation' <<<"$PRE_STAGE"
grep -Fq 'systemctl is-active' <<<"$PRE_STAGE"
```

Expected: FAIL because the merged guide has only the monolithic
`Atomic activation` section and its referenced procedure restarts the proxy.

- [ ] **Step 2: Split the systemd procedure**

In `docs/deployment/systemd.md`:

1. Rename `## Atomic activation` to
   `## Atomic current-link activation`.
2. State immediately below the heading that the block validates the release,
   writes the rollback record, and swaps `current` but never starts, stops, or
   restarts a service.
3. Remove this line from the end of the existing block:

   ```bash
   systemctl restart mud-web-proxy
   ```

4. After the block, add:

   ````markdown
   ### Apply an activated release

   Normal upgrades run this phase only after the current-link phase exits
   zero:

   ```bash
   set -euo pipefail

   systemctl restart mud-web-proxy
   curl --fail --silent --show-error \
     http://127.0.0.1:6200/health >/dev/null
   ```

   Production acceptance still requires WSS and a complete mock-MUD session.
   A new-Droplet pre-stage does not run this phase.
   ````

5. Update the surrounding prose so “activation” explicitly means both phases
   during a normal upgrade.

- [ ] **Step 3: Make pre-stage use only the link phase**

Replace step 5 under `Pre-stage the new host` with requirements that:

- the verified release and MWP-105 files are installed;
- the unit is installed but inactive;
- the operator records
  `systemctl is-active mud-web-proxy || true` and requires exactly `inactive`;
- only `Atomic current-link activation` is run;
- the same state check after the link swap again requires `inactive`; and
- `Apply an activated release` is forbidden until the final App Attest
  transfer gate.

Use this exact state check in the prose:

```bash
PROXY_STATE="$(systemctl is-active mud-web-proxy || true)"
[[ "$PROXY_STATE" == "inactive" ]]
```

- [ ] **Step 4: Run the green semantic audit**

Re-run Step 1.

Expected: PASS. Also run:

```bash
PROCESS_PHASE="$(
  sed -n \
    '/^### Apply an activated release$/,/^## Offline rollback$/p' \
    docs/deployment/systemd.md
)"
grep -Fq 'systemctl restart mud-web-proxy' <<<"$PROCESS_PHASE"
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add docs/deployment/systemd.md \
  docs/deployment/new-droplet-cutover.md
git commit -m "docs: separate link and process activation (MWP-104)"
```

### Task 2: Contain a failed new-host start before recovery

**Files:**

- Modify: `docs/deployment/new-droplet-cutover.md:300-518`

**Interfaces:**

- Consumes: `NEW_HOST`, the aggregate App Attest transfer gate, and the
  existing `Failure before routing changes` procedure
- Produces: automatic stop-on-failure plus an authoritative
  stop-and-inactive recovery precondition

- [ ] **Step 1: Run the red recovery-order audit**

Run:

```bash
set -euo pipefail

FAILURE_SECTION="$(
  sed -n \
    '/^## Failure before routing changes$/,/^## Acceptance$/p' \
    docs/deployment/new-droplet-cutover.md
)"
STOP_LINE="$(
  grep -n -m1 'systemctl stop mud-web-proxy caddy' \
    <<<"$FAILURE_SECTION" | cut -d: -f1
)"
RESTORE_LINE="$(
  grep -n -m1 'SAFETY_STORE=' <<<"$FAILURE_SECTION" | cut -d: -f1
)"

[[ "$STOP_LINE" =~ ^[0-9]+$ ]]
[[ "$RESTORE_LINE" =~ ^[0-9]+$ ]]
((STOP_LINE < RESTORE_LINE))
grep -Fq 'systemctl is-active --quiet mud-web-proxy' <<<"$FAILURE_SECTION"
grep -Fq 'systemctl is-active --quiet caddy' <<<"$FAILURE_SECTION"
```

Expected: FAIL because the merged recovery procedure never stops or verifies
the new services.

- [ ] **Step 2: Extend the aggregate-gate cleanup trap**

Immediately before the existing `cleanup()` function, initialize:

```bash
REMOTE_INSTALL_TEMP=
NEW_SERVICES_MAY_BE_RUNNING=0
```

Replace the function with:

```bash
cleanup() {
  status=$?
  if [[ -n "$REMOTE_INSTALL_TEMP" ]]; then
    ssh "$NEW_HOST" "sudo rm -f -- '$REMOTE_INSTALL_TEMP'" || true
  fi
  if ((status != 0 && NEW_SERVICES_MAY_BE_RUNNING == 1)); then
    ssh "$NEW_HOST" \
      'sudo systemctl stop mud-web-proxy caddy' || true
  fi
  return "$status"
}
trap cleanup EXIT
```

Set the flag before the start attempt so partial start failure is covered:

```bash
NEW_SERVICES_MAY_BE_RUNNING=1
ssh "$NEW_HOST" 'sudo systemctl start mud-web-proxy caddy'
```

After loopback health and the post-start count both pass, disarm containment:

```bash
NEW_SERVICES_MAY_BE_RUNNING=0
trap - EXIT
```

State in prose that a nonzero start or later gate automatically attempts to
stop both services, but the explicit recovery precondition remains
authoritative.

- [ ] **Step 3: Gate recovery on verified new-service inactivity**

At the start of the `Failure before routing changes` shell block:

1. define `NEW_HOST=production-new`;
2. validate it with `: "${NEW_HOST:?}"`; and
3. before reading `SAFETY_STORE`, run:

   ```bash
   ssh "$NEW_HOST" \
     'sudo systemctl stop mud-web-proxy caddy &&
      ! systemctl is-active --quiet mud-web-proxy &&
      ! systemctl is-active --quiet caddy'
   ```

Update the prose to state that failure of this command aborts recovery before
any old-host mutation, restart, ingress restoration, or routing reversal.

- [ ] **Step 4: Run the green recovery-order audit**

Re-run Step 1.

Expected: PASS. Then confirm the containment flag precedes start and is
disarmed only after the post-start count:

```bash
FINAL_GATE="$(
  sed -n \
    '/Install and verify the valid final store/,/^## Failure before routing changes$/p' \
    docs/deployment/new-droplet-cutover.md
)"
FLAG_LINE="$(
  grep -n -m1 'NEW_SERVICES_MAY_BE_RUNNING=1' \
    <<<"$FINAL_GATE" | cut -d: -f1
)"
START_LINE="$(
  grep -n -m1 'systemctl start mud-web-proxy caddy' \
    <<<"$FINAL_GATE" | cut -d: -f1
)"
DISARM_LINE="$(
  grep -n 'NEW_SERVICES_MAY_BE_RUNNING=0' \
    <<<"$FINAL_GATE" | tail -n1 | cut -d: -f1
)"
COUNT_LINE="$(
  grep -n -m1 'POST_START_COUNT.*LOCAL_FINAL_COUNT' \
    <<<"$FINAL_GATE" | cut -d: -f1
)"
((FLAG_LINE < START_LINE))
((COUNT_LINE < DISARM_LINE))
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add docs/deployment/new-droplet-cutover.md
git commit -m "docs: stop new services before cutover recovery (MWP-104)"
```

### Task 3: Synchronize the specification, plan, and Linear handoff

**Files:**

- Modify:
  `docs/superpowers/specs/2026-07-30-systemd-release-and-cutover-design.md`
- Modify:
  `docs/superpowers/plans/2026-07-30-systemd-release-and-cutover.md`
- Verify:
  `docs/superpowers/specs/2026-07-30-cutover-failure-gates-design.md`
- External update: Linear MWP-106

**Interfaces:**

- Consumes: the two implemented ordering invariants from Tasks 1 and 2
- Produces: published activation requirements consumed by MWP-103 and MWP-105,
  plus identical executable obligations in MWP-106

- [ ] **Step 1: Update the original MWP-104 specification**

Under `Upgrade and rollback`, define link activation as service-neutral and
process activation as the separate restart/acceptance phase. Under
`Pre-stage`, require the proxy inactive before and after link activation and
forbid process activation before final-state installation.

Under `Cutover window`, require automatic stop-on-failure after the new start
attempt. Under `Infrastructure rollback`, require both new services stopped
and verified inactive before old-host state mutation or restart.

- [ ] **Step 2: Update the original implementation plan**

Apply the same changes to the embedded required outline and acceptance
language:

- `Atomic current-link activation`;
- `Apply an activated release`;
- pre-stage inactive-before/inactive-after checks;
- final-gate automatic containment; and
- explicit recovery stop-and-inactive ordering.

Do not rewrite completed task history unrelated to these two findings.

- [ ] **Step 3: Update MWP-106 in Linear**

Read MWP-106 first. Append these explicit obligations without replacing its
existing description:

- pre-stage uses link-only activation and verifies the proxy inactive before
  and after;
- final-state start is guarded by automatic stop-on-failure cleanup; and
- failure-before-routing stops and verifies both new services inactive before
  old-host state restoration, service restart, ingress restoration, or
  routing reversal.

Add a comment linking both original PR #88 review threads and stating that the
follow-up PR implements them.

- [ ] **Step 4: Commit Task 3**

```bash
git add \
  docs/superpowers/specs/2026-07-30-systemd-release-and-cutover-design.md \
  docs/superpowers/plans/2026-07-30-systemd-release-and-cutover.md
git commit -m "docs: propagate cutover failure invariants (MWP-104)"
```

### Task 4: Verify and publish the follow-up pull request

**Files:**

- Verify: all six changed Markdown files
- External update: PR #88 review threads
- External create: follow-up draft pull request

**Interfaces:**

- Consumes: Tasks 1-3
- Produces: a reviewable GitHub follow-up linked from MWP-104, MWP-106, and
  both original review threads

- [ ] **Step 1: Validate every changed Bash block**

Extract every `bash` fenced block from the changed operational documents into
a mode-`0700` temporary directory and run `bash -n` on each extracted file.
Require at least one block from each document:

````bash
set -euo pipefail

CHECK_DIR="$(mktemp -d /tmp/mwp104-bash.XXXXXX)"
cleanup() {
  find "$CHECK_DIR" -depth -delete
}
trap cleanup EXIT

for doc in \
  docs/deployment/systemd.md \
  docs/deployment/new-droplet-cutover.md; do
  prefix="$(basename "$doc" .md)"
  awk -v out="$CHECK_DIR" -v prefix="$prefix" '
    /^```bash$/ { in_block = 1; block += 1; next }
    /^```$/ && in_block {
      close(file)
      in_block = 0
      next
    }
    in_block {
      file = out "/" prefix "-" block ".sh"
      print >> file
    }
  ' "$doc"
done

count=0
for script in "$CHECK_DIR"/*.sh; do
  bash -n "$script"
  count=$((count + 1))
done
((count > 0))
printf 'bash_blocks_checked=%s\n' "$count"
````

- [ ] **Step 2: Run full repository verification with exact Bun 1.3.14**

Run:

```bash
set -euo pipefail

VERIFY_DIR="$(mktemp -d /tmp/mwp104-verify.XXXXXX)"
cleanup() {
  find "$VERIFY_DIR" -depth -delete
}
trap cleanup EXIT

curl -fsSL \
  https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip \
  -o "$VERIFY_DIR/bun.zip"
unzip -q "$VERIFY_DIR/bun.zip" -d "$VERIFY_DIR"
export PATH="$VERIFY_DIR/bun-linux-x64:$PATH"

bun --version
bun test tests/*.test.ts --coverage
bun run lint
bun run typecheck
bun run build
bun run check:bun-version
bun run check:config-docs
bun run format
git diff --check origin/main...HEAD
test -z "$(git status --short)"
```

Expected: Bun `1.3.14`; 1,063 tests and zero failures; every remaining command
exits zero; clean worktree.

- [ ] **Step 3: Push and create the draft PR**

Confirm `git status -sb`, `git diff --stat origin/main...HEAD`, and
`git log --oneline origin/main..HEAD`. Push:

```bash
git push -u origin docs/mwp-104-cutover-failure-gates
```

Create a draft PR against `main` with:

- both P1 review-thread URLs;
- the post-merge timing/root cause;
- the two-phase activation fix;
- automatic and explicit new-service containment;
- the exact verification evidence; and
- `MWP-104` in the title.

- [ ] **Step 4: Link the PR and address the original threads**

Add the PR link and verification summary to MWP-104 and MWP-106.

Reply in each original PR #88 inline thread with the follow-up PR URL and the
specific fix. Resolve each thread only after confirming the fix is present on
the pushed branch.

- [ ] **Step 5: Final read-back**

Verify:

- the follow-up PR is open and draft;
- its head SHA equals the pushed local SHA;
- MWP-104 remains In Progress;
- MWP-106 contains all three new obligations; and
- both PR #88 threads are resolved with replies linking the follow-up.
