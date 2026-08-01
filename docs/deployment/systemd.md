# Native systemd deployment

## Scope and implementation status

This guide installs and operates MWP-104's native-host layout. The repository
ships these MWP-105 artifacts:

- [`deploy/sysusers.d/mud-web-proxy.conf`](../../deploy/sysusers.d/mud-web-proxy.conf)
  creates the persistent service identity.
- [`deploy/systemd/mud-web-proxy.service`](../../deploy/systemd/mud-web-proxy.service)
  supervises the release-local Bun process.
- [`config/mud-web-proxy.env.systemd.example`](../../config/mud-web-proxy.env.systemd.example)
  is the native environment starting point.
- [`deploy/caddy/Caddyfile.example`](../../deploy/caddy/Caddyfile.example)
  is the reusable HTTPS/WSS edge template.

MWP-103 supplies a verified release bundle. The production state-transfer,
final App Attest, activation, and rollback gates remain in the
[New-Droplet cutover runbook](new-droplet-cutover.md); this guide does not
replace them.

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

The shipped unit requires:

```text
StateDirectory=mud-web-proxy
StateDirectoryMode=0700
UMask=0077
DynamicUser=no
```

`DynamicUser=yes` is forbidden. It relocates state under `/var/lib/private`,
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

## Install the native operator files

Run this installation sequence as root on the new Ubuntu 26.04 host, after
the MWP-103 release has been verified and before the MWP-104 final activation
gate. It installs no production App Attest state and does not start either
service. Keep the production environment and final App Attest store out of
this procedure until the cutover runbook permits them.

Install Caddy from its official stable Ubuntu repository. The package starts
`caddy.service`; stop it immediately so the packaged default cannot serve
before the rendered configuration is validated.

```bash
sudo apt install -y \
  debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
  sudo gpg --dearmor \
    -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf \
  'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' |
  sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo chmod o+r \
  /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
  /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
sudo systemctl stop caddy.service
```

Install the persistent identity and verify its locked shell, home directory,
and matching primary group. `DynamicUser=yes` is prohibited: it would create a
transient identity and relocate state under `/var/lib/private`, breaking the
pre-seeded `mud-web-proxy:mud-web-proxy` App Attest store. The shipped unit
sets `DynamicUser=no` explicitly.

```bash
install -D -o root -g root -m 0644 \
  deploy/sysusers.d/mud-web-proxy.conf \
  /usr/local/lib/sysusers.d/mud-web-proxy.conf
systemd-sysusers mud-web-proxy.conf
service_group_gid="$(
  getent group mud-web-proxy | awk -F: '
    $1 == "mud-web-proxy" { print $3; found = 1 }
    END { exit !found }
  '
)"
[[ "$service_group_gid" =~ ^[0-9]+$ ]]
getent passwd mud-web-proxy | awk -F: \
  -v group_gid="$service_group_gid" '
    $1 == "mud-web-proxy" && $4 == group_gid &&
    $6 == "/var/lib/mud-web-proxy" && $7 == "/usr/sbin/nologin" {
      found = 1
    }
    END { exit !found }
  '
passwd -S mud-web-proxy | awk '
  $1 == "mud-web-proxy" && $2 == "L" { found = 1 }
  END { exit !found }
'
```

Install the unit and prepare a root-owned staging copy of the environment.
Replace every example target, origin, authentication, App Attest, APNS, and
other production value in the staging file according to the
[configuration reference](../configuration.md). Do not add
`ALLOW_INSECURE_INBOUND_NO_TLS`, `TLS_CERT_PATH`, or `TLS_KEY_PATH`: the
application is plaintext only on loopback and Caddy owns inbound TLS.

```bash
install -D -o root -g root -m 0644 \
  deploy/systemd/mud-web-proxy.service \
  /etc/systemd/system/mud-web-proxy.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/mud-web-proxy.service
```

Render Caddy only after setting a real public proxy hostname. `PROXY_HOSTNAME`
and `MUD_HOSTNAME` below are operator inputs, not repository production
values. The placeholder gate rejects every shipped example hostname, including
the example allowed origin. Caddy owns public ports 80 and 443; never create a
firewall rule for port 6200.

