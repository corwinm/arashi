#!/usr/bin/env bash

set -euo pipefail

PROJECT_NAME="arashi"
BINARY_NAME="arashi.bin"
WRAPPER_ASSET="arashi"
ALIAS_ASSET="aw"
UNINSTALL_HELPER_ASSET="uninstall.sh"
ALIAS_MARKER="arashi-managed-alias:aw:v1"
LEDGER_NAME=".arashi-managed-entrypoints.json"
LEDGER_SCHEMA_VERSION=2
PATH_MUTATION_PROFILE=""
PATH_MUTATION_BYTES=""
PATH_MUTATION_JSON=""
PATH_MUTATION_BACKUP=""
PATH_MUTATION_PROFILE_CREATED=false
REPOSITORY="corwinm/arashi"
CHECKSUM_MANIFEST="arashi-checksums.txt"
VERSION_INPUT="latest"
INSTALL_DIR_OVERRIDE=""
NO_MODIFY_PATH=false
DEBUG_LOG=false
PROGRESS_UI=false
SHELL_INTEGRATION_MODE="prompt"
SHELL_INTEGRATION_START="# >>> arashi shell integration >>>"
SHELL_INTEGRATION_END="# <<< arashi shell integration <<<"

log() {
  printf '==> %s\n' "$*"
}

log_debug() {
  if [ "$DEBUG_LOG" = "true" ]; then
    printf 'DEBUG: %s\n' "$*" >&2
  fi
}

warn() {
  printf '\033[0;91mWARNING: %s\n\033[0m' "$*" >&2
}

fail() {
  printf 'error: %s\n' "$*" >&2
  printf 'Try: npm install -g arashi\n' >&2
  printf 'Or see: https://github.com/%s/blob/main/docs/INSTALLATION.md\n' "$REPOSITORY" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install Arashi from GitHub Releases.

Usage:
  install.sh [--version <version>] [--install-dir <path>]

Options:
  --version, -v      Install a specific version (for example 1.4.0 or v1.4.0)
  --install-dir      Override target install directory (default: ~/.arashi/bin)
  --shell-integration     Enable shell integration without prompting
  --no-shell-integration  Skip shell integration setup
  --help, -h         Show this help

Environment:
  ARASHI_VERSION     Same as --version
  ARASHI_INSTALL_DIR Same as --install-dir
  ARASHI_SHELL_INTEGRATION  yes|no|prompt (default: prompt)
EOF
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command not found: $command_name"
}

parse_args() {
  if [ -n "${ARASHI_VERSION:-}" ]; then
    VERSION_INPUT="$ARASHI_VERSION"
  fi
  if [ -n "${ARASHI_INSTALL_DIR:-}" ]; then
    INSTALL_DIR_OVERRIDE="$ARASHI_INSTALL_DIR"
  fi
  if [ -n "${ARASHI_SHELL_INTEGRATION:-}" ]; then
    SHELL_INTEGRATION_MODE="$ARASHI_SHELL_INTEGRATION"
  fi
  if [ "${ARASHI_NO_MODIFY_PATH:-}" = "1" ]; then
    NO_MODIFY_PATH=true
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version|-v)
        shift
        [ "$#" -gt 0 ] || fail "Missing value for --version"
        VERSION_INPUT="$1"
        ;;
      --install-dir)
        shift
        [ "$#" -gt 0 ] || fail "Missing value for --install-dir"
        INSTALL_DIR_OVERRIDE="$1"
        ;;
      --debug|-d)
        DEBUG_LOG=true
        set -x
        ;;
      --no-modify-path)
        NO_MODIFY_PATH=true
        ;;
      --shell-integration)
        SHELL_INTEGRATION_MODE="yes"
        ;;
      --no-shell-integration)
        SHELL_INTEGRATION_MODE="no"
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
    shift
  done
}

normalize_version() {
  local version="$1"
  if [ -z "$version" ] || [ "$version" = "latest" ] || [ "$version" = "stable" ]; then
    printf 'latest\n'
    return
  fi
  printf '%s\n' "${version#v}"
}

detect_platform_asset() {
  local os
  local arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os-$arch" in
    darwin-arm64|darwin-aarch64)
      printf 'arashi-macos-arm64\n'
      ;;
    linux-x86_64|linux-amd64)
      printf 'arashi-linux-x64\n'
      ;;
    mingw64_nt-*-x86_64|msys_nt-*-x86_64|cygwin_nt-*-x86_64)
      fail "Windows detected. Use npm install -g arashi or the Windows release binary"
      ;;
    *)
      fail "Unsupported platform: $os-$arch"
      ;;
  esac
}

spinner_frame() {
  local frame_index="$1"
  case "$frame_index" in
    0) printf '|'
      ;;
    1) printf '/'
      ;;
    2) printf '-'
      ;;
    *) printf '\\'
      ;;
  esac
}

file_size_bytes() {
  local file_path="$1"
  if [ -f "$file_path" ]; then
    wc -c < "$file_path" | tr -d '[:space:]'
    return
  fi
  printf '0'
}

progress_bar_width() {
  local cols=80
  local width

  if command -v tput >/dev/null 2>&1 && [ -n "${TERM:-}" ] && [ "${TERM}" != "dumb" ]; then
    cols="$(tput cols 2>/dev/null || printf '80')"
  fi

  # "Loading " + bar + spacing + percentage
  local fixed_width=22
  width="$((cols - fixed_width))"
  if [ "$width" -lt 10 ]; then
    width=10
  fi
  if [ "$width" -gt 40 ]; then
    width=40
  fi

  printf '%s' "$width"
}

init_progress_ui() {
  if [ "$DEBUG_LOG" = "true" ]; then
    return
  fi
  if [ ! -t 1 ] || [ ! -t 2 ]; then
    return
  fi

  if [ -w /dev/tty ]; then
    exec 4>/dev/tty || return
  else
    exec 4>&2 || return
  fi

  printf '\n' >&4
  printf '\033[?25l' >&4
  PROGRESS_UI=true
}

cleanup_progress_ui() {
  if [ "$PROGRESS_UI" = "true" ]; then
    printf '\033[?25h' >&4
    exec 4>&- 2>/dev/null || true
    PROGRESS_UI=false
  fi
}

render_progress_line() {
  printf '\r\033[2K%s' "$1" >&4
}

render_progress_done_line() {
  printf '\r\033[2K%s\n\n' "$1" >&4
}

progress_bar() {
  local current="$1"
  local total="$2"
  local width="$3"
  local filled=0
  local empty
  local percent=0
  local block_fill='■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■'
  local block_empty='････････････････････････････････････'

  if [ "$total" -gt 0 ] 2>/dev/null; then
    if [ "$current" -gt "$total" ]; then
      current="$total"
    fi
    filled="$((current * width / total))"
    percent="$((current * 100 / total))"
  fi

  if [ "$filled" -gt "$width" ]; then
    filled="$width"
  fi
  empty="$((width - filled))"

  printf '[%s%s] %3d%%' "${block_fill:0:filled}" "${block_empty:0:empty}" "$percent"
}

asset_content_length() {
  local url="$1"
  local content_length

  content_length="$(
    curl --silent --show-error --location --head --retry 3 --retry-delay 1 --connect-timeout 15 "$url" 2>/dev/null |
      awk 'BEGIN{IGNORECASE=1} /^content-length:/ {value=$2} END {gsub("\\r", "", value); if (value ~ /^[0-9]+$/) print value; else print 0}'
  )"

  case "$content_length" in
    ''|*[!0-9]*)
      printf '0'
      ;;
    *)
      printf '%s' "$content_length"
      ;;
  esac
}

