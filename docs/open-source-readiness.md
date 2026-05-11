# Open Source Readiness Plan

Audit date: 2026-05-11

This document captures the work needed before making this repository public and
inviting other operators to run private MUD WebSocket-to-Telnet proxies.

## Executive Summary

Do not publish the repository as-is. The code builds and the default unit test
suite passes, but there are security, licensing, documentation, deployment, and
repository hygiene issues that should be resolved first.

The most important risk is open-relay behavior: the legacy connection path
restricts clients to the configured default MUD, but the newer session protocol
can create sessions to arbitrary `host` and `port` values. That makes a public
deployment usable as a generic TCP proxy unless fixed.

## Must Fix Before Public Release

- Fix the open-relay risk in `src/session-integration.ts`. New session
  `connect` messages must enforce the same target restriction or allowlist as
  the legacy connect path.

- Make target restriction configuration explicit and environment-driven.
  `ONLY_ALLOW_DEFAULT_SERVER` is currently hardcoded in `wsproxy.ts`, while
  `.env.example` presents it as configurable.

- Decide the default app-auth behavior and document it clearly.
  `REQUIRE_APP_AUTH` currently defaults to enabled unless explicitly set to
  `false`, but the README quickstart does not explain the required App Attest
  configuration.

- Lock down or disable diagnostics by default. `/diagnostic` and
  `/diagnostic/api` expose operational data, including full session IDs, and
  should require an admin token or be disabled in production.

- Fix known telnet protocol bugs before inviting external operators:
  `ESC` should be ASCII 27, and `ACCEPT_UTF8` should use a valid CHARSET
  subnegotiation response.

- Tighten `.gitignore`. It currently ignores local env files and then
  re-includes all `.env.*` files. Real local secrets should stay ignored, and
  only explicit example files should be tracked.

- Fix CI command drift. `.github/workflows/test.yml` runs
  `bun run test:unit`, but `package.json` does not define that script.

- Remove or template the private deployment workflow. The current deploy
  workflow points at a specific host and path and should not be part of the
  default public project.

- Resolve licensing inconsistencies. `wsproxy.ts` says MIT, `LICENSE.md` says
  GPL text for `mud-web-client`, and `package.json` says `gpl-3.0`.
  Choose the intended license, update all references, and use a valid SPDX
  identifier such as `GPL-3.0-or-later` if GPLv3-or-later is intended.

## Security Hardening

### Target Restrictions

Recommended safe default:

- `ONLY_ALLOW_DEFAULT_SERVER=true`
- `TN_HOST` and `TN_PORT` are the only permitted upstream target
- Any client-provided `host` or `port` is rejected unless it exactly matches the
  configured target

Recommended advanced mode:

- Add `ALLOWED_TARGETS` as a comma-separated list like
  `aardmud.org:4000,achaea.com:23`
- Reject all non-allowlisted targets
- Reject private, loopback, link-local, multicast, and metadata-service
  addresses unless explicitly enabled for local development
- Resolve DNS and validate resolved IPs before connecting
- Rate-limit failed connection attempts

### Diagnostics

Recommended defaults:

- `/health` stays public and minimal
- `/diagnostic` disabled unless `ENABLE_DIAGNOSTICS=true`
- `/diagnostic/api` requires `ADMIN_TOKEN`
- Diagnostic responses should avoid full session IDs, full IP addresses, device
  tokens, activity tokens, auth tokens, and raw MUD output
- The APNS debug controls should stay disabled unless `APNS_TEST_SECRET` is set
  and the diagnostics endpoint is authenticated

### Authentication

Define and document supported modes:

- Private browser/client mode: `REQUIRE_APP_AUTH=false`, restricted target,
  restricted origins
- Official iOS app mode: `REQUIRE_APP_AUTH=true`, App Attest configured
- Development mode: App Attest disabled, TLS optional, diagnostics allowed only
  on localhost or behind an admin token

### TLS

Recommended changes:

