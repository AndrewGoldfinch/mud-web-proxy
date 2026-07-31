#!/usr/bin/env bash

set -euo pipefail

[[ "$#" -eq 1 ]] || exit 64
readonly metadata_url="$1"
readonly curl_bin="${CURL_BIN:-curl}"

[[ "${metadata_url}" =~ ^https?://[^/?#]+/metadata/v1/id$ ]] || exit 64

metadata_id="$(
  "${curl_bin}" \
    --fail \
    --silent \
    --connect-timeout 2 \
    --max-time 5 \
    --retry 2 \
    --retry-delay 1 \
    --retry-connrefused \
    "${metadata_url}" 2>/dev/null
)" || exit 65
[[ "${metadata_id}" =~ ^[1-9][0-9]*$ ]] || exit 65

printf '%s\n' "${metadata_id}"
