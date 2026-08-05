# MWP-114 Operations Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `docs/operations.md` as the day-two operator entry point,
covering what no existing document covers, and linking rather than restating
what `deployment/*.md` already owns.

**Architecture:** One new document. Its bulk is a troubleshooting table built
from the _actual_ output of a process that refused to start, not from reading
the source. Everything else is short and routes to the authoritative procedure.

**Tech Stack:** Markdown, Bun for provoking real startup failures, Docker for
the Compose path, the repository's own preflight gates.

## Global Constraints

- Add no runtime, configuration, or deployment behaviour change.
- Do not restate install, activation, rollback, backup, or cutover procedures
  that `docs/deployment/*.md` own. Link them.
- Do not touch `docs/mud-proxy-guide.md`; its staleness is MWP-113's.
- Source behaviour wins over existing prose, and **observed** output wins over
  source reading: every symptom string is copied from a real run.
- If a startup error's message contradicts what the code does, stop and surface
  it rather than documenting the discrepancy as intended.
- Every upgrade and every rollback drops all active sessions. This must appear
  where an operator planning a maintenance window will see it, not only in a
  table cell.
- Label any procedure not executed against a real host as unverified. Never
  describe an untested restore as tested.
- v4 is the first public release; add no migration documentation.

---

### Task 1: Capture the verified fail-fast error inventory

**Files:**

- Read: `src/runtime-config.ts`
- Create: scratch capture only; no tracked file

**Interfaces:**

- Produces: a verbatim symptom string for each of the 28 `errors.push` sites,
  used as the sole source for Task 3's table.

- [ ] **Step 1: Enumerate the sites**

```bash
grep -n "errors.push" src/runtime-config.ts | wc -l
grep -n "errors.push" -A4 src/runtime-config.ts
```

Expected: 28 sites. If the count differs, the inventory below is stale — use
the live count and reconcile before continuing.

- [ ] **Step 2: Provoke each error and capture the real output**

For each site, start the process with the offending environment and record the
exact line the process printed. Errors accumulate under one
`Configuration errors:` header, so a run may yield several at once; that is
fine, but each captured line must be attributable to one cause.

```bash
TARGET_MODE=arbitrary AUTH_MODE=none BIND_HOST=127.0.0.1 \
  INBOUND_TLS_MODE=off timeout 10 bun wsproxy.ts 2>&1 | sed -n '/Configuration errors/,/^ *at /p'
```

Repeat with the environment for each remaining case: each retired variable
(`ONLY_ALLOW_DEFAULT_SERVER`, `DISABLE_TLS`, `ALLOW_INSECURE_PRODUCTION_NO_TLS`,
`TRUST_PROXY`, `ALLOW_MTLS_FALLBACK`, `MTLS_CLIENT_CA_PATH`); allowlist with an
empty and with an all-malformed `ALLOWED_TARGETS`; `AUTH_MODE=shared-secret`
with no secret and with a 31-unit secret; `REQUIRE_APP_AUTH=true` without App
Attest; App Attest with only one identifier; an unwritable attested-key
directory; non-loopback plaintext without `ALLOW_INSECURE_INBOUND_NO_TLS`;
`WS_HEARTBEAT_TIMEOUT_MS` at or below `WS_HEARTBEAT_INTERVAL_MS`;
`MAX_MESSAGES_PER_SECOND_PER_IP` below `MAX_MESSAGES_PER_SECOND`;
`INBOUND_TLS_MODE=required` with missing, unreadable, and mismatched material.

Expected: every site produces an observed line. A site that cannot be provoked
is either unreachable or guarded by something undocumented — record which, and
do not invent a symptom for it.

- [ ] **Step 3: Confirm the health contract by observation**

```bash
BIND_HOST=127.0.0.1 INBOUND_TLS_MODE=off ALLOW_INSECURE_INBOUND_NO_TLS=true \
  WS_PORT=6390 TN_HOST=localhost TN_PORT=4000 bun wsproxy.ts &
sleep 2; curl -si localhost:6390/health | head -12; kill %1
```