download_file() {
  local url="$1"
  local destination="$2"
  local label="$3"
  local finish_line="${4:-true}"

  log_debug "Downloading $label from $url"

  if [ "$PROGRESS_UI" = "true" ]; then

    local spinner_index=0
    local spinner
    local current_bytes
    local total_bytes
    local bar
    local bar_width
    local line
    local curl_pid

    bar_width="$(progress_bar_width)"
    total_bytes="$(asset_content_length "$url")"

    curl --silent --fail --show-error --location --retry 3 --retry-delay 1 --connect-timeout 15 --output "$destination" "$url" &
    curl_pid="$!"

    while kill -0 "$curl_pid" >/dev/null 2>&1; do
      if [ "$total_bytes" -gt 0 ] 2>/dev/null; then
        current_bytes="$(file_size_bytes "$destination")"
        bar="$(progress_bar "$current_bytes" "$total_bytes" "$bar_width")"
        line="Loading $bar"
        render_progress_line "$line"
      else
        spinner="$(spinner_frame "$spinner_index")"
        line="Loading $spinner"
        render_progress_line "$line"
      fi

      spinner_index="$(((spinner_index + 1) % 4))"
      sleep 0.1
    done

    if wait "$curl_pid"; then
      if [ "$total_bytes" -gt 0 ] 2>/dev/null; then
        bar="$(progress_bar "$total_bytes" "$total_bytes" "$bar_width")"
        line="Loading $bar"
      else
        line="Loading done"
      fi

      if [ "$finish_line" = "true" ]; then
        render_progress_done_line "$line"
      else
        render_progress_line "$line"
      fi
      return
    fi

    render_progress_done_line "Loading failed"
    fail "Unable to download $label from $url"
  fi

  log "Downloading $label"
  curl --silent --fail --show-error --location --retry 3 --retry-delay 1 --connect-timeout 15 --output "$destination" "$url" || fail "Unable to download $label from $url"
}

sha256_file() {
  local file_path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | cut -d ' ' -f1
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | cut -d ' ' -f1
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file_path" | awk '{print $NF}'
    return
  fi
  fail "No SHA-256 tool found (tried shasum, sha256sum, and openssl)"
}

expected_checksum_for_asset() {
  local checksum_file="$1"
  local asset_name="$2"
  local expected=""

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    set -- $line
    if [ "${2:-}" = "$asset_name" ]; then
      expected="$1"
      break
    fi
  done < "$checksum_file"

  [ -n "$expected" ] || fail "Checksum entry for $asset_name not found"
  printf '%s\n' "$expected"
}

choose_install_dir() {
  if [ -n "$INSTALL_DIR_OVERRIDE" ]; then
    printf '%s\n' "$INSTALL_DIR_OVERRIDE"
    return
  fi

  [ -n "${HOME:-}" ] || fail "HOME is not set. Use ARASHI_INSTALL_DIR to provide an install path"

  local default_install_dir
  default_install_dir="$HOME/.arashi/bin"
  printf '%s\n' "$default_install_dir"
}

