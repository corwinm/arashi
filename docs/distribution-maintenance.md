# Distribution maintenance

User installation, manual release fallback, and troubleshooting belong in the
[canonical installation guide](https://arashi.haphazard.dev/getting-started/).
This page covers the CLI implementation and release artifacts.

## Entrypoints

The npm package intentionally has no install lifecycle script. Both `aw` and `arashi`
map to `bin/arashi.js`; `bin/install-binary.js` resolves the native asset from the
installed package version on explicit install or first use, verifies its version,
and removes partial downloads on failure.

Direct distributions keep the canonical wrappers and marked `aw` aliases beside one
native payload: `arashi.bin` on POSIX or `arashi.bin.exe` on Windows. Keep aliases as
source files; do not compile a second native executable for `aw`.

See [FZF compatibility](FZF_COMPATIBILITY.md) for the POSIX wrapper's conditional
stdin handling. Windows launchers keep stdin attached for interactive pickers.

## Build and release

```bash
pnpm run build       # current platform: bin/arashi.bin
pnpm run build:all   # macOS ARM64, Linux x64, Windows x64
pnpm run executable-contract:check
```

Bun compiles the application; pnpm runs contributor tooling. Semantic Release uses
`.releaserc.json` to publish platform binaries, wrappers, uninstall helpers, and
`arashi-checksums.txt` together. The checksum manifest must describe the artifacts
from that same release. The docs site serves `scripts/install.sh` and
`scripts/install.ps1` through its hosted installer endpoints.

Direct installers verify checksums before replacing payloads. Their recoverable
transactions commit the schema-v2 `.arashi-managed-entrypoints.json` only after
payload and installer-created PATH state are known. POSIX verifies matching,
non-empty versions through both command names. Windows compares the native binary
and policy-independent `arashi.bat` / `aw.bat` entrypoints; fresh-shell acceptance
separately exercises PowerShell wrappers. Preserve these checks when changing
packaging or installers.

Release verification is owned by `.github/workflows/verify-aw-release.yml` and
`scripts/release/verify-aw.ts`; installer and packed-package acceptance tests live
in `tests/integration/` and `tests/windows/`.
