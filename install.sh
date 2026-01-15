#!/bin/bash
set -e

# aide installation script
# Usage: curl -fsSL https://raw.githubusercontent.com/rlcurrall/aide/main/install.sh | bash

REPO="rlcurrall/aide"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)
    BINARY_NAME="aide-linux"
    ;;
  Darwin*)
    BINARY_NAME="aide-mac"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    BINARY_NAME="aide.exe"
    ;;
  *)
    echo "Unsupported operating system: $OS"
    exit 1
    ;;
esac

echo "Installing aide for $OS..."

# Create install directory if it doesn't exist
mkdir -p "$INSTALL_DIR"

# Download the latest release
DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/$BINARY_NAME"
echo "Downloading from $DOWNLOAD_URL"

# Determine output filename (keep .exe on Windows)
if [[ "$OS" == MINGW* || "$OS" == MSYS* || "$OS" == CYGWIN* ]]; then
  OUTPUT_FILE="$INSTALL_DIR/aide.exe"
else
  OUTPUT_FILE="$INSTALL_DIR/aide"
fi

if command -v curl &> /dev/null; then
  curl -fsSL "$DOWNLOAD_URL" -o "$OUTPUT_FILE"
elif command -v wget &> /dev/null; then
  wget -q "$DOWNLOAD_URL" -O "$OUTPUT_FILE"
else
  echo "Error: curl or wget is required"
  exit 1
fi

# Make executable (not needed on Windows)
if [[ "$OS" != MINGW* && "$OS" != MSYS* && "$OS" != CYGWIN* ]]; then
  chmod +x "$OUTPUT_FILE"
fi

echo "aide installed to $OUTPUT_FILE"

# Check if install directory is in PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo ""
  echo "Warning: $INSTALL_DIR is not in your PATH"
  echo "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo ""
  echo "  export PATH=\"\$PATH:$INSTALL_DIR\""
  echo ""
fi

# Verify installation
if command -v aide &> /dev/null; then
  echo "aide is ready to use!"
  aide --version
elif [[ -x "$OUTPUT_FILE" ]] || [[ -f "$OUTPUT_FILE" ]]; then
  echo "Installation complete. You may need to restart your shell or add $INSTALL_DIR to your PATH."
else
  echo "Installation complete. You may need to add $INSTALL_DIR to your PATH."
fi