Expected: `200` with `{"status":"healthy","version":"…"}`. Record the exact
key set and the version source. Confirm the draining `503` separately by
sending `SIGTERM` and polling during the shutdown grace.

---

### Task 2: Write everything except troubleshooting

**Files:**

- Create: `docs/operations.md`
- Read: `docs/deployment/systemd.md`, `docs/deployment/compose.md`,
  `docs/deployment/images.md`, `docs/configuration.md`, `docs/security.md`,
  `src/shutdown.ts`, `wsproxy.ts`

- [ ] **Step 1: Create the document with the approved section contract**

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

- [ ] **Step 2: Write `Before you start`**

Must state, prominently and near the top:

- sessions and rate-limiter state are memory-local and **every restart,
  upgrade, and rollback drops all active sessions**, so maintenance windows
  belong off-peak;
- one process is one replica; running two multiplies every limit;
- this document covers running the service — installing it is
  `deployment/systemd.md` or `deployment/compose.md`, and variable metadata is
  `configuration.md`.

- [ ] **Step 3: Write `Which deployment am I running?`**

A short decision aid mapping observable facts (a `systemd` unit versus a
Compose project) to which procedure document applies. No procedure content.

- [ ] **Step 4: Write `Health and diagnostics`**

From Task 1 Step 3's observation, not from source reading: the exact `/health`
key set, `200` healthy versus `503` draining, and what each field means.
Then diagnostics: disabled by default, admin token required when enabled, and
what that exposes. Cross-reference `security.md` for why it is off by default.

- [ ] **Step 5: Write `Logs`, `Certificate renewal`, `Capacity and sizing`**

These three are new content, not links:

- **Logs** — where they land per deployment (`journalctl` versus the Compose
  driver), what `LOG_LEVEL` changes, what is deliberately not recorded
  (cross-reference the redaction work rather than restating it), and rotation
  and retention for both paths.
- **Certificate renewal** — automatic under Caddy on both paths; the volume or
  directory that must persist or renewal silently breaks; what to check when it
  fails. `compose.md` mentions renewal; the systemd path currently has nothing.
- **Capacity and sizing** — converting the session, message-rate, and buffer
  limits into host sizing, anchored to the measured production profile
  (139 MB against a 384 MB `MemoryHigh`, 13 file descriptors against a
  1024 limit) so the guidance is empirical rather than notional.

- [ ] **Step 6: Write `Routine changes` and `Backup and restore` as routers**

Each states only the operational consequence, then links:

- upgrade and rollback both drop every active session; the systemd procedure is
  the current-link swap in `deployment/systemd.md`, the Compose procedure is
  the digest pin in `deployment/images.md`;
- backup-required versus disposable paths are enumerated in
  `deployment/systemd.md`; state which restore steps have been executed against
  a host and which have not.

Do not copy either procedure.

- [ ] **Step 7: Verify no procedure was duplicated**

