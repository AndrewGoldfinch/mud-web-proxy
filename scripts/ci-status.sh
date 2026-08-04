#!/usr/bin/env bash
#
# Poll a pull request's checks until they reach a terminal state, then print
# the logs of whatever failed.
#
#   scripts/ci-status.sh          the PR for the current branch
#   scripts/ci-status.sh 104      an explicit PR number
#
# Environment:
#   CI_STATUS_INTERVAL   seconds between polls (default 20)
#   CI_STATUS_TIMEOUT    seconds before giving up (default 1200)
#
# Exit codes: 0 all checks passed · 1 at least one failed · 2 usage/setup
# problem · 3 timed out with checks still running.
#
# Deliberately uses `gh pr view --json statusCheckRollup` rather than
# `gh pr checks --json`: the latter needs gh >= 2.50 and this repo has been
# built against 2.46. `gh pr checks --watch` exists but neither reports which
# job failed in a parseable form nor fetches logs, which is the whole point.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

INTERVAL="${CI_STATUS_INTERVAL:-20}"
TIMEOUT="${CI_STATUS_TIMEOUT:-1200}"

case "${1:-}" in
  -h | --help)
    sed -n '3,15p' "$0" | sed 's/^# \?//'
    exit 0
    ;;
esac

command -v gh >/dev/null || {
  printf 'gh is not installed.\n' >&2
  exit 2
}
command -v jq >/dev/null || {
  printf 'jq is not installed.\n' >&2
  exit 2
}

PR="${1:-}"
if [ -z "$PR" ]; then
  PR="$(gh pr view --json number -q .number 2>/dev/null)" || true
  [ -n "$PR" ] || {
    printf 'No PR found for the current branch. Pass a PR number explicitly.\n' >&2
    exit 2
  }
fi

printf 'Watching PR #%s (poll %ss, timeout %ss)\n' "$PR" "$INTERVAL" "$TIMEOUT"

rollup() { gh pr view "$PR" --json statusCheckRollup -q '.statusCheckRollup[]' 2>/dev/null; }

DEADLINE=$(( $(date +%s) + TIMEOUT ))
while :; do
  SNAP="$(rollup)"
  EMPTY=0
  if [ -z "$SNAP" ]; then
    # Either checks have not been created yet, or the API call hiccuped.
    # Both mean "not terminal" — retry rather than reporting a false pass.
    EMPTY=1
    PENDING=1
  else
    # A check is terminal when status is COMPLETED. Older/external checks may
    # carry `state` instead of `status`/`conclusion`; treat a null status with
    # a non-PENDING state as terminal so a legacy commit status cannot hang
    # the loop forever.
    PENDING="$(printf '%s' "$SNAP" | jq -s '[.[]
      | select((.status // "") != "COMPLETED")
      | select(((.status // null) != null) or ((.state // "PENDING") == "PENDING"))
    ] | length')"
  fi

  if [ "${PENDING:-1}" -eq 0 ]; then
    break
  fi

  NOW="$(date +%s)"
  if [ "$NOW" -ge "$DEADLINE" ]; then
    printf '\nTimed out after %ss with %s check(s) still running.\n' "$TIMEOUT" "$PENDING" >&2
    printf '%s' "$SNAP" | jq -rs '.[] | "  \(.name // .context): \(.status // .state // "?")"' >&2
    exit 3
  fi

  if ((EMPTY)); then
    printf '  no checks reported yet (%ss elapsed)\n' "$(( NOW - DEADLINE + TIMEOUT ))"
  else
    printf '  %s pending… (%ss elapsed)\n' "$PENDING" "$(( NOW - DEADLINE + TIMEOUT ))"
  fi
  sleep "$INTERVAL"
done

printf '\nFinal state:\n'
printf '%s' "$SNAP" | jq -rs '.[] | "  \(.conclusion // .state // "?")  \(.name // .context)"' | sort

# Allowlist the values that mean "fine", rather than enumerating failures.
#
# Enumerating failures is how this got it wrong the first time: the list
# omitted STALE and STARTUP_FAILURE, both non-success members of GitHub's
# CheckConclusionState, so a run that hit either printed "All checks passed"
# and exited 0. Any conclusion GitHub adds in future is now treated as a
# failure until someone deliberately adds it here — the safe direction.
FAILING="$(printf '%s' "$SNAP" | jq -rs '.[]
  | select(((.conclusion // .state // "") | ascii_upcase)
           | . == "FAILURE" or . == "TIMED_OUT" or . == "ACTION_REQUIRED")
  | "\(.name // .context)\t\(.conclusion // .state // "?")\t\(.detailsUrl // "")"')"

if [ -z "$FAILING" ]; then
  printf '\nAll checks passed.\n'
  exit 0
fi

printf '\nFailing checks:\n%s\n' "$FAILING" | sed 's/\t/  /'

# detailsUrl looks like .../actions/runs/<run_id>/job/<job_id>. Fetch each
# distinct run once — several failing jobs usually share one run, and
# --log-failed already prints every failed job in it.
RUN_IDS="$(printf '%s' "$FAILING" | grep -oE '/actions/runs/[0-9]+' | grep -oE '[0-9]+$' | sort -u)"
if [ -z "$RUN_IDS" ]; then
  printf '\nNo workflow run id in the check URLs — open the PR to see details.\n'
  exit 1
fi

for run in $RUN_IDS; do
  printf '\n\033[1m── failed logs, run %s\033[0m\n' "$run"
  gh run view "$run" --log-failed 2>&1 | tail -80
done

exit 1
