# Wicklee — Progress Journal

*A running log of what shipped, what was learned, and what's next. Most recent entry first.*

---

## March 12, 2026 — Rolling Smoothing, Nav Polish, Cloud Version Endpoint 🔧

**The Goal:** Eliminate metric jitter in the dashboard display, fix nav visual regressions after the rail refactor, and ship a version endpoint to the cloud backend.

---

### Rolling-Average Display Smoothing ✅ (Shipped)

Display-layer 5-sample rolling average applied to fast-moving metrics — no SSE or agent changes.

**New hook: `src/hooks/useRollingMetrics.ts`:**
- `useRollingBuffer(window=5)` — generic hook backed by `useRef<{buf, lastTs}>`. Deduplicates same-timestamp pushes (React strict-mode safe). Null/NaN values skip the buffer without clearing it.
- `useNodeRollingMetrics()` — per-node hook with three keyed slots (`tps`, `watts`, `gpu`). `resetAll()` fires synchronously when a node goes offline.

**Smoothed metrics in `Overview.tsx`:**
- Fleet: tok/s (Tile 1), Avg WES (Tile 5), W/1K (Tile 6), Cost/1K (Tile 7)
- Per-node: tok/s (Ollama + vLLM combined), total power draw (Watts column), GPU% column
- Fleet dedup key: `Math.max(...effectiveMetrics.map(m => m.timestamp_ms))`
- Per-node buffers reset on node offline transition

---

### Nav & Header Visual Polish ✅ (Shipped)

Five targeted fixes after the collapsible-rail refactor introduced visual regressions:

- **Logo size**: Restored to `text-xl` (was `text-base` — too small post-refactor)
- **Icon vertical position**: `pt-16` on the nav container clears the 64px sticky header zone; icons now start below the header, not overlapping it
- **Nav icon horizontal centering**: `px-6` on nav buttons — icon center lands at exactly 32px = half the 64px rail width
- **Profile avatar centering**: `justify-center group-hover/nav:justify-start` on the button + `max-w-0 overflow-hidden group-hover/nav:max-w-full` on name span — avatar is perfectly centered in collapsed state
- **Icon size normalization**: `UserIcon` at `w-4 h-4` to match nav icons

---

### Cloud Version Endpoint ✅ (Shipped)

`GET /api/agent/version` on the cloud backend — returns `{"version": env!("CARGO_PKG_VERSION")}`. Enables future update-check flows from the hosted dashboard.

---

## March 12, 2026 — Rationalizing the Sovereign Cockpit ⚡

**The Goal:** Ship vLLM runtime detection. Formally document the Cockpit vs. Mission Control identity split. Eliminate the Credibility Gap on local installs.

---

### vLLM Integration ✅ (Shipped v0.4.5)

Full-stack vLLM runtime detection and metrics harvesting across agent → cloud → frontend:

**Agent (`agent/src/main.rs`):**
- `VllmMetrics` struct + 5 fields in `MetricsPayload` (`vllm_running`, `vllm_model_name`, `vllm_tokens_per_sec`, `vllm_cache_usage_perc`, `vllm_requests_running`)
- `harvest_vllm()` — GET `localhost:8000/metrics`, 500ms timeout, Prometheus text line parser (no library)
- `start_vllm_harvester()` — 2s polling loop, `Arc<Mutex<VllmMetrics>>` pattern identical to Ollama harvester
- Dual `MetricsPayload` construction (broadcaster at 10Hz + SSE handler at 1Hz) — both updated; `cargo check` caught the first miss immediately

**Cloud (`cloud/src/main.rs`):**
- 5 fields with `#[serde(default)]` — older agents deserialise cleanly, newer agents populate the fields

**Frontend:**
- `types.ts` — 5 new optional fields on `SentinelMetrics`
- `NodesList.tsx` — dynamic vLLM diagnostic row: CheckCircle when detected, model name, tok/s (green `font-telin`), KV cache % (cyan `font-telin`)
- `Overview.tsx` — fleet throughput sums Ollama + vLLM; MODEL column shows vLLM cache badge; WES leaderboard + HexHive both include vLLM tok/s

**Design decision:** Ollama and vLLM can run simultaneously on the same node. Fleet tok/s = sum of both. No priority, no override — both coexist.

