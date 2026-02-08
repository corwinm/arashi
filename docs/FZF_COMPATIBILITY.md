# FZF Compatibility Fix

## Problem
When piping `arashi list` to `fzf`, the interactive interface would not respond to keyboard input. This is due to a limitation in Bun's compiled executables where stdin (file descriptor 0) remains open, preventing fzf from accessing `/dev/tty` for keyboard input.

## Solution
We use a shell wrapper that closes stdin when piping `arashi list` output:

```bash
#!/bin/bash
if [ "$command" = "list" ] && [ ! -t 1 ]; then
  exec arashi.bin "$@" 0<&-
fi
exec arashi.bin "$@"
```

The `0<&-` syntax closes file descriptor 0 (stdin) before execution.

## Build Process
The build process now creates:
- `dist/arashi.bin` - The compiled Bun executable
- `dist/arashi-wrapper.sh` - Shell wrapper that closes stdin
- For installation, rename the wrapper to `arashi`

## Installation
```bash
cp dist/arashi.bin ~/.local/bin/arashi.bin
cp dist/arashi-wrapper.sh ~/.local/bin/arashi
chmod +x ~/.local/bin/arashi
```

## Why This Works
1. **Root Cause**: Bun's compiled executables keep stdin open even when `process.stdin.destroy()` or `fs.closeSync(0)` is called
2. **Impact**: When stdin is open, fzf cannot exclusively access `/dev/tty` for keyboard input
3. **Fix**: The shell wrapper closes stdin at the OS level before the binary runs
4. **Result**: fzf can properly open `/dev/tty` and receive keyboard input while interactive commands keep stdin

## Testing
To verify fzf works correctly:
```bash
arashi list | fzf
# Should show the list and respond to typing/arrow keys/enter
```

## Alternative Approaches Tried
- ❌ `process.stdin.destroy()` - Doesn't close FD 0 in Bun
- ❌ `process.stdin.unref()` - Doesn't help with FD ownership
- ❌ `fs.closeSync(0)` - Ignored by Bun's compiled executable
- ✅ Shell wrapper with `0<&-` - Works perfectly
