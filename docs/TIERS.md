# Wicklee — Subscription Tiers

> **Authoritative reference for feature gating.** All subscription logic in the frontend (`usePermissions`, gate guards, upgrade prompts) and backend (Clerk metadata, Stripe entitlements) should derive from this document.

---

## Tier Summary

| Feature Area | Community | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Max Nodes** | 3 | 10 | Unlimited | Unlimited |
| **Price** | Free | ~$9/mo | ~$29/mo | ~$199/mo |
| **Metric History** | 24-Hour Rolling | 7-Day | 90-Day | Custom / Audit Scope |
| **Alerting** | Dashboard only | Slack (Single) | Slack & PagerDuty | SIEM / Webhooks |
| **Insights** | Live + Core Educational | Persistent Cards | Trend Analysis | Predictive / Compliance |
| **Sovereignty** | Cloud Relay | Cloud Relay | Cloud Relay | **Airgapped — no outbound telemetry** |
| **Artifacts** | — | — | CSV Exports | Signed PDF Audits |
| **Prometheus / Grafana Export** | — | — | — | ✅ |
| **Kubernetes Operator** | — | — | — | ✅ |
| **SSO / SAML** | — | — | — | ✅ |

---

## Community — Free

**Target user:** Individual developer, hobbyist, home-lab operator. Evaluating Wicklee.

### Nodes
- Maximum 3 paired nodes
- Enforcement: checked at `/api/pair/activate` — reject if `node_count >= 3` and tier = Community
- UI: 3-node hard cap with upgrade prompt when adding a 4th node

### Metrics & History
- **24-Hour Rolling History** — cloud stores last 24h of SSE stream data
- All hardware telemetry available: WES, tok/s, tok/w, watts, GPU%, memory, VRAM, thermal
- Data retention: 24h in cloud; no long-term DuckDB persistence at this tier
- Local agent SQLite (localhost:7700): unaffected — always stores full local history

### WES v2 Diagnostics — All Tiers
- **WES (Wicklee Efficiency Score)** — available on every tier, computed from live SSE telemetry
- **Raw WES** (`tok/s ÷ Watts`) and **Penalized WES** (`tok/s ÷ (Watts × ThermalPenalty)`) both visible everywhere
- **Thermal Cost %** — `(RawWES − PenalizedWES) / RawWES × 100` — shown as an amber badge whenever TC% > 0
  - Appears in: Fleet Status table WES column, Fleet Leaderboard, Best Route Now card, WES tooltip
- **WES tooltip v2** — shows tok/s · Watts · Thermal state · TC% · Thermal data source on all WES values
- **Penalty table** — `Normal: 1.0 · Fair: 1.25 · Serious: 1.75 · Critical: 2.0`
- These are core observability signals. No tier gate. No upgrade prompt.

### Insights
- **Live + Core Educational** — insight cards computed from current SSE frame + 24h rolling data; persist across sessions within the 24h window
- Available cards (all Community / free tier):
  - Thermal Degradation Correlation
  - Power Anomaly Detection
  - Unified Memory Exhaustion Warning (Apple Silicon / NVIDIA)
  - Model-to-Hardware Fit Score
  - Model Eviction Prediction
  - **Idle Resource Notice** — node idle ≥ 1 hr; shows estimated $/hr cost. Community-free.
  - Quantization ROI (live snapshot — tok/s, W/1K TKN, WES with educational copy)
  - **Live WES Leaderboard** — ranks all connected nodes by penalized WES; shows TC% and thermal state badge per node. Community-free; no history required.
- Cards persist via localStorage with 24h expiry; dismissed state survives tab close within the 24h window
- **Pattern Engine (9 Community patterns):** A (Thermal Drain), B (Phantom Load), C (WES Velocity Drop), F (Memory Trajectory), H (Power Jitter), J (Swap I/O Pressure), K (Clock Drift), N (NVIDIA Thermal Redline), O (VRAM Overcommit) fire for all tiers. Each finding includes a `recommendation` string and `action_id` badge in the ObservationCard UI.

### Alerting
- **Dashboard only** — no outbound delivery
- Insight cards surface on the Insights tab when conditions fire
- No email, Slack, webhook, or SIEM delivery

### Fleet Intelligence
- View-only access to live fleet cards: Fleet Avg WES, Cost Efficiency, Tokens Per Watt, Thermal Diversity, Inference Density Map, Idle Fleet Cost (daily $/node estimate)
- No alert configuration, no export

### Sovereignty
- **Cloud Relay** — telemetry flows agent → Railway → wicklee.dev SSE
- No airgapped mode
- Sovereignty audit log: view only (no export)

