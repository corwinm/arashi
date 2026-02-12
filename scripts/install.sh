#!/usr/bin/env bash

set -euo pipefail

PROJECT_NAME="arashi"
BINARY_NAME="arashi.bin"
WRAPPER_ASSET="arashi"
REPOSITORY="corwinm/arashi"
CHECKSUM_MANIFEST="arashi-checksums.txt"
VERSION_INPUT="latest"
INSTALL_DIR_OVERRIDE=""

log() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
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
  --help, -h         Show this help

Environment:
  ARASHI_VERSION     Same as --version
  ARASHI_INSTALL_DIR Same as --install-dir
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

download_file() {
  local url="$1"
  local destination="$2"
  local label="$3"
  log "Downloading $label"
  curl --fail --silent --show-error --location --retry 3 --retry-delay 1 --connect-timeout 15 --output "$destination" "$url" || fail "Unable to download $label from $url"
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

print_post_install_notes() {
  local install_dir="$1"
  local wrapper_path="$2"
  local binary_path="$3"

  log "Installed $PROJECT_NAME wrapper to $wrapper_path"
  log "Installed $PROJECT_NAME binary to $binary_path"

  case ":$PATH:" in
    *":$install_dir:"*)
      ;;
    *)
      warn "$install_dir is not on PATH. Add it to use 'arashi' directly"
      warn "Example: export PATH=\"$install_dir:\$PATH\""
      ;;
  esac

  printf 'Run: arashi --version\n'
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
    return 0
  fi
  if [ "$install_dir" = "$HOME/.arashi/bin" ] && grep -F '$HOME/.arashi/bin' "$rc_file" >/dev/null 2>&1; then
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
      rc_file="$HOME/.zshrc"
      path_line="$(build_posix_path_line "$install_dir")"
      ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        rc_file="$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then
        rc_file="$HOME/.bash_profile"
      elif [ "$(uname -s)" = "Darwin" ]; then
        rc_file="$HOME/.bash_profile"
      else
        rc_file="$HOME/.bashrc"
      fi
      path_line="$(build_posix_path_line "$install_dir")"
      ;;
    fish)
      rc_file="$HOME/.config/fish/config.fish"
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
  warn "Open a new shell or run: export PATH=\"$install_dir:\$PATH\""
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

  log "Preparing installation for $asset_name ($release_label)"

  local tmp_dir
  local downloaded_binary_asset
  local downloaded_wrapper_asset
  local downloaded_manifest
  tmp_dir="$(mktemp -d)"
  downloaded_binary_asset="$tmp_dir/$asset_name"
  downloaded_wrapper_asset="$tmp_dir/$WRAPPER_ASSET"
  downloaded_manifest="$tmp_dir/$CHECKSUM_MANIFEST"
  trap 'rm -rf "$tmp_dir"' EXIT

  download_file "$release_base_url/$asset_name" "$downloaded_binary_asset" "$asset_name"
  download_file "$release_base_url/$WRAPPER_ASSET" "$downloaded_wrapper_asset" "$WRAPPER_ASSET"
  download_file "$release_base_url/$CHECKSUM_MANIFEST" "$downloaded_manifest" "$CHECKSUM_MANIFEST"

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

  log "Checksum verified for $asset_name and $WRAPPER_ASSET"

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

  configure_shell_path "$install_dir"

  print_post_install_notes "$install_dir" "$target_wrapper_path" "$target_binary_path"
}

main "$@"
