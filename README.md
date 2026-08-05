# mud-web-proxy

A WebSocket-to-Telnet proxy that lets a browser reach a telnet MUD, MUSH, or
MOO server over `wss://`. Browsers refuse plaintext `ws://` from an `https://`
page, so a web MUD client needs something like this in front of the game
server. It speaks the protocols MUD clients expect — GMCP/ATCP, MSDP, MXP,
MCCP compression, NAWS, UTF-8 negotiation, 256 colour — and passes them through
in both directions.

It is a **single process, single replica** service. There is no clustering and
no shared state between instances.

## What this does on your behalf

Read this before the install commands. Three properties decide whether this is
safe to run in your environment.

**It opens outbound TCP connections for remote clients.** That is the entire
product, and `TARGET_MODE` is the only thing deciding where those connections
go. The default, `fixed`, permits exactly one configured target. Widening it to
`arbitrary` lets clients choose the destination — so `arbitrary` refuses to
start without both an allowed-port list and enforced authentication. Understand
[target policy](docs/security.md#target-policy) before changing it.

**Sessions live in memory and every restart drops them.** No persistence, no
handover. Restarts, upgrades, and rollbacks all disconnect every connected
player, and clients reconnect from scratch. Plan maintenance windows
accordingly.

**The browser hop and the game hop are independent.** `wss://` between browser
and proxy says nothing about the link between proxy and MUD, which is usually
plaintext because most MUDs offer nothing else. `MUD_TLS_MODE=prefer` (the
default) attempts TLS and falls back — including when the MUD's certificate
fails validation, which is the common case, since few MUDs have a publicly
trusted certificate. `required` refuses to fall back, at the cost of only
working against certificates your runtime already trusts.

The full treatment, including the threat model and what is explicitly _not_
protected, is in [the security model](docs/security.md).

## Requirements

- A domain name pointing at the host.
- Inbound TCP **80 and 443**. Port 80 is needed for certificate issuance and
  renewal even though traffic runs on 443 — a firewall allowing only 443 is the
  most common cause of a silent renewal failure.
- Docker with Compose, **or** Bun `1.3.14` (the version pinned in
  [`.bun-version`](.bun-version)) for the native path.

Both quickstarts put [Caddy](https://caddyserver.com/) in front to terminate
HTTPS/WSS and obtain certificates automatically.

## Quickstart: Docker Compose

The portable path. Caddy and the proxy run as two containers; only 80 and 443
are published.

```bash
git clone https://github.com/AndrewGoldfinch/mud-web-proxy
cd mud-web-proxy
cp .env.compose.example .env
```

Set four values in `.env`:

```dotenv
MWP_DOMAIN=proxy.example.com      # the domain pointing at this host
MWP_ACME_EMAIL=you@example.com    # for Let's Encrypt expiry notices
TN_HOST=mud.example.com           # the MUD to connect to
TN_PORT=4000
```

Then bring it up and check it:

```bash
docker compose up -d
curl https://proxy.example.com/health
```

A healthy stack answers `{"status":"healthy","version":"…"}`. Those values ship
empty on purpose: an unedited copy fails immediately with a named error rather
than starting on placeholder configuration.

Full walkthrough: [Docker Compose deployment](docs/deployment/compose.md).

## Quickstart: Bun + systemd

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

Then follow [native systemd deployment](docs/deployment/systemd.md), which
covers the release layout, the service user, the hardened unit, and the Caddy
template as a checklist. Verify the same way:

```bash
curl https://proxy.example.com/health
```

## Configuration

Every setting is an environment variable, read once at startup. An invalid or
retired value aborts the process rather than being ignored, so a bad edit fails
loudly at restart instead of quietly changing behaviour later.

The variables an operator has to decide on:

| Variable          | What it controls                                                                   | Default  |
| ----------------- | ---------------------------------------------------------------------------------- | -------- |
| `TN_HOST`         | Default upstream MUD host. Set this — the built-in default is a third-party server | —        |
| `TN_PORT`         | Default upstream MUD port                                                          | `5010`   |
| `TARGET_MODE`     | Which targets a client may name: `fixed`, `allowlist`, or `arbitrary`              | `fixed`  |
| `MUD_TLS_MODE`    | Upstream TLS: `plain`, `prefer`, or `required`                                     | `prefer` |
| `AUTH_MODE`       | `none` or `shared-secret`. Must be set for `TARGET_MODE=arbitrary`                 | `none`   |
| `ALLOWED_ORIGINS` | Exact browser origins permitted. Unset applies no restriction                      | unset    |

Every remaining variable — trusted proxies, session and rate limits,
diagnostics, the optional Apple features — is in the
[configuration reference](docs/configuration.md), which CI keeps in step with
the source. [`.env.example`](.env.example) carries the same settings as
commented, copyable defaults.

## Documentation

| Document                                                | Covers                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Security model](docs/security.md)                      | Threat model, target policy, trust boundaries, and known limitations     |
| [Operations](docs/operations.md)                        | Health, logs, certificate renewal, upgrades, backup, and troubleshooting |
| [Configuration reference](docs/configuration.md)        | Every variable, its type, default, and when it is required               |
| [Client protocols](docs/protocols.md)                   | The wire contract for both protocols, for client authors                 |
| [Docker Compose deployment](docs/deployment/compose.md) | The container path in full                                               |
| [Native systemd deployment](docs/deployment/systemd.md) | The single-VM path in full                                               |
| [Published images](docs/deployment/images.md)           | Tag policy, digest pinning, and provenance verification                  |

Every startup error the proxy can refuse to start with has a troubleshooting
entry in the operations guide, and a CI gate keeps that true.

For reporting and contributing:

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
[mudportal.com](http://www.mudportal.com/), which contained both a browser
client and a proxy and did not support secure connections. It was forked in
2020 to separate the two and add `wss://` support. The browser client lives
separately as
[`mud-web-client`](https://github.com/maldorne/mud-web-client).

[`NOTICE`](NOTICE) carries the upstream authorship and the attribution required
for MIT-derived portions.

## License

[GPL-3.0-or-later](LICENSE).
