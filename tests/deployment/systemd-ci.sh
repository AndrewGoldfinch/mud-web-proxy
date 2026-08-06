#!/usr/bin/env bash
#
# Prove the native systemd path from the real release bundle.
#
# The Compose path gained CI coverage in MWP-119; this is its counterpart. The
# systemd path is the more fragile of the two, because it depends on filesystem
# layout, ownership, and unit-file correctness — three things that are easy to
# get subtly wrong and that fail only on a clean machine, never on the
# developer's.
#
# Deliberately not `run-systemd-acceptance.sh`. That harness is the MWP-105
# production acceptance: fifty sessions, a sustained load window, resource
# sampling, and provider evidence collection. It belongs on a disposable
# droplet, not on a CI runner. This runs the parts that answer "did the
# deployment break" and nothing else.
#
# Requires root and systemd as PID 1. GitHub-hosted Ubuntu runners have both.
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly INSTALL_ROOT=/opt/mud-web-proxy
readonly ENV_FILE=/etc/mud-web-proxy.env
readonly STATE_DIR=/var/lib/mud-web-proxy
readonly UNIT=/etc/systemd/system/mud-web-proxy.service
readonly SERVICE=mud-web-proxy.service
readonly BASELINE="${REPO_ROOT}/tests/deployment/systemd-security-baseline.json"
readonly WS_PORT=6200
readonly MUD_PORT=6455

mud_pid=

fail() {
  echo "systemd-ci: $*" >&2
  systemctl status "${SERVICE}" --no-pager -l 2>&1 | tail -20 >&2 || true
  journalctl -u "${SERVICE}" --no-pager -o cat 2>/dev/null | tail -30 >&2 || true
  exit 1
}

cleanup() {
  if [[ -n "${mud_pid}" ]]; then kill "${mud_pid}" 2>/dev/null || true; fi
  systemctl stop "${SERVICE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

need_root() {
  [[ "$(id -u)" -eq 0 ]] || fail 'must run as root'
  [[ "$(ps -p 1 -o comm=)" == systemd ]] || fail 'systemd is not PID 1'
}

# --- install one release into the documented layout -------------------------
install_release() {
  local version="$1" tarball="$2"
  local dir="${INSTALL_ROOT}/releases/mud-web-proxy-${version}"
  rm -rf "${dir}"
  mkdir -p "${INSTALL_ROOT}/releases"
  tar xzf "${tarball}" -C "${INSTALL_ROOT}/releases/"
  # The unit's ExecStart points at a runtime inside the release, so each
  # release carries its own interpreter. That is what makes rollback total
  # rather than partial.
  mkdir -p "${dir}/runtime/bin"
  cp "$(command -v bun)" "${dir}/runtime/bin/bun"
  echo "${dir}"
}

activate() {
  # Atomic swap, exactly as deployment/systemd.md documents. A plain
  # `ln -sfn` onto an existing symlink is not atomic.
  ln -sfn "$1" "${INSTALL_ROOT}/current.new"
  mv -T "${INSTALL_ROOT}/current.new" "${INSTALL_ROOT}/current"
}

live_version() {
  curl -fsS --max-time 10 "http://127.0.0.1:${WS_PORT}/health" |
    grep -oE '"version":"[^"]*"' | cut -d'"' -f4
}

wait_healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:${WS_PORT}/health"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

need_root
cd "${REPO_ROOT}"

echo 'systemd-ci: building the real release bundle'
bun install --frozen-lockfile >/dev/null 2>&1 || fail 'install failed'
bun run build >/dev/null || fail 'build failed'
bun scripts/build-release-bundle.ts release >/dev/null || fail 'bundle failed'
BASE_VERSION="$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null ||
  grep -m1 '"version"' package.json | cut -d'"' -f4)"
BUNDLE="${REPO_ROOT}/release/mud-web-proxy-${BASE_VERSION}.tar.gz"
[[ -f "${BUNDLE}" ]] || fail "bundle not found at ${BUNDLE}"

echo 'systemd-ci: installing into the documented layout'
id -u mud-web-proxy >/dev/null 2>&1 || useradd --system \
  --home-dir "${STATE_DIR}" --shell /usr/sbin/nologin mud-web-proxy
