#!/bin/bash
# Release packaging script
# Creates platform-specific archives with wrapper included

set -e

VERSION=${1:-"0.1.0"}
DIST_DIR="releases"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

echo "Building all platforms..."
bun run build:all

echo ""
echo "Creating release packages..."

# macOS
echo "Packaging macOS (arm64)..."
mkdir -p "$DIST_DIR/arashi-macos-arm64"
cp bin/arashi-macos-arm64 "$DIST_DIR/arashi-macos-arm64/arashi.bin"
cat > "$DIST_DIR/arashi-macos-arm64/arashi" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/arashi.bin" "$@" 0<&-
EOF
chmod +x "$DIST_DIR/arashi-macos-arm64/arashi"
cd "$DIST_DIR" && tar czf "arashi-${VERSION}-macos-arm64.tar.gz" arashi-macos-arm64 && cd ..

# Linux
echo "Packaging Linux (x64)..."
mkdir -p "$DIST_DIR/arashi-linux-x64"
cp bin/arashi-linux-x64 "$DIST_DIR/arashi-linux-x64/arashi.bin"
cp "$DIST_DIR/arashi-macos-arm64/arashi" "$DIST_DIR/arashi-linux-x64/arashi"
cd "$DIST_DIR" && tar czf "arashi-${VERSION}-linux-x64.tar.gz" arashi-linux-x64 && cd ..

# Windows
echo "Packaging Windows (x64)..."
mkdir -p "$DIST_DIR/arashi-windows-x64"
cp bin/arashi-windows-x64.exe "$DIST_DIR/arashi-windows-x64/arashi.bin.exe"
cp bin/arashi.bat "$DIST_DIR/arashi-windows-x64/arashi.bat"
cp bin/arashi.ps1 "$DIST_DIR/arashi-windows-x64/arashi.ps1"
# Create README for Windows users
cat > "$DIST_DIR/arashi-windows-x64/README.txt" << 'EOF'
Arashi for Windows
==================

Installation:
1. Copy all files to a directory in your PATH (e.g., C:\Program Files\arashi\)
2. Add that directory to your PATH if not already

Usage Options:

Option 1 - Batch File (CMD):
  Add arashi.bat to PATH
  Usage: arashi list | fzf

Option 2 - PowerShell:
  Add directory to PATH
  Usage: arashi.ps1 list | fzf
  Or create an alias in your PowerShell profile:
    Set-Alias arashi C:\path\to\arashi.ps1

Option 3 - Direct Binary:
  Use arashi.bin.exe directly
  Note: May not work with fzf due to stdin handling

For fzf compatibility, use the .bat or .ps1 wrappers.
EOF
cd "$DIST_DIR" && zip -r "arashi-${VERSION}-windows-x64.zip" arashi-windows-x64 && cd ..

echo ""
echo "✓ Release packages created in $DIST_DIR/"
ls -lh "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.zip 2>/dev/null || true

echo ""
echo "Installation instructions:"
echo ""
echo "macOS:"
echo "  tar xzf arashi-${VERSION}-macos-arm64.tar.gz"
echo "  cd arashi-macos-arm64"
echo "  sudo cp arashi arashi.bin /usr/local/bin/"
echo ""
echo "Linux:"
echo "  tar xzf arashi-${VERSION}-linux-x64.tar.gz"
echo "  cd arashi-linux-x64"
echo "  sudo cp arashi arashi.bin /usr/local/bin/"
echo ""
echo "Windows:"
echo "  1. Extract arashi-${VERSION}-windows-x64.zip"
echo "  2. Copy contents to a directory in PATH"
echo "  3. Use arashi.bat (CMD) or arashi.ps1 (PowerShell)"