```bash
set -euo pipefail
umask 077
: "${PROXY_HOSTNAME:?set the public proxy hostname}"
: "${MUD_HOSTNAME:?set the fixed MUD target hostname}"
: "${EDITOR:?set EDITOR to a root-safe editor}"
[[ "$PROXY_HOSTNAME" =~ ^[A-Za-z0-9.-]+$ ]]
[[ "$MUD_HOSTNAME" =~ ^[A-Za-z0-9.-]+$ ]]

environment_staging="$(mktemp /root/.mud-web-proxy.env.staging.XXXXXX)"
environment_rendered="$(mktemp /root/.mud-web-proxy.env.rendered.XXXXXX)"
caddy_staging="$(mktemp /etc/caddy/.Caddyfile.XXXXXX)"
cleanup() {
  rm -f "$environment_staging" "$environment_rendered" "$caddy_staging"
}
trap cleanup EXIT
install -o root -g root -m 0600 \
  config/mud-web-proxy.env.systemd.example "$environment_staging"
# Set every approved production value; do not add the forbidden TLS variables.
"$EDITOR" "$environment_staging"
sed \
  -e "s|proxy\\.example\\.com|$PROXY_HOSTNAME|g" \
  -e "s|mud\\.example\\.com|$MUD_HOSTNAME|g" \
  "$environment_staging" >"$environment_rendered"
sed "s|proxy\\.example\\.com|$PROXY_HOSTNAME|g" \
  deploy/caddy/Caddyfile.example >"$caddy_staging"
if grep -Eq \
  'proxy\.example\.com|mud\.example\.com|https://proxy\.example\.com' \
  "$environment_rendered" "$caddy_staging"; then
  echo 'unrendered deployment placeholder remains' >&2
  exit 1
fi
install -o root -g mud-web-proxy -m 0640 \
  "$environment_rendered" /etc/mud-web-proxy.env
install -o root -g root -m 0644 "$caddy_staging" /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl stop caddy.service
```

The environment is `0640 root:mud-web-proxy`; the unit and rendered Caddyfile
are `0644 root:root`. Confirm the installed ownership and modes before the
first permitted start:

```bash
stat -c '%a %U:%G %n' \
  /usr/local/lib/sysusers.d/mud-web-proxy.conf \
  /etc/systemd/system/mud-web-proxy.service \
  /etc/mud-web-proxy.env \
  /etc/caddy/Caddyfile
```

## Installing a release

### Host prerequisites

A clean Ubuntu 26.04 image ships with neither of the tools this section
requires. Install them before anything else:

```bash
apt-get update && apt-get install -y unzip gh
```

`unzip` is not optional — the Bun installer aborts with `error: unzip is
required to install bun`, so the runtime install below fails outright rather
than degrading. `gh` is needed for the attestation check; without it the
provenance step cannot run at all.

Both were confirmed missing on a fresh Ubuntu 26.04 Droplet on 2026-08-01.

### Obtain and verify the bundle

Releases publish `mud-web-proxy-<version>.tar.gz`, `SHA256SUMS`, and an SPDX
SBOM, each carrying a build-provenance attestation.

Verification is a required step, not an optional one. Both checks run
**before extraction**, because extracting first means an unverified archive
has already written to the filesystem:

```bash
VERSION=4.0.0
gh release download "v${VERSION}" --repo AndrewGoldfinch/mud-web-proxy \
  --pattern 'mud-web-proxy-*.tar.gz' --pattern 'SHA256SUMS'

# 1. Integrity: the archive is the one the checksum names.
sha256sum -c SHA256SUMS

# 2. Provenance: that archive was built by this repository's release
#    workflow, from the commit the attestation names.
gh attestation verify "mud-web-proxy-${VERSION}.tar.gz" \
  --owner AndrewGoldfinch
```

The two answer different questions and neither substitutes for the other. A
checksum proves the file matches a digest you were given; it says nothing
about who produced that digest. The attestation is what ties the artifact to
this repository. If either fails, stop — do not extract.

The bundle contains no dependencies and no Bun binary. `node_modules` is
installed on the host from the bundled `bun.lock`, and the runtime is the
shared, versioned installation under `/opt/mud-web-proxy/runtimes/`, linked
per release. Bundling either would make the archive
architecture-specific and duplicate a runtime for every retained release.

