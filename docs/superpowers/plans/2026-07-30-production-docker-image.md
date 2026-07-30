# Production Docker Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and continuously verify a minimal, digest-pinned, non-root
production image for `mud-web-proxy`.

**Architecture:** Five Docker stages keep development and production dependency
trees structurally separate before copying only the compiled bundle, production
dependencies, and public App Attest CA into the runtime image. A host-side Bash
harness uses separate pinned-Bun helper containers for the mock MUD and
acceptance client, while the image under test runs with a read-only root,
dropped capabilities, `no-new-privileges`, and only its named state volume.

**Tech Stack:** Docker Engine/BuildKit, Bun 1.3.14, TypeScript, esbuild, Bash,
GitHub Actions.

## Global Constraints

- Use
  `oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`
  for every image and helper stage.
- Preserve `.bun-version` and exact `package.json#engines.bun` value `1.3.14`.
- Preserve the existing esbuild `--packages=external` behavior.
- Keep `deps-dev` and `deps-prod` as independent Docker stages.
- Runtime UID/GID is exactly `10001:10001`.
- Runtime application root is `/opt/mud-web-proxy`.
- The bundle is `/opt/mud-web-proxy/dist/wsproxy.js`.
- The public CA is exactly
  `/opt/mud-web-proxy/config/apple-app-attest-root-ca.pem`, owned by `0:0`
  with mode `0444`.
- App Attest state is
  `/var/lib/mud-web-proxy/attested-keys.json`; mount the writable directory
  `/var/lib/mud-web-proxy`, never the JSON file.
- Do not add `EXPOSE`, `HEALTHCHECK`, or `VOLUME` to the image.
- Do not copy or mount repository source, tests, certificate keys, or helper
  code into the image under test.
- The supported Caddy topology must explicitly set `BIND_HOST=0.0.0.0`,
  `INBOUND_TLS_MODE=off`, and `ALLOW_INSECURE_INBOUND_NO_TLS=true`.
- Do not change the pre-existing fallback at `wsproxy.ts:1707`; the image's
  explicit `ATTESTED_KEYS_PATH` makes it unreachable, and correcting that
  application fallback is outside MWP-98.

---

### Task 1: Define and statically enforce the production image

**Files:**

- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `tests/docker-image-contract.test.ts`

**Interfaces:**

- Consumes: `package.json`, `bun.lock`, `tsconfig.json`, `wsproxy.ts`, `src/`,
  and `config/apple-app-attest-root-ca.pem`.
- Produces: final Docker stage `runtime`, whose default process is
  `bun dist/wsproxy.js` as `10001:10001`.
- Produces: static tests that prevent dependency-stage collapse, runtime copy
  expansion, private material leakage, and topology metadata from drifting.

- [ ] **Step 1: Write the failing Dockerfile contract test**

Create `tests/docker-image-contract.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '..');
const readRoot = (name: string): string =>
  readFileSync(path.join(repoRoot, name), 'utf8');

const stageBody = (dockerfile: string, stage: string): string => {
  const start = dockerfile.indexOf(` AS ${stage}\n`);
  if (start === -1) return '';
  const bodyStart = dockerfile.indexOf('\n', start) + 1;
  const next = dockerfile.indexOf('\nFROM ', bodyStart);
  return dockerfile.slice(bodyStart, next === -1 ? undefined : next);
};

describe('production Docker image contract', () => {
  test('pins Bun and keeps development and production installs separate', () => {
    const dockerfile = readRoot('Dockerfile');
    expect(dockerfile).toContain(
      'ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4',
    );
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(5);

    const dev = stageBody(dockerfile, 'deps-dev');
    const prod = stageBody(dockerfile, 'deps-prod');
    expect(dev).toContain('bun install --frozen-lockfile');
    expect(dev).not.toContain('--production');
    expect(prod).toContain('bun install --frozen-lockfile --production');

    const build = stageBody(dockerfile, 'build');
    const runtime = stageBody(dockerfile, 'runtime');
    expect(build).toContain(
      'COPY --from=deps-dev /opt/mud-web-proxy/node_modules ./node_modules',
    );
    expect(runtime).toContain(
      'COPY --from=deps-prod /opt/mud-web-proxy/node_modules ./node_modules',
    );
  });

  test('contains only the required runtime artifacts and identity', () => {
    const runtime = stageBody(readRoot('Dockerfile'), 'runtime');
    expect(runtime).toContain(
      'COPY --from=build --chown=0:0 --chmod=0444 /opt/mud-web-proxy/dist/wsproxy.js ./dist/wsproxy.js',
    );
    expect(runtime).toContain(
      'COPY --chown=0:0 --chmod=0444 config/apple-app-attest-root-ca.pem ./config/apple-app-attest-root-ca.pem',
    );
    expect(runtime).toContain(
      'ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json',
    );
    expect(runtime).toContain('USER 10001:10001');
    expect(runtime).toContain('STOPSIGNAL SIGTERM');
    expect(runtime).toContain('ENTRYPOINT ["bun", "dist/wsproxy.js"]');
    expect(runtime).toContain('CMD []');
    expect(runtime).not.toMatch(/^\s*(EXPOSE|HEALTHCHECK|VOLUME)\b/m);
    expect(runtime).not.toContain('COPY . .');
  });

  test('uses an allowlisted build context that excludes private material', () => {
    const ignore = readRoot('.dockerignore');
    expect(ignore.startsWith('**\n')).toBe(true);
    for (const included of [
      '!package.json',
      '!bun.lock',
      '!tsconfig.json',
      '!wsproxy.ts',
      '!src/',
      '!src/**',
      '!config/',
      '!config/apple-app-attest-root-ca.pem',
    ]) {
      expect(ignore).toContain(included);
    }
    expect(ignore).not.toContain('!cert.pem');
    expect(ignore).not.toContain('!privkey.pem');
  });
});
```

