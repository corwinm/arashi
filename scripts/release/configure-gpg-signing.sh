#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'GPG signing setup failed: %s\n' "$*" >&2
  exit 1
}

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
[[ "$RUNNER_TEMP" == /* ]] || fail "RUNNER_TEMP must be an absolute path"
runner_temp_root=$(cd "$RUNNER_TEMP" && pwd -P) || fail "RUNNER_TEMP could not be resolved"
[[ "$runner_temp_root" != "/" ]] || fail "RUNNER_TEMP must not resolve to the filesystem root"
state_root="${runner_temp_root}/arashi-release-gpg"
gnupg_home="${state_root}/gnupg"

cleanup() {
  if [[ -d "$gnupg_home" ]]; then
    GNUPGHOME="$gnupg_home" gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  fi
  rm -rf -- "$state_root"
}

if [[ "${1:-}" == "--cleanup" ]]; then
  cleanup
  exit 0
fi

required_variables=(
  GITHUB_ENV
  GITHUB_OUTPUT
  RELEASE_GPG_PRIVATE_KEY
  RELEASE_GPG_PASSPHRASE
  RELEASE_GPG_KEY_NAME
  RELEASE_GPG_KEY_EMAIL
)
for variable in "${required_variables[@]}"; do
  [[ -n "${!variable:-}" ]] || fail "required environment variable ${variable} is missing"
done
[[ "$RELEASE_GPG_PASSPHRASE" != *$'\n'* ]] || fail "release-key passphrase must not contain a newline"

temporary_key_file="${state_root}/release-key.asc"
passphrase_file="${state_root}/passphrase"
gpg_program="${state_root}/gpg-sign"

cleanup
trap cleanup EXIT
umask 077
mkdir -p "$gnupg_home"
printf '%s' "$RELEASE_GPG_PRIVATE_KEY" >"$temporary_key_file"
printf '%s' "$RELEASE_GPG_PASSPHRASE" >"$passphrase_file"

GNUPGHOME="$gnupg_home" gpg --batch --quiet --import "$temporary_key_file"
rm -f -- "$temporary_key_file"

fingerprint=$(
  GNUPGHOME="$gnupg_home" gpg --batch --with-colons --list-secret-keys 2>/dev/null |
    awk -F: '$1 == "fpr" { print toupper($10); exit }'
)
[[ "$fingerprint" =~ ^[0-9A-F]{40}$ ]] || fail "imported key did not expose a full primary fingerprint"

imported_uid=$(
  GNUPGHOME="$gnupg_home" gpg --batch --with-colons --list-secret-keys "$fingerprint" 2>/dev/null |
    awk -F: '$1 == "uid" { print $10; exit }'
)
expected_uid="${RELEASE_GPG_KEY_NAME} <${RELEASE_GPG_KEY_EMAIL}>"
[[ "$imported_uid" == "$expected_uid" ]] || fail "imported key UID does not match the expected release identity"

cat >"$gpg_program" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
: "${ARASHI_GPG_PASSPHRASE_FILE:?ARASHI_GPG_PASSPHRASE_FILE is required}"
exec 3<"$ARASHI_GPG_PASSPHRASE_FILE"
exec gpg --batch --no-tty --pinentry-mode loopback --passphrase-fd 3 "$@"
SCRIPT
chmod 700 "$gpg_program"

{
  printf 'GNUPGHOME=%s\n' "$gnupg_home"
  printf 'ARASHI_GPG_PASSPHRASE_FILE=%s\n' "$passphrase_file"
} >>"$GITHUB_ENV"
printf 'fingerprint=%s\n' "$fingerprint" >>"$GITHUB_OUTPUT"

export GNUPGHOME="$gnupg_home"
export ARASHI_GPG_PASSPHRASE_FILE="$passphrase_file"
git config --local gpg.format openpgp
git config --local gpg.program "$gpg_program"
git config --local user.signingkey "$fingerprint"
git config --local commit.gpgsign true
git config --local user.name "$RELEASE_GPG_KEY_NAME"
git config --local user.email "$RELEASE_GPG_KEY_EMAIL"

trap - EXIT
printf 'Configured repository-local GPG commit signing for fingerprint %s\n' "$fingerprint"