**Key metric note:** vLLM reports `gpu_cache_usage_perc` as 0.0–1.0 in Prometheus. Agent multiplies by 100 for consistent % representation across all surfaces. Document and enforce at the source, not the display layer.

---

### The Cockpit vs. Mission Control Identity Split

The most important architectural decision today: **Wicklee has two UI identities, not one.**

**The Credibility Gap problem:**
When a user runs `localhost:7700` — a single bare-metal node — and sees "Pair your fleet," "Team Management," and "Billing," the UI is lying about their context. It signals cloud SaaS product, not sovereign tool. For the Show HN audience and for HIPAA/defense operators who chose the agent for its sovereignty properties, this erodes trust in all the data.

**The solution:** A single `isLocalhost` flag at runtime branches the entire UI identity:

```typescript
const isLocalhost = window.location.hostname === 'localhost' ||
                    window.location.hostname === '127.0.0.1';
```

**The Cockpit (`localhost:7700`):**
- No Clerk auth — the filesystem is the auth
- 10Hz WebSocket (Hardware Rail pulse charts)
- Zero outbound connections
- Single-node scope — deep diagnostics, not fleet chrome
- "Node Intelligence" tab (not "AI Insights")
- Hardware Rail — live scrolling CPU/GPU/Thermal/Power timeline at 10Hz

**Mission Control (`wicklee.dev`):**
- Clerk auth — JWT, hosted signup/login
- 1Hz SSE via FleetStreamContext (single shared connection)
- Fleet scope — aggregates, WES Leaderboard, Inference Density Map
- "AI Insights" tab with cross-node fleet intelligence
- Team management, billing, node Coverage table

**Why this matters for Show HN:**
The Sovereign by Design thesis requires that the local install looks and feels like sovereign infrastructure — not a cloud product that happens to run locally. The Cockpit identity is the thesis made visible in the product.

---

### Documents Updated This Session

| File | Change |
|---|---|
| `docs/SPEC.md` | Added "Dual-Surface Strategy: Cockpit vs. Mission Control" section; vLLM Harvester marked live; SSE payload vLLM fields documented; Platform Support Linux Thermal updated to shipped |
| `docs/ROADMAP.md` | vLLM Integration + Linux Thermal marked shipped (v0.4.5); Binary Release & Local-Sync Pipeline section added |
| `docs/PROGRESS.md` | This entry |

---

### What Was Learned

- **Dual `MetricsPayload` construction pattern** — agent has two independent MetricsPayload constructions (broadcaster at 10Hz, SSE handler at 1Hz). When adding new fields, both must be updated. `cargo check` caught the miss instantly — the compiler is the checklist.
- **vLLM Prometheus metric units are 0–1, not 0–100** — `gpu_cache_usage_perc` requires ×100 at the agent layer. Enforce at the source, not the display layer.
- **The Credibility Gap is a product problem, not a marketing problem** — it cannot be solved with better copy. It requires a UI identity split backed by runtime detection.
- **`isLocalhost` is a clean enough heuristic** for the current stage — operators accessing the embedded binary will always be on localhost. Edge case (Nginx proxy) is acceptable as a later refinement.
- **Coverage, not Permissions** — "Coverage" describes what metric data the agent can collect from a node. "Permissions" implies access control. The distinction matters for operator mental models.
- **`font-telin` + `tabular-nums` everywhere numeric** — all tok/s, WES, power, cache % values use this. Prevents layout shifts at 10Hz update rates. Typography is load-bearing infrastructure.

---

### Code Shipped This Session

**Commit `b497199` — vLLM integration (5 files, 226 insertions):**
- `agent/src/main.rs` — `VllmMetrics` struct, `harvest_vllm()`, `start_vllm_harvester()`, updated broadcaster + SSE handler + main
- `cloud/src/main.rs` — 5 `#[serde(default)]` vLLM fields
- `src/types.ts` — 5 vLLM fields on `SentinelMetrics`
- `src/components/NodesList.tsx` — dynamic vLLM diagnostic row
- `src/components/Overview.tsx` — fleet tps + WES + HexHive updated for vLLM

---

*"Sovereign by default. Two surfaces, one codebase, one flag."*

---

## March 11, 2026 — WES, Agent-Native, Clerk, and the Two-Database Architecture ⚡

