#!/usr/bin/env bash
set -euo pipefail

readonly BUN_IMAGE='oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4'
readonly IMAGE='mud-web-proxy:test'
readonly PREFIX="mwp-container-$$"
readonly NETWORK="${PREFIX}-network"
readonly MOCK_CONTAINER="${PREFIX}-mud"
readonly PROXY_CONTAINER="${PREFIX}-proxy"
readonly CLIENT_CONTAINER="${PREFIX}-client"
readonly NO_STATE_CONTAINER="${PREFIX}-no-state"
readonly CLIENT_DEPS="${PREFIX}-client-deps"
readonly STATE_VOLUME="${PREFIX}-state"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
state_volume_created=0

fail() {
  for container in \
    "${CLIENT_CONTAINER}" \
    "${PROXY_CONTAINER}" \
    "${MOCK_CONTAINER}" \
    "${NO_STATE_CONTAINER}"; do
    if docker container inspect "${container}" >/dev/null 2>&1; then
      echo "container-acceptance: logs: ${container}" >&2
      docker logs "${container}" >&2 || true
    fi
  done
  echo "container-acceptance: $*" >&2
  exit 1
}

cleanup() {
  docker rm -f \
    "${CLIENT_CONTAINER}" \
    "${PROXY_CONTAINER}" \
    "${MOCK_CONTAINER}" \
    "${NO_STATE_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  docker volume rm "${CLIENT_DEPS}" >/dev/null 2>&1 || true
  if ((state_volume_created == 1)); then
    docker volume rm "${STATE_VOLUME}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_log() {
  local container="$1"
  local marker="$2"
  local attempts=100
  while ((attempts > 0)); do
    if docker logs "${container}" 2>&1 | grep -Fq "${marker}"; then
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "${container}")" != true ]]; then
      docker logs "${container}" >&2
      fail "${container} exited before ${marker}"
    fi
    sleep 0.1
    attempts=$((attempts - 1))
  done
  docker logs "${container}" >&2
  fail "timed out waiting for ${marker}"
}

prepare_helper_deps() {
  local volume="$1"
  docker volume create "${volume}" >/dev/null
  docker run --rm \
    --mount "type=bind,source=${REPO_ROOT}/package.json,target=/workspace/package.json,readonly" \
    --mount "type=bind,source=${REPO_ROOT}/bun.lock,target=/workspace/bun.lock,readonly" \
    --mount "type=volume,source=${volume},target=/workspace/node_modules" \
    --workdir /workspace \
    "${BUN_IMAGE}" \
    bun install --frozen-lockfile --production
}

if docker volume inspect "${STATE_VOLUME}" >/dev/null 2>&1; then
  fail "refusing to reuse existing volume ${STATE_VOLUME}"
fi

# Platform is overridable so CI can build amd64 on pull requests and both
# architectures on tags. Unset means the host architecture, which keeps local
# runs fast — arm64 under QEMU costs minutes, not seconds.
if [[ -n "${MWP_BUILD_PLATFORMS:-}" ]]; then
  docker buildx build --pull --load \
    --platform "${MWP_BUILD_PLATFORMS}" \
    --tag "${IMAGE}" "${REPO_ROOT}"
else
  docker build --pull --tag "${IMAGE}" "${REPO_ROOT}"
fi

[[ "$(docker image inspect "${IMAGE}" --format '{{.Config.User}}')" == '10001:10001' ]]
[[ "$(docker image inspect "${IMAGE}" --format '{{json .Config.Entrypoint}}')" == '["bun","dist/wsproxy.js"]' ]]
[[ "$(docker image inspect "${IMAGE}" --format '{{json .Config.Cmd}}')" == 'null' ]]
[[ "$(docker image inspect "${IMAGE}" --format '{{.Config.StopSignal}}')" == 'SIGTERM' ]]
[[ "$(docker image inspect "${IMAGE}" --format '{{json .Config.ExposedPorts}}')" == 'null' ]]
[[ "$(docker image inspect "${IMAGE}" --format '{{json .Config.Healthcheck}}')" == 'null' ]]
[[ "$(docker image inspect "${IMAGE}" --format '{{json .Config.Volumes}}')" == 'null' ]]

