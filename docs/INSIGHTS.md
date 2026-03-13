# Wicklee — Insights Reference

> **Authoritative spec for all 14 insights: derivation formulas, tier gating, UI placement, and scaffolding approach.**
> The Insights tab and all `InsightCard` components should derive from this document.

---

## Core Thesis

Every insight on this list is impossible without owning both hardware telemetry and inference runtime context simultaneously. That intersection is Wicklee's structural moat.

- **Hardware side:** CPU power (RAPL / NVML), GPU utilization, thermal state, VRAM, memory pressure
- **Runtime side:** model loaded, quantization, size, tok/s (Ollama probe / vLLM Prometheus)

No other tool has both streams. This is not a feature list — it is a structural moat.

---

## Proxy-Free Architecture

All 14 insights are derived from hardware telemetry and Ollama/vLLM API metadata **only**. Wicklee never sits in the HTTP request path. It does not intercept, proxy, or inspect actual inference requests or model responses.

Data sources used:
- `NVML` / `powermetrics` / `ioreg` — hardware metrics
- Ollama `/api/ps`, `/api/tags` — model metadata, keepalive state
- vLLM `/metrics` — Prometheus endpoint, no request content
- Wicklee Performance Probe — Wicklee's own 3-token pulse, not user traffic
- DuckDB time-series history — for trend and regression insights (Pro+ / Team+)

**Removed from scope:** Cross-Node Inference Routing (Sentinel Proxy) was considered as an insight but requires being in the HTTP request path. It is deferred to Phase 5 as a separate architectural component, not an insight card.

**Hardware Cold Start note:** Earlier spec versions required TTFT data (which needed proxy). The current derivation uses pure hardware pattern matching (gpu_util + vram + power transitions) and does not require proxying.

---

## WES — Foundation Metric

```
WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)
```

| Thermal State | Penalty |
|---|---|
| Normal | 1.0× |
| Fair | 1.25× |
| Serious | 2.0× |
| Critical | 2.0×+ |

WES is thermally-honest tok/watt. When a node is healthy, WES ≈ tok/watt. When throttling, WES is lower — the gap is exactly how much efficiency heat is costing you.

---

## The 14 Insights

---

### Tier 1 — Active Alerts · Community · All Nodes

> Real-time detection from a single SSE frame. No history required. Available to all users.

---

#### 1. Thermal Degradation

**Derivation:** `thermal_state` transitions to `Serious` or `Critical` AND `tok/s` drops >15% from the session baseline (rolling 5-sample mean from session start).

**Data sources:** `thermal_state` (pmset / NVML) · `ollama_tokens_per_second` + `vllm_tokens_per_sec`

**Session baseline:** computed from the first 5 tok/s samples after agent connect; reset on reconnect.

**Card state:** Fires when both conditions are true simultaneously. Dismissed when thermal returns to Normal or tok/s recovers within 15% of baseline.

**Alerting:** Dashboard card (Community) · Slack delivery (Pro+)

**Existing component:** `src/components/insights/tier1/ThermalDegradationCard.tsx` ✅

---

#### 2. Power Anomaly

**Derivation:** `current_watts > 2 × idle_watts` AND `gpu_utilization < 20%`.

**Data sources:** `cpu_power_w` + `nvidia_power_draw_w` (board total) · `nvidia_gpu_utilization_percent` or `gpu_utilization_percent`

**Idle baseline:** lowest 5-sample rolling min of `watts` during the current session.

**Card state:** Fires on sustained anomaly (>60s). High wattage at low GPU% indicates a background process consuming power without doing inference work.

**Alerting:** Dashboard card (Community) · Slack after 5-min sustained anomaly (Pro+)

**Existing component:** `src/components/insights/tier1/PowerAnomalyCard.tsx` ✅

---

#### 3. Memory Exhaustion

**Derivation:** `available_mem - model_size < 10% of total_mem`.

**Data sources:** `used_memory_mb` / `total_memory_mb` / `memory_pressure_percent` · `ollama_model_size_gb` (from Ollama `/api/ps`)

