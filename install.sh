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

# ── NVIDIA GPU detection (Linux only) ────────────────────────────────────────
# If nvidia-smi is available the node has an NVIDIA GPU.  The glibc+NVML build
# unlocks VRAM metrics, GPU utilisation, GPU temperature, and power draw —
# metrics that the static musl build cannot provide.
# Supported: linux-x86_64-nvidia, linux-aarch64-nvidia (NVIDIA Grace Blackwell).
if [[ "$OS_TAG" == "linux" ]] && command -v nvidia-smi &>/dev/null; then
  ASSET_NAME="${ASSET_NAME}-nvidia"
  dim "  NVIDIA GPU detected — selecting GPU-enabled build"
fi

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

# ── Ghost-Kill preflight ─────────────────────────────────────────────────────
# Stop any running wicklee instance before swapping the binary.
# Prevents "port 7700 already in use" when the new binary first starts.
# We attempt a clean service stop first; pkill is the belt-and-suspenders fallback.

if [[ "$OS_TAG" == "darwin" ]]; then
  if [[ -f "/Library/LaunchDaemons/dev.wicklee.agent.plist" ]]; then
    sudo launchctl bootout system/dev.wicklee.agent 2>/dev/null || true
    sleep 1
  fi
  # Also kill any manual `sudo wicklee` process not managed by launchd.
  sudo pkill -x wicklee 2>/dev/null || true

elif [[ "$OS_TAG" == "linux" ]]; then
  if command -v systemctl &>/dev/null && systemctl is-active --quiet wicklee 2>/dev/null; then
    sudo systemctl stop wicklee
  fi
  sudo pkill -x wicklee-agent 2>/dev/null || true
  sudo pkill -x wicklee       2>/dev/null || true
fi

# ── Install ───────────────────────────────────────────────────────────────────
# Use cp+mv rather than cp-in-place so an existing running wicklee service
# (Text file busy) doesn't block the update.  mv replaces the directory entry
# atomically; the old inode/process keeps running until systemd restarts it.

INSTALL_PATH="${INSTALL_DIR}/${BIN_NAME}"
INSTALL_TMP="${INSTALL_PATH}.new"

if [[ -w "$INSTALL_DIR" ]]; then
  cp "$TMP" "$INSTALL_TMP" && mv "$INSTALL_TMP" "$INSTALL_PATH"
else
  echo "  Installing to ${INSTALL_PATH} (sudo required)…"
  sudo cp "$TMP" "$INSTALL_TMP" && sudo mv "$INSTALL_TMP" "$INSTALL_PATH"
fi

# ── Service update ────────────────────────────────────────────────────────────
# If a service is already registered, re-run --install-service so the unit
# file stays current and binary ownership transfers to the service user
# (enabling future self-updates without sudo). Restart is handled internally.

SERVICE_UPDATED=false

if [[ "$OS_TAG" == "linux" ]] && command -v systemctl &>/dev/null; then
  if systemctl list-unit-files wicklee.service &>/dev/null 2>&1; then
    echo "  Updating systemd service…"
    sudo "${INSTALL_PATH}" --install-service
    SERVICE_UPDATED=true
  fi
elif [[ "$OS_TAG" == "darwin" ]]; then
  if [[ -f "/Library/LaunchDaemons/dev.wicklee.agent.plist" ]]; then
    echo "  Updating launchd service…"
    sudo "${INSTALL_PATH}" --install-service
    SERVICE_UPDATED=true
  fi
fi

# ── Success ───────────────────────────────────────────────────────────────────

echo ""
green "  ✓ Wicklee agent installed successfully (${LATEST_TAG})"
echo ""

if [[ "$SERVICE_UPDATED" == "true" ]]; then
  dim "     Service updated and restarted automatically."
else
  echo "  Start monitoring your node:"
  echo ""
  bold "  Recommended — runs on every boot:"
  bold "    sudo wicklee --install-service"
  echo ""
  echo "  Or run manually:"
  bold "    sudo wicklee"
fi

echo ""
echo "  Your dashboard:     http://localhost:7700"
echo "  Pair with your fleet: https://wicklee.dev"
echo ""