mkdir -p "${STATE_DIR}" /var/lib/mud-web-proxy-deploy
chown -R mud-web-proxy:mud-web-proxy "${STATE_DIR}"
FIRST_DIR="$(install_release "${BASE_VERSION}" "${BUNDLE}")"
activate "${FIRST_DIR}"

# ALLOWED_ORIGINS is commented out rather than pointed somewhere: the test
# client is a bare WebSocket and cannot set an Origin header, so any value
# would reject it. Origin policy has its own coverage in
# tests/origin-checking.test.ts; this job is about deployment mechanics.
sed -e "s/^TN_HOST=.*/TN_HOST=127.0.0.1/" \
  -e "s/^TN_PORT=.*/TN_PORT=${MUD_PORT}/" \
  -e "s/^ALLOWED_ORIGINS=/#ALLOWED_ORIGINS=/" \
  config/mud-web-proxy.env.systemd.example >"${ENV_FILE}"
chown root:mud-web-proxy "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"
cp deploy/systemd/mud-web-proxy.service "${UNIT}"
systemctl daemon-reload

# --- 1. the unit is well formed ---------------------------------------------
# Run after installing, not before: verify resolves ExecStart and reports a
# missing interpreter as an error, so on an empty machine it always fails.
#
# Two traps here, both found by testing this against a real host:
#
#   * verify exits 0 even for a bogus directive — it only warns. Gating on the
#     exit code would produce a check that can never fail.
#   * it also reports on unrelated units the OS ships (xfs_scrub_all and
#     friends), so "output must be empty" fails on noise that is nothing to do
#     with us.
#
# So: filter to lines naming our unit, and fail if any survive. Verified to
# fail by appending a nonsense directive.
echo 'systemd-ci: systemd-analyze verify'
verify_out="$(systemd-analyze verify "${UNIT}" 2>&1 || true)"
ours="$(grep -F "${UNIT}" <<<"${verify_out}" || true)"
[[ -z "${ours}" ]] || fail "systemd-analyze verify reported problems in our unit:
${ours}"

# --- 2. hardening has not regressed -----------------------------------------
# Threshold comes from the checked-in baseline rather than a literal here, so
# there is one place to change it and it cannot drift from the recorded
# measurement.
THRESHOLD="$(grep -oE '"maximumExposure"[[:space:]]*:[[:space:]]*[0-9.]+' "${BASELINE}" |
  grep -oE '[0-9.]+$')"
[[ -n "${THRESHOLD}" ]] || fail 'could not read maximumExposure from the baseline'
EXPOSURE="$(systemd-analyze security --offline=true --no-pager "${UNIT}" 2>/dev/null |
  grep -oE 'Overall exposure level for .*: [0-9.]+' | grep -oE '[0-9.]+$')"
[[ -n "${EXPOSURE}" ]] || fail 'could not read the exposure level'
echo "systemd-ci: exposure ${EXPOSURE}, threshold ${THRESHOLD}"
awk -v e="${EXPOSURE}" -v t="${THRESHOLD}" 'BEGIN { exit !(e <= t) }' ||
  fail "exposure ${EXPOSURE} exceeds the agreed threshold ${THRESHOLD}"

# --- 3. it starts, serves, and talks to a MUD -------------------------------
echo 'systemd-ci: starting the mock MUD'
bun tests/compose/mock-target.ts "${MUD_PORT}" >/tmp/mwp-mock.log 2>&1 &
mud_pid=$!
sleep 2

echo 'systemd-ci: starting the service'
systemctl start "${SERVICE}" || fail 'service failed to start'
wait_healthy || fail '/health never answered'
[[ "$(live_version)" == "${BASE_VERSION}" ]] ||
  fail "served version $(live_version), expected ${BASE_VERSION}"

echo 'systemd-ci: a session reaches the MUD'
bun tests/deployment/systemd-ci-session.ts "${WS_PORT}" "${MUD_PORT}" ||
  fail 'session through the service failed'

