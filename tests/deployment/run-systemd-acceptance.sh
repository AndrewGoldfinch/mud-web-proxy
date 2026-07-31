#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly INSTALL_ROOT=/opt/mud-web-proxy
readonly ENV_FILE=/etc/mud-web-proxy.env
readonly STATE_DIR=/var/lib/mud-web-proxy
readonly DEPLOY_STATE_DIR=/var/lib/mud-web-proxy-deploy
readonly TEST_MUD_NAME=mwp-mud.test
readonly TEST_MUD_PORT=6300
readonly SESSION_COUNT=50
readonly SUSTAIN_MS=60000
readonly SECURITY_MODE="${MWP_SECURITY_MODE:-verify}"
readonly ACCEPTANCE_PHASE="${MWP_ACCEPTANCE_PHASE:-install}"
readonly EVIDENCE_DIR="/root/mwp-105-evidence-$(date -u +%Y%m%dT%H%M%SZ)"
readonly RESUME_FILE=/root/mwp-105-acceptance-resume
readonly BUN_VERSION=1.3.14
readonly NODE_ACCEPTANCE_VERSION=22.21.1
readonly NODE_ACCEPTANCE_ARCHIVE="node-v${NODE_ACCEPTANCE_VERSION}-linux-x64.tar.gz"
readonly NODE_ACCEPTANCE_DIST_URL="https://nodejs.org/dist/v${NODE_ACCEPTANCE_VERSION}"
readonly NODE_ACCEPTANCE_RUNTIME_ROOT="/root/mwp-105-node-${NODE_ACCEPTANCE_VERSION}"
readonly NODE_ACCEPTANCE_CLIENT_ROOT="${REPO_ROOT}/node_modules/.cache/mwp-105-systemd-clients"
readonly RELEASE_VERSION=systemd-acceptance
readonly RUN_STARTED="$(date --iso-8601=seconds)"

# shellcheck source=tests/deployment/systemd-evidence.sh
source "${REPO_ROOT}/tests/deployment/systemd-evidence.sh"

mock_mud_pid=
acceptance_client_pid=
load_client_pid=
test_address=
hosts_line=
firewall_table_created=
acceptance_node_bin=

fail() {
  echo "systemd-acceptance: $*" >&2
  exit 1
}

remove_test_host_mapping() {
  local hosts_staging

  [[ -n "${hosts_line}" ]] || return 0
  hosts_staging="$(mktemp /etc/.hosts.mwp-105.XXXXXX)"
  awk -v exact="${hosts_line}" '$0 != exact' /etc/hosts >"${hosts_staging}"
  cat "${hosts_staging}" >/etc/hosts
  rm -f "${hosts_staging}"
  hosts_line=
}

cleanup() {
  systemctl stop mud-web-proxy caddy >/dev/null 2>&1 || true
  systemctl disable mud-web-proxy caddy >/dev/null 2>&1 || true
  if [[ -n "${acceptance_client_pid}" ]]; then
    kill "${acceptance_client_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${load_client_pid}" ]]; then
    kill "${load_client_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${mock_mud_pid}" ]]; then
    kill "${mock_mud_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${firewall_table_created}" ]]; then
    nft delete table inet mwp_105_acceptance >/dev/null 2>&1 || true
    firewall_table_created=
  fi
  remove_test_host_mapping || true
}

require_disposable_host() {
  local path

  [[ "${EUID}" -eq 0 ]] || fail 'must run as root'
  [[ "${MWP_DISPOSABLE_VM_ACK:-}" == \
    'ERASE THIS CLEAN UBUNTU 26.04 VM' ]] ||
    fail 'set the exact disposable VM acknowledgement'
  for path in \
    /opt/mud-web-proxy \
    /etc/mud-web-proxy.env \
    /var/lib/mud-web-proxy \
    /var/lib/mud-web-proxy-deploy; do
    [[ ! -e "${path}" && ! -L "${path}" ]] ||
      fail "refusing non-clean host: ${path} exists"
  done

  # shellcheck source=/dev/null
  source /etc/os-release
  [[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 26.04 ]] ||
    fail 'requires Ubuntu 26.04'
  [[ "$(uname -m)" == x86_64 ]] || fail 'requires x86_64'
}

install_caddy() {
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    apt-transport-https \
    curl \
    debian-archive-keyring \
    debian-keyring \
    gnupg \
    nftables
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    gpg --dearmor --yes \
      -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf \
    'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    >/etc/apt/sources.list.d/caddy-stable.list
  chmod o+r \
    /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
  systemctl stop caddy.service
  systemctl disable caddy.service
  ! systemctl is-active --quiet caddy.service ||
    fail 'Caddy remained active after package installation'
  ! systemctl is-enabled --quiet caddy.service ||
    fail 'Caddy remained enabled after package installation'
}