docker run --rm --entrypoint sh "${IMAGE}" -ec '
  test -f /opt/mud-web-proxy/dist/wsproxy.js
  test "$(stat -c "%u:%g %a" /opt/mud-web-proxy/config/apple-app-attest-root-ca.pem)" = "0:0 444"
  test "$(sha256sum /opt/mud-web-proxy/config/apple-app-attest-root-ca.pem | cut -d " " -f 1)" = "c778d09ac341f7fd9f8f3b19e2b815af6aed4ad4490e1e92c05cb355212a5013"
  bun -e "await import(\"cbor-x\"); await import(\"iconv-lite\"); await import(\"ws\")"
  for path in \
    /opt/mud-web-proxy/src \
    /opt/mud-web-proxy/tests \
    /opt/mud-web-proxy/scripts \
    /opt/mud-web-proxy/docs \
    /opt/mud-web-proxy/wsproxy.ts \
    /opt/mud-web-proxy/tsconfig.json \
    /opt/mud-web-proxy/node_modules/esbuild \
    /opt/mud-web-proxy/node_modules/typescript
  do
    test ! -e "${path}"
  done
  test -z "$(find /opt/mud-web-proxy -type f \( -name cert.pem -o -name privkey.pem \) -print -quit)"
'

docker run --detach \
  --name "${NO_STATE_CONTAINER}" \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --env INBOUND_TLS_MODE=off \
  --env SHUTDOWN_GRACE_MS=1 \
  --env SHUTDOWN_DEADLINE_MS=3000 \
  "${IMAGE}" >/dev/null
wait_for_log "${NO_STATE_CONTAINER}" 'server listening:'
docker kill --signal=TERM "${NO_STATE_CONTAINER}" >/dev/null
no_state_status="$(timeout 5s docker wait "${NO_STATE_CONTAINER}")" ||
  fail 'disabled App Attest shutdown exceeded its deadline'
[[ "${no_state_status}" == 0 ]] ||
  fail "disabled App Attest proxy exited ${no_state_status}"
no_state_logs="$(docker logs "${NO_STATE_CONTAINER}" 2>&1)"
grep -Fq 'shutdown: completed' <<<"${no_state_logs}" ||
  fail 'disabled App Attest shutdown did not complete'
if grep -Eiq 'EROFS|read-only file system|shutdown: .* failed:' <<<"${no_state_logs}"; then
  printf '%s\n' "${no_state_logs}" >&2
  fail 'disabled App Attest wrote to the read-only root'
fi

docker volume create "${STATE_VOLUME}" >/dev/null
state_volume_created=1
docker run --rm \
  --mount "type=volume,source=${STATE_VOLUME},target=/var/lib/mud-web-proxy" \
  --entrypoint bun \
  "${IMAGE}" \
  -e '
    import fs from "fs";
    import path from "path";
    const dir = "/var/lib/mud-web-proxy";
    const staging = fs.mkdtempSync(path.join(dir, ".attested-keys-"));
    const temporary = path.join(staging, "keys.json");
    const live = path.join(dir, "attested-keys.json");
    fs.writeFileSync(temporary, "{}\n", { flag: "wx" });
    fs.renameSync(temporary, live);
    fs.rmSync(staging, { recursive: true });
  '

prepare_helper_deps "${CLIENT_DEPS}"
docker network create "${NETWORK}" >/dev/null

docker run --detach \
  --name "${MOCK_CONTAINER}" \
  --network "${NETWORK}" \
  --network-alias mwp-test-mud \
  --mount "type=bind,source=${REPO_ROOT},target=/repo,readonly" \
  --workdir /repo \
  "${BUN_IMAGE}" \
  bun /repo/tests/e2e/mock-mud.ts 6300 generic >/dev/null
wait_for_log "${MOCK_CONTAINER}" 'listening on port 6300'