### Install

In the newly extracted release, before making it immutable, install
dependencies and create the runtime link:

```bash
set -euo pipefail

RELEASE_VERSION="$(cat VERSION)"
BUN_VERSION="$(cat .bun-version)"
BUN="/opt/mud-web-proxy/runtimes/bun/$BUN_VERSION/bin/bun"
"$BUN" install --frozen-lockfile --production
ln -s "../../runtimes/bun/$BUN_VERSION" runtime
```

Validate bundle, dependencies, runtime, ownership, and modes before
current-link activation. During a normal upgrade, activation means both the
current-link phase and the subsequent process-application phase. Health, WSS,
and mock-MUD validation follow both phases and gate acceptance.

## Atomic current-link activation

Run this complete procedure as root. It validates the release, writes the
rollback record, and swaps `current`, but never starts, stops, or restarts a
service. Set `RELEASE_VERSION` from the already verified extracted directory.
The procedure rejects non-basename identifiers, proves the resolved release
and runtime remain in their direct versioned directories, validates the
release, writes the prior target to the root-only deployment record, and then
performs one same-filesystem symlink rename. Every failed check exits before
the link swap:

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
```

An empty `previous-release` record denotes an initial activation with no prior
release. Production acceptance still requires a tested retained rollback
release.

### Apply an activated release

Normal upgrades run this phase only after the current-link phase exits zero:

```bash
set -euo pipefail

systemctl restart mud-web-proxy
curl --fail --silent --show-error \
  http://127.0.0.1:6200/health >/dev/null
```

Production acceptance still requires WSS and a complete mock-MUD session.
A new-Droplet pre-stage does not run this phase.

## Offline rollback

Rollback performs no download, dependency installation, or package-manager resolution.

Run this procedure as root. It reads the persistent record, rejects an empty or
malformed target, repeats the complete release/runtime validation, creates a
unique temporary symlink under the installation root, atomically reverses
`current`, and ends after the rename succeeds:

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
```

After the current-link procedure exits zero, run the separate
`Apply an activated release` phase, then validate `/health`, WSS, and a
mock-MUD session.

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

## Operator commands

