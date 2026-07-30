# Bun Version Source Redesign

**Date:** 2026-07-30

**Status:** Approved

## Goal

Make `.bun-version` the sole canonical Bun runtime pin while retaining a
small, explicit guard against GitHub Actions steps bypassing that file.

## Source Contract

The repository has one authoritative runtime value:

- `.bun-version` contains one exact `x.y.z` version.

The other consumers do not repeat that value:

- `oven-sh/setup-bun` receives `bun-version-file: .bun-version`.
- `package.json#engines.bun` remains an exact metadata declaration checked
  against `.bun-version`.
- The running Bun version is checked against `.bun-version`.

At the pinned `oven-sh/setup-bun` commit, version resolution checks
`bun-version`, then `bun-version-file`, then `package.json`. Explicitly naming
`.bun-version` therefore makes the canonical file authoritative and prevents
`package.json` from selecting the CI runtime.

## Workflow Guard

The checker will not parse YAML or resolve GitHub Actions expressions. It will
concatenate the `.yml` and `.yaml` files in `.github/workflows` and enforce two
literal invariants:

1. `bun-version:` occurs zero times. An explicit input would override
   `bun-version-file`.
2. The number of `oven-sh/setup-bun` occurrences equals the number of
   `bun-version-file: .bun-version` occurrences.

The second invariant catches new setup steps without the canonical input and
misspelled or alternate version-file paths. A repository with no workflows has
zero occurrences of both strings and satisfies the invariant; this also keeps
metadata/runtime test fixtures independent of workflow scaffolding.

Every setup step must remain after `actions/checkout`. The action resolves
version files relative to `GITHUB_WORKSPACE` and returns early when that
workspace is unavailable. The workflow comment will record this ordering
requirement. The checker deliberately does not attempt to infer YAML step
ordering.

## Checker Phases

`collectBunVersionErrors(repoRoot, runtimeVersion)` retains its current
signature so tests can inject the runtime.

### Phase 1: Resolve Required Sources

Resolution fails fast:

1. Read `.bun-version`.
2. If it is missing, unreadable, empty, or not exact `x.y.z`, return exactly
   one source-specific error. Do not read or compare any other source.
3. Read and parse `package.json`.
4. If it is missing, unreadable, or invalid JSON, return exactly one
   source-specific error rather than allowing `ENOENT` or a parse exception to
   escape.

### Phase 2: Collect Comparison Errors

After both required sources resolve:

- Compare `package.json#engines.bun` with the canonical version.
- Apply the two workflow literal-count invariants.
- Compare `runtimeVersion` with the canonical version.

These independent comparison failures are collected and reported together.
Workflow directory absence means an empty workflow corpus; other workflow
read failures receive a source-specific diagnostic.

The CLI keeps the `import.meta.main` guard. It prints every returned error with
the existing `check-bun-version:` prefix and exits `1`, or prints the success
summary and exits `0`.

## Tests

Most tests call the checker functions in-process.

The metadata/runtime fixture creates only:

- `.bun-version`
- `package.json`

Direct tests cover:

- exact agreement;
- package version mismatch;
- runtime mismatch;
- missing, empty, and non-exact `.bun-version`, each producing one error;
- missing and invalid `package.json`, each producing one error;
- a valid workflow corpus using `bun-version-file: .bun-version`;
- `bun-version: latest`;
- a setup action without a matching canonical version-file input;
- a misspelled version-file path;
- multiple setup actions in one concatenated workflow corpus.

Workflow invariant tests call a pure text-validation helper directly and do
not build fake workflow directory trees.

Two spawned-process tests protect the executable gate:

- valid inputs exit `0`;
- invalid inputs exit `1`.

## Workflow Changes

Delete the workflow-level `BUN_VERSION` variable. Each of the three
`oven-sh/setup-bun` steps will use:

```yaml
with:
  bun-version-file: .bun-version
```

The version check remains immediately after setup and before dependency
installation in the quality job.

## Documentation Changes

README installation becomes:

1. clone the repository;
2. enter the repository;
3. install `bun-v$(cat .bun-version)`;
4. install dependencies;
5. run `bun run check:bun-version`.

The README will not repeat the pinned version or show a literal expected
`bun --version` result. The upgrade checklist treats `.bun-version` and
`bun.lock` as the hand-updated artifacts; `package.json#engines.bun` is a
mechanically matching mirror enforced by the checker. CI reads the canonical
file rather than carrying another declaration. Docker is mentioned only as an
additional consumer once MWP-98 lands.

`docs/open-source-plan.md` will state semantically that the pin lives in
`.bun-version` and CI and package metadata derive from or are checked against
it. It will not claim that CI contains a duplicated literal.

## Rejected Alternatives

- **Full workflow parsing:** unnecessary for two literal repository
  invariants and reintroduces quoting, expression, and environment-scope edge
  cases.
- **No workflow inspection:** permits an explicit `bun-version: latest` to
  override the canonical file and permits new steps to omit or misspell the
  canonical input without a repository-level diagnostic.
- **Package fallback only:** makes `.bun-version` nominal because
  `setup-bun` would select `package.json` rather than the declared canonical
  source.