normalize_absolute_path() {
  local input="$1" part output="" index
  local parts=() normalized=()
  case "$input" in /*) ;; *) input="$(pwd)/$input" ;; esac
  IFS='/' read -r -a parts <<< "$input"
  for part in "${parts[@]}"; do
    case "$part" in
      ''|.) ;;
      ..) if [ "${#normalized[@]}" -gt 0 ]; then index=$((${#normalized[@]} - 1)); unset "normalized[$index]"; fi ;;
      *) normalized+=("$part") ;;
    esac
  done
  for index in "${!normalized[@]}"; do output="$output/${normalized[$index]}"; done
  printf '%s\n' "${output:-/}"
}

json_escape() {
  printf '%s' "$1" | awk 'BEGIN { ORS="" } { if (NR > 1) printf "\\n"; gsub(/\\/, "\\\\"); gsub(/\"/, "\\\""); printf "%s", $0 }'
}

physical_command_path() {
  local path="$1" directory name physical_directory
  directory="$(dirname "$path")"
  name="$(basename "$path")"
  physical_directory="$(cd -P "$directory" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$physical_directory" "$name"
}

validate_current_ownership_ledger() {
  local install_dir="$1" ledger_path="$install_dir/$LEDGER_NAME" line_count line actual expected name role digest line_number
  line_count="$(wc -l < "$ledger_path" | tr -d '[:space:]')"
  [ "$line_count" = 12 ] || [ "$line_count" = 13 ] || return 1
  [ "$(sed -n '1p' "$ledger_path")" = '{' ] || return 1
  [ "$(sed -n '2p' "$ledger_path")" = '  "schemaVersion": 2,' ] || return 1
  [ "$(sed -n '3p' "$ledger_path")" = '  "installationChannel": "official-direct",' ] || return 1
  [ "$(sed -n '4p' "$ledger_path")" = '  "platform": "posix",' ] || return 1
  [ "$(sed -n '5p' "$ledger_path")" = "  \"installDirectory\": \"$(json_escape "$install_dir")\"," ] || return 1
  [ "$(sed -n '6p' "$ledger_path")" = '  "files": [' ] || return 1
  line_number=7
  for name in "$BINARY_NAME" "$PROJECT_NAME" "$ALIAS_ASSET" "$UNINSTALL_HELPER_ASSET"; do
    case "$name" in
      "$BINARY_NAME") role="native-executable" ;;
      "$PROJECT_NAME") role="canonical-wrapper" ;;
      "$ALIAS_ASSET") role="alias-wrapper" ;;
      *) role="uninstall-helper" ;;
    esac
    [ ! -L "$install_dir/$name" ] && [ -f "$install_dir/$name" ] && [ -r "$install_dir/$name" ] || return 1
    digest="$(sha256_file "$install_dir/$name")" || return 1
    line="$(sed -n "${line_number}p" "$ledger_path")"
    expected="    { \"relativePath\": \"$name\", \"role\": \"$role\", \"digest\": \"$digest\" }"
    [ "$line_number" -eq 10 ] || expected="$expected,"
    [ "$line" = "$expected" ] || return 1
    line_number=$((line_number + 1))
  done
  if [ "$line_count" = 12 ]; then
    [ "$(sed -n '11p' "$ledger_path")" = '  ]' ] || return 1
  else
    [ "$(sed -n '11p' "$ledger_path")" = '  ],' ] || return 1
    PATH_MUTATION_PROFILE="$(sed -n '12p' "$ledger_path" | LC_ALL=C awk '
      function valid(value, required, i,c,e) {
        if (required && value == "") return 0
        for (i=1;i<=length(value);i++) if (substr(value,i,1)=="\\") { i++; e=substr(value,i,1); if (e!="\\" && e!="\"" && e!="n") return 0 }
        return 1
      }
      function decode(value, output, i, c, escaped) {
        output=""
        for(i=1;i<=length(value);i++) {
          c=substr(value,i,1)
          if(c!="\\") { output=output c; continue }
          i++; escaped=substr(value,i,1)
          if(escaped=="n") output=output sprintf("%c",10)
          else output=output escaped
        }
        return output
      }
      {
        prefix="  \"pathMutation\": { \"profilePath\": \""; separator="\", \"insertedBytes\": \""; suffix="\" }"
        if (substr($0,1,length(prefix)) != prefix || substr($0,length($0)-length(suffix)+1) != suffix) exit 1
        body=substr($0,length(prefix)+1,length($0)-length(prefix)-length(suffix)); split_at=0; escaped=0
        for(i=1;i<=length(body)-length(separator)+1;i++){c=substr(body,i,1);if(!escaped && substr(body,i,length(separator))==separator){split_at=i;break}if(c=="\\"&&!escaped)escaped=1;else escaped=0}
        if(!split_at)exit 1; profile=substr(body,1,split_at-1); inserted=substr(body,split_at+length(separator))
        if(substr(profile,1,1)!="/" || !valid(profile,1) || !valid(inserted,1))exit 1
        printf "%s", decode(profile)
      }')" || return 1
    PATH_MUTATION_JSON="$(sed -n '12p' "$ledger_path")"
  fi
  [ "$(sed -n "${line_count}p" "$ledger_path")" = '}' ] || return 1
}

clear_recorded_path_mutation() {
  PATH_MUTATION_PROFILE=""
  PATH_MUTATION_BYTES=""
  PATH_MUTATION_JSON=""
}

recorded_path_mutation_is_current() {
  local install_dir="$1" path_line marker expected_json
  [ -n "$PATH_MUTATION_JSON" ] && [ -n "$PATH_MUTATION_PROFILE" ] || return 1
  [ ! -L "$PATH_MUTATION_PROFILE" ] && [ -f "$PATH_MUTATION_PROFILE" ] && [ -r "$PATH_MUTATION_PROFILE" ] || return 1

  path_line="$(build_posix_path_line "$install_dir")"
  marker="# Added by arashi installer"
  PATH_MUTATION_BYTES="$(printf '\n%s\n%s\n' "$marker" "$path_line")"
  expected_json="  \"pathMutation\": { \"profilePath\": \"$(json_escape "$PATH_MUTATION_PROFILE")\", \"insertedBytes\": \"$(json_escape "$PATH_MUTATION_BYTES")\" }"
  [ "$PATH_MUTATION_JSON" = "$expected_json" ] || return 1

  LC_ALL=C awk -v marker="$marker" -v path_line="$path_line" '
    {
      current=$0
      sub(/\r$/, "", current)
      if (NR > 2 && previous_previous == "" && previous == marker && current == path_line) count++
      previous_previous=previous
      previous=current
    }
    END { exit(count == 1 ? 0 : 1) }
  ' "$PATH_MUTATION_PROFILE"
}

preflight_alias_ownership() {
  local install_dir="$1"
  local alias_path="$install_dir/$ALIAS_ASSET"
  local ledger_path="$install_dir/$LEDGER_NAME"
  local resolved=""

  if [ ! -e "$ledger_path" ] && [ ! -L "$ledger_path" ]; then
    local unmanaged_name
    for unmanaged_name in "$BINARY_NAME" "$PROJECT_NAME" "$ALIAS_ASSET" "$UNINSTALL_HELPER_ASSET"; do
      if [ -e "$install_dir/$unmanaged_name" ] || [ -L "$install_dir/$unmanaged_name" ]; then
        printf 'error: unmanifested install collision at %s with no installer ownership ledger; move it aside or refresh deliberately from a proven official install\n' "$install_dir/$unmanaged_name" >&2
        return 1
      fi
    done
  fi

  if [ -e "$ledger_path" ] || [ -L "$ledger_path" ]; then
    if [ -L "$ledger_path" ] || [ ! -f "$ledger_path" ] || [ ! -r "$ledger_path" ]; then
      printf 'error: ownership ledger collision at %s; move or remove it deliberately before retrying\n' "$ledger_path" >&2
      return 1
    fi
    if grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*2([,[:space:]}])' "$ledger_path"; then
      validate_current_ownership_ledger "$install_dir" || {
        printf 'error: current ownership manifest failed validation at %s; repair deliberately before retrying\n' "$ledger_path" >&2
        return 1
      }
      return 0
    fi
    grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*1([,[:space:]}])' "$ledger_path" || {
      printf 'error: ownership ledger schema defect at %s; move or remove it deliberately before retrying\n' "$ledger_path" >&2
      return 1
    }
    if [ -e "$install_dir/$UNINSTALL_HELPER_ASSET" ] || [ -L "$install_dir/$UNINSTALL_HELPER_ASSET" ]; then
      printf 'error: legacy ownership metadata does not own %s; move it aside before refreshing\n' "$install_dir/$UNINSTALL_HELPER_ASSET" >&2
      return 1
    fi
    grep -Fq "\"installDirectory\": \"$(json_escape "$install_dir")\"" "$ledger_path" || {
      printf 'error: ownership ledger install-directory mismatch at %s; move or remove it deliberately before retrying\n' "$ledger_path" >&2
      return 1
    }
    [ "$(grep -c '"path"' "$ledger_path")" -eq 1 ] || {
      printf 'error: ownership ledger alias-set defect at %s; move or remove it deliberately before retrying\n' "$ledger_path" >&2
      return 1
    }
  fi

  if [ -e "$alias_path" ] || [ -L "$alias_path" ]; then
    if [ -L "$alias_path" ] || [ ! -f "$alias_path" ] || [ ! -r "$alias_path" ]; then
      printf 'error: aw collision at %s is not a readable regular managed file; move or remove it deliberately before retrying\n' "$alias_path" >&2
      return 1
    fi
    grep -Fq "$ALIAS_MARKER" "$alias_path" || {
      printf 'error: unrelated aw collision at %s; move or remove it deliberately before retrying\n' "$alias_path" >&2
      return 1
    }
    [ -f "$ledger_path" ] || {
      printf 'error: marked manual aw at %s has no installer ownership ledger; move or remove it deliberately before retrying\n' "$alias_path" >&2
      return 1
    }
    local alias_hash
    alias_hash="$(sha256_file "$alias_path")"
    grep -Fq "\"path\": \"$(json_escape "$alias_path")\"" "$ledger_path" || {
      printf 'error: ownership ledger path mismatch for %s; move or remove it deliberately before retrying\n' "$alias_path" >&2
      return 1
    }
    grep -Fq "\"sha256\": \"$alias_hash\"" "$ledger_path" || {
      printf 'error: ownership ledger hash mismatch for %s; move or remove it deliberately before retrying\n' "$alias_path" >&2
      return 1
    }
    grep -Eq '"releaseVersion"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?"' "$ledger_path" || {
      printf 'error: ownership ledger release-version defect at %s; move or remove it deliberately before retrying\n' "$ledger_path" >&2
      return 1
    }
    local ledger_release_version ledger_contents expected_ledger
    ledger_release_version="$(sed -nE 's/^  "releaseVersion": "([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)",$/\1/p' "$ledger_path")"
    [ -n "$ledger_release_version" ] || {
      printf 'error: ownership ledger release-version defect at %s; move or remove it deliberately before retrying\n' "$ledger_path" >&2
      return 1
    }
    ledger_contents="$(cat "$ledger_path")"
    expected_ledger="$(render_legacy_ownership_ledger "$install_dir" "$alias_path" "$alias_hash" "$ledger_release_version")"
    [ "$ledger_contents" = "$expected_ledger" ] || {
      printf 'error: ownership ledger property or alias-set defect at %s; move or remove it deliberately before retrying\n' "$ledger_path" >&2
      return 1
    }
  elif [ -e "$ledger_path" ] || [ -L "$ledger_path" ]; then
    printf 'error: ownership ledger %s claims a missing aw alias; move or remove it deliberately before retrying\n' "$ledger_path" >&2
    return 1
  fi

  resolved="$(type -P aw 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    if [ ! -e "$alias_path" ] && [ ! -L "$alias_path" ]; then
      printf 'error: unrelated aw command resolves to %s outside %s; move or remove the collision deliberately before retrying\n' "$resolved" "$install_dir" >&2
      return 1
    fi
    local resolved_physical alias_physical
    resolved_physical="$(physical_command_path "$resolved")" || {
      printf 'error: unable to resolve filesystem identity for aw command at %s\n' "$resolved" >&2
      return 1
    }
    alias_physical="$(physical_command_path "$alias_path")" || {
      printf 'error: unable to resolve managed aw destination identity at %s\n' "$alias_path" >&2
      return 1
    }
    if [ "$resolved_physical" != "$alias_physical" ]; then
      printf 'error: unrelated aw command resolves to %s outside %s; move or remove the collision deliberately before retrying\n' "$resolved" "$install_dir" >&2
      return 1
    fi
  fi
}

render_legacy_ownership_ledger() {
  local install_dir="$1"
  local alias_path="$2"
  local alias_hash="$3"
  local release_version="$4"
  cat <<EOF
{
  "schemaVersion": 1,
  "installDirectory": "$(json_escape "$install_dir")",
  "releaseVersion": "$(json_escape "$release_version")",
  "aliases": [
    { "path": "$(json_escape "$alias_path")", "sha256": "$alias_hash" }
  ]
}
EOF
}

render_ownership_ledger() {
  local install_dir="$1"
  local binary_hash wrapper_hash alias_hash helper_hash
  binary_hash="$(sha256_file "$install_dir/$BINARY_NAME")"
  wrapper_hash="$(sha256_file "$install_dir/$PROJECT_NAME")"
  alias_hash="$(sha256_file "$install_dir/$ALIAS_ASSET")"
  helper_hash="$(sha256_file "$install_dir/$UNINSTALL_HELPER_ASSET")"
  cat <<EOF
{
  "schemaVersion": $LEDGER_SCHEMA_VERSION,
  "installationChannel": "official-direct",
  "platform": "posix",
  "installDirectory": "$(json_escape "$install_dir")",
  "files": [
    { "relativePath": "arashi.bin", "role": "native-executable", "digest": "$binary_hash" },
    { "relativePath": "arashi", "role": "canonical-wrapper", "digest": "$wrapper_hash" },
    { "relativePath": "aw", "role": "alias-wrapper", "digest": "$alias_hash" },
    { "relativePath": "uninstall.sh", "role": "uninstall-helper", "digest": "$helper_hash" }
  ]$(if [ -n "$PATH_MUTATION_PROFILE" ]; then printf ',\n  "pathMutation": { "profilePath": "%s", "insertedBytes": "%s" }' "$(json_escape "$PATH_MUTATION_PROFILE")" "$(json_escape "$PATH_MUTATION_BYTES")"; elif [ -n "$PATH_MUTATION_JSON" ]; then printf ',\n%s' "$PATH_MUTATION_JSON"; fi)
}
EOF
}

write_ownership_ledger() {
  local output_path="$1"
  shift
  render_ownership_ledger "$@" > "$output_path"
}

replace_installed_asset() {
  local source_path="$1"
  local destination_path="$2"
  local destination_dir
  local destination_name
  local temporary_path
  local mode=755
  destination_dir="$(dirname "$destination_path")"
  destination_name="$(basename "$destination_path")"
  [ "$destination_name" != "$LEDGER_NAME" ] || mode=644
  temporary_path="$(mktemp "$destination_dir/.$destination_name.arashi-install.XXXXXX")" || return 1
  if ! cp "$source_path" "$temporary_path" || ! chmod "$mode" "$temporary_path" || ! mv -f "$temporary_path" "$destination_path"; then
    rm -f "$temporary_path"
    return 1
  fi
}

restore_installed_asset() {
  local backup_path="$1"
  local destination_path="$2"
  local preserved_mode="$3"
  local destination_dir destination_name temporary_path
  destination_dir="$(dirname "$destination_path")"
  destination_name="$(basename "$destination_path")"
  temporary_path="$(mktemp "$destination_dir/.$destination_name.arashi-restore.XXXXXX")" || return 1
  if ! cp "$backup_path" "$temporary_path" || ! chmod "$preserved_mode" "$temporary_path" || ! mv -f "$temporary_path" "$destination_path"; then
    rm -f "$temporary_path"
    return 1
  fi
}

capture_entrypoint_version() {
  local path="$1" output_variable="$2"
  local output_path status output
  output_path="$(mktemp "${TMPDIR:-/tmp}/arashi-version.XXXXXX")" || return 1
  "$path" --version >"$output_path" 2>&1 &
  ACTIVE_TRANSACTION_CHILD=$!
  wait "$ACTIVE_TRANSACTION_CHILD"
  status=$?
  ACTIVE_TRANSACTION_CHILD=0
  output="$(cat "$output_path")"
  rm -f "$output_path"
  printf -v "$output_variable" '%s' "$output"
  return "$status"
}

verify_installed_entrypoints() {
  local canonical_path="$1"
  local alias_path="$2"
  local canonical_version alias_version canonical_status alias_status

  log "Running post-install smoke test"
  set +e
  capture_entrypoint_version "$canonical_path" canonical_version
  canonical_status=$?
  capture_entrypoint_version "$alias_path" alias_version
  alias_status=$?
  set -e
  if [ "$canonical_status" -ne 0 ] || [ "$alias_status" -ne 0 ]; then
    printf 'smoke test failed: arashi=%s aw=%s\n' "$canonical_status" "$alias_status" >&2
    return 1
  fi
  if [ -z "$canonical_version" ] || [ "$canonical_version" != "$alias_version" ]; then
    printf 'smoke test failed: arashi and aw version output must be identical and non-empty\n' >&2
    return 1
  fi
  INSTALLED_VERSION_OUTPUT="$canonical_version"
  log "Verified arashi and aw executables ($canonical_version)"
}

install_posix_payload_transaction() {
  local install_dir="$1" binary_source="$2" wrapper_source="$3" alias_source="$4" helper_source="$5" release_version="$6"
  local canonical_path="$install_dir/$PROJECT_NAME" alias_path="$install_dir/$ALIAS_ASSET"
  local binary_path="$install_dir/$BINARY_NAME" ledger_path="$install_dir/$LEDGER_NAME"
  local backup_directory staged_ledger alias_hash ledger_release_version phase="backup"
  local helper_path="$install_dir/$UNINSTALL_HELPER_ASSET"
  local -a destinations=("$binary_path" "$canonical_path" "$alias_path" "$helper_path" "$ledger_path")
  local -a sources=("$binary_source" "$wrapper_source" "$alias_source" "$helper_source" "")
  local -a existed=()
  local -a backup_modes=(0 0 0 0 0)
  local -a backup_fd_open=(0 0 0 0 0)
  local transaction_armed=0 transaction_committed=0 ACTIVE_TRANSACTION_CHILD=0
  local transaction_failure="Installation exited unexpectedly during $phase"
  local previous_exit_trap previous_err_trap
  previous_exit_trap="$(trap -p EXIT)"
  previous_err_trap="$(trap -p ERR)"

  open_rollback_backup_descriptors() {
    local backup_index="$1"
    case "$backup_index" in
      0) exec 7<"$backup_directory/0" 11<"$backup_directory/0" ;;
      1) exec 8<"$backup_directory/1" 12<"$backup_directory/1" ;;
      2) exec 9<"$backup_directory/2" 13<"$backup_directory/2" ;;
      3) exec 10<"$backup_directory/3" 14<"$backup_directory/3" ;;
      4) exec 15<"$backup_directory/4" 16<"$backup_directory/4" ;;
      *) return 1 ;;
    esac
    backup_fd_open[$backup_index]=1
  }

  rollback_backup_source() {
    local backup_index="$1" source_kind="${2:-restore}"
    if [ "${backup_fd_open[$backup_index]}" -eq 1 ]; then
      case "$source_kind:$backup_index" in
        restore:0) printf '/dev/fd/7\n' ;;
        restore:1) printf '/dev/fd/8\n' ;;
        restore:2) printf '/dev/fd/9\n' ;;
        restore:3) printf '/dev/fd/10\n' ;;
        retain:0) printf '/dev/fd/11\n' ;;
        retain:1) printf '/dev/fd/12\n' ;;
        retain:2) printf '/dev/fd/13\n' ;;
        retain:3) printf '/dev/fd/14\n' ;;
        restore:4) printf '/dev/fd/15\n' ;;
        retain:4) printf '/dev/fd/16\n' ;;
        *) return 1 ;;
      esac
    else
      printf '%s/%s\n' "$backup_directory" "$backup_index"
    fi
  }

  close_rollback_backup_descriptors() {
    [ "${backup_fd_open[0]}" -eq 0 ] || { exec 7<&-; exec 11<&-; }
    [ "${backup_fd_open[1]}" -eq 0 ] || { exec 8<&-; exec 12<&-; }
    [ "${backup_fd_open[2]}" -eq 0 ] || { exec 9<&-; exec 13<&-; }
    [ "${backup_fd_open[3]}" -eq 0 ] || { exec 10<&-; exec 14<&-; }
    [ "${backup_fd_open[4]}" -eq 0 ] || { exec 15<&-; exec 16<&-; }
    backup_fd_open=(0 0 0 0 0)
  }

  backup_file_mode() {
    local backup_path="$1" mode
    if mode="$(stat -f '%Lp' "$backup_path" 2>/dev/null)"; then
      case "$mode" in
        [0-7]|[0-7][0-7]|[0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) printf '%s\n' "$mode"; return 0 ;;
      esac
    fi
    mode="$(stat -c '%a' "$backup_path" 2>/dev/null)" || return 1
    case "$mode" in
      [0-7]|[0-7][0-7]|[0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) printf '%s\n' "$mode" ;;
      *) return 1 ;;
    esac
  }

  retain_recoverable_backups() {
    local backup_index backup_source
    mkdir -p "$backup_directory" || return 1
    for backup_index in "${!destinations[@]}"; do
      [ "${existed[$backup_index]}" -eq 1 ] || continue
      [ -f "$backup_directory/$backup_index" ] && continue
      backup_source="$(rollback_backup_source "$backup_index" retain)" || return 1
      cp "$backup_source" "$backup_directory/$backup_index" || return 1
      chmod "${backup_modes[$backup_index]}" "$backup_directory/$backup_index" || return 1
    done
  }

  rollback_transaction_on_exit() {
    local observed_status=$?
    local status="${1:-$observed_status}"
    trap - EXIT ERR HUP INT TERM
    if [ "$transaction_committed" -eq 1 ]; then
      return
    fi
    if [ "$transaction_armed" -eq 0 ]; then
      finish_shell_path_transaction rollback
      return
    fi

    local rollback_failed=0 rollback_index backup_source
    for rollback_index in "${!destinations[@]}"; do
      if [ "${existed[$rollback_index]}" -eq 1 ]; then
        if backup_source="$(rollback_backup_source "$rollback_index")"; then
          restore_installed_asset "$backup_source" "${destinations[$rollback_index]}" "${backup_modes[$rollback_index]}" || rollback_failed=1
        else
          rollback_failed=1
        fi
      elif [ -e "${destinations[$rollback_index]}" ] || [ -L "${destinations[$rollback_index]}" ]; then
        rm -f "${destinations[$rollback_index]}" || rollback_failed=1
      fi
    done
    rm -f "$staged_ledger" || rollback_failed=1

    if [ "$rollback_failed" -ne 0 ]; then
      local backups_retained=0
      if retain_recoverable_backups; then backups_retained=1; fi
      close_rollback_backup_descriptors || true
      if [ "$backups_retained" -eq 1 ]; then
        printf 'error: %s. Rollback failed; recoverable backups retained at: %s. Restore them manually before retrying\n' "$transaction_failure" "$backup_directory" >&2
      else
        printf 'error: %s. Rollback failed and complete recovery backups could not be retained at: %s. Inspect the destination state before retrying\n' "$transaction_failure" "$backup_directory" >&2
      fi
    else
      close_rollback_backup_descriptors || true
      rm -rf "$backup_directory"
      printf 'error: %s. Rollback completed and restored the previous managed payload\n' "$transaction_failure" >&2
    fi
    finish_shell_path_transaction rollback
    [ "$status" -ne 0 ] || status=1
    if [ -n "$previous_exit_trap" ]; then
      eval "$previous_exit_trap"
    fi
    if [ -n "$previous_err_trap" ]; then
      eval "$previous_err_trap"
    fi
    exit "$status"
  }

  interrupt_transaction() {
    local signal_name="$1" signal_status="$2"
    transaction_failure="Installation interrupted by $signal_name during $phase"
    if [ "$ACTIVE_TRANSACTION_CHILD" -gt 0 ]; then
      kill -TERM "$ACTIVE_TRANSACTION_CHILD" 2>/dev/null || true
      local child_shutdown_attempt
      for child_shutdown_attempt in {1..20}; do
        kill -0 "$ACTIVE_TRANSACTION_CHILD" 2>/dev/null || break
        sleep 0.05
      done
      if kill -0 "$ACTIVE_TRANSACTION_CHILD" 2>/dev/null; then
        kill -KILL "$ACTIVE_TRANSACTION_CHILD" 2>/dev/null || true
      fi
      wait "$ACTIVE_TRANSACTION_CHILD" 2>/dev/null || true
      ACTIVE_TRANSACTION_CHILD=0
    fi
    rollback_transaction_on_exit "$signal_status"
  }

  mkdir -p "$install_dir" || fail "Unable to create install directory: $install_dir"
  [ -w "$install_dir" ] || fail "Install directory is not writable: $install_dir"
  backup_directory="$(mktemp -d "${TMPDIR:-/tmp}/arashi-payload-backup.XXXXXX")" || fail "Unable to create transaction backup"
  staged_ledger="$(mktemp "${TMPDIR:-/tmp}/arashi-ledger.XXXXXX")" || fail "Unable to stage ownership ledger"

  local index
  for index in "${!destinations[@]}"; do
    if [ -e "${destinations[$index]}" ] || [ -L "${destinations[$index]}" ]; then
      if [ -L "${destinations[$index]}" ] || [ ! -f "${destinations[$index]}" ] || [ ! -r "${destinations[$index]}" ]; then
        rm -rf "$backup_directory"
        rm -f "$staged_ledger"
        fail "Managed destination ${destinations[$index]} is not a readable regular file; move or remove it deliberately before retrying"
      fi
      existed[$index]=1
      backup_modes[$index]="$(backup_file_mode "${destinations[$index]}")" || fail "Installation failed to record destination mode before replacement began"
      cp -p "${destinations[$index]}" "$backup_directory/$index" || fail "Installation failed during backup before replacement began"
    else
      existed[$index]=0
    fi
  done

  transaction_armed=1
  trap rollback_transaction_on_exit EXIT
  trap 'rollback_transaction_on_exit $?' ERR
  trap 'interrupt_transaction HUP 129' HUP
  trap 'interrupt_transaction INT 130' INT
  trap 'interrupt_transaction TERM 143' TERM

  local failed=0
  phase="replacement"
  transaction_failure="Installation failed during $phase"
  for index in 0 1 2 3; do
    if ! replace_installed_asset "${sources[$index]}" "${destinations[$index]}"; then failed=1; break; fi
  done
  if [ "$failed" -eq 0 ]; then
    phase="smoke test"
    transaction_failure="Installation failed during $phase"
    verify_installed_entrypoints "$canonical_path" "$alias_path" || failed=1
  fi
  if [ "$failed" -eq 0 ]; then
    phase="ledger commit"
    transaction_failure="Installation failed during $phase"
    alias_hash="$(sha256_file "$alias_path")" || failed=1
    ledger_release_version="$(printf '%s\n' "$INSTALLED_VERSION_OUTPUT" | sed -nE 's/.*(^|[^0-9A-Za-z.-])([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)([^0-9A-Za-z.-]|$).*/\2/p' | head -n 1)"
    if [ -z "$ledger_release_version" ]; then
      printf 'ledger commit failed: could not determine exact installed release version from %s\n' "$INSTALLED_VERSION_OUTPUT" >&2
      failed=1
    elif [ "$release_version" != "latest" ] && [ "$ledger_release_version" != "$release_version" ]; then
      printf 'ledger commit failed: installed version %s does not match requested release %s\n' "$ledger_release_version" "$release_version" >&2
      failed=1
    fi
    if [ "$failed" -eq 0 ]; then
      write_ownership_ledger "$staged_ledger" "$install_dir" || failed=1
    fi
  fi
  if [ "$failed" -eq 0 ]; then
    replace_installed_asset "$staged_ledger" "$ledger_path" || failed=1
  fi

  if [ "$failed" -ne 0 ]; then
    rollback_transaction_on_exit 1
  fi

  phase="transaction cleanup"
  transaction_failure="Installation interrupted or failed during $phase"
  for index in "${!destinations[@]}"; do
    if [ "${existed[$index]}" -eq 1 ]; then
      open_rollback_backup_descriptors "$index"
    fi
  done
  rm -f "$staged_ledger"
  rm -rf "$backup_directory"
  transaction_committed=1
  trap - EXIT ERR HUP INT TERM
  close_rollback_backup_descriptors
  if [ -n "$previous_exit_trap" ]; then
    eval "$previous_exit_trap"
  fi
  if [ -n "$previous_err_trap" ]; then
    eval "$previous_err_trap"
  fi
  return 0
}