**The Goal:** Coin and ship WES as the live efficiency standard. Redesign the console UI for launch readiness. Lay the agent-native foundation. Integrate Clerk auth. Design the two-database architecture.

---

### WES — Wicklee Efficiency Score

The single most important thing that happened today: **WES was coined and shipped**.

**Formula:**
```
WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)
```
Which is equivalently:
```
WES = tok/watt ÷ ThermalPenalty
```

This second framing is the cleaner explanation: WES is tok/watt made thermally honest. When a node is thermally healthy, WES equals tok/watt. When it's throttling, WES is lower — and the gap tells you exactly how much efficiency is being lost to heat. That gap is **Thermal Cost %**.

**Live fleet scores (at time of coining):**

| Node | tok/s | Watts | WES |
|---|---|---|---|
| Apple M2 (WK-1EFC) | 108.9 | 0.6W | 181.5 |
| Ryzen 9 7950X idle (WK-C133) | 17.3 | 32.5W | 0.53 |
| Ryzen 9 7950X load (WK-C133) | 17.1 | 121.2W | 0.14 |

The 1,296× WES differential between M2 and Ryzen under load is the Show HN headline.

**Academic precedent:** Stanford/Together AI "Intelligence per Watt" (IPW, arXiv:2511.07885). WES is the operational counterpart — live fleet, thermal-aware, real-time. IPW = lab benchmark. WES = fleet operations.

**Dual meaning:** "Wicklee Efficiency Score" (branded) or "Watt-normalized Efficiency Score" (industry-neutral).

**WES v2 planned (spec document produced):**
- Thermal sampling loop — average ThermalPenalty over inference window at 2s intervals, not snapshot
- Separate Raw WES (tok/watt) from Penalized WES (÷ ThermalPenalty)
- Thermal Cost % as named visible quantity: `(tok/watt - WES) / tok/watt × 100`
- NVML throttle reason bitmask for NVIDIA — hardware-authoritative thermal source
- Refined Apple Silicon penalty: Serious→1.75 (was 2.0), Critical→2.0
- `wes_config.json` for configurable thresholds per platform
- "Why is my WES low?" tooltip with full calculation breakdown

**⚠ Breaking change:** Serious penalty 2.0→1.75 shifts existing scores. Capture four-node comparison table AFTER this ships.

---

### Console UI — Full Redesign Pass

**Intelligence page:**
- Fleet Status rows: fixed-width single-line grid, column priority hiding at breakpoints
- Fleet Intelligence: six fleet-level aggregate cards
- Inference Density Map: ✅ hexagonal hive plot, amber pulse on active inference, dim gray idle — the Show HN visual
- Best Route Now card: latency recommendation vs efficiency recommendation, delta line
- WES displayed as headline metric on every node card

**Management page (formerly Node Registry):**
- Four header tiles: Fleet VRAM, Connectivity, Hardware Mix, Lifecycle Alerts
- Fixed-width node table with expand/collapse rows
- "Permissions" column renamed → **Coverage** (metric coverage, not access control)
  - Full ✓ / Partial ⚠ / — with tooltip explaining what's available per node
- Responsive column hiding: always visible (Status+NodeID, Identity, Connectivity, Coverage), hide at breakpoints (Agent Version, OS, Uptime, Memory)
- Telemetry endpoint URL removed — was exposing Railway internal URL with no user value
- Expanded row: Connectivity | Node Settings (read-only) | Diagnostics

**Settings page — full redesign:**
- Cost & Energy: kWh rate, currency, PUE multiplier with live cost preview panel
- Node Configuration table: per-node overrides with amber indicator on overridden cells
- Display & Units: temperature, power display, WES precision, theme
- Alerts & Notifications: locked preview (Phase 4A)
- Account & Data: agent version, pairing, export, danger zone
- Auto-save to localStorage, no Save button anywhere
- getNodeSettings(nodeId) helper: resolves node override ?? fleet default

**Bug fixes:**
- Memory % showing 15 decimal places → fixed to 1dp
- Missing memory showing "memory —" → now shows clean "—"
- Permissions/Coverage column wrapping onto second line → single-line enforcement

