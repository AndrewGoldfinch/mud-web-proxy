# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mud-web-proxy is a WebSocket-to-Telnet proxy for MUD/MUSH/MOO game servers. It lets web browsers connect to legacy telnet MUD servers over secure WSS/HTTPS connections. Single-file TypeScript application (`wsproxy.ts`).

## Before pushing

```bash
bun run preflight        # every gate CI's `quality` job runs, in CI's order
bun run preflight:full   # + mock-e2e and audit (the other two CI jobs)
bun run ci:status        # poll the PR's checks, then dump failing job logs
```

`preflight` mirrors `.github/workflows/test.yml` step for step, so a green
preflight means a green `quality` job. **If the two ever disagree, the script
is wrong — fix `scripts/preflight.sh`, don't work around it.** Unlike CI it
does not stop at the first failure: it runs every gate and reports all of
them, so a push blocked by three problems costs one run instead of three.

`format` (`prettier --check .`) is the gate most often skipped and it fails
the build; `check:bun-version` and `check:config-docs` are easy to forget
because nothing else surfaces them locally. That is exactly why preflight runs
the whole set rather than the obvious three.

`ci:status` takes a PR number or infers it from the branch. Exit codes:
`0` green, `1` something failed (logs printed), `2` setup problem, `3` timed
out with checks still running.

## Code Conventions

Run `bun run` to list the scripts; the manifest is authoritative.

- **Runtime**: Bun (for dev and package management)
- **Naming**: camelCase (vars/functions), PascalCase (types/interfaces), UPPER_SNAKE_CASE (constants), `_` prefix for unused params
- **Logging**: Use `srv.log()` instead of `console.log`. ESLint only _warns_ on
  `no-console`, so this is not mechanically enforced — it is on you.
- **Error typing**: Cast errors as `(err as Error)` in catch blocks
- **Imports**: ES module style, use `import type` for type-only imports
- **`__dirname` emulation**: `fileURLToPath(import.meta.url)` (required for ES modules)

## Security Notes

- **Target policy is `TARGET_MODE`**, not a boolean. `fixed` (the default)
  restricts to one target; `allowlist` and `arbitrary` widen it, and
  `arbitrary` refuses to start without `ARBITRARY_ALLOWED_PORTS` plus enforced
  authentication. `ONLY_ALLOW_DEFAULT_SERVER` was **removed** — setting it now
  fails startup (`src/runtime-config.ts`). Do not assume connections are
  restricted to one server; production runs `arbitrary`.
- Inbound TLS is owned by the edge proxy (Caddy) in the native deployment; the
  app listens plaintext on loopback. See `docs/deployment/systemd.md`.
- Password mode detection (ECHO negotiation) omits passwords from logs
