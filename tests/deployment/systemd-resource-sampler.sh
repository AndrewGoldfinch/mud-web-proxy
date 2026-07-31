#!/usr/bin/env bash

set -euo pipefail

[[ "$#" -eq 2 ]] || exit 64
service="$1"
stop_file="$2"
systemctl_bin="${SYSTEMCTL_BIN:-systemctl}"
sample_limit="${MWP_RESOURCE_SAMPLE_LIMIT:-1200}"
sample_interval="${MWP_RESOURCE_SAMPLE_INTERVAL:-0.1}"

[[ "${sample_limit}" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "${sample_interval}" =~ ^(0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]+)?)$ ]] ||
  exit 64

printf 'sample\tmonotonic_ms\tstate\tmain_pid\ttasks\tfile_descriptors\n'
for ((sample = 1; sample <= sample_limit; sample += 1)); do
  state="$("${systemctl_bin}" is-active "${service}" 2>/dev/null || true)"
  case "${state}" in
    active | activating | deactivating | inactive) ;;
    *) exit 65 ;;
  esac

  main_pid="$(
    "${systemctl_bin}" show -p MainPID --value "${service}" 2>/dev/null || true
  )"
  tasks="$(
    "${systemctl_bin}" show -p TasksCurrent --value "${service}" \
      2>/dev/null || true
  )"
  if [[ "${state}" == active || "${state}" == activating ]]; then
    if [[ ! "${main_pid}" =~ ^[1-9][0-9]*$ ||
      ! -d "/proc/${main_pid}" || ! "${tasks}" =~ ^[0-9]+$ ]]; then
      state="$(
        "${systemctl_bin}" is-active "${service}" 2>/dev/null || true
      )"
      case "${state}" in
        active | activating | deactivating | inactive) ;;
        *) exit 65 ;;
      esac
    fi
  fi
  if [[ ! "${main_pid}" =~ ^[1-9][0-9]*$ || ! -d "/proc/${main_pid}" ]]; then
    [[ "${state}" == inactive || "${state}" == deactivating ]] || exit 65
    main_pid=0
  fi
  if [[ ! "${tasks}" =~ ^[0-9]+$ ]]; then
    [[ "${state}" == inactive || "${state}" == deactivating ]] || exit 65
    tasks=0
  fi

  file_descriptors=0
  if ((main_pid > 0)); then
    if ! file_descriptors="$(
      find "/proc/${main_pid}/fd" -mindepth 1 -maxdepth 1 2>/dev/null |
        wc -l
    )"; then
      state="$(
        "${systemctl_bin}" is-active "${service}" 2>/dev/null || true
      )"
      case "${state}" in
        inactive | deactivating)
          main_pid=0
          tasks=0
          file_descriptors=0
          ;;
        active | activating) exit 65 ;;
        *) exit 65 ;;
      esac
    fi
    [[ "${file_descriptors}" =~ ^[0-9]+$ ]] || exit 65
  fi
  monotonic_ms="$(
    awk '{ printf "%.0f\n", $1 * 1000 }' /proc/uptime
  )"
  [[ "${monotonic_ms}" =~ ^[0-9]+$ ]] || exit 65
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${sample}" "${monotonic_ms}" "${state}" "${main_pid}" \
    "${tasks}" "${file_descriptors}"

  [[ ! -e "${stop_file}" ]] || exit 0
  sleep "${sample_interval}"
done

printf 'resource sampler reached its sample limit\n' >&2
exit 70
