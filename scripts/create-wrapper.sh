#!/bin/bash
# Create shell wrapper for arashi to fix fzf compatibility
# This wrapper closes stdin before executing the binary, which is required
# because Bun's compiled executables don't properly close stdin, blocking
# fzf from accessing /dev/tty for keyboard input

set -e

DIST_DIR="dist"

# Create wrapper for Unix-like systems (macOS, Linux)
cat > "$DIST_DIR/arashi-wrapper.sh" << 'EOF'
#!/bin/bash
# Wrapper for arashi that closes stdin before execution
# This is required for proper fzf integration with Bun compiled executables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command=""
force_remove="false"
for arg in "$@"; do
  case "$arg" in
    -*)
      case "$arg" in
        -f|--force) force_remove="true" ;;
      esac
      continue
      ;;
    *) command="$arg"; break ;;
  esac
done

if [ ! -t 1 ]; then
  if [ "$command" = "list" ] || { [ "$command" = "remove" ] && [ "$force_remove" = "true" ]; }; then
    exec "$SCRIPT_DIR/arashi.bin" "$@" 0<&-
  fi
fi

exec "$SCRIPT_DIR/arashi.bin" "$@"
EOF

chmod +x "$DIST_DIR/arashi-wrapper.sh"

echo "✓ Created wrapper script: $DIST_DIR/arashi-wrapper.sh"
echo ""
echo "Installation instructions:"
echo "1. Copy the compiled binary: cp dist/arashi ~/.local/bin/arashi.bin"
echo "2. Copy the wrapper: cp dist/arashi-wrapper.sh ~/.local/bin/arashi"
echo "3. Make it executable: chmod +x ~/.local/bin/arashi"
echo ""
echo "Or for platform-specific builds:"
echo "  macOS: mv dist/arashi-macos-arm64 dist/arashi.bin && cp dist/arashi-wrapper.sh dist/arashi"
echo "  Linux: mv dist/arashi-linux-x64 dist/arashi.bin && cp dist/arashi-wrapper.sh dist/arashi"
