# Installation and Distribution

## Overview

Arashi uses a wrapper script approach to ensure compatibility with interactive tools like fzf. The distribution includes two files:
- `arashi` - Shell wrapper script (the command users run)
- `arashi.bin` - The compiled Bun executable

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

The npm package automatically handles the wrapper:

```json
{
  "bin": {
    "arashi": "./bin/arashi"
  },
  "files": [
    "bin/"
  ]
}
```

When users run `npm install -g arashi`, npm:
1. Installs both `bin/arashi` (wrapper) and `bin/arashi.bin` (binary)
2. Creates a symlink in the global bin directory pointing to `bin/arashi`
3. Everything works transparently

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
```

## Windows Support

Windows requires a different approach since `.bat` and `.ps1` files can't use `exec` or close stdin in the same way. Options:
1. Use WSL (works with Linux binary)
2. Create a PowerShell wrapper (requires research)
3. Document the limitation

Currently, Windows support is marked as "coming soon" in the README.
