#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly REPO_ROOT
readonly BUN_BIN="${BUN_BIN:-bun}"

if [[ "$#" -ne 2 ]]; then
  echo 'usage: build-systemd-acceptance-clients.sh OUTPUT_DIR METAFILE' >&2
  exit 2
fi

readonly OUTPUT_DIR="$1"
readonly METAFILE="$2"

mkdir -p "${OUTPUT_DIR}"
"${BUN_BIN}" build \
  "${REPO_ROOT}/tests/deployment/systemd-acceptance-client.ts" \
  "${REPO_ROOT}/tests/deployment/systemd-load-client.ts" \
  --target=node \
  --outdir="${OUTPUT_DIR}" \
  --external=ws \
  --metafile="${METAFILE}"
