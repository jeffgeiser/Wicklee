# Wicklee — Development Progress

## Recent Sessions

---

### Marketing — Hero Copy & Meta Tags
*1 commit — 5b4366f*

- **Headline**: "Local AI inference, finally observable." (gradient on "finally observable.")
- **Subheading**: "Routing intelligence. True inference cost. Thermal state. Live, across every node. Built for Ollama and vLLM. Install in 60 seconds — nothing to configure."
- **`index.html`**: Updated `<title>` and added `meta description`, `og:title`, `og:description`, `twitter:title`, `twitter:description` (all five meta tags were previously missing).

---

### Settings Page — Full Redesign (5 sections)
*1 commit — 23df820*

Ground-up rebuild of `SettingsView.tsx`. Auto-save throughout — no explicit Save button.

1. **Cost & Energy** — Fleet defaults (kWh rate, currency, PUE) with auto-save on blur/Enter, amber dirty-state borders, and live cost preview panel (100W reference node × PUE × kWh × 24/7 × 30.4 days).
2. **Node Configuration** — Per-node override table preserved with column-clear + apply-all; "Management →" quick link.
3. **Display & Units** — Radio groups for temperature (°C/°F), power (W/BTU), WES display (Auto/Fixed), theme (Dark/Light/System).
4. **Alerts & Notifications** — Phase 4A locked preview with four placeholder alert types, dimmed and non-interactive.
5. **Account & Data** — Agent version, fleet status pill, JSON export, danger zone with two-step confirm reset.

`useSettings.ts`: `FleetSettings` extended with `temperatureUnit`, `powerUnit`, `wesDisplay`, `themePreference`. `App.tsx`: SettingsView now receives `theme`, `onThemeChange`, `onNavigateToManagement`, `pairingInfo`.

---

### Management Page + Fleet Status — Responsive Layout & Bug Fixes
*5 commits — 249d1b5 ← 45bffc5*

1. **Management page full redesign** (`45bffc5`) — Complete rebuild of `NodesList.tsx`: 4 header tiles (Fleet VRAM, Connectivity, Hardware Mix, Lifecycle Alerts), 9-column CSS grid table, expandable DetailBand (Connectivity / Node Settings / Diagnostics), bulk actions bar. Removed per-node real-time metrics, Sovereignty Score tile, Provider Mix tile.
2. **Responsive column priority** (`73a912f`) — `MGMT_GRID_CLS` with Tailwind v3 arbitrary breakpoints; columns hide in priority tiers at 860/1024/1200px. Identity cell surfaces hidden columns via `title` tooltip.
3. **Connectivity panel** (`06abc43`) — Removed raw backend URL; replaced with "Data Destination: Wicklee Cloud / This device only".
4. **Fleet Status memory bugs** (`74a1eff`) — Memory % showing 15 decimal places → 1dp (`Math.round(v * 1000) / 10`); "memory —" empty state → "—".
5. **Responsive Fleet Status + permissions wrap** (`249d1b5`) — `FLEET_GRID_CLS` responsive grid with 4 breakpoint tiers; `FS_MODEL/WATTS/MEMORY` visibility classes; `whitespace-nowrap` on Permissions badge.

---

### Settings Page — Interaction Clarity & Alignment
*5 commits — d407ec3 ← 5570e60*

1. **Save flow** (`5570e60`) — Replaced auto-save (onBlur) with explicit dirty-state tracking. "Save Changes" button appears only when any Fleet Defaults field is modified. Enter key triggers save from number inputs. Inline "Saved ✓" indicator on commit. Added `clearAllNodeOverrides` to `useSettings`.

2. **Apply fleet defaults to all nodes** (`669d566`) — Secondary action below the save button: clears all per-node overrides atomically with a two-step inline confirm ("Remove all per-node overrides? Confirm / Cancel"). Shows brief "All overrides cleared ✓" on success. Column header sub-links renamed "Reset column to fleet default".

3. **Remove (fleet) repetition** (`8928e69`) — Removed `(fleet)` suffix from per-node cell placeholders. Trailing "Fleet defaults" chip appears on rows with no overrides. Overridden cells show high-contrast white; inheriting cells show muted placeholder.

