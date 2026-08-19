# mud-web-proxy

A WebSocket-to-Telnet proxy that lets a browser reach a telnet MUD, MUSH, or
MOO server over `wss://`. Browsers refuse plaintext `ws://` from an `https://`
page, so a web MUD client needs something like this in front of the game
server. It supports the protocols that MUD clients expect—GMCP and ATCP,
MSDP, MXP, MCCP compression, NAWS, UTF-8 negotiation, and 256 color—and
passes them through in both directions.

It is a single-process, single-replica service. There is no clustering and no
shared state between instances.

## What this does on your behalf

Read this section before you run the install commands. Three properties
decide whether this proxy is safe to run in your environment.

**It opens outbound TCP connections for remote clients.** That is the entire
product, and `TARGET_MODE` alone determines where those connections go. The default, `fixed`, permits exactly one configured target. Widening it to
`arbitrary` lets clients choose the destination, so `arbitrary` refuses to
start without both an allowed-port list and enforced authentication. Before
you change it, see [Target policy](docs/security.md#target-policy).

**Sessions live in memory and every restart drops them.** No persistence, no
handover. Restarts, upgrades, and rollbacks all disconnect every connected
player, and clients reconnect from scratch. Plan maintenance windows
accordingly.

**The browser hop and the game hop are independent.** `wss://` between browser
and proxy implies nothing about the link between proxy and MUD, which is usually
plaintext because most MUDs offer nothing else. `MUD_TLS_MODE=prefer` (the
default) attempts TLS and falls back—including when the MUD's certificate
fails validation, which is the common case, since few MUDs have a publicly
trusted certificate. `required` refuses to fall back, at the cost of only
working against certificates your runtime already trusts.

For the full treatment, including the threat model and what is explicitly
_not_ protected, see [Security model and threat model](docs/security.md).

## Requirements

- A domain name pointing at the host.
- Inbound TCP ports 80 and 443. Certificate issuance and renewal need port 80
  even though traffic runs on 443. A firewall that allows only 443 is the most
  common cause of a silent renewal failure.
- Docker with Compose, or Bun `1.3.14` for the native path. The
  [`.bun-version`](.bun-version) file pins the version.

Both quickstarts put [Caddy](https://caddyserver.com/) in front to terminate
HTTPS and WSS, and to obtain certificates automatically.

## Quickstart: Docker Compose

The portable path. Caddy and the proxy run as two containers; only 80 and 443
are published.

A clean Ubuntu image has neither Docker nor the Compose plugin; install them
from [Docker's own repository](https://docs.docker.com/engine/install/) first.
The distribution's `docker.io` package doesn't work, because it omits
Compose v2.

```bash
git clone https://github.com/AndrewGoldfinch/mud-web-proxy
cd mud-web-proxy
git checkout v4.0.0     # a release; omit to track unreleased main
cp .env.compose.example .env
```

Set four values in the `.env` file. They ship empty on purpose, so that an
unedited copy fails immediately with a named error rather than starting on
placeholder configuration.

```dotenv
MWP_DOMAIN=proxy.example.com      # the domain pointing at this host
MWP_ACME_EMAIL=you@example.com    # for Let's Encrypt expiry notices
TN_HOST=mud.example.com           # the MUD to connect to
TN_PORT=4000
```

Then start the stack and check it:

```bash
docker compose up -d
curl https://proxy.example.com/health
```

A healthy stack answers `{"status":"healthy","version":"…"}`.

For the full walkthrough, see
[Docker Compose deployment](docs/deployment/compose.md).

## Quickstart: Bun and systemd

The native path for a single Linux VM. The proxy runs under systemd bound to
loopback, with Caddy on the host in front of it.

Install the two prerequisites:

```bash
# unzip first — a clean Ubuntu image has no unzip, and without it the Bun
# installer aborts with "error: unzip is required to install bun"
sudo apt update && sudo apt install -y unzip

# The pinned Bun release
curl -fsSL https://bun.com/install | bash -s "bun-v1.3.14"

# Caddy, from its official repository
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Then follow [Native systemd deployment](docs/deployment/systemd.md), which
covers the release layout, the service user, the hardened unit, and the Caddy
template as a checklist. Verify the same way:

```bash
curl https://proxy.example.com/health
```

## Configuration

Every setting is an environment variable, read once at startup. An invalid or
retired value aborts the process rather than being ignored, so a bad edit fails
loudly at restart instead of quietly changing behavior later.

You must decide on the following variables:

| Variable          | What it controls                                                                                | Default  |
| ----------------- | ----------------------------------------------------------------------------------------------- | -------- |
| `TN_HOST`         | Default upstream MUD host. Set this value, because the built-in default is a third-party server | None     |
| `TN_PORT`         | Default upstream MUD port                                                                       | `5010`   |
| `TARGET_MODE`     | Which targets a client may name: `fixed`, `allowlist`, or `arbitrary`                           | `fixed`  |
| `MUD_TLS_MODE`    | Upstream TLS: `plain`, `prefer`, or `required`                                                  | `prefer` |
| `AUTH_MODE`       | `none` or `shared-secret`. Must be set for `TARGET_MODE=arbitrary`                              | `none`   |
| `ALLOWED_ORIGINS` | Exact browser origins permitted. Unset applies no restriction                                   | unset    |

Every remaining variable—trusted proxies, session and rate limits,
diagnostics, and the optional Apple features—is in the
[Configuration reference](docs/configuration.md), which CI keeps in step with
the source. The [`.env.example`](.env.example) file carries the same settings
as commented, copyable defaults.

## Documentation

| Document                                                | Covers                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Security model](docs/security.md)                      | Threat model, target policy, trust boundaries, and known limitations       |
| [Operations](docs/operations.md)                        | Health, logs, certificate renewal, upgrades, backup, and troubleshooting   |
| [Configuration reference](docs/configuration.md)        | Every variable, its type, default, and when it is required                 |
| [Client protocols](docs/protocols.md)                   | The wire contract for both protocols, for client authors                   |
| [App Attest and push](docs/app-attest-and-push.md)      | The optional Apple features: what they send, what they store, how to purge |
| [Docker Compose deployment](docs/deployment/compose.md) | The container path in full                                                 |
| [Native systemd deployment](docs/deployment/systemd.md) | The single-VM path in full                                                 |
| [Published images](docs/deployment/images.md)           | Tag policy, digest pinning, and provenance verification                    |

Every startup error the proxy can refuse to start with has a troubleshooting
entry in the operations guide, and a CI gate keeps that true.

The following documents cover reporting and contributing:

| Document                        | Covers                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------- |
| [Security policy](SECURITY.md)  | How to report a vulnerability privately, response windows, and scope          |
| [Support](SUPPORT.md)           | Where questions, bugs, and security findings each go, and what is unsupported |
| [Contributing](CONTRIBUTING.md) | Development setup, the checks to run, conventions, and licensing              |
| [Changelog](CHANGELOG.md)       | What changed in each release, including every retired configuration variable  |

## Project lineage

This project is a fork of
[MUDPortal-Web-App](https://github.com/plamzi/MUDPortal-Web-App) by
[@plamzi](https://github.com/plamzi), creator of
[MUDPortal](http://www.mudportal.com/), which contained both a browser
client and a proxy and did not support secure connections. It was forked in
2020 to separate the two and add `wss://` support. The browser client lives
separately as
[`mud-web-client`](https://github.com/maldorne/mud-web-client).

The [`NOTICE`](NOTICE) file carries the upstream authorship and the
attribution that MIT-derived portions require.

## License

This project is licensed under [GPL-3.0-or-later](LICENSE).
