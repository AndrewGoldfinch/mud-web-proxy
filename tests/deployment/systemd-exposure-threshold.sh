#!/usr/bin/env bash

set -euo pipefail

[[ "$#" -eq 1 ]] || exit 64
exposure="$1"

[[ "${exposure}" =~ ^([0-9]|10)\.([0-9])$ ]] || exit 65
whole="${BASH_REMATCH[1]}"
tenth="${BASH_REMATCH[2]}"
[[ "${whole}" != 10 || "${tenth}" == 0 ]] || exit 65

percentage=$((10#${whole} * 10 + 10#${tenth}))
((percentage >= 0 && percentage <= 100)) || exit 65
printf '%d\n' "${percentage}"
