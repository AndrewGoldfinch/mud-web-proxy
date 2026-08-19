# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 4.x     | Yes       |
| < 4.0   | No        |

v4 is the first public release. Earlier version numbers exist only in this
repository's history and were never published.

## Reporting a vulnerability

Report privately, not as a public issue. Use GitHub's private vulnerability
reporting to
[open a draft advisory](https://github.com/AndrewGoldfinch/mud-web-proxy/security/advisories/new).

That channel is preferred over email because it keeps the report, the fix, and
the advisory in one place and does not publish an address that gets scraped.

Include the following in your report:

- The version from `/health`.
- Which deployment path you run: Docker Compose or systemd.
- The relevant configuration, with secrets redacted.
- What an attacker gains.

## What to expect

This project is maintained by one person. These windows are what one person can
actually keep:

| Stage                  | Commitment                                                    |
| ---------------------- | ------------------------------------------------------------- |
| Acknowledgment         | Within seven days                                             |
| Initial assessment     | Within 14 days                                                |
| Fix or mitigation plan | Communicated with the assessment                              |
| Public disclosure      | Coordinated—after a fix ships, or 90 days, whichever is first |

This project offers no fixed fix-by date. A single maintainer cannot honor a 72-hour
critical-fix promise, and a published timeline that is missed is worse than a
modest one that is kept.

## Scope

**In scope**: anything that lets a client reach a target the operator's
configuration forbids, bypass authentication or Origin policy, spoof its client
identity, exhaust a bounded resource beyond its limit, or read another client's
data.

**Out of scope:**

- Attacks against the App Attest implementation. It is experimental and has
  not had independent cryptographic review, and it is disabled by default.
  Findings are welcome, but they are not severity-rated as vulnerabilities in a
  reviewed control.
- A hostile operator, or compromise of the host the proxy runs on.
- Rendering vulnerabilities in a MUD client consuming this proxy's output. The
  proxy relays untrusted game output verbatim by design.
- Volumetric denial of service that exhausts the host, reverse proxy, or
  network before process-level limits can act.
- Configuration choices working as documented. `TARGET_MODE=arbitrary` permits
  client-chosen destinations on purpose, and `MUD_TLS_MODE=prefer` is
  downgradeable on purpose.

For the reasoning behind every one of those, and for what the built-in
controls do and do not protect, see
[Security model and threat model](docs/security.md). That document is the
authoritative technical reference; this document is disclosure policy.
