# Production Docker Image Design

**Issue:** MWP-98  
**Date:** 2026-07-30  
**Status:** Approved

## Goal

Add a reproducible production image for `mud-web-proxy` that runs the compiled
proxy as a fixed non-root user, contains no source, tests, development
dependencies, or private TLS material, and works with a read-only root
filesystem, all Linux capabilities dropped, and `no-new-privileges`.

This issue builds the proxy image only. MWP-99 will define the Caddy and proxy
Compose services, internal networking, readiness probe, and optional App Attest
state volume.

## Base image and build stages

Every stage derives from the same multi-platform OCI image:

```dockerfile
oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
```

The digest was resolved and inspected through the registry on 2026-07-30. It
is the `oven/bun:1.3.14` OCI index and contains:

- `linux/amd64`:
  `sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834`
- `linux/arm64`:
  `sha256:d8a4c24744b290bf789d58966a6f2521fc4d8bec36ec02cead6c541147b7d550`

The tag records the human-readable Bun version; the index digest makes the
actual base immutable while selecting the correct child manifest for each
platform. The version must remain identical to `.bun-version` and the exact
`package.json#engines.bun` value.

The Dockerfile has five named stages:

1. `base` sets the application work directory.
2. `deps-dev` copies only `package.json` and `bun.lock`, then runs
   `bun install --frozen-lockfile`.
3. `deps-prod` independently copies only `package.json` and `bun.lock`, then
   runs `bun install --frozen-lockfile --production`.
4. `build` copies `node_modules` only from `deps-dev` and the source needed by
   the existing `bun run build` script. The existing esbuild command keeps
   `--packages=external` and produces `dist/wsproxy.js`.
5. `runtime` copies `node_modules` only from `deps-prod`, plus the compiled
   bundle and the public Apple App Attest root CA.

The two dependency stages are structurally independent. They may execute in
parallel under BuildKit, and neither `bun install` command can mutate or prune
the other stage's `node_modules`.

Production dependencies cannot be omitted because the bundle externalizes
`cbor-x`, `iconv-lite`, and `ws`. They must not be bundled as part of this
issue: `cbor-x` has optional native accelerators, so changing the existing
module-loading boundary creates unnecessary runtime and cross-platform risk.

## Runtime filesystem layout

The runtime stage uses this exact layout:

```text
/opt/mud-web-proxy/
├── config/
│   └── apple-app-attest-root-ca.pem
├── dist/
│   └── wsproxy.js
└── node_modules/
/var/lib/mud-web-proxy/
```

The CA path is a hard runtime contract, not a discretionary copy target.
Bundled `src/app-attest.ts` resolves the CA as:

```text
path.resolve(__dirname, "../config/apple-app-attest-root-ca.pem")
```

With the bundle at `/opt/mud-web-proxy/dist/wsproxy.js`, the CA must therefore
be at:

```text
/opt/mud-web-proxy/config/apple-app-attest-root-ca.pem
```

Container acceptance tests must assert that exact path and must exercise App
Attest CA loading. A misplaced CA is otherwise detected only when attestation
is first used.

The public CA remains owned by root and is copied with mode `0444`. The runtime
user needs read access but no ownership or write access. The acceptance test
must exercise the real loader rather than infer readability from `stat`.

The image must not contain:

- repository application source outside `dist/wsproxy.js`
- `tests/`, `scripts/`, documentation, coverage, or Git metadata
- development dependencies such as `esbuild`, TypeScript, or ESLint
- repository-root `cert.pem` or `privkey.pem`
- `.env` files or APNS private keys

`.dockerignore` excludes local dependencies, build output, tests, documentation,
Git data, environment files, coverage, logs, and private key or certificate
material. The Dockerfile uses explicit `COPY` instructions as a second boundary;
the runtime stage never uses `COPY . .`.

## User and process model

The runtime stage creates a dedicated `mwp` group and user with fixed
GID/UID `10001:10001`. All application and state directories are created with
the minimum ownership needed by that user. The image ends with:

```dockerfile
USER 10001:10001
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "dist/wsproxy.js"]
```

The exec-form entrypoint makes Bun PID 1, so Docker's SIGTERM reaches the
signal handlers implemented by MWP-96. No shell wrapper or process manager sits
between Docker and the proxy.