# --- 4. loopback only --------------------------------------------------------
echo 'systemd-ci: the listener is loopback-only'
# Field 4 is the LOCAL address. The peer column is `0.0.0.0:*` for any
# listener — matching the whole line treats that as a wildcard bind and fails
# a perfectly correct loopback listener. Cost one round on a real host.
listen="$(ss -ltnH "sport = :${WS_PORT}" | awk '{print $4}')"
[[ -n "${listen}" ]] || fail "nothing is listening on ${WS_PORT}"
grep -qE '^(127\.0\.0\.1|\[::1\]):' <<<"${listen}" ||
  fail "listener is not loopback-only: ${listen}"
# An `if`, not `grep -q ... && fail`: that form returns nonzero when grep
# finds nothing, which is the passing case, and `set -e` then kills the script
# silently mid-run. Cost one debugging round on a real host.
if grep -qE '^(0\.0\.0\.0|\[::\]|\*):' <<<"${listen}"; then
  fail "listener is bound to a wildcard address: ${listen}"
fi

# --- 5. graceful stop, not a timeout kill ------------------------------------
echo 'systemd-ci: graceful shutdown'
cursor="$(journalctl -u "${SERVICE}" -n 0 --show-cursor -q | sed -n 's/^-- cursor: //p')"
systemctl stop "${SERVICE}" || fail 'stop failed'
stop_logs="$(journalctl -u "${SERVICE}" --after-cursor "${cursor}" --no-pager -o cat 2>/dev/null)"
grep -q 'shutdown: completed' <<<"${stop_logs}" ||
  fail "graceful shutdown did not complete:
${stop_logs}"
if grep -qiE 'killed|SIGKILL|Timed out stopping' <<<"${stop_logs}"; then
  fail "the service was killed rather than drained:
${stop_logs}"
fi

# --- 6. upgrade and rollback via the documented symlink swap ------------------
echo 'systemd-ci: upgrade and rollback'
UPGRADE_VERSION="${BASE_VERSION}-ci-upgrade"
UP_TARBALL="${REPO_ROOT}/release/mud-web-proxy-${UPGRADE_VERSION}.tar.gz"
# A real second build, not a copied directory: the version /health reports is
# compiled into dist/wsproxy.js, so a copied release would report the old one
# and the swap would look like it had done nothing (learned in MWP-114).
#
# Restore package.json from a copy rather than `git checkout`: CI may hand this
# script a source tree with no .git directory, and a failed restore would leave
# the working copy pinned to a fake version.
cp "${REPO_ROOT}/package.json" "${REPO_ROOT}/package.json.systemd-ci.bak"
restore_package_json() {
  if [[ -f "${REPO_ROOT}/package.json.systemd-ci.bak" ]]; then
    mv -f "${REPO_ROOT}/package.json.systemd-ci.bak" "${REPO_ROOT}/package.json"
  fi
}
trap 'restore_package_json; cleanup' EXIT

python3 - "$REPO_ROOT" "$UPGRADE_VERSION" <<'PY'
import json, sys, pathlib
root, ver = sys.argv[1], sys.argv[2]
p = pathlib.Path(root) / 'package.json'
d = json.loads(p.read_text()); d['version'] = ver
p.write_text(json.dumps(d, indent=2) + '\n')
PY
bun run build >/dev/null || fail 'upgrade build failed'
bun scripts/build-release-bundle.ts release >/dev/null || fail 'upgrade bundle failed'
restore_package_json
bun run build >/dev/null || fail 'restore build failed'
[[ -f "${UP_TARBALL}" ]] || fail "upgrade bundle not found at ${UP_TARBALL}"

SECOND_DIR="$(install_release "${UPGRADE_VERSION}" "${UP_TARBALL}")"
activate "${SECOND_DIR}"
systemctl start "${SERVICE}" || fail 'service failed to start after upgrade'
wait_healthy || fail '/health never answered after upgrade'
[[ "$(live_version)" == "${UPGRADE_VERSION}" ]] ||
  fail "after upgrade served $(live_version), expected ${UPGRADE_VERSION}"

activate "${FIRST_DIR}"
systemctl restart "${SERVICE}" || fail 'service failed to start after rollback'
wait_healthy || fail '/health never answered after rollback'
[[ "$(live_version)" == "${BASE_VERSION}" ]] ||
  fail "after rollback served $(live_version), expected ${BASE_VERSION}"

systemctl stop "${SERVICE}"
echo 'systemd-ci: passed'
