#!/usr/bin/env bash
#
# Run the same gates CI runs, in the same order, before you push.
#
# This mirrors the `quality` job in .github/workflows/test.yml step for step.
# The point is that a green preflight means a green `quality` job — if the two
# ever drift, this script is wrong and should be corrected, not worked around.
#
#   scripts/preflight.sh          quality job only (fast, the usual case)
#   scripts/preflight.sh --full   + mock-e2e, dependency-scan, container
#
# Unlike CI, this does not stop at the first failure: it runs everything and
# reports every gate that failed. A push blocked by three problems should cost
# one run, not three.
#
# Idempotent and read-only apart from `bun install --frozen-lockfile`, which
# only ever brings node_modules into line with the committed lockfile — and
# fails loudly rather than rewriting it if the lockfile is stale, which is
# itself a CI failure worth catching here.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FULL=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    -h | --help)
      sed -n '3,17p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      printf 'unknown option: %s (try --help)\n' "$arg" >&2
      exit 2
      ;;
  esac
done

FAILED=()
PASSED=()
SKIPPED=()

run_gate() {
  local label="$1"
  shift
  printf '\n\033[1m── %s\033[0m\n' "$label"
  if "$@"; then
    PASSED+=("$label")
  else
    FAILED+=("$label")
  fi
}

# Order matches the `quality` job exactly. check:bun-version runs first there
# because every later gate is meaningless under the wrong runtime.
run_gate "check:bun-version" bun run check:bun-version
run_gate "install (frozen lockfile)" bun install --frozen-lockfile
run_gate "format" bun run format
run_gate "check:config-docs" bun run check:config-docs
run_gate "check:defect-classes" bun run check:defect-classes
run_gate "typecheck" bun run typecheck
run_gate "lint" bun run lint
run_gate "test:unit" bun run test:unit
run_gate "build" bun run build

if ((FULL)); then
  # This map DRIVES --full. It is executable data, not documentation: if a
  # job is listed as cmd: and the command is wrong, --full breaks loudly. The
  # previous version described its coverage in prose, which let the claim and
  # the behaviour drift apart silently (review on #107, then again on #109).
  #
  # check:defect-classes fails the build if these keys and the job list in
  # .github/workflows/test.yml disagree in either direction.
  declare -A CI_JOB_COVERAGE=(
    [quality]="inline"
    [mock-e2e]="cmd:bun run test:e2e:mock"
    [dependency-scan]="cmd:bun run audit"
    [container]="docker:bash tests/container/run.sh"
    [secret-scan]="skip:gitleaks GitHub Action, no local invocation"
  )

  for job in "${!CI_JOB_COVERAGE[@]}"; do
    spec="${CI_JOB_COVERAGE[$job]}"
    case "$spec" in
      inline) ;; # already covered by the quality gates above
      cmd:*) run_gate "$job" bash -c "${spec#cmd:}" ;;
      docker:*)
        if docker info >/dev/null 2>&1; then
          run_gate "$job" bash -c "${spec#docker:}"
        else
          printf '\n\033[1m── %s\033[0m\n  SKIPPED — no Docker daemon.\n' "$job"
          SKIPPED+=("$job (no Docker daemon)")
        fi
        ;;
      skip:*) SKIPPED+=("$job (${spec#skip:})") ;;
      *)
        printf 'preflight: unknown coverage spec for %s: %s\n' "$job" "$spec" >&2
        FAILED+=("$job (bad coverage spec)")
        ;;
    esac
  done
fi

printf '\n\033[1m── summary\033[0m\n'
for g in "${PASSED[@]:-}"; do
  [ -n "$g" ] && printf '  \033[32mPASS\033[0m  %s\n' "$g"
done
for g in "${FAILED[@]:-}"; do
  [ -n "$g" ] && printf '  \033[31mFAIL\033[0m  %s\n' "$g"
done
for g in "${SKIPPED[@]:-}"; do
  [ -n "$g" ] && printf '  \033[33mSKIP\033[0m  %s\n' "$g"
done

if ((${#FAILED[@]} > 0)); then
  printf '\n%d gate(s) failed — CI will fail the same way. Fix before pushing.\n' "${#FAILED[@]}" >&2
  printf 'Formatting problems: run `bun run format:fix`. Lint: `bun run lint:fix`.\n' >&2
  exit 1
fi

if ((FULL)); then
  printf '\nAll runnable gates passed. See SKIP lines for CI jobs not covered locally.\n'
else
  printf '\nAll quality gates passed. `--full` also runs mock-e2e, audit, and container.\n'
fi