print_post_install_notes() {
  local install_dir="$1"
  local wrapper_path="$2"
  local binary_path="$3"

  log_debug "Installed $PROJECT_NAME wrapper to $wrapper_path"
  log_debug "Installed $PROJECT_NAME binary to $binary_path"

  if [ "$NO_MODIFY_PATH" = "true" ]; then
    case ":$PATH:" in
      *":$install_dir:"*)
        ;;
      *)
        warn "$install_dir is not on PATH. Add it to use 'aw' directly"
        warn "Example: export PATH=\"$install_dir:\$PATH\""
        ;;
    esac
  fi

  cat <<'EOF'

◢▲◣  ▓█▀█  ▓█▀▄  ▓█▀█  ▓█▀▀  ▓█░█  ▓█
◥▲◤  ▓█▀█  ▓█▀▄  ▓█▀█  ▓▀▀█  ▓█▀█  ▓█
     ▓▀░▀  ▓▀░▀  ▓▀░▀  ▀▀▀▀  ▓▀░▀  ▓▀

Arashi is a Git worktree manager that pairs perfectly with a 
spec-driven development workflow in a multi-repository environment.

Get started in a new project:
  cd <project>                  # Open your meta-repository
  aw init                       # Initialize Arashi
  aw add git@github.com:<your-org>/frontend.git # Add a sub-repository
  aw add git@github.com:<your-org>/backend.git  # Add another sub-repository
  aw create <feature-name>      # Create new worktrees for your feature branch
  aw switch <feature-name>      # Switch to your new feature worktrees

