#!/usr/bin/env bash

set -euo pipefail

[[ "$#" -eq 5 ]] || exit 64
threshold="$1"
service="$2"
report="$3"
baseline="$4"
comparison="$5"
bun_bin="${BUN_BIN:-bun}"
systemd_analyze_bin="${SYSTEMD_ANALYZE_BIN:-systemd-analyze}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

[[ "${threshold}" =~ ^([0-9]|[1-9][0-9]|100)$ ]] || exit 64
[[ -n "${service}" ]] || exit 64

analyze_status=0
"${systemd_analyze_bin}" security "--threshold=${threshold}" --no-pager \
  "${service}" >"${report}" || analyze_status=$?

comparison_status=0
"${bun_bin}" "${script_dir}/systemd-security-residuals.ts" \
  "${report}" "${baseline}" "${comparison}" || comparison_status=$?
[[ -f "${comparison}" && ! -L "${comparison}" ]] || exit 1
chmod 0600 "${comparison}"

((comparison_status == 0)) || exit "${comparison_status}"
exit "${analyze_status}"
