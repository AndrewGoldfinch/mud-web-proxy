# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [4.0.0] - 2026-08-20

First public release. Version numbers below 4.0.0 exist only in this
repository's history and were never published, so there is no migration path
from a public predecessor and no migration guide.

### Added

- **Target policy** via `TARGET_MODE`: `fixed` (default, one configured
  target), `allowlist` (exact operator entries), and `arbitrary`
  (client-chosen, and refuses to start without both an allowed-port list and
  enforced authentication).
- **Reserved-network rejection and DNS-rebinding protection** in `arbitrary`
  mode. Hostnames resolve once and the proxy dials the validated address.
- **Shared-secret authentication** (`AUTH_MODE=shared-secret`) with
  constant-time comparison and bounded failed-attempt tracking.
- **Origin policy** via `ALLOWED_ORIGINS`, with wildcards rejected at startup.
- **Trusted-proxy handling** via `TRUSTED_PROXY_CIDRS`. Forwarded headers are
  ignored unless the immediate peer is inside the list.
- **Upstream TLS** via `MUD_TLS_MODE`: `plain`, `prefer` (default), or
  `required`. One shared transport serves both wire protocols.
- **Resource limits**: per-device, per-IP, and global session caps; pending-dial
  reservations; per-connection and per-address message rates; Telnet
  subnegotiation and replay-buffer byte caps; heartbeat reclamation.
- **Ordered shutdown** with an absolute deadline, and `/health` reporting
  `draining` with a 503 while it runs.
- **Log redaction** of configured secrets, and neutralisation of control
  sequences in client-supplied values.
- **Optional App Attest and APNS support**, disabled unless fully configured.
  App Attest is experimental and has not had independent cryptographic review.
- **Supported deployments**: Docker Compose with Caddy, and Bun + systemd with
  a hardened unit. Multi-arch images published to GHCR with build provenance
  and an SBOM.
- **Documentation**: [security model](docs/security.md),
  [operations guide](docs/operations.md), and a
  [configuration reference](docs/configuration.md) that CI keeps in step with
  the source.

### Changed

- **Bun is pinned** to the version in `.bun-version`, enforced across package
  metadata, CI, and the container image.
- **Inbound TLS is the edge's job** in both supported topologies. The
  application listens plaintext on loopback or an internal network, and
  `INBOUND_TLS_MODE=off` on a non-loopback address requires explicit
  acknowledgement.
- Public documentation now follows the
  [Google developer documentation style guide](https://developers.google.com/style):
  sentence-case headings, second person, active voice, present tense, American
  spelling, and its word list. `docs/MOCK_MUD.md` is renamed to
  `docs/mock-mud.md` to match the guide's filename rules; update any bookmark
  to the old path. Three factual defects were corrected on the way: an
  unresolved git merge conflict committed into the mock MUD guide, a claim in
  `docs/artifact-policy.md` that the audit script ignores ESLint advisories
  (it carries no ignore list, and ESLint was removed), and a stale caveat in
  `docs/deployment/images.md` that the Compose stack might not exist in a
  checkout.

- Refusals at the WebSocket upgrade now record a reason in the log. A rejected
  Origin names the value that was received — the usual cause is one that is
  nearly right, a trailing slash or `http` for `https` — and a missing Origin
  is reported distinctly, because the two have different fixes. Draining
  refusals log too. Previously an operator saw the upgrade request and then
  silence, while the client was told `1008 403 Forbidden`, so the person who
  could fix the configuration knew less than the person hitting it.

- **Connections refused at the WebSocket upgrade now close with a WebSocket
  close code instead of an HTTP status.** `1008` for a refusal that retrying
  will not fix (`401 Unauthorized`, `403 Forbidden`), `1013` for a temporary
  one worth retrying after a wait (`429 Too Many Requests`,
  `503 Service Unavailable`); the reason string carries the corresponding HTTP
  status. Clients that inspected the handshake status must read `event.code`
  and `event.reason` instead. This is not a preference: the proxy runs on Bun,
  which discards writes to the upgrade socket, so the status line never
  reached clients at all — every refusal arrived as a bare connection reset,
  indistinguishable from a crash. See `docs/protocols.md`.
- APNS failure diagnostics are written once, to stderr. They were written to
  both stdout and stderr so that PM2 setups showing only one stream still
  captured them. Both supported topologies capture stderr — journald under
  systemd, the json-file driver under Compose — so the second write only
  duplicated every failure.
- App Attest certificate subjects are neutralised before being logged. The
  subject is client-supplied and was stripped of newlines only, leaving ANSI
  and cursor-movement sequences intact in a warning that fires precisely when
  the certificate is not the expected Apple one.

### Removed

Six configuration variables were retired. Each **aborts startup** when set,
naming its replacement, rather than being silently ignored — a silently ignored
security setting is a protection that disappears without anyone noticing.

| Retired                            | Use instead                                                      |
| ---------------------------------- | ---------------------------------------------------------------- |
| `ONLY_ALLOW_DEFAULT_SERVER`        | `TARGET_MODE=fixed` (default), or `allowlist` / `arbitrary`      |
| `DISABLE_TLS`                      | `INBOUND_TLS_MODE=off` (loopback only)                           |
| `ALLOW_INSECURE_PRODUCTION_NO_TLS` | `INBOUND_TLS_MODE=off` plus `ALLOW_INSECURE_INBOUND_NO_TLS=true` |
| `TRUST_PROXY`                      | `TRUSTED_PROXY_CIDRS`                                            |
| `ALLOW_MTLS_FALLBACK`              | `AUTH_MODE=shared-secret` for clients that cannot attest         |
| `MTLS_CLIENT_CA_PATH`              | Removed with the above; client certificates are not requested    |

- **PM2** was removed from the supported deployment matrix. The native path is
  systemd.
- **MCCP negotiation, which never worked.** The flag gating it was declared
  and never assigned, so the branch answering `IAC WILL MCCP2` was
  unreachable. The diagnostics surface nevertheless reported
  `protocols.mccp: true` for every connection older than the 12-second
  negotiation timeout. Both that field and `compressed` — which was likewise
  permanently zero once the dead branch was gone — are removed from the
  diagnostics payload. Traffic to the MUD was never compressed, so nothing
  about the data path changes.
- `ecosystem.config.cjs`. PM2 was removed from the supported deployment matrix
  in 4.0.0; the file was the last thing in the repository that could be
  mistaken for a supported path.

### Fixed

- Legacy connections honour `MUD_TLS_MODE`. `required` previously fell back to
  plaintext on the legacy path.
- An upstream dial that never completes no longer holds connection capacity
  for the life of the process.
- A frame the client has already acknowledged is no longer replayed on resume.

[unreleased]: https://github.com/AndrewGoldfinch/mud-web-proxy/compare/v4.0.0...HEAD
[4.0.0]: https://github.com/AndrewGoldfinch/mud-web-proxy/releases/tag/v4.0.0
