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

valid_state() {
  case "$1" in
    active | activating | deactivating | inactive) return 0 ;;
    *) return 1 ;;
  esac
}

refresh_service_snapshot() {
  local active_state_seen=0
  local key
  local main_pid_seen=0
  local snapshot
  local tasks_seen=0
  local value

  snapshot="$(
    "${systemctl_bin}" show \
      --property=ActiveState \
      --property=MainPID \
      --property=TasksCurrent \
      "${service}" 2>/dev/null
  )" || return 1
  while IFS='=' read -r key value; do
    case "${key}" in
      ActiveState)
        ((active_state_seen == 0)) || return 1
        state="${value}"
        active_state_seen=1
        ;;
      MainPID)
        ((main_pid_seen == 0)) || return 1
        main_pid="${value}"
        main_pid_seen=1
        ;;
      TasksCurrent)
        ((tasks_seen == 0)) || return 1
        tasks="${value}"
        tasks_seen=1
        ;;
      *) return 1 ;;
    esac
  done <<<"${snapshot}"
  ((active_state_seen == 1 && main_pid_seen == 1 && tasks_seen == 1)) ||
    return 1
  valid_state "${state}"
}

snapshot_has_live_process() {
  [[ "${state}" == active || "${state}" == activating ||
    "${state}" == deactivating ]] &&
    [[ "${main_pid}" =~ ^[1-9][0-9]*$ ]] &&
    [[ -d "/proc/${main_pid}" ]] &&
    [[ "${tasks}" =~ ^[0-9]+$ ]]
}

snapshot_proves_process_absent() {
  [[ "${state}" == inactive || "${state}" == deactivating ]] &&
    [[ "${main_pid}" == 0 ]]
}

printf 'sample\tmonotonic_ms\tstate\tmain_pid\ttasks\tfile_descriptors\n'
for ((sample = 1; sample <= sample_limit; sample += 1)); do
  state="$("${systemctl_bin}" is-active "${service}" 2>/dev/null || true)"
  valid_state "${state}" || exit 65

  main_pid="$(
    "${systemctl_bin}" show -p MainPID --value "${service}" 2>/dev/null || true
  )"
  tasks="$(
    "${systemctl_bin}" show -p TasksCurrent --value "${service}" \
      2>/dev/null || true
  )"
  if ! snapshot_has_live_process; then
    refresh_service_snapshot || exit 65
    if snapshot_proves_process_absent; then
      main_pid=0
      tasks=0
    else
      snapshot_has_live_process || exit 65
    fi
  fi
  if snapshot_proves_process_absent; then
    main_pid=0
    tasks=0
  fi

  file_descriptors=0
  if ((main_pid > 0)); then
    if ! file_descriptors="$(
      find "/proc/${main_pid}/fd" -mindepth 1 -maxdepth 1 2>/dev/null |
        wc -l
    )"; then
      refresh_service_snapshot || exit 65
      snapshot_proves_process_absent || exit 65
      main_pid=0
      tasks=0
      file_descriptors=0
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