For more information visit https://arashi.haphazard.dev

If you skip shell integration during install, you can enable it later with:
  aw shell install
EOF
}

detect_shell_name() {
  if [ -n "${ARASHI_SHELL:-}" ]; then
    printf '%s\n' "${ARASHI_SHELL##*/}"
    return
  fi
  if [ -n "${SHELL:-}" ]; then
    printf '%s\n' "${SHELL##*/}"
    return
  fi
  printf 'sh\n'
}

is_supported_shell() {
  case "$1" in
    bash|zsh|fish)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_shell_rc_file() {
  local shell_name="$1"

  case "$shell_name" in
    zsh)
      printf '%s\n' "$HOME/.zshrc"
      ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        printf '%s\n' "$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then
        printf '%s\n' "$HOME/.bash_profile"
      elif [ "$(uname -s)" = "Darwin" ]; then
        printf '%s\n' "$HOME/.bash_profile"
      else
        printf '%s\n' "$HOME/.bashrc"
      fi
      ;;
    fish)
      printf '%s\n' "$HOME/.config/fish/config.fish"
      ;;
    ksh)
      printf '%s\n' "$HOME/.kshrc"
      ;;
    *)
      printf '%s\n' "$HOME/.profile"
      ;;
  esac
}

build_posix_path_line() {
  local install_dir="$1"
  if [ "$install_dir" = "$HOME/.arashi/bin" ]; then
    printf 'export PATH="$HOME/.arashi/bin:$PATH"\n'
    return
  fi
  printf 'export PATH="%s:$PATH"\n' "$install_dir"
}