**Navigation restructure:**
- Settings removed from primary left nav → single ⚙ icon in bottom anchor
- Profile dropdown cleaned: identity header, Settings, Docs, Release Notes, Sign out
- Removed: Account Security, API Keys, AI Providers, Preferences, Billing from dropdown
- Single profile entry point: lower left only. Topbar avatar removed.
- Theme toggle removed from topbar → Settings → Display & Units
- Search tab removed — no backend to power it, returns in Phase 4A with DuckDB
- Topbar: Search · Pair node · Notifications only

**Status indicators — consistency pass:**
- Per-node dots: Green (online <60s), Red (offline >60s), Gray (pending)
- SSE indicator: Green/all nodes (pulsing), Amber/some offline (pulsing), Red/disconnected (no pulse)
- Footer fleet count: "Fleet: 2 / 3 online" with color matching severity
- Tooltips on all three surfaces showing per-node last-seen elapsed time

---

### Marketing Site

**New hero copy:**
> **Local AI inference, finally observable.**
> Routing intelligence. True inference cost. Thermal state. Live, across every node. Built for Ollama and vLLM. Install in 60 seconds — nothing to configure.

**Blog launched:**
- Markdown files in Railway repo — git push is the publish action
- `/blog/[slug]` renders HTML for humans
- `/blog/[slug].md` serves raw Markdown for agents
- Defensive frontmatter parsing: missing fields degrade gracefully, never crash listing
- "Blog" added to marketing site top nav between Documentation and GitHub

**`/llms.txt` published:**
- Plain text index of site content and API surface for LLM consumption
- Lists blog posts, API endpoints (current and coming), MCP server (Phase 5), docs, install commands
- The `robots.txt` for the agent era

---

### Agent-Native Vision — Coined and Documented

The strategic insight captured today: **Wicklee is built for humans and their agents.**

Most SaaS is being retrofitted for agents as an afterthought. Wicklee is designed for both from the start. The data Wicklee collects — WES scores, thermal state, tok/s, cost per token, node availability — is exactly what an orchestration agent needs to make intelligent routing decisions.

**The four-phase progression:**
```
Phase 3A  →  /llms.txt + Markdown blog     agents can discover and read Wicklee
Phase 3B  →  Agent API v1                  agents can query live fleet data
Phase 4A  →  /api/v1/insights/latest       agents can consume Wicklee intelligence
Phase 5   →  MCP server                    agents call Wicklee tools natively
```

**Agent API v1 designed (Phase 3B):**
```
GET /api/v1/fleet           → fleet summary
GET /api/v1/fleet/wes       → WES scores, ranked
GET /api/v1/nodes/{id}      → single node deep metrics
GET /api/v1/route/best      → latency vs efficiency recommendation
```

The `/route/best` endpoint is the one agents need most — returns two opinionated recommendations with reasoning JSON.

**Blog post drafted:** "Built for Humans and Their Agents" — ready to publish after Show HN.

---

### Clerk Auth Integration ✅

Replaced DIY bcrypt/session auth with Clerk. Eight tasks completed by Claude Code:

1. `@clerk/clerk-react` installed
2. `VITE_CLERK_PUBLISHABLE_KEY` added to env (Vite stack, not Next.js)
3. App wrapped with `<ClerkProvider>`
4. DIY auth state removed — replaced with `useAuth()` / `useUser()`
5. `SignInPage.tsx` / `SignUpPage.tsx` — Clerk `<SignIn>` / `<SignUp>` components
6. Sidebar uses `useClerk()` for signOut and `openUserProfile()`
7. AddNodeModal token from `useAuth().getToken()`
8. `AuthModal.tsx` deleted

**What Clerk now handles:** password hashing, session management, token refresh, email verification, password reset, 2FA, active session management. None of this is custom code.

**"Manage Account"** added to profile dropdown → opens Clerk hosted account portal.

---

### Two-Database Architecture — Designed and Documented

The key architectural decision: **two databases, two purposes, one sovereign promise.**

```
Local agent SQLite  →  on-node, embedded in Rust binary
                        powers localhost:7700 entirely
                        never leaves node without explicit export

Cloud SQLite        →  Railway, multi-tenant
                        powers wicklee.dev fleet console
                        receives only SSE stream subset when paired
```

**Local agent schema:** `metrics_history`, `inference_runs`, `thermal_events`, `model_registry`. 90-day retention on metrics, 1-year on runs, unlimited thermal events.

**Cloud schema:** `fleet_metrics`, `fleet_events`, `node_registry`, `user_settings`, `api_keys` (Phase 3B). Scoped by Clerk `user_id`.

