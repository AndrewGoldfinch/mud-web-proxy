# MWP-116 Community Health Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the community health files and enable the two repository
settings they depend on.

**Architecture:** Six root files plus `.github/ISSUE_TEMPLATE/` forms and a PR
template. Each file links the authoritative document rather than restating it.

## Global Constraints

- No runtime, configuration, or deployment change.
- `docs/security.md` is the authoritative technical security model.
  `SECURITY.md` is disclosure policy and links it; it does not restate the
  threat model.
- No migration documentation. v4 is the first public release.
- No Code of Conduct.
- Published response timelines require the maintainer's explicit confirmation
  before merge; they are a commitment to strangers, not a default.
- YAML issue _forms_, not Markdown templates, so required fields are enforced.

---

### Task 1: Write the six root files

**Files:**

- Create: `SECURITY.md`, `SUPPORT.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
  `CODEOWNERS`
- Read: `docs/security.md`, `docs/operations.md`, `docs/configuration.md`,
  `scripts/check-config-docs.ts`, `package.json`, `.bun-version`, `CLAUDE.md`

- [ ] **Step 1: `SECURITY.md`**

Supported versions, private reporting via GitHub's channel, the timelines from
the design note, disclosure scope, and a link to `docs/security.md`. State that
App Attest is experimental and out of scope for severity ratings.

- [ ] **Step 2: `SUPPORT.md`**

Questions to Discussions, bugs to Issues, what a good report contains (version
from `/health`, deployment path, redacted configuration, logs), and the three
explicitly unsupported things from the design note.

- [ ] **Step 3: `CONTRIBUTING.md`**

Setup with the pinned Bun version, the required commands (`bun run preflight`
is the single gate that mirrors CI), conventions from `CLAUDE.md`, the PR
process, and that contributions are GPL-3.0-or-later.

- [ ] **Step 4: `CHANGELOG.md`**

Keep a Changelog format, one `4.0.0` entry. Include every retired variable and
its replacement from the design note's table.

- [ ] **Step 5: `CODEOWNERS`**

Single maintainer. Keep it trivial.

- [ ] **Step 6: Verify links resolve**

```bash
bun -e '
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
for (const f of ["SECURITY.md","SUPPORT.md","CONTRIBUTING.md","CHANGELOG.md"]) {
  const md = await Bun.file(f).text();
  for (const m of md.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const h = m[1];
    if (/^(?:https?:|mailto:|#)/.test(h)) continue;
    if (!existsSync(resolve(dirname(f), decodeURIComponent(h.split("#",1)[0]))))
      throw new Error(`${f}: missing ${h}`);
  }
}
console.log("all local links resolve");'
```

---

### Task 2: Issue forms and PR template

**Files:**

- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`,
  `.github/ISSUE_TEMPLATE/feature_request.yml`,
  `.github/ISSUE_TEMPLATE/config.yml`, `.github/pull_request_template.md`

- [ ] **Step 1: Bug and feature forms**

YAML forms with required fields. Both capture version and deployment path,
because every triage question starts there.

- [ ] **Step 2: `config.yml`**

`blank_issues_enabled: false`, with contact links routing security reports to
private advisories and questions to Discussions — so neither arrives as a
public issue.

- [ ] **Step 3: PR template**

A checklist: tests added, docs updated, configuration reference updated if a
variable changed, changelog entry.

- [ ] **Step 4: Validate the YAML parses**

```bash
bun -e '
for (const f of ["bug_report","feature_request","config"]) {
  const t = await Bun.file(`.github/ISSUE_TEMPLATE/${f}.yml`).text();
  if (!t.trim()) throw new Error(`${f}.yml is empty`);
  console.log(`${f}.yml: ${t.split("\n").length} lines`);
}'
```

GitHub validates forms on push; a malformed form silently stops appearing in
the chooser, so confirm in Step 3 of Task 3 that the files are accepted.

---

### Task 3: Repository settings and verification

- [ ] **Step 1: Enable Discussions and private vulnerability reporting**

```bash
gh api -X PATCH repos/AndrewGoldfinch/mud-web-proxy -f has_discussions=true
gh api -X PUT repos/AndrewGoldfinch/mud-web-proxy/private-vulnerability-reporting
```

Both are reversible. Report them explicitly rather than folding them into the
PR silently.

- [ ] **Step 2: Verify the settings took**

```bash
gh api repos/AndrewGoldfinch/mud-web-proxy --jq '{issues:.has_issues, discussions:.has_discussions}'
gh api repos/AndrewGoldfinch/mud-web-proxy/private-vulnerability-reporting
```

Expected: both true; the reporting endpoint returns enabled rather than 404.

- [ ] **Step 3: Repository gate and scope**

```bash
bun run preflight:full
git diff --name-only origin/main...HEAD
```

Expected: the six files, four `.github/` files, and this issue's design and
plan artifacts. Nothing else.

- [ ] **Step 4: Confirm the timelines before merge**

The `SECURITY.md` acknowledgement and assessment windows are the maintainer's
commitment. Do not merge without their explicit confirmation of those numbers.
