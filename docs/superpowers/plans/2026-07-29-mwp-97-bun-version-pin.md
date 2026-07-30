# MWP-97 Bun Version Pin Implementation Plan

> **Superseded:** The workflow/version-checking design in this plan was
> replaced by
> [`2026-07-30-bun-version-source-redesign.md`](2026-07-30-bun-version-source-redesign.md).
> Keep this file only as the implementation history for the first PR revision.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Bun 1.3.14 the single exact runtime contract for local tools,
CI, package metadata, and operator documentation.

**Architecture:** `.bun-version` is the canonical pin. A dependency-free
TypeScript command compares it with `package.json`, every workflow
`bun-version` input, and the running Bun runtime; CI executes that command
immediately after installing Bun. Integration tests run the command against
temporary repositories so they verify exit status and diagnostics rather than
matching source text.

**Tech Stack:** Bun 1.3.14, TypeScript, `bun:test`, GitHub Actions YAML.

## Global Constraints

- The supported Bun runtime is exactly `1.3.14`, not a semver range.
- No new runtime or development dependency is permitted.
- MWP-98 owns the future Docker base-image digest pin.
- Existing CI action references remain pinned to full commit SHAs.
- Tests must observe the checker fail before implementation makes them pass.

---

### Task 1: Add the executable drift check test-first

**Files:**

- Create: `tests/check-bun-version.test.ts`
- Create: `scripts/check-bun-version.ts`

**Interfaces:**

- Consumes: `.bun-version`, `package.json#engines.bun`,
  `.github/workflows/*.{yml,yaml}`, and `Bun.version`.
- Produces: `bun scripts/check-bun-version.ts`, exiting zero only when all
  version sources agree exactly.

- [ ] **Step 1: Write a failing valid-repository integration test**

Create a temporary repository with all four sources set to `Bun.version`. Run
the not-yet-existing checker with `Bun.spawn`, capture stdout and stderr, and
assert exit code `0` plus a success summary.

```typescript
test('accepts an exact pin shared by metadata, workflows, and runtime', async () => {
  const root = await makeFixture(Bun.version);
  const result = await runCheck(root);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    `check-bun-version: all sources pin Bun ${Bun.version}.`,
  );
  expect(result.stderr).toBe('');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test tests/check-bun-version.test.ts
```

Expected: the assertion receives a non-zero exit because
`scripts/check-bun-version.ts` does not exist.

- [ ] **Step 3: Add the minimum executable that passes the valid fixture**

Create an import-safe command guarded by `import.meta.main`. Read the canonical
version from `.bun-version`, and print:

```text
check-bun-version: all sources pin Bun <version>.
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
bun test tests/check-bun-version.test.ts
```

Expected: one passing test.

- [ ] **Step 5: Add a failing drift integration test**

Build a fixture whose canonical file pins `9.9.9`, package metadata uses
`>=9.9.9`, workflow metadata uses `9.9.8`, and runtime is the actual
`Bun.version`. Assert a non-zero exit and one diagnostic for each disagreement.

```typescript
test('rejects every source that differs from the canonical file', async () => {
  const root = await makeFixture('9.9.9', {
    packageVersion: '>=9.9.9',
    workflowVersion: '9.9.8',
  });
  const result = await runCheck(root);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    'package.json engines.bun must equal 9.9.9; found >=9.9.9',
  );
  expect(result.stderr).toContain(
    '.github/workflows/test.yml BUN_VERSION must equal 9.9.9; found 9.9.8',
  );
  expect(result.stderr).toContain(
    `running Bun must equal 9.9.9; found ${Bun.version}`,
  );
});
```

- [ ] **Step 6: Run the new test and verify RED**

Run:

```bash
bun test tests/check-bun-version.test.ts
```

Expected: the drift fixture incorrectly exits zero.

- [ ] **Step 7: Implement exact validation**

Parse `package.json` as JSON. Inspect every `.yml` and `.yaml` workflow, reject
`latest`, resolve `${{ env.BUN_VERSION }}` from the same workflow, and reject
any literal or environment value that differs from `.bun-version`. Compare
`Bun.version` last. Print all disagreements before exiting `1`.

- [ ] **Step 8: Run the focused tests and verify GREEN**

Run:

```bash
bun test tests/check-bun-version.test.ts
```

Expected: all drift-check integration tests pass with no warnings.

### Task 2: Establish the repository contract and CI gate

**Files:**

