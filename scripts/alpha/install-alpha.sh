#!/usr/bin/env bash
# Local, opt-in alpha bundle only. Never use the stable installer endpoint.
set -euo pipefail
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'Alpha setup needs Python 3.9+. Install Python, or manually verify/extract the alpha archive into a NEW private directory; do not replace arashi/aw.' >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 -B "$script_dir/alpha_setup.py" "$@"