**Sovereign Mode (Phase 5)** becomes a single feature flag — disable the SSE forward branch. The two-database architecture makes this trivially implementable rather than a rewrite.

**DuckDB deferred:** SQLite handles all Phase 4A analytical queries at current scale (3-50 node fleets). Migration trigger: when P50/P95 queries over 90 days exceed 200ms. Schema designed for clean migration when that time comes.

---

### Documents Produced This Session

| File | Purpose |
|---|---|
| `ROADMAP_merged.md` | Full roadmap incorporating all session additions |
| `DATABASE_ARCHITECTURE.md` | Two-database design with full schemas |
| `built-for-humans-and-their-agents.md` | Blog post draft, ready to publish post-Show HN |
| `claude_code_clerk_prompt.md` | Clerk integration prompt (executed, complete) |
| `claude_code_blog_llms_prompt.md` | Blog + llms.txt prompt (executed, complete) |
| WES Implementation Spec | Agent changes for WES v2 (external doc, reviewed) |

---

### What Was Learned

- **WES = tok/watt ÷ ThermalPenalty** is the cleaner framing. Leads with tok/watt as an already-understood metric, positions WES as its thermal-honest extension. Thermal Cost % is the gap made visible.
- **"Permissions" is the wrong word** for metric coverage — implies access control rather than data quality. "Coverage" is precise and unambiguous.
- **Two database problem is real and architectural.** Local data must live in a local database by design, not policy. Cloud gets only what's needed for fleet aggregation.
- **Agent-native is a founding assumption, not a feature.** `/llms.txt` and raw Markdown routes are the first step of a deliberate progression toward MCP server. Each phase builds on the last.
- **Clerk on Vite requires `VITE_` prefix** on publishable key — not `NEXT_PUBLIC_`. Claude Code adapted correctly without being told.
- **The SSE indicator showing green when nodes are offline** erodes trust in all data. Status must be fleet-state-aware, not just connection-aware.

---

### Code Shipped This Session (commits ddbad6d → f21a4f8)

**Clerk auth** (`f21a4f8`):
- `@clerk/clerk-react` installed; `ClerkProvider` in `src/index.tsx` with `VITE_CLERK_PUBLISHABLE_KEY`
- `useAuth` + `useUser` replace all DIY session state; `getToken()` replaces `localStorage` token reads
- `/sign-in` + `/sign-up` path-routed pages; `AuthModal.tsx` deleted
- Sidebar: `signOut()` + `openUserProfile()` via `useClerk()`; "Manage Account" added to dropdown
- Header search bar removed

**`src/utils/time.ts`** — new shared module:
- `NODE_REACHABLE_MS = 60_000` — single threshold for all reachability checks
- `fmtAgo(ms)` — <60s → "just now", else Xm/Xh/Xd ago

**SSE indicator overhaul** (Intelligence page, Fleet Status card header):
- 3-state: green+pulse (all nodes <60s), amber+pulse (some nodes >60s), red/no-pulse (stream down)
- Hover tooltip lists node IDs + elapsed time per unreachable node

**Node status consistency** (3 surfaces, same `NODE_REACHABLE_MS`):
- Fleet Status rows: green/red/gray dot with reachability tooltip (was always green)
- Management table: threshold updated 30s → 60s; same 3-state dot; amber permission indicator removed from reachability dot
- Footer: "Fleet: X / Y online" with green/amber/red text + per-node tooltip breakdown; `nodeLastSeenMs` captured from existing App-level SSE

**Coverage column** (Management page):
- "Permissions" → "Coverage"; header tooltip added
- Offline: `—` with "Node offline — coverage unknown"; Full: `✓ Full`; Partial: `⚠ Partial` with dynamic missing-metric tooltip
- Row height locked: `max-h-[48px] overflow-hidden` — no wrapping

---

### Current State

**Live fleet:** Apple M2 (WK-1EFC) ✅, GeiserBMC Ryzen (WK-C133) ✅, Andy_PC RTX 3070 (WK-03E2) ⬜ pending Ollama install

**Critical path to Show HN:**
```
Andy_PC Ollama install  →  RTX 4090 Vast.ai test (~$0.50/hr)
→  Four-node WES table (after WES v2 penalty fix)
→  dev.to article  →  Show HN
```