- [ ] **Step 2: Run the contract test and confirm the red state**

Run:

```bash
bun test tests/docker-image-contract.test.ts
```

Expected: FAIL because `Dockerfile` and `.dockerignore` do not exist.

- [ ] **Step 3: Add the allowlisted build context**

Create `.dockerignore`:

```dockerignore
**
!package.json
!bun.lock
!tsconfig.json
!wsproxy.ts
!src/
!src/**
!config/
!config/apple-app-attest-root-ca.pem
```

The initial `**` excludes local `cert.pem`, `privkey.pem`, `.env*`, Git data,
tests, documentation, dependencies, coverage, logs, and all other files unless
explicitly re-included.

- [ ] **Step 4: Add the five-stage Dockerfile**

Create `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

FROM ${BUN_IMAGE} AS base
WORKDIR /opt/mud-web-proxy

FROM base AS deps-dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS deps-prod
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS build
COPY --from=deps-dev /opt/mud-web-proxy/node_modules ./node_modules
COPY package.json tsconfig.json wsproxy.ts ./
COPY src ./src
RUN bun run build

FROM base AS runtime
ENV NODE_ENV=production \
    ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json

RUN groupadd --gid 10001 mwp \
    && useradd --uid 10001 --gid 10001 --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin mwp \
    && install -d -o 0 -g 0 -m 0555 /opt/mud-web-proxy/config \
    && install -d -o 0 -g 0 -m 0555 /opt/mud-web-proxy/dist \
    && install -d -o 10001 -g 10001 -m 0750 /var/lib/mud-web-proxy

COPY --from=deps-prod /opt/mud-web-proxy/node_modules ./node_modules
COPY --from=build --chown=0:0 --chmod=0444 /opt/mud-web-proxy/dist/wsproxy.js ./dist/wsproxy.js
COPY --chown=0:0 --chmod=0444 config/apple-app-attest-root-ca.pem ./config/apple-app-attest-root-ca.pem

USER 10001:10001
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "dist/wsproxy.js"]
CMD []
```

`CMD []` clears the Bun base image's inherited command so it is not appended to
the proxy entrypoint.

- [ ] **Step 5: Run the focused contract and image-build checks**

Run:

```bash
bun test tests/docker-image-contract.test.ts
docker build --pull --tag mud-web-proxy:test .
docker image inspect mud-web-proxy:test \
  --format 'user={{.Config.User}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}'
```

Expected:

```text
3 pass
user=10001:10001 entrypoint=["bun","dist/wsproxy.js"] cmd=null
```

- [ ] **Step 6: Commit the image definition**

```bash
git add Dockerfile .dockerignore tests/docker-image-contract.test.ts
git commit -m "feat(container): add production Docker image (MWP-98)"
```

---

### Task 2: Add the hardened runtime acceptance test

**Files:**

- Create: `tests/container/acceptance-client.ts`
- Create: `tests/container/run.sh`
- Modify: `package.json`
- Modify: `wsproxy.ts`

**Interfaces:**

