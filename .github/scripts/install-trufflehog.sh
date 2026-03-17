#!/usr/bin/env bash
# Install TruffleHog binary into this repo's .github/tools/ directory.
# Run from repo root: .github/scripts/install-trufflehog.sh
#
# Usage:
#   ./.github/scripts/install-trufflehog.sh              # install latest
#   TRUFFLEHOG_VERSION=v3.93.7 ./.github/scripts/install-trufflehog.sh  # pin version

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS_DIR="${REPO_ROOT}/.github/tools"
BIN_NAME="trufflehog"
INSTALL_DIR="${TOOLS_DIR}/bin"
INSTALL_PATH="${INSTALL_DIR}/${BIN_NAME}"

# Resolve version (default: latest from GitHub API)
if [ -n "$TRUFFLEHOG_VERSION" ]; then
  VERSION="${TRUFFLEHOG_VERSION#v}"  # strip leading v if present
else
  VERSION=$(curl -sSfL "https://api.github.com/repos/trufflesecurity/trufflehog/releases/latest" | grep -E '"tag_name":\s*"v[0-9]' | sed -E 's/.*"v([^"]+)".*/\1/')
fi

# Map OS and arch to release asset name
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac
case "$OS" in
  darwin) OS="darwin" ;;
  linux)  OS="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

ASSET="trufflehog_${VERSION}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/trufflesecurity/trufflehog/releases/download/v${VERSION}/${ASSET}"

mkdir -p "$INSTALL_DIR"
echo "Installing TruffleHog v${VERSION} (${OS}/${ARCH}) to ${INSTALL_DIR} ..."
curl -sSfL "$URL" -o "${TOOLS_DIR}/${ASSET}"
tar -xzf "${TOOLS_DIR}/${ASSET}" -C "$INSTALL_DIR" "$BIN_NAME"
rm -f "${TOOLS_DIR}/${ASSET}"
chmod +x "$INSTALL_PATH"
echo "Installed: $INSTALL_PATH"
"$INSTALL_PATH" --version
