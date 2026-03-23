# Wicklee — Developer Guide

Wicklee is a sovereign GPU fleet monitor for local AI inference. One Rust binary per node, React dashboard at `localhost:7700`, optional fleet aggregation at `wicklee.dev`.

## Repository Structure

```
agent/src/              Rust agent (Tokio/Axum, single binary)
  main.rs               Orchestrator, hardware harvesters, HTTP handlers, broadcaster
  inference.rs          Inference state machine (HardwareSignals, InferenceState)
  harvester.rs          Ollama + vLLM runtime harvesters, probes, attribution logic
  proxy.rs              Transparent Ollama proxy (:11434 -> configurable port)
  cloud_push.rs         Fleet telemetry push (2s cadence, state-change bypass)
  service.rs            Install/uninstall as launchd/systemd/Windows service
  diagnostics.rs        Startup health-check (--status)
  process_discovery.rs  Runtime detection (Ollama, vLLM process scanning)
  store.rs              DuckDB local metrics storage (conditional, not on musl)
src/                    React 19 frontend (Vite, Tailwind, Recharts)
docs/                   Architecture spec, roadmap, security, tier definitions
```

## Agent (Rust)

### Build and Test
```bash
cd agent
cargo check            # fast compilation check
cargo test             # 18 tests (inference state machine + attribution)
cargo build --release  # production binary
```
For updating a running Mac install, use `curl -fsSL https://wicklee.dev/install.sh | bash` — not `cargo build`.

The frontend is embedded via RustEmbed from `agent/frontend/dist/`. Build the frontend first (`npm run build` in `src/`), then copy output to `agent/frontend/dist/` before `cargo build`.

### Inference State Machine (inference.rs)
Four states: `Live`, `IdleSpd`, `Busy`, `Idle`. Evaluated once per broadcast tick (1 Hz) as a pure function from sensor readings.

Tier hierarchy (first match wins):
- **Tier 1 (Exact):** vLLM active request count > 0
- **Tier 2 (Attribution):** `/api/ps` expires_at change attributed to user (not probe) within 15s
- **Tier 3 (Physics):** GPU residency > 20%, SoC power > 8W, ANE power > 0.5W, or NVIDIA power > 40W

### Hardware Ground Truth (do not change these thresholds)
- Probe GPU residency never exceeds ~60% on Apple Silicon
- Saturated GPU override: >= 75% (confirmed on M2 — inference drives to 99%)
- powermetrics sampling window: 5000ms (shorter windows miss inter-token idles)
- `recent_probe` window: 30s (matches probe interval)
- Tier 2 attribution window: 15s

### Wire Format (frozen)
`MetricsPayload` field names are shared with the cloud backend and React frontend. Do not rename any fields. The `inference_state` string values ("live", "idle-spd", "busy", "idle") are frozen.

### Architecture Constraints
- Single broadcast channel is the SSOT — do not split into separate local/cloud channels
- `compute_inference_state()` must remain a pure function (no side effects, no stored state)
- All sensor data flows through `Arc<Mutex<T>>` shared state
- The agent runs as root (LaunchDaemon on macOS, systemd on Linux) for powermetrics access
- Graceful shutdown via SIGTERM/SIGINT — flushes in-flight responses and DuckDB WAL

### Config
- `~/.wicklee/config.toml` — node_id, fleet_url, session_token
- Fleet cloud: `wicklee.dev` (not wicklee.app)
- Agent port: 7700 (default)
- Proxy port: 11434 (intercepts Ollama, forwards to configured backend port)

## Frontend (React)

### Tech Stack
- React 19, Vite, Tailwind CSS (dark mode, `gray-950` background)
- Recharts for telemetry charts, Lucide React for icons
- Inter for UI text, JetBrains Mono for telemetry/logs

### Design Language
"Hardware-Centric Dark" — precise, dense, atmospheric. See `HANDOVER.md` for full design tokens.

### Key Patterns
- WebSocket to `localhost:7700/ws` for real-time metrics
- `inference_state` field from agent is the SSOT — no frontend re-computation
- Local mode (unpaired) vs Fleet mode (paired) — gates AI Key Vault + Team Management
- Graceful fallback: if agent unavailable, show "Disconnected" with setup guide link

## Conventions
- Rust: no `unsafe` except NVML bindings. Minimal dependencies. `pub(crate)` for inter-module visibility.
- Frontend: Tailwind utility classes only (no custom CSS). Strict typing in `types.ts`.
- All metrics are real or explicitly labeled as unavailable — no mock values in production.