- Consumes: image tag `mud-web-proxy:test`.
- Consumes: network aliases `mwp-test-proxy` and `mwp-test-mud`.
- Consumes: mock MUD positional CLI
  `bun tests/e2e/mock-mud.ts 6300 generic`.
- Produces: client log markers `container-acceptance: ca-loaded`,
  `container-acceptance: session-ready`, and
  `container-acceptance: proxy-closed`.
- Produces: package script `test:container`.
- Keeps the bounded listener-close fallback referenced so Bun cannot exit
  before state flush and the `shutdown: completed` marker.

- [ ] **Step 1: Establish the missing-test red state**

Run:

```bash
bun run test:container
```

Expected: FAIL with `Script not found "test:container"`.

- [ ] **Step 2: Add the separate helper-container acceptance client**

Create `tests/container/acceptance-client.ts`:

```typescript
import { encode } from 'cbor-x';

const httpBase = process.env.PROXY_HTTP_URL ?? 'http://mwp-test-proxy:6200';
const wsUrl = process.env.PROXY_WS_URL ?? 'ws://mwp-test-proxy:6200';

const fail = (message: string): never => {
  throw new Error(`container-acceptance: ${message}`);
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`container-acceptance: timeout: ${label}`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const exerciseCaLoader = async (): Promise<void> => {
  const challengeResponse = await fetch(`${httpBase}/attest/challenge`);
  if (!challengeResponse.ok) {
    fail(`challenge returned ${challengeResponse.status}`);
  }
  const challenge = (await challengeResponse.json()) as { nonce?: string };
  if (!challenge.nonce) fail('challenge omitted nonce');

  const invalidAttestation = Buffer.from(
    encode({
      fmt: 'apple-appattest',
      attStmt: {
        x5c: [Buffer.from([0]), Buffer.from([0])],
      },
      authData: Buffer.alloc(55),
    }),
  ).toString('base64');

  const registerResponse = await fetch(`${httpBase}/attest/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      keyId: 'container-test-key',
      attestation: invalidAttestation,
      nonce: challenge.nonce,
    }),
  });
  const responseBody = await registerResponse.text();
  if (registerResponse.status !== 400) {
    fail(`invalid certificate chain returned ${registerResponse.status}`);
  }
  if (responseBody.includes('Apple root CA not found')) {
    fail(`App Attest CA loader failed: ${responseBody}`);
  }
  if (!/(certificate|asn1|pem|header|wrong tag)/i.test(responseBody)) {
    fail(`request did not reach certificate parsing: ${responseBody}`);
  }
  console.log('container-acceptance: ca-loaded');
};

const exerciseSession = async (): Promise<void> => {
  const socket = new WebSocket(wsUrl);
  let ready = false;
  let phase: 'opening' | 'login' | 'ready' = 'opening';
  let loginTimer: ReturnType<typeof setInterval> | undefined;

  const sessionReady = new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'connect',
          host: 'mwp-test-mud',
          port: 6300,
        }),
      );
    };

    socket.onerror = () => {
      reject(new Error('container-acceptance: WebSocket error'));
    };

    socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data.toString()) as {
        type?: string;
        code?: string;
        message?: string;
        payload?: string;
      };
      if (message.type === 'error') {
        reject(
          new Error(
            `container-acceptance: proxy error ${message.code}: ${message.message}`,
          ),
        );
        return;
      }
      if (message.type === 'session' && phase === 'opening') {
        phase = 'login';
        loginTimer = setInterval(() => {
          socket.send(
            JSON.stringify({ type: 'input', text: 'container-login\r\n' }),
          );
        }, 250);
        return;
      }
      if (message.type !== 'data' || !message.payload) return;

      const text = Buffer.from(message.payload, 'base64').toString('utf8');
      const plainText = text.replace(/\x1b\[[0-9;]*m/g, '');
      if (
        phase === 'login' &&
        plainText.includes('Welcome to the Mock MUD!')
      ) {
        if (loginTimer) clearInterval(loginTimer);
        phase = 'ready';
        ready = true;
        console.log('container-acceptance: session-ready');
        resolve();
      }
    };
  });

  const proxyClosed = new Promise<void>((resolve, reject) => {
    socket.onclose = (event: CloseEvent) => {
      if (loginTimer) clearInterval(loginTimer);
      if (!ready) {
        reject(
          new Error(
            `container-acceptance: socket closed before session was ready (${event.code})`,
          ),
        );
        return;
      }
      if (event.reason !== 'Server restarting') {
        reject(
          new Error(
            `container-acceptance: unexpected close ${event.code}: ${event.reason}`,
          ),
        );
        return;
      }
      console.log('container-acceptance: proxy-closed');
      resolve();
    };
  });

  await withTimeout(sessionReady, 10_000, 'real session');
  await withTimeout(proxyClosed, 15_000, 'graceful proxy close');
};

