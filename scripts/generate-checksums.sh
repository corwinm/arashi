#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/bin"
OUTPUT_FILE="${1:-$BIN_DIR/arashi-checksums.txt}"

ASSETS=(
  "arashi"
  "arashi.bat"
  "arashi.ps1"
  "arashi-macos-arm64"
  "arashi-linux-x64"
  "arashi-windows-x64.exe"
)

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
  printf 'No SHA-256 tool found (tried shasum, sha256sum, and openssl).\n' >&2
  exit 1
}

mkdir -p "$(dirname "$OUTPUT_FILE")"
TEMP_FILE="$(mktemp "${OUTPUT_FILE}.tmp.XXXXXX")"

for asset in "${ASSETS[@]}"; do
  asset_path="$BIN_DIR/$asset"
  if [ ! -f "$asset_path" ]; then
    rm -f "$TEMP_FILE"
    printf 'Missing build artifact: %s\n' "$asset_path" >&2
    exit 1
  fi
  checksum="$(sha256_file "$asset_path")"
  printf '%s  %s\n' "$checksum" "$asset" >> "$TEMP_FILE"
done

mv "$TEMP_FILE" "$OUTPUT_FILE"
printf 'Wrote checksum manifest: %s\n' "$OUTPUT_FILE"