install_node_acceptance_runtime() {
  local archive
  local archive_checksum
  local download_root
  local manifest
  local source_bun
  local ws_version

  [[ ! -e "${NODE_ACCEPTANCE_RUNTIME_ROOT}" ]] ||
    fail 'Node acceptance runtime path already exists'
  [[ ! -e "${NODE_ACCEPTANCE_CLIENT_ROOT}" ]] ||
    fail 'Node acceptance client build path already exists'
  source_bun="$(command -v bun)" || fail 'Bun is not on PATH'
  [[ "$("${source_bun}" --version)" == "${BUN_VERSION}" ]] ||
    fail "Bun ${BUN_VERSION} is required"

  download_root="$(mktemp -d /tmp/mwp-105-node.XXXXXX)"
  manifest="${download_root}/SHASUMS256.txt"
  archive="${download_root}/${NODE_ACCEPTANCE_ARCHIVE}"
  curl --proto '=https' --tlsv1.2 --fail --location \
    --silent --show-error --output "${manifest}" \
    "${NODE_ACCEPTANCE_DIST_URL}/SHASUMS256.txt"
  curl --proto '=https' --tlsv1.2 --fail --location \
    --silent --show-error --output "${archive}" \
    "${NODE_ACCEPTANCE_DIST_URL}/${NODE_ACCEPTANCE_ARCHIVE}"
  archive_matches_sha256_manifest "${manifest}" "${archive}" ||
    fail 'Node archive does not match the official SHA-256 manifest'
  archive_checksum="$(sha256sum "${archive}" | awk '{ print $1 }')"

  install -d -o root -g root -m 0700 "${NODE_ACCEPTANCE_RUNTIME_ROOT}"
  tar --extract --gzip --file "${archive}" \
    --directory "${NODE_ACCEPTANCE_RUNTIME_ROOT}" --strip-components=1
  acceptance_node_bin="${NODE_ACCEPTANCE_RUNTIME_ROOT}/bin/node"
  [[ "$("${acceptance_node_bin}" --version)" == \
    "v${NODE_ACCEPTANCE_VERSION}" ]] ||
    fail 'Node acceptance runtime has the wrong version'
  ws_version="$(
    cd "${REPO_ROOT}"
    "${acceptance_node_bin}" -e \
      'process.stdout.write(require("ws/package.json").version)'
  )"

  BUN_BIN="${source_bun}" bash \
    "${REPO_ROOT}/tests/deployment/build-systemd-acceptance-clients.sh" \
    "${NODE_ACCEPTANCE_CLIENT_ROOT}" \
    "${EVIDENCE_DIR}/node-client-build.json"
  "${acceptance_node_bin}" --check \
    "${NODE_ACCEPTANCE_CLIENT_ROOT}/systemd-acceptance-client.js"
  "${acceptance_node_bin}" --check \
    "${NODE_ACCEPTANCE_CLIENT_ROOT}/systemd-load-client.js"

  [[ ! -e "${INSTALL_ROOT}/current/runtime/bin/node" ]] ||
    fail 'Node was copied into the synthetic release runtime'
  install -o root -g root -m 0600 "${manifest}" \
    "${EVIDENCE_DIR}/node-SHASUMS256.txt"
  {
    printf 'node-version=v%s\n' "${NODE_ACCEPTANCE_VERSION}"
    printf 'node-archive=%s\n' "${NODE_ACCEPTANCE_ARCHIVE}"
    printf 'node-archive-sha256=%s\n' "${archive_checksum}"
    printf 'node-distribution=%s\n' "${NODE_ACCEPTANCE_DIST_URL}"
    printf 'node-runtime-root=%s\n' "${NODE_ACCEPTANCE_RUNTIME_ROOT}"
    printf 'client-build-root=%s\n' "${NODE_ACCEPTANCE_CLIENT_ROOT}"
    printf 'ws-version=%s\n' "${ws_version}"
  } >"${EVIDENCE_DIR}/node-acceptance-runtime.txt"
  chmod 0600 "${EVIDENCE_DIR}/node-acceptance-runtime.txt"

  find "${download_root}" -type f -delete
  rmdir "${download_root}"
}

install_identity_and_unit() {
  install -D -o root -g root -m 0644 \
    "${REPO_ROOT}/deploy/sysusers.d/mud-web-proxy.conf" \
    /usr/local/lib/sysusers.d/mud-web-proxy.conf
  systemd-sysusers /usr/local/lib/sysusers.d/mud-web-proxy.conf
  getent group mud-web-proxy >/dev/null ||
    fail 'mud-web-proxy group was not created'
  getent passwd mud-web-proxy |
    awk -F: '$1 == "mud-web-proxy" && $6 == "/var/lib/mud-web-proxy" &&
      $7 == "/usr/sbin/nologin" { found = 1 } END { exit !found }' ||
    fail 'mud-web-proxy user does not match the static identity'
  passwd -S mud-web-proxy | awk '$2 == "L" { found = 1 } END { exit !found }' ||
    fail 'mud-web-proxy user is not locked'

  install -D -o root -g root -m 0644 \
    "${REPO_ROOT}/deploy/systemd/mud-web-proxy.service" \
    /etc/systemd/system/mud-web-proxy.service
  systemctl daemon-reload
  systemctl disable mud-web-proxy.service >/dev/null 2>&1 || true
  systemctl stop mud-web-proxy.service >/dev/null 2>&1 || true
}

