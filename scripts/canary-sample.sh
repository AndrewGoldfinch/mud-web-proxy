#!/usr/bin/env bash
# One canary sample, appended to a CSV.
#
# MWP-123 step 6 requires seven days of evidence for memory, file descriptors,
# reconnect behaviour, and session cleanup, and says explicitly that growth in
# any of those is a blocker rather than a curiosity. That standard needs a
# series, not a glance, so this writes one row per invocation and a timer runs
# it. Analysis lives in `canary-report.ts`; this script only observes.
#
# Deliberately read-only and dependency-free: it runs against a production
# service for a week, so it touches nothing, installs nothing, and needs no
# configuration change to the thing it is watching.

set -uo pipefail

readonly SERVICE="${MWP_CANARY_SERVICE:-mud-web-proxy.service}"
readonly OUT="${MWP_CANARY_CSV:-/var/lib/mud-web-proxy-canary/samples.csv}"

mkdir -p "$(dirname "$OUT")"

# Header once, so the file is self-describing when it is attached as evidence.
if [[ ! -s "$OUT" ]]; then
  echo 'iso8601,unix,pid,rss_kib,fds,threads,nrestarts,active_sockets,mem_max_bytes,nofile_limit' >"$OUT"
fi

now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
now_unix="$(date -u +%s)"

pid="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null)"
[[ "$pid" =~ ^[0-9]+$ ]] || pid=0

rss=""
fds=""
threads=""
if [[ "$pid" != "0" && -r "/proc/$pid/status" ]]; then
  rss="$(awk '/^VmRSS:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)"
  threads="$(awk '/^Threads:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)"
  # ls rather than a glob: the directory can be large and entries vanish
  # mid-read on a live process, which a glob turns into an error.
  fds="$(ls -U "/proc/$pid/fd" 2>/dev/null | wc -l)"
fi

# A restart resets rss and fds, so the count is what distinguishes "flat
# because it is healthy" from "flat because it keeps dying".
nrestarts="$(systemctl show -p NRestarts --value "$SERVICE" 2>/dev/null)"
[[ "$nrestarts" =~ ^[0-9]+$ ]] || nrestarts=""

# Session count without requiring ENABLE_DIAGNOSTICS on a production host:
# the service already logs it on every connect and disconnect. Best effort by
# construction — if nothing connected in the window there is no line, which is
# reported as empty rather than as zero, because those mean different things.
active_sockets="$(
  journalctl -u "$SERVICE" --since '15 min ago' --no-pager -o cat 2>/dev/null |
    grep -oE 'active sockets: [0-9]+' | tail -1 | grep -oE '[0-9]+$'
)"

# The enforced ceilings, recorded per row so the report can express growth as
# a fraction of the limit rather than as a bare number.
mem_max="$(systemctl show -p MemoryMax --value "$SERVICE" 2>/dev/null)"
[[ "$mem_max" =~ ^[0-9]+$ ]] || mem_max=""
nofile="$(systemctl show -p LimitNOFILE --value "$SERVICE" 2>/dev/null)"
[[ "$nofile" =~ ^[0-9]+$ ]] || nofile=""

printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
  "$now_iso" "$now_unix" "$pid" "$rss" "$fds" "$threads" \
  "$nrestarts" "$active_sockets" "$mem_max" "$nofile" >>"$OUT"
