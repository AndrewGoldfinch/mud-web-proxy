# Open-Source and Self-Hosting Release Plan

## Executive summary

`AndrewGoldfinch/mud-web-proxy` is already public. The work is therefore not a
visibility change; it is a security, licensing, packaging, and operations
release project.

The repository currently builds, passes 495 unit tests, and passes the mock MUD
E2E suite. It is not yet ready to recommend for third-party self-hosting:

- `ws` is below the patched version and the dependency audit fails.
- Production deploys automatically from an unprotected `develop` branch.
- The public health endpoint exposes operational and Apple/APNS metadata.
- Forwarded client-IP headers are trusted without a trusted-proxy boundary.
- Session and connection limits can be bypassed by omitting or rotating device
  tokens.
- Target policy can become an unrestricted TCP relay.
- Licensing metadata is contradictory and GitHub reports `NOASSERTION`.
- There is no supported Docker, Compose, Caddy, or systemd package.

The first supported release should be `v4.0.0`: preserve the typed and legacy
client wire protocols, but make configuration and security defaults explicit
and intentionally breaking.

## Phase 0: contain current exposure

Complete these before normal release work:

1. Disable the existing branch-triggered production deployment. Set GitHub
   Actions defaults to read-only permissions, disable workflow PR approval, and
   move hostnames, paths, and SSH deployment logic to a private operations
   repository. Rotate the deployment SSH key after migration.

