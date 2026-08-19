# Tracked artifact policy

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

Generated output is also untracked. Recreate build output, coverage reports,
dependency folders, logs, and release bundles from source in CI, or publish
them as external release artifacts.

## Quality gates

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

The audit job runs `bun audit --audit-level=moderate`. Moderate, high, and
critical findings fail CI until you fix them or review them explicitly. The
script carries no advisory ignore list.

Secret scanning runs in CI with Gitleaks. Findings fail the check, so review
them before you merge. If a test or example needs secret-shaped text, use
synthetic placeholders. Don't add real secrets as allowlist fixtures.