### Artifacts
- None
- No CSV, JSON, or PDF export

### API & Integrations
- Agent API v1: ✅ all endpoints including `/api/v1/route/best`
- `/api/v1/insights/latest`: ❌ (Team+)
- MCP server: ❌ (Team+)

### Gating Constants (frontend)
```typescript
// src/types.ts or src/constants/tiers.ts
COMMUNITY_NODE_LIMIT = 3
COMMUNITY_HISTORY_DAYS = 1          // 24-hour rolling
COMMUNITY_KEEP_WARM = true
COMMUNITY_KEEP_WARM_LIMIT = 1       // 1 active node
COMMUNITY_INSIGHTS = 'live_session'
COMMUNITY_ALERTING = 'dashboard'
COMMUNITY_ARTIFACTS = false
COMMUNITY_SOVEREIGN = false
```

---

## Pro — ~$9/mo

**Target user:** Individual operator or small team, unattended overnight monitoring, wants Slack pings when something breaks.

### Nodes
- Maximum 10 paired nodes
- Enforcement: checked at `/api/pair/activate` — reject if `node_count >= 10` and tier = Pro
- UI: 10-node cap with upgrade prompt
- **Node Naming & Tags** — Pro users can assign custom display names (e.g., "Primary-Inference-Node-1") and tags for fleet organization. Community users see hostname only.

### Metrics & History
- **7-day rolling history** stored in cloud Postgres
- All community metrics plus historical time series
- History enables trend-based insight cards and sparkline charts

### Custom Alert Thresholds
- Community alerts fire at default thresholds. Pro users can configure custom thresholds in Settings → Alerts:
  - WES floor (alert when WES drops below)
  - Temperature ceiling (alert when thermal state exceeds)
  - Memory pressure threshold (alert when memory pressure exceeds %)
- Per-node override: set different thresholds for different hardware profiles

### Insights
- **Persistent Cards** — insight cards survive session; state stored server-side (Clerk metadata or DB)
- Cards resurface on reconnect if condition still active
- All Community insight cards plus persistent state
- **Pattern Engine (6 Pro patterns):** D (Power-GPU Decoupling), E (Fleet Load Imbalance), G (Bandwidth Saturation), I (Efficiency Penalty Drag), L (PCIe Lane Degradation), M (vLLM KV Cache Saturation). These require multi-node fleet context, historical GPU data, or advanced sensor access. All 15 patterns available at Pro. Each carries `recommendation` + `action_id` for agent automation.
- Trend-based cards unlock *only* after 7 days of history accumulates:
  - NOT available at day 0 — cards show "Collecting history…" state
  - Available once history threshold met

### Alerting
- **Slack (Single channel)**
- One Slack workspace, one channel — configured via webhook URL input in Settings → Alerts
- Alert types delivered: Thermal Degradation, Power Anomaly, Model Eviction (imminent), Memory Exhaustion
- Alert types NOT included at Pro: Tok/s Regression (requires history analysis), PagerDuty, SIEM
- No per-node alert routing — all alerts go to the single configured channel
- UI: Settings → Alerts → Slack Webhook URL input field (enabled at Pro+)

### Fleet Intelligence
- Full view + alert delivery for: Thermal Diversity Score → Slack
- Fleet WES Leaderboard with 7-day trend sparklines

### Sovereignty
- **Cloud Relay** — same as Community
- Sovereignty audit log: view only

### Artifacts
- None
- History accessible via dashboard charts; no raw export at Pro tier

### API & Integrations
- All Community API features
- `/api/v1/insights/latest`: ❌ (Team+)
- MCP server: ❌ (Team+)

### Gating Constants (frontend)
```typescript
PRO_NODE_LIMIT = 10
PRO_HISTORY_DAYS = 7
PRO_KEEP_WARM = true
PRO_KEEP_WARM_LIMIT = 3             // up to 3 active nodes
PRO_INSIGHTS = 'persistent_cards'
PRO_ALERTING = 'slack_single'
PRO_ARTIFACTS = false
PRO_SOVEREIGN = false
```

---

## Team — ~$29/mo

**Target user:** Engineering team, on-call rotation, production inference fleet. Needs PagerDuty, trend analysis, and exportable data.

### Nodes
- **Unlimited** paired nodes
- No enforcement gate at activation
- UI: no upgrade prompt on node add

### Metrics & History
- **90-day rolling history** in cloud DuckDB
- Full time series for all metrics: WES, tok/s, watts, GPU%, thermal, cost/token
- History powers trend-based intelligence and regression detection

