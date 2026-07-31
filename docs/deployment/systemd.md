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
/var/lib/mud-web-proxy-deploy/
└── previous-release
```

## Ownership, modes, and static service identity

| Path                             | Owner                         | Mode                              | Contract                                                        |
| -------------------------------- | ----------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `/opt/mud-web-proxy`             | `root:root`                   | `0755`                            | Service user can traverse but not modify.                       |
| `releases/`                      | `root:root`                   | `0755`                            | Contains immutable verified releases.                           |
| `releases/<version>/`            | `root:root`                   | `0755`                            | No file is modified after activation.                           |
| Release files                    | `root:root`                   | `0644` unless executable          | Bundle and installed dependencies are read-only to the service. |
| `current`                        | `root:root`                   | symlink                           | Replaced atomically; never edited in place.                     |
| `runtimes/bun/<version>/`        | `root:root`                   | directories `0755`, binary `0755` | Versioned and immutable.                                        |
| `/etc/mud-web-proxy.env`         | `root:mud-web-proxy`          | `0640`                            | Configuration and secrets; not world-readable.                  |
| `/etc/mud-web-proxy/`            | `root:mud-web-proxy`          | `0750`                            | Read-only secret files referenced by the environment.           |
| APNS private key                 | `root:mud-web-proxy`          | `0640`                            | Present only when APNS is enabled.                              |
| `/var/lib/mud-web-proxy/`        | `mud-web-proxy:mud-web-proxy` | `0700`                            | Created by systemd `StateDirectory`.                            |
| `attested-keys.json`             | `mud-web-proxy:mud-web-proxy` | `0600`                            | Durable App Attest registrations and counters.                  |
| `/var/lib/mud-web-proxy-deploy/` | `root:root`                   | `0700`                            | Root-only deployment metadata; never writable by the service.   |
| `previous-release`               | `root:root`                   | `0600`                            | Persistent rollback target written before activation.           |

```text
/etc/mud-web-proxy.env: 0640 root:mud-web-proxy
/var/lib/mud-web-proxy: 0700 mud-web-proxy:mud-web-proxy
/var/lib/mud-web-proxy/attested-keys.json: 0600 mud-web-proxy:mud-web-proxy
/var/lib/mud-web-proxy-deploy: 0700 root:root
/var/lib/mud-web-proxy-deploy/previous-release: 0600 root:root
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
`mud-web-proxy:mud-web-proxy` state.

