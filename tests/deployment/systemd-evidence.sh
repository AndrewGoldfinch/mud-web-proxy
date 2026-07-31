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
