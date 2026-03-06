# Wicklee Technical Handover Specification
## Project: Transition to Production-Ready Monorepo
**Role:** Lead Architect
**Status:** Draft / Handover Ready

---

## 1. Refined Design Tokens (High-Tech Dark Aesthetic)

The "Wicklee" aesthetic is defined as **Hardware-Centric Dark**. It should feel like a physical instrument—precise, dense, and atmospheric.

### 1.1 Color Palette (Tailwind CSS)
| Token | Value | Usage |
| :--- | :--- | :--- |
| `bg-base` | `#030712` (Zinc-950) | Main application background |
| `bg-surface` | `#09090b` (Zinc-900) | Card backgrounds, sidebars |
| `ink-primary` | `#f9fafb` (Zinc-50) | Primary text, titles |
| `ink-secondary` | `#71717a` (Zinc-400) | Labels, micro-copy, inactive states |
| `accent-primary` | `#10b981` (Emerald-500) | Online status, success, primary actions |
| `accent-secondary` | `#6366f1` (Indigo-500) | AI features, telemetry highlights |
| `border-subtle` | `rgba(255, 255, 255, 0.05)` | Component borders |

### 1.2 Typography
- **Primary UI:** `Inter` (Variable). Tracking: `-0.01em` for body, `-0.02em` for headings.
- **Data & Telemetry:** `JetBrains Mono`. Used for IP addresses, GPU metrics, and logs to ensure tabular alignment.

### 1.3 Glow & Atmospheric Effects
- **Glow Indigo:** `shadow-[0_0_15px_-3px_rgba(99,102,241,0.3)]`
- **Glow Emerald:** `shadow-[0_0_15px_-3px_rgba(16,185,129,0.3)]`
- **Glass Morph:** `backdrop-blur-md bg-zinc-900/80 border border-white/5`

---

## 2. API & WebSocket Contract

### 2.1 WebSocket: Real-Time Telemetry (`/ws/telemetry`)
Nodes broadcast heartbeats every 1000ms.

**JSON Schema:**
```json
{
  "type": "NODE_HEARTBEAT",
  "payload": {
    "node_id": "uuid",
    "metrics": {
      "gpu_temp": 68.5,
      "vram_used_gb": 12.4,
      "vram_total_gb": 24.0,
      "power_watts": 245,
      "rps": 4.2
    },
    "active_interceptors": ["pii-redactor", "audit-log"],
    "timestamp": "2026-02-24T14:57:06Z"
  }
}
```

### 2.2 REST: Node Registration (`POST /api/v1/nodes/register`)
Used by new agents to join the fleet. Requires mTLS certificate verification.

**Request Body:**
```json
{
  "hostname": "wicklee-worker-03",
  "ip_address": "10.0.0.45",
  "capabilities": {
    "compute_cap": "8.6",
    "total_vram": 81920
  }
}
```

---

## 3. Rust Backend Blueprint (Axum + DuckDB)

The orchestrator is transitioning to a Rust-based core for memory safety and high-throughput telemetry processing.

### 3.1 Architecture Overview
- **Framework:** `Axum` for the web layer.
- **State Management:** `Arc<AppState>` containing the DuckDB connection pool and WebSocket broadcaster.
- **Storage:** `DuckDB` for local, high-performance OLAP queries on telemetry data (traces, metrics).

### 3.2 Backend Structure
```text
/backend
  /src
    /api        # Axum route handlers
    /db         # DuckDB integration (duckdb-rs)
    /intercept  # WASM runtime management (Wasmtime)
    /models     # Shared Rust structs (serde)
    /security   # mTLS and JWT logic
    main.rs     # Entry point
```

### 3.3 mTLS Handshake Requirements
- All nodes MUST present a client certificate signed by the Wicklee Internal CA.
- Orchestrator validates the `Common Name (CN)` against the registered `node_id`.

---

## 4. UI Component Catalog

### 4.1 Atomic & Layout Components
- `Sidebar`: Navigation and User/Tenant switcher.
- `Header`: Breadcrumbs, Tenant selector, and Global Status.
- `MetricCard`: Reusable telemetry display with sparkline integration.
- `StatusBadge`: Animated indicator for Online/Offline/Degraded states.

### 4.2 Feature Views
- `Overview`: Fleet-wide aggregate metrics.
- `NodesList`: Detailed grid of active worker agents.
- `TracesView`: Log stream and request latency analysis.
- `AIInsights`: Gemini-powered diagnostic panel.
- `TeamManagement`: RBAC and member invitation flow.

### 4.3 Planned Additions
- **WASM Binary Uploader:** A drag-and-drop interface for deploying new request interceptors to the fleet.
- **Thermal Map:** A 2D grid visualization of the server rack temperatures.

---

## 5. Success Criteria for Production-Ready State

1.  **Zero-Latency UI:** WebSocket updates must reflect on the dashboard in <100ms from receipt.
2.  **Secure Tenant Isolation:** No data leakage between `tenant_id` scopes at the database or WebSocket layer.
3.  **Resilient Connectivity:** Automatic exponential backoff and state reconciliation for disconnected nodes.
4.  **Auditability:** 100% of request traces stored in DuckDB with a 30-day retention policy.
5.  **Thermal Safety:** Automated load shedding triggers when any node exceeds 85°C.

---

## 6. Implementation Progress Log

### Phase 1 — Agent (Complete)
- Rust agent (`agent/`) embeds the React dashboard and serves it from `localhost:7700`.
- 10 Hz WebSocket broadcast of `MetricsPayload` (CPU, RAM, Apple Silicon deep-metal, NVIDIA GPU via NVML).
- Fleet pairing UX: `--pair` flag generates a 6-digit code; `/api/pair/claim` transitions node to `Connected`.
- Config persistence at `~/.wicklee/config.toml` (node identity + fleet URL).

### Phase 2 — Cloud Handshake Backend (Complete)
**Location:** `cloud/` (standalone Rust crate, separate Railway service)

**Endpoints implemented:**

| Method | Path | Description |
| :----- | :--- | :---------- |
| `POST` | `/api/pair/claim` | Accepts 6-digit code + fleet URL + WK-XXXX node ID; registers node, returns session token |
| `POST` | `/api/telemetry` | Accepts `MetricsPayload` from a paired agent; stores latest snapshot per node in memory |
| `GET`  | `/api/fleet` | Returns all registered nodes with their latest metrics — feeds the Fleet Overview dashboard |

**Design decisions:**
- State: `Arc<RwLock<HashMap<String, NodeEntry>>>` — in-memory for Phase 2; DuckDB swap-in planned for Phase 3.
- No auth gate yet: node identity (`WK-XXXX`) is the pairing key per spec.
- CORS locked to `https://wicklee.com` and `https://wicklee.dev`.
- Reads `PORT` env var (Railway injects this at runtime); defaults to `8080` for local dev.
- Telemetry from unregistered nodes is silently dropped — no info leak.

**Deployment:**
- `cloud/Dockerfile` — multi-stage build (`rust:1.85-slim` → `debian:bookworm-slim`), produces ~10 MB image.
- `cloud/railway.toml` — points Railway at the Dockerfile; health check on `GET /api/fleet`.
- Deploy as a separate Railway service, root directory set to `cloud/`.

### Phase 3 — Planned
- Swap in-memory fleet map for DuckDB persistence (`duckdb-rs`).
- Add session-token validation on `POST /api/telemetry`.
- WebSocket push from cloud to dashboard (replace dashboard polling of `/api/fleet`).
- mTLS client-certificate verification for agent→cloud channel.