The image declares no `EXPOSE` instruction. MWP-99 will connect Caddy to port
6200 on an internal network and publish only Caddy's ports 80 and 443.
`EXPOSE` is image metadata, not a prerequisite for networking: Docker's `-p`
and Compose port or network configuration can still reach an undeclared
container port.

## Configuration and TLS boundary

The image retains the application's secure defaults. It does not bake in the
Caddy topology by changing `BIND_HOST`, `INBOUND_TLS_MODE`, or
`ALLOW_INSECURE_INBOUND_NO_TLS`.

MWP-99 must explicitly set all three values for the internal plaintext hop:

```text
BIND_HOST=0.0.0.0
INBOUND_TLS_MODE=off
ALLOW_INSECURE_INBOUND_NO_TLS=true
```

This preserves the startup guard for an operator who runs the image outside the
supported Caddy topology.

The image sets:

```text
NODE_ENV=production
ATTESTED_KEYS_PATH=/var/lib/mud-web-proxy/attested-keys.json
```

No image-level `HEALTHCHECK` is defined. The correct scheme is controlled by
`INBOUND_TLS_MODE`, and this issue deliberately leaves that choice to the
deployment layer. Hard-coding HTTP in the image would break an operator who
terminates TLS in-process; constructing an HTTPS loopback probe would fail
normal hostname verification for a certificate issued to the public host.
MWP-99 will define the HTTP readiness probe after it explicitly selects
`INBOUND_TLS_MODE=off`.

This intentionally supersedes MWP-98's original image-level `HEALTHCHECK`
wording while preserving its behavioral requirement: the container acceptance
test must verify `/health` returns 200 while ready and 503 during drain.

## Writable state and read-only root filesystem

The current production server writes only the optional App Attest key store.
That is not treated as a permanent audit conclusion; container acceptance tests
enforce the claim by running the proxy with `--read-only` and exercising a real
WebSocket-to-Telnet session before graceful shutdown.

App Attest persists atomically by calling `fs.mkdtempSync` inside the directory
containing `ATTESTED_KEYS_PATH`, writing a temporary file, and renaming it over
the live JSON file. MWP-99 must therefore mount a writable named volume at the
directory:

```text
/var/lib/mud-web-proxy
```

It must not mount only:

```text
/var/lib/mud-web-proxy/attested-keys.json
```

A file-only mount prevents creation of the sibling staging directory and
breaks the atomic rename. The mounted directory must be writable by
UID/GID `10001:10001`.

The Dockerfile creates `/var/lib/mud-web-proxy` with that ownership but does
not declare `VOLUME`. App Attest is disabled by default, and an unconditional
Dockerfile volume would create an anonymous writable volume and orphan it for
every container even when the feature is unused. MWP-99 owns the optional named
volume because it owns the deployment topology.

APNS key material is read-only operator input and is never copied into the
image. An operator enabling APNS supplies `APNS_KEY_PATH` and mounts the key
read-only at that path.

## Container acceptance tests

The repository adds a repeatable Docker acceptance script and runs it in the
GitHub Actions quality workflow. The script uses traps to remove containers,
networks, and test volumes on both success and failure.

The mock MUD and acceptance client are never copied into or mounted inside the
image under test. They run in separate helper containers derived from the same
digest-pinned `oven/bun:1.3.14` base. Each helper receives the repository as a
read-only bind mount plus its own writable dependency/cache volume. The mock
helper runs `tests/e2e/mock-mud.ts`; the client helper runs a dedicated
container-acceptance client from the repository. Both join the test's private
Docker network.

The image under test receives no repository, source, test, or dependency bind
mount. Its only permitted mount is the named state volume at
`/var/lib/mud-web-proxy` when the state-volume and App Attest paths are under
test.

The test performs these checks:

1. Build the image from the repository root with BuildKit.
2. Inspect the image and require:
   - user `10001:10001`
   - no declared exposed ports
   - exec-form entrypoint `bun dist/wsproxy.js`
   - `SIGTERM` as the stop signal
3. Start a shell in the image and require:
   - `/opt/mud-web-proxy/dist/wsproxy.js` exists
   - `/opt/mud-web-proxy/config/apple-app-attest-root-ca.pem` exists and is
     root-owned with mode `0444`
   - the three production packages resolve
   - source, tests, scripts, development dependencies, `cert.pem`, and
     `privkey.pem` are absent