4. **Fleet Defaults input alignment** (`c5df396`) — Helper/unit labels moved below inputs for all three fields: `$/kWh`, `Display only — no FX conversion`, `1.0 = home lab · 1.4–1.6 = datacenter/colo`. Consistent Inter `text-[10px]` micro-label style. Removed unused `FieldLabel` component.

5. **Row dividers & spacing** (`d407ec3`) — Stronger `divide-gray-100 dark:divide-gray-800` row dividers. Consistent `py-3` row height. Currency dropdown chevron vertical alignment fixed with `flex items-center` container. Location Label gets `max-w-[180px]` + `title` tooltip for long values.

---

### Sitewide Font Audit — font-telin
*1 commit — e36b328*

Replaced `font-mono` with `font-telin` across all data/identifier display contexts: telemetry values, node IDs, metric figures, inference stats, trace records, compliance values. Preserved `font-mono` only for legitimate code/terminal contexts (shell commands, API keys, pairing codes, URL `<code>` elements).

---

### Management Tab — NodeHardwarePanel Polish
*1 commit — eb304d5*

- Inference row: unified all elements to `text-xs`; dot separator between "Ollama" label and model name with `font-telin` for model/quant/size
- Hardware section: always expanded (removed toggle button and `useState`)
- Removed floating spec line (core count + VRAM text above tiles)

---

### Settings Page — 8-Item Polish Pass
*8 commits — b760f2d ← 2cb2f1e*

1. Table column widths and numeric right-alignment
2. Standardize input component family (consistent `INPUT_BASE` class)
3. Semantic icon badge colors for section headers
4. Table column header micro-label style
5. Amber row border + high-contrast overridden cell values
6. Green success state for "Set all to fleet default" column action
7. Replace fleet summary tile with Provider Mix tile (shows location label counts from live nodes; empty state links to Settings)
8. Inline "Saved ✓" indicator near Fleet Defaults fields

---

### Management Tab — Architecture Tile & Provider Mix
*1 commit — aa7ef00*

Refactored "OS Distribution" tile to "Architecture" with corrected heuristics: `cpu_power_w != null` → Apple Silicon, `nvidia_vram_total_mb != null` → NVIDIA, else Generic. Displays inline counts: `Apple: N · NVIDIA: N · Generic: N`.

---

### Management Tab — Node Detail Improvements
*1 commit — 028f4a2*

- Core Count moved into hardware panel as a `HudTile` under Compute
- Destination field removed from ComplianceBand; "Pairing Log" shifted left; 5 elements evenly spaced

---

### Settings Page — Initial Implementation
*1 commit — 937122c*

Full Settings page with Fleet Defaults (electricity rate, currency, PUE) and per-node override table. `useSettings` hook with `FleetSettings`, `NodeOverride`, `WickleeSettings`, `NodeEffectiveSettings` types. Persisted to `wicklee_settings` localStorage. Migrates legacy `wk_node_pue` data on first mount.

---

## Key Files

| File | Purpose |
|---|---|
| `src/hooks/useSettings.ts` | Fleet/node settings hook, localStorage persistence |
| `src/components/SettingsView.tsx` | Settings page UI — 5 sections, auto-save, display prefs |
| `src/components/LandingPage.tsx` | Marketing landing page (wicklee.dev) |
| `src/components/NodesList.tsx` | Management tab — node registry, responsive grid table |
| `src/components/NodeHardwarePanel.tsx` | Node detail hardware tile grid |
| `src/components/Overview.tsx` | Fleet Intelligence + Fleet Status with responsive grid |
| `src/App.tsx` | Root orchestrator — WebSocket, tab routing, settings wiring |
| `src/types.ts` | Shared TypeScript interfaces |
| `index.html` | App shell + meta/OG/Twitter tags |

---

## Phase Status

- **Phase 1** ✅ — Sentinel agent, SSE/WS telemetry, Apple Silicon + NVIDIA metrics, embedded frontend
- **Phase 2** 🔄 — NVIDIA/NVML support ✅, Fleet Connect ✅, pairing-state-driven UI mode ✅, Settings page ✅
