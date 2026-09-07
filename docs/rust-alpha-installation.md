# Controlled canonical Rust alpha

The native alpha uses the canonical executable names `aw` and `arashi`. It is for coordinated personal testing only. It is incomplete; read the [support ledger](rust-port.md) before using it on a workspace.

The alpha does **not** replace files in the stable installation. It installs into a private `$HOME/.arashi-alpha` directory (Windows: `%USERPROFILE%\.arashi-alpha`). It shadows stable v1 only when you explicitly put that directory before the stable directory on `PATH`. Stable npm packages, website installers, update discovery, release workflows, and `$HOME/.arashi/bin` remain unchanged.

## Build a local tester bundle

From a reviewed checkout:

```sh
cargo build --locked --release --bin arashi --bin aw --bin arashi-alpha-setup
python3 -B scripts/alpha/package.py --output target/alpha-distribution
```

Packaging is local and host-native. It performs no tag, upload, npm, update, or network operation. The output includes a platform payload ZIP, its `.zip.sha256`, and a mode-preserving `*-tester.tar.gz` on macOS/Linux or `*-tester.zip` on Windows. Extract the tester archive into a new directory. It contains only the payload ZIP, checksum, `arashi-alpha-setup` (`.exe` on Windows), and the Bash/PowerShell launchers.

Install, refresh, uninstall, and the installed CLI require no Python, Node, Bun, Rust toolchain, or network access. The launcher executes the exact adjacent native setup helper and never searches `PATH` for one.

## Install and opt in to shadowing

Substitute the exact artifact name produced for the host:

```sh
bash ./install-alpha.sh install \
  --accept-canonical-shadow \
  --archive ./arashi-2.0.0-alpha.1-macos-arm64.zip \
  --checksum-file ./arashi-2.0.0-alpha.1-macos-arm64.zip.sha256
```

Windows PowerShell:

```powershell
.\install-alpha.ps1 install --accept-canonical-shadow `
  --archive .\arashi-2.0.0-alpha.1-windows-x64.zip `
  --checksum-file .\arashi-2.0.0-alpha.1-windows-x64.zip.sha256
```

`--accept-canonical-shadow` is mandatory for every install or refresh. It acknowledges that the private directory contains canonical names. Setup itself does not edit `PATH`, shell profiles, registry values, stable files, or npm state.

For one shell session, explicitly shadow stable after installation:

```sh
export PATH="$HOME/.arashi-alpha:$PATH"
command -v aw
aw --version
```

PowerShell:

```powershell
$env:Path = "$env:USERPROFILE\.arashi-alpha;$env:Path"
Get-Command aw
aw --version
```

The version output is `arashi 2.x.y-alpha.N (controlled native alpha)`. Verify `command -v aw`/`Get-Command aw` resolves inside `.arashi-alpha` before testing. Do not add this directory permanently unless you accept managing that profile edit yourself.

## Shell and completion

Canonical native shell and completion generation are enabled:

```sh
aw shell init bash
aw completion bash
```

Generated wrappers, completion registrations, and dynamic completion queries use canonical `arashi`. With `.arashi-alpha` first on `PATH`, those calls resolve back to the installed native alpha. `update`, `uninstall`, `shell install`, and `shell uninstall` dispatch inside `aw`/`arashi` are blocked so the alpha cannot invoke the stable lifecycle or edit persistent profiles. Use the setup bundle for alpha refresh/removal, and use `shell init` plus completion generation for non-mutating shell setup. `aw install` remains the non-mutating direct-binary informational command.

## Exact rollback

Keep the extracted setup bundle. First remove any temporary `PATH` prefix from the current shell (or start a fresh shell), then run:

```sh
bash ./install-alpha.sh uninstall
hash -r 2>/dev/null || true
command -v aw
aw --version
```

PowerShell:

```powershell
$env:Path = (($env:Path -split ';') | Where-Object { $_ -ne "$env:USERPROFILE\.arashi-alpha" }) -join ';'
.\install-alpha.ps1 uninstall
Get-Command aw
aw --version
```

Removal validates the closed schema-2 ownership manifest and every payload hash, then removes only `aw`, `arashi`, the manifest, and the empty `.arashi-alpha` directory. It never restores stable bytes because it never changed them; removing the PATH shadow exposes the unchanged stable installation. If you made a persistent profile edit, remove that exact edit manually.

Refresh uses an adjacent stage and backup directory. Both new binaries must pass an exact alpha-version smoke test before promotion. A failed promotion restores the prior owned alpha when possible and reports any preserved recovery directory.

## Refusal and retired `aw2` installs

Changed/missing payloads, unknown or duplicate manifest fields, extra files, symlinks, hardlinks, Windows reparse points, wrong-platform archives, malformed checksums, stale locks, and unowned destinations fail closed. Setup preserves unproven contents for manual recovery.

The former schema-1 `aw2`/`arashi2` development install is not migrated or adopted. Remove it with its original trusted setup bundle before installing this alpha. If that bundle is unavailable or the old install is modified, leave `$HOME/.arashi-alpha` untouched, move it aside only after manual inspection, and install into a clean default location. Never rewrite its ownership manifest to force adoption.

SHA-256 detects accidental corruption, not authenticity. Build locally from a reviewed commit or trust the exact workflow commit. No public alpha release or stable update channel is part of this contract.

## Validation

`python3 -B tests/rust/alpha_distribution.py` builds the local artifact contract around actual release binaries, extracts the tester archive with native tools, and exercises install, refresh, canonical PATH shadowing, shell/completion, refusal cases, and rollback in disposable Unicode HOME paths. CI may retain short-lived workflow artifacts, but has no release-upload or repository-write permission.

This support describes implemented behavior, not an invitation to install an arbitrary branch build. The Windows cleanup is integrated, but the exact candidate still must satisfy the [controlled alpha handoff gates](rust-completion-plan.md#controlled-alpha-handoff-gates). Until then, build and test only from a reviewed local checkout; do not treat an unverified workflow artifact as a release.