````bash
bun -e '
const ops = await Bun.file("docs/operations.md").text();
for (const f of ["docs/deployment/systemd.md", "docs/deployment/compose.md", "docs/deployment/images.md"]) {
  const other = await Bun.file(f).text();
  const blocks = [...other.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  for (const b of blocks) {
    if (b.length > 80 && ops.includes(b)) throw new Error(`${f}: command block duplicated into operations.md`);
  }
}
console.log("no duplicated procedure blocks");
'
````

Expected: prints the success line. A duplicated block means Step 6 restated a
procedure instead of linking it.

---

### Task 3: Write the troubleshooting section

**Files:**

- Modify: `docs/operations.md`

- [ ] **Step 1: Write the startup-failure table**

One row per captured error from Task 1, with three columns: the symptom
exactly as printed, the cause in one sentence, and the remedy as a concrete
setting change. Group retired variables separately from validation failures,
because their remedy shape differs — a retired variable is always "use the
named replacement".

- [ ] **Step 2: Write the runtime-failure table**

Beyond startup, cover the failures the deployment actually produces: clients
rejected by target policy; per-IP limits tripping because
`TRUSTED_PROXY_CIDRS` is unset behind a proxy so every client shares one
apparent address; upstream TLS failing under `required` against a MUD without
a runtime-trusted certificate; `prefer` silently downgrading on certificate
validation failure; certificate issuance failing; mass disconnect after a
restart. Each with the observable symptom, not the internal cause.

- [ ] **Step 3: Assert every startup error has an entry**

```bash
bun -e '
const src = await Bun.file("src/runtime-config.ts").text();
const doc = await Bun.file("docs/operations.md").text();
const sites = [...src.matchAll(/errors\.push\(/g)].length;
console.log(`errors.push sites: ${sites}`);
const rows = [...doc.matchAll(/^\| `?[A-Z_]{4,}/gm)].length;
console.log(`troubleshooting rows keyed on a variable: ${rows}`);
'
```

Expected: the row count accounts for every site. Reconcile any shortfall
against the Task 1 capture before proceeding — a site with no entry is the
acceptance criterion failing.

---

### Task 4: Decide and, if approved, add the `check:ops-docs` gate

**Blocked on an explicit decision.** The design recommends this; it is scope
beyond the issue as filed. Do not implement without approval.

- [ ] **Step 1: If approved, add `scripts/check-ops-docs.ts`**

Fail the build when an `errors.push` message in `src/runtime-config.ts` has no
troubleshooting entry keyed to it. Mirror `scripts/check-config-docs.ts` in
shape and failure output. Register it in `package.json` and in
`CI_JOB_COVERAGE` in `scripts/preflight.sh`, which `check:defect-classes`
enforces against the workflow job list.

- [ ] **Step 2: Prove it fails**

Temporarily add an `errors.push` with no documentation entry and confirm the
gate goes red, then remove it. A gate that could not have failed is not a gate.

---

### Task 5: Link, verify, and commit

**Files:**

- Modify: `README.md`, `docs/operations.md`

- [ ] **Step 1: Link from the README**

Add the operations link beside the existing configuration and security links.
Keep it one sentence.

- [ ] **Step 2: Check every local link mechanically**

```bash
bun -e '
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
for (const file of ["README.md", "docs/operations.md"]) {
  const md = await Bun.file(file).text();
  for (const m of md.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = m[1];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const abs = resolve(dirname(file), decodeURIComponent(href.split("#", 1)[0]));
    if (!existsSync(abs)) throw new Error(`${file}: missing local link ${href}`);
  }
}
console.log("all local links resolve");
'
```

- [ ] **Step 3: Run the sole repository gate**

```bash
bun run preflight:full
```

Expected: exit zero. Do not substitute a hand-maintained list of checks.

- [ ] **Step 4: Verify scope and commit**

```bash
git status --short
git diff --name-only origin/main...HEAD
```

Expected: `README.md`, `docs/operations.md`, the design and plan artifacts
under `docs/superpowers/`, and — only if Task 4 was approved —
`scripts/check-ops-docs.ts`, `package.json`, and `scripts/preflight.sh`.
Nothing else.

---

### Task 6: Host acceptance

**Blocked on a disposable host.** Neither existing droplet is eligible:
`589287826` serves production, and `550847252` is the stopped rollback target
retained until 2026-08-09. The procedure is destructive by design.

- [ ] **Step 1: On a disposable host, execute the issue's verification**

Install, upgrade, roll back, restore from backup, and force a certificate
renewal, using only `docs/operations.md` and the documents it links. Then
trigger three misconfigurations and confirm each is diagnosable from the
troubleshooting table alone.

- [ ] **Step 2: Remove the unverified labels for steps that passed**

Every label removed must correspond to a step actually executed. Record what
was run and where.

- [ ] **Step 3: Destroy the host**

Confirm destruction rather than assuming it; a forgotten droplet bills
indefinitely.