install_test_release() {
  local dependency_check_dir
  local release_bun
  local release_root
  local runtime_root
  local source_bun

  source_bun="$(command -v bun)" || fail 'Bun is not on PATH'
  [[ "$("${source_bun}" --version)" == "${BUN_VERSION}" ]] ||
    fail "Bun ${BUN_VERSION} is required"
  [[ "$(<"${REPO_ROOT}/.bun-version")" == "${BUN_VERSION}" ]] ||
    fail 'repository .bun-version does not match the acceptance runtime'
  (
    cd "${REPO_ROOT}"
    "${source_bun}" run build
  )

  release_root="${INSTALL_ROOT}/releases/${RELEASE_VERSION}"
  runtime_root="${INSTALL_ROOT}/runtimes/bun/${BUN_VERSION}"
  install -d -o root -g root -m 0755 \
    "${release_root}/config" \
    "${release_root}/dist" \
    "${runtime_root}/bin" \
    "${DEPLOY_STATE_DIR}"
  install -o root -g root -m 0555 "${source_bun}" \
    "${runtime_root}/bin/bun"
  install -o root -g root -m 0444 \
    "${REPO_ROOT}/.bun-version" \
    "${REPO_ROOT}/bun.lock" \
    "${REPO_ROOT}/package.json" \
    "${release_root}/"
  printf '%s\n' "${RELEASE_VERSION}" >"${release_root}/VERSION"
  chmod 0444 "${release_root}/VERSION"
  install -o root -g root -m 0444 \
    "${REPO_ROOT}/config/apple-app-attest-root-ca.pem" \
    "${release_root}/config/apple-app-attest-root-ca.pem"
  cp -a "${REPO_ROOT}/dist/." "${release_root}/dist/"
  [[ -s "${release_root}/dist/wsproxy.js" ]] ||
    fail 'test release has no compiled entrypoint'
  ln -s "../../runtimes/bun/${BUN_VERSION}" "${release_root}/runtime"

  release_bun="${runtime_root}/bin/bun"
  (
    cd "${release_root}"
    "${release_bun}" install --frozen-lockfile --production
  )
  [[ "$("${release_bun}" --version)" == "${BUN_VERSION}" ]] ||
    fail 'installed release runtime has the wrong version'
  (
    cd "${release_root}"
    "${release_bun}" -e \
      'await import("cbor-x"); await import("iconv-lite"); await import("ws")'
  )
  dependency_check_dir="$(mktemp -d /tmp/mwp-105-dist-check.XXXXXX)"
  (
    cd "${release_root}"
    "${release_bun}" build dist/wsproxy.js --target=bun \
      --outdir "${dependency_check_dir}"
  )
  find "${dependency_check_dir}" -type f -delete
  rmdir "${dependency_check_dir}"

  chown -R root:root "${INSTALL_ROOT}"
  chown -h root:root "${release_root}/runtime"
  chmod -R a-w "${INSTALL_ROOT}/releases" "${INSTALL_ROOT}/runtimes"
  ln -s "releases/${RELEASE_VERSION}" "${INSTALL_ROOT}/current"
  printf '\n' >"${DEPLOY_STATE_DIR}/previous-release"
  chown root:root "${DEPLOY_STATE_DIR}/previous-release"
  chmod 0600 "${DEPLOY_STATE_DIR}/previous-release"
  chmod 0700 "${DEPLOY_STATE_DIR}"

  [[ "$(readlink "${INSTALL_ROOT}/current")" == \
    "releases/${RELEASE_VERSION}" ]] ||
    fail 'current does not select the test release'
  [[ -d "${INSTALL_ROOT}/current/node_modules" ]] ||
    fail 'test release has no production node_modules'
  [[ -f "${INSTALL_ROOT}/current/config/apple-app-attest-root-ca.pem" ]] ||
    fail 'test release has no App Attest root CA'
  tree_has_no_writable_files_or_directories \
    "${INSTALL_ROOT}/releases" "${INSTALL_ROOT}/runtimes" ||
    fail 'test release is not immutable'
}

install_test_state() {
  local state_staging

  install -d -o mud-web-proxy -g mud-web-proxy -m 0700 \
    /var/lib/mud-web-proxy
  state_staging="$(mktemp /var/lib/mud-web-proxy/.attested-keys.XXXXXX)"
  printf '{}\n' >"${state_staging}"
  chown mud-web-proxy:mud-web-proxy "${state_staging}"
  chmod 0600 "${state_staging}"
  mv -Tf "${state_staging}" \
    /var/lib/mud-web-proxy/attested-keys.json

  [[ "$(stat -c '%a %U:%G' "${STATE_DIR}")" == \
    '700 mud-web-proxy:mud-web-proxy' ]] ||
    fail 'state directory owner or mode is wrong'
  [[ "$(stat -c '%a %U:%G' "${STATE_DIR}/attested-keys.json")" == \
    '600 mud-web-proxy:mud-web-proxy' ]] ||
    fail 'App Attest state owner or mode is wrong'
  STATE_PATH="${STATE_DIR}/attested-keys.json" \
    "${INSTALL_ROOT}/current/runtime/bin/bun" -e '
      const value = await Bun.file(Bun.env.STATE_PATH).json();
      if (!value || Array.isArray(value) || typeof value !== "object") {
        throw new Error("state root is not an object");
      }
    '
}

render_test_environment() {
  local environment_staging
  local required_line

  environment_staging="$(mktemp /etc/.mud-web-proxy.env.XXXXXX)"
  cat >"${environment_staging}" <<'EOF'
BIND_HOST=127.0.0.1
WS_PORT=6200
INBOUND_TLS_MODE=off
TARGET_MODE=fixed
TN_HOST=mwp-mud.test
TN_PORT=6300
MUD_TLS_MODE=plain
TRUSTED_PROXY_CIDRS=127.0.0.1
ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
APPATTEST_BUNDLE_ID=com.example.mwp-systemd-test
APPATTEST_TEAM_ID=MWPTESTTEAM
SHUTDOWN_GRACE_MS=3000
SHUTDOWN_DEADLINE_MS=15000
MAX_SESSIONS_GLOBAL=200
MAX_SESSIONS_PER_IP=100
LOG_LEVEL=INFO
EOF
  for required_line in \
    BIND_HOST=127.0.0.1 \
    WS_PORT=6200 \
    INBOUND_TLS_MODE=off \
    TARGET_MODE=fixed \
    TN_HOST=mwp-mud.test \
    TN_PORT=6300 \
    MUD_TLS_MODE=plain \
    TRUSTED_PROXY_CIDRS=127.0.0.1 \
    ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json \
    APPATTEST_BUNDLE_ID=com.example.mwp-systemd-test \
    APPATTEST_TEAM_ID=MWPTESTTEAM \
    SHUTDOWN_GRACE_MS=3000 \
    SHUTDOWN_DEADLINE_MS=15000 \
    MAX_SESSIONS_GLOBAL=200 \
    MAX_SESSIONS_PER_IP=100 \
    LOG_LEVEL=INFO; do
    grep -Fxq "${required_line}" "${environment_staging}" ||
      fail "rendered environment omitted ${required_line%%=*}"
  done
  if grep -Eq \
    '^(ALLOW_INSECURE_INBOUND_NO_TLS|TLS_CERT_PATH|TLS_KEY_PATH)=' \
    "${environment_staging}"; then
    fail 'rendered environment contains a forbidden native variable'
  fi
  install -o root -g mud-web-proxy -m 0640 \
    "${environment_staging}" "${ENV_FILE}"
  rm -f "${environment_staging}"
  [[ "$(stat -c '%a %U:%G' "${ENV_FILE}")" == \
    '640 root:mud-web-proxy' ]] ||
    fail 'environment owner or mode is wrong'
}

