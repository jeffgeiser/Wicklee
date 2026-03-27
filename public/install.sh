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

# ── Preserve Linux capabilities ──────────────────────────────────────────────
# The install replaces the binary, which strips filesystem capabilities.
# If the old binary had cap_sys_ptrace (for cross-user runtime discovery),
# remember it so we can re-apply after the copy.
HAD_PTRACE_CAP=false
if [[ "$OS_TAG" == "linux" ]] && command -v getcap &>/dev/null; then
  if [[ -f "${INSTALL_DIR}/${BIN_NAME}" ]]; then
    if getcap "${INSTALL_DIR}/${BIN_NAME}" 2>/dev/null | grep -q cap_sys_ptrace; then
      HAD_PTRACE_CAP=true
    fi
  fi
fi

# ── Ghost-Kill preflight ─────────────────────────────────────────────────────
# Stop any running wicklee instance before swapping the binary.
# Prevents "port 7700 already in use" when the new binary first starts.
# We attempt a clean service stop first; pkill is the belt-and-suspenders fallback.

GHOST_KILLED=false

if [[ "$OS_TAG" == "darwin" ]]; then
  # Migrate old user-level LaunchAgent (pre-v0.5.3 installs).
  # Runs as the real user (before sudo), so $HOME and id -u are correct.
  OLD_AGENT_PLIST="$HOME/Library/LaunchAgents/dev.wicklee.agent.plist"
  if [[ -f "$OLD_AGENT_PLIST" ]]; then
    echo "  Migrating from user LaunchAgent to system LaunchDaemon…"
    launchctl bootout "gui/$(id -u)/dev.wicklee.agent" 2>/dev/null || true
    sleep 0.5
    rm -f "$OLD_AGENT_PLIST"
    dim "  Old LaunchAgent removed — full SoC/ANE power will be available after install."
  fi

  if [[ -f "/Library/LaunchDaemons/dev.wicklee.agent.plist" ]]; then
    sudo launchctl bootout system/dev.wicklee.agent 2>/dev/null && GHOST_KILLED=true || true
    # launchd label deregistration is async — poll until the label is actually
    # gone instead of a fixed sleep. Prevents exit status 5 race in --install-service.
    for i in $(seq 1 20); do
      launchctl list dev.wicklee.agent &>/dev/null || break
      sleep 0.5
    done
  fi
  # Also kill any manual `sudo wicklee` process not managed by launchd.
  sudo pkill -x wicklee 2>/dev/null && GHOST_KILLED=true || true

elif [[ "$OS_TAG" == "linux" ]]; then
  if command -v systemctl &>/dev/null && systemctl is-active --quiet wicklee 2>/dev/null; then
    sudo systemctl stop wicklee && GHOST_KILLED=true
  fi
  sudo pkill -x wicklee-agent 2>/dev/null && GHOST_KILLED=true || true
  sudo pkill -x wicklee       2>/dev/null && GHOST_KILLED=true || true
fi

[[ "$GHOST_KILLED" == "true" ]] && dim "  Stopped previous Wicklee instance."

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

# ── Re-apply Linux capabilities ──────────────────────────────────────────────
if [[ "$HAD_PTRACE_CAP" == "true" ]]; then
  sudo setcap cap_sys_ptrace+ep "$INSTALL_PATH" 2>/dev/null \
    && dim "  Restored cap_sys_ptrace (cross-user runtime discovery)." \
    || dim "  Warning: could not restore cap_sys_ptrace — run: sudo setcap cap_sys_ptrace+ep $INSTALL_PATH"
fi

# ── Service update ────────────────────────────────────────────────────────────
# If a service is already registered, re-run --install-service so the unit
# file stays current and the service is restarted with the new binary.

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

# Read the actual version from the installed binary (e.g. "wicklee-agent v0.4.36").
INSTALLED_VERSION="$("${INSTALL_PATH}" --version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
VERSION_LABEL="${INSTALLED_VERSION:-${RELEASE_TAG}}"

echo ""
green "  ✓ Wicklee agent installed successfully  —  ${VERSION_LABEL}"
echo ""

if [[ "$SERVICE_UPDATED" == "true" ]]; then
  # Verify the service is actually running before claiming success.
  sleep 2
  if curl -sf http://localhost:7700/api/pair/status &>/dev/null; then
    dim "  Service updated and restarted automatically."
  else
    dim "  Service updated. If the dashboard is unreachable, run:"
    if [[ "$OS_TAG" == "darwin" ]]; then
      bold "    sudo wicklee --install-service"
    else
      bold "    sudo systemctl restart wicklee"
    fi
  fi
  echo ""
else
  echo "  Start monitoring your node:"
  echo ""
  bold "  Recommended — runs on every boot:"
  bold "    sudo wicklee --install-service"
  echo ""
  echo "  To upgrade later, just run this script again — it stops the old"
  echo "  instance automatically before swapping in the new binary."
fi

echo ""
echo "  Your dashboard:     http://localhost:7700"
echo "  Pair with your fleet: https://wicklee.dev"
echo ""
