#!/usr/bin/env bash

archive_matches_sha256_manifest() {
  [[ "$#" -eq 2 ]] || return 1

  local archive="$2"
  local manifest="$1"
  local -a checksums

  [[ -f "${manifest}" && -f "${archive}" ]] || return 1
  mapfile -t checksums < <(
    awk -v archive="$(basename "${archive}")" \
      '$2 == archive { print $1 }' "${manifest}"
  )
  [[ "${#checksums[@]}" -eq 1 && "${checksums[0]}" =~ ^[0-9a-f]{64}$ ]] ||
    return 1
  printf '%s  %s\n' "${checksums[0]}" "${archive}" |
    sha256sum --check --status
}

tree_has_no_writable_files_or_directories() {
  local writable

  [[ "$#" -gt 0 ]] || return 1
  writable="$(
    find "$@" \( -type f -o -type d \) -perm /0222 -print -quit
  )" || return 1
  [[ -z "${writable}" ]]
}

record_release_artifact_hash() {
  [[ "$#" -eq 4 ]] || return 1

  local built="$1"
  local installed="$2"
  local label="$3"
  local output="$4"
  local checksum

  [[ -f "${built}" && ! -L "${built}" &&
    -f "${installed}" && ! -L "${installed}" ]] || return 1
  [[ "${label}" != /* &&
    "${label}" != .. &&
    "${label}" != ../* &&
    "${label}" != */../* ]] || return 1
  cmp --silent -- "${built}" "${installed}" || return 1
  checksum="$(sha256sum -- "${built}")" || return 1
  checksum="${checksum%% *}"
  [[ "${checksum}" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s  %s\n' "${checksum}" "${label}" >"${output}"
}

journal_has_unit_failure() {
  local journal="$1"

  grep -Eiq \
    'EROFS|read[- ]only|shutdown: .*failed:|timeout|timed out|deadline|SIGKILL|status=9/KILL|code=killed|(^|[^[:alnum:]_])oom([^[:alnum:]_]|$)|oom[_-](group[_-])?kill|out of memory|Killed process' \
    "${journal}"
}

journal_has_system_failure() {
  local journal="$1"

  grep -Eiq \
    'EROFS|read[- ]only|SIGKILL|status=9/KILL|code=killed.*status=9/KILL|(^|[^[:alnum:]_])oom([^[:alnum:]_]|$)|oom[_-](group[_-])?kill|out of memory|Killed process' \
    "${journal}"
}

memory_events_unchanged() {
  local after="$2"
  local before="$1"

  awk '
    NR == FNR {
      original[$1] = $2
      next
    }
    {
      terminal[$1] = $2
    }
    END {
      required["max"] = 1
      required["oom"] = 1
      required["oom_kill"] = 1
      for (name in required) {
        if (!(name in original) || !(name in terminal) ||
            terminal[name] != original[name]) {
          exit 1
        }
      }
      if ("oom_group_kill" in original) {
        if (!("oom_group_kill" in terminal) ||
            terminal["oom_group_kill"] != original["oom_group_kill"]) {
          exit 1
        }
      } else if ("oom_group_kill" in terminal) {
        exit 1
      }
    }
  ' "${before}" "${after}"
}

resource_sample_peaks() {
  [[ "$#" -eq 4 ]] || return 1

  local descriptor_limit="$4"
  local output="$2"
  local samples="$1"
  local task_limit="$3"
  local descriptor_peak
  local task_peak

  [[ -f "${samples}" && ! -L "${samples}" ]] || return 1
  [[ "${task_limit}" =~ ^[1-9][0-9]*$ &&
    "${descriptor_limit}" =~ ^[1-9][0-9]*$ ]] || return 1
  awk -F '\t' '
    function reject() {
      invalid = 1
      exit 1
    }
    NR == 1 {
      if ($0 != "sample\tmonotonic_ms\tstate\tmain_pid\ttasks\tfile_descriptors") {
        reject()
      }
      next
    }
    {
      if (NF != 6 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ ||
          $4 !~ /^[0-9]+$/ || $5 !~ /^[0-9]+$/ || $6 !~ /^[0-9]+$/) {
        reject()
      }
      rows += 1
      if ($1 != rows || (rows > 1 && $2 <= previous_time) ||
          $3 !~ /^(active|activating|deactivating|inactive)$/) {
        reject()
      }
      if ($3 == "active") {
        saw_active = 1
      }
      if ($5 > task_peak) {
        task_peak = $5
      }
      if ($6 > descriptor_peak) {
        descriptor_peak = $6
      }
      if (rows == 1) {
        first_time = $2
      }
      previous_time = $2
      last_state = $3
    }
    END {
      if (invalid || rows == 0 || !saw_active || last_state != "inactive") {
        exit 1
      }
      printf "Samples=%d\n", rows
      printf "FirstMonotonicMs=%d\n", first_time
      printf "LastMonotonicMs=%d\n", previous_time
      printf "TaskPeak=%d\n", task_peak
      printf "FileDescriptorPeak=%d\n", descriptor_peak
    }
  ' "${samples}" >"${output}" || return 1

  task_peak="$(awk -F= '$1 == "TaskPeak" { print $2 }' "${output}")"
  descriptor_peak="$(
    awk -F= '$1 == "FileDescriptorPeak" { print $2 }' "${output}"
  )"
  [[ "${task_peak}" =~ ^[0-9]+$ &&
    "${descriptor_peak}" =~ ^[0-9]+$ ]] || return 1
  ((task_peak < task_limit && descriptor_peak < descriptor_limit))
}

host_shape_matches() {
  [[ "$#" -eq 2 ]] || return 1

  local cpu_count="$2"
  local memory_kib

  memory_kib="$(
    awk '
      $1 == "MemTotal:" {
        matches += 1
        value = $2
      }
      END {
        if (matches != 1) {
          exit 1
        }
        print value
      }
    ' "$1"
  )" || return 1
  [[ "${memory_kib}" =~ ^[0-9]+$ && "${cpu_count}" =~ ^[0-9]+$ ]] ||
    return 1
  ((memory_kib >= 900000 && memory_kib <= 1200000 && cpu_count == 1))
}

record_boot_id_pair() {
  [[ "$#" -eq 3 ]] || return 1

  local install_boot_id="$1"
  local post_reboot_boot_id="$2"
  local output="$3"
  local uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

  [[ "${install_boot_id}" =~ ${uuid} &&
    "${post_reboot_boot_id}" =~ ${uuid} &&
    "${install_boot_id}" != "${post_reboot_boot_id}" ]] || return 1
  printf 'install-boot-id=%s\npost-reboot-boot-id=%s\n' \
    "${install_boot_id}" "${post_reboot_boot_id}" >"${output}"
}