render_caddy() {
  local caddy_staging

  caddy_staging="$(mktemp /etc/caddy/.Caddyfile.mwp-105.XXXXXX)"
  sed 's/^proxy\.example\.com /localhost /' \
    "${REPO_ROOT}/deploy/caddy/Caddyfile.example" >"${caddy_staging}"
  grep -q '^localhost {' "${caddy_staging}" ||
    fail 'Caddy test hostname was not rendered'
  ! grep -q 'proxy\.example\.com' "${caddy_staging}" ||
    fail 'Caddy placeholder remains'
  install -o root -g root -m 0644 "${caddy_staging}" /etc/caddy/Caddyfile
  rm -f "${caddy_staging}"
  caddy fmt --overwrite /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile
  systemctl stop caddy.service
  ! systemctl is-active --quiet caddy.service ||
    fail 'Caddy became active during rendering'
}

wait_for_marker() {
  local attempts="$3"
  local file="$1"
  local marker="$2"

  until grep -Fq "${marker}" "${file}" 2>/dev/null; do
    attempts=$((attempts - 1))
    if ((attempts == 0)); then
      [[ ! -e "${file}" ]] || cat "${file}" >&2
      fail "timed out waiting for marker: ${marker}"
    fi
    sleep 0.1
  done
}

start_mock_mud() {
  test_address="$(ip -4 route get 1.1.1.1 |
    awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
  [[ -n "${test_address}" && "${test_address}" != 127.* ]] ||
    fail 'no non-loopback test address'
  ! grep -Eq "[[:space:]]${TEST_MUD_NAME}([[:space:]]|$)" /etc/hosts ||
    fail "${TEST_MUD_NAME} already exists in /etc/hosts"
  hosts_line="${test_address} ${TEST_MUD_NAME}"
  printf '%s\n' "${hosts_line}" >>/etc/hosts

  ! nft list table inet mwp_105_acceptance >/dev/null 2>&1 ||
    fail 'nftables acceptance table already exists'
  nft add table inet mwp_105_acceptance
  firewall_table_created=1
  nft \
    'add chain inet mwp_105_acceptance input { type filter hook input priority -10; policy accept; }'
  nft add rule inet mwp_105_acceptance input \
    iifname lo tcp dport "${TEST_MUD_PORT}" accept
  nft add rule inet mwp_105_acceptance input \
    tcp dport "${TEST_MUD_PORT}" drop
  nft list table inet mwp_105_acceptance \
    >"${EVIDENCE_DIR}/mock-mud-firewall.txt"
  grep -Fq "tcp dport ${TEST_MUD_PORT} drop" \
    "${EVIDENCE_DIR}/mock-mud-firewall.txt" ||
    fail "host firewall does not block port ${TEST_MUD_PORT}"

  "${INSTALL_ROOT}/current/runtime/bin/bun" \
    "${REPO_ROOT}/tests/e2e/mock-mud.ts" \
    "${TEST_MUD_PORT}" generic \
    >"${EVIDENCE_DIR}/mock-mud.log" 2>&1 &
  mock_mud_pid=$!
  wait_for_marker "${EVIDENCE_DIR}/mock-mud.log" \
    "listening on port ${TEST_MUD_PORT}" 200
  ss -Hltn "sport = :${TEST_MUD_PORT}" |
    grep -q ":${TEST_MUD_PORT}" ||
    fail 'mock MUD is not listening'
}

wait_for_health() {
  local expected="$1"
  local url="$2"
  local deadline_ms="${3:-}"
  local attempts=300
  local curl_max_time=1
  local now_ms
  local remaining_ms
  local status

  while ((attempts > 0)); do
    if [[ -n "${deadline_ms}" ]]; then
      now_ms="$(monotonic_milliseconds)"
      ((now_ms < deadline_ms)) ||
        fail "drain exceeded 30 seconds while waiting for ${url}"
      remaining_ms=$((deadline_ms - now_ms))
      printf -v curl_max_time '%d.%03d' \
        "$((remaining_ms / 1000))" "$((remaining_ms % 1000))"
    fi
    status="$(curl --silent --max-time "${curl_max_time}" --output /dev/null \
      --write-out '%{http_code}' "${url}" || true)"
    [[ "${status}" == "${expected}" ]] && return 0
    attempts=$((attempts - 1))
    sleep 0.1
  done
  fail "${url} did not return ${expected}; last status ${status}"
}

monotonic_milliseconds() {
  awk '{ printf "%.0f\n", $1 * 1000 }' /proc/uptime
}

deadline_has_elapsed() {
  local deadline_ms="$1"
  local now_ms

  now_ms="$(monotonic_milliseconds)"
  ((now_ms >= deadline_ms))
}

require_before_deadline() {
  local deadline_ms="$1"
  local label="$2"

  ! deadline_has_elapsed "${deadline_ms}" ||
    fail "drain exceeded 30 seconds during ${label}"
}

verify_loopback_listener() {
  local evidence_dir="${1:-${EVIDENCE_DIR}}"
  local sockets

  sockets="$(ss -Hltn 'sport = :6200')"
  [[ -n "${sockets}" ]] || fail 'port 6200 is not listening'
  awk '$4 != "127.0.0.1:6200" { bad = 1 } END { exit bad }' \
    <<<"${sockets}" ||
    fail 'port 6200 is not bound only to 127.0.0.1'
  printf '%s\n' "${sockets}" >"${evidence_dir}/port-6200.txt"
}

wait_for_https_health() {
  local attempts=300
  local ca_path="$1"
  local status

  while ((attempts > 0)); do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --cacert "${ca_path}" https://localhost/health || true)"
    [[ "${status}" == 200 ]] && return 0
    attempts=$((attempts - 1))
    sleep 0.1
  done
  fail "https://localhost/health did not return 200; last status ${status}"
}

