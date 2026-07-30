# Tracked Artifact Policy

This repository tracks source code, tests, documentation, package manifests,
`bun.lock`, and non-secret example configuration files.

Tracked environment files must be examples only:

- `.env.example`
- `.env.*.example`

Local runtime configuration and credentials must stay untracked:

- `.env`
- `.env.*`
- `.envrc`
- TLS certificates and private keys used by a deployment
- APNS `.p8` keys
- App Attest key stores
- client CA material
- local E2E JSON configs

Generated output is also untracked. Build output, coverage reports, dependency
folders, logs, and release bundles should be recreated from source in CI or
published as external release artifacts.

## Quality Gates

CI runs the source checks without requiring private MUD credentials:

- `bun run check:bun-version`
- `bun run typecheck`
- `bun run lint`
- `bun run test:unit`
- `bun run test:e2e:mock`
- `bun run build`

Dependency vulnerability checks run with:

```bash
bun run audit
```

The audit job uses `bun audit --audit-level=moderate`; moderate, high, and
critical findings fail CI until they are fixed or explicitly reviewed. The
current script ignores the known ESLint/type-tooling transitive advisories that
remain in the latest compatible toolchain. Remove those ignores as upstream
packages publish patched dependency graphs.

Secret scanning runs in CI with Gitleaks. Findings fail the check and should be
reviewed before merge. Do not add real secrets as allowlist fixtures; use
synthetic placeholders if a test or example needs secret-shaped text.
