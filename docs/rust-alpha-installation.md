# Rust alpha setup

`aw2` and `arashi2` are the same incomplete native Rust alpha CLI. They coexist with stable `aw`/`arashi`; they do not replace it. Read the [support ledger](rust-port.md) before using alpha commands on a workspace.

## Get a tester bundle

Use an artifact from the **Rust alpha distribution artifacts** workflow for your OS/architecture and a reviewed commit. There is no published alpha installer endpoint or automatic “latest” lookup. Stable npm and website installers still install v1.

Alternatively, create a host-native bundle locally:

```sh
cargo build --locked --release --bin arashi2 --bin aw2
python3 -B scripts/alpha/package.py --output target/alpha-distribution
```

The bundle contains a platform-named ZIP, its `.zip.sha256` file, and three setup files. Keep the setup files together. Python **3.9+** is required for setup/removal only; installed CLI binaries need neither Python, Node nor Bun. Bash is used on macOS/Linux; Windows PowerShell 5.1 or PowerShell 7 uses `python` on PATH.

## Install or refresh

From the extracted tester bundle, substitute its exact ZIP filename:

```sh
bash ./install-alpha.sh install \
  --archive ./arashi2-2.0.0-alpha.1-macos-arm64.zip \
  --checksum-file ./arashi2-2.0.0-alpha.1-macos-arm64.zip.sha256
"$HOME/.arashi-alpha/aw2" --version
```

Windows PowerShell:

```powershell
.\install-alpha.ps1 install --archive .\arashi2-2.0.0-alpha.1-windows-x64.zip --checksum-file .\arashi2-2.0.0-alpha.1-windows-x64.zip.sha256
& "$env:USERPROFILE\.arashi-alpha\aw2.exe" --version
```

Re-run `install` with another trusted alpha bundle to refresh. Only explicit `2.x.y-alpha.N` releases for the running OS/architecture are accepted. Both executables must pass the native alpha version smoke test before replacement. Downloads, signatures, automatic updates and stable-major migration are not implemented. SHA-256 detects damaged/mismatched bytes, **not authenticity**: the workflow commit and downloaded setup code must be trusted.

Default ownership is confined to `$HOME/.arashi-alpha` (Windows: `%USERPROFILE%\.arashi-alpha`), containing only the two binaries and `.arashi-alpha-ownership.json`. `--install-dir` accepts a canonical absolute path ending in `.arashi-alpha` beneath an existing ordinary directory; it cannot target `.arashi/bin` or adopt an existing unowned directory.

## Shell and removal

Setup makes **no PATH, profile, registry or shell-block changes**. Invoke the absolute path, or manually add the alpha-only directory to PATH. Alpha-specific shell wrappers and completions are pending. `aw2 shell`, `completion`, `install`, `update` and `uninstall` deliberately fail rather than emit stable wrappers or invoke stable lifecycle code. Parent-shell switching integration is not provided by this bundle.

Keep the setup bundle for removal:

```sh
bash ./install-alpha.sh uninstall
```

```powershell
.\install-alpha.ps1 uninstall
```

Pass the same `--install-dir` if installation used an override. Removal verifies the closed alpha manifest and every payload hash, then removes only those files and their empty directory. Manual PATH entries remain yours to remove. Stable v1 binaries, ownership manifests, npm packages and shell integration are never managed by this setup.

## Refusal and recovery

Changed/missing payloads, unknown manifest schemas/properties, added caller files, symlinks, hardlinks, Windows reparse points and occupied/stale locks block automatic mutation. Preserve those files and inspect the reported location; do not delete or rewrite an ownership manifest to force adoption. A failed pre-publication smoke test preserves the old install. A failed directory promotion attempts rollback; a busy Windows executable or interrupted operation can require manual recovery from the reported `.arashi-alpha-backup-*` directory. Never remove a lock while setup is running.

Manual fallback: verify a trusted ZIP's checksum, extract only `arashi2` and `aw2` (`.exe` on Windows) into a **new private directory**, and invoke them by absolute path. Do not rename them to `arashi`/`aw`. Manual extraction does not create installer ownership and must be removed manually.

The lifecycle serializes its own invocations but does not promise crash-atomicity or protection against arbitrary concurrent external filesystem writers. Uninstall may stop partially on an OS error and preserve the remaining files for recovery. Close running alpha commands before refresh/removal on Windows.

## Validation and transition gates

`python3 -B tests/rust/alpha_distribution.py` packages and exercises actual release binaries using disposable Unicode HOME paths. It covers refresh/removal, stable-file/profile preservation, caller collisions, changed payloads/manifests, corrupt/traversing/wrong-platform archives, smoke failure, promotion rollback, links and reproducible packaging. Windows CI runs the same lifecycle through PowerShell 5.1 and 7, plus junction refusal; the macOS run cannot establish those Windows results.

CI only retains tester artifacts; it has no release-upload or repository-write permission. Stable publication is unchanged. Before native v2 becomes stable, independently accept npm/direct-install v1-to-v2 migration, canonical-name ownership and updater discovery (including a final v1 bridge release if necessary). Do not retire alpha aliases or migrate alpha ownership into the v1 ledger implicitly. Companion website/skill instructions require parent-owned updates before public alpha publication.
