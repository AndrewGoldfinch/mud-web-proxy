# Docker Compose deployment

The portable, container-first way to run mud-web-proxy. Caddy terminates
HTTPS/WSS and one Bun process runs behind it on an internal network.

## Which path should you use?

**If you are running a single Linux VM — including the project's own
DigitalOcean Droplet — use [the native systemd path](systemd.md) instead.**
It is the recommended default: fewer moving parts, no container runtime to
keep patched, and atomic release activation with offline rollback.

Compose is the right choice when you want the container ecosystem: an
immutable published image, a host you do not manage packages on, or a
platform that already speaks Compose.

Both paths share the same architecture — Caddy in front, one Bun process
behind, plaintext only on the internal hop — so the security properties are
equivalent. Only the packaging differs.

## Scope and implementation status

This document covers the topology delivered by MWP-100: the two services,
the network boundary, and the environment contract.

Health checks, restart policy, log bounds, and the App Attest state volume
are **not** configured yet; they belong to MWP-101. The mount point that
work must use is reserved and commented in `compose.yaml` — see
[App Attest state](#app-attest-state) below.

## Requirements

- Docker Engine with the Compose plugin (v2).
- A DNS name resolving to the host, before first start.
- Inbound TCP 80 and 443 reachable from the internet.

Port 80 is not optional. Caddy uses the HTTP-01 challenge, so closing 80
after issuance breaks **renewal**, not just the initial certificate.

## Quickstart

```bash
cp .env.compose.example .env
$EDITOR .env          # fill in the required values
docker compose up -d
```

The example ships with its required values empty and `compose.yaml` declares
them as `${VAR:?...}`, so an unedited copy fails immediately with a named
error rather than starting on placeholder configuration:

```
error while interpolating services.caddy.environment.MWP_DOMAIN:
required variable MWP_DOMAIN is missing a value: set MWP_DOMAIN in .env
```

That is the intended behaviour, not a fault.

## Configuration

Only the deployment-shaped values live in `.env`. Everything else the proxy
understands is documented in [configuration.md](../configuration.md) and can
be added to the `proxy` service's `environment:` block.

| Variable          | Required | Purpose                                            |
| ----------------- | -------- | -------------------------------------------------- |
| `MWP_DOMAIN`      | yes      | Public hostname; the certificate is issued for it  |
| `MWP_ACME_EMAIL`  | yes      | Let's Encrypt account contact, for expiry warnings |
| `MWP_TN_HOST`     | yes      | The MUD to front, under the default `TARGET_MODE`  |
| `MWP_TN_PORT`     | no       | Defaults to `4000`                                 |
| `MWP_TARGET_MODE` | no       | Defaults to `fixed`                                |
| `MWP_IMAGE`       | no       | Published image; unset builds from source          |

### The internal plaintext hop

The proxy runs with this exact trio, set in `compose.yaml`:

```
BIND_HOST=0.0.0.0
INBOUND_TLS_MODE=off
ALLOW_INSECURE_INBOUND_NO_TLS=true
```

All three are mandatory and none of them weakens the image's defaults. The
image deliberately leaves topology unset; here the proxy listens on a
non-loopback container interface, and the runtime refuses
`INBOUND_TLS_MODE=off` on a non-loopback bind unless the operator
acknowledges it explicitly. Omitting the acknowledgement fails startup
rather than quietly serving plaintext.

The hop is plaintext only inside the Compose network. Nothing reaches the
proxy from the host: `compose.yaml` publishes 80 and 443 from Caddy and
gives the proxy no `ports:` block at all.

> **`off` must stay quoted in YAML.** A bare `off` is parsed as boolean
> false under YAML 1.1 and arrives at the proxy as the string `false`, which
> fails validation with a confusing message.

### Client IP attribution

The Caddyfile **replaces** `X-Forwarded-For` and `X-Real-IP` with the real
peer address rather than appending to whatever the client sent. Caddy's
default is to append, which would let a client prepend a forged address —
and because the proxy trusts this hop via `TRUSTED_PROXY_CIDRS`, it would
believe the forgery. Per-IP connection limits and every address-keyed log
line depend on this replacement.

`TRUSTED_PROXY_CIDRS` is scoped to the stack's own `172.28.0.0/24` subnet,
not the whole `172.16.0.0/12` private range. The subnet is pinned in
`compose.yaml` for exactly that reason; letting Docker allocate from its
pool would force the trusted range to be widened to cover whatever it chose.

## App Attest state

App Attest is optional and off unless configured. When you enable it, the
writable state volume mounts at the **directory**:

```
/var/lib/mud-web-proxy
```

Never at `/var/lib/mud-web-proxy/attested-keys.json`. Persistence writes a
sibling staging file and renames it into place, so a file-only mount makes
every write fail — and it fails at write time, not at start, so it looks
healthy until the first registration is lost.

A volume mounted over that path stays writable despite `read_only: true` on
the service. The volume itself, and making it writable by UID/GID
`10001:10001`, are MWP-101's work; `compose.yaml` reserves the target in a
comment and configures nothing.

## Operations

```bash
docker compose ps                 # service state
docker compose logs -f proxy      # proxy logs
docker compose logs -f caddy      # TLS issuance and renewal
curl -s https://$MWP_DOMAIN/health
```

Certificates and ACME account keys live in the `caddy_data` volume. Do not
prune it casually: losing it forces re-issuance on next start, which counts
against Let's Encrypt rate limits.

### Upgrading

```bash
docker compose pull               # when MWP_IMAGE is set
docker compose up -d --build      # when building from source
```

All in-memory sessions drop on restart. Session and resume state are
process-local, so schedule upgrades accordingly.

### Verifying the boundary

The proxy must not be reachable from the host:

```bash
ss -ltn | grep 6200               # must print nothing
```

Confirm the published set is only what you expect:

```bash
docker compose ps --format 'table {{.Service}}\t{{.Ports}}'
```
