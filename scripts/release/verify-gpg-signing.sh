#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'GPG signing preflight failed: %s\n' "$*" >&2
  exit 1
}

required_variables=(
  RELEASE_GPG_FINGERPRINT
  RELEASE_GPG_KEY_NAME
  RELEASE_GPG_KEY_EMAIL
  GIT_AUTHOR_NAME
  GIT_AUTHOR_EMAIL
  GIT_COMMITTER_NAME
  GIT_COMMITTER_EMAIL
)

for variable in "${required_variables[@]}"; do
  [[ -n "${!variable:-}" ]] || fail "required environment variable ${variable} is missing"
done

[[ "$RELEASE_GPG_KEY_NAME" == "$GIT_AUTHOR_NAME" ]] || fail "imported key name does not match Git author name"
[[ "$RELEASE_GPG_KEY_NAME" == "$GIT_COMMITTER_NAME" ]] || fail "imported key name does not match Git committer name"
[[ "$RELEASE_GPG_KEY_EMAIL" == "$GIT_AUTHOR_EMAIL" ]] || fail "imported key email does not match Git author email"
[[ "$RELEASE_GPG_KEY_EMAIL" == "$GIT_COMMITTER_EMAIL" ]] || fail "imported key email does not match Git committer email"

expected_fingerprint=$(printf '%s' "$RELEASE_GPG_FINGERPRINT" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')
[[ "$expected_fingerprint" =~ ^[0-9A-F]{40}$ ]] || fail "imported key fingerprint is not a full 40-character fingerprint"

secret_key_fingerprint=$(
  gpg --batch --with-colons --list-secret-keys "$expected_fingerprint" 2>/dev/null |
    awk -F: '$1 == "fpr" { print toupper($10); exit }'
)
[[ "$secret_key_fingerprint" == "$expected_fingerprint" ]] || fail "imported secret key fingerprint does not match expected fingerprint"

head_before=$(git rev-parse HEAD)
refs_before=$(git show-ref || true)
status_before=$(git status --porcelain=v1 --untracked-files=all)
git_dir=$(git rev-parse --absolute-git-dir)
index_path=$(git rev-parse --git-path index)
objects_path="${git_dir}/objects"
index_before=$(git hash-object "$index_path")
objects_before=$(git count-objects -v)

temporary_object_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/arashi-gpg-preflight.XXXXXX")
cleanup() {
  unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  rm -rf "$temporary_object_root"
}
trap cleanup EXIT
mkdir -p "${temporary_object_root}/objects"
export GIT_OBJECT_DIRECTORY="${temporary_object_root}/objects"
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects_path"

tree_oid=$(git rev-parse 'HEAD^{tree}')
commit_oid=$(printf 'Arashi release signing preflight\n' | git commit-tree -S"$expected_fingerprint" "$tree_oid" -p "$head_before")
verification_output=$(git verify-commit --raw "$commit_oid" 2>&1) || fail "Git could not verify the isolated signed commit"
validsig=$(printf '%s\n' "$verification_output" | awk '/\[GNUPG:\] VALIDSIG / { print; exit }')
[[ -n "$validsig" ]] || fail "git verify-commit did not report a VALIDSIG fingerprint"
valid_fingerprint=$(printf '%s\n' "$validsig" | awk '{ print toupper($3) }')
valid_primary_fingerprint=$(printf '%s\n' "$validsig" | awk '{ print toupper($12) }')
if [[ "$valid_fingerprint" != "$expected_fingerprint" && "$valid_primary_fingerprint" != "$expected_fingerprint" ]]; then
  fail "signed commit fingerprint does not match imported key fingerprint"
fi

commit_author_name=$(git show -s --format='%an' "$commit_oid")
commit_author_email=$(git show -s --format='%ae' "$commit_oid")
commit_committer_name=$(git show -s --format='%cn' "$commit_oid")
commit_committer_email=$(git show -s --format='%ce' "$commit_oid")
[[ "$commit_author_name" == "$GIT_AUTHOR_NAME" ]] || fail "signed commit author name does not match release identity"
[[ "$commit_author_email" == "$GIT_AUTHOR_EMAIL" ]] || fail "signed commit author email does not match release identity"
[[ "$commit_committer_name" == "$GIT_COMMITTER_NAME" ]] || fail "signed commit committer name does not match release identity"
[[ "$commit_committer_email" == "$GIT_COMMITTER_EMAIL" ]] || fail "signed commit committer email does not match release identity"

cleanup
trap - EXIT

head_after=$(git rev-parse HEAD)
refs_after=$(git show-ref || true)
status_after=$(git status --porcelain=v1 --untracked-files=all)
index_after=$(git hash-object "$index_path")
objects_after=$(git count-objects -v)

[[ "$head_after" == "$head_before" ]] || fail "preflight changed HEAD"
[[ "$refs_after" == "$refs_before" ]] || fail "preflight changed repository refs"
[[ "$status_after" == "$status_before" ]] || fail "preflight changed worktree or index status"
[[ "$index_after" == "$index_before" ]] || fail "preflight changed the index"
[[ "$objects_after" == "$objects_before" ]] || fail "preflight changed the normal Git object store"

printf 'GPG signing preflight passed for fingerprint %s\n' "$expected_fingerprint"
