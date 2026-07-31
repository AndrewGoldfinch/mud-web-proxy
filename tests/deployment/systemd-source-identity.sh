#!/usr/bin/env bash

set -euo pipefail

[[ "$#" -eq 1 || "$#" -ge 4 ]] || exit 64
readonly repository="$1"
shift

[[ -d "${repository}" && ! -L "${repository}" ]] || exit 65
repository_root="$(git -C "${repository}" rev-parse --show-toplevel)" || exit 65
repository_root="$(cd "${repository_root}" && pwd -P)"
requested_root="$(cd "${repository}" && pwd -P)"
[[ "${repository_root}" == "${requested_root}" ]] || exit 65

head_commit="$(git -C "${repository}" rev-parse --verify 'HEAD^{commit}')" ||
  exit 65
[[ "${head_commit}" =~ ^[0-9a-f]{40}$ ]] || exit 65
tracked_status="$(
  git -C "${repository}" status --porcelain=v1 --untracked-files=no
)" || exit 65
[[ -z "${tracked_status}" ]] || exit 65

if [[ "$#" -eq 0 ]]; then
  printf '%s\n' "${head_commit}"
  exit 0
fi

readonly evidence_dir="$1"
readonly expected_commit="$2"
shift 2

[[ "${expected_commit}" =~ ^[0-9a-f]{40}$ ]] || exit 64
[[ "${head_commit}" == "${expected_commit}" ]] || exit 65
[[ -d "${evidence_dir}" && ! -L "${evidence_dir}" ]] || exit 65

for source_file in "$@"; do
  [[ "${source_file}" != /* &&
    "${source_file}" != .. &&
    "${source_file}" != ../* &&
    "${source_file}" != */../* ]] || exit 64
  git -C "${repository}" ls-files --error-unmatch -- "${source_file}" \
    >/dev/null 2>&1 || exit 65
  [[ -f "${repository}/${source_file}" &&
    ! -L "${repository}/${source_file}" ]] || exit 65
done

umask 077
identity_staging="$(mktemp "${evidence_dir}/.source-identity.XXXXXX")"
manifest_staging="$(mktemp "${evidence_dir}/.source-files.XXXXXX")"
cleanup() {
  rm -f "${identity_staging}" "${manifest_staging}"
}
trap cleanup EXIT

{
  printf 'git-head=%s\n' "${head_commit}"
  printf 'tracked-checkout-clean=yes\n'
} >"${identity_staging}"
(
  cd "${repository}"
  sha256sum -- "$@"
) >"${manifest_staging}"
chmod 0600 "${identity_staging}" "${manifest_staging}"
mv -Tf "${identity_staging}" "${evidence_dir}/source-identity.txt"
mv -Tf "${manifest_staging}" "${evidence_dir}/source-files.sha256"
trap - EXIT
