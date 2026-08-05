# Support

## Where to go

| You have           | Use                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| A question         | [Discussions](https://github.com/AndrewGoldfinch/mud-web-proxy/discussions)                                         |
| A bug              | [Issues](https://github.com/AndrewGoldfinch/mud-web-proxy/issues)                                                   |
| A security finding | [Private advisory](https://github.com/AndrewGoldfinch/mud-web-proxy/security/advisories/new) — never a public issue |

Before opening anything, check [the operations guide](docs/operations.md). It
has a troubleshooting entry for every startup error the proxy can refuse to
start with, and a CI gate keeps that true.

## What a good bug report contains

- **Version** — the `version` field from `/health`, not the tag you think you
  deployed. It reports the build that is actually running.
- **Deployment path** — Docker Compose or Bun + systemd.
- **Configuration**, with secrets redacted. `PROXY_SHARED_SECRET`,
  `ADMIN_TOKEN`, and APNS material never belong in an issue.
- **Logs** around the failure. `journalctl -u mud-web-proxy` or
  `docker compose logs proxy`.
- What you expected, and what happened instead.

## Explicitly unsupported

These are not oversights. Reports against them will be closed with a pointer
here.

- **PM2.** Removed from the supported deployment matrix. The native path is
  systemd — see [native systemd deployment](docs/deployment/systemd.md).
- **Direct exposure without a reverse proxy.** Both supported topologies put
  Caddy in front. Running the application itself on a public interface is a
  different topology, requires `INBOUND_TLS_MODE=required`, and is not what the
  deployment documents describe or test.
- **Multiple replicas.** Sessions and rate-limiter state are memory-local. A
  second replica does not share them — it multiplies every limit by the replica
  count. See [known limitations](docs/security.md#known-limitations-and-residual-risks).
