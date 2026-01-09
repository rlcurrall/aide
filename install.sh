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

if command -v curl &> /dev/null; then
  curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/aide"
elif command -v wget &> /dev/null; then
  wget -q "$DOWNLOAD_URL" -O "$INSTALL_DIR/aide"
else
  echo "Error: curl or wget is required"
  exit 1
fi

# Make executable (not needed on Windows)
if [[ "$OS" != MINGW* && "$OS" != MSYS* && "$OS" != CYGWIN* ]]; then
  chmod +x "$INSTALL_DIR/aide"
fi

echo "✓ aide installed to $INSTALL_DIR/aide"

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
  echo "✓ aide is ready to use!"
  aide --version
else
  echo "Installation complete. You may need to add $INSTALL_DIR to your PATH."
fi
