#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <version-or-tag> [output-file]" >&2
  exit 1
fi

VERSION="${1#v}"
OUTPUT_FILE="${2:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG_PATH="$ROOT_DIR/CHANGELOG.md"

if [ ! -f "$CHANGELOG_PATH" ]; then
  echo "CHANGELOG.md not found at $CHANGELOG_PATH" >&2
  exit 1
fi

extract_section() {
  awk -v version="$VERSION" '
    $0 ~ "^## \\[" version "\\]" {
      capture = 1
    }

    capture {
      if ($0 ~ "^## \\[" && $0 !~ "^## \\[" version "\\]") {
        exit
      }
      print
    }
  ' "$CHANGELOG_PATH"
}

if [ -n "$OUTPUT_FILE" ]; then
  extract_section > "$OUTPUT_FILE"
  if [ ! -s "$OUTPUT_FILE" ]; then
    echo "Could not find changelog section for version $VERSION" >&2
    rm -f "$OUTPUT_FILE"
    exit 1
  fi
  exit 0
fi

TEMP_FILE="$(mktemp)"
extract_section > "$TEMP_FILE"
if [ ! -s "$TEMP_FILE" ]; then
  echo "Could not find changelog section for version $VERSION" >&2
  rm -f "$TEMP_FILE"
  exit 1
fi
cat "$TEMP_FILE"
rm -f "$TEMP_FILE"
