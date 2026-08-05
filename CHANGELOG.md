# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.0.0] - 2026-08-05

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

[unreleased]: https://github.com/AndrewGoldfinch/mud-web-proxy/compare/v4.0.0...HEAD
[4.0.0]: https://github.com/AndrewGoldfinch/mud-web-proxy/releases/tag/v4.0.0
