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
behind, plaintext only on the internal hop — so the boundary is the same.
Only the packaging differs.

One default does not match, and it is worth knowing before you go public:
the systemd environment example sets `ALLOWED_ORIGINS` and the documented
render fills in your hostname, while `.env.compose.example` ships it
commented out. A Compose stack brought up unedited therefore accepts **any**
Origin, and says so at startup:

```
WARN [init] ALLOWED_ORIGINS is not set: connections from any Origin are
accepted. Set it for internet-facing deployments.
```

Origin is browser hardening rather than authentication — a native client
sends whatever it likes — so this is not a hole on its own. Set it anyway if
browsers are your clients; see [Configuration](#configuration).

## Requirements

- Docker Engine with the Compose plugin (v2).
- A DNS name resolving to the host, before first start.
- Inbound TCP 80 and 443 reachable from the internet.

Port 80 is not optional. Caddy uses the HTTP-01 challenge, so closing 80
after issuance breaks **renewal**, not just the initial certificate.

A clean Ubuntu image has neither Docker nor the Compose plugin, and the
distribution's `docker.io` package does not include Compose v2. Install from
Docker's own repository, following
[their instructions](https://docs.docker.com/engine/install/), then confirm
both halves are present — `docker compose version` failing while
`docker --version` succeeds is the usual symptom of installing the engine
alone:

```bash
docker --version
docker compose version
```

## Quickstart

```bash
git clone https://github.com/AndrewGoldfinch/mud-web-proxy
cd mud-web-proxy
git checkout v4.0.0            # omit to track main, which is unreleased
cp .env.compose.example .env
$EDITOR .env                   # fill in the required values
docker compose up -d
```

**Check out a release tag.** Cloning without one leaves you on `main`, and
because `MWP_IMAGE` is unset by default the stack _builds that working tree
from source_ rather than pulling a published image — so an operator who
skipped this step is running unreleased code without being told. Setting
`MWP_IMAGE` to a published digest, as
[images.md](images.md) describes, is the better answer for anything you
intend to keep running; see [Upgrading](#upgrading).

The example ships with its required values empty and `compose.yaml` declares
them as `${VAR:?...}`, so an unedited copy fails immediately with a named
error rather than starting on placeholder configuration:

```
error while interpolating services.caddy.environment.MWP_DOMAIN:
required variable MWP_DOMAIN is missing a value: set MWP_DOMAIN in .env
```

That is the intended behaviour, not a fault.

## Configuration

Two kinds of setting live in `.env`, distinguished by name:

- **`MWP_*`** — compose and Caddy concerns.
- **Everything else** — proxy configuration, under the exact names in
  [configuration.md](../configuration.md).

The `proxy` service loads `.env` directly, so **any** variable from that
reference works without being added to `compose.yaml` first. That is
deliberate: enumerating a subset here would silently gate which of the ~58
documented variables are usable, and drift out of step the moment either
side changed.

| Variable         | Required | Purpose                                              |
| ---------------- | -------- | ---------------------------------------------------- |
| `MWP_DOMAIN`     | yes      | Public hostname; the certificate is issued for it    |
| `MWP_ACME_EMAIL` | yes      | Let's Encrypt account contact, for expiry warnings   |
| `TN_HOST`        | yes      | The MUD to front, under the default `TARGET_MODE`    |
| `TN_PORT`        | no       | The example ships `5010`; unset falls back to `4000` |
| `MWP_IMAGE`      | no       | Published image; unset builds from source            |

`TN_HOST` is required rather than defaulted because the proxy's built-in
default is a real third-party server (`muds.maldorne.org`). Leaving it
unset would start a proxy quietly fronting someone else's MUD, so
`compose.yaml` guards it and fails instead.

### Settings you cannot override

`compose.yaml` sets `BIND_HOST`, `INBOUND_TLS_MODE`,
`ALLOW_INSECURE_INBOUND_NO_TLS`, and `TRUSTED_PROXY_CIDRS` in its
`environment:` block, which takes precedence over `.env`. Putting them in
`.env` has no effect — by design. Widening `TRUSTED_PROXY_CIDRS` to
`0.0.0.0/0`, for instance, would make forwarded-header spoofing trivial,
and the topology contract should not be editable by accident.

### Choosing a target mode

`TARGET_MODE` defaults to `fixed`, which restricts every client to
`TN_HOST:TN_PORT`. The other modes each have mandatory companions, and the
proxy **refuses to start** without them rather than falling back to
something permissive:

| Mode        | Also required                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixed`     | nothing                                                                                                                                                                                  |
| `allowlist` | `ALLOWED_TARGETS` — at least one valid `host:port`                                                                                                                                       |
| `arbitrary` | `ARBITRARY_ALLOWED_PORTS`, **and** either `AUTH_MODE=shared-secret` with a ≥32-byte `PROXY_SHARED_SECRET`, or `REQUIRE_APP_AUTH=true` with `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID` |

`arbitrary` lets the client name any host, so the authentication
requirement is what keeps it from being an open relay. All of these are
ordinary `.env` entries; see `.env.compose.example` for a commented
template.

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
the service.

Enable it by layering the override:

```bash
docker compose -f compose.yaml -f compose.appattest.yaml up -d
```

The base stack deliberately mounts nothing: with App Attest off the proxy
needs no writable state, and it runs with a read-only root.

**Use the named volume, not a bind mount.** The image creates
`/var/lib/mud-web-proxy` owned by `10001:10001`, and Docker seeds an empty
named volume from the image path it covers — including ownership. A bind
mount does not: the host directory arrives root-owned, and the non-root
process cannot write it.

## Volumes

| Volume          | Holds                                 | If deleted                                                                                | Back up?                            |
| --------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| `caddy_data`    | Certificates, ACME account key        | Certificates are re-requested on next start, counting against Let's Encrypt rate limits   | **Yes**                             |
| `caddy_config`  | Caddy's autosaved config              | Regenerated from the Caddyfile                                                            | No                                  |
| `attested_keys` | App Attest registrations and counters | **Every registered client fails with `Unknown key`** and cannot re-register automatically | **Yes**, when App Attest is enabled |

`caddy_data` is the one whose loss is silently expensive: nothing breaks
immediately, but repeated recreates can exhaust the issuance rate limit and
leave the stack unable to obtain a certificate for hours.

Both tmpfs mounts (`/tmp`) hold nothing durable and need no backup.

## Health, restarts, and logs

Both services declare a health check, `restart: unless-stopped`, and bounded
logging.

**Logs are capped at 10 MB × 5 files per service.** The default `json-file`
driver keeps everything forever; filling the host disk with logs is the most
common way a small self-hosted deployment dies, and it happens months after
anyone last touched the stack.

**The proxy probe uses `bun`, not `curl` or `wget`** — neither is guaranteed
in the runtime image, but bun is the entrypoint. It polls `/health` over
plain HTTP, because this topology selects `INBOUND_TLS_MODE=off`.

**A draining proxy reports unhealthy, and that is correct.** During graceful
shutdown `/health` answers `503 {"status":"draining"}` — it is genuinely not
ready to serve. It does not cause a restart loop: Compose's `restart` policy
responds to the container _exiting_, not to health status. The timings make
it moot anyway — three 30-second failures take 90 s to mark unhealthy, and
`SHUTDOWN_DEADLINE_MS` bounds shutdown at 15 s, so the process is gone first.

`restart: unless-stopped` rather than `always`, so a stack you deliberately
stopped stays stopped across a daemon restart.

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
