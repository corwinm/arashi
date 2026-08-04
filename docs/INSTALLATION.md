# Installation and Distribution

## Overview

Arashi uses a small JavaScript npm entrypoint plus wrapper scripts to ensure compatibility with interactive tools like fzf. Direct installer distributions include wrapper scripts and compiled Bun executables; npm installs begin with lightweight JavaScript and wrapper files, then install the matching platform binary on first use or through `arashi install`.

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
arashi install
```

Verify any method with:

```bash
arashi --version
```

## POSIX curl installer behavior and release binding

The POSIX curl installer (`scripts/install.sh`) is bound to GitHub Releases artifacts:

- Default behavior installs the latest stable release from `releases/latest/download`.
- `ARASHI_VERSION=<version>` pins to `releases/download/v<version>` for reproducible installs.
- Platform mapping:
  - `darwin-arm64` -> `arashi-macos-arm64`
  - `linux-x64` -> `arashi-linux-x64`
- Integrity requirement: installer downloads `arashi-checksums.txt` from the same release and verifies both the wrapper (`arashi`) and target platform binary SHA-256 checksums before install.
- Runtime verification: after staging the wrapper and binary, the installer runs `arashi --version` as a smoke test before updating shell PATH configuration.
- Default install placement is `~/.arashi/bin` unless overridden with `ARASHI_INSTALL_DIR` or `--install-dir`.
- Installer updates the active shell config (`.zshrc`, `.bashrc`/`.bash_profile`, `.profile`, or fish config) to include the install directory on `PATH`.
- Interactive curl installs offer to enable shell integration for bash, zsh, and fish so `arashi switch --cd` works without a second setup step.
- For unattended installs, set `ARASHI_SHELL_INTEGRATION=yes` to enable shell integration without prompting or `ARASHI_SHELL_INTEGRATION=no` to skip it.
- Install placement uses staged temp files and atomic moves to `arashi` (wrapper) and `arashi.bin` (platform binary).

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
- Default install placement is `%USERPROFILE%\.arashi\bin` unless overridden with `ARASHI_INSTALL_DIR` or `-InstallDir`.
- Install placement uses staged downloads and installs files together as:
  - `arashi.bin.exe`
  - `arashi`
  - `arashi.ps1`
  - `arashi.bat`
- The installer adds the install directory to the persistent user PATH by default, avoids duplicate PATH entries, and tells the user to open a new Git Bash window or other terminal. The extensionless `arashi` wrapper lets Git Bash execute the adjacent `arashi.bin.exe`.
- The installer does not create or modify `.bashrc`, `.bash_profile`, `.profile`, or another shell profile.
- Use `ARASHI_NO_MODIFY_PATH=1` or `-NoModifyPath` to skip PATH modification.
- Runtime verification: after installing the wrapper and binary, the installer runs `arashi.bin.exe --version` as a smoke test so the default install path does not depend on PowerShell execution policy.

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
- Smoke test failure (for example `arashi --version` exits immediately or returns code `137`): rerun with a pinned release using `ARASHI_VERSION=<version>`, or use npm/manual release assets while reporting the bad release artifact.
- Unsupported platform: use npm (`npm install -g arashi`) when available, otherwise use manual release assets.
- If you skip shell integration during install, run `arashi shell install` later.

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
- To preinstall the platform binary, run `arashi install` after npm install. This is safe to run more than once; if the matching binary already exists it exits successfully without downloading again.
- First-use download failure: retry `arashi install` once, then use direct/manual release assets if the network or release asset remains unavailable.
- Verification fails during `arashi install` or first use: partial downloads are removed automatically; switch to direct/manual release flow and report the bad release artifact.

## Manual Windows release fallback

If you do not want to pipe a remote script into PowerShell or the installer fails:

1. Open <https://github.com/corwinm/arashi/releases/latest>.
2. Download these assets from the same release:
   - `arashi-windows-x64.exe`
   - `arashi`
   - `arashi.ps1`
   - `arashi.bat`
   - `arashi-checksums.txt`
3. Verify each downloaded asset against `arashi-checksums.txt` with `Get-FileHash -Algorithm SHA256`.
4. Put the four payload files in one directory on PATH.
5. Rename `arashi-windows-x64.exe` to `arashi.bin.exe` so both wrappers find the binary.
6. Open a new Git Bash window and run `arashi --version`, or verify through `arashi.ps1` in PowerShell / `arashi.bat` in Command Prompt.

## Why a Wrapper?

Bun's compiled executables have a limitation where stdin (file descriptor 0) remains open even after calling `process.stdin.destroy()` or `fs.closeSync(0)`. This prevents tools like fzf from exclusively accessing `/dev/tty` for keyboard input.

The POSIX wrapper solves this by closing stdin when piping `arashi list` output:

```bash
if [ "$command" = "list" ] && [ ! -t 1 ]; then
  exec "$SCRIPT_DIR/arashi.bin" "$@" 0<&-
fi
exec "$SCRIPT_DIR/arashi.bin" "$@"
```

## Distribution Methods

### 1. npm Package (Recommended when Node/npm is available)

The npm package intentionally avoids lifecycle scripts. Its package metadata points the npm `bin` entry to `./bin/arashi.js` and publishes the JavaScript entrypoint, wrapper files, and runtime installer module.

When users run `npm install -g arashi`, npm:

1. Installs the JavaScript entrypoint (`bin/arashi.js`), wrapper files, and runtime installer module.
2. Creates a symlink in the global bin directory pointing to `bin/arashi.js`.
3. Downloads the matching platform binary when the user runs `arashi install` or the first normal `arashi <command>`.

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

The POSIX wrapper (`bin/arashi`) and Windows wrappers (`bin/arashi.ps1`, `bin/arashi.bat`) are maintained as source files and included in distributions.

## Creating Releases

Semantic Release builds and uploads the release assets listed in `.releaserc.json`, including platform binaries, wrappers, and `arashi-checksums.txt`. The docs site exposes the installer scripts at:

- `https://arashi.haphazard.dev/install`
- `https://arashi.haphazard.dev/install.ps1`

## User Experience

From the user's perspective, they just run `arashi` - they don't need to know about the wrapper:

```bash
# Install via npm
npm install -g arashi

# Use anywhere
arashi list | fzf          # ✓ Works perfectly
cd $(arashi list | fzf)    # ✓ Interactive navigation
arashi remove -f "$(arashi list | fzf)"  # ✓ Pick a worktree via fzf
```

## Windows Support

On Windows, the npm entrypoint and Windows wrappers launch the packaged `.exe` directly and keep stdin attached so interactive commands such as `arashi switch` can render prompt pickers normally.

The Unix shell wrapper's stdin-closing behavior is only needed for shell pipelines like `arashi list | fzf`; Windows launchers do not force stdin closed for every command because that breaks interactive prompts.