capture_resource_evidence() {
  local control_group
  local fd_count
  local main_pid
  local memory_events

  main_pid="$(systemctl show -p MainPID --value mud-web-proxy.service)"
  [[ "${main_pid}" =~ ^[1-9][0-9]*$ ]] ||
    fail 'service has no main process'
  control_group="$(
    systemctl show -p ControlGroup --value mud-web-proxy.service
  )"
  [[ "${control_group}" == /* ]] || fail 'service has no control group'
  memory_events="/sys/fs/cgroup${control_group}/memory.events"
  [[ -f "${memory_events}" ]] || fail 'service memory.events is unavailable'
  fd_count="$(
    find "/proc/${main_pid}/fd" -mindepth 1 -maxdepth 1 | wc -l
  )"

  systemctl show mud-web-proxy.service \
    -p MemoryCurrent \
    -p MemoryPeak \
    -p TasksCurrent \
    -p TasksMax \
    -p LimitNOFILE \
    -p MainPID \
    -p ControlGroup >"${EVIDENCE_DIR}/resources.txt"
  printf 'FileDescriptors=%s\n' "${fd_count}" \
    >>"${EVIDENCE_DIR}/resources.txt"
  cp "${memory_events}" "${EVIDENCE_DIR}/memory-events-load.txt"

  [[ "${fd_count}" -lt 1024 ]] ||
    fail 'file-descriptor count reached LimitNOFILE'
  [[ "$(systemctl show -p TasksCurrent --value mud-web-proxy.service)" \
    -lt 128 ]] || fail 'task count reached TasksMax'
}

verify_mount_boundary() {
  local main_pid
  local service_gid
  local service_uid

  main_pid="$(systemctl show -p MainPID --value mud-web-proxy.service)"
  service_uid="$(id -u mud-web-proxy)"
  service_gid="$(id -g mud-web-proxy)"
  if nsenter --target "${main_pid}" --mount -- \
    setpriv --reuid="${service_uid}" --regid="${service_gid}" \
      --clear-groups -- \
      touch /opt/mud-web-proxy/current/write-probe; then
    fail 'service user wrote to the immutable release'
  fi
  nsenter --target "${main_pid}" --mount -- \
    setpriv --reuid="${service_uid}" --regid="${service_gid}" \
      --clear-groups -- \
      touch /var/lib/mud-web-proxy/write-probe
  rm -f /var/lib/mud-web-proxy/write-probe
  printf '%s\n' \
    'release write failed; state-directory write succeeded' \
    >"${EVIDENCE_DIR}/mount-boundary.txt"
}

require_ok_security_assessment() {
  local report="$1"

  grep -Eq \
    'Overall exposure level for mud-web-proxy\.service: [0-9]+\.[0-9]+ OK' \
    "${report}" ||
    fail 'systemd security assessment is not OK'
}

measure_security() {
  local measured_exposure
  local report="${EVIDENCE_DIR}/systemd-security.txt"
  local systemd_package

  systemd-analyze security --no-pager mud-web-proxy.service >"${report}"
  require_ok_security_assessment "${report}"
  measured_exposure="$(
    sed -nE \
      's/.*Overall exposure level for mud-web-proxy.service: ([0-9]+\.[0-9]+).*/\1/p' \
      "${report}"
  )"
  [[ "${measured_exposure}" =~ ^[0-9]+\.[0-9]$ ]] ||
    fail 'could not parse the measured security exposure'
  systemd_package="$(dpkg-query -W -f='${Version}\n' systemd)"
  MEASURED_EXPOSURE="${measured_exposure}" \
    SYSTEMD_PACKAGE="${systemd_package}" \
    "${INSTALL_ROOT}/current/runtime/bin/bun" -e '
      console.log(JSON.stringify({
        image: "ubuntu-26-04-x64",
        osVersion: "26.04",
        architecture: "x86_64",
        systemdPackage: Bun.env.SYSTEMD_PACKAGE,
        measuredExposure: Number(Bun.env.MEASURED_EXPOSURE),
      }, null, 2));
    ' >"${EVIDENCE_DIR}/systemd-security-measurement.json"
}

verify_security() {
  local architecture
  local baseline="${REPO_ROOT}/tests/deployment/systemd-security-baseline.json"
  local baseline_image
  local baseline_os
  local baseline_systemd
  local current_systemd
  local maximum_exposure
  local report="${EVIDENCE_DIR}/systemd-security.txt"

  [[ -f "${baseline}" ]] ||
    fail 'systemd security baseline is missing'
  IFS=$'\t' read -r \
    baseline_image baseline_os architecture baseline_systemd maximum_exposure \
    < <(
      BASELINE_FILE="${baseline}" \
        "${INSTALL_ROOT}/current/runtime/bin/bun" -e '
          const value = await Bun.file(Bun.env.BASELINE_FILE).json();
          console.log([
            value.image,
            value.osVersion,
            value.architecture,
            value.systemdPackage,
            value.maximumExposure,
          ].join("\t"));
        '
    )
  [[ "${baseline_image}" == ubuntu-26-04-x64 &&
    "${baseline_os}" == 26.04 &&
    "${architecture}" == x86_64 ]] ||
    fail 'systemd security baseline host does not match'
  [[ "${maximum_exposure}" =~ ^[0-9]+\.[0-9]$ ]] ||
    fail 'systemd security baseline threshold is invalid'
  current_systemd="$(dpkg-query -W -f='${Version}\n' systemd)"
  [[ "${current_systemd}" == "${baseline_systemd}" ]] ||
    fail 'systemd package does not match the security baseline'
  systemd-analyze security "--threshold=${maximum_exposure}" --no-pager \
    mud-web-proxy.service >"${report}"
  require_ok_security_assessment "${report}"
}

