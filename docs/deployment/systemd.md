# Native systemd deployment

## Scope and implementation status

This is MWP-104's normative layout and operations contract for a native host.
It defines the public contract; it does not provide the unit or release
bundle. MWP-105 supplies the systemd/Caddy files and MWP-103 supplies the
release bundle.

## Supported host

The only supported host is Ubuntu 26.04 LTS x64, using DigitalOcean image
`ubuntu-26-04-x64`. The old host release is irrelevant: this is a new-host
cutover, not an in-place conversion. See the [Ubuntu 26.04 release
notes](https://documentation.ubuntu.com/release-notes/26.04/) and
[DigitalOcean Droplets updates](https://docs.digitalocean.com/products/droplets/#latest-updates).

## Filesystem layout

```text
/opt/mud-web-proxy/
├── current -> releases/$RELEASE_VERSION
├── releases/
│   └── $RELEASE_VERSION/
│       ├── .bun-version
│       ├── VERSION
│       ├── config/apple-app-attest-root-ca.pem
│       ├── dist/wsproxy.js
│       ├── node_modules/
│       ├── package.json
│       ├── bun.lock
│       └── runtime -> ../../runtimes/bun/$BUN_VERSION
└── runtimes/bun/$BUN_VERSION/bin/bun
/etc/mud-web-proxy.env
/etc/mud-web-proxy/
/var/lib/mud-web-proxy/attested-keys.json
```

## Ownership, modes, and static service identity

| Path                      | Owner                         | Mode                              | Contract                                                        |
| ------------------------- | ----------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `/opt/mud-web-proxy`      | `root:root`                   | `0755`                            | Service user can traverse but not modify.                       |
| `releases/`               | `root:root`                   | `0755`                            | Contains immutable verified releases.                           |
| `releases/<version>/`     | `root:root`                   | `0755`                            | No file is modified after activation.                           |
| Release files             | `root:root`                   | `0644` unless executable          | Bundle and installed dependencies are read-only to the service. |
| `current`                 | `root:root`                   | symlink                           | Replaced atomically; never edited in place.                     |
| `runtimes/bun/<version>/` | `root:root`                   | directories `0755`, binary `0755` | Versioned and immutable.                                        |
| `/etc/mud-web-proxy.env`  | `root:mud-web-proxy`          | `0640`                            | Configuration and secrets; not world-readable.                  |
| `/etc/mud-web-proxy/`     | `root:mud-web-proxy`          | `0750`                            | Read-only secret files referenced by the environment.           |
| APNS private key          | `root:mud-web-proxy`          | `0640`                            | Present only when APNS is enabled.                              |
| `/var/lib/mud-web-proxy/` | `mud-web-proxy:mud-web-proxy` | `0700`                            | Created by systemd `StateDirectory`.                            |
| `attested-keys.json`      | `mud-web-proxy:mud-web-proxy` | `0600`                            | Durable App Attest registrations and counters.                  |

```text
/etc/mud-web-proxy.env: 0640 root:mud-web-proxy
/var/lib/mud-web-proxy: 0700 mud-web-proxy:mud-web-proxy
/var/lib/mud-web-proxy/attested-keys.json: 0600 mud-web-proxy:mud-web-proxy
```

MWP-105 requires:

```text
StateDirectory=mud-web-proxy
StateDirectoryMode=0700
UMask=0077
DynamicUser=no
```

`DynamicUser=yes is forbidden`. It relocates state under `/var/lib/private`,
uses a transient UID/GID, and conflicts with pre-seeded
`mud-web-proxy:mud-web-proxy` state. systemd recursively corrects state owner
and mode on service start, so the installer must create the directory correctly
before first start; otherwise verification only observes systemd's repair.

## Versioned Bun runtime

For each release, read `$RELEASE_DIR/.bun-version`; require an exact `x.y.z`;
require equality with `package.json#engines.bun`; download that exact official
release asset; verify its published SHA-256; install it under
`/opt/mud-web-proxy/runtimes/bun/$BUN_VERSION`; and require
`/opt/mud-web-proxy/runtimes/bun/$BUN_VERSION/bin/bun --version` to print
`$BUN_VERSION`. The initial pinned version is Bun 1.3.14.

Bun's global package-download cache is disposable installer state, not
immutable release content, backup data, or a rollback dependency.

## Native environment

The native environment must begin with this boundary:

```text
BIND_HOST=127.0.0.1
WS_PORT=6200
INBOUND_TLS_MODE=off
TARGET_MODE=fixed
ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
```

`ALLOW_INSECURE_INBOUND_NO_TLS`, `TLS_CERT_PATH`, and `TLS_KEY_PATH` must be
absent. The acknowledgement is required only off loopback. Caddy, not the
application, owns inbound TLS. Add production target, authentication, origin,
trusted-proxy, App Attest, APNS, resource-limit, and shutdown settings using
the [configuration reference](../configuration.md); do not blindly copy the
old environment.

## Installing a release

Verify archive checksum and provenance before extraction. In the newly
extracted release, before making it immutable, install dependencies and create
the runtime link:

```bash
RELEASE_VERSION="$(cat VERSION)"
BUN_VERSION="$(cat .bun-version)"
BUN="/opt/mud-web-proxy/runtimes/bun/$BUN_VERSION/bin/bun"
"$BUN" install --frozen-lockfile --production
ln -s "../../runtimes/bun/$BUN_VERSION" runtime
```

Validate bundle, dependencies, runtime, ownership, and modes before
activation. Health, WSS, and mock-MUD validation follow activation and gate
acceptance.

## Atomic activation

Set `RELEASE_VERSION` from the already verified extracted directory. Its
`VERSION` equality check must succeed before changing the symlink. Record the
previous target and use one same-filesystem symlink rename:

```bash
INSTALL_ROOT=/opt/mud-web-proxy
: "${RELEASE_VERSION:?set RELEASE_VERSION to the verified release identifier}"
RELEASE_DIR="$INSTALL_ROOT/releases/$RELEASE_VERSION"
test "$(cat "$RELEASE_DIR/VERSION")" = "$RELEASE_VERSION"
PREVIOUS_TARGET=
if [[ -L "$INSTALL_ROOT/current" ]]; then
  PREVIOUS_TARGET="$(readlink "$INSTALL_ROOT/current")"
fi
sudo ln -s "releases/$RELEASE_VERSION" "$INSTALL_ROOT/.current.new"
sudo mv -Tf "$INSTALL_ROOT/.current.new" "$INSTALL_ROOT/current"
sudo systemctl restart mud-web-proxy
```

## Offline rollback

Rollback performs no download, dependency installation, or package-manager resolution.

Verify the recorded target, its `node_modules`, and its referenced runtime,
then atomically reverse the symlink and restart:

```bash
test -n "$PREVIOUS_TARGET"
test -d "/opt/mud-web-proxy/$PREVIOUS_TARGET/node_modules"
test -x "/opt/mud-web-proxy/$PREVIOUS_TARGET/runtime/bin/bun"
sudo ln -s "$PREVIOUS_TARGET" /opt/mud-web-proxy/.current.new
sudo mv -Tf /opt/mud-web-proxy/.current.new /opt/mud-web-proxy/current
sudo systemctl restart mud-web-proxy
```

Validate `/health`, WSS, and a mock-MUD session after rollback.

## Retention and pruning

Retain the active release and the two most recent verified previous releases,
plus every referenced Bun runtime and installed `node_modules`. Prune only
after acceptance; never prune a retained release or a runtime it references.

## Backup-required and disposable data

Back up encrypted, off-host `/etc/mud-web-proxy.env`, referenced APNS key
material, and App Attest state. Take a file-level backup before every upgrade
and at least daily, and test restoration on a non-production host.
DigitalOcean automated Droplet backups are an additional machine-recovery
layer, not a replacement. Immutable retained releases are needed only for
rollback.

Disposable data is the Git checkout, PM2 state, old Bun, Bun cache, private
TLS material, logs, `chat.json`, and in-memory state. Caddy reissues
certificates on the new host instead of transferring old TLS keys.

## DigitalOcean firewall, monitoring, and backups

Allow public TCP 80/443 and TCP 22 only from administrative sources; create no
public rule for 6200. Install the DigitalOcean metrics agent and alert on CPU,
memory, disk, and load. Enable automated Droplet backups plus separate
encrypted file backups. See [DigitalOcean firewall rules](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/),
[monitoring quickstart](https://docs.digitalocean.com/products/monitoring/getting-started/quickstart/),
and [backup guidance](https://docs.digitalocean.com/support/how-do-i-manually-back-up-my-droplet/).

## Verification

Run these commands as root:

```bash
readlink -f /opt/mud-web-proxy/current
find /opt/mud-web-proxy/releases -maxdepth 1 -mindepth 1 -type d -print
find /opt/mud-web-proxy/runtimes/bun -maxdepth 1 -mindepth 1 -type d -print
stat -c '%a %U:%G %n' /etc/mud-web-proxy.env
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy/attested-keys.json
/opt/mud-web-proxy/current/runtime/bin/bun --version
ss -ltnp | grep ':6200'
systemctl is-active mud-web-proxy caddy do-agent
```

Expect modes/owners `640 root:mud-web-proxy`, `700
mud-web-proxy:mud-web-proxy`, and `600 mud-web-proxy:mud-web-proxy`; the Bun
version must equal the release pin; and port 6200 must be loopback-only at
`127.0.0.1:6200`.

## Responsibilities of follow-up tickets

MWP-103 supplies verified release bundles. MWP-105 supplies the systemd unit,
static service account, and Caddy configuration implementing this contract.
