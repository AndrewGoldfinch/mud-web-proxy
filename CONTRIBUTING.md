# Contributing

## Setup

Development and CI use exactly the Bun release pinned in the
[`.bun-version`](.bun-version) file. A different minor version silently
changes test results: unknown flags are ignored rather than rejected, so a
wrong version looks like a real failure.

```bash
git clone https://github.com/AndrewGoldfinch/mud-web-proxy
cd mud-web-proxy
curl -fsSL https://bun.com/install | bash -s "bun-v$(cat .bun-version)"
bun install
bun run check:bun-version
```

## Before you open a pull request

```bash
bun run preflight
```

That is the single command that matters. It mirrors CI's `quality` job step for
step, and unlike CI it runs every gate rather than stopping at the first
failure—so three problems cost one run instead of three.

`bun run preflight:full` additionally runs the mock end-to-end suite, the
dependency scan, and the container test. Neither command covers `secret-scan`, which is
a GitHub Action with no local equivalent.

If preflight and CI ever disagree, the script is wrong. Fix
`scripts/preflight.sh` rather than working around it.

## Conventions

- **Runtime**: Bun, for both development and package management.
- **Naming**: `camelCase` for variables and functions, `PascalCase` for types
  and interfaces, `UPPER_SNAKE_CASE` for constants, `_` prefix for unused
  parameters.
- **Logging**: use `srv.log()`, not `console.log`. Oxlint only warns on
  `no-console`, so this is on you.
- **Errors**: render with `errorText(err)` from `src/error-text.ts`, never a
  cast—a thrown non-Error would otherwise log as `undefined`.
- **Imports**: ES modules, `import type` for type-only imports.

Comments must say _why_, not _what_. This codebase's comments carry the
reasoning behind non-obvious decisions, and that is deliberate.

## Tests

A test that stays green when you delete the protection it covers is not a
test. Where you add a guard, prove the test fails without it.

New configuration variables need a `docs/configuration.md` entry—
`check:config-docs` enforces it. New startup errors need a troubleshooting
entry in `docs/operations.md`—`check:ops-docs` enforces that one.

## Pull requests

Explain what changed and why. If you found a defect while working, say so
rather than folding the fix in silently.

The PR template's checklist is the minimum: tests, docs, configuration
reference, changelog.

## Licensing

This project is [GPL-3.0-or-later](LICENSE). This project accepts
contributions under the same license. The [`NOTICE`](NOTICE) file records
upstream authorship and the attribution that MIT-derived portions require. If
you touch those portions, leave their headers intact.