### Insights
- **Trend Analysis** — full historical intelligence layer
- All Pro persistent cards plus trend-based cards:
  - Memory Pressure Forecasting (projects exhaustion date from trajectory)
  - Tok/s Regression Detection (statistically significant throughput decline)
  - Quantization ROI Measurement (efficiency delta between model quantizations)
  - Efficiency Regression per Model (WES trend per loaded model)
  - Fleet Degradation Trend (fleet-wide WES moving average)
- Insights AI morning briefing: digest of fleet health emailed/Slacked at 08:00
- `/api/v1/insights/latest`: ✅ — agents can consume current intelligence state

### Alerting
- **Slack & PagerDuty**
- Multiple Slack channels: per-node routing, per-event-type routing
- PagerDuty service key integration for on-call escalation
- Alert types: all Pro types plus Tok/s Regression, Fleet Degradation, custom threshold alerts
- Per-node, per-event-type configuration in Settings → Alerts
- Alert threshold customization: operators set their own tok/s floor, watt ceiling, thermal state trigger level



### Fleet Intelligence
- Full access + alert delivery for all fleet cards
- Trend-based fleet analysis unlocked (degradation trend, efficiency regression)

### Sovereignty
- **Cloud Relay** — same as Community / Pro
- Sovereignty audit log: view only
- No airgapped mode

### Artifacts
- **CSV Exports**
- Any metric, any time range, any node — exported as CSV or JSON
- Available from Fleet Status table (export button) and any chart's context menu
- Endpoint: `GET /api/v1/export?nodes=...&metrics=...&from=...&to=...&format=csv`

### API & Integrations
- All Pro API features
- `/api/v1/insights/latest`: ✅
- MCP server tools: ✅ (`wicklee_fleet_status`, `wicklee_best_route`, `wicklee_wes_scores`, `wicklee_node_metrics`, `wicklee_insights`)

### Gating Constants (frontend)
```typescript
TEAM_NODE_LIMIT = Infinity
TEAM_HISTORY_DAYS = 90
TEAM_KEEP_WARM = 'all_nodes'
TEAM_INSIGHTS = 'trend_analysis'
TEAM_ALERTING = 'slack_pagerduty'
TEAM_ARTIFACTS = 'csv'
TEAM_SOVEREIGN = false
TEAM_MCP = true
TEAM_INSIGHTS_API = true
```

---

## Enterprise — ~$199/mo

**Target user:** Defense contractor, HIPAA-governed healthcare, financial institution, or any operator with a compliance requirement that data never leave their sovereign boundary.

> **The Enterprise differentiator is Sovereign Mode.** No outbound telemetry, no cloud pairing, no external network calls. The agent, dashboard, and backend all run on-premise. For every other tier, Wicklee routes telemetry through the cloud relay. Enterprise is the only tier where the cloud backend is optional — replaced by a self-hosted control plane on the operator's own infrastructure.

### Nodes
- **Unlimited** paired nodes
- Airgapped mode: no cloud pairing required — local-only fleet management

### Metrics & History
- **Custom / Audit Scope**
- Retention configured per deployment: 1 year, 3 years, indefinite
- Audit-scoped exports: timestamp-range exports aligned to compliance audit windows
- All Team history features included

### Insights
- **Predictive / Compliance**
- All Team trend analysis cards plus:
  - Predictive thermal failure modeling (time-to-failure projection from degradation curve)
  - Compliance posture scoring (data residency, egress events, audit trail completeness)
  - Anomaly detection with configurable sensitivity (tunable false-positive tolerance)
  - Custom insight rules: operator-defined conditions with webhook trigger
- Insights API: ✅ full access

### Alerting
- **SIEM / Webhooks**
- Webhook to any endpoint: custom payload, configurable retry policy
- SIEM integration: Splunk, Datadog, Elastic SIEM — event forwarding with structured JSON schema
- All Team alerting capabilities included
- Programmatic alert management via API

### Fleet Intelligence
- Full Team capabilities plus compliance-layer overlays
- Data residency map: visual indication of which nodes are forwarding vs. fully sovereign

### Sovereignty
- **Airgapped (Custom) — the key Enterprise differentiator**
- **Sovereign Mode:** no cloud pairing, no outbound telemetry, fully local operation
- On-premise Docker image + Helm chart for self-hosted fleet backend
- **Kubernetes Operator:** deploy the Wicklee control plane to an existing K8s cluster; fleet nodes register via in-cluster service discovery; no cloud relay, no external DNS
- Zero external network calls (agent + dashboard + backend all on-prem)
- Custom deployment: bare metal, private cloud, air-gapped VPC, K8s namespace
- Sovereignty audit log: full signed export