Do not enable or start either service before the MWP-104 final App Attest
transfer gate. At that gate, start the loopback proxy first, prove its health,
then start Caddy and prove that its service is active. The linked post-routing
gate proves public HTTPS/WSS. If a gate fails, follow the
[cutover runbook's rollback procedure](new-droplet-cutover.md), which requires
both new services to be inactive before restoring the old host.

```bash
systemctl enable mud-web-proxy.service caddy.service
systemctl start mud-web-proxy.service
curl --fail --silent --show-error http://127.0.0.1:6200/health
systemctl start caddy.service
systemctl is-active --quiet caddy.service
```

The linked post-routing MWP-104 gate owns the public HTTPS/WSS probe. Do not
use a public hostname curl here: before routing changes, it can reach the old
host rather than this prepared host.

For routine operation, use systemd directly. PM2 is unsupported and must not
supervise `mud-web-proxy.service`; there must be one systemd-managed process,
not a second process manager or a legacy Git-checkout process.

```bash
systemctl stop mud-web-proxy.service
systemctl restart mud-web-proxy.service
systemctl status mud-web-proxy.service caddy.service --no-pager
journalctl -u mud-web-proxy.service -u caddy.service -n 200 --no-pager
journalctl -u mud-web-proxy.service --since '1 hour ago' --no-pager
curl --fail --silent --show-error http://127.0.0.1:6200/health
: "${PROXY_HOSTNAME:?set the public proxy hostname}"
curl --fail --silent --show-error "https://${PROXY_HOSTNAME}/health"
ss -ltnp 'sport = :6200'
systemctl show mud-web-proxy.service \
  -p MemoryCurrent -p MemoryPeak -p TasksCurrent -p TasksMax \
  -p LimitNOFILE -p MainPID -p ControlGroup
systemd-analyze verify /etc/systemd/system/mud-web-proxy.service
systemd-analyze security --no-pager mud-web-proxy.service
```

Port 6200 must appear only as `127.0.0.1:6200`; Caddy is the public HTTPS/WSS
listener. The live descriptor count is available from the reported `MainPID`:

```bash
main_pid="$(systemctl show -p MainPID --value mud-web-proxy.service)"
find "/proc/${main_pid}/fd" -mindepth 1 -maxdepth 1 | wc -l
```

### Capacity and security boundaries

`MAX_SESSIONS_GLOBAL=200` rejects excess sessions before the service consumes
an accidental host-default limit. `LimitNOFILE=1024` budgets four descriptors
per admitted session (800 total) and reserves 224 for listeners, DNS/TLS,
APNS, journald, and transient accepts. A session normally uses a client and a
MUD descriptor; four is deliberate headroom, not an assertion that each
session always needs four.

The initial one-vCPU, one-GiB host envelope is provisional:

```text
MemoryHigh=384M
MemoryMax=512M
TasksMax=128
LimitNOFILE=1024
```

The clean-host profile is a lower bound: it sustains 50 concurrent
WebSocket-to-mock-MUD sessions with bidirectional traffic for 60 seconds. It
does not prove the 200-session production cap. `MemoryHigh` is the pressure
boundary; at `MemoryMax=512M`, systemd can OOM-kill and restart the proxy,
disconnecting every active session. That is an availability trade to reserve
capacity for Caddy, the kernel, journald, SSH, and a one-GiB host. MWP-106
must record representative production `MemoryCurrent`, `MemoryPeak`, task,
descriptor, and `memory.events` measurements before these values are treated
as production sizing.

#### Steady-state memory observation

`MemoryCurrent` on its own cannot distinguish a service resting well under
its ceiling from one being reclaimed at it repeatedly. The cgroup event
counters are what separate the two:

```bash
systemctl show mud-web-proxy \
  -p MemoryCurrent -p MemoryPeak -p TasksCurrent -p LimitNOFILE
cat /sys/fs/cgroup/system.slice/mud-web-proxy.service/memory.events
```

| Event increments            | Meaning                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `oom`, `oom_kill`, or `max` | The hard ceiling is being reached. Sessions are being dropped; resize. |
| `high`                      | `MemoryHigh` throttled allocation. Review before it becomes an `oom`.  |
| none                        | Operating inside the envelope.                                         |

During a cutover this is a gate rather than a diagnostic: an `oom`,
`oom_kill`, or `max` increment blocks native-deployment acceptance outright,
and a `high` increment requires explicit review. See
[Production resource observation](new-droplet-cutover.md#production-resource-observation)
for the 24-hour schedule and the fail-closed recovery.

Change these limits through the MWP-105 resource design, not the unit alone.
They are one set: `LimitNOFILE=1024` is budgeted against
`MAX_SESSIONS_GLOBAL=200`, so raising the session cap without the descriptor
limit exhausts descriptors before the cap is reached.

The unit deliberately permits only `AF_UNIX`, `AF_INET`, and `AF_INET6`.
`AF_NETLINK` is not a speculative allowance. The Ubuntu acceptance test uses
the hostname `mwp-mud.test` rather than an IP literal, so its WSS/session
evidence records whether the restricted hostname-resolution path works. Keep
the unit unchanged when that evidence succeeds. If it fails by hostname while
the same target succeeds by IP, record both diagnostics and the required
`AF_NETLINK` rationale in the Ubuntu acceptance evidence and security
baseline before proposing a unit change; do not loosen the address-family
restriction silently.

The security report must remain in systemd's `OK` assessment band. The first
Ubuntu measurement records its exact image, systemd package, and measured
exposure in the acceptance evidence. The committed
`tests/deployment/systemd-security-baseline.json` maximum is exactly measured
exposure plus `0.1` (for example, `2.3` measures to a `2.4` maximum). A later
verification run reads that committed maximum; it must never calculate a new
threshold from the current host. See [Systemd acceptance](systemd-acceptance.md)
for the measurement-to-baseline workflow and evidence paths.

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

The clean-host procedure and evidence checklist are in
[Systemd acceptance](systemd-acceptance.md). It validates the files and
runtime behavior on a disposable host; it does not replace the MWP-104
production cutover gates.