build_fish_path_line() {
  local install_dir="$1"
  if [ "$install_dir" = "$HOME/.arashi/bin" ]; then
    printf 'fish_add_path --prepend --move "$HOME/.arashi/bin"\n'
    return
  fi
  printf 'fish_add_path --prepend --move "%s"\n' "$install_dir"
}

rc_file_has_install_dir() {
  local rc_file="$1"
  local install_dir="$2"

  if grep -F "$install_dir" "$rc_file" >/dev/null 2>&1; then
    log_debug "Found $install_dir in $rc_file"
    return 0
  fi
  if [ "$install_dir" = "$HOME/.arashi/bin" ] && grep -F '$HOME/.arashi/bin' "$rc_file" >/dev/null 2>&1; then
    log_debug "Found \$HOME/.arashi/bin in $rc_file, which matches $install_dir"
    return 0
  fi
  return 1
}

configure_shell_path() {
  local install_dir="$1"
  local shell_name
  local rc_file
  local path_line

  shell_name="$(detect_shell_name)"

  case "$shell_name" in
    zsh)
      rc_file="$(resolve_shell_rc_file "$shell_name")"
      path_line="$(build_posix_path_line "$install_dir")"
      ;;
    bash)
      rc_file="$(resolve_shell_rc_file "$shell_name")"
      path_line="$(build_posix_path_line "$install_dir")"
      ;;
    fish)
      rc_file="$(resolve_shell_rc_file "$shell_name")"
      path_line="$(build_fish_path_line "$install_dir")"
      ;;
    ksh)
      rc_file="$HOME/.kshrc"
      path_line="$(build_posix_path_line "$install_dir")"
      ;;
    *)
      rc_file="$HOME/.profile"
      path_line="$(build_posix_path_line "$install_dir")"
      ;;
  esac

  mkdir -p "$(dirname "$rc_file")" 2>/dev/null || {
    warn "Could not create shell config directory for $rc_file"
    warn "Add this manually: $(build_posix_path_line "$install_dir")"
    return
  }

  PATH_MUTATION_PROFILE_CREATED=false
  if [ ! -f "$rc_file" ]; then
    : > "$rc_file" 2>/dev/null || {
      warn "Could not create shell config file: $rc_file"
      warn "Add this manually: $(build_posix_path_line "$install_dir")"
      return
    }
    PATH_MUTATION_PROFILE_CREATED=true
  fi

  if rc_file_has_install_dir "$rc_file" "$install_dir"; then
    log "PATH already includes $install_dir in $rc_file"
    return
  fi

  PATH_MUTATION_PROFILE="$(cd -P "$(dirname "$rc_file")" && pwd -P)/$(basename "$rc_file")"
  PATH_MUTATION_BYTES="$(printf '\n# Added by arashi installer\n%s\n' "$path_line")"
  PATH_MUTATION_BACKUP="$(mktemp "${TMPDIR:-/tmp}/arashi-path-backup.XXXXXX")" || {
    PATH_MUTATION_PROFILE=""
    PATH_MUTATION_BYTES=""
    PATH_MUTATION_PROFILE_CREATED=false
    warn "Failed to stage a PATH rollback backup; leaving $rc_file unchanged"
    return
  }
  cp -p "$rc_file" "$PATH_MUTATION_BACKUP" || {
    rm -f "$PATH_MUTATION_BACKUP"
    PATH_MUTATION_BACKUP=""
    PATH_MUTATION_PROFILE=""
    PATH_MUTATION_BYTES=""
    PATH_MUTATION_PROFILE_CREATED=false
    warn "Failed to stage a PATH rollback backup; leaving $rc_file unchanged"
    return
  }
  {
    printf '%s' "$PATH_MUTATION_BYTES"
  } >> "$rc_file" || {
    cp -p "$PATH_MUTATION_BACKUP" "$rc_file" 2>/dev/null || true
    rm -f "$PATH_MUTATION_BACKUP"
    PATH_MUTATION_BACKUP=""
    PATH_MUTATION_PROFILE=""
    PATH_MUTATION_BYTES=""
    PATH_MUTATION_PROFILE_CREATED=false
    warn "Failed to update PATH in $rc_file"
    warn "Add this manually: $(build_posix_path_line "$install_dir")"
    return
  }

  log "Added $install_dir to PATH in $rc_file"
  echo ""
  warn "Open a new shell or run: export PATH=\"$install_dir:\$PATH\""
}

