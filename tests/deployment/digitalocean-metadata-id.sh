#!/usr/bin/env bash

set -euo pipefail

[[ "$#" -eq 0 ]] || exit 64
readonly metadata_url="$(
  printf 'http://%d.%d.%d.%d/metadata/v1/id' 169 254 169 254
)"
curl_bin=/usr/bin/curl
if [[ -n "${MWP_METADATA_TEST_CURL_BIN:-}" ]]; then
  ((EUID != 0)) || exit 64
  curl_bin="${MWP_METADATA_TEST_CURL_BIN}"
fi
readonly curl_bin

[[ -x "${curl_bin}" && ! -L "${curl_bin}" ]] || exit 65

metadata_id="$(
  "${curl_bin}" \
    --disable \
    --fail \
    --silent \
    --noproxy '*' \
    --connect-timeout 2 \
    --max-time 5 \
    --retry 2 \
    --retry-delay 1 \
    --retry-connrefused \
    "${metadata_url}" 2>/dev/null
)" || exit 65
[[ "${metadata_id}" =~ ^[1-9][0-9]*$ ]] || exit 65

printf '%s\n' "${metadata_id}"
