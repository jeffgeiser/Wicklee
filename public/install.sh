#!/usr/bin/env bash

# Guard: must run under bash (not dash/sh, which is the default on Debian/Ubuntu)
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  else
    echo "Wicklee installer requires bash. Please install bash and retry."
    exit 1
  fi
fi

set -euo pipefail

# ── Wicklee Sentinel — one-line installer ─────────────────────────────────────
#
#   curl -fsSL https://wicklee.dev/install.sh | bash
#
# Downloads the latest binary for the current OS/arch from GitHub Releases,
# installs it to /usr/local/bin/wicklee, and prints getting-started tips.

REPO="jeffgeiser/Wicklee"
RELEASE_TAG="nightly"
INSTALL_DIR="/usr/local/bin"
BIN_NAME="wicklee"

# ── Helpers ───────────────────────────────────────────────────────────────────

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n'  "$*"; }

die()  { red "error: $*" >&2; exit 1; }
need() { command -v "$1" &>/dev/null || die "'$1' is required but not installed."; }

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

# On Linux, prefer the glibc+NVML build when an NVIDIA GPU is present.
# The nvidia variant dlopen-s libnvidia-ml.so at runtime (ships with NVIDIA
# drivers) — no CUDA toolkit required on the target machine. Falls back to
# the fully-static musl build if no GPU is detected.
# Supported arches: x86_64-nvidia, aarch64-nvidia (NVIDIA Grace Blackwell / DGX Spark).
NVIDIA_SUFFIX=""
if [[ "$OS_TAG" == "linux" ]]; then
  if command -v nvidia-smi >/dev/null 2>&1 || [[ -c /dev/nvidia0 ]]; then
    NVIDIA_SUFFIX="-nvidia"
    echo "  NVIDIA GPU detected — downloading GPU-enabled build…"
    dim "     (VRAM, GPU utilisation, GPU temp, and power draw will be active)"
  fi
fi

ASSET_NAME="wicklee-agent-${OS_TAG}-${ARCH_TAG}${NVIDIA_SUFFIX}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ASSET_NAME}"

# ── Download ──────────────────────────────────────────────────────────────────

need curl

echo ""
echo "  Downloading Wicklee (${RELEASE_TAG} · ${OS_TAG}-${ARCH_TAG}${NVIDIA_SUFFIX})…"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$TMP" \
  || die "Download failed. Check https://github.com/${REPO}/releases for available assets."

chmod +x "$TMP"

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

# ── Success ───────────────────────────────────────────────────────────────────

echo ""
green "  ✓ wicklee installed successfully."
echo ""
echo "     Run:        wicklee"
echo "     Dashboard:  http://localhost:7700"
echo ""

if [[ "$OS" == "Darwin" ]]; then
  echo "  💡 macOS tip: run \`sudo wicklee\` to unlock CPU power draw metrics."
  dim "     All other metrics (GPU, memory pressure, thermal) work without sudo."
  echo ""
fi
