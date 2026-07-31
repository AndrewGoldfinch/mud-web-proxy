#!/usr/bin/env bash

set -euo pipefail

[[ "$#" -eq 1 || "$#" -eq 3 ]] || exit 64
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

umask 077
identity_staging="$(mktemp "${evidence_dir}/.source-identity.XXXXXX")"
manifest_staging="$(mktemp "${evidence_dir}/.source-files.XXXXXX")"
tracked_list="$(mktemp "${evidence_dir}/.source-list.XXXXXX")"
cleanup() {
  rm -f "${identity_staging}" "${manifest_staging}" "${tracked_list}"
}
trap cleanup EXIT

git -C "${repository}" ls-files -z >"${tracked_list}" || exit 65
mapfile -d '' -t tracked_files <"${tracked_list}"
[[ "${#tracked_files[@]}" -gt 0 ]] || exit 65
for source_file in "${tracked_files[@]}"; do
  [[ -f "${repository}/${source_file}" &&
    ! -L "${repository}/${source_file}" ]] || exit 65
done

{
  printf 'git-head=%s\n' "${head_commit}"
  printf 'tracked-checkout-clean=yes\n'
} >"${identity_staging}"
(
  cd "${repository}"
  sha256sum -- "${tracked_files[@]}"
) >"${manifest_staging}"
chmod 0600 "${identity_staging}" "${manifest_staging}"
mv -Tf "${identity_staging}" "${evidence_dir}/source-identity.txt"
mv -Tf "${manifest_staging}" "${evidence_dir}/source-files.sha256"
rm -f "${tracked_list}"
trap - EXIT
