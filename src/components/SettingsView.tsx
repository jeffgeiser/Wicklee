import React, { useState } from 'react';
import { Zap, MapPin, Check, ChevronDown, Monitor, Bell, User, Download, Lock } from 'lucide-react';
import type { NodeAgent, PairingInfo } from '../types';
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
  clearAllNodeOverrides: () => void;
  theme: 'light' | 'dark';
  onThemeChange: (t: 'dark' | 'light' | 'system') => void;
  onNavigateToManagement: () => void;
  pairingInfo: PairingInfo | null;
}

// ── Section ───────────────────────────────────────────────────────────────────

const Section: React.FC<{
  id: string;
  title: string;
  icon: React.ElementType;
  iconBg: string;
  iconCls: string;
  children: React.ReactNode;
}> = ({ id, title, icon: Icon, iconBg, iconCls, children }) => (
  <div id={id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-sm dark:shadow-none overflow-hidden scroll-mt-6">
    <div className="flex items-center gap-2.5 px-6 py-4 border-b border-gray-100 dark:border-gray-800">
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded ${iconBg} shrink-0`}>
        <Icon size={11} className={iconCls} />
      </span>
      <h2 className="text-sm font-bold text-gray-900 dark:text-white tracking-tight">{title}</h2>
    </div>
    {children}
  </div>
);

// ── RadioGroup ────────────────────────────────────────────────────────────────

const RadioGroup: React.FC<{
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}> = ({ label, options, value, onChange }) => (
  <div className="space-y-2">
    <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{label}</p>
    <div className="flex items-center gap-1 flex-wrap">
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
            value === opt.value
              ? 'bg-indigo-600 border-indigo-600 text-white'
              : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-indigo-400/50 hover:text-indigo-400'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  </div>
);

// ── Shared input classes ──────────────────────────────────────────────────────

const INPUT_BASE =
  'h-9 bg-gray-50 dark:bg-gray-800 border rounded-lg px-3 text-sm font-telin text-gray-900 dark:text-white focus:outline-none focus:ring-1 transition-colors';

const inputCls = (dirty: boolean) =>
  dirty
    ? `${INPUT_BASE} border-amber-400/60 dark:border-amber-400/50 focus:border-amber-400/60 focus:ring-amber-400/20`
    : `${INPUT_BASE} border-gray-200 dark:border-gray-700 focus:border-indigo-500/60 focus:ring-indigo-500/30`;

// ── Main component ─────────────────────────────────────────────────────────────

const SettingsView: React.FC<SettingsViewProps> = ({
  nodes,
  settings,
  savedToast,
  getNodeSettings,
  updateFleet,
  setNodeOverride,
  clearAllOverridesForField,
  clearAllNodeOverrides,
  theme,
  onThemeChange,
  onNavigateToManagement,
  pairingInfo,
}) => {
  // ── Fleet defaults drafts (numbers need validation before commit) ───────────
  const [kwhDraft, setKwhDraft] = useState(settings.fleet.kwhRate.toString());
  const [pueDraft, setPueDraft] = useState(settings.fleet.pue.toString());

  React.useEffect(() => { setKwhDraft(settings.fleet.kwhRate.toString()); }, [settings.fleet.kwhRate]);
  React.useEffect(() => { setPueDraft(settings.fleet.pue.toString()); }, [settings.fleet.pue]);

  const kwhDirty = kwhDraft !== settings.fleet.kwhRate.toString();
  const pueDirty = pueDraft !== settings.fleet.pue.toString();

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

  // ── Live cost preview ──────────────────────────────────────────────────────
  const draftKwh = parseFloat(kwhDraft);
  const draftPue = parseFloat(pueDraft);
  const effKwh = !isNaN(draftKwh) && draftKwh >= 0 ? draftKwh : settings.fleet.kwhRate;
  const effPue = !isNaN(draftPue) && draftPue >= 1  ? draftPue : settings.fleet.pue;
  const currSymbol = CURRENCY_OPTIONS.find(c => c.value === settings.fleet.currency)?.symbol ?? '$';
  // 100W node, 24/7, 30.4 days/month
  const monthlyCost100W = (100 / 1000) * effPue * 24 * 30.4 * effKwh;

  // ── Column clear state ─────────────────────────────────────────────────────
  const [confirmClear, setConfirmClear] = useState<'kwhRate' | 'currency' | 'pue' | null>(null);
  const [successField, setSuccessField] = useState<'kwhRate' | 'currency' | 'pue' | null>(null);

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
    if (field === 'kwhRate')  return `Reset all kWh overrides? Nodes will use ${currSymbol}${settings.fleet.kwhRate}/kWh.`;
    if (field === 'currency') return `Reset all currency overrides? Nodes will use ${settings.fleet.currency}.`;
    return `Reset all PUE overrides? Nodes will use PUE ${settings.fleet.pue.toFixed(1)}.`;
  };

  // ── Apply fleet defaults to all nodes ─────────────────────────────────────
  const [confirmApplyAll, setConfirmApplyAll] = useState(false);
  const [applyAllDone, setApplyAllDone] = useState(false);
  const overrideNodeCount = nodes.filter(n => getNodeSettings(n.id).hasAnyOverride).length;

  const handleApplyAll = () => {
    if (confirmApplyAll) {
      clearAllNodeOverrides();
      setConfirmApplyAll(false);
      setApplyAllDone(true);
      setTimeout(() => setApplyAllDone(false), 1800);
    } else {
      setConfirmApplyAll(true);
    }
  };

  // ── Danger zone ────────────────────────────────────────────────────────────
  const [confirmReset, setConfirmReset] = useState(false);
  const handleResetAll = () => {
    if (confirmReset) {
      updateFleet({ ...FLEET_DEFAULTS });
      clearAllNodeOverrides();
      setConfirmReset(false);
    } else {
      setConfirmReset(true);
    }
  };

  // ── Export settings ────────────────────────────────────────────────────────
  const handleExport = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wicklee-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Theme preference ───────────────────────────────────────────────────────
  // settings.fleet.themePreference is the stored value; fall back to current effective theme
  const themePreference: string = settings.fleet.themePreference ?? theme;

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-300 pb-12">

      {/* Page title */}
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-sm text-gray-500">Fleet defaults, node configuration, and display preferences.</p>
      </div>

      {/* ── ① COST & ENERGY ─────────────────────────────────────────────── */}
      <Section id="cost-energy" title="Cost & Energy" icon={Zap} iconBg="bg-amber-500/10" iconCls="text-amber-400">
        <div className="px-6 py-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">

            {/* Electricity Rate */}
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Electricity Rate</p>
              <input
                type="number" min="0" step="0.01"
                value={kwhDraft}
                onChange={e => setKwhDraft(e.target.value)}
                onBlur={commitKwh}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                className={`${inputCls(kwhDirty)} w-28 tabular-nums`}
              />
              <p className="text-[10px] text-gray-500">$/kWh</p>
            </div>

            {/* Currency */}
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Currency</p>
              <div className="relative">
                <select
                  value={settings.fleet.currency}
                  onChange={e => updateFleet({ currency: e.target.value as FleetSettings['currency'] })}
                  className={`${inputCls(false)} w-full appearance-none pr-7`}
                >
                  {CURRENCY_OPTIONS.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              </div>
              <p className="text-[10px] text-gray-500">Display only — no FX conversion</p>
            </div>

            {/* PUE */}
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">PUE Multiplier</p>
              <input
                type="number" min="1.0" max="3.0" step="0.1"
                value={pueDraft}
                onChange={e => setPueDraft(e.target.value)}
                onBlur={commitPue}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                className={`${inputCls(pueDirty)} w-24 tabular-nums`}
              />
              <p className="text-[10px] text-gray-500">1.0 = home lab · 1.4–1.6 = datacenter/colo</p>
            </div>
          </div>

          {/* Live cost preview */}
          <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-800 px-4 py-3">
            <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
              Cost Preview · 100 W node · 24/7
            </p>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold font-telin text-gray-900 dark:text-white">
                {currSymbol}{monthlyCost100W.toFixed(2)}
              </span>
              <span className="text-xs text-gray-500">/month</span>
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
              {currSymbol}{effKwh.toFixed(4)}/kWh · PUE {effPue.toFixed(1)}
            </p>
          </div>

          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            These values apply to all nodes. Override any setting per-node in Node Configuration below.
          </p>
        </div>
      </Section>

      {/* ── ② NODE CONFIGURATION ─────────────────────────────────────────── */}
      <Section id="node-configuration" title="Node Configuration" icon={MapPin} iconBg="bg-indigo-500/10" iconCls="text-indigo-400">
        {nodes.length === 0 ? (
          <div className="px-6 py-12 text-center space-y-2">
            <p className="text-sm text-gray-500">No nodes connected yet.</p>
            <button
              onClick={onNavigateToManagement}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Go to Management →
            </button>
          </div>
        ) : (
          <div>
            {/* Controls bar */}
            <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-4 flex-wrap border-b border-gray-100 dark:border-gray-800">
              <div className="flex items-center gap-1.5">
                <span className="text-amber-400 text-[9px]">◆</span>
                <span className="text-[9px] text-gray-400 dark:text-gray-500">= custom override active</span>
              </div>
              <div className="flex items-center gap-3">
                {applyAllDone ? (
                  <span className="flex items-center gap-1 text-[10px] text-green-400">
                    <Check size={9} /> All overrides cleared
                  </span>
                ) : confirmApplyAll ? (
                  <span className="flex items-center gap-2">
                    <span className="text-[10px] text-amber-500">
                      Reset {overrideNodeCount} node{overrideNodeCount !== 1 ? 's' : ''}?
                    </span>
                    <button onClick={handleApplyAll} className="text-[10px] font-semibold text-red-400 hover:text-red-300 transition-colors">Confirm</button>
                    <button onClick={() => setConfirmApplyAll(false)} className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">Cancel</button>
                  </span>
                ) : (
                  <button
                    onClick={handleApplyAll}
                    disabled={overrideNodeCount === 0}
                    className="text-[10px] text-gray-500 hover:text-indigo-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    Apply fleet defaults to all nodes
                  </button>
                )}
                <button
                  onClick={onNavigateToManagement}
                  className="text-[10px] text-gray-500 hover:text-indigo-400 transition-colors"
                >
                  Management →
                </button>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <th className="text-left px-4 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-24">Node ID</th>
                    <th className="text-left px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-24">Hostname</th>
                    <th className="text-left px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-[180px]">Location Label</th>
                    <th className="text-right px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-32">
                      <div>kWh Rate</div>
                      <ClearColumnButton
                        label="Reset"
                        field="kwhRate"
                        confirmClear={confirmClear}
                        successField={successField}
                        confirmText={confirmText('kwhRate')}
                        onConfirm={() => handleClearField('kwhRate')}
                        onCancel={() => setConfirmClear(null)}
                      />
                    </th>
                    <th className="text-left px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-28">
                      <div>Currency</div>
                      <ClearColumnButton
                        label="Reset"
                        field="currency"
                        confirmClear={confirmClear}
                        successField={successField}
                        confirmText={confirmText('currency')}
                        onConfirm={() => handleClearField('currency')}
                        onCancel={() => setConfirmClear(null)}
                      />
                    </th>
                    <th className="text-right px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-24">
                      <div>PUE</div>
                      <ClearColumnButton
                        label="Reset"
                        field="pue"
                        confirmClear={confirmClear}
                        successField={successField}
                        confirmText={confirmText('pue')}
                        onConfirm={() => handleClearField('pue')}
                        onCancel={() => setConfirmClear(null)}
                      />
                    </th>
                    <th className="w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
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
          </div>
        )}
      </Section>

      {/* ── ③ DISPLAY & UNITS ────────────────────────────────────────────── */}
      <Section id="display-units" title="Display & Units" icon={Monitor} iconBg="bg-blue-500/10" iconCls="text-blue-400">
        <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <RadioGroup
            label="Temperature"
            options={[
              { value: 'C', label: '°C  Celsius' },
              { value: 'F', label: '°F  Fahrenheit' },
            ]}
            value={settings.fleet.temperatureUnit}
            onChange={v => updateFleet({ temperatureUnit: v as 'C' | 'F' })}
          />
          <RadioGroup
            label="Power Display"
            options={[
              { value: 'W',   label: 'Watts' },
              { value: 'BTU', label: 'BTU/hr' },
            ]}
            value={settings.fleet.powerUnit}
            onChange={v => updateFleet({ powerUnit: v as 'W' | 'BTU' })}
          />
          <RadioGroup
            label="WES Display"
            options={[
              { value: 'auto',  label: 'Auto  (mWES / WES)' },
              { value: 'fixed', label: 'Fixed  (WES)' },
            ]}
            value={settings.fleet.wesDisplay}
            onChange={v => updateFleet({ wesDisplay: v as 'auto' | 'fixed' })}
          />
          <RadioGroup
            label="Theme"
            options={[
              { value: 'dark',   label: 'Dark' },
              { value: 'light',  label: 'Light' },
              { value: 'system', label: 'System' },
            ]}
            value={themePreference}
            onChange={v => {
              updateFleet({ themePreference: v as 'dark' | 'light' | 'system' });
              onThemeChange(v as 'dark' | 'light' | 'system');
            }}
          />
        </div>
      </Section>

      {/* ── ④ ALERTS & NOTIFICATIONS ─────────────────────────────────────── */}
      <Section id="alerts" title="Alerts & Notifications" icon={Bell} iconBg="bg-rose-500/10" iconCls="text-rose-400">
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider shrink-0 mt-0.5">
              <Lock size={9} /> Phase 4A
            </span>
            <p className="text-xs text-gray-500">
              Alert rules and notification channels are coming in the next major release.
            </p>
          </div>
          <div className="space-y-2 opacity-40 pointer-events-none select-none">
            {[
              { label: 'Thermal threshold',  desc: 'Alert when any node exceeds a set temperature' },
              { label: 'Node offline',        desc: 'Alert when a node stops reporting telemetry' },
              { label: 'High power draw',     desc: 'Alert when fleet power exceeds a wattage budget' },
              { label: 'Cost overrun',        desc: 'Alert when projected monthly cost exceeds a limit' },
            ].map(item => (
              <div
                key={item.label}
                className="flex items-center justify-between px-4 py-3 rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40"
              >
                <div>
                  <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{item.label}</p>
                  <p className="text-[10px] text-gray-500">{item.desc}</p>
                </div>
                <div className="w-8 h-4 rounded-full bg-gray-200 dark:bg-gray-700 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── ⑤ ACCOUNT & DATA ─────────────────────────────────────────────── */}
      <Section id="account" title="Account & Data" icon={User} iconBg="bg-gray-500/10" iconCls="text-gray-400">
        <div className="px-6 py-5 space-y-5">

          {/* Version & Fleet Status */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Agent Version</p>
              <p className="text-sm font-telin text-gray-900 dark:text-white">v0.4.5</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Fleet Status</p>
              {pairingInfo?.status === 'connected' ? (
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                  <p className="text-sm font-telin text-green-400">Connected</p>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-600 shrink-0" />
                  <p className="text-sm font-telin text-gray-500 dark:text-gray-400">Local mode</p>
                </div>
              )}
            </div>
          </div>

          {/* Export */}
          <div className="flex items-center justify-between py-4 border-t border-gray-100 dark:border-gray-800">
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Export Settings</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Download your fleet and node settings as JSON.</p>
            </div>
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 hover:border-indigo-400/50 hover:text-indigo-400 transition-colors"
            >
              <Download size={11} /> Export
            </button>
          </div>

          {/* Danger zone */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-500/70 mb-3">Danger Zone</p>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Reset all settings</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Restore fleet defaults and clear all node overrides.</p>
              </div>
              {confirmReset ? (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-amber-500">This cannot be undone.</span>
                  <button
                    onClick={handleResetAll}
                    className="px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[10px] font-semibold text-rose-400 hover:bg-rose-500/20 transition-colors"
                  >
                    Confirm Reset
                  </button>
                  <button
                    onClick={() => setConfirmReset(false)}
                    className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmReset(true)}
                  className="shrink-0 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-500 hover:border-rose-500/40 hover:text-rose-400 transition-colors"
                >
                  Reset defaults
                </button>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* Saved toast */}
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

  const [savedCell, setSavedCell] = useState<'kwh' | 'pue' | 'curr' | 'loc' | null>(null);
  const flashSaved = (cell: 'kwh' | 'pue' | 'curr' | 'loc') => {
    setSavedCell(cell);
    setTimeout(() => setSavedCell(c => c === cell ? null : c), 1500);
  };

  const commitKwh = () => {
    const v = parseFloat(kwhDraft);
    if (kwhDraft === '') { onOverride({ kwhRate: undefined }); flashSaved('kwh'); }
    else if (!isNaN(v) && v >= 0) { onOverride({ kwhRate: v }); flashSaved('kwh'); }
    else { setKwhDraft(ov.kwhRate?.toString() ?? ''); }
  };

  const commitPue = () => {
    const v = parseFloat(pueDraft);
    if (pueDraft === '') { onOverride({ pue: undefined }); flashSaved('pue'); }
    else if (!isNaN(v) && v >= 1.0 && v <= 3.0) { onOverride({ pue: v }); flashSaved('pue'); }
    else { setPueDraft(ov.pue?.toString() ?? ''); }
  };

  const valCls  = (active: boolean) => active ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-gray-500';
  const cellBase = 'w-full bg-transparent border-0 outline-none text-xs font-telin tabular-nums placeholder-gray-400 dark:placeholder-gray-600';

  const SavedMark = () => (
    <span className="flex items-center gap-0.5 animate-in fade-in duration-150 shrink-0">
      <Check size={9} className="text-green-400" />
      <span className="text-[9px] text-green-400">Saved</span>
    </span>
  );

  return (
    <tr className={`hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition-colors ${eff.hasAnyOverride ? 'border-l-2 border-amber-400/40' : 'border-l-2 border-transparent'}`}>

      {/* Node ID */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          {eff.hasAnyOverride && (
            <span className="text-amber-400 text-[9px] shrink-0" title="This node has custom overrides">◆</span>
          )}
          <span className="text-xs font-telin font-bold text-gray-900 dark:text-white truncate">{node.id}</span>
        </div>
      </td>

      {/* Hostname */}
      <td className="px-3 py-3">
        <span className="text-xs font-telin text-gray-500 truncate block">{node.hostname || '—'}</span>
      </td>

      {/* Location Label */}
      <td className="px-3 py-3 max-w-[180px]">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={ov.locationLabel ?? ''}
            onChange={e => { onOverride({ locationLabel: e.target.value || undefined }); flashSaved('loc'); }}
            placeholder="e.g. Home lab, Hetzner Frankfurt"
            title={ov.locationLabel ?? ''}
            className={`${cellBase} truncate ${valCls(!!ov.locationLabel)}`}
          />
          {savedCell === 'loc' && <SavedMark />}
        </div>
      </td>

      {/* kWh Rate */}
      <td className="px-3 py-3 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {savedCell === 'kwh' && <SavedMark />}
          <input
            type="number" min="0" step="0.01"
            value={kwhDraft}
            onChange={e => setKwhDraft(e.target.value)}
            onBlur={commitKwh}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder={fleetSettings.kwhRate.toString()}
            className={`${cellBase} text-right tabular-nums ${valCls(eff.kwhRateOverride)}`}
          />
        </div>
      </td>

      {/* Currency */}
      <td className="px-3 py-3">
        <div className="flex items-center gap-1.5">
          <div className="relative flex items-center min-w-0 flex-1">
            <select
              value={ov.currency ?? ''}
              onChange={e => { onOverride({ currency: e.target.value as NodeOverride['currency'] || undefined }); flashSaved('curr'); }}
              className={`${cellBase} appearance-none cursor-pointer pr-5 ${valCls(eff.currencyOverride)}`}
            >
              <option value="">{fleetSettings.currency}</option>
              {CURRENCY_OPTIONS.map(c => (
                <option key={c.value} value={c.value}>{c.value}</option>
              ))}
            </select>
            <ChevronDown size={10} className="pointer-events-none absolute right-0.5 text-gray-400 shrink-0" />
          </div>
          {savedCell === 'curr' && <SavedMark />}
        </div>
      </td>

      {/* PUE */}
      <td className="px-3 py-3 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {savedCell === 'pue' && <SavedMark />}
          <input
            type="number" min="1.0" max="3.0" step="0.1"
            value={pueDraft}
            onChange={e => setPueDraft(e.target.value)}
            onBlur={commitPue}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder={fleetSettings.pue.toFixed(1)}
            className={`${cellBase} text-right tabular-nums ${valCls(eff.pueOverride)}`}
          />
        </div>
      </td>

      {/* Fleet defaults chip */}
      <td className="px-3 py-3 text-right">
        {!eff.hasAnyOverride && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 whitespace-nowrap">
            Fleet defaults
          </span>
        )}
      </td>
    </tr>
  );
};

export default SettingsView;
