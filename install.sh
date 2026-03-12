#!/usr/bin/env bash
set -euo pipefail

# ── Wicklee Sentinel — one-line installer ─────────────────────────────────────
#
#   curl -fsSL https://wicklee.dev/install.sh | bash
#
# Downloads the pre-built binary for the current OS/arch from GitHub Releases,
# installs it to /usr/local/bin/wicklee, and prints getting-started tips.

REPO="jeffgeiser/Wicklee"
INSTALL_DIR="/usr/local/bin"
BIN_NAME="wicklee"

# ── Helpers ───────────────────────────────────────────────────────────────────

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }

die() { red "error: $*" >&2; exit 1; }

need() {
  command -v "$1" &>/dev/null || die "'$1' is required but not installed."
}

# ── Platform detection ────────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  OS_TAG="linux"  ;;
  Darwin) OS_TAG="darwin" ;;
  *)      die "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64)          ARCH_TAG="x86_64"  ;;
  arm64 | aarch64) ARCH_TAG="aarch64" ;;
  *)               die "Unsupported architecture: $ARCH" ;;
esac

ASSET_NAME="wicklee-agent-${OS_TAG}-${ARCH_TAG}"

# ── Fetch latest release tag ──────────────────────────────────────────────────

need curl

echo ""
echo "  Fetching latest Wicklee release…"

LATEST_TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' \
  | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"

[[ -n "$LATEST_TAG" ]] || die "Could not determine latest release tag."

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ASSET_NAME}"

# ── Download ──────────────────────────────────────────────────────────────────

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "  Downloading ${ASSET_NAME} (${LATEST_TAG})…"
curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$TMP" \
  || die "Download failed. Check https://github.com/${REPO}/releases for available assets."

chmod +x "$TMP"

# ── Install ───────────────────────────────────────────────────────────────────

INSTALL_PATH="${INSTALL_DIR}/${BIN_NAME}"

if [[ -w "$INSTALL_DIR" ]]; then
  cp "$TMP" "$INSTALL_PATH"
else
  echo "  Installing to ${INSTALL_PATH} (sudo required)…"
  sudo cp "$TMP" "$INSTALL_PATH"
fi

# ── Success ───────────────────────────────────────────────────────────────────

echo ""
green "  ✓ wicklee installed successfully."
echo ""
echo "     Run:        wicklee"
echo "     Dashboard:  http://localhost:7700"
echo ""

if [[ "$(uname)" == "Darwin" ]]; then
  echo "  💡 macOS tip: run \`sudo wicklee\` to unlock CPU power draw metrics."
  dim "     All other metrics (GPU, memory pressure, thermal) work without sudo."
  echo ""
fi

echo "  Run as a background service (auto-starts on boot):"
if [[ "$(uname)" == "Darwin" ]]; then
  dim "     sudo wicklee --install-service   # launchd · /Library/LaunchDaemons/"
else
  dim "     sudo wicklee --install-service   # systemd · /etc/systemd/system/"
fi
dim "     sudo wicklee --uninstall-service  # remove the service"
echo ""