verify_logs() {
  local journal="${EVIDENCE_DIR}/mud-web-proxy-journal.txt"
  local system_journal="${EVIDENCE_DIR}/system-journal.txt"

  journalctl -u mud-web-proxy.service --since "${RUN_STARTED}" --no-pager \
    >"${journal}"
  journalctl --since "${RUN_STARTED}" --no-pager >"${system_journal}"
  grep -Fq 'shutdown: completed' "${journal}" ||
    fail 'shutdown completion was not logged'
  if journal_has_unit_failure "${journal}"; then
    fail 'journal contains a filesystem, timeout, deadline, OOM, or signal failure'
  fi
  if journal_has_system_failure "${system_journal}"; then
    fail 'system journal contains a filesystem, OOM, or signal failure'
  fi
}

capture_terminal_memory_events() {
  local output="${EVIDENCE_DIR}/memory-events-after.txt"

  # Parent counters are hierarchical and remain readable after the unit cgroup
  # is pruned, so they close the terminal-read race without losing unit events.
  [[ -r "${parent_memory_events}" ]] ||
    fail 'parent memory.events disappeared during service shutdown'
  cp "${parent_memory_events}" "${output}"
  [[ -s "${output}" ]] ||
    fail 'terminal memory.events was not captured after service shutdown'
}

verify_memory_events() {
  local before="${EVIDENCE_DIR}/memory-events-before.txt"
  local after="${EVIDENCE_DIR}/memory-events-after.txt"

  [[ -f "${before}" && -f "${after}" ]] ||
    fail 'memory.events evidence is incomplete'
  memory_events_unchanged "${before}" "${after}" ||
    fail 'memory.events recorded an oom, oom kill, or max increment'
}

wait_for_inactive() {
  local attempts=300
  local deadline_ms="${2:-}"
  local state
  local unit="$1"

  while ((attempts > 0)); do
    if [[ -n "${deadline_ms}" ]] &&
      deadline_has_elapsed "${deadline_ms}"; then
      fail "${unit} did not become inactive within the shared 30-second drain"
    fi
    state="$(systemctl show -p ActiveState --value "${unit}")"
    if [[ "${state}" == inactive ]]; then
      return 0
    fi
    [[ "${state}" != failed ]] || fail "${unit} entered failed state"
    attempts=$((attempts - 1))
    sleep 0.1
  done
  fail "${unit} did not become inactive within 30 seconds"
}

wait_for_background_client() {
  local attempts=300
  local deadline_ms="${4:-}"
  local label="$2"
  local log_file="$3"
  local pid="$1"
  local status

  while kill -0 "${pid}" >/dev/null 2>&1; do
    if [[ -n "${deadline_ms}" ]] &&
      deadline_has_elapsed "${deadline_ms}"; then
      kill "${pid}" >/dev/null 2>&1 || true
      cat "${log_file}" >&2
      fail "${label} did not exit within the shared 30-second drain"
    fi
    attempts=$((attempts - 1))
    if ((attempts == 0)); then
      kill "${pid}" >/dev/null 2>&1 || true
      cat "${log_file}" >&2
      fail "${label} did not exit within 30 seconds"
    fi
    sleep 0.1
  done
  if [[ -n "${deadline_ms}" ]]; then
    require_before_deadline "${deadline_ms}" "${label} completion"
  fi
  if wait "${pid}"; then
    return 0
  else
    status=$?
  fi
  cat "${log_file}" >&2
  fail "${label} exited ${status}"
}

stop_test_helpers() {
  if [[ -n "${acceptance_client_pid}" ]]; then
    kill "${acceptance_client_pid}" >/dev/null 2>&1 || true
    wait "${acceptance_client_pid}" >/dev/null 2>&1 || true
    acceptance_client_pid=
  fi
  if [[ -n "${load_client_pid}" ]]; then
    kill "${load_client_pid}" >/dev/null 2>&1 || true
    wait "${load_client_pid}" >/dev/null 2>&1 || true
    load_client_pid=
  fi
  if [[ -n "${mock_mud_pid}" ]]; then
    kill "${mock_mud_pid}" >/dev/null 2>&1 || true
    wait "${mock_mud_pid}" >/dev/null 2>&1 || true
    mock_mud_pid=
  fi
  if [[ -n "${firewall_table_created}" ]]; then
    nft delete table inet mwp_105_acceptance
    firewall_table_created=
  fi
  remove_test_host_mapping
}

