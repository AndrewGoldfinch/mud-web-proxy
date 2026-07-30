# Bun Version Source Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.bun-version` the sole canonical Bun runtime source while
retaining small literal workflow guards against explicit or omitted CI
overrides.

**Architecture:** The checker resolves the canonical file and package metadata
in a fail-fast first phase, then collects independent metadata, workflow, and
runtime comparison failures. GitHub Actions reads `.bun-version` directly;
workflow validation uses two literal counts over concatenated workflow text
and performs no YAML or expression parsing.

**Tech Stack:** Bun 1.3.14, TypeScript, `bun:test`, GitHub Actions YAML.

## Global Constraints

- `.bun-version` is the only canonical Bun version source.
- The canonical value must be one exact `x.y.z` version.
- Keep
  `collectBunVersionErrors(repoRoot: string, runtimeVersion: string)` as the
  testable public signature.
- `package.json#engines.bun` remains an exact mirror checked against the
  canonical file.
- Every current setup action must use
  `bun-version-file: .bun-version`.
- Explicit `bun-version:` inputs are forbidden in repository workflows.
- `actions/checkout` must precede the setup action because version files
  resolve relative to `GITHUB_WORKSPACE`.
- Do not add a YAML parser or any other dependency.
- Keep the version gate before dependency installation in the quality job.
- MWP-98 owns the future Docker image version consumer.

---

## File Map

- `scripts/check-bun-version.ts`: canonical resolution, comparison collection,
  workflow corpus loading, literal workflow invariants, and CLI behavior.
- `tests/check-bun-version.test.ts`: direct source/comparison tests, pure
  workflow guard tests, and two spawned CLI exit tests.
- `.github/workflows/test.yml`: direct `.bun-version` consumption and
  checkout-order explanation.
- `README.md`: clone-first installation and source-of-truth upgrade guidance.
- `docs/open-source-plan.md`: semantic Phase 2 description of the canonical
  pin.
- `docs/superpowers/plans/2026-07-29-mwp-97-bun-version-pin.md`: supersession
  notice pointing at the approved redesign.

---

### Task 1: Make required-source resolution fail fast

**Files:**

- Modify: `tests/check-bun-version.test.ts`
- Modify: `scripts/check-bun-version.ts`

**Interfaces:**

- Consumes:
  `collectBunVersionErrors(repoRoot: string, runtimeVersion: string)`.
- Produces:
  `Promise<{ version: string; errors: string[] }>` without uncaught
  file/JSON errors for required sources.

- [ ] **Step 1: Replace the fixture with the two required files**

Import the checker in-process and remove workflow fields from
`FixtureOptions`:

```typescript
import { collectBunVersionErrors } from '../scripts/check-bun-version';

interface FixtureOptions {
  canonicalContent?: string;
  packageContent?: string;
  packageVersion?: string;
}

const makeFixture = async (
  version: string,
  options: FixtureOptions = {},
): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'mwp-bun-version-'));
  fixtures.push(root);

  await writeFile(
    path.join(root, '.bun-version'),
    options.canonicalContent ?? `${version}\n`,
  );
  await writeFile(
    path.join(root, 'package.json'),
    options.packageContent ??
      JSON.stringify({
        engines: { bun: options.packageVersion ?? version },
      }),
  );

  return root;
};
```

Keep `runCheck(root)` for the two CLI tests, but remove workflow creation from
the shared fixture.

- [ ] **Step 2: Write direct tests for valid and mismatched comparisons**

Add literal expectations that independently specify the contract:

```typescript
test('accepts exact package and runtime mirrors', async () => {
  const root = await makeFixture('1.2.3');

  expect(await collectBunVersionErrors(root, '1.2.3')).toEqual({
    version: '1.2.3',
    errors: [],
  });
});

test('collects independent package and runtime mismatches', async () => {
  const root = await makeFixture('1.2.3', {
    packageVersion: '1.2.2',
  });

  expect(await collectBunVersionErrors(root, '1.2.1')).toEqual({
    version: '1.2.3',
    errors: [
      'package.json engines.bun must equal 1.2.3; found 1.2.2',
      'running Bun must equal 1.2.3; found 1.2.1',
    ],
  });
});
```

The mutation caught by the first test is an implementation that still
requires workflow scaffolding. The second catches early-return comparison
logic that reports only one independent mismatch.

- [ ] **Step 3: Write fail-fast canonical-source tests**

Test missing, unreadable, empty, and non-exact canonical sources. For missing
and unreadable cases, assert one error plus a stable source prefix rather than
the platform-specific low-level message:

```typescript
test('a missing canonical file returns one source error', async () => {
  const root = await makeFixture('1.2.3');
  await rm(path.join(root, '.bun-version'));

  const result = await collectBunVersionErrors(root, '9.9.9');

  expect(result.version).toBe('');
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('.bun-version could not be read');
});

test('an unreadable canonical path returns one source error', async () => {
  const root = await makeFixture('1.2.3');
  await rm(path.join(root, '.bun-version'));
  await mkdir(path.join(root, '.bun-version'));

  const result = await collectBunVersionErrors(root, '9.9.9');

  expect(result.version).toBe('');
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('.bun-version could not be read');
});

test.each([
  ['', '(empty)'],
  ['1.2', '1.2'],
])(
  'invalid canonical content %p returns one error',
  async (canonicalContent, displayed) => {
    const root = await makeFixture('ignored', { canonicalContent });

    const result = await collectBunVersionErrors(root, '9.9.9');

    expect(result.errors).toEqual([
      `.bun-version must contain an exact x.y.z version; found ${displayed}`,
    ]);
  },
);
```

These tests fail if package/runtime comparisons cascade after canonical
resolution has already failed.

- [ ] **Step 4: Write fail-fast package-source tests**

```typescript
test('a missing package manifest returns one source error', async () => {
  const root = await makeFixture('1.2.3');
  await rm(path.join(root, 'package.json'));

  const result = await collectBunVersionErrors(root, '9.9.9');

  expect(result.version).toBe('1.2.3');
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('package.json could not be read');
});

test('invalid package JSON returns one source error', async () => {
  const root = await makeFixture('1.2.3', {
    packageContent: '{not-json',
  });

  const result = await collectBunVersionErrors(root, '9.9.9');

  expect(result.version).toBe('1.2.3');
  expect(result.errors).toEqual(['package.json must contain valid JSON']);
});
```

The runtime is deliberately wrong in both tests. Receiving a runtime error
would prove the required-source phase did not fail fast.

- [ ] **Step 5: Replace the CLI coverage with one success and one failure**

Use metadata-only fixtures:

```typescript
test('CLI exits zero when every resolved source agrees', async () => {
  const root = await makeFixture(Bun.version);
  const result = await runCheck(root);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    `check-bun-version: all sources pin Bun ${Bun.version}.`,
  );
  expect(result.stderr).toBe('');
});

test('CLI exits one when a resolved source disagrees', async () => {
  const root = await makeFixture(Bun.version, {
    packageVersion: '9.9.9',
  });
  const result = await runCheck(root);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(
    `package.json engines.bun must equal ${Bun.version}; found 9.9.9`,
  );
});
```

- [ ] **Step 6: Run the focused tests and verify RED**

Run:

```bash
bun test tests/check-bun-version.test.ts
```

Expected: failures show the current checker still reads
`.github/workflows`, throws raw source errors, and cascades comparisons after
invalid canonical content.

- [ ] **Step 7: Implement two-phase required-source handling**

Remove `SetupBunStep`, `ENV_REFERENCE`, `yamlScalar`, and
`collectSetupBunSteps`. Retain `EXACT_VERSION`. Start
`collectBunVersionErrors` with explicit source resolution:

```typescript
export const collectBunVersionErrors = async (
  repoRoot: string,
  runtimeVersion: string,
): Promise<{ version: string; errors: string[] }> => {
  let version: string;
  try {
    version = (
      await readFile(path.join(repoRoot, '.bun-version'), 'utf8')
    ).trim();
  } catch (err: unknown) {
    return {
      version: '',
      errors: [`.bun-version could not be read: ${(err as Error).message}`],
    };
  }

  if (!EXACT_VERSION.test(version)) {
    return {
      version,
      errors: [
        `.bun-version must contain an exact x.y.z version; found ${
          version || '(empty)'
        }`,
      ],
    };
  }

  let packageSource: string;
  try {
    packageSource = await readFile(
      path.join(repoRoot, 'package.json'),
      'utf8',
    );
  } catch (err: unknown) {
    return {
      version,
      errors: [`package.json could not be read: ${(err as Error).message}`],
    };
  }

  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(packageSource) as PackageManifest;
  } catch {
    return {
      version,
      errors: ['package.json must contain valid JSON'],
    };
  }

  const errors: string[] = [];
  const packageVersion = manifest.engines?.bun;
  if (packageVersion !== version) {
    errors.push(
      `package.json engines.bun must equal ${version}; found ${String(
        packageVersion,
      )}`,
    );
  }

  if (runtimeVersion !== version) {
    errors.push(`running Bun must equal ${version}; found ${runtimeVersion}`);
  }

  return { version, errors };
};
```

