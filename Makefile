# ── Wicklee Sentinel — Build & Install ────────────────────────────────────────
#
# Usage:
#   make          → build frontend + Rust agent (release)
#   make install  → build + copy binary to /usr/local/bin/wicklee
#   make clean    → remove build artefacts

CARGO       := $(shell command -v cargo 2>/dev/null || echo $(HOME)/.cargo/bin/cargo)
BINARY      := agent/target/release/wicklee-agent
INSTALL_BIN := /usr/local/bin/wicklee

.PHONY: build install clean

## build — compile Vite frontend then embed it into the Rust release binary
build:
	@echo "⟳  Building frontend..."
	npm run build
	@echo "⟳  Building Rust agent (release)..."
	cd agent && $(CARGO) build --release
	@echo "✓  Build complete  →  $(BINARY)"

## install — build then copy to /usr/local/bin so 'wicklee' works globally
install: build
	@echo "⟳  Installing to $(INSTALL_BIN) (may prompt for sudo password)..."
	sudo cp $(BINARY) $(INSTALL_BIN)
	@echo ""
	@echo "✓  wicklee installed."
	@echo "   Run:        wicklee"
	@echo "   Dashboard:  http://localhost:7700"

## clean — remove build artefacts (frontend dist + Rust target dir)
clean:
	rm -rf agent/target agent/frontend/dist
