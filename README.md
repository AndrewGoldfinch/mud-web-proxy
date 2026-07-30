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

Build the production image:

```bash
docker build --pull -t mud-web-proxy:local .
```

The supported Phase 2 deployment places Caddy in front of the proxy. Until the
Compose topology lands in MWP-100, this loopback-only command exercises the same
internal plaintext hop without exposing port 6200 beyond the host:

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

You need to have your certificates available to use wsproxy. Inbound TLS is required by default, so starting without usable certificates aborts at startup rather than quietly falling back to plaintext:

```bash
$ bun dev
error: Configuration errors:
  TLS certificate not found at /path/to/cert.pem. INBOUND_TLS_MODE=required requires both TLS_CERT_PATH and TLS_KEY_PATH to point to existing files.
  TLS key not found at /path/to/privkey.pem. INBOUND_TLS_MODE=required requires both TLS_CERT_PATH and TLS_KEY_PATH to point to existing files.
```

The check is more than a file-existence test: an unreadable file, a malformed certificate, or a certificate that does not match its private key is also refused here, rather than failing later at the first handshake.

To run without TLS during local development — behind a reverse proxy that terminates it, or against a loopback-only listener — set `INBOUND_TLS_MODE=off`. On any non-loopback `BIND_HOST` that additionally requires `ALLOW_INSECURE_INBOUND_NO_TLS=true`, so an exposed plaintext listener is always something you asked for explicitly.

You need to have available both files in the same directory as the proxy, like this:

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

Probably you will only have to set:

- `TN_HOST` to your hostname (Note that `localhost` or `127.0.0.1` don't seem to work: [see conversation here](https://github.com/maldorne/mud-web-proxy/issues/5#issuecomment-866464161), although it has not been tested in deep).
- `TN_PORT` to the port where the mud is running.