**Apple Silicon note:** Unified memory serves both CPU and GPU. `memory_pressure_percent` from `vm_stat` is the primary signal; model size from Ollama `/api/ps`.

**Card state:** Warning card when headroom < 10%. Dismissed when headroom recovers above 15%.

**Alerting:** Dashboard card (Community) · Slack at configurable threshold (Pro+, default 10%)

**Existing component:** `src/components/insights/tier1/MemoryExhaustionCard.tsx` ✅

---

### Tier 2 — Advisory · Pro · Up to 10 Nodes · 7-Day History

> Persistent cards that survive session reconnects. Some cards require accumulated history to activate — show "Collecting data…" state until threshold met.

---

#### 4. Model Fit Score

**Derivation:**
- **Poor:** `model_size > available_vram` OR memory headroom < 10%
- **Fair:** memory headroom < 30% OR thermal state = Fair
- **Good:** memory headroom > 30% AND thermal Normal

**Data sources:** `ollama_model_size_gb` (from `/api/ps`) · `nvidia_vram_used_mb` / `nvidia_vram_total_mb` · `memory_pressure_percent` · `thermal_state`

**History required:** No — computed from current frame.

**Card state:** Always shown when a model is loaded. Score degrades in real time as memory pressure increases or thermal worsens.

**Alerting:** Dashboard card (Pro) · Slack when score degrades to Poor (Pro+)

**Existing component:** `src/components/insights/tier2/ModelFitInsightCard.tsx` ✅

---

#### 5. Model Eviction Prediction

**Derivation:** `(ollama_keep_alive_seconds - time_since_last_request_s) < 120`.

**Data sources:** Ollama `/api/ps` — exposes `expires_at` per loaded model. `time_since_last_req` derived from `expires_at` and `keep_alive` without request proxying.

**No proxy required:** Ollama tracks last-request time internally and surfaces it via `/api/ps`. Wicklee reads this directly.

**Card state:** Warning shown when eviction is predicted within 2 minutes. Keep Warm toggle available (Pro: 1 node, Team+: all fleet nodes).

**Keep Warm mechanics:** On predicted eviction, Wicklee sends a silent 3-token pulse with `keep_alive: -1` to reset the expiry timer. Logged in Live Activity with timestamp and model name.

**Alerting:** Warning card (Pro) · Keep Warm action (Pro: single node, Team+: all nodes)

**Existing component:** `src/components/insights/tier2/ModelEvictionCard.tsx` ✅

---

#### 6. Idle Resource Cost

**Derivation:** `idle_watts × PUE × kwh_rate × 24` = $/day. Only fires when node has been idle (no active inference) for > 1 hour.

**Data sources:** `cpu_power_w` / `nvidia_power_draw_w` · per-node `kwhRate` + `pue` from Settings · `ollama_tokens_per_second` (to confirm idle state)

**Idle threshold:** No tok/s activity for > 60 continuous minutes.

**History required:** No — computed from current power draw.

**Card state:** Shows projected 24h cost from current idle draw. Dismissed when inference becomes active.

**Alerting:** Dashboard card (Pro) · Weekly idle cost digest via Slack (Team+)

**Existing component:** `src/components/insights/tier2/IdleResourceCard.tsx` ✅

---

#### 7. WES Peer Leaderboard

**Derivation:** Flags a node if its `current_WES < 80% of fleet_avg_WES` across nodes running identical hardware.

**Hardware matching:** Nodes grouped by `chip_name` (Apple Silicon) or `gpu_name` (NVIDIA). Only nodes in the same hardware group are compared.

**Data sources:** Per-node `wes` · `chip_name` / `gpu_name` from telemetry · 7-day WES history (DuckDB)

**History required:** 7-day history for trend context (shows "Collecting data…" until threshold met). Live peer comparison available immediately.

**Card state:** Flags underperforming nodes. A same-hardware node running below fleet peers is a signal of thermal paste degradation, background processes, or VRAM fragmentation.

