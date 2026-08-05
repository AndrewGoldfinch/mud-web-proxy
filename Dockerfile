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

# Patch the base image's packages ahead of upstream.
#
# oven/bun:1.3.14 ships packages that carry HIGH findings with fixes already
# published by Debian — CVE-2026-45447 in libssl3t64 (heap use-after-free in
# PKCS7_verify) and CVE-2026-4878 in libcap2 (privilege escalation via a
# TOCTOU race in cap_set_file), at the time of writing. Upstream has not
# rebuilt, and the digest pinned above is still what the tag resolves to, so
# there is no newer base to move to.
#
# This started as `--only-upgrade libssl3t64`, and the scanner immediately
# surfaced the next package behind it. A per-package list needs editing every
# time that happens, which is the maintenance burden that gets security gates
# switched off. Upgrading everything with a published fix is the version that
# stays correct without attention.
#
# The cost is strict reproducibility: this layer changes as Debian publishes.
# That is the accepted trade for not shipping known HIGHs that are already
# fixed in the archive. `tests/container/scan.sh` is what keeps it honest.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 mwp \
    && useradd --uid 10001 --gid 10001 --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin mwp \
    && install -d -o 0 -g 0 -m 0555 /opt/mud-web-proxy/config \
    && install -d -o 0 -g 0 -m 0555 /opt/mud-web-proxy/dist \
    && install -d -o 10001 -g 10001 -m 0750 /var/lib/mud-web-proxy

COPY --from=deps-prod /opt/mud-web-proxy/node_modules ./node_modules
COPY --from=build --chown=0:0 --chmod=0444 /opt/mud-web-proxy/dist/wsproxy.js ./dist/wsproxy.js
COPY --chown=0:0 --chmod=0444 config/apple-app-attest-root-ca.pem ./config/apple-app-attest-root-ca.pem
COPY --chown=0:0 --chmod=0444 LICENSE NOTICE ./

USER 10001:10001
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "dist/wsproxy.js"]
CMD []