On Ubuntu 26.04, systemd creates the configured state directory when absent,
sets the innermost directory's owner and `StateDirectoryMode`, and recursively
changes ownership only when that directory initially has the wrong owner or
group. When the directory already has the configured owner and group, systemd
leaves child ownership unchanged as an optimization. It does not infer or
repair the pre-seeded JSON file's `0600` mode. The installer must therefore
verify the directory and file independently before first start. See Ubuntu
26.04's
[systemd.exec `StateDirectory=` documentation](https://manpages.ubuntu.com/manpages/resolute/man5/systemd.exec.5.html#runtime-directory-state-directory-cache-directory-logs-directory-configuration-directory).

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
set -euo pipefail

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

Run this complete procedure as root. Set `RELEASE_VERSION` from the already
verified extracted directory. The procedure rejects non-basename identifiers,
proves the resolved release and runtime remain in their direct versioned
directories, validates the release, writes the prior target to the root-only
deployment record, and then performs one same-filesystem symlink rename.
Every failed check exits before the restart:

```bash
set -euo pipefail
umask 077

[[ "$EUID" -eq 0 ]]
INSTALL_ROOT=/opt/mud-web-proxy
RELEASES_DIR="$INSTALL_ROOT/releases"
RUNTIMES_DIR="$INSTALL_ROOT/runtimes/bun"
CURRENT="$INSTALL_ROOT/current"
DEPLOY_RECORD_DIR=/var/lib/mud-web-proxy-deploy
ROLLBACK_RECORD="$DEPLOY_RECORD_DIR/previous-release"
: "${RELEASE_VERSION:?set RELEASE_VERSION to the verified release identifier}"

[[ "$(readlink -e -- "$INSTALL_ROOT")" == "$INSTALL_ROOT" ]]
[[ "$(readlink -e -- "$RELEASES_DIR")" == "$RELEASES_DIR" ]]
[[ "$(readlink -e -- "$RUNTIMES_DIR")" == "$RUNTIMES_DIR" ]]

VALIDATED_RELEASE_DIR=
validate_release() {
  local release_version="$1"
  local release_dir bun_version runtime_dir package_bun_version

  [[ "$release_version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
  release_dir="$(readlink -e -- "$RELEASES_DIR/$release_version")"
  [[ "$(dirname -- "$release_dir")" == "$RELEASES_DIR" ]]
  [[ "$(basename -- "$release_dir")" == "$release_version" ]]
  [[ -f "$release_dir/VERSION" && ! -L "$release_dir/VERSION" ]]
  [[ "$(<"$release_dir/VERSION")" == "$release_version" ]]
  [[ -f "$release_dir/.bun-version" && ! -L "$release_dir/.bun-version" ]]
  bun_version="$(<"$release_dir/.bun-version")"
  [[ "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  [[ -f "$release_dir/package.json" && ! -L "$release_dir/package.json" ]]
  [[ -d "$release_dir/node_modules" && ! -L "$release_dir/node_modules" ]]
  [[ -f "$release_dir/dist/wsproxy.js" && ! -L "$release_dir/dist/wsproxy.js" ]]
  [[ -L "$release_dir/runtime" ]]
  [[ "$(readlink -- "$release_dir/runtime")" == \
    "../../runtimes/bun/$bun_version" ]]
  runtime_dir="$(readlink -e -- "$release_dir/runtime")"
  [[ "$(dirname -- "$runtime_dir")" == "$RUNTIMES_DIR" ]]
  [[ "$(basename -- "$runtime_dir")" == "$bun_version" ]]
  [[ -x "$runtime_dir/bin/bun" ]]
  [[ "$("$runtime_dir/bin/bun" --version)" == "$bun_version" ]]
  package_bun_version="$(
    "$runtime_dir/bin/bun" -e \
      'const p = await Bun.file(process.argv[1]).json();
       if (typeof p.engines?.bun !== "string") process.exit(1);
       process.stdout.write(p.engines.bun);' \
      "$release_dir/package.json"
  )"
  [[ "$package_bun_version" == "$bun_version" ]]
  VALIDATED_RELEASE_DIR="$release_dir"
}

validate_release "$RELEASE_VERSION"
RELEASE_DIR="$VALIDATED_RELEASE_DIR"
[[ "$RELEASE_DIR" == "$RELEASES_DIR/$RELEASE_VERSION" ]]

if [[ -e "$DEPLOY_RECORD_DIR" || -L "$DEPLOY_RECORD_DIR" ]]; then
  [[ -d "$DEPLOY_RECORD_DIR" && ! -L "$DEPLOY_RECORD_DIR" ]]
fi
install -d -o root -g root -m 0700 "$DEPLOY_RECORD_DIR"
[[ "$(stat -c '%u:%g:%a' "$DEPLOY_RECORD_DIR")" == "0:0:700" ]]

PREVIOUS_TARGET=
if [[ -e "$CURRENT" || -L "$CURRENT" ]]; then
  [[ -L "$CURRENT" ]]
  PREVIOUS_TARGET="$(readlink -- "$CURRENT")"
  [[ "$PREVIOUS_TARGET" =~ \
    ^releases/([A-Za-z0-9][A-Za-z0-9._-]*)$ ]]
  PREVIOUS_VERSION="${BASH_REMATCH[1]}"
  validate_release "$PREVIOUS_VERSION"
  [[ "$VALIDATED_RELEASE_DIR" == "$RELEASES_DIR/$PREVIOUS_VERSION" ]]
  [[ "$PREVIOUS_TARGET" != "releases/$RELEASE_VERSION" ]]
fi

RECORD_TEMP=
LINK_TEMP_DIR=
cleanup() {
  if [[ -n "$RECORD_TEMP" ]]; then
    rm -f -- "$RECORD_TEMP" || true
  fi
  if [[ -n "$LINK_TEMP_DIR" ]]; then
    rm -f -- "$LINK_TEMP_DIR/current" || true
    rmdir -- "$LINK_TEMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

RECORD_TEMP="$(mktemp "$DEPLOY_RECORD_DIR/.previous-release.XXXXXX")"
chown root:root "$RECORD_TEMP"
chmod 0600 "$RECORD_TEMP"
printf '%s\n' "$PREVIOUS_TARGET" >"$RECORD_TEMP"
mv -Tf -- "$RECORD_TEMP" "$ROLLBACK_RECORD"
RECORD_TEMP=
[[ "$(stat -c '%u:%g:%a' "$ROLLBACK_RECORD")" == "0:0:600" ]]
[[ "$(<"$ROLLBACK_RECORD")" == "$PREVIOUS_TARGET" ]]

LINK_TEMP_DIR="$(mktemp -d "$INSTALL_ROOT/.current.XXXXXX")"
ln -s "releases/$RELEASE_VERSION" "$LINK_TEMP_DIR/current"
mv -Tf -- "$LINK_TEMP_DIR/current" "$CURRENT"
rmdir -- "$LINK_TEMP_DIR"
LINK_TEMP_DIR=

systemctl restart mud-web-proxy
```

An empty `previous-release` record denotes an initial activation with no prior
release. Production acceptance still requires a tested retained rollback
release.

## Offline rollback

Rollback performs no download, dependency installation, or package-manager resolution.

Run this procedure as root. It reads the persistent record, rejects an empty or
malformed target, repeats the complete release/runtime validation, creates a
unique temporary symlink under the installation root, atomically reverses
`current`, and restarts only after the rename succeeds:

```bash
set -euo pipefail
umask 077

[[ "$EUID" -eq 0 ]]
INSTALL_ROOT=/opt/mud-web-proxy
RELEASES_DIR="$INSTALL_ROOT/releases"
RUNTIMES_DIR="$INSTALL_ROOT/runtimes/bun"
CURRENT="$INSTALL_ROOT/current"
DEPLOY_RECORD_DIR=/var/lib/mud-web-proxy-deploy
ROLLBACK_RECORD="$DEPLOY_RECORD_DIR/previous-release"

[[ "$(readlink -e -- "$INSTALL_ROOT")" == "$INSTALL_ROOT" ]]
[[ "$(readlink -e -- "$RELEASES_DIR")" == "$RELEASES_DIR" ]]
[[ "$(readlink -e -- "$RUNTIMES_DIR")" == "$RUNTIMES_DIR" ]]
[[ ! -L "$DEPLOY_RECORD_DIR" ]]
[[ "$(stat -c '%u:%g:%a' "$DEPLOY_RECORD_DIR")" == "0:0:700" ]]
[[ -f "$ROLLBACK_RECORD" && ! -L "$ROLLBACK_RECORD" ]]
[[ "$(stat -c '%u:%g:%a' "$ROLLBACK_RECORD")" == "0:0:600" ]]

VALIDATED_RELEASE_DIR=
validate_release() {
  local release_version="$1"
  local release_dir bun_version runtime_dir package_bun_version

  [[ "$release_version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
  release_dir="$(readlink -e -- "$RELEASES_DIR/$release_version")"
  [[ "$(dirname -- "$release_dir")" == "$RELEASES_DIR" ]]
  [[ "$(basename -- "$release_dir")" == "$release_version" ]]
  [[ -f "$release_dir/VERSION" && ! -L "$release_dir/VERSION" ]]
  [[ "$(<"$release_dir/VERSION")" == "$release_version" ]]
  [[ -f "$release_dir/.bun-version" && ! -L "$release_dir/.bun-version" ]]
  bun_version="$(<"$release_dir/.bun-version")"
  [[ "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  [[ -f "$release_dir/package.json" && ! -L "$release_dir/package.json" ]]
  [[ -d "$release_dir/node_modules" && ! -L "$release_dir/node_modules" ]]
  [[ -f "$release_dir/dist/wsproxy.js" && ! -L "$release_dir/dist/wsproxy.js" ]]
  [[ -L "$release_dir/runtime" ]]
  [[ "$(readlink -- "$release_dir/runtime")" == \
    "../../runtimes/bun/$bun_version" ]]
  runtime_dir="$(readlink -e -- "$release_dir/runtime")"
  [[ "$(dirname -- "$runtime_dir")" == "$RUNTIMES_DIR" ]]
  [[ "$(basename -- "$runtime_dir")" == "$bun_version" ]]
  [[ -x "$runtime_dir/bin/bun" ]]
  [[ "$("$runtime_dir/bin/bun" --version)" == "$bun_version" ]]
  package_bun_version="$(
    "$runtime_dir/bin/bun" -e \
      'const p = await Bun.file(process.argv[1]).json();
       if (typeof p.engines?.bun !== "string") process.exit(1);
       process.stdout.write(p.engines.bun);' \
      "$release_dir/package.json"
  )"
  [[ "$package_bun_version" == "$bun_version" ]]
  VALIDATED_RELEASE_DIR="$release_dir"
}

PREVIOUS_TARGET="$(<"$ROLLBACK_RECORD")"
[[ "$PREVIOUS_TARGET" =~ \
  ^releases/([A-Za-z0-9][A-Za-z0-9._-]*)$ ]]
PREVIOUS_VERSION="${BASH_REMATCH[1]}"
validate_release "$PREVIOUS_VERSION"
[[ "$VALIDATED_RELEASE_DIR" == "$RELEASES_DIR/$PREVIOUS_VERSION" ]]
[[ -L "$CURRENT" ]]
[[ "$(readlink -- "$CURRENT")" != "$PREVIOUS_TARGET" ]]

LINK_TEMP_DIR=
cleanup() {
  if [[ -n "$LINK_TEMP_DIR" ]]; then
    rm -f -- "$LINK_TEMP_DIR/current" || true
    rmdir -- "$LINK_TEMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

LINK_TEMP_DIR="$(mktemp -d "$INSTALL_ROOT/.current.XXXXXX")"
ln -s "$PREVIOUS_TARGET" "$LINK_TEMP_DIR/current"
mv -Tf -- "$LINK_TEMP_DIR/current" "$CURRENT"
rmdir -- "$LINK_TEMP_DIR"
LINK_TEMP_DIR=

systemctl restart mud-web-proxy
```

Validate `/health`, WSS, and a mock-MUD session after rollback.

## Retention and pruning

Retain the active release, the release named by the non-empty root-only
rollback record, and the two most recent verified previous releases, plus
every referenced Bun runtime and installed `node_modules`. Prune only after
acceptance; never prune a recorded or otherwise retained release or a runtime
it references.

## Backup-required and disposable data

Back up encrypted, off-host `/etc/mud-web-proxy.env`, referenced APNS key
material, App Attest state, and
`/var/lib/mud-web-proxy-deploy/previous-release`. Take a file-level backup
before every upgrade and at least daily, and test restoration on a
non-production host. DigitalOcean automated Droplet backups are an additional
machine-recovery layer, not a replacement. Immutable retained releases are
needed only for rollback.

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
set -euo pipefail

readlink -f /opt/mud-web-proxy/current
find /opt/mud-web-proxy/releases -maxdepth 1 -mindepth 1 -type d -print
find /opt/mud-web-proxy/runtimes/bun -maxdepth 1 -mindepth 1 -type d -print
stat -c '%a %U:%G %n' /etc/mud-web-proxy.env
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy-deploy
stat -c '%a %U:%G %n' /var/lib/mud-web-proxy-deploy/previous-release
NONEMPTY_ENV_VALUE_RE="(\"[^\"]+\"|'[^']+'|[^[:space:]#'\"][^#]*)"
if grep -Eq "^APPATTEST_BUNDLE_ID=${NONEMPTY_ENV_VALUE_RE}$" \
  /etc/mud-web-proxy.env &&
  grep -Eq "^APPATTEST_TEAM_ID=${NONEMPTY_ENV_VALUE_RE}$" \
    /etc/mud-web-proxy.env; then
  stat -c '%a %U:%G %n' /var/lib/mud-web-proxy/attested-keys.json
fi
/opt/mud-web-proxy/current/runtime/bin/bun --version
ss -ltnp | grep ':6200'
systemctl is-active mud-web-proxy caddy do-agent
```

Expect modes/owners `640 root:mud-web-proxy`, `700
mud-web-proxy:mud-web-proxy`, `700 root:root`, and `600 root:root`. When both
App Attest identifiers are configured, also expect `600
mud-web-proxy:mud-web-proxy` for its store. The Bun version must equal the
release pin, and port 6200 must be loopback-only at `127.0.0.1:6200`.

## Responsibilities of follow-up tickets

MWP-103 supplies verified release bundles. MWP-105 supplies the systemd unit,
static service account, and Caddy configuration implementing this contract.
