#!/usr/bin/env bash
# Local, opt-in alpha bundle only. No interpreter or stable installer fallback.
set -euo pipefail
script_dir="${BASH_SOURCE[0]%/*}"
if [[ "$script_dir" == "${BASH_SOURCE[0]}" ]]; then script_dir=.; fi
script_dir="$(cd -- "$script_dir" && pwd -P)"
helper="$script_dir/arashi2-setup"
if [[ ! -f "$helper" || ! -x "$helper" || -L "$helper" ]]; then
  printf '%s\n' 'Missing or unsafe native arashi2-setup beside this launcher. Obtain the complete trusted alpha bundle for this platform.' >&2
  exit 1
fi
exec "$helper" "$@"