**Alerting:** Dashboard card (Pro) · Slack when a node drops below 80% of hardware-group WES (Pro+)

**Component:** `src/components/insights/tier2/WESPeerLeaderboardCard.tsx` 🔲 Pending

---

### Tier 3 — Advanced Intelligence · Team · Unlimited Nodes · 90-Day History

> Trend and regression analysis. All cards require historical data from DuckDB. Show "Collecting history…" state for new Team subscribers until minimum history is met.

---

#### 8. Efficiency Regression

**Derivation:** `current_WES < 85% of 7_day_avg_WES` where thermal state is Normal (filters out thermal-caused regressions, which are covered by Insight #1).

**Data sources:** Per-node WES time-series (DuckDB, 7-day window) · `thermal_state` (to exclude throttling events from baseline)

**History required:** 7 days minimum. "Collecting history…" state below threshold.

**Card state:** Shows current WES vs 7-day baseline with delta. Triggered when degradation is statistically significant and not thermally explained.

**Alerting:** Dashboard card (Team) · Slack when regression >20% vs 7-day baseline

**Component:** `src/components/insights/tier3/EfficiencyRegressionCard.tsx` 🔲 Pending

---

#### 9. Memory Forecast

**Derivation:** Linear regression of `memory_pressure_percent` over the last 60 minutes. Projects time to 90% saturation.

**Data sources:** `memory_pressure_percent` time-series (DuckDB) · `total_memory_mb` · `ollama_model_size_gb`

**History required:** 60 minutes of samples for regression. "Collecting data…" until threshold met.

**Card state:** Shows ETA to critical pressure with a mini sparkline of the pressure trajectory. Only fires when slope is positive (pressure is rising).

**Alerting:** Dashboard card (Team) · Slack at 15-min ETA · Slack at 5-min ETA (cannot disable)

**Component:** `src/components/insights/tier3/MemoryForecastCard.tsx` 🔲 Pending

---

#### 10. Quantization ROI

**Derivation:** `historical_WES(Q4) > 1.25 × current_WES(Q8)` — fires when Q4 quantization shows >25% better WES than the current Q8 run on the same hardware.

**Data sources:** Per-model, per-quantization WES and tok/s history (DuckDB) · `ollama_active_model` (quantization detected from model name suffix)

**History required:** Both quantizations must have been run on this node within the 90-day window. "No comparison data" state otherwise — this is a point-in-time comparison, not a live condition.

**Card state:** Side-by-side WES and tok/s for each quantization with hardware context. Actionable recommendation: switch to Q4 to recover X% efficiency.

**Alerting:** Dashboard card only (Team) — no alert delivery

**Component:** `src/components/insights/tier3/QuantizationROICard.tsx` 🔲 Pending

---

#### 11. Hardware Cold Start

**Derivation:** Pattern match on three simultaneous transitions within a 10-second window:
1. `gpu_utilization`: 0% → ≥80%
2. VRAM / unified memory: near-zero → approximately `model_size`
3. Power draw: idle level → inference level (≥1.5× idle)

**Data sources:** `gpu_utilization_percent` · `nvidia_vram_used_mb` or `memory_pressure_percent` · `cpu_power_w` + `nvidia_power_draw_w` — all hardware telemetry, no request proxying required.

**No proxy required:** Detection is fully hardware-metric-based. TTFT is not used (proxy dependency removed from earlier spec versions).

**History required:** No for live detection. DuckDB used for cold start frequency analysis over 90-day window.

**Card state:** Live Activity event on each detection. Insight card shows cold start frequency and average model load duration over 90-day window.

**Alerting:** Live Activity event (Team) · Slack on >3 cold starts/day (Team+)

**Component:** `src/components/insights/tier3/ColdStartCard.tsx` 🔲 Pending

---

#### 12. Fleet Thermal Diversity

**Derivation:** Percentage of fleet nodes in `Serious` or `Critical` thermal state.
- **Healthy:** 0% of nodes throttling
- **Stressed:** >25% of nodes at Serious
- **Critical:** >50% of nodes at Serious or Critical

**Data sources:** `thermal_state` per node across all paired fleet nodes — live telemetry.

**History required:** No for live score. DuckDB used for 90-day thermal trend view.

**Card state:** Live fleet health score with per-state breakdown. Trend sparkline over 90-day window.

**Alerting:** Dashboard card (Team) · Slack when fleet reaches Stressed threshold (Team+)

**Component:** `src/components/insights/tier3/FleetThermalDiversityCard.tsx` 🔲 Pending

---

#### 13. Inference Density

**Derivation:** Visualization of active vs. idle nodes across the fleet. Active inference = amber pulse. Idle = dim gray. Throttling = red.

**Data sources:** `ollama_tokens_per_second` / `vllm_tokens_per_sec` · `gpu_utilization_percent` · `thermal_state` — all live telemetry.

**History required:** No for live view. DuckDB used for historical density playback (Team+).

**Note on live view:** The live hive plot already ships in Fleet Intelligence at the Community tier. The Inference Density insight card at Team tier adds: historical density playback over the 90-day window, peak inference hour analysis, and node utilization heatmap by time-of-day.

**Alerting:** None — visualization only.

**Component:** `src/components/insights/tier3/InferenceDensityCard.tsx` 🔲 Pending (live hive: `HexHive.tsx` ✅)

---

### Tier 4 — Sovereignty · Enterprise · Custom / Airgapped

> Compliance-layer insights. Enterprise only. Requires Sovereign Mode or airgapped deployment.

---

#### 14. Sovereignty Audit

**Derivation:** Verifies `telemetry_logs` against an operator-defined IP/Domain allowlist. Detects any outbound connections from the agent not in the allowlist.

**Data sources:** Agent outbound connection log · operator-configured allowlist (IP ranges + domains) · pairing event timestamps

**Card state:** Compliance posture score — Green (all telemetry within allowlist) / Amber (unrecognized destinations) / Red (allowlist violations). Full signed audit trail.

**Artifact:** Cryptographically signed PDF export (ECDSA). Report includes: node inventory, metric history summary, egress event log, data residency map, audit window timestamps. CISO-ready compliance artifact.

**Alerting:** Dashboard card + webhook to SIEM on allowlist violation (Enterprise)

**Component:** `src/components/insights/tier4/SovereigntyAuditCard.tsx` 🔲 Pending

---

## UI Tab Organization

### Insights Tab Layout

The Insights tab is organized into four tier-labeled sections with progressive disclosure. Cards are **never hidden** from lower-tier users — locked tiers render as teaser cards showing name, one-liner, and upgrade CTA. Visible locked cards drive upgrade consideration.

```
┌─────────────────────────────────────────────────────┐
│  ⚠ ACTIVE ALERTS (firing banner)                    │
│  Thermal Degradation on WK-C133 · 3 min ago         │  ← Floats above sections
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  ACTIVE ALERTS · Community                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │
│  │ Thermal     │ │ Power       │ │ Memory      │   │
│  │ Degradation │ │ Anomaly     │ │ Exhaustion  │   │
│  └─────────────┘ └─────────────┘ └─────────────┘   │
├─────────────────────────────────────────────────────┤
│  ADVISORY · Pro  [lock badge if Community]          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │
│  │ Model Fit   │ │ Model       │ │ Idle        │   │
│  │ Score       │ │ Eviction    │ │ Resource    │   │
│  └─────────────┘ └─────────────┘ └─────────────┘   │
│  ┌─────────────┐                                    │
│  │ WES Peer    │                                    │
│  │ Leaderboard │                                    │
│  └─────────────┘                                    │
├─────────────────────────────────────────────────────┤
│  ADVANCED INTELLIGENCE · Team  [lock if Pro-]       │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │
│  │ Efficiency  │ │ Memory      │ │ Quant ROI   │   │
│  │ Regression  │ │ Forecast    │ │             │   │
│  └─────────────┘ └─────────────┘ └─────────────┘   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │
│  │ Cold Start  │ │ Fleet       │ │ Inference   │   │
│  │             │ │ Thermal Div │ │ Density     │   │
│  └─────────────┘ └─────────────┘ └─────────────┘   │
├─────────────────────────────────────────────────────┤
│  SOVEREIGNTY · Enterprise  [lock if Team-]          │
│  ┌──────────────────────────────────────────────┐   │
│  │ Sovereignty Audit                            │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Card States

| State | Description | Visual Treatment |
|---|---|---|
| **Live** | Insight computing, no condition firing | Card with "— no condition" or current value |
| **Firing** | Condition is active right now | Colored alert state; card also appears in the top banner |
| **Collecting** | Tier unlocked but insufficient history | "Collecting X days of history…" with progress indicator |
| **Locked** | User tier is below requirement | Card shell: name + icon + one-liner + lock icon + tier badge + upgrade CTA |
| **Unavailable** | Required data source missing | "— no power data" / "— no model loaded" |

### Locked Card Pattern

Render the full card chrome with:
- Muted opacity on the body content area
- `🔒` lock icon in the card header alongside the insight name
- Tier badge (`Pro` / `Team` / `Enterprise`) in the tier color
- Upgrade CTA: "Available on [Tier] →" linking to the upgrade/billing flow

**Do not show mock or sample data in locked cards.** It can mislead operators into thinking they have live readings. The description and one-liner are sufficient context.

### Active Alerts Banner

When any Tier 1 card is in Firing state, a banner appears at the top of the Insights tab:
- Background: `red-900/30`, border `red-700/40`
- Shows: insight name · node ID · time elapsed · anchor link to the card below
- Multiple firing alerts stack as separate rows
- Dismissible per-alert (sessionStorage for Community, server-side for Pro+)

### Upgrade Prompt on Alert Delivery

For Community users when a Tier 1 card fires, inline CTA below the card body:
```
⚠ Thermal Degradation on WK-C133
  Upgrade to Pro to receive Slack alerts →
```

---

## Gating Implementation

### `usePermissions` Mapping

```typescript
// insightsTier from usePermissions (see TIERS.md)
type InsightsTier = 'live_session' | 'persistent' | 'trend' | 'predictive';

const INSIGHT_TIER_GATE: Record<number, InsightsTier> = {
  1:  'live_session',   // Thermal Degradation        — Community
  2:  'live_session',   // Power Anomaly              — Community
  3:  'live_session',   // Memory Exhaustion          — Community
  4:  'persistent',     // Model Fit Score            — Pro
  5:  'persistent',     // Model Eviction             — Pro
  6:  'persistent',     // Idle Resource Cost         — Pro
  7:  'persistent',     // WES Peer Leaderboard       — Pro
  8:  'trend',          // Efficiency Regression      — Team
  9:  'trend',          // Memory Forecast            — Team
  10: 'trend',          // Quantization ROI           — Team
  11: 'trend',          // Hardware Cold Start        — Team
  12: 'trend',          // Fleet Thermal Diversity    — Team
  13: 'trend',          // Inference Density (hist.)  — Team
  14: 'predictive',     // Sovereignty Audit          — Enterprise
};

const TIER_ORDER: InsightsTier[] = [
  'live_session', 'persistent', 'trend', 'predictive'
];

function canViewInsight(insightId: number, userTier: InsightsTier): boolean {
  const required = INSIGHT_TIER_GATE[insightId];
  return TIER_ORDER.indexOf(userTier) >= TIER_ORDER.indexOf(required);
}
```

### History-Gated Cards

Cards where the tier is unlocked but data hasn't accumulated yet. These render as "Collecting" state — not "Locked". The user has paid; they just need to wait.

| Insight | Min History | "Collecting" Message |
|---|---|---|
| WES Peer Leaderboard (#7) | 1 day | "Collecting baseline — available in ~X hours" |
| Efficiency Regression (#8) | 7 days | "Collecting 7-day WES baseline — available in ~X days" |
| Memory Forecast (#9) | 1 hour | "Collecting memory trajectory…" |
| Quantization ROI (#10) | Both quants run | "Run both quantizations on this node to enable comparison" |
| Cold Start history (#11) | 7 days (history view) | Live detection available now; historical frequency in ~X days |
| Inference Density history (#13) | 7 days | Live hive available now; density playback in ~X days |

### Alert Delivery Gate

Alert delivery is separately gated from card visibility. Community sees the card; Slack/PagerDuty delivery gates to Pro+ per TIERS.md alerting tier.

---

## Component Inventory

| Component | Tier | Status |
|---|---|---|
| `InsightCard.tsx` | base | ✅ Shipped |
| `ModelFitCard.tsx` | base | ✅ Shipped |
| `tier1/ThermalDegradationCard.tsx` | 1 | ✅ Shipped |
| `tier1/PowerAnomalyCard.tsx` | 1 | ✅ Shipped |
| `tier1/MemoryExhaustionCard.tsx` | 1 | ✅ Shipped |
| `tier2/ModelFitInsightCard.tsx` | 2 | ✅ Shipped |
| `tier2/ModelEvictionCard.tsx` | 2 | ✅ Shipped |
| `tier2/IdleResourceCard.tsx` | 2 | ✅ Shipped |
| `tier2/WESPeerLeaderboardCard.tsx` | 2 | 🔲 Pending |
| `tier3/EfficiencyRegressionCard.tsx` | 3 | 🔲 Pending |
| `tier3/MemoryForecastCard.tsx` | 3 | 🔲 Pending |
| `tier3/QuantizationROICard.tsx` | 3 | 🔲 Pending |
| `tier3/ColdStartCard.tsx` | 3 | 🔲 Pending |
| `tier3/FleetThermalDiversityCard.tsx` | 3 | 🔲 Pending |
| `tier3/InferenceDensityCard.tsx` | 3 | 🔲 Pending (live: `HexHive.tsx` ✅) |
| `tier4/SovereigntyAuditCard.tsx` | 4 | 🔲 Pending |
| `InsightLockedCard.tsx` | gate wrapper | 🔲 Pending |
| `InsightsTab.tsx` | tab orchestrator | 🔲 Pending |

---

## Delivery Reference

| # | Insight | Tier | History Req. | Shipped | Alerting |
|---|---|---|---|---|---|
| 1 | Thermal Degradation | Community | None | ✅ | Slack (Pro+) |
| 2 | Power Anomaly | Community | None | ✅ | Slack 5-min debounce (Pro+) |
| 3 | Memory Exhaustion | Community | None | ✅ | Slack at threshold (Pro+) |
| 4 | Model Fit Score | Pro | None | ✅ | Slack on Poor (Pro+) |
| 5 | Model Eviction | Pro | None | ✅ | Keep Warm action |
| 6 | Idle Resource Cost | Pro | None | ✅ | Weekly digest (Team+) |
| 7 | WES Peer Leaderboard | Pro | 1 day | 🔲 | Slack <80% peer (Pro+) |
| 8 | Efficiency Regression | Team | 7 days | 🔲 | Slack >20% regression |
| 9 | Memory Forecast | Team | 1 hour | 🔲 | Slack 15-min + 5-min ETA |
| 10 | Quantization ROI | Team | Both quants | 🔲 | None |
| 11 | Hardware Cold Start | Team | None (live) | 🔲 | Slack >3/day |
| 12 | Fleet Thermal Diversity | Team | None (live) | 🔲 | Slack at Stressed |
| 13 | Inference Density (hist.) | Team | 7 days | 🔲 | None |
| 14 | Sovereignty Audit | Enterprise | Full window | 🔲 | SIEM / webhook |

---

*Last updated: March 13, 2026. Source of truth for the Insights tab and InsightCard scaffolding.*
