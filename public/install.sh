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

# ── Detect existing install (upgrade vs fresh) ───────────────────────────────
# Single upgrade path: if /usr/local/bin/wicklee exists, we still download
# the new binary (to ~/.wicklee/bin/) and instruct the user to run
# `sudo /usr/local/bin/wicklee --install-service` — no, wait: they should
# run `sudo ~/.wicklee/bin/wicklee --install-service` so the NEW binary
# self-promotes to the canonical path. The existing /usr/local/bin/wicklee
# would just reinstall its own (old) bits.

EXISTING_SERVICE_ACTIVE=false
EXISTING_BINARY=false
EXISTING_VERSION=""

if [[ -x "$CANONICAL_BIN" ]]; then
  EXISTING_BINARY=true
  EXISTING_VERSION="$("$CANONICAL_BIN" --version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
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
  echo ""
  if [[ "$EXISTING_SERVICE_ACTIVE" == "true" ]]; then
    green "  Existing Wicklee install detected at ${CANONICAL_BIN}${EXISTING_VERSION:+ (${EXISTING_VERSION})}."
    echo "  Service is currently active. Downloading new binary…"
  else
    green "  Existing Wicklee binary detected at ${CANONICAL_BIN}${EXISTING_VERSION:+ (${EXISTING_VERSION})}."
    echo "  No service running. Downloading new binary…"
  fi
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

# Gatekeeper: clear the quarantine xattr on the downloaded binary (macOS).
# User paths are inspected loosely, but once the binary is promoted to
# /usr/local/bin (by `--install-service` or a manual `sudo cp`), Gatekeeper
# enforces strictly and SIGKILLs quarantined binaries on launch
# ("zsh: killed"). macOS file copies carry xattrs along, so clearing it
# here — at the only place the binary enters the system — covers every
# later promotion path. Proper long-term fix is Developer ID signing +
# notarization in the release workflow; until then this keeps upgrades
# from bricking the canonical path.
if [[ "$OS_TAG" == "darwin" ]]; then
  xattr -d com.apple.quarantine "$USER_INSTALL_PATH" 2>/dev/null || true
fi

INSTALLED_VERSION="$("${USER_INSTALL_PATH}" --version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
VERSION_LABEL="${INSTALLED_VERSION:-${RELEASE_TAG}}"

# ── Anonymous install telemetry ───────────────────────────────────────────────
NVIDIA_FLAG="false"
[[ -n "$NVIDIA_SUFFIX" ]] && NVIDIA_FLAG="true"
UPGRADE_FLAG="false"
[[ "$EXISTING_BINARY" == "true" ]] && UPGRADE_FLAG="true"
curl -sf -X POST "https://wicklee.dev/api/telemetry/install" \
  -H "Content-Type: application/json" \
  -d "{\"os\":\"${OS_TAG}\",\"arch\":\"${ARCH_TAG}\",\"version\":\"${VERSION_LABEL}\",\"nvidia\":${NVIDIA_FLAG},\"upgrade\":${UPGRADE_FLAG}}" \
  >/dev/null 2>&1 &

# ── Success ───────────────────────────────────────────────────────────────────

echo ""
green "  ✓ Wicklee agent downloaded successfully — ${VERSION_LABEL}"
dim   "    Location: ${USER_INSTALL_PATH}"
echo ""

if [[ "$EXISTING_BINARY" == "true" ]]; then
  # Upgrade path — existing system-path install. The download above only
  # updated ~/.wicklee/bin; the service unit (and PATH resolution) still
  # point at the old ${CANONICAL_BIN} binary, so an upgrade that stops here
  # looks successful while localhost:7700 keeps serving the old version.
  # When we have a terminal, offer to finish the swap right now; otherwise
  # fall through to printed instructions with an explicit warning.
  UPGRADE_DONE=false
  if [[ "$EXISTING_SERVICE_ACTIVE" == "true" && -r /dev/tty && -w /dev/tty ]]; then
    echo "  The running service still uses the old binary at ${CANONICAL_BIN}${EXISTING_VERSION:+ (${EXISTING_VERSION})}."
    printf '  Finish the upgrade now? Runs: sudo %s --install-service [Y/n] ' "$USER_INSTALL_PATH" > /dev/tty
    REPLY=""
    read -r REPLY < /dev/tty || REPLY=""
    if [[ -z "$REPLY" || "$REPLY" =~ ^[Yy] ]]; then
      echo ""
      # Self-promotes to ${CANONICAL_BIN}, re-registers the service unit, and
      # restarts — same command we'd otherwise tell the user to run by hand.
      if sudo "$USER_INSTALL_PATH" --install-service; then
        NEW_CANONICAL_VERSION="$("$CANONICAL_BIN" --version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
        echo ""
        green "  ✓ Upgrade complete — ${CANONICAL_BIN} is now ${NEW_CANONICAL_VERSION:-$VERSION_LABEL} and the service has restarted."
        UPGRADE_DONE=true
      else
        echo ""
        red "  Upgrade step failed or was cancelled — the service is still running the old binary."
      fi
    fi
  fi
  if [[ "$UPGRADE_DONE" != "true" ]]; then
    echo "  Finish the upgrade (the only sudo step):"
    echo ""
    bold "    sudo ${USER_INSTALL_PATH} --install-service"
    echo ""
    dim   "  Stops the current service, copies the new binary to ${CANONICAL_BIN},"
    dim   "  and restarts. The new ${VERSION_LABEL} binary self-promotes — running the"
    dim   "  existing ${CANONICAL_BIN} directly would just re-install the old version."
    if [[ "$EXISTING_SERVICE_ACTIVE" == "true" ]]; then
      echo ""
      red "  ⚠ Until you run it, the service (and \`wicklee --version\` via PATH)"
      red "    keeps using the OLD${EXISTING_VERSION:+ ${EXISTING_VERSION}} binary at ${CANONICAL_BIN}."
    fi
    echo ""
  fi
else
  # Fresh install — two choices.
  echo "  Next steps:"
  echo ""
  bold "  Try it (foreground, no sudo):"
  echo "    ${USER_INSTALL_PATH}"
  echo ""
  bold "  Recommended (background service, starts on boot):"
  echo "    sudo ${USER_INSTALL_PATH} --install-service"
  if [[ "$OS_TAG" == "darwin" ]]; then
    dim "    Promotes the binary to ${CANONICAL_BIN} and registers the LaunchDaemon."
  else
    dim "    Promotes the binary to ${CANONICAL_BIN} and registers the systemd unit."
  fi
  dim   "    This is the only step that needs sudo."
  echo ""
fi
echo "  Local dashboard:    http://localhost:7700"
echo "  Fleet dashboard:    https://wicklee.dev"
echo ""
