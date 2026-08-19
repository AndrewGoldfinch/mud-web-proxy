# Docker Compose deployment

Docker Compose is the portable, container-first way to run mud-web-proxy.
Caddy terminates HTTPS and WSS, and one Bun process runs behind it on an
internal network.

## Which path should you use?

If you are running a single Linux VM, including the project's own
DigitalOcean Droplet, use [Native systemd deployment](systemd.md) instead. It
is the recommended default: fewer moving parts, no container runtime to
keep patched, and atomic release activation with offline rollback.

Compose is the right choice when you want the container ecosystem: an
immutable published image, a host whose packages you don't manage, or a
platform that already runs Compose.

Both paths share the same architecture—Caddy in front, one Bun process
behind, plaintext only on the internal hop—so the boundary is the same.
Only the packaging differs.

One default doesn't match, and it is worth knowing before you go public:
the systemd environment example sets `ALLOWED_ORIGINS` and the documented
render fills in your hostname, while `.env.compose.example` ships it
commented out. An unedited Compose stack therefore accepts _any_ Origin, and reports so at
startup:

```
WARN [init] ALLOWED_ORIGINS is not set: connections from any Origin are
accepted. Set it for internet-facing deployments.
```

Origin is browser hardening rather than authentication, because a native
client can send any value, so this default is not a hole on its own. Set it
anyway if browsers are your clients. See [Configuration](#configuration).

## Requirements

- Docker Engine with the Compose plugin (v2).
- A DNS name resolving to the host, before first start.
- Inbound TCP 80 and 443 reachable from the internet.

Port 80 is not optional. Caddy uses the HTTP-01 challenge, so closing 80
after issuance breaks _renewal_, not only the initial certificate.

A clean Ubuntu image has neither Docker nor the Compose plugin, and the
distribution's `docker.io` package doesn't include Compose v2. Install from
Docker's own repository, following the
[Docker Engine installation instructions](https://docs.docker.com/engine/install/),
then confirm that both halves are present. A failing `docker compose version`
alongside a succeeding `docker --version` is the usual symptom of installing
the engine alone:

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
because `MWP_IMAGE` is unset by default, the stack _builds that working tree
from source_ rather than pulling a published image. An operator who skips this
step runs unreleased code without being told. Setting `MWP_IMAGE` to a
published digest, as [Published container images](images.md) describes, is the
better answer for anything you intend to keep running. See
[Upgrade the stack](#upgrade-the-stack).

The example ships with its required values empty, and the `compose.yaml` file
declares them as `${VAR:?...}`, so an unedited copy fails immediately with a named
error rather than starting on placeholder configuration:

```
error while interpolating services.caddy.environment.MWP_DOMAIN:
required variable MWP_DOMAIN is missing a value: set MWP_DOMAIN in .env
```

That is the intended behavior, not a fault.

## Configuration

Two kinds of setting live in the `.env` file, distinguished by name:

- **`MWP_*`**: Compose and Caddy concerns.
- **Everything else**: proxy configuration, under the exact names in the
  [Configuration reference](../configuration.md).

The `proxy` service loads the `.env` file directly, so _any_ variable from that
reference works without being added to `compose.yaml` first. That behavior is
deliberate: enumerating a subset here would silently gate which of the roughly
58 documented variables are usable, and it would drift out of step the moment
either side changed.

| Variable         | Required | Purpose                                              |
| ---------------- | -------- | ---------------------------------------------------- |
| `MWP_DOMAIN`     | yes      | Public hostname; the certificate is issued for it    |
| `MWP_ACME_EMAIL` | yes      | Let's Encrypt account contact, for expiry warnings   |
| `TN_HOST`        | yes      | The MUD to front, under the default `TARGET_MODE`    |
| `TN_PORT`        | no       | The example ships `5010`; unset falls back to `4000` |
| `MWP_IMAGE`      | no       | Published image; unset builds from source            |

`TN_HOST` is required rather than defaulted, because the proxy's built-in
default is a real third-party server, `muds.maldorne.org`. Leaving it unset
would start a proxy quietly fronting someone else's MUD, so `compose.yaml`
guards it and fails instead.

### Settings you can't override

`compose.yaml` sets `BIND_HOST`, `INBOUND_TLS_MODE`,
`ALLOW_INSECURE_INBOUND_NO_TLS`, and `TRUSTED_PROXY_CIDRS` in its
`environment:` block, which takes precedence over `.env`. Putting them in the
`.env` file has no effect, by design. Widening `TRUSTED_PROXY_CIDRS` to
`0.0.0.0/0`, for instance, would make forwarded-header spoofing trivial, and
the topology contract must not be editable by accident.

### Choose a target mode

`TARGET_MODE` defaults to `fixed`, which restricts every client to
`TN_HOST:TN_PORT`. The other modes each have mandatory companions, and the
proxy refuses to start without them rather than falling back to something
permissive:

| Mode        | Also required                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixed`     | Nothing                                                                                                                                                                                         |
| `allowlist` | `ALLOWED_TARGETS`, with at least one valid `host:port` entry                                                                                                                                    |
| `arbitrary` | `ARBITRARY_ALLOWED_PORTS`, and either `AUTH_MODE=shared-secret` with a `PROXY_SHARED_SECRET` of 32 bytes or more, or `REQUIRE_APP_AUTH=true` with `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID` |

`arbitrary` lets the client name any host, so the authentication requirement
is what keeps it from being an open relay. All of these settings are ordinary
`.env` entries. For a commented template, see the `.env.compose.example` file.

### The internal plaintext hop

The proxy runs with this exact trio, set in `compose.yaml`:

```
BIND_HOST=0.0.0.0
INBOUND_TLS_MODE=off
ALLOW_INSECURE_INBOUND_NO_TLS=true
```

All three are mandatory, and none of them weakens the image's defaults. The
image deliberately leaves topology unset; here the proxy listens on a
non-loopback container interface, and the runtime refuses
`INBOUND_TLS_MODE=off` on a non-loopback bind unless the operator
acknowledges it explicitly. Omitting the acknowledgment fails startup
rather than quietly serving plaintext.

The hop is plaintext only inside the Compose network. Nothing reaches the
proxy from the host: `compose.yaml` publishes 80 and 443 from Caddy and
gives the proxy no `ports:` block at all.

**Caution:** `off` must stay quoted in YAML. YAML 1.1 parses a bare `off` as
boolean false, which arrives at the proxy as the string `false` and fails
validation with a confusing message.

### Client IP attribution

The Caddyfile _replaces_ `X-Forwarded-For` and `X-Real-IP` with the real peer
address rather than appending to whatever the client sent. Caddy's default is
to append, which would let a client prepend a forged address, and because the
proxy trusts this hop through `TRUSTED_PROXY_CIDRS`, it would accept the
forgery. Per-IP connection limits and every address-keyed log line depend on
this replacement.

`TRUSTED_PROXY_CIDRS` is scoped to the stack's own `172.28.0.0/24` subnet,
not the whole `172.16.0.0/12` private range. The subnet is pinned in the
`compose.yaml` file for exactly that reason. Letting Docker allocate from its
pool would force you to widen the trusted range to cover whatever Docker chose.

## App Attest state

App Attest is optional, and off unless configured. When you enable it, the
writable state volume mounts at the _directory_:

```
/var/lib/mud-web-proxy
```

Never mount at `/var/lib/mud-web-proxy/attested-keys.json`. Persistence writes
a sibling staging file and renames it into place, so a file-only mount makes
every write fail. The failure happens at write time, not at start, so the
stack looks healthy until the first registration is lost.

A volume mounted over that path stays writable despite `read_only: true` on
the service.

To enable it, layer the override:

```bash
docker compose -f compose.yaml -f compose.appattest.yaml up -d
```

The base stack deliberately mounts nothing: with App Attest off the proxy
needs no writable state, and it runs with a read-only root.

**Use the named volume, not a bind mount.** The image creates
`/var/lib/mud-web-proxy` owned by `10001:10001`, and Docker seeds an empty
named volume from the image path it covers, ownership included. A bind mount
doesn't: the host directory arrives root-owned, and the non-root process can't
write to it.

## Volumes

| Volume          | Holds                                 | If deleted                                                                              | Back up?                            |
| --------------- | ------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| `caddy_data`    | Certificates, ACME account key        | Certificates are re-requested on next start, counting against Let's Encrypt rate limits | **Yes**                             |
| `caddy_config`  | Caddy's autosaved config              | Regenerated from the Caddyfile                                                          | No                                  |
| `attested_keys` | App Attest registrations and counters | Every registered client fails with `Unknown key` and can't re-register automatically    | **Yes**, when App Attest is enabled |

`caddy_data` is the one whose loss is silently expensive: nothing breaks
immediately, but repeated recreates can exhaust the issuance rate limit and
leave the stack unable to obtain a certificate for hours.

Both tmpfs mounts (`/tmp`) hold nothing durable and need no backup.

## Health, restarts, and logs

Both services declare a health check, `restart: unless-stopped`, and bounded
logging.

**Logs are capped at 10 MB across 5 files per service.** The default
`json-file` driver keeps everything forever, and filling the host disk with
logs is the most common way a small self-hosted deployment fails. It happens
months after anyone last touched the stack.

**The proxy probe uses `bun`, not `curl` or `wget`.** Neither of those is
present in the runtime image, but `bun` is the entrypoint. It polls `/health` over
plain HTTP, because this topology selects `INBOUND_TLS_MODE=off`.

**A draining proxy reports unhealthy, and that is correct.** During graceful
shutdown, `/health` answers `503 {"status":"draining"}`, because it is
genuinely not ready to serve. It doesn't cause a restart loop: Compose's
`restart` policy responds to the container _exiting_, not to health status. The
timings settle it anyway: three 30-second failures take 90 seconds to mark the
service unhealthy, and `SHUTDOWN_DEADLINE_MS` bounds shutdown at 15 seconds, so
the process is gone first.

The stack uses `restart: unless-stopped` rather than `always`, so a stack you
deliberately stopped stays stopped across a daemon restart.

## Operations

```bash
docker compose ps                 # service state
docker compose logs -f proxy      # proxy logs
docker compose logs -f caddy      # TLS issuance and renewal
curl -s https://$MWP_DOMAIN/health
```

Certificates and ACME account keys live in the `caddy_data` volume. Don't
prune it casually: losing it forces re-issuance on next start, which counts
against Let's Encrypt rate limits.

### Upgrade the stack

```bash
docker compose pull               # when MWP_IMAGE is set
docker compose up -d --build      # when building from source
```

All in-memory sessions drop on restart. Session and resume state are
process-local, so schedule upgrades accordingly.

### Verify the boundary

The proxy must not be reachable from the host:

```bash
ss -ltn | grep 6200               # must print nothing
```

Confirm the published set is only what you expect:

```bash
docker compose ps --format 'table {{.Service}}\t{{.Ports}}'
```