await exerciseCaLoader();
await exerciseSession();
```

This helper is test code mounted only in its own pinned-Bun container. It is
excluded from the production build context and absent from the image under test.

- [ ] **Step 3: Add the Docker acceptance harness**

Create `tests/container/run.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly BUN_IMAGE='oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4'
readonly IMAGE='mud-web-proxy:test'
readonly PREFIX="mwp-container-$$"
readonly NETWORK="${PREFIX}-network"
readonly MOCK_CONTAINER="${PREFIX}-mud"
readonly PROXY_CONTAINER="${PREFIX}-proxy"
readonly CLIENT_CONTAINER="${PREFIX}-client"
readonly MOCK_DEPS="${PREFIX}-mock-deps"
readonly CLIENT_DEPS="${PREFIX}-client-deps"
readonly STATE_VOLUME='mwp-test-state'
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
state_volume_created=0

fail() {
  for container in "${CLIENT_CONTAINER}" "${PROXY_CONTAINER}" "${MOCK_CONTAINER}"; do
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
    "${MOCK_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  docker volume rm \
    "${MOCK_DEPS}" \
    "${CLIENT_DEPS}" >/dev/null 2>&1 || true
  if (( state_volume_created == 1 )); then
    docker volume rm "${STATE_VOLUME}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

wait_for_log() {
  local container="$1"
  local marker="$2"
  local attempts=100
  while (( attempts > 0 )); do
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

docker build --pull --tag "${IMAGE}" "${REPO_ROOT}"

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

prepare_helper_deps "${MOCK_DEPS}"
prepare_helper_deps "${CLIENT_DEPS}"
docker network create "${NETWORK}" >/dev/null

docker run --detach \
  --name "${MOCK_CONTAINER}" \
  --network "${NETWORK}" \
  --network-alias mwp-test-mud \
  --mount "type=bind,source=${REPO_ROOT},target=/repo,readonly" \
  --mount "type=volume,source=${MOCK_DEPS},target=/workspace/node_modules" \
  --env NODE_PATH=/workspace/node_modules \
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
  --mount "type=volume,source=${CLIENT_DEPS},target=/workspace/node_modules" \
  --env NODE_PATH=/workspace/node_modules \
  --workdir /repo \
  "${BUN_IMAGE}" \
  bun /repo/tests/container/acceptance-client.ts >/dev/null
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

client_logs="$(docker logs "${CLIENT_CONTAINER}" 2>&1)"
grep -Fq 'container-acceptance: ca-loaded' <<<"${client_logs}"
grep -Fq 'container-acceptance: proxy-closed' <<<"${client_logs}"

echo 'container-acceptance: passed'
```

The exact close code is asserted from the proxy's authoritative log. Bun
1.3.14's global WebSocket client reports a server-issued code 1001 as 1000,
while preserving the reason, so the helper asserts `Server restarting`.

- [ ] **Step 4: Keep the listener fallback alive through state flush**

In `wsproxy.ts`, remove `bail.unref?.()` from the bounded
`LISTENER_CLOSE_WAIT_MS` timer. Once sockets and the listener close, that timer
can be Bun's only referenced handle; unref'ing it lets the process exit before
the state flush and `shutdown: completed`. The overall shutdown deadline still
bounds the sequence.

- [ ] **Step 5: Make the harness executable and expose the package command**

Run:

```bash
chmod 0755 tests/container/run.sh
```

Add to `package.json#scripts`:

```json
"test:container": "bash tests/container/run.sh"
```

- [ ] **Step 6: Run the acceptance test**

Run:

```bash
bun run test:container
```

Expected final output:

```text
container-acceptance: passed
```

Also inspect the proxy logs printed on failure; the test is not passing if they
contain `EROFS`, `read-only file system`, or `shutdown: ... failed:`.

- [ ] **Step 7: Commit the acceptance coverage**

```bash
git add docs/superpowers/plans/2026-07-30-production-docker-image.md \
  package.json wsproxy.ts tests/container/acceptance-client.ts \
  tests/container/run.sh
git commit -m "test(container): verify hardened runtime behavior (MWP-98)"
```

---

### Task 3: Gate the image in CI and document direct Docker usage

**Files:**

- Modify: `.github/workflows/test.yml`
- Modify: `README.md`

**Interfaces:**

- Consumes: `tests/container/run.sh`.
- Produces: required GitHub Actions job `container`.
- Produces: documented direct-image build and hardened run command; Compose
  remains MWP-99.

- [ ] **Step 1: Add the container job to GitHub Actions**

Append this sibling job under `.github/workflows/test.yml#jobs`:

```yaml
container:
  runs-on: ubuntu-latest
  timeout-minutes: 15
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
    - run: bash tests/container/run.sh
```

Do not add `setup-bun` to this job. The host runs Bash and Docker; all Bun code
runs inside the digest-pinned helper or application images.

- [ ] **Step 2: Add the Docker build and run documentation**

Add a `### Docker image` section after the existing production build commands
in `README.md`:

````markdown
### Docker image

Build the production image:

```bash
docker build --pull -t mud-web-proxy:local .
```

The supported Phase 2 deployment places Caddy in front of the proxy. Until the
Compose topology lands in MWP-99, this loopback-only command exercises the same
internal plaintext hop without exposing port 6200 beyond the host:

```bash
docker volume create mud-web-proxy-state
docker run --rm --name mud-web-proxy \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --mount type=volume,source=mud-web-proxy-state,target=/var/lib/mud-web-proxy \
  --publish 127.0.0.1:6200:6200 \
  --env BIND_HOST=0.0.0.0 \
  --env INBOUND_TLS_MODE=off \
  --env ALLOW_INSECURE_INBOUND_NO_TLS=true \
  --env TARGET_MODE=fixed \
  --env TN_HOST=mud.example.com \
  --env TN_PORT=4000 \
  mud-web-proxy:local
```

The image deliberately declares neither `EXPOSE` nor `HEALTHCHECK`: Caddy and
Compose own port publication and the HTTP readiness probe because that layer
selects the internal TLS mode. Docker port publication still works without
`EXPOSE`.

App Attest is disabled unless both `APPATTEST_BUNDLE_ID` and
`APPATTEST_TEAM_ID` are set. When enabled, mount the writable directory
`/var/lib/mud-web-proxy`, not the `attested-keys.json` file; atomic persistence
creates and renames a sibling temporary directory.
````

- [ ] **Step 3: Run static, formatting, and workflow pin checks**

Run:

```bash
bun test tests/docker-image-contract.test.ts
docker run --rm \
  --mount "type=bind,source=$PWD,target=/opt/mud-web-proxy" \
  --workdir /opt/mud-web-proxy \
  oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 \
  bun run check:bun-version
bunx prettier@3.9.6 --check tests/docker-image-contract.test.ts \
  tests/container/acceptance-client.ts \
  .github/workflows/test.yml README.md
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Run the complete project and container verification**

Create isolated, user-owned directories for generated dependencies and output,
run the project checks with the exact pinned runtime, then remove the temporary
tree:

```bash
verify_root="$(mktemp -d)"
mkdir -p \
  "${verify_root}/node_modules" \
  "${verify_root}/dist" \
  "${verify_root}/coverage"
trap 'rm -r "${verify_root}"' EXIT
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=/workspace" \
  --mount "type=bind,source=${verify_root}/node_modules,target=/workspace/node_modules" \
  --mount "type=bind,source=${verify_root}/dist,target=/workspace/dist" \
  --mount "type=bind,source=${verify_root}/coverage,target=/workspace/coverage" \
  --workdir /workspace \
  oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 \
  sh -ec '
    bun install --frozen-lockfile
    bun run check:bun-version
    bun run format
    bun run check:config-docs
    bun run typecheck
    bun run lint
    bun run test:unit
    bun run build
  '
rm -r "${verify_root}"
trap - EXIT
bun run test:container
```

Expected:

- exact Bun version gate passes
- formatting, config documentation, type checking, lint, unit tests, and build
  all pass
- container acceptance ends with `container-acceptance: passed`

- [ ] **Step 5: Commit CI and documentation**

```bash
git add .github/workflows/test.yml README.md
git commit -m "ci(container): gate the production image (MWP-98)"
```

- [ ] **Step 6: Inspect the final scope**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: a clean worktree, the design/specification commits plus the three
implementation commits, and no unrelated files.