docker run --detach \
  --name "${PROXY_CONTAINER}" \
  --network "${NETWORK}" \
  --network-alias mwp-test-proxy \
  --publish 127.0.0.1::6200 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --mount "type=volume,source=${STATE_VOLUME},target=/var/lib/mud-web-proxy" \
  --env BIND_HOST=0.0.0.0 \
  --env INBOUND_TLS_MODE=off \
  --env ALLOW_INSECURE_INBOUND_NO_TLS=true \
  --env TARGET_MODE=fixed \
  --env MUD_TLS_MODE=plain \
  --env TN_HOST=mwp-test-mud \
  --env TN_PORT=6300 \
  --env SHUTDOWN_GRACE_MS=3000 \
  --env SHUTDOWN_DEADLINE_MS=10000 \
  --env APPATTEST_BUNDLE_ID=com.example.mwp-container-test \
  --env APPATTEST_TEAM_ID=MWPTESTTEAM \
  "${IMAGE}" >/dev/null

host_port="$(docker port "${PROXY_CONTAINER}" 6200/tcp | awk -F: 'NR == 1 { print $NF }')"
[[ -n "${host_port}" ]] || fail 'Docker did not publish the undeclared app port'

attempts=100
until [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:${host_port}/health" || true)" == 200 ]]; do
  attempts=$((attempts - 1))
  ((attempts > 0)) || fail 'proxy did not become healthy'
  sleep 0.1
done

docker run --detach \
  --name "${CLIENT_CONTAINER}" \
  --network "${NETWORK}" \
  --mount "type=bind,source=${REPO_ROOT},target=/repo,readonly" \
  --mount "type=bind,source=${REPO_ROOT}/tests/container/acceptance-client.ts,target=/home/bun/app/acceptance-client.ts,readonly" \
  --mount "type=volume,source=${CLIENT_DEPS},target=/home/bun/app/node_modules" \
  --workdir /home/bun/app \
  "${BUN_IMAGE}" \
  bun /home/bun/app/acceptance-client.ts >/dev/null
wait_for_log "${CLIENT_CONTAINER}" 'container-acceptance: session-ready'

docker kill --signal=TERM "${PROXY_CONTAINER}" >/dev/null

attempts=25
until [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:${host_port}/health" || true)" == 503 ]]; do
  attempts=$((attempts - 1))
  ((attempts > 0)) || fail 'proxy did not report 503 during drain'
  sleep 0.1
done

proxy_status="$(timeout 10s docker wait "${PROXY_CONTAINER}")" ||
  fail 'proxy exceeded the shutdown deadline'
[[ "${proxy_status}" == 0 ]] || fail "proxy exited ${proxy_status}"

client_status="$(timeout 5s docker wait "${CLIENT_CONTAINER}")" ||
  fail 'acceptance client did not observe proxy shutdown'
[[ "${client_status}" == 0 ]] || {
  docker logs "${CLIENT_CONTAINER}" >&2
  fail "acceptance client exited ${client_status}"
}

proxy_logs="$(docker logs "${PROXY_CONTAINER}" 2>&1)"
grep -Fq 'shutdown: completed' <<<"${proxy_logs}" ||
  fail 'shutdown completion was not logged'
grep -Fq 'peer disconnected: code=1001 reason=Server restarting' <<<"${proxy_logs}" ||
  fail 'proxy did not use the graceful restart close code'
if grep -Eiq 'EROFS|read-only file system|shutdown: .* failed:' <<<"${proxy_logs}"; then
  printf '%s\n' "${proxy_logs}" >&2
  fail 'proxy swallowed a filesystem or shutdown-step failure'
fi

docker run --rm \
  --mount "type=volume,source=${STATE_VOLUME},target=/var/lib/mud-web-proxy" \
  --entrypoint sh \
  "${IMAGE}" \
  -ec '
    test "$(stat -c "%s" /var/lib/mud-web-proxy/attested-keys.json)" = 2
    test "$(cat /var/lib/mud-web-proxy/attested-keys.json)" = "{}"
    test -z "$(find /var/lib/mud-web-proxy -mindepth 1 -maxdepth 1 \
      -type d -name ".attested-keys-*" -print -quit)"
  '

client_logs="$(docker logs "${CLIENT_CONTAINER}" 2>&1)"
grep -Fq 'container-acceptance: ca-loaded' <<<"${client_logs}"
grep -Fq 'container-acceptance: proxy-closed' <<<"${client_logs}"

echo 'container-acceptance: passed'