4. Mount a fresh named volume at `/var/lib/mud-web-proxy` and, as UID 10001,
   reproduce the key store's `mkdtemp` → write → rename → cleanup sequence.
   This proves that the directory-level volume and ownership support the
   atomic persistence algorithm.
5. Create a private Docker network. Start the pinned-Bun mock helper with the
   repository mounted read-only, and run `tests/e2e/mock-mud.ts` on that
   network. Start a separate pinned-Bun client helper under the same mount and
   network constraints.
6. Start the proxy on that network with:

   ```text
   --read-only
   --cap-drop=ALL
   --security-opt=no-new-privileges
   BIND_HOST=0.0.0.0
   INBOUND_TLS_MODE=off
   ALLOW_INSECURE_INBOUND_NO_TLS=true
   TARGET_MODE=fixed
   MUD_TLS_MODE=plain
   TN_HOST=mwp-test-mud
   TN_PORT=6300
   SHUTDOWN_GRACE_MS=3000
   SHUTDOWN_DEADLINE_MS=10000
   APPATTEST_BUNDLE_ID=com.example.mwp-container-test
   APPATTEST_TEAM_ID=MWPTESTTEAM
   ```

   The explicit fixed target prevents a missing or mistyped override from
   falling back to the repository's public default MUD. The shutdown deadline
   is strictly greater than the grace period, as required by
   `runtime-config.ts`; equal values are a startup error.

7. Wait for `GET /health` to return HTTP 200. The acceptance script publishes
   the container port with `-p`; this works without `EXPOSE` metadata.
8. Exercise the actual App Attest CA loader:
   - obtain a valid nonce from `/attest/challenge`
   - have the client helper encode an otherwise well-shaped App Attest CBOR
     object containing a deliberately invalid two-certificate chain
   - submit it to `/attest/register`
   - require HTTP 400 from certificate parsing or validation
   - reject any response containing `Apple root CA not found`

   `verifyAttestation` loads the configured CA after CBOR shape and chain-count
   validation but before constructing the deliberately invalid certificates.
   Reaching certificate parsing therefore proves that the runtime code loaded
   the CA from its compiled path; a missing or misplaced file produces the
   distinct rejected error.

9. Through the separate client helper, open a real WebSocket connection, send
   a typed `connect` request, establish the Telnet connection to the mock MUD,
   exchange payload data in both directions, and leave the session active.
10. Send SIGTERM to the proxy container.
11. During the 3000 ms grace window, require `GET /health` to return HTTP 503
    while the real session still exists.
12. Require the container to exit within 10000 ms and require logs to contain
    `shutdown: completed`.

The real session is essential: merely starting the process under
`--read-only` would not execute connection-path behavior and could miss a new
filesystem write introduced there.

## Documentation and scope

MWP-98 documents how to build and run the image for acceptance testing,
including the required explicit plaintext acknowledgement when Caddy terminates
TLS. It records `/var/lib/mud-web-proxy` as the only writable state mount and
explains why the directory, rather than the JSON file, must be mounted.

The following remain out of scope and belong to later Phase 2 tickets:

- Caddy and Docker Compose services
- image publishing to GHCR
- amd64/arm64 release builds and provenance attestations
- release tags, SBOM publication, and vulnerability scanning
- systemd deployment

## Acceptance criteria

- A clean checkout builds using the digest-pinned Bun 1.3.14 base.
- The runtime image contains only the compiled bundle, production
  dependencies, and the public App Attest CA at its exact required path.
- Source, tests, development dependencies, `cert.pem`, and `privkey.pem` are
  absent.
- The configured runtime identity is exactly `10001:10001`.
- The proxy completes a real WebSocket-to-Telnet session with a read-only root
  filesystem, all capabilities dropped, and `no-new-privileges`.
- A directory volume at `/var/lib/mud-web-proxy` supports App Attest's atomic
  persistence sequence as UID 10001.
- Readiness returns 200 normally and 503 during the SIGTERM drain window.
- SIGTERM reaches Bun directly and the bounded graceful shutdown completes.
- The image declares neither an application port nor a topology-dependent
  health check.
