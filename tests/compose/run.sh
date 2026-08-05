#!/usr/bin/env bash
#
# Prove a WebSocket session survives Caddy.
#
# This is the integration nothing else covers. tests/container/run.sh exercises
# the image directly and never involves Caddy; the unit suite cannot see a
# reverse proxy at all. The upgrade surviving the edge — and the proxy seeing
# the real client rather than Caddy — is exactly what breaks between releases
# and stays invisible until an operator follows the quickstart.
#
# The client-address assertion is the point of the whole script. Caddy's
# default is to *append* to a client-supplied X-Forwarded-For; the Caddyfile
# replaces it instead. If that regresses, the proxy attributes every connection
# to Caddy's container address, and per-IP limits, the per-address message-rate
# budget, and pending-dial reservations all silently stop working.
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly PROJECT='mwp-compose-smoke'
readonly MUD_PORT=6450
readonly COMPOSE=(docker compose -p "${PROJECT}" -f compose.yaml -f compose.test.yaml)

mud_pid=
CA_FILE="$(mktemp -t mwp-caddy-ca.XXXXXX.crt)"

fail() {
  echo "compose-e2e: $*" >&2
  echo '--- proxy logs ---' >&2
  "${COMPOSE[@]}" logs proxy 2>&1 | tail -30 >&2 || true
  exit 1
}

cleanup() {
  if [[ -n "${mud_pid}" ]]; then kill "${mud_pid}" 2>/dev/null || true; fi
  rm -f "${CA_FILE}"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo 'compose-e2e: SKIP (docker unavailable)'
  exit 0
fi

cd "${REPO_ROOT}"

# compose.yaml guards these with `:?`, so they must be set even for a test run.
export MWP_DOMAIN=localhost
export MWP_ACME_EMAIL=ci@example.invalid
export TN_HOST=host.docker.internal
export MWP_IMAGE=mud-web-proxy:test

echo 'compose-e2e: building the image'
docker build --pull --tag "${MWP_IMAGE}" "${REPO_ROOT}" >/dev/null ||
  fail 'image build failed'

echo 'compose-e2e: starting the mock MUD on the host'
bun tests/compose/mock-target.ts "${MUD_PORT}" &
mud_pid=$!
sleep 2

echo 'compose-e2e: bringing up the stack'
"${COMPOSE[@]}" up -d >/dev/null 2>&1 || fail 'compose up failed'

# Caddy generates its internal CA at startup. Extract it first, so every
# request below can validate the certificate instead of skipping the check.
ca_ready=
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" cp \
      caddy:/data/caddy/pki/authorities/local/root.crt "${CA_FILE}" >/dev/null 2>&1 &&
      [[ -s "${CA_FILE}" ]]; then
    ca_ready=1
    break
  fi
  sleep 2
done
[[ -n "${ca_ready}" ]] || fail 'Caddy never produced an internal root CA'

# NODE_EXTRA_CA_CERTS has to be set before the runtime starts, so it is
# exported here rather than inside the assertion script.
export NODE_EXTRA_CA_CERTS="${CA_FILE}"
export MWP_CADDY_CA="${CA_FILE}"

# Caddy issues the leaf on first request. Poll rather than sleeping a fixed
# interval, which is a bet on issuance always being fast.
ready=
for _ in $(seq 1 30); do
  if curl -s -o /dev/null --cacert "${CA_FILE}" "https://localhost/health" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
[[ -n "${ready}" ]] || fail 'Caddy never served /health'

echo 'compose-e2e: asserting through Caddy'
bun tests/compose/assert-through-caddy.ts || fail 'assertions failed'

echo 'compose-e2e: passed'