### Observability Integrations
- **Prometheus / Grafana Export:**
  - Wicklee exposes a `/metrics` endpoint in Prometheus exposition format
  - All WES, thermal, power, tok/s, and VRAM metrics available as labeled time series
  - Pre-built Grafana dashboard JSON for fleet WES trend, thermal cost heatmap, node ranking panel
  - Scraped by the operator's existing Prometheus instance — no Wicklee-specific sink required
  - See Prometheus schema in `docs/metrics.md`
- OpenTelemetry span export (planned): inference request traces with TTFT and TPOT labels

### Artifacts
- **Signed PDF Audits**
- Cryptographically signed PDF audit reports (CISO-ready compliance artifact)
- Report includes: node inventory, metric history, alert history, egress event log, data residency summary, cost allocation breakdown
- Endpoint: `POST /api/v1/audit/export` → returns signed PDF
- Signature: ECDSA with customer-provided or Wicklee-managed key

### API & Integrations
- All Team API features
- Sentinel Proxy routing (cross-node inference load balancer): ✅
- SSO / SAML: ✅ (Okta, Azure AD, Google Workspace)
- HIPAA / SOC2 BAA: ✅ (signed business associate agreement)
- Prometheus `/metrics` endpoint: ✅
- Kubernetes Operator: ✅
- Priority support + SLA: ✅

### Gating Constants (frontend)
```typescript
ENTERPRISE_NODE_LIMIT = Infinity
ENTERPRISE_HISTORY_DAYS = Infinity   // custom / audit scope
ENTERPRISE_KEEP_WARM = 'all_nodes'
ENTERPRISE_INSIGHTS = 'predictive_compliance'
ENTERPRISE_ALERTING = 'siem_webhooks'
ENTERPRISE_ARTIFACTS = 'signed_pdf'
ENTERPRISE_SOVEREIGN = true          // airgapped capable — the key differentiator
ENTERPRISE_PROMETHEUS = true         // /metrics Prometheus endpoint
ENTERPRISE_K8S_OPERATOR = true       // Kubernetes Operator deployment
ENTERPRISE_MCP = true
ENTERPRISE_INSIGHTS_API = true
ENTERPRISE_SENTINEL_PROXY = true
ENTERPRISE_SSO = true
```

---

## Gating Implementation Notes

### Clerk Metadata
Tier is stored in Clerk user public metadata: `{ "tier": "community" | "pro" | "team" | "enterprise" }`. Read in the frontend via `useUser().user.publicMetadata.tier`. Set by the Stripe webhook handler on subscription events.

### `usePermissions` Hook
`src/hooks/usePermissions.ts` should derive all gate booleans from the tier string. No hardcoded per-feature checks scattered across components — always go through `usePermissions`.

Example shape:
```typescript
interface Permissions {
  nodeLimit: number;
  historyDays: number;
  canKeepWarm: boolean;
  keepWarmNodeLimit: number | 'all';
  insightsTier: 'live_session' | 'persistent' | 'trend' | 'predictive';
  alertingTier: 'dashboard' | 'slack_single' | 'slack_pagerduty' | 'siem';
  canExportCsv: boolean;
  canExportSignedPdf: boolean;
  canUseMcp: boolean;
  canUseInsightsApi: boolean;
  canUseSentinelProxy: boolean;
  canGoSovereign: boolean;
  canManageTeam: boolean;         // Team+
  canViewScaffolding: boolean;    // existing gate
  canRunAIAnalysis: boolean;      // existing gate
}
```

### Upgrade Prompts
- **Node limit hit:** Inline banner on Add Node modal — "You've reached your X-node limit. Upgrade to [next tier] to add more nodes."
- **Locked feature:** Toggle rendered but disabled with lock icon; hover shows tier required.
- **Locked tab/card:** Gray overlay with "Available on [Tier]" and upgrade CTA.
- **No dark patterns:** Never block existing nodes retroactively if a user downgrades — grandfather in existing paired nodes until they are manually removed.

### Backend Enforcement
Node limit is enforced server-side at `/api/pair/activate` — client-side gates are UX only, not security. The backend reads tier from Clerk JWT claims.

---

## Upgrade Moments

| Moment | Upgrade Path |
|---|---|
| "Something broke overnight and I missed it" | Community → Pro (Slack alerts) |
| "I need to understand *why* tok/s dropped last week" | Pro → Team (90-day history + trend analysis) |
| "Our on-call rotation needs PagerDuty integration" | Pro → Team |
| "Compliance needs a signed audit trail" | Team → Enterprise |
| "We can't send any data to a cloud relay" | Any → Enterprise (Airgapped) |
| "We need SSO / SAML for procurement" | Any → Enterprise |

---

*Last updated: March 15, 2026. Source of truth for all subscription gating decisions.*
