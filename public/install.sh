#!/usr/bin/env bash

# Guard: must run under bash (not dash/sh, which is the default on Debian/Ubuntu).
# When piped via `curl | sh`, $0 is "/usr/bin/sh" (the interpreter), not a script
# file — so `exec bash "$0"` would try to execute the sh binary, producing
# "cannot execute binary file". Instead, re-download and pipe into bash.
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    if [ -f "$0" ] && [ "$0" != "/usr/bin/sh" ] && [ "$0" != "/bin/sh" ]; then
      exec bash "$0" "$@"
    else
      # Piped invocation (curl | sh) — re-fetch and pipe into bash
      exec bash -c "$(curl -fsSL https://wicklee.dev/install.sh)" bash "$@"
    fi
  else
    echo "Wicklee installer requires bash. Please install bash and retry."
    exit 1
  fi
fi

set -euo pipefail

# ── Wicklee — one-line installer (v0.8.0+) ────────────────────────────────────
#
#   curl -fsSL https://wicklee.dev/install.sh | bash
#
# No sudo. Downloads the latest binary to ~/.wicklee/bin/wicklee and prints
# next-step instructions. To run as a system service (LaunchDaemon / systemd),
# the user runs `sudo wicklee --install-service` — that is the only sudo step,
# and it self-copies the binary to /usr/local/bin/wicklee for the service unit.

REPO="jeffgeiser/Wicklee"
RELEASE_TAG="nightly"       # GitHub release tag used in the download URL
DISPLAY_CHANNEL="latest"    # Human-friendly label shown in install output
BIN_NAME="wicklee"

USER_INSTALL_DIR="${HOME}/.wicklee/bin"
USER_INSTALL_PATH="${USER_INSTALL_DIR}/${BIN_NAME}"
CANONICAL_BIN="/usr/local/bin/${BIN_NAME}"

# ── Helpers ───────────────────────────────────────────────────────────────────

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }

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

# ── Detect existing install ──────────────────────────────────────────────────
# Single upgrade path: if /usr/local/bin/wicklee exists, point to
# `sudo wicklee --install-service` regardless of whether the service is
# currently active. That command stops the running service (if any),
# self-copies the new binary to the canonical path, and restarts.

EXISTING_SERVICE_ACTIVE=false
EXISTING_BINARY=false

if [[ -x "$CANONICAL_BIN" ]]; then
  EXISTING_BINARY=true
  if [[ "$OS_TAG" == "linux" ]] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet wicklee 2>/dev/null; then
      EXISTING_SERVICE_ACTIVE=true
    fi
  elif [[ "$OS_TAG" == "darwin" ]]; then
    if [[ -f "/Library/LaunchDaemons/dev.wicklee.agent.plist" ]]; then
      if launchctl print system/dev.wicklee.agent >/dev/null 2>&1; then
        EXISTING_SERVICE_ACTIVE=true
      fi
    fi
  fi
fi

if [[ "$EXISTING_BINARY" == "true" ]]; then
  EXISTING_VERSION="$("$CANONICAL_BIN" --version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  echo ""
  if [[ "$EXISTING_SERVICE_ACTIVE" == "true" ]]; then
    green "  Existing Wicklee install detected at ${CANONICAL_BIN}${EXISTING_VERSION:+ (${EXISTING_VERSION})}."
    echo "  Service is currently active."
  else
    green "  Existing Wicklee binary detected at ${CANONICAL_BIN}${EXISTING_VERSION:+ (${EXISTING_VERSION})}."
    dim   "  (No service is currently running.)"
  fi
  echo ""
  echo "  To upgrade in place, run:"
  echo ""
  bold "    sudo ${CANONICAL_BIN} --install-service"
  echo ""
  dim "  That command stops the service, swaps in the new binary, and restarts."
  dim "  It is the only step that needs sudo."
  echo ""

  # Fire-and-forget telemetry — flag this as an upgrade attempt.
  curl -sf -X POST "https://wicklee.dev/api/telemetry/install" \
    -H "Content-Type: application/json" \
    -d "{\"os\":\"${OS_TAG}\",\"arch\":\"${ARCH_TAG}\",\"version\":\"${EXISTING_VERSION:-unknown}\",\"nvidia\":false,\"upgrade\":true,\"stage\":\"detect-existing\"}" \
    >/dev/null 2>&1 &

  exit 0
fi

# ── NVIDIA detection (Linux) ─────────────────────────────────────────────────
# Prefer the glibc+NVML build when an NVIDIA GPU is present. The nvidia
# variant dlopen-s libnvidia-ml.so at runtime (ships with NVIDIA drivers) —
# no CUDA toolkit required. Falls back to the fully-static musl build
# otherwise. Supported arches: x86_64-nvidia, aarch64-nvidia.
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
echo "  Downloading Wicklee (${DISPLAY_CHANNEL} · ${OS_TAG}-${ARCH_TAG}${NVIDIA_SUFFIX})…"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$TMP" \
  || die "Download failed. Check https://github.com/${REPO}/releases for available assets."

chmod +x "$TMP"

# ── Install to ~/.wicklee/bin (no sudo) ──────────────────────────────────────

mkdir -p "$USER_INSTALL_DIR"
mv "$TMP" "$USER_INSTALL_PATH"
chmod 755 "$USER_INSTALL_PATH"
trap - EXIT

INSTALLED_VERSION="$("${USER_INSTALL_PATH}" --version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
VERSION_LABEL="${INSTALLED_VERSION:-${RELEASE_TAG}}"

# ── Anonymous install telemetry ───────────────────────────────────────────────
NVIDIA_FLAG="false"
[[ -n "$NVIDIA_SUFFIX" ]] && NVIDIA_FLAG="true"
curl -sf -X POST "https://wicklee.dev/api/telemetry/install" \
  -H "Content-Type: application/json" \
  -d "{\"os\":\"${OS_TAG}\",\"arch\":\"${ARCH_TAG}\",\"version\":\"${VERSION_LABEL}\",\"nvidia\":${NVIDIA_FLAG},\"upgrade\":false}" \
  >/dev/null 2>&1 &

# ── Success ───────────────────────────────────────────────────────────────────

echo ""
green "  ✓ Wicklee agent installed successfully — ${VERSION_LABEL}"
dim   "    Location: ${USER_INSTALL_PATH}"
echo ""
echo "  Next steps:"
echo ""
bold "  Try it (foreground, no sudo):"
echo "    ${USER_INSTALL_PATH}"
echo ""
bold "  Recommended (background service, starts on boot):"
echo "    sudo ${USER_INSTALL_PATH} --install-service"
dim   "    Promotes the binary to ${CANONICAL_BIN} and registers"
if [[ "$OS_TAG" == "darwin" ]]; then
  dim "    the LaunchDaemon. This is the only step that needs sudo."
else
  dim "    the systemd unit. This is the only step that needs sudo."
fi
echo ""
echo "  Local dashboard:    http://localhost:7700"
echo "  Fleet dashboard:    https://wicklee.dev"
echo ""