**Remaining code work before Show HN:**
- WES v2: thermal sampling loop, NVML bitmask, dual display, wes_config.json
- Mock data fix on fleet overview cards
- Local agent SQLite (embedded Rust)

---

*"Local AI inference, finally observable."*

---

## March 1–2, 2026 — The London Protocol 🇬🇧☕

**The Goal:** Go from "Rust agent + separate React frontend" to a single binary that serves a live hardware dashboard at `localhost:7700` with zero separate processes, zero sudo, and metrics that Activity Monitor can't show.

**What Shipped:**

### Binary UI (Commit 6e5c725)
- Added `rust-embed` and `mime_guess` to `agent/Cargo.toml`
- Created `StaticAssets` struct embedding `frontend/dist/` directly into the binary at compile time
- Axum router now serves the React app at `/`, with SPA fallback for sub-routes (`/nodes`, `/team`, etc.) so React Router works on page refresh
- SSE endpoint live at `/api/metrics` — 1 event per second
- Clean ASCII startup box printed to terminal on launch
- Vite build output redirected to `agent/frontend/dist/` to match the embed path

### Deep Metal — Apple Silicon (Commits 4988706, 8cec0f7)
- `ioreg -r -c IOGPUDevice` → GPU Utilization % (no sudo, M-series compatible)
- `pmset -g therm` → Thermal State mapped to Normal / Elevated / High / Critical (no sudo)
- `vm_stat` → Memory Pressure % computed from wired + active pages only (dropped inactive/speculative inflation)
- `powermetrics` attempted without sudo — graceful `null` on failure, never crashes
- `machdep.xcpm.cpu_thermal_level` sysctl attempted — graceful `null` on M-series (Intel only)
- All privileged metrics (`cpu_power_w`, `ecpu_power_w`, `pcpu_power_w`) return `null` with clear dashboard label

### Dashboard Wiring (Overview.tsx)
- `EventSource('/api/metrics')` hooked into `useEffect` — relative URL works for both embedded binary (7700) and Vite dev proxy (3000)
- Green pulsing dot when SSE connected, grey "Reconnecting…" on drop with 3s auto-retry
- Sentinel Node panel: CPU %, Memory Used/Total, Memory Available, CPU Cores, Thermal State (color-coded badge)
- Apple Silicon row: GPU Utilization, Memory Pressure — conditionally rendered only when data is non-null
- All fields show `—` until first SSE frame arrives

### Bug Fixes
- `available_memory_mb` was always `0` on macOS — fixed using `total_memory().saturating_sub(used_memory())` (sysinfo's `available_memory()` is unreliable on macOS 0.30)
- Memory pressure was inflated by inactive pages — recalculated as wired + active only

**Final SSE Stream (verified live):**
```json
{
  "node_id": "JEFFs-MacBook-Pro-2.local",
  "cpu_usage_percent": 29.4,
  "total_memory_mb": 8192,
  "used_memory_mb": 6654,
  "available_memory_mb": 1537,
  "memory_pressure_percent": 99.0,
  "gpu_utilization_percent": 29.0,
  "thermal_state": "Normal",
  "cpu_power_w": null,
  "ecpu_power_w": null,
  "pcpu_power_w": null,
  "cpu_core_count": 8,
  "timestamp_ms": 1772405021684
}
```

**What Was Learned:**
- `powermetrics` requires a privileged kernel entitlement on macOS — there is no sudoless workaround for CPU cluster power. Own it, label it honestly.
- `machdep.xcpm.cpu_thermal_level` is Intel-only. M-series thermal comes from `pmset`.
- `ioreg -r -c IOAccelerator` is the wrong class on M-series. `IOGPUDevice` is correct.
- rust-embed with Brotli compression keeps the embedded JS reasonable despite React + Recharts + Lucide bundle size.
- SPA fallback in Axum is essential — forgetting it causes 404s on any browser refresh of a sub-route.

**What's Next:**
- Fix memory pressure calc (wired + active only — drop speculative/inactive)
- `make install` → `wicklee` global CLI
- 10Hz WebSocket for liquid pulse charts
- NVIDIA/NVML support for Linux nodes
- `docs/` folder: SPEC.md, ROADMAP.md, progress.md committed to repo

---

*"Your fleet data never leaves your network until you choose."*