prepare_reboot() {
  local install_boot_id
  local resume_staging

  systemctl enable mud-web-proxy.service caddy.service
  systemctl is-enabled --quiet mud-web-proxy.service
  systemctl is-enabled --quiet caddy.service
  systemctl is-active --quiet mud-web-proxy.service
  systemctl is-active --quiet caddy.service
  systemctl status mud-web-proxy.service caddy.service --no-pager \
    >"${EVIDENCE_DIR}/pre-reboot-status.txt"
  journalctl -u mud-web-proxy.service -u caddy.service \
    --since "${RUN_STARTED}" --no-pager \
    >"${EVIDENCE_DIR}/pre-reboot-journal.txt"
  install_boot_id="$(</proc/sys/kernel/random/boot_id)"
  [[ "${install_boot_id}" =~ \
    ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    fail 'install boot ID is invalid'
  printf '%s\n' "${install_boot_id}" \
    >"${EVIDENCE_DIR}/install-boot-id"
  chmod 0600 "${EVIDENCE_DIR}/install-boot-id"

  resume_staging="$(mktemp /root/.mwp-105-acceptance-resume.XXXXXX)"
  printf '%s\n' "${EVIDENCE_DIR}" >"${resume_staging}"
  chown root:root "${resume_staging}"
  chmod 0600 "${resume_staging}"
  mv -Tf "${resume_staging}" "${RESUME_FILE}"

  stop_test_helpers
  trap - EXIT INT TERM
  echo "systemd-acceptance: evidence ${EVIDENCE_DIR}"
  echo 'systemd-acceptance: reboot required'
}

verify_post_reboot() {
  local caddy_ca
  local current_boot_id
  local evidence_complete
  local install_boot_id
  local resume_evidence

  [[ "${EUID}" -eq 0 ]] || fail 'must run as root'
  [[ -f "${RESUME_FILE}" && ! -L "${RESUME_FILE}" ]] ||
    fail 'root-only acceptance resume file is missing'
  [[ "$(stat -c '%a %U:%G' "${RESUME_FILE}")" == '600 root:root' ]] ||
    fail 'acceptance resume file owner or mode is wrong'
  [[ "$(wc -l <"${RESUME_FILE}")" -eq 1 ]] ||
    fail 'acceptance resume file is malformed'
  resume_evidence="$(<"${RESUME_FILE}")"
  [[ "${resume_evidence}" == /root/mwp-105-evidence-* &&
    -d "${resume_evidence}" &&
    ! -L "${resume_evidence}" ]] ||
    fail 'acceptance resume path is invalid'
  [[ "$(stat -c '%a %U:%G' "${resume_evidence}")" == '700 root:root' ]] ||
    fail 'acceptance evidence directory owner or mode is wrong'
  [[ -f "${resume_evidence}/install-boot-id" &&
    ! -L "${resume_evidence}/install-boot-id" ]] ||
    fail 'persisted install boot ID is missing'
  [[ "$(stat -c '%a %U:%G' "${resume_evidence}/install-boot-id")" == \
    '600 root:root' ]] ||
    fail 'persisted install boot ID owner or mode is wrong'
  install_boot_id="$(<"${resume_evidence}/install-boot-id")"
  current_boot_id="$(</proc/sys/kernel/random/boot_id)"
  [[ "${install_boot_id}" =~ \
    ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ &&
    "${current_boot_id}" =~ \
    ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    fail 'boot ID evidence is invalid'
  [[ "${install_boot_id}" != "${current_boot_id}" ]] ||
    fail 'post-reboot phase requires a different boot ID'

  systemctl is-enabled --quiet mud-web-proxy.service
  systemctl is-enabled --quiet caddy.service
  systemctl is-active --quiet mud-web-proxy.service
  systemctl is-active --quiet caddy.service
  wait_for_health 200 'http://127.0.0.1:6200/health'
  caddy_ca="${resume_evidence}/caddy-local-root.crt"
  [[ -s "${caddy_ca}" ]] || fail 'persisted Caddy CA is missing'
  wait_for_https_health "${caddy_ca}"

  verify_loopback_listener "${resume_evidence}"
  systemctl status mud-web-proxy.service caddy.service --no-pager \
    >"${resume_evidence}/post-reboot-status.txt"
  journalctl -b -u mud-web-proxy.service -u caddy.service --no-pager \
    >"${resume_evidence}/post-reboot-journal.txt"
  ss -ltnp >"${resume_evidence}/post-reboot-sockets.txt"
  evidence_complete="${resume_evidence}/evidence-complete"
  printf 'systemd acceptance complete after reboot\n' >"${evidence_complete}"
  chmod 0600 "${evidence_complete}"
  echo "systemd-acceptance: evidence ${resume_evidence}"
  echo 'systemd-acceptance: evidence complete'
}

run_acceptance_client() {
  local log_file="$1"

  env \
    PROXY_HTTP_URL=http://127.0.0.1:6200 \
    PROXY_WS_URL=wss://localhost \
    CADDY_CA_PATH="${EVIDENCE_DIR}/caddy-local-root.crt" \
    MUD_HOST="${TEST_MUD_NAME}" \
    MUD_PORT="${TEST_MUD_PORT}" \
    "${acceptance_node_bin}" \
    "${NODE_ACCEPTANCE_CLIENT_ROOT}/systemd-acceptance-client.js" \
    >"${log_file}" 2>&1 &
  acceptance_client_pid=$!
}

case "${ACCEPTANCE_PHASE}" in
  install | post-reboot) ;;
  *) fail "unsupported MWP_ACCEPTANCE_PHASE: ${ACCEPTANCE_PHASE}" ;;
esac

case "${SECURITY_MODE}" in
  measure | verify) ;;
  *) fail "unsupported MWP_SECURITY_MODE: ${SECURITY_MODE}" ;;
esac

if [[ "${ACCEPTANCE_PHASE}" == post-reboot ]]; then
  verify_post_reboot
  exit 0
fi

# This check deliberately precedes the privilege check so ordinary CI can
# exercise the destructive-host acknowledgement without becoming root.
[[ "${MWP_DISPOSABLE_VM_ACK:-}" == \
  'ERASE THIS CLEAN UBUNTU 26.04 VM' ]] ||
  fail 'set the exact disposable VM acknowledgement'
require_disposable_host

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -m 0700 "${EVIDENCE_DIR}"
chown root:root "${EVIDENCE_DIR}"
{
  printf 'run-started=%s\n' "${RUN_STARTED}"
  printf 'architecture=%s\n' "$(uname -m)"
  printf 'kernel=%s\n' "$(uname -r)"
  printf 'os-release=%s\n' "$(< /etc/os-release)"
} >"${EVIDENCE_DIR}/host.txt"

install_caddy
install_identity_and_unit
install_test_release
install_node_acceptance_runtime
install_test_state
render_test_environment
render_caddy
systemd-analyze verify /etc/systemd/system/mud-web-proxy.service \
  >"${EVIDENCE_DIR}/systemd-verify.txt" 2>&1
if [[ "${SECURITY_MODE}" == measure ]]; then
  measure_security
else
  verify_security
fi
start_mock_mud

systemctl start mud-web-proxy.service
wait_for_health 200 'http://127.0.0.1:6200/health'
verify_loopback_listener

systemctl start caddy.service
for _attempt in {1..300}; do
  [[ -s /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt ]] &&
    break
  sleep 0.1
done
[[ -s /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt ]] ||
  fail 'Caddy local root CA was not created'