finish_shell_path_transaction() {
  local outcome="$1" expected=""
  [ -n "$PATH_MUTATION_BACKUP" ] || return 0
  if [ "$outcome" = "commit" ]; then
    rm -f "$PATH_MUTATION_BACKUP"
  else
    expected="$(mktemp "${TMPDIR:-/tmp}/arashi-path-expected.XXXXXX")" || return 1
    cat "$PATH_MUTATION_BACKUP" > "$expected"
    printf '%s' "$PATH_MUTATION_BYTES" >> "$expected"
    if cmp -s "$PATH_MUTATION_PROFILE" "$expected"; then
      if [ "$PATH_MUTATION_PROFILE_CREATED" = true ]; then
        rm -f "$PATH_MUTATION_PROFILE"
      else
        cp -p "$PATH_MUTATION_BACKUP" "$PATH_MUTATION_PROFILE"
      fi
    else
      warn "PATH profile changed during failed installation; preserving it for manual inspection: $PATH_MUTATION_PROFILE"
    fi
    rm -f "$expected" "$PATH_MUTATION_BACKUP"
  fi
  PATH_MUTATION_BACKUP=""
}

build_shell_integration_block() {
  local shell_name="$1"

  case "$shell_name" in
    fish)
      printf 'command arashi shell init fish | source\ncommand arashi completion fish | source'
      ;;
    bash|zsh)
      printf 'eval "$(command arashi shell init %s)"\nsource <(command arashi completion %s)' "$shell_name" "$shell_name"
      ;;
    *)
      return 1
      ;;
  esac
}

has_managed_shell_integration() {
  local rc_file="$1"
  awk -v marker="$SHELL_INTEGRATION_START" '$0 == marker { found=1 } END { exit !found }' "$rc_file"
}