- Add `TLS_CERT_PATH` and `TLS_KEY_PATH`
- Keep `cert.pem` and `privkey.pem` as compatibility fallbacks
- In production, fail closed if TLS is expected but certs are missing
- Document reverse-proxy TLS termination as the preferred deployment path for
  most users
- Avoid logging certificate or environment details beyond what operators need

### Logging And Privacy

Document this explicitly:

- The proxy operator can observe MUD traffic passing through the proxy
- Telnet credentials pass through the proxy and upstream telnet is plaintext
  unless the MUD supports TLS on its own port
- Logs should avoid player passwords, session tokens, App Attest data, device
  tokens, and complete MUD output
- Debug logging should never be recommended for production

## Repository Hygiene

Recommended file changes:

- Rename tracked MUD E2E env profiles to example names, such as
  `.env.aardwolf.example`
- Ignore `.env`, `.env.*`, and all local secret variants
- Explicitly unignore only `.env.example` and `*.example` config files
- Keep `cert.pem`, `privkey.pem`, APNS `.p8` keys, client CAs, attested key
  stores, chat logs, coverage, and build output ignored
- Remove local/private agent files from lint scope
- Keep `bun.lock` tracked for reproducible installs
- Keep `dist/` ignored unless release packaging intentionally commits build
  output

Before publication, run a full history secret scan with a purpose-built tool
such as Gitleaks or TruffleHog. A quick grep did not find non-placeholder env
credentials in current tracked files, but that is not enough for public release
confidence.

## CI And Quality Gates

Minimum CI on every pull request:

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run build`

Recommended script cleanup:

- Add `test:unit` as an alias for the current unit test command, or update CI to
  run `bun run test`
- Add `test:ci` if CI should run without coverage noise or with stricter flags
- Add `format:check` if Prettier should be enforced separately from ESLint
- Add a mock-only e2e job that does not contact real public MUDs

Recommended extra checks:

- Dependency audit or vulnerability scan
- Docker image build test
- Secret scan
- Markdown link check for docs

## Testing Gaps To Close

Add regression tests for:

- Session protocol rejects non-default or non-allowlisted `host` and `port`
- Legacy and session connection paths use the same target policy
- Private, loopback, metadata, and link-local addresses are rejected in
  multi-target mode
- `ONLY_ALLOW_DEFAULT_SERVER`, `ALLOWED_TARGETS`, and related env parsing
- Diagnostics disabled by default in production
- Diagnostics require an admin token when enabled
- Diagnostic HTML escapes all interpolated values
- APNS debug secret comparison is timing-safe
- HTTP body-size guard sends only one response
- Correct `ESC` and `ACCEPT_UTF8` protocol constants
- NAWS width and height validation
- Non-compressed WebSocket send path checks `readyState`

Current observed verification:

- `bun run typecheck` passes
- `bun run build` passes
- `bun run test` passes with `467 pass, 0 fail`
- `bun run lint` fails locally because it scans
  `.claude/settings.local.json`
- `bun run test:unit` fails because the script is missing

## Documentation Needed

README should cover:

- What the project does in one paragraph
- Who should run it
- Safe private-proxy quickstart
- Docker quickstart
- Bun-from-source quickstart
- Configuration table for all runtime env vars
- Security model and privacy warning
- Reverse proxy/TLS guidance
- Client protocol summary
- Health and diagnostics endpoints
- Troubleshooting
- Links to detailed docs

Add dedicated docs:

- `docs/deployment.md`: Docker Compose, systemd, reverse proxy, Certbot,
  Fly.io-style deployment, firewall guidance
- `docs/configuration.md`: every env var, default, allowed values, production
  recommendation
- `docs/security.md`: threat model, open-relay prevention, App Attest,
  diagnostics, secret handling
- `docs/client-protocol.md`: legacy protocol and session protocol message
  formats
- `docs/e2e-testing.md`: mock tests versus real MUD tests, credential handling
- `docs/operations.md`: logs, health checks, upgrades, backups, APNS key
  rotation

Project governance docs:

- `SECURITY.md`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- Issue templates
- Pull request template
- `CHANGELOG.md`
- Release checklist

## Deployment Packaging

Recommended Docker support:

- `Dockerfile` using Bun
- Non-root runtime user
- `HEALTHCHECK` hitting `/health`
- `.dockerignore`
- `compose.yml` with env file, persistent config volume, and port mapping
- Optional Caddy or Nginx reverse proxy example
- GHCR image publishing on tags

Recommended systemd support:

- Example service file
- `EnvironmentFile=/etc/mud-web-proxy.env`
- Restart policy
- Read/write paths limited to config and data directories
- Journald logging instructions

Recommended production layout:

```text
/opt/mud-web-proxy/        application checkout or release bundle
/etc/mud-web-proxy.env     runtime configuration
/var/lib/mud-web-proxy/    attested keys and runtime state
/var/log/mud-web-proxy/    optional file logs if not using journald
```

## Configuration Model

Recommended public-facing env vars:

- `WS_PORT`
- `TN_HOST`
- `TN_PORT`
- `ONLY_ALLOW_DEFAULT_SERVER`
- `ALLOWED_TARGETS`
- `ALLOWED_ORIGINS`
- `LOG_LEVEL`
- `DISABLE_TLS`
- `TLS_CERT_PATH`
- `TLS_KEY_PATH`
- `REQUIRE_APP_AUTH`
- `APPATTEST_BUNDLE_ID`
- `APPATTEST_TEAM_ID`
- `ATTESTED_KEYS_PATH`
- `APNS_KEY_PATH`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_TOPIC`
- `APNS_ENVIRONMENT`
- `APNS_TEST_SECRET`
- `ENABLE_DIAGNOSTICS`
- `ADMIN_TOKEN`
- `SESSION_TIMEOUT_HOURS`
- `MAX_SESSIONS_PER_DEVICE`
- `MAX_CONNECTIONS_PER_IP`
- `BUFFER_SIZE_KB`

