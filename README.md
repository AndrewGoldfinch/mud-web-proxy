# mud-web-proxy

### What is this?

[Bun](https://bun.sh/) / TypeScript microserver which provides a secure websocket (`wss://`) to telnet (`telnet://`) proxy for [MUD](https://en.wikipedia.org/wiki/MUD) / MUSH / MOO game servers, supporting all major data interchange and interactive text protocols. To connect and play a game, you will need to run in your web page a web client capable to connect through `wss` to this proxy, like [`mud-web-client`](https://github.com/maldorne/mud-web-client).

### History

This project is a fork of [MUDPortal-Web-App](https://github.com/plamzi/MUDPortal-Web-App), made by [@plamzi](https://github.com/plamzi), creator of [mudportal.com](http://www.mudportal.com/). The original project had the code of both the client and proxy-server apps, and was outdated and did not support secure connections (`wss://` instead of `ws://`), so I decided to fork it in 2020, separate in different projects and update them. But kudos to [@plamzi](https://github.com/plamzi), who is the original author.

In 2025, I've ported the project to use ES modules.

### Motivation

In modern browsers, web-pages served through `https://` are not allowed to open connections to non-secure locations, so an `https://`-served web could not include a web client which opens a connection using `ws://`. Modifications were needed to allow secure connections.

## Features

- MCCP compression support (zlib)
- MXP protocol support built into the client
- MSDP protocol support
- GMCP / ATCP protocol support (JSON) with sample uses in multiple existing plugins
- 256-color support, including background colors
- Unicode font support and UTF-8 negotiation
- To avoid abuse, default installation only allows connection to an specific server, although it can be configured to connect to any server sent by the client as an argument.

## Installation

Development and production use exactly the Bun release recorded in
`.bun-version`. Clone the repository first, then install that release:

```bash
git clone https://github.com/maldorne/mud-web-proxy
cd mud-web-proxy
curl -fsSL https://bun.com/install |
  bash -s "bun-v$(cat .bun-version)"
bun install
bun run check:bun-version
```

```bash
# Development (run TypeScript directly)
bun dev

# Production (compile first, then run)
bun run build
bun start
```

### Docker image

Published multi-arch images (`linux/amd64`, `linux/arm64`) are available from
GHCR:

```bash
docker pull ghcr.io/andrewgoldfinch/mud-web-proxy:latest
```

Every image carries a build-provenance attestation and an SBOM. Pin by digest
in production and verify before deploying — see
[Published container images](docs/deployment/images.md) for the tag policy and
verification commands. Release candidates never move `latest`.

Or build it yourself:

```bash
docker build --pull -t mud-web-proxy:local .
```

The supported Phase 2 deployment places Caddy in front of the proxy — see
[Docker Compose](#docker-compose) below. This loopback-only command exercises
the same internal plaintext hop directly, without exposing port 6200 beyond
the host, which is useful for testing the image on its own:

```bash
docker volume create mud-web-proxy-state
docker run --rm --name mud-web-proxy \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --mount type=volume,source=mud-web-proxy-state,target=/var/lib/mud-web-proxy \
  --publish 127.0.0.1:6200:6200 \
  --env BIND_HOST=0.0.0.0 \
  --env INBOUND_TLS_MODE=off \
  --env ALLOW_INSECURE_INBOUND_NO_TLS=true \
  --env TARGET_MODE=fixed \
  --env MUD_TLS_MODE=plain \
  --env TN_HOST=mud.example.com \
  --env TN_PORT=4000 \
  mud-web-proxy:local
```

The image deliberately declares neither `EXPOSE` nor `HEALTHCHECK`: Caddy and
Compose own port publication and the HTTP readiness probe because that layer
selects the internal TLS mode. Docker port publication still works without
`EXPOSE`.

### Docker Compose

The portable, container-first path: Caddy terminates HTTPS/WSS and the proxy
runs behind it on an internal network, with only 80 and 443 published.

```bash
cp .env.compose.example .env
$EDITOR .env
docker compose up -d
```

See [Docker Compose deployment](docs/deployment/compose.md). The stack ships
health checks, `restart: unless-stopped`, and bounded logs; App Attest state
is an opt-in overlay. Proxy settings from docs/configuration.md go straight
into `.env` under their real names. For a single Linux VM, prefer the systemd
path below.

### Native systemd deployment

The repository ships the hardened unit, static-user declaration, native
environment example, and reusable Caddy template under `deploy/` and
`config/`. Follow [Native systemd deployment](docs/deployment/systemd.md);
validate changes on a disposable Ubuntu 26.04 host with
[Systemd acceptance](docs/deployment/systemd-acceptance.md).

The verified MWP-103 release bundle is a separate deployment input. Migration
from the legacy PM2/git-checkout host uses MWP-104's new Ubuntu 26.04 Droplet
rather than an in-place conversion. Follow the
[New-Droplet cutover runbook](docs/deployment/new-droplet-cutover.md); App
Attest state preservation is mandatory for the current production deployment.

App Attest is disabled unless both `APPATTEST_BUNDLE_ID` and
`APPATTEST_TEAM_ID` are set. When enabled, mount the writable directory
`/var/lib/mud-web-proxy`, not the `attested-keys.json` file; atomic persistence
creates and renames a sibling temporary directory.

To upgrade Bun, change `.bun-version`, mirror that exact value in
`package.json#engines.bun` and the digest-pinned `BUN_IMAGE` in `Dockerfile`,
update the pinned image occurrences in `tests/container/` and
`tests/docker-image-contract.test.ts`, then regenerate `bun.lock` with the new
runtime. CI reads `.bun-version` directly, and
`bun run check:bun-version` enforces the package metadata mirror. Use
`rg 'oven/bun:' Dockerfile tests/container tests/docker-image-contract.test.ts`
to find every container pin.

### Direct application-managed TLS

The certificate instructions below apply only when the application itself
terminates inbound TLS. The native host-Caddy path and the Compose edge path
terminate TLS at the edge, set `INBOUND_TLS_MODE=off`, and omit
`TLS_CERT_PATH` and `TLS_KEY_PATH` from the application environment.

For direct application-managed TLS, you need to have certificates available
to use wsproxy. Inbound TLS is required by default, so starting without usable
certificates aborts at startup rather than quietly falling back to plaintext:

```bash
$ bun dev
error: Configuration errors:
  TLS certificate not found at /path/to/cert.pem. INBOUND_TLS_MODE=required requires both TLS_CERT_PATH and TLS_KEY_PATH to point to existing files.
  TLS key not found at /path/to/privkey.pem. INBOUND_TLS_MODE=required requires both TLS_CERT_PATH and TLS_KEY_PATH to point to existing files.
```

The check is more than a file-existence test: an unreadable file, a malformed certificate, or a certificate that does not match its private key is also refused here, rather than failing later at the first handshake.

To run without TLS during local development — behind a reverse proxy that terminates it, or against a loopback-only listener — set `INBOUND_TLS_MODE=off`. On any non-loopback `BIND_HOST` that additionally requires `ALLOW_INSECURE_INBOUND_NO_TLS=true`, so an exposed plaintext listener is always something you asked for explicitly.

For this direct-TLS mode, make both files available in the same directory as
the proxy, like this:

```bash
$ ls
cert.pem  chat.json  dist/  docs/  LICENSE.md  package.json  privkey.pem  README.md  src/  tsconfig.json  wsproxy.ts
```

where `cert.pem` and `privkey.pem` will be links to the real files, something like:

```bash
cert.pem -> /etc/letsencrypt/live/...somewhere.../cert.pem
privkey.pem -> /etc/letsencrypt/live/...somewhere.../privkey.pem
```

How to install the certificates is beyond the scope of this project, but you could use [Certbot](https://certbot.eff.org/pages/about). You can find installation instructions for every operating system there, or look for instructions for your specific OS in any search engine with something like `How to install certbot for let's encrypt in <your operating system>`.

## Configuration

Configuration is environment-driven. Every setting is read once, at startup, in `src/runtime-config.ts`, and an invalid or retired value aborts the process rather than being ignored.

Read the [security model and threat model](docs/security.md) before changing
target policy, authentication, trusted-proxy, TLS, or resource-limit settings;
it explains which protections each default provides and what loosening it
exposes.

The `srv` object in `wsproxy.ts` is populated from that parsed config, so editing values like `ws_port` or `tn_host` there has no effect — they are overwritten on every start. Two literals in `srv` are genuinely source-only, because nothing reads an environment variable for them:

```typescript
  /* enable additional debugging */
  debug: false,
  /* use node zlib (different from mccp) - you want this turned off unless
     your server can't do MCCP and your client can inflate data */
  compress: true,
```

(`open` also appears there, but it is shutdown state rather than a setting: it flips to `false` while the server drains.)

Everything else is set through the environment:

| Variable                        | Description                                                                        | Default             |
| ------------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| `WS_PORT`                       | WebSocket proxy port                                                               | `6200`              |
| `BIND_HOST`                     | Address to listen on                                                               | `127.0.0.1`         |
| `TN_HOST`                       | Default telnet host                                                                | `muds.maldorne.org` |
| `TN_PORT`                       | Default telnet port                                                                | `5010`              |
| `INBOUND_TLS_MODE`              | `required` or `off`. `required` refuses to start without a usable cert/key pair    | `required`          |
| `TLS_CERT_PATH`                 | Certificate path                                                                   | `./cert.pem`        |
| `TLS_KEY_PATH`                  | Private key path                                                                   | `./privkey.pem`     |
| `ALLOW_INSECURE_INBOUND_NO_TLS` | Acknowledge a plaintext listener. Required for `INBOUND_TLS_MODE=off` off loopback | `false`             |

`DISABLE_TLS` and `ALLOW_INSECURE_PRODUCTION_NO_TLS` were removed. Startup aborts if either is still set, naming the replacement — they are listed here only so an upgrade from an older version fails loudly instead of silently serving plaintext.

This table is not exhaustive. Every variable — target policy, authentication, origin checks, trusted proxies, session limits, diagnostics, and the optional Apple features — is documented in the [configuration reference](docs/configuration.md), which CI keeps in step with `src/runtime-config.ts`. [`.env.example`](.env.example) carries the same settings as commented, copyable defaults.

Once it is running, the [operations guide](docs/operations.md) covers health checks, logs, certificate renewal, upgrades, backup and restore, and a troubleshooting entry for every startup error the proxy can refuse to start with.

Probably you will only have to set:

- `TN_HOST` to your hostname (Note that `localhost` or `127.0.0.1` don't seem to work: [see conversation here](https://github.com/maldorne/mud-web-proxy/issues/5#issuecomment-866464161), although it has not been tested in deep).
- `TN_PORT` to the port where the mud is running.

## License and attribution

mud-web-proxy is licensed under
[GPL-3.0-or-later](LICENSE). See [NOTICE](NOTICE) for upstream authorship and
the attribution required for MIT-derived portions of the project.