2. Upgrade `ws` to `8.21.1`, refresh `bun.lock`, set an explicit WebSocket
   `maxPayload` of 64 KiB, and manually deploy the tested hotfix to the live
   proxy. The high-severity memory exhaustion issue is documented in the
   [GitHub advisory](https://github.com/advisories/GHSA-96hv-2xvq-fx4p).

3. Make `/health` return only `{ status, version }`, add
   `Cache-Control: no-store`, and return 503 while draining. Keep detailed
   diagnostics admin-authenticated.

4. Configure the current reverse proxy to overwrite `X-Forwarded-For` and
   `X-Real-IP`; do not append attacker-supplied values.

5. Preserve the dirty worktree in a safety branch, fetch public `develop`, and
   rebase a release branch onto it. Do not push directly to `develop`.

6. Run Gitleaks across all refs, deleted blobs, workflow logs, and artifacts.
   Replace the 64-character token-shaped PRD example with an unmistakable
   placeholder. Treat it as synthetic only after checking it against deployed
   credentials; revoke anything matching it before release.

## Phase 1: runtime security contract

Centralize environment parsing and fail startup on invalid or contradictory
configuration. Use these public settings:

- `BIND_HOST`, `WS_PORT`, `INBOUND_TLS_MODE`, `TLS_CERT_PATH`, and
  `TLS_KEY_PATH` for listener and TLS behavior.
- `TRUSTED_PROXY_CIDRS`, disabled by default, so forwarded headers are honored
  only from known proxy peers.
- `ALLOWED_ORIGINS` and `ALLOW_MISSING_ORIGIN`; Origin is browser hardening,
  not authentication.
- `AUTH_MODE=shared-secret|none` and `PROXY_SHARED_SECRET`; production private
  deployments use a random shared secret of at least 32 bytes.
- `TARGET_MODE=fixed|allowlist|arbitrary`.
- `TN_HOST`, `TN_PORT`, `ALLOWED_TARGETS`, and `ARBITRARY_ALLOWED_PORTS`.
- `MUD_TLS_MODE=plain|required|prefer`; required mode must never downgrade to
  plaintext.
- Explicit global, per-IP, pending-dial, per-session, buffer, payload, and
  connection-timeout limits.

Target behavior:

- `fixed` allows only `TN_HOST:TN_PORT`.
- `allowlist` permits only exact operator-configured `host:port` entries.
- `arbitrary` requires authentication and configured port ranges. Resolve all
  A/AAAA records, reject loopback/private/link-local/multicast/metadata
  addresses, and connect to the validated address to prevent DNS rebinding.
- Exact `ALLOWED_TARGETS` entries may deliberately reference private networks.
- An empty or malformed allowlist is a startup error, never an unrestricted
  fallback.

Apply the same policy and authentication to both the typed session protocol and
the legacy `{ host, port, connect }` protocol. The existing legacy path is
currently not reached by the main parser; restore it deliberately and cover it
with real process-level tests.

Enforce limits for every client, even without a device token. Reserve capacity
before DNS/TCP work, release it on every failure path, reject repeated connect
messages on one WebSocket, add ping/pong heartbeats, and cap telnet
subnegotiation, GMCP, input, and circular-buffer sizes.

Validate recognized JSON messages strictly. Invalid recognized messages must
return `invalid_request`, never fall through as raw MUD input. Never allow a
client to enable server debug logging; redact secrets, player input, session
tokens, device tokens, and control characters from logs.

Make App Attest/APNS optional and disabled by default. Register App Attest
routes only when configured, remove production assertion bypasses, bound and
rate-limit nonce/key stores, atomically persist attested keys, and label the
feature experimental until its Apple verification implementation receives an
independent cryptographic review.

Implement bounded graceful shutdown: become unready, reject upgrades, close
WebSockets and telnet sessions, flush state, close listeners, and exit within a
fixed deadline. Document that sessions and resume state are memory-local and
are lost on restart.

## Phase 2: distribution and deployment

Support two equal production paths using the same architecture: Caddy
terminates HTTPS/WSS and one Bun process runs behind it. Caddy supports
WebSocket tunneling and trusted-proxy configuration; see the
[Caddy reverse-proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

### Docker Compose

- Pin Bun `1.3.14` in package metadata, CI, and the image build.
- Add a multi-stage Dockerfile with a non-root runtime, production
  dependencies, read-only root filesystem where practical, dropped
  capabilities, and no-new-privileges.
- Add Compose services for Caddy and the proxy. Expose only ports 80/443;
  keep port 6200 internal.
- Add health checks, restart policy, bounded logs, Caddy certificate volumes,
  and an optional App Attest state volume.
- Publish amd64/arm64 images to GHCR using immutable release tags and digests.

### Bun + systemd

- Publish a release bundle containing `dist`, production manifests and lockfile,
  checksums, SBOM, license, notice, and public CA material.
- Install releases under `/opt/mud-web-proxy/releases/<version>` with a
  `current` symlink; store environment in `/etc/mud-web-proxy.env` and durable
  state in `/var/lib/mud-web-proxy`.
- Provide a hardened systemd unit with a dedicated user, `StateDirectory`,
  `NoNewPrivileges`, `ProtectSystem=strict`, restricted writable paths, and
  restart-on-failure.
- Bind the application to loopback and proxy it through host Caddy.
- Document atomic upgrade, rollback, certificate renewal, backups, and the
  fact that active sessions are lost during restart.
- Remove PM2 from the supported deployment matrix.

The official [Bun Docker guide](https://bun.sh/docs/guides/ecosystem/docker)
should inform the container structure.

## Phase 3: legal, documentation, and governance

Standardize the project on `GPL-3.0-or-later`, matching the inherited GPL
lineage. GNU recommends an explicit license statement as well as the license
text; see the [GNU licensing guidance](https://www.gnu.org/licenses/gpl-howto.en.html).

- Replace the abbreviated/misnamed license file with canonical GPLv3 text in
  `LICENSE`.
- Add `NOTICE` preserving original authors, MIT-derived attribution, and
  upstream links.
- Set package and source metadata to `GPL-3.0-or-later`; remove the misleading
  current-project MIT header.
- Mark the package private; do not publish it to npm in v4.

Rewrite the README and add focused documentation for:

- Docker and systemd quickstarts.
- Complete configuration and v3→v4 migration.
- Target policy, authentication, trusted proxies, resource limits, and threat
  model.
- Typed and legacy client protocols.
- TLS boundaries, plaintext upstream Telnet limitations, logs, health,
  diagnostics, upgrades, rollback, backups, and troubleshooting.
- Optional App Attest/APNS behavior and privacy implications — the substance
  is in [Optional Apple features](#optional-apple-features-privacy-and-status)
  below; the README should summarize it and link there.

### Optional Apple features: privacy and status

Both App Attest and APNS are optional and disabled by default. A self-hosting
operator running the proxy for a browser client should leave both unset and
will then carry none of what follows.

**App Attest is experimental.** The attestation and assertion verification in
`src/app-attest.ts` is a from-scratch implementation of Apple's format and has
not received an independent cryptographic review. That gap matters more than
it might appear: a verifier that is too permissive still accepts every genuine
client, so the failure mode is silent. Documentation, the `.env.example`
comments, and the startup log all say so, and all recommend pairing it with
`AUTH_MODE=shared-secret` rather than relying on it alone. Enabling it is the
operator's decision; the proxy's job is to make sure that decision is informed
and is never made by default.

Enabling it also has a privacy cost worth stating plainly. The proxy persists
one record per registered device — an Apple-issued key identifier, its public
key, a signature counter, and timestamps — to `ATTESTED_KEYS_PATH`. That file
is a durable list of which devices have used this server and roughly when,
so it should be treated as personal data: keep it on the same footing as
logs, and note that entries are reclaimed after 90 days of inactivity, which
bounds retention rather than eliminating it.

**APNS sends data to Apple.** When push is configured, three things follow
that do not otherwise happen:

- Device tokens supplied by clients are held in memory alongside their
  sessions, and are sent to Apple with every push. A device token is a stable
  per-install identifier.
- Alert pushes carry a snippet of MUD output — by default a trigger match,
  which is typically someone else's message to the player — through Apple's
  servers in cleartext-to-Apple form. Apple can read it. `ACTIVITY_PUSH_MAX_SNIPPET_LENGTH`
  bounds the size but does not change who can see it.
- Silent and Live Activity pushes reveal connection timing to Apple even when
  they carry no text: the pattern of pushes is itself a record of when a
  player is active.

None of this happens with APNS unconfigured, which is the default. Operators
who enable it should say so in their own privacy policy, because their users
cannot infer it from the fact that they are playing a MUD.

Add `SECURITY.md`, `SUPPORT.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CODEOWNERS`,
issue forms, and a pull-request template. Enable Issues and Discussions. Keep
governance single-maintainer and lightweight; add a Code of Conduct only after
choosing a monitored enforcement contact.

Move to protected `main`, require pull requests and passing checks, block force
push/deletion, require resolved conversations, use squash merges, and pin all
GitHub Actions to full commit SHAs. Enable Dependabot security updates, CodeQL,
secret scanning, and push protection. GitHub documents protected branches and
rulesets [here](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches).

## Phase 4: CI and release gates

Every pull request and protected-main push must run:

- Frozen Bun install, format check, lint, typecheck, unit tests, mock E2E, and
  production build.
- Unignored dependency audit with no unexplained moderate-or-higher findings.
- Full-history secret scan and CodeQL.
- Docker amd64/arm64 build, image scan, and Caddy-to-mock-MUD smoke test.
- Native release-bundle smoke test and `systemd-analyze verify`.

Add regression tests for:

- Fixed, allowlist, and arbitrary target modes.
- Reserved-network and DNS-rebinding rejection.
- Shared-secret authentication on typed and legacy protocols.
- Spoofed versus trusted forwarding headers.
- Tokenless, concurrent, repeated, and failed connection-limit behavior.
- Payload, rate, heartbeat, telnet, GMCP, nonce, key, and buffer caps.
- Required TLS no-downgrade behavior.
- Minimal public health and authenticated diagnostics.
- Secret/log redaction and graceful shutdown.
- App Attest route gating and production bypass removal.

Release sequence:

1. Merge the hardening branch to protected `main`.
2. Tag `v4.0.0-rc.1`; verify tag/version equality.
3. Build and publish the RC image, release bundle, SBOM, checksums, and
   provenance attestations. GitHub documents container publishing and
   attestations [here](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).
4. Install the RC on clean Docker and systemd hosts using only public docs.
5. Verify real WSS-to-MUD traffic, both protocols, restart, backup/restore,
   upgrade, rollback, and certificate renewal.
6. Run a seven-day canary while watching memory, file descriptors, reconnects,
   and session cleanup.
7. Publish `v4.0.0` only after both paths pass; update `4`, `4.0`, and `latest`
   only for the stable release.
8. Have the private operations repository deploy the exact stable image digest
   after approval and a health check.

## Acceptance criteria

The project is ready when:

- A clean operator can complete either documented installation without editing
  source code.
- Only Caddy’s 80/443 ports are externally exposed in the canonical setups.
- Both client protocols enforce identical authentication, target policy, and
  limits.
- Arbitrary mode cannot reach reserved networks without an exact allowlist.
- Public health reveals no sessions, IPs, APNS data, filesystem paths, hosts,
  or tokens.
- CI builds the exact production image and release bundle from a clean tag.
- The image is non-root, scan-clean, reproducible, and provenance-attested.
- Upgrades and rollback work from documented commands.
- Security reporting, support, contribution, licensing, and privacy guidance
  are all discoverable from the repository landing page.

## Assumptions

- Generic proxy support and MUDBasher-specific features remain in one project.
- `GPL-3.0-or-later` is used unless all relevant prior copyright holders provide
  written relicensing permission.
- Configuration changes are intentionally breaking for v4; client wire
  protocols remain supported.
- Private-network targets are allowed only as exact operator allowlist entries.
- One process/replica is supported; distributed session storage is outside v4.