Production recommendations:

- `ONLY_ALLOW_DEFAULT_SERVER=true`
- `ALLOWED_ORIGINS` set to specific origins, not `*`
- `LOG_LEVEL=INFO` or `WARN`
- `DISABLE_TLS=0` unless TLS is terminated by a trusted reverse proxy
- `ENABLE_DIAGNOSTICS=false` unless protected
- `REQUIRE_APP_AUTH=true` only when App Attest is fully configured

## Licensing

Pick one license model and make it consistent.

Recommended path if preserving GPL lineage:

- Replace `LICENSE.md` with the full GPLv3 text or clearly name it as GPLv3
- Set `package.json` license to `GPL-3.0-or-later` if the current
  "version 3 or later" wording is intended
- Update `wsproxy.ts` header to match
- Add attribution for original authors and fork history
- Consider a `NOTICE` file if you want clearer attribution outside the license

Useful references:

- SPDX GPLv3-or-later identifier:
  https://spdx.org/licenses/GPL-3.0-or-later.html
- GNU GPLv3 license text:
  https://www.gnu.org/licenses/gpl-3.0.html

## Recommended Release Sequence

1. Fix the open-relay issue and add regression tests.
2. Fix protocol constants and other confirmed high-confidence bugs.
3. Make runtime security defaults explicit and documented.
4. Clean up `.gitignore`, env examples, private deploy files, and CI scripts.
5. Resolve license metadata and file headers.
6. Add Docker Compose and systemd deployment paths.
7. Rewrite README for self-hosters.
8. Add security, contributing, issue template, and release checklist docs.
9. Run typecheck, lint, build, unit tests, mock e2e tests, and secret scanning.
10. Publish as a release candidate tag.
11. Test the release candidate from a clean machine using only public docs.
12. Make the repository public after the clean-machine install succeeds.

## Publication Criteria

The repository is ready to make public when all of these are true:

- No known critical or medium security bugs remain.
- The default config cannot be abused as an open relay.
- A new user can run a private proxy from the README without reading source.
- CI passes from a clean checkout.
- Real secrets and private deployment details are not tracked.
- License metadata is consistent.
- Docker or systemd deployment has been tested.
- Security reporting instructions exist.
- The first public release tag is reproducible from source.
