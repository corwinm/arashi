# Installation and Distribution

## Overview

Arashi uses a small JavaScript npm entrypoint plus wrapper scripts to ensure compatibility with interactive tools like fzf. Direct/curl distributions include a wrapper and compiled Bun executable; npm installs begin with lightweight JavaScript and wrapper files, then install the matching platform binary on first use or through `arashi install`.

## Official install methods

Use either of these official commands:

```bash
curl -fsSL https://arashi.haphazard.dev/install | bash
```

```bash
npm install -g arashi
```

Verify either method with:

```bash
arashi --version
```

## Curl installer behavior and release binding

The curl installer (`scripts/install.sh`) is bound to GitHub Releases artifacts:

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

Checksum manifest expectations:

- Release workflow must generate `bin/arashi-checksums.txt` from built artifacts.
- The release must publish wrapper scripts, platform binaries, and the checksum manifest together.
- If checksum validation fails, installer exits without replacing an existing binary.

## Curl troubleshooting and fallback guidance

- Missing prerequisite (`curl`, `bash`, checksum tool): install missing dependency, then rerun installer.
- Permission denied writing install location: rerun with `ARASHI_INSTALL_DIR="$HOME/.local/bin"` or another writable path.
- Download/network errors: retry the command; if failures persist, use npm installation or manual releases.
- Checksum mismatch: treat as a blocked install, retry once, then fall back to npm/manual and report the issue.
- Smoke test failure (for example `arashi --version` exits immediately or returns code `137`): rerun with a pinned release using `ARASHI_VERSION=<version>`, or use npm/manual release assets while reporting the bad release artifact.
- Unsupported platform: use npm (`npm install -g arashi`) when available, otherwise use manual release assets.
- If you skip shell integration during install, run `arashi shell install` later.

## npm troubleshooting and fallback guidance

- `npm: command not found`: install Node.js/npm, then retry. If unavailable, use the curl installer.
- Permission errors with global npm installs: configure a user-level npm prefix or use curl with `ARASHI_INSTALL_DIR="$HOME/.local/bin"`.
- Lifecycle scripts are not required: the npm package does not define `postinstall`, so package managers that block install scripts can still install Arashi.
- To preinstall the platform binary, run `arashi install` after npm install. This is safe to run more than once; if the matching binary already exists it exits successfully without downloading again.
- First-use download failure: retry `arashi install` once, then use curl/manual release assets if the network or release asset remains unavailable.
- Verification fails during `arashi install` or first use: partial downloads are removed automatically; switch to curl/manual release flow and report the bad release artifact.

## Why a Wrapper?

Bun's compiled executables have a limitation where stdin (file descriptor 0) remains open even after calling `process.stdin.destroy()` or `fs.closeSync(0)`. This prevents tools like fzf from exclusively accessing `/dev/tty` for keyboard input.

The wrapper solves this by closing stdin when piping `arashi list` output:

```bash
if [ "$command" = "list" ] && [ ! -t 1 ]; then
  exec "$SCRIPT_DIR/arashi.bin" "$@" 0<&-
fi
exec "$SCRIPT_DIR/arashi.bin" "$@"
```

## Distribution Methods

### 1. npm Package (Recommended)

The npm package intentionally avoids lifecycle scripts. Its package metadata points the npm `bin` entry to `./bin/arashi.js` and publishes the JavaScript entrypoint, wrapper files, and runtime installer module.

When users run `npm install -g arashi`, npm:

1. Installs the JavaScript entrypoint (`bin/arashi.js`), wrapper files, and runtime installer module.
2. Creates a symlink in the global bin directory pointing to `bin/arashi.js`.
3. Downloads the matching platform binary when the user runs `arashi install` or the first normal `arashi <command>`.

The installer resolves assets from the installed package version, for example `https://github.com/corwinm/arashi/releases/download/v<version>/arashi-linux-x64`, verifies the binary with `--version`, and removes partial downloads on failure.

### 2. Direct Binary Downloads (GitHub Releases)

For users who don't use npm, we distribute platform-specific `.tar.gz` archives that include both files:

```
arashi-macos-arm64.tar.gz
├── arashi          # Wrapper script
└── arashi.bin      # Compiled binary

arashi-linux-x64.tar.gz
├── arashi          # Wrapper script
└── arashi.bin      # Compiled binary
```

Users extract and install both files:

```bash
tar xzf arashi-macos-arm64.tar.gz
cd arashi-macos-arm64
sudo cp arashi arashi.bin /usr/local/bin/
```

## Build Process

The build process creates binaries in the `bin/` directory:

```bash
# Build for current platform
bun run build
# Output: bin/arashi.bin

# Build for all platforms
bun run build:all
# Output: bin/arashi-macos-arm64, bin/arashi-linux-x64, bin/arashi-windows-x64.exe
```

The wrapper (`bin/arashi`) is maintained as a source file and included in all distributions.

## Creating Releases

Use the packaging script to create release archives:

```bash
./scripts/package-releases.sh 0.1.0
```

This creates:

- `releases/arashi-0.1.0-macos-arm64.tar.gz`
- `releases/arashi-0.1.0-linux-x64.tar.gz`

Upload these to GitHub Releases.

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

On Windows, the npm entrypoint launches the packaged `.exe` directly and keeps stdin attached so interactive commands such as `arashi switch` can render prompt pickers normally.

The Unix shell wrapper's stdin-closing behavior is only needed for shell pipelines like `arashi list | fzf`; Windows launchers do not force stdin closed for every command because that breaks interactive prompts.
