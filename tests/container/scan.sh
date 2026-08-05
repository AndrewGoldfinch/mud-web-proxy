#!/usr/bin/env bash
#
# Fail when the runtime image carries a known HIGH or CRITICAL vulnerability.
#
# The runtime stage only. Scanning the build stage reports toolchain findings
# that never ship, which trains everyone to ignore the output — the failure
# mode a scanner is supposed to prevent.
#
# This gate will occasionally block unrelated work when a new CVE lands in the
# Bun base image. That pressure is the point: an image with a known critical
# vulnerability should not be one merge away from being published. If it ever
# becomes untenable, the answer is a checked-in ignore file with justifications
# and expiry dates, not turning the gate off.
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly IMAGE='mud-web-proxy:scan'
readonly TRIVY_IMAGE='aquasec/trivy:0.73.0'
readonly SEVERITY='HIGH,CRITICAL'

# Overridable so the "prove it fails" step can point at a known-bad image
# without editing this script.
SCAN_TARGET="${MWP_SCAN_TARGET:-${IMAGE}}"

fail() {
  echo "image-scan: $*" >&2
  exit 1
}

if ! docker info >/dev/null 2>&1; then
  echo 'image-scan: SKIP (docker unavailable)'
  exit 0
fi

if [[ "${SCAN_TARGET}" == "${IMAGE}" ]]; then
  echo "image-scan: building ${IMAGE}"
  docker build --pull --tag "${IMAGE}" "${REPO_ROOT}" >/dev/null ||
    fail 'image build failed'
fi

echo "image-scan: scanning ${SCAN_TARGET} for ${SEVERITY}"

# The Trivy DB lives in a named volume so repeated local runs do not re-download
# it.
#
# --exit-code 2 rather than 1 is deliberate. Trivy exits 1 for operational
# failures too — an unreachable registry, a bad tag, a missing image — and an
# early version of this script reported a failed pull as "found
# vulnerabilities". A scanner that cannot run must never be mistaken for a
# verdict, so findings get their own code and everything else is an error.
docker volume create mwp-trivy-cache >/dev/null

set +e
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v mwp-trivy-cache:/root/.cache/trivy \
  "${TRIVY_IMAGE}" image \
  --severity "${SEVERITY}" \
  --exit-code 2 \
  --ignore-unfixed \
  --scanners vuln \
  --format table \
  "${SCAN_TARGET}"
status=$?
set -e

case ${status} in
  0) ;;
  2) fail "found ${SEVERITY} vulnerabilities in ${SCAN_TARGET} (see the table above)" ;;
  *) fail "trivy could not complete the scan (exit ${status}) — this is a scanner failure, not a clean result" ;;
esac

echo "image-scan: no ${SEVERITY} vulnerabilities with a fix available"
