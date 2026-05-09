#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <tag>" >&2
  exit 1
fi

TAG="$1"
VERSION="${TAG#v}"
DRY_RUN="${DRY_RUN:-false}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTES_FILE="$(mktemp)"

cleanup() {
  rm -f "$NOTES_FILE"
}
trap cleanup EXIT

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required for release recovery" >&2
  exit 1
fi

cd "$ROOT_DIR"

if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG does not exist in this checkout" >&2
  exit 1
fi

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
if [ "$PACKAGE_VERSION" != "$VERSION" ]; then
  echo "package.json version ($PACKAGE_VERSION) does not match requested tag ($TAG)" >&2
  exit 1
fi

"$ROOT_DIR/scripts/extract-changelog-section.sh" "$TAG" "$NOTES_FILE"

ASSET_SPECS=(
  "bin/arashi#arashi (POSIX wrapper script)"
  "bin/arashi.bat#arashi.bat (Windows CMD wrapper)"
  "bin/arashi.ps1#arashi.ps1 (Windows PowerShell wrapper)"
  "bin/arashi-linux-x64#arashi-linux-x64 (Linux x64)"
  "bin/arashi-macos-arm64#arashi-macos-arm64 (macOS ARM64)"
  "bin/arashi-windows-x64.exe#arashi-windows-x64.exe (Windows x64)"
  "bin/arashi-checksums.txt#arashi-checksums.txt (SHA-256 checksums)"
)

ASSET_PATHS=()
for asset_spec in "${ASSET_SPECS[@]}"; do
  asset_path="${asset_spec%%#*}"
  if [ ! -f "$asset_path" ]; then
    echo "Missing release asset: $asset_path" >&2
    exit 1
  fi
  ASSET_PATHS+=("$asset_spec")
done

run() {
  if [ "$DRY_RUN" = "true" ]; then
    printf '+ ' >&2
    printf '%q ' "$@" >&2
    printf '\n' >&2
    return 0
  fi

  "$@"
}

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Updating existing GitHub release for $TAG"
  run gh release edit "$TAG" --title "$TAG" --notes-file "$NOTES_FILE"
  run gh release upload "$TAG" "${ASSET_PATHS[@]}" --clobber
else
  echo "Creating GitHub release for $TAG"
  run gh release create "$TAG" "${ASSET_PATHS[@]}" --title "$TAG" --notes-file "$NOTES_FILE" --verify-tag
fi