Keep the existing `import.meta.main` CLI block unchanged.

- [ ] **Step 8: Run focused tests, types, and lint and verify GREEN**

Run:

```bash
bun test tests/check-bun-version.test.ts
bun run typecheck
bun run lint
```

Expected: every command exits `0`; the focused test output reports zero
failures.

- [ ] **Step 9: Commit the fail-fast checker**

```bash
git add scripts/check-bun-version.ts tests/check-bun-version.test.ts
git commit -m "refactor(ci): fail fast on Bun version sources (MWP-97)"
```

---

### Task 2: Add literal workflow invariants and migrate CI

**Files:**

- Modify: `tests/check-bun-version.test.ts`
- Modify: `scripts/check-bun-version.ts`
- Modify: `.github/workflows/test.yml`

**Interfaces:**

- Consumes: the Task 1 two-phase checker.
- Produces:
  `collectWorkflowVersionErrors(workflowText: string): string[]`, composed
  into `collectBunVersionErrors`.

- [ ] **Step 1: Write pure workflow invariant tests**

Import `collectWorkflowVersionErrors` and add:

```typescript
test('workflow actions all read the canonical file', () => {
  const workflow = [
    '- uses: oven-sh/setup-bun@sha-one',
    '  with:',
    '    bun-version-file: .bun-version',
    '- uses: oven-sh/setup-bun@sha-two',
    '  with:',
    '    bun-version-file: .bun-version',
  ].join('\n');

  expect(collectWorkflowVersionErrors(workflow)).toEqual([]);
});

test('workflow rejects an explicit version override', () => {
  const workflow = [
    '- uses: oven-sh/setup-bun@sha',
    '  with:',
    '    bun-version: latest',
  ].join('\n');

  expect(collectWorkflowVersionErrors(workflow)).toEqual([
    'workflow files must not declare bun-version; use bun-version-file: .bun-version',
    'every setup-bun action must declare bun-version-file: .bun-version; found 1 action and 0 canonical inputs',
  ]);
});

test.each([
  [
    '- uses: oven-sh/setup-bun@sha',
    'every setup-bun action must declare bun-version-file: .bun-version; found 1 action and 0 canonical inputs',
  ],
  [
    [
      '- uses: oven-sh/setup-bun@sha',
      '  with:',
      '    bun-version-file: .bunversion',
    ].join('\n'),
    'every setup-bun action must declare bun-version-file: .bun-version; found 1 action and 0 canonical inputs',
  ],
])('%s violates the canonical workflow input count', (workflow, error) => {
  expect(collectWorkflowVersionErrors(workflow)).toEqual([error]);
});
```

Each expectation is hand-derived. Removing either literal count from
production makes at least one test fail.

- [ ] **Step 2: Write a source-specific workflow read failure test**

Use a regular file where the workflows directory would be, forcing `readdir`
to fail with `ENOTDIR` without relying on filesystem permissions:

```typescript
test('workflow read failures become source-specific errors', async () => {
  const root = await makeFixture('1.2.3');
  await mkdir(path.join(root, '.github'));
  await writeFile(path.join(root, '.github', 'workflows'), 'not-a-directory');

  const result = await collectBunVersionErrors(root, '1.2.3');

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('.github/workflows could not be read');
});
```

The shared fixture remains metadata-only; this test creates only the malformed
source needed to exercise the error boundary.

- [ ] **Step 3: Make the failing CLI test exercise workflow composition**

Change the exit-`1` CLI test so package metadata and runtime agree, then create
one invalid workflow only in that test:

```typescript
test('CLI exits one when a workflow overrides the canonical file', async () => {
  const root = await makeFixture(Bun.version);
  const workflowsDir = path.join(root, '.github', 'workflows');
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(
    path.join(workflowsDir, 'test.yml'),
    [
      '- uses: oven-sh/setup-bun@sha',
      '  with:',
      '    bun-version: latest',
      '',
    ].join('\n'),
  );

  const result = await runCheck(root);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    'workflow files must not declare bun-version',
  );
});
```

This is the sole fixture that needs workflow directories. It proves the CLI
gate invokes the pure workflow validator rather than merely testing an
uncomposed helper.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
bun test tests/check-bun-version.test.ts
```

Expected: the pure helper import is missing, the workflow read error is not
reported, and the invalid workflow CLI fixture exits `0`.

- [ ] **Step 5: Implement the literal workflow helper**

Add:

```typescript
const countOccurrences = (source: string, needle: string): number =>
  source.split(needle).length - 1;