install -o root -g root -m 0600 \
  /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt \
  "${EVIDENCE_DIR}/caddy-local-root.crt"
wait_for_https_health "${EVIDENCE_DIR}/caddy-local-root.crt"

run_acceptance_client "${EVIDENCE_DIR}/acceptance-client.log"
wait_for_marker "${EVIDENCE_DIR}/acceptance-client.log" \
  'systemd-acceptance-client: spoof-probe-ready' 300
journalctl -u mud-web-proxy.service --since "${RUN_STARTED}" --no-pager \
  >"${EVIDENCE_DIR}/spoof-probe-journal.txt"
grep -Eq 'Upgrade request peer=(127\.0\.0\.1|::1)([[:space:]]|$)' \
  "${EVIDENCE_DIR}/spoof-probe-journal.txt" ||
  fail 'spoof probe journal omitted the actual local peer'
if grep -Eq '198\.51\.100\.77|203\.0\.113\.88' \
  "${EVIDENCE_DIR}/spoof-probe-journal.txt"; then
  fail 'Caddy passed a spoofed client address to the proxy'
fi

main_pid="$(systemctl show -p MainPID --value mud-web-proxy.service)"
control_group="$(
  systemctl show -p ControlGroup --value mud-web-proxy.service
)"
memory_events="/sys/fs/cgroup${control_group}/memory.events"
parent_control_group="${control_group%/*}"
parent_memory_events="/sys/fs/cgroup${parent_control_group}/memory.events"
[[ "${main_pid}" =~ ^[1-9][0-9]*$ &&
  "${parent_control_group}" != "${control_group}" &&
  -f "${memory_events}" &&
  -f "${parent_memory_events}" ]] ||
  fail 'could not resolve the running service cgroup'
cp "${memory_events}" "${EVIDENCE_DIR}/memory-events-unit-before.txt"
cp "${parent_memory_events}" "${EVIDENCE_DIR}/memory-events-before.txt"
printf 'unit=%s\nparent=%s\n' "${control_group}" "${parent_control_group}" \
  >"${EVIDENCE_DIR}/memory-events-cgroups.txt"

env \
  SESSION_COUNT="${SESSION_COUNT}" \
  SUSTAIN_MS="${SUSTAIN_MS}" \
  PROXY_WS_URL=wss://localhost \
  CADDY_CA_PATH="${EVIDENCE_DIR}/caddy-local-root.crt" \
  MUD_HOST="${TEST_MUD_NAME}" \
  MUD_PORT="${TEST_MUD_PORT}" \
  "${acceptance_node_bin}" \
  "${NODE_ACCEPTANCE_CLIENT_ROOT}/systemd-load-client.js" \
  >"${EVIDENCE_DIR}/load-client.log" 2>&1 &
load_client_pid=$!
wait_for_marker "${EVIDENCE_DIR}/load-client.log" \
  'systemd-load-client: 50 sessions ready' 300
wait_for_marker "${EVIDENCE_DIR}/load-client.log" \
  'systemd-load-client: sustained' 800

capture_resource_evidence
verify_mount_boundary

drain_deadline_ms=$(( $(monotonic_milliseconds) + 30000 ))
systemctl kill --signal=TERM mud-web-proxy.service
wait_for_health 503 'http://127.0.0.1:6200/health' "${drain_deadline_ms}"
wait_for_background_client "${acceptance_client_pid}" \
  'acceptance client' "${EVIDENCE_DIR}/acceptance-client.log" \
  "${drain_deadline_ms}"
acceptance_client_pid=
wait_for_background_client "${load_client_pid}" \
  'load client' "${EVIDENCE_DIR}/load-client.log" "${drain_deadline_ms}"
load_client_pid=
wait_for_inactive mud-web-proxy.service "${drain_deadline_ms}"
require_before_deadline "${drain_deadline_ms}" 'drain assertions'
capture_terminal_memory_events
grep -Fq 'systemd-acceptance-client: ca-loaded' \
  "${EVIDENCE_DIR}/acceptance-client.log"
grep -Fq 'systemd-acceptance-client: graceful-close-observed' \
  "${EVIDENCE_DIR}/acceptance-client.log"
grep -Fq 'systemd-load-client: graceful-close-observed' \
  "${EVIDENCE_DIR}/load-client.log"
verify_memory_events
[[ "$(stat -c '%a %U:%G' "${STATE_DIR}")" == \
  '700 mud-web-proxy:mud-web-proxy' ]] ||
  fail 'state directory owner or mode changed'
[[ "$(stat -c '%a %U:%G' "${STATE_DIR}/attested-keys.json")" == \
  '600 mud-web-proxy:mud-web-proxy' ]] ||
  fail 'App Attest state owner or mode changed'
STATE_PATH="${STATE_DIR}/attested-keys.json" \
  "${INSTALL_ROOT}/current/runtime/bin/bun" -e '
    const value = await Bun.file(Bun.env.STATE_PATH).json();
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("state root is not an object");
    }
  '

systemctl start mud-web-proxy.service
wait_for_health 200 'http://127.0.0.1:6200/health'
run_acceptance_client "${EVIDENCE_DIR}/restart-wss-client.log"
wait_for_marker "${EVIDENCE_DIR}/restart-wss-client.log" \
  'systemd-acceptance-client: spoof-probe-ready' 300
kill "${acceptance_client_pid}"
wait "${acceptance_client_pid}" >/dev/null 2>&1 || true
acceptance_client_pid=

systemctl stop caddy.service
wait_for_inactive caddy.service
systemctl start caddy.service
wait_for_https_health "${EVIDENCE_DIR}/caddy-local-root.crt"

systemctl stop mud-web-proxy.service
wait_for_inactive mud-web-proxy.service
systemctl start mud-web-proxy.service
wait_for_health 200 'http://127.0.0.1:6200/health'
verify_loopback_listener
wait_for_https_health "${EVIDENCE_DIR}/caddy-local-root.crt"

verify_logs
prepare_reboot
