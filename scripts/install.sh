#!/usr/bin/env bash

set -euo pipefail

PROJECT_NAME="arashi"
BINARY_NAME="arashi.bin"
WRAPPER_ASSET="arashi"
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
    mkdir -p "$INSTALL_DIR_OVERRIDE" 2>/dev/null || fail "Unable to create install directory: $INSTALL_DIR_OVERRIDE"
    [ -w "$INSTALL_DIR_OVERRIDE" ] || fail "Install directory is not writable: $INSTALL_DIR_OVERRIDE"
    printf '%s\n' "$INSTALL_DIR_OVERRIDE"
    return
  fi

  [ -n "${HOME:-}" ] || fail "HOME is not set. Use ARASHI_INSTALL_DIR to provide an install path"

  local default_install_dir
  default_install_dir="$HOME/.arashi/bin"
  mkdir -p "$default_install_dir" 2>/dev/null || fail "Unable to create default install directory: $default_install_dir"
  [ -w "$default_install_dir" ] || fail "Default install directory is not writable: $default_install_dir"
  printf '%s\n' "$default_install_dir"
}

verify_installed_binary() {
  local wrapper_path="$1"
  local version_output=""
  local verify_status=0

  log "Running post-install smoke test"

  set +e
  version_output="$("$wrapper_path" --version 2>&1)"
  verify_status=$?
  set -e

  if [ "$verify_status" -eq 0 ]; then
    if [ -z "$version_output" ]; then
      fail "Installed binary returned success but produced no version output"
    fi

    log "Verified arashi executable ($version_output)"
    return
  fi

  warn "Installed binary failed smoke test with exit code $verify_status"
  if [ -n "$version_output" ]; then
    warn "$version_output"
  fi
  warn "This usually indicates a bad release asset or a compiler regression in the published binary"
  warn "Retry with a pinned version: curl -fsSL https://arashi.haphazard.dev/install | ARASHI_VERSION=<version> bash"
  fail "Installed arashi binary could not start"
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
        warn "$install_dir is not on PATH. Add it to use 'arashi' directly"
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
  arashi init                   # Initialize arashi
  arashi add git@github.com:<your-org>/frontend.git # Add a sub-repository
  arashi add git@github.com:<your-org>/backend.git  # Add another sub-repository
  arashi create <feature-name>  # Create a new worktrees for your feature branch
  arashi switch <feature-name>  # Switch to your new feature worktrees

For more information visit https://arashi.haphazard.dev

If you skip shell integration during install, you can enable it later with:
  arashi shell install
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

  if [ ! -f "$rc_file" ]; then
    : > "$rc_file" 2>/dev/null || {
      warn "Could not create shell config file: $rc_file"
      warn "Add this manually: $(build_posix_path_line "$install_dir")"
      return
    }
  fi

  if rc_file_has_install_dir "$rc_file" "$install_dir"; then
    log "PATH already includes $install_dir in $rc_file"
    return
  fi

  {
    printf '\n# Added by arashi installer\n'
    printf '%s\n' "$path_line"
  } >> "$rc_file" || {
    warn "Failed to update PATH in $rc_file"
    warn "Add this manually: $(build_posix_path_line "$install_dir")"
    return
  }

  log "Added $install_dir to PATH in $rc_file"
  echo ""
  warn "Open a new shell or run: export PATH=\"$install_dir:\$PATH\""
}

build_shell_integration_line() {
  local shell_name="$1"

  case "$shell_name" in
    fish)
      printf 'command arashi shell init fish | source'
      ;;
    bash|zsh)
      printf 'eval "$(command arashi shell init %s)"' "$shell_name"
      ;;
    *)
      return 1
      ;;
  esac
}

