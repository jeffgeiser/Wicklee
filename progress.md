# Wicklee — Development Progress

## Recent Sessions

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
| `src/components/SettingsView.tsx` | Settings page UI — fleet defaults + node override table |
| `src/components/NodesList.tsx` | Management tab — node registry, hardware panel, provider mix |
| `src/components/NodeHardwarePanel.tsx` | Node detail hardware tile grid |
| `src/App.tsx` | Root orchestrator — WebSocket, tab routing, settings wiring |
| `src/types.ts` | Shared TypeScript interfaces |

---

## Phase Status

- **Phase 1** ✅ — Sentinel agent, SSE/WS telemetry, Apple Silicon + NVIDIA metrics, embedded frontend
- **Phase 2** 🔄 — NVIDIA/NVML support ✅, Fleet Connect ✅, pairing-state-driven UI mode ✅, Settings page ✅
