import React, { useState } from 'react';
import { Settings, Zap, MapPin, Check, X, ChevronDown } from 'lucide-react';
import type { NodeAgent } from '../types';
import {
  CURRENCY_OPTIONS, FLEET_DEFAULTS,
  type FleetSettings, type NodeOverride, type WickleeSettings, type NodeEffectiveSettings,
} from '../hooks/useSettings';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SettingsViewProps {
  nodes: NodeAgent[];
  settings: WickleeSettings;
  savedToast: boolean;
  getNodeSettings: (nodeId: string) => NodeEffectiveSettings;
  updateFleet: (patch: Partial<FleetSettings>) => void;
  setNodeOverride: (nodeId: string, patch: Partial<NodeOverride>) => void;
  clearAllOverridesForField: (field: 'kwhRate' | 'currency' | 'pue') => void;
}

// ── Section wrapper ───────────────────────────────────────────────────────────

const Section: React.FC<{
  title: string;
  icon: React.ElementType;
  iconBg: string;
  iconCls: string;
  children: React.ReactNode;
}> = ({ title, icon: Icon, iconBg, iconCls, children }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-sm dark:shadow-none overflow-hidden">
    <div className="flex items-center gap-2.5 px-6 py-4 border-b border-gray-100 dark:border-gray-800">
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded ${iconBg} shrink-0`}>
        <Icon size={11} className={iconCls} />
      </span>
      <h2 className="text-sm font-bold font-telin text-gray-900 dark:text-white tracking-tight">{title}</h2>
    </div>
    {children}
  </div>
);

// ── Field label ───────────────────────────────────────────────────────────────

const FieldLabel: React.FC<{ children: React.ReactNode; helper?: string }> = ({ children, helper }) => (
  <div>
    <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-0.5">{children}</p>
    {helper && <p className="text-[10px] text-gray-500">{helper}</p>}
  </div>
);

// ── Shared input classes ──────────────────────────────────────────────────────

const INPUT_BASE =
  'h-9 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 text-sm font-telin text-gray-900 dark:text-white focus:outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/30 transition-colors';

// ── Main component ─────────────────────────────────────────────────────────────

const SettingsView: React.FC<SettingsViewProps> = ({
  nodes,
  settings,
  savedToast,
  getNodeSettings,
  updateFleet,
  setNodeOverride,
  clearAllOverridesForField,
}) => {
  // Local draft for number inputs (save on blur)
  const [kwhDraft, setKwhDraft]  = useState(settings.fleet.kwhRate.toString());
  const [pueDraft,  setPueDraft] = useState(settings.fleet.pue.toString());

  // Confirm + success state for "Set all to fleet default"
  const [confirmClear, setConfirmClear] = useState<'kwhRate' | 'currency' | 'pue' | null>(null);
  const [successField, setSuccessField] = useState<'kwhRate' | 'currency' | 'pue' | null>(null);

  // ── Fleet defaults handlers ─────────────────────────────────────────────────

  const commitKwh = () => {
    const v = parseFloat(kwhDraft);
    if (!isNaN(v) && v >= 0) updateFleet({ kwhRate: Math.round(v * 10000) / 10000 });
    else setKwhDraft(settings.fleet.kwhRate.toString());
  };

  const commitPue = () => {
    const v = parseFloat(pueDraft);
    if (!isNaN(v) && v >= 1.0 && v <= 3.0) updateFleet({ pue: Math.round(v * 10) / 10 });
    else setPueDraft(settings.fleet.pue.toString());
  };

  // ── Clear column handlers ───────────────────────────────────────────────────

  const handleClearField = (field: 'kwhRate' | 'currency' | 'pue') => {
    if (confirmClear === field) {
      clearAllOverridesForField(field);
      setConfirmClear(null);
      setSuccessField(field);
      setTimeout(() => setSuccessField(f => f === field ? null : f), 1000);
    } else {
      setConfirmClear(field);
    }
  };

  const confirmText = (field: 'kwhRate' | 'currency' | 'pue') => {
    if (field === 'kwhRate')  return `Clear all kWh rate overrides? Nodes will use $${settings.fleet.kwhRate}/kWh.`;
    if (field === 'currency') return `Clear all currency overrides? Nodes will use ${settings.fleet.currency}.`;
    return `Clear all PUE overrides? Nodes will use PUE ${settings.fleet.pue.toFixed(1)}.`;
  };


  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-300 pb-12">

      {/* Page title */}
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-sm text-gray-500">Fleet defaults and per-node energy configuration.</p>
      </div>

      {/* ── Fleet Defaults ──────────────────────────────────────────────────── */}
      <Section title="Fleet Defaults" icon={Zap} iconBg="bg-amber-500/10" iconCls="text-amber-400">
        <div className="px-6 py-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">

            {/* Electricity Rate */}
            <div className="space-y-1.5">
              <FieldLabel>Electricity Rate</FieldLabel>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={kwhDraft}
                  onChange={e => setKwhDraft(e.target.value)}
                  onBlur={commitKwh}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  className={`${INPUT_BASE} w-28 tabular-nums`}
                />
                <span className="text-xs text-gray-500 shrink-0">$/kWh</span>
              </div>
            </div>

            {/* Currency */}
            <div className="space-y-1.5">
              <FieldLabel>Currency</FieldLabel>
              <div className="relative">
                <select
                  value={settings.fleet.currency}
                  onChange={e => updateFleet({ currency: e.target.value as FleetSettings['currency'] })}
                  className={`${INPUT_BASE} w-full appearance-none pr-7`}
                >
                  {CURRENCY_OPTIONS.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              </div>
            </div>

            {/* PUE */}
            <div className="space-y-1.5">
              <FieldLabel
                helper="1.0 = home lab  ·  1.4–1.6 = datacenter/colo"
              >
                PUE Multiplier
              </FieldLabel>
              <input
                type="number"
                min="1.0"
                max="3.0"
                step="0.1"
                value={pueDraft}
                onChange={e => setPueDraft(e.target.value)}
                onBlur={commitPue}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                className={`${INPUT_BASE} w-24 tabular-nums`}
              />
            </div>
          </div>

          <p className="text-[11px] text-gray-500 border-t border-gray-100 dark:border-gray-800 pt-4">
            These values apply to all nodes. Override any setting per-node below for nodes in different locations or energy markets.
          </p>
        </div>
      </Section>

      {/* ── Node Overrides ──────────────────────────────────────────────────── */}
      <Section title="Node Overrides" icon={MapPin} iconBg="bg-indigo-500/10" iconCls="text-indigo-400">
        {nodes.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-gray-500">
              No nodes paired yet — node overrides will appear here once your first node is connected.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            {/* Table */}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800">
                  <th className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 w-24">Node ID</th>
                  <th className="text-left px-3 py-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 w-24">Hostname</th>
                  <th className="text-left px-3 py-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 w-[180px]">Location Label</th>
                  <th className="text-right px-3 py-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 w-32">
                    <div>kWh Rate</div>
                    <ClearColumnButton
                      label="Set all to fleet default"
                      field="kwhRate"
                      confirmClear={confirmClear}
                      successField={successField}
                      confirmText={confirmText('kwhRate')}
                      onConfirm={() => handleClearField('kwhRate')}
                      onCancel={() => setConfirmClear(null)}
                    />
                  </th>
                  <th className="text-left px-3 py-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 w-28">
                    <div>Currency</div>
                    <ClearColumnButton
                      label="Set all to fleet default"
                      field="currency"
                      confirmClear={confirmClear}
                      successField={successField}
                      confirmText={confirmText('currency')}
                      onConfirm={() => handleClearField('currency')}
                      onCancel={() => setConfirmClear(null)}
                    />
                  </th>
                  <th className="text-right px-3 py-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 w-24">
                    <div>PUE</div>
                    <ClearColumnButton
                      label="Set all to fleet default"
                      field="pue"
                      confirmClear={confirmClear}
                      successField={successField}
                      confirmText={confirmText('pue')}
                      onConfirm={() => handleClearField('pue')}
                      onCancel={() => setConfirmClear(null)}
                    />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800/50">
                {nodes.map(node => {
                  const eff = getNodeSettings(node.id);
                  const ov  = settings.nodes[node.id] ?? {};
                  return (
                    <NodeOverrideRow
                      key={node.id}
                      node={node}
                      eff={eff}
                      ov={ov}
                      fleetSettings={settings.fleet}
                      onOverride={(patch) => setNodeOverride(node.id, patch)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Saved toast ─────────────────────────────────────────────────────── */}
      {savedToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-gray-900 border border-gray-700/80 rounded-xl shadow-xl shadow-black/40 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <Check size={13} className="text-green-400 shrink-0" />
          <span className="text-xs font-semibold text-gray-200">Saved</span>
        </div>
      )}
    </div>
  );
};

// ── Clear-column button with inline confirm ───────────────────────────────────

const ClearColumnButton: React.FC<{
  label: string;
  field: 'kwhRate' | 'currency' | 'pue';
  confirmClear: 'kwhRate' | 'currency' | 'pue' | null;
  successField: 'kwhRate' | 'currency' | 'pue' | null;
  confirmText: string;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ label, field, confirmClear, successField, confirmText, onConfirm, onCancel }) => {
  if (successField === field) {
    return (
      <div className="flex items-center gap-1 mt-1">
        <Check size={9} className="text-green-400" />
        <span className="text-[9px] font-semibold text-green-400">Reset</span>
      </div>
    );
  }
  if (confirmClear === field) {
    return (
      <div className="mt-1 space-y-1">
        <p className="text-[9px] text-amber-500 leading-tight max-w-[140px]">{confirmText}</p>
        <div className="flex items-center gap-2">
          <button onClick={onConfirm} className="text-[9px] font-semibold text-red-400 hover:text-red-300 transition-colors">Confirm</button>
          <button onClick={onCancel}  className="text-[9px] text-gray-500 hover:text-gray-300 transition-colors">Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <button
      onClick={onConfirm}
      className="block mt-1 text-[9px] text-gray-500 hover:text-indigo-400 transition-colors"
    >
      {label}
    </button>
  );
};

// ── Node override row ─────────────────────────────────────────────────────────

const NodeOverrideRow: React.FC<{
  node: NodeAgent;
  eff: NodeEffectiveSettings;
  ov: NodeOverride;
  fleetSettings: FleetSettings;
  onOverride: (patch: Partial<NodeOverride>) => void;
}> = ({ node, eff, ov, fleetSettings, onOverride }) => {
  const [kwhDraft, setKwhDraft] = useState(ov.kwhRate?.toString() ?? '');
  const [pueDraft,  setPueDraft] = useState(ov.pue?.toString()  ?? '');

  React.useEffect(() => { setKwhDraft(ov.kwhRate?.toString() ?? ''); }, [ov.kwhRate]);
  React.useEffect(() => { setPueDraft(ov.pue?.toString()  ?? ''); }, [ov.pue]);

  const commitKwh = () => {
    const v = parseFloat(kwhDraft);
    if (kwhDraft === '') { onOverride({ kwhRate: undefined }); }
    else if (!isNaN(v) && v >= 0) { onOverride({ kwhRate: v }); }
    else { setKwhDraft(ov.kwhRate?.toString() ?? ''); }
  };

  const commitPue = () => {
    const v = parseFloat(pueDraft);
    if (pueDraft === '') { onOverride({ pue: undefined }); }
    else if (!isNaN(v) && v >= 1.0 && v <= 3.0) { onOverride({ pue: v }); }
    else { setPueDraft(ov.pue?.toString() ?? ''); }
  };

  // Overridden values → high-contrast white; inheriting fleet default → muted
  const valCls  = (active: boolean) => active
    ? 'text-gray-900 dark:text-white'
    : 'text-gray-400 dark:text-gray-500';
  const cellBase = 'w-full bg-transparent border-0 outline-none text-xs font-telin tabular-nums placeholder-gray-400 dark:placeholder-gray-600';

  return (
    <tr className={`hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition-colors ${eff.hasAnyOverride ? 'border-l-2 border-amber-400/40' : 'border-l-2 border-transparent'}`}>

      {/* Node ID — ◆ indicator when any override active */}
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          {eff.hasAnyOverride && (
            <span className="text-amber-400 text-[9px] shrink-0" title="This node has custom overrides">◆</span>
          )}
          <span className="text-xs font-telin font-bold text-gray-900 dark:text-white truncate">{node.id}</span>
        </div>
      </td>

      {/* Hostname */}
      <td className="px-3 py-2.5">
        <span className="text-xs font-telin text-gray-500 truncate block">{node.hostname || '—'}</span>
      </td>

      {/* Location Label */}
      <td className="px-3 py-2.5">
        <input
          type="text"
          value={ov.locationLabel ?? ''}
          onChange={e => onOverride({ locationLabel: e.target.value || undefined })}
          placeholder="e.g. Home lab, Hetzner Frankfurt, Vast.ai US-East"
          className={`${cellBase} ${valCls(!!ov.locationLabel)}`}
        />
      </td>

      {/* kWh Rate */}
      <td className="px-3 py-2.5 text-right">
        <input
          type="number"
          min="0"
          step="0.01"
          value={kwhDraft}
          onChange={e => setKwhDraft(e.target.value)}
          onBlur={commitKwh}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          placeholder={`${fleetSettings.kwhRate} (fleet)`}
          className={`${cellBase} text-right ${valCls(eff.kwhRateOverride)}`}
        />
      </td>

      {/* Currency */}
      <td className="px-3 py-2.5">
        <div className="relative">
          <select
            value={ov.currency ?? ''}
            onChange={e => onOverride({ currency: e.target.value as NodeOverride['currency'] || undefined })}
            className={`${cellBase} appearance-none cursor-pointer pr-5 ${valCls(eff.currencyOverride)}`}
          >
            <option value="">{fleetSettings.currency} (fleet)</option>
            {CURRENCY_OPTIONS.map(c => (
              <option key={c.value} value={c.value}>{c.value}</option>
            ))}
          </select>
          <ChevronDown size={10} className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 text-gray-400" />
        </div>
      </td>

      {/* PUE */}
      <td className="px-3 py-2.5 text-right">
        <input
          type="number"
          min="1.0"
          max="3.0"
          step="0.1"
          value={pueDraft}
          onChange={e => setPueDraft(e.target.value)}
          onBlur={commitPue}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          placeholder={`${fleetSettings.pue.toFixed(1)} (fleet)`}
          className={`${cellBase} text-right ${valCls(eff.pueOverride)}`}
        />
      </td>
    </tr>
  );
};

export default SettingsView;