export const collectWorkflowVersionErrors = (
  workflowText: string,
): string[] => {
  const errors: string[] = [];
  const explicitInputs = countOccurrences(workflowText, 'bun-version:');
  const setupActions = countOccurrences(workflowText, 'oven-sh/setup-bun');
  const canonicalInputs = countOccurrences(
    workflowText,
    'bun-version-file: .bun-version',
  );

  if (explicitInputs > 0) {
    errors.push(
      'workflow files must not declare bun-version; use bun-version-file: .bun-version',
    );
  }
  if (setupActions !== canonicalInputs) {
    errors.push(
      `every setup-bun action must declare bun-version-file: .bun-version; found ${setupActions} action${setupActions === 1 ? '' : 's'} and ${canonicalInputs} canonical input${canonicalInputs === 1 ? '' : 's'}`,
    );
  }

  return errors;
};
```

This intentionally counts literal repository conventions. Do not add YAML
scalar handling, expression matching, quote handling, or job-level scope
logic.

- [ ] **Step 6: Compose workflow loading into the checker**

Import `readdir` alongside `readFile`. Add a private loader:

```typescript
const readWorkflowText = async (repoRoot: string): Promise<string> => {
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  let files: string[];
  try {
    files = (await readdir(workflowsDir))
      .filter((file) => /\.ya?ml$/.test(file))
      .sort();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw err;
  }

  return (
    await Promise.all(
      files.map((file) => readFile(path.join(workflowsDir, file), 'utf8')),
    )
  ).join('\n');
};
```

After the package comparison and before the runtime comparison:

```typescript
try {
  errors.push(
    ...collectWorkflowVersionErrors(await readWorkflowText(repoRoot)),
  );
} catch (err: unknown) {
  errors.push(
    `.github/workflows could not be read: ${(err as Error).message}`,
  );
}
```

Missing workflow directories represent an empty corpus. Any other directory
or file read error is returned as a source-specific comparison error.

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run:

```bash
bun test tests/check-bun-version.test.ts
```

Expected: all direct and CLI tests pass with zero failures.

- [ ] **Step 8: Run the repository checker and verify the old CI shape fails**

Run with Bun 1.3.14:

```bash
bun run check:bun-version
```

Expected: exit `1`, reporting the three forbidden `bun-version:` inputs and
the mismatch between three setup actions and zero canonical file inputs.

- [ ] **Step 9: Point all setup actions at `.bun-version`**

Delete the workflow `env.BUN_VERSION` block. Replace each setup input with:

```yaml
with:
  bun-version-file: .bun-version
```

Use this top-level comment without adding counted action/input literals:

```yaml
# .bun-version is the canonical runtime pin. Keep checkout before the setup
# action because version files resolve relative to GITHUB_WORKSPACE.
```

Keep checkout first in `quality`, `mock-e2e`, and `dependency-scan`. Keep
`bun run check:bun-version` immediately after setup in `quality`.

- [ ] **Step 10: Run the checker and focused quality gates**

Run with Bun 1.3.14:

```bash
bun run check:bun-version
bun test tests/check-bun-version.test.ts
bun run typecheck
bun run lint
```

Expected: all four commands exit `0`. The checker prints one success summary
for the exact canonical version.

- [ ] **Step 11: Commit the workflow redesign**

```bash
git add .github/workflows/test.yml scripts/check-bun-version.ts \
  tests/check-bun-version.test.ts
git commit -m "ci: read the Bun runtime from the canonical file (MWP-97)"
```

---

### Task 3: Remove operational version duplication from documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/open-source-plan.md`
- Modify: `docs/superpowers/plans/2026-07-29-mwp-97-bun-version-pin.md`

**Interfaces:**

- Consumes: `.bun-version` and `bun run check:bun-version`.
- Produces: clone-first installation instructions and accurate Phase 2
  source-of-truth language.

- [ ] **Step 1: Rewrite README installation order**

Replace the pre-clone literal installation block with:

````markdown
Development and production use exactly the Bun release recorded in
`.bun-version`. Clone the repository first, then install that release:

```bash
git clone https://github.com/maldorne/mud-web-proxy
cd mud-web-proxy
curl -fsSL https://bun.com/install |
  bash -s "bun-v$(cat .bun-version)"
bun install
bun run check:bun-version
```
````

Keep the existing development and production commands after this block. Do
not retain a literal version or expected `bun --version` comment.

- [ ] **Step 2: Rewrite the README upgrade checklist**

State:

```markdown
To upgrade Bun, change `.bun-version`, mirror that exact value in
`package.json#engines.bun`, and regenerate `bun.lock` with the new runtime.
CI reads `.bun-version` directly, and `bun run check:bun-version` enforces the
metadata mirror. Once MWP-98 lands, update its Docker base-image version in
the same change.
```

This makes `.bun-version` and `bun.lock` the hand-updated artifacts, while the
package value is a mechanically checked mirror and Docker remains future
scope.

- [ ] **Step 3: Rewrite the Phase 2 plan semantically**

Replace the Docker Compose Bun bullet with:

```markdown
- Keep the canonical Bun pin in `.bun-version`; CI reads it directly, and
  package metadata and the image build derive from or are checked against it.
```

Do not replace the old number with a different literal.

- [ ] **Step 4: Mark the original implementation plan as superseded**

Immediately after its title, add:

```markdown
> **Superseded:** The workflow/version-checking design in this plan was
> replaced by
> [`2026-07-30-bun-version-source-redesign.md`](2026-07-30-bun-version-source-redesign.md).
> Keep this file only as the implementation history for the first PR revision.
```

- [ ] **Step 5: Verify operational prose no longer duplicates the pin**

Run:

```bash
rg -n '1\\.3\\.14|CI `BUN_VERSION`|the CI `BUN_VERSION`' \
  README.md docs/open-source-plan.md
```

Expected: no matches.

Then verify the future Docker qualifier:

```bash
rg -n 'Once MWP-98 lands' README.md
```

Expected: exactly one match.

- [ ] **Step 6: Format and validate documentation**

Run:

```bash
bunx prettier --write README.md docs/open-source-plan.md \
  docs/superpowers/plans/2026-07-29-mwp-97-bun-version-pin.md
bun run format
bun run check:config-docs
```

Expected: formatting and the 58-variable configuration documentation check
both pass.

- [ ] **Step 7: Commit the documentation correction**

```bash
git add README.md docs/open-source-plan.md \
  docs/superpowers/plans/2026-07-29-mwp-97-bun-version-pin.md
git commit -m "docs: make the Bun pin canonical (MWP-97)"
```

---

### Task 4: Verify and publish the amended PR

**Files:**

- Review only: every file changed since `3cf9039`.

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces: complete local and GitHub verification evidence for PR #85.

- [ ] **Step 1: Confirm the exact verification runtime**

Use the locally cached exact executable:

```bash
canonical_bun_dir=/home/andy/.bun/install/cache/@oven/bun-linux-x64@1.3.14@@@1/bin
PATH="$canonical_bun_dir:$PATH"
bun --version
```

Expected: `1.3.14`.

- [ ] **Step 2: Run the complete local quality gate**

With the exact binary first in `PATH`, run:

```bash
bun install --frozen-lockfile
bun run check:bun-version
bun run format
bun run check:config-docs
bun run typecheck
bun run lint
bun run test:unit
bun run test:e2e:mock
bun run build
bun run audit
```

Expected:

- version checker reports agreement;
- formatter, configuration docs, types, lint, build, and audit exit `0`;
- all unit tests pass;
- all four mock E2E tests pass.

- [ ] **Step 3: Audit the final source contract**

Run:

```bash
git diff --check 3cf9039...HEAD
rg -n 'BUN_VERSION|bun-version:' .github/workflows
rg -n 'oven-sh/setup-bun|bun-version-file: .bun-version' \
  .github/workflows
rg -n '1\\.3\\.14' README.md docs/open-source-plan.md
git status --short
git log --oneline 3cf9039..HEAD
```

Expected:

- no whitespace errors;
- no `BUN_VERSION` or explicit `bun-version:` workflow input;
- three setup action occurrences and three canonical file inputs;
- no operational-doc version literal;
- the worktree is clean;
- the redesign commits are present after the original PR commits.

- [ ] **Step 4: Push the branch**

```bash
git push origin feat/mwp-97-bun-pin
```

Expected: origin advances to the local `HEAD`.

- [ ] **Step 5: Wait for all PR checks**

Run:

```bash
gh pr checks 85 --watch --interval 10
```

Expected: quality, mock E2E, dependency scan, secret scan, Analyze, and
CodeQL all reach `pass`.

- [ ] **Step 6: Re-read review state**

Run:

```bash
python3 \
  /home/andy/.codex/plugins/cache/openai-curated-remote/github/0.1.8-2841cf9749ae/skills/gh-address-comments/scripts/fetch_comments.py
```

Expected: the original global-counter thread is outdated. Do not reply to or
resolve it unless the user explicitly requests that GitHub write.
