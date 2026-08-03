# MWP-108 NOTICE Distribution Design

**Issue:** MWP-108
**Date:** 2026-08-03
**Status:** Approved

## Goal

Make the existing `NOTICE` discoverable from the repository landing page and
ensure that it travels with both supported distribution artifacts. Preserve
the canonical GPLv3 text in `LICENSE` without project-specific additions.

## Current state

The repository-root `NOTICE` already records the verified project lineage,
upstream authorship, upstream URLs, and the full MIT notice. The native release
bundle already includes both `LICENSE` and `NOTICE`, and
`tests/release-bundle.test.ts` enforces their inclusion.

Two gaps remain:

- `README.md` does not point readers to either licensing file.
- The runtime container includes neither licensing file.

MWP-108 also asks for `LICENSE` to reference `NOTICE`. That conflicts with
MWP-107's requirement that `LICENSE` remain the canonical GPLv3 text. The
design resolves the conflict by leaving `LICENSE` unchanged and linking both
files from the README. Every distributed artifact will carry the two files
side by side, so recipients receive the license and attribution together.

## Repository discoverability

Add a concise `License and attribution` section to `README.md`. It will state
that the project is licensed under `GPL-3.0-or-later`, link to `LICENSE`, and
link to `NOTICE` for upstream authorship and MIT-derived attribution.

This section belongs near the end of the README as repository-level legal
information. It will not duplicate the license or NOTICE text and will not
rewrite the broader self-hosting documentation assigned to MWP-110.

## Container artifact

Extend the Docker build context allowlist with `LICENSE` and `NOTICE`. In the
runtime stage, copy both files to:

```text
/opt/mud-web-proxy/LICENSE
/opt/mud-web-proxy/NOTICE
```

Both files will be owned by root and mode `0444`, matching the image's other
immutable runtime files. No new directory, environment variable, or runtime
behavior is required.

## Native release bundle

No production change is needed. `scripts/build-release-bundle.ts` already
includes `LICENSE` and `NOTICE` in its explicit file allowlist.

The existing parameterized test in `tests/release-bundle.test.ts` already
asserts that both files are present in the generated archive. It remains the
contract for the native artifact.

## Verification

Extend `tests/docker-image-contract.test.ts` before changing the Dockerfile:

- Assert that `.dockerignore` admits `LICENSE` and `NOTICE` into the build
  context.
- Assert that the runtime stage copies both files with root ownership and mode
  `0444`.

Then verify the focused contracts and repository links:

```bash
bun test tests/docker-image-contract.test.ts tests/release-bundle.test.ts
rg -n 'LICENSE|NOTICE' README.md Dockerfile .dockerignore
git diff --check
```

The focused Docker contract test must fail before the production change and
pass afterward. The release-bundle test proves the existing native artifact
behavior has not regressed.

## Linear closeout

Update MWP-108's completion record to state explicitly that the canonical
`LICENSE` file was intentionally left untouched. Record the replacement
criterion: `NOTICE` is linked beside `LICENSE` from the README and both files
ship together in every supported artifact.

MWP-108 is complete when the README links are present, both distribution
contracts pass, and the runtime image contains the two files. Building or
publishing a new image is outside this issue; the existing release workflow
will carry the Dockerfile change into the next image build.
