# Installation and Distribution

## Overview

Arashi uses a small JavaScript npm entrypoint plus wrapper scripts to ensure compatibility with interactive tools like fzf. Supported installations provide both `aw` and `arashi` through the same implementation. Product identity, configuration, `ARASHI_*` variables, packages, and native binaries retain their established Arashi names.

## Official install methods

Use the installer for your platform, or install through npm when you already have Node.js/npm.

macOS/Linux:

```bash
curl -fsSL https://arashi.haphazard.dev/install | bash
```

Windows PowerShell:

```powershell
powershell -c "irm https://arashi.haphazard.dev/install.ps1 | iex"
```

npm:

```bash
npm install -g arashi
aw install
```

Verify any method with:

```bash
aw --version
```

## POSIX curl installer behavior and release binding

The POSIX curl installer (`scripts/install.sh`) is bound to GitHub Releases artifacts:

- Default behavior installs the latest stable release from `releases/latest/download`.
- `ARASHI_VERSION=<version>` pins to `releases/download/v<version>` for reproducible installs.
- Platform mapping:
  - `darwin-arm64` -> `arashi-macos-arm64`
  - `linux-x64` -> `arashi-linux-x64`
- Integrity requirement: installer downloads `arashi-checksums.txt` from the same release and verifies `arashi`, marked alias `aw`, and the target platform binary before install.
- Runtime verification: a recoverable transaction installs `arashi.bin`, `arashi`, and `aw`, requires identical non-empty version output through both names, and atomically commits `.arashi-managed-entrypoints.json` before updating PATH or shell startup state.
- Default install placement is `~/.arashi/bin` unless overridden with `ARASHI_INSTALL_DIR` or `--install-dir`.
- Installer updates the active shell config (`.zshrc`, `.bashrc`/`.bash_profile`, `.profile`, or fish config) to include the install directory on `PATH`.
- Interactive curl installs offer to enable shell integration for bash, zsh, and fish so `aw switch --cd` works without a second setup step.
- For unattended installs, set `ARASHI_SHELL_INTEGRATION=yes` to enable shell integration without prompting or `ARASHI_SHELL_INTEGRATION=no` to skip it.
- Before downloads or mutation, the installer rejects an unowned destination `aw`, malformed/mismatched ledger, or an effective-PATH `aw` outside the selected install directory. Marked manual wrappers are not adopted without ledger ownership; move or remove them deliberately before retrying.

## Windows PowerShell installer behavior and release binding

The Windows PowerShell installer (`scripts/install.ps1`) is also bound to GitHub Releases artifacts:

- Default behavior installs the latest stable release from `releases/latest/download`.
- `ARASHI_VERSION=<version>` or `-Version <version>` pins to `releases/download/v<version>` for reproducible installs.
- Platform mapping:
  - Windows x64 -> `arashi-windows-x64.exe`
- Integrity requirement: installer downloads `arashi-checksums.txt` from the same release and verifies these assets with `Get-FileHash -Algorithm SHA256` before install:
  - `arashi-windows-x64.exe`
  - `arashi`
  - `arashi.ps1`
  - `arashi.bat`
  - `aw`
  - `aw.ps1`
  - `aw.bat`
- Default install placement is `%USERPROFILE%\.arashi\bin` unless overridden with `ARASHI_INSTALL_DIR` or `-InstallDir`.
- Install placement uses staged downloads and installs files together as:
  - `arashi.bin.exe`
  - `arashi`
  - `arashi.ps1`
  - `arashi.bat`
  - `aw`
  - `aw.ps1`
  - `aw.bat`
- The installer adds the install directory to the persistent user PATH by default, avoids duplicate PATH entries, and tells the user to open a new Git Bash window or other terminal. The extensionless `arashi` wrapper lets Git Bash execute the adjacent `arashi.bin.exe`.
- The installer does not create or modify `.bashrc`, `.bash_profile`, `.profile`, or another shell profile.
- Use `ARASHI_NO_MODIFY_PATH=1` or `-NoModifyPath` to skip PATH modification.
- Before downloads or mutation, the installer rejects unowned/ambiguous alias destinations, malformed or mismatched ownership ledgers, and PowerShell/CMD/Git Bash `aw` resolutions outside the selected directory without executing the unrelated command.
- Runtime verification compares identical output from the native binary and the policy-independent CMD entrypoints `arashi.bat` and `aw.bat` before atomically committing the alias ownership ledger. Fresh-shell acceptance separately verifies the PowerShell wrappers. Any replacement, smoke, or ledger failure restores the seven-file payload and prior ledger; recoverable backups are retained with manual instructions if rollback itself fails.