shell_integration_installed() {
  local rc_file="$1"
  grep -F "$SHELL_INTEGRATION_START" "$rc_file" >/dev/null 2>&1
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
  local integration_line

  shell_name="$(detect_shell_name)"
  if ! is_supported_shell "$shell_name"; then
    warn "Skipping shell integration prompt for unsupported shell: $shell_name"
    return
  fi

  rc_file="$(resolve_shell_rc_file "$shell_name")"
  integration_line="$(build_shell_integration_line "$shell_name")" || {
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

  if shell_integration_installed "$rc_file"; then
    log "Shell integration already configured in $rc_file"
    return
  fi

  if ! prompt_shell_integration "$shell_name"; then
    log "Skipping shell integration setup"
    return
  fi

  {
    printf '\n%s\n' "$SHELL_INTEGRATION_START"
    printf '%s\n' "$integration_line"
    printf '%s\n' "$SHELL_INTEGRATION_END"
  } >> "$rc_file" || {
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

  log "Preparing installation for arashi ($release_label)"
  log_debug "Installing $asset_name ($release_label)"

  local tmp_dir
  local downloaded_binary_asset
  local downloaded_wrapper_asset
  local downloaded_manifest
  tmp_dir="$(mktemp -d)"
  log_debug "Created temporary directory at $tmp_dir"
  downloaded_binary_asset="$tmp_dir/$asset_name"
  downloaded_wrapper_asset="$tmp_dir/$WRAPPER_ASSET"
  downloaded_manifest="$tmp_dir/$CHECKSUM_MANIFEST"
  trap "cleanup_progress_ui; rm -rf '$tmp_dir'" EXIT

  init_progress_ui

  download_file "$release_base_url/$asset_name" "$downloaded_binary_asset" "$asset_name" false
  download_file "$release_base_url/$WRAPPER_ASSET" "$downloaded_wrapper_asset" "$WRAPPER_ASSET" false
  download_file "$release_base_url/$CHECKSUM_MANIFEST" "$downloaded_manifest" "$CHECKSUM_MANIFEST" true

  local expected_binary_checksum
  local actual_binary_checksum
  local expected_wrapper_checksum
  local actual_wrapper_checksum
  expected_binary_checksum="$(expected_checksum_for_asset "$downloaded_manifest" "$asset_name")"
  actual_binary_checksum="$(sha256_file "$downloaded_binary_asset")"

  expected_wrapper_checksum="$(expected_checksum_for_asset "$downloaded_manifest" "$WRAPPER_ASSET")"
  actual_wrapper_checksum="$(sha256_file "$downloaded_wrapper_asset")"

  [ "$expected_binary_checksum" = "$actual_binary_checksum" ] || fail "Checksum validation failed for $asset_name"
  [ "$expected_wrapper_checksum" = "$actual_wrapper_checksum" ] || fail "Checksum validation failed for $WRAPPER_ASSET"

  log_debug "Checksum verified for $asset_name and $WRAPPER_ASSET"

  local install_dir
  local target_wrapper_path
  local target_binary_path
  local staging_wrapper_path
  local staging_binary_path
  install_dir="$(choose_install_dir)"
  target_wrapper_path="$install_dir/$PROJECT_NAME"
  target_binary_path="$install_dir/$BINARY_NAME"
  staging_wrapper_path="$install_dir/.${PROJECT_NAME}.tmp.$$"
  staging_binary_path="$install_dir/.${BINARY_NAME}.tmp.$$"

  cp "$downloaded_binary_asset" "$staging_binary_path" || fail "Failed to stage binary in $install_dir"
  chmod 755 "$staging_binary_path" || fail "Failed to set executable permissions on binary"
  mv -f "$staging_binary_path" "$target_binary_path" || fail "Failed to place binary at $target_binary_path"

  cp "$downloaded_wrapper_asset" "$staging_wrapper_path" || fail "Failed to stage wrapper in $install_dir"
  chmod 755 "$staging_wrapper_path" || fail "Failed to set executable permissions on wrapper"
  mv -f "$staging_wrapper_path" "$target_wrapper_path" || fail "Failed to place wrapper at $target_wrapper_path"

  verify_installed_binary "$target_wrapper_path"

  if [ "$NO_MODIFY_PATH" = "true" ]; then
    if [ "$DEBUG_LOG" = "true" ]; then
      log "Skipping PATH modification as --no-modify-path is set"
    fi
  else
    configure_shell_path "$install_dir"
  fi

  configure_shell_integration

  print_post_install_notes "$install_dir" "$target_wrapper_path" "$target_binary_path"
}

main "$@"