- Create: `.bun-version`
- Modify: `package.json`
- Modify: `.github/workflows/test.yml`
- Modify: `README.md`
- Modify: `docs/artifact-policy.md`

**Interfaces:**

- Consumes: `bun run check:bun-version` from Task 1.
- Produces: one exact `1.3.14` pin consumed by developers, CI, and MWP-98.

- [ ] **Step 1: Add the canonical file**

Create `.bun-version` containing one line:

```text
1.3.14
```

- [ ] **Step 2: Make package metadata exact and expose the check**

Change `engines.bun` to `1.3.14` and add:

```json
"check:bun-version": "bun scripts/check-bun-version.ts"
```

- [ ] **Step 3: Run the checker under the existing runtime**

Run:

```bash
bun run check:bun-version
```

Expected: failure identifying the workstation's Bun 1.3.5 runtime. This proves
the runtime comparison is active rather than decorative.

- [ ] **Step 4: Add the CI gate**

Update the workflow comment to name `.bun-version` as canonical and add
`bun run check:bun-version` immediately after `oven-sh/setup-bun` in the
quality job, before dependency installation.

- [ ] **Step 5: Document installation and upgrades**

In `README.md`, state that production and development use exactly Bun 1.3.14,
show `bun --version` and `bun run check:bun-version`, and require a runtime
upgrade to update `.bun-version`, `package.json`, workflow metadata, the future
MWP-98 image base, and `bun.lock` together.

- [ ] **Step 6: Document the quality gate**

Add `bun run check:bun-version` to `docs/artifact-policy.md` before the
typecheck/lint/test/build list.

- [ ] **Step 7: Format the changed files**

Run:

```bash
bun run format:fix -- README.md docs/artifact-policy.md package.json \
  scripts/check-bun-version.ts tests/check-bun-version.test.ts \
  .github/workflows/test.yml
```

- [ ] **Step 8: Run focused validation**

Run:

```bash
bun test tests/check-bun-version.test.ts
bun run typecheck
bun run lint
```

Expected: all commands pass; the repository-level checker still correctly
rejects the host's Bun 1.3.5.

### Task 3: Verify under the supported runtime

**Files:**

- Review only: all files changed by Tasks 1 and 2.

**Interfaces:**

- Consumes: the exact contract and CI gate.
- Produces: verification evidence under Bun 1.3.14.

- [ ] **Step 1: Install Bun 1.3.14 into an isolated temporary directory**

Run:

```bash
mwp97_bun_dir=$(mktemp -d)
curl -fsSL https://bun.com/install |
  BUN_INSTALL="$mwp97_bun_dir" bash -s "bun-v1.3.14"
"$mwp97_bun_dir/bin/bun" --version
```

Expected: `1.3.14`. The host Bun installation is not changed.

- [ ] **Step 2: Run the complete quality gate with the isolated binary first in PATH**

Run:

```bash
PATH="$mwp97_bun_dir/bin:$PATH" bun install --frozen-lockfile
PATH="$mwp97_bun_dir/bin:$PATH" bun run check:bun-version
PATH="$mwp97_bun_dir/bin:$PATH" bun run format
PATH="$mwp97_bun_dir/bin:$PATH" bun run check:config-docs
PATH="$mwp97_bun_dir/bin:$PATH" bun run typecheck
PATH="$mwp97_bun_dir/bin:$PATH" bun run lint
PATH="$mwp97_bun_dir/bin:$PATH" bun run test:unit
PATH="$mwp97_bun_dir/bin:$PATH" bun run test:e2e:mock
PATH="$mwp97_bun_dir/bin:$PATH" bun run build
```

Expected: every command passes.

- [ ] **Step 3: Audit the final diff**

Run:

```bash
git diff --check
git diff --stat
git diff -- .bun-version package.json .github/workflows/test.yml README.md \
  docs/artifact-policy.md scripts/check-bun-version.ts \
  tests/check-bun-version.test.ts
rg -n 'bun-version:\s*latest|engines.*>=1\.3\.14' \
  package.json .github/workflows
```

Expected: no whitespace errors, only MWP-97 files changed, and the final
Ripgrep command returns no matches.

- [ ] **Step 4: Commit the completed slice**

```bash
git add .bun-version package.json .github/workflows/test.yml README.md \
  docs/artifact-policy.md scripts/check-bun-version.ts \
  tests/check-bun-version.test.ts \
  docs/superpowers/plans/2026-07-29-mwp-97-bun-version-pin.md
git commit -m "ci: enforce the exact Bun runtime (MWP-97)"
```