Examples:

```powershell
# Inspect before running
irm https://arashi.haphazard.dev/install.ps1

# Install latest
powershell -c "irm https://arashi.haphazard.dev/install.ps1 | iex"

# Pin a version when invoking a downloaded script
.\install.ps1 -Version 1.16.0

# Custom user-writable install directory without changing PATH
.\install.ps1 -InstallDir C:\Tools\Arashi -NoModifyPath
```

## Checksum manifest expectations

- Release workflow must generate `bin/arashi-checksums.txt` from built artifacts.
- The release must publish wrapper scripts, platform binaries, and the checksum manifest together.
- If checksum validation fails, installers exit without replacing an existing binary.

## POSIX curl troubleshooting and fallback guidance

- Missing prerequisite (`curl`, `bash`, checksum tool): install missing dependency, then rerun installer.
- Permission denied writing install location: rerun with `ARASHI_INSTALL_DIR="$HOME/.local/bin"` or another writable path.
- Download/network errors: retry the command; if failures persist, use npm installation or manual releases.
- Checksum mismatch: treat as a blocked install, retry once, then fall back to npm/manual and report the issue.
- Smoke test failure (for example `aw --version` exits immediately or returns code `137`): rerun with a pinned release using `ARASHI_VERSION=<version>`, or use npm/manual release assets while reporting the bad release artifact.
- Unsupported platform: use npm (`npm install -g arashi`) when available, otherwise use manual release assets.
- If you skip shell integration during install, run `aw shell install` later.

## Windows PowerShell troubleshooting and fallback guidance

- Execution policy blocks local `.ps1` execution: inspect `install.ps1` first, add `-ExecutionPolicy Bypass` to the `powershell` invocation for this one process, or use manual release assets.
- Permission denied writing install location: rerun with `-InstallDir` or `ARASHI_INSTALL_DIR` pointing to a user-writable directory.
- Download/network errors: retry the command; if failures persist, use npm installation or manual releases.
- Checksum mismatch: treat as a blocked install, retry once, then fall back to npm/manual and report the issue.
- PATH changes do not appear in the current shell: open a new Git Bash window or other terminal, or add `%USERPROFILE%\.arashi\bin` to the persistent user PATH manually when using no-modify-PATH mode. Do not add an installer-managed entry to `.bashrc` or another shell profile.
- Smoke test failure: rerun with a pinned release using `ARASHI_VERSION=<version>` or `-Version <version>`, then use npm/manual release assets while reporting the bad release artifact.
- Unsupported Windows architecture: use npm when available, or wait for a matching release asset.

## npm troubleshooting and fallback guidance

- `npm: command not found`: install Node.js/npm, then retry. If unavailable, use the platform installer for macOS/Linux or Windows PowerShell.
- Permission errors with global npm installs: configure a user-level npm prefix or use a direct installer with a custom user-writable install directory.
- Lifecycle scripts are not required: the npm package does not define `postinstall`, so package managers that block install scripts can still install Arashi.
- To preinstall the platform binary, run `aw install` after npm install. This is safe to run more than once; if the matching binary already exists it exits successfully without downloading again.
- First-use download failure: retry `aw install` once, then use direct/manual release assets if the network or release asset remains unavailable.
- Verification fails during `aw install` or first use: partial downloads are removed automatically; switch to direct/manual release flow and report the bad release artifact.

## Manual macOS and Linux release fallback

If you do not want to pipe a remote script into a shell, download the native payload and both wrappers from the same release, then place them together on `PATH`.

macOS (Apple Silicon):

```bash
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi-macos-arm64 -o arashi.bin
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi -o arashi
curl -L https://github.com/corwinm/arashi/releases/latest/download/aw -o aw
chmod +x arashi.bin arashi aw
sudo install -m 0755 arashi.bin arashi aw /usr/local/bin/
```

Linux (x64):

```bash
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi-linux-x64 -o arashi.bin
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi -o arashi
curl -L https://github.com/corwinm/arashi/releases/latest/download/aw -o aw
chmod +x arashi.bin arashi aw
sudo install -m 0755 arashi.bin arashi aw /usr/local/bin/
```