resolve_symlink_target() {
  local path="$1"
  local output_variable="$2"
  local link_target
  local hops=0

  while [ -L "$path" ]; do
    hops="$((hops + 1))"
    if [ "$hops" -gt 40 ]; then
      return 1
    fi
    link_target="$(readlink "$path")" || return 1
    case "$link_target" in
      /*)
        path="$link_target"
        ;;
      *)
        path="$(dirname "$path")/$link_target"
        ;;
    esac
  done

  printf -v "$output_variable" '%s' "$path"
}

upsert_shell_integration_block() {
  local rc_file="$1"
  local integration_block="$2"
  local temporary_file
  local replacement_file
  local target_file="$rc_file"
  local final_newline

  if ! has_managed_shell_integration "$rc_file"; then
    {
      printf '\n%s\n' "$SHELL_INTEGRATION_START"
      printf '%s\n' "$integration_block"
      printf '%s\n' "$SHELL_INTEGRATION_END"
    } >> "$rc_file"
    return
  fi

  resolve_symlink_target "$rc_file" target_file || return 1

  temporary_file="$(mktemp)" || return 1
  replacement_file="$(mktemp)" || {
    rm -f "$temporary_file"
    return 1
  }
  printf '%s\n' "$integration_block" > "$replacement_file" || {
    rm -f "$temporary_file" "$replacement_file"
    return 1
  }

  final_newline=0
  if [ "$(tail -c 1 "$target_file" | od -An -t u1 | tr -d ' ')" = "10" ]; then
    final_newline=1
  fi

  awk \
    -v start="$SHELL_INTEGRATION_START" \
    -v end="$SHELL_INTEGRATION_END" \
    -v replacement_file="$replacement_file" \
    -v final_newline="$final_newline" \
    'function emit_line(line, is_last) {
       printf "%s", line
       if (!is_last || final_newline) printf "\n"
     }
     { lines[NR] = $0 }
     END {
       for (line_number = 1; line_number <= NR; line_number++) {
         is_last = line_number == NR
         if (!managed && lines[line_number] == start) {
           print start
           while ((getline replacement_line < replacement_file) > 0) print replacement_line
           close(replacement_file)
           managed = 1
           continue
         }
         if (managed) {
           if (lines[line_number] == end) {
             emit_line(end, is_last)
             managed = 0
           }
           continue
         }
         emit_line(lines[line_number], is_last)
       }
       if (managed) exit 2
     }' "$target_file" > "$temporary_file" || {
      rm -f "$temporary_file" "$replacement_file"
      return 1
    }
  rm -f "$replacement_file"
  mv "$temporary_file" "$target_file"
}

prompt_shell_integration() {
  local shell_name="$1"

  case "$SHELL_INTEGRATION_MODE" in
    yes)
      return 0
      ;;
    no)
      return 1
      ;;
    prompt)
      ;;
    *)
      warn "Unknown ARASHI_SHELL_INTEGRATION value: $SHELL_INTEGRATION_MODE"
      return 1
      ;;
  esac

  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    return 1
  fi

  printf '\n' >&2
  printf 'Install shell integration for %s so `arashi switch --cd` can change the current shell directory? [Y/n] ' "$shell_name" >&2

  local response
  if [ -r /dev/tty ]; then
    IFS= read -r response < /dev/tty || return 1
  else
    IFS= read -r response || return 1
  fi

  case "$response" in
    ""|y|Y|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

configure_shell_integration() {
  local shell_name
  local rc_file
  local integration_block

  shell_name="$(detect_shell_name)"
  if ! is_supported_shell "$shell_name"; then
    warn "Skipping shell integration prompt for unsupported shell: $shell_name"
    return
  fi

  rc_file="$(resolve_shell_rc_file "$shell_name")"
  integration_block="$(build_shell_integration_block "$shell_name")" || {
    warn "Could not build shell integration line for $shell_name"
    return
  }

  mkdir -p "$(dirname "$rc_file")" 2>/dev/null || {
    warn "Could not create shell config directory for $rc_file"
    warn "Run 'arashi shell install' manually after installation"
    return
  }

  if [ ! -f "$rc_file" ]; then
    : > "$rc_file" 2>/dev/null || {
      warn "Could not create shell config file: $rc_file"
      warn "Run 'arashi shell install' manually after installation"
      return
    }
  fi

  if ! has_managed_shell_integration "$rc_file" && ! prompt_shell_integration "$shell_name"; then
    log "Skipping shell integration setup"
    return
  fi

  upsert_shell_integration_block "$rc_file" "$integration_block" || {
    warn "Failed to update shell integration in $rc_file"
    warn "Run 'arashi shell install' manually after installation"
    return
  }

  log "Added shell integration to $rc_file"
}

main() {
  parse_args "$@"

  require_command curl
  require_command uname
  require_command mktemp
  require_command mv
  require_command chmod

  local normalized_version
  local release_base_url
  local release_label
  normalized_version="$(normalize_version "$VERSION_INPUT")"
  if [ "$normalized_version" = "latest" ]; then
    release_label="latest"
    release_base_url="https://github.com/$REPOSITORY/releases/latest/download"
  else
    release_label="v$normalized_version"
    release_base_url="https://github.com/$REPOSITORY/releases/download/$release_label"
  fi

  local asset_name
  asset_name="$(detect_platform_asset)"

  local install_dir
  install_dir="$(normalize_absolute_path "$(choose_install_dir)")"
  preflight_alias_ownership "$install_dir" || exit 1
  if [ -n "$PATH_MUTATION_JSON" ] && ! recorded_path_mutation_is_current "$install_dir"; then
    log "Recorded PATH bytes changed since installation; refreshing PATH ownership"
    clear_recorded_path_mutation
  fi

  log "Preparing installation for arashi ($release_label)"
  log_debug "Installing $asset_name ($release_label)"

  local tmp_dir
  local downloaded_binary_asset
  local downloaded_wrapper_asset
  local downloaded_alias_asset
  local downloaded_helper_asset
  local downloaded_manifest
  tmp_dir="$(mktemp -d)"
  log_debug "Created temporary directory at $tmp_dir"
  downloaded_binary_asset="$tmp_dir/$asset_name"
  downloaded_wrapper_asset="$tmp_dir/$WRAPPER_ASSET"
  downloaded_alias_asset="$tmp_dir/$ALIAS_ASSET"
  downloaded_helper_asset="$tmp_dir/$UNINSTALL_HELPER_ASSET"
  downloaded_manifest="$tmp_dir/$CHECKSUM_MANIFEST"
  trap "cleanup_progress_ui; rm -rf '$tmp_dir'" EXIT

  init_progress_ui

  download_file "$release_base_url/$asset_name" "$downloaded_binary_asset" "$asset_name" false
  download_file "$release_base_url/$WRAPPER_ASSET" "$downloaded_wrapper_asset" "$WRAPPER_ASSET" false
  download_file "$release_base_url/$ALIAS_ASSET" "$downloaded_alias_asset" "$ALIAS_ASSET" false
  download_file "$release_base_url/$UNINSTALL_HELPER_ASSET" "$downloaded_helper_asset" "$UNINSTALL_HELPER_ASSET" false
  download_file "$release_base_url/$CHECKSUM_MANIFEST" "$downloaded_manifest" "$CHECKSUM_MANIFEST" true

  local expected_binary_checksum
  local actual_binary_checksum
  local expected_wrapper_checksum
  local actual_wrapper_checksum
  local expected_alias_checksum
  local actual_alias_checksum
  local expected_helper_checksum
  local actual_helper_checksum
  expected_binary_checksum="$(expected_checksum_for_asset "$downloaded_manifest" "$asset_name")"
  actual_binary_checksum="$(sha256_file "$downloaded_binary_asset")"

  expected_wrapper_checksum="$(expected_checksum_for_asset "$downloaded_manifest" "$WRAPPER_ASSET")"
  actual_wrapper_checksum="$(sha256_file "$downloaded_wrapper_asset")"
  expected_alias_checksum="$(expected_checksum_for_asset "$downloaded_manifest" "$ALIAS_ASSET")"
  actual_alias_checksum="$(sha256_file "$downloaded_alias_asset")"
  expected_helper_checksum="$(expected_checksum_for_asset "$downloaded_manifest" "$UNINSTALL_HELPER_ASSET")"
  actual_helper_checksum="$(sha256_file "$downloaded_helper_asset")"

  [ "$expected_binary_checksum" = "$actual_binary_checksum" ] || fail "Checksum validation failed for $asset_name"
  [ "$expected_wrapper_checksum" = "$actual_wrapper_checksum" ] || fail "Checksum validation failed for $WRAPPER_ASSET"
  [ "$expected_alias_checksum" = "$actual_alias_checksum" ] || fail "Checksum validation failed for $ALIAS_ASSET"
  [ "$expected_helper_checksum" = "$actual_helper_checksum" ] || fail "Checksum validation failed for $UNINSTALL_HELPER_ASSET"

  log_debug "Checksum verified for $asset_name and $WRAPPER_ASSET"

  local target_wrapper_path
  local target_binary_path
  target_wrapper_path="$install_dir/$PROJECT_NAME"
  target_binary_path="$install_dir/$BINARY_NAME"
  if [ -n "$PATH_MUTATION_JSON" ]; then
    log "Preserving the validated installer-owned PATH entry from the existing manifest"
  elif [ "$NO_MODIFY_PATH" = "true" ]; then
    if [ "$DEBUG_LOG" = "true" ]; then
      log "Skipping PATH modification as --no-modify-path is set"
    fi
  else
    trap "finish_shell_path_transaction rollback; cleanup_progress_ui; rm -rf '$tmp_dir'" EXIT
    configure_shell_path "$install_dir"
  fi

  install_posix_payload_transaction "$install_dir" "$downloaded_binary_asset" "$downloaded_wrapper_asset" "$downloaded_alias_asset" "$downloaded_helper_asset" "$normalized_version"
  finish_shell_path_transaction commit

  configure_shell_integration

  print_post_install_notes "$install_dir" "$target_wrapper_path" "$target_binary_path"
}

if [ "${ARASHI_INSTALLER_SOURCE_ONLY:-}" != "1" ]; then
  main "$@"
fi