## Manual Windows release fallback

If you do not want to pipe a remote script into PowerShell or the installer fails:

1. Open <https://github.com/corwinm/arashi/releases/latest>.
2. Download these assets from the same release:
   - `arashi-windows-x64.exe`
   - `arashi`
   - `arashi.ps1`
   - `arashi.bat`
   - `aw`
   - `aw.ps1`
   - `aw.bat`
   - `arashi-checksums.txt`
3. Verify each downloaded asset against `arashi-checksums.txt` with `Get-FileHash -Algorithm SHA256`.
4. Put the seven payload files in one directory on PATH.
5. Rename `arashi-windows-x64.exe` to `arashi.bin.exe` so both wrappers find the binary.
6. Open fresh Git Bash, PowerShell, and Command Prompt sessions and confirm that both installed executable entrypoints report the same version.

These marked manual aliases intentionally have no direct-installer ledger ownership. Move or remove the manual alias files deliberately before running the PowerShell installer later; the installer will then create its own ledger.

## Why a Wrapper?

Bun's compiled executables have a limitation where stdin (file descriptor 0) remains open even after calling `process.stdin.destroy()` or `fs.closeSync(0)`. This prevents tools like fzf from exclusively accessing `/dev/tty` for keyboard input.

The POSIX wrapper solves this by closing stdin when piping `aw list` output:

```bash
if [ "$command" = "list" ] && [ ! -t 1 ]; then
  exec "$SCRIPT_DIR/arashi.bin" "$@" 0<&-
fi
exec "$SCRIPT_DIR/arashi.bin" "$@"
```

## Distribution Methods

### 1. npm Package (Recommended when Node/npm is available)

The npm package intentionally avoids lifecycle scripts. Its `arashi` and `aw` npm bins both point to `./bin/arashi.js` and publish one JavaScript entrypoint, wrapper files, and runtime installer module.

When users run `npm install -g arashi`, npm:

1. Installs the JavaScript entrypoint (`bin/arashi.js`), wrapper files, and runtime installer module.
2. Creates package-manager shims for `arashi` and `aw` pointing to `bin/arashi.js`.
3. Downloads the matching platform binary when either shim handles explicit install or first normal use.

The installer resolves assets from the installed package version, for example `https://github.com/corwinm/arashi/releases/download/v<version>/arashi-linux-x64`, verifies the binary with `--version`, and removes partial downloads on failure.

### 2. Direct Binary Downloads and Installers

For users who do not use npm, Arashi publishes platform-specific release assets and hosted installer scripts:

- macOS/Linux: `curl -fsSL https://arashi.haphazard.dev/install | bash`
- Windows: `powershell -c "irm https://arashi.haphazard.dev/install.ps1 | iex"`
- Manual release assets: <https://github.com/corwinm/arashi/releases/latest>

## Build Process

The build process creates binaries in the `bin/` directory:

```bash
# Build for current platform
pnpm run build
# Output: bin/arashi.bin

# Build for all platforms
pnpm run build:all
# Output: bin/arashi-macos-arm64, bin/arashi-linux-x64, bin/arashi-windows-x64.exe
```

The canonical wrappers and marked `bin/aw`, `bin/aw.ps1`, and `bin/aw.bat` aliases are maintained as source files and included in distributions; all delegate to one adjacent native binary.

## Creating Releases

Semantic Release builds and uploads the release assets listed in `.releaserc.json`, including platform binaries, wrappers, and `arashi-checksums.txt`. The docs site exposes the installer scripts at:

- `https://arashi.haphazard.dev/install`
- `https://arashi.haphazard.dev/install.ps1`

## User Experience

From the user's perspective, they just run `aw` - they don't need to know about the wrapper:

```bash
# Install via npm
npm install -g arashi

# Use anywhere
aw list | fzf          # ✓ Works perfectly
cd $(aw list | fzf)    # ✓ Interactive navigation
aw remove -f "$(aw list | fzf)"  # ✓ Pick a worktree via fzf
```

## Windows Support

On Windows, the npm entrypoint and Windows wrappers launch the packaged `.exe` directly and keep stdin attached so interactive commands such as `aw switch` can render prompt pickers normally.

The Unix shell wrapper's stdin-closing behavior is only needed for shell pipelines like `aw list | fzf`; Windows launchers do not force stdin closed for every command because that breaks interactive prompts.
