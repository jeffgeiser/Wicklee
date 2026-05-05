import React, { useState, useEffect, useCallback } from 'react';
import { version as pkgVersion } from '../../package.json';
import { Zap, MapPin, Check, ChevronDown, Monitor, Bell, User, Download, Plus, Trash2, Send, AlertTriangle, Slack, Mail, Lock, Key, ChevronRight, Globe } from 'lucide-react';
import type { NodeAgent, PairingInfo, SentinelMetrics } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';
import WebhooksSection from './settings/WebhooksSection';
import {
  CURRENCY_OPTIONS, FLEET_DEFAULTS,
  type FleetSettings, type NodeOverride, type WickleeSettings, type NodeEffectiveSettings,
} from '../hooks/useSettings';

// ── Cloud URL (matches WESHistoryChart pattern) ────────────────────────────────

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL as string) ?? '';
  if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
  if (v === '/') return '';
  return v.startsWith('http') ? v : `https://${v}`;
})();

// ── Alert types ────────────────────────────────────────────────────────────────

interface AlertChannel {
  id: string;
  channel_type: 'slack' | 'email';
  name: string;
  config_json: string;
  verified: boolean;
  created_at: number;
}

interface AlertRule {
  id: string;
  node_id: string | null;
  event_type: string;
  threshold_value: number | null;
  urgency: string;
  channel_id: string;
  enabled: boolean;
  created_at: number;
}

const EVENT_TYPES: { value: string; label: string; hasThreshold: boolean; thresholdLabel?: string; defaultThreshold?: number }[] = [
  { value: 'thermal_serious',      label: 'Thermal — Serious or Critical',  hasThreshold: false },
  { value: 'thermal_critical',     label: 'Thermal — Critical only',         hasThreshold: false },
  { value: 'node_offline',         label: 'Node offline (>5 min)',           hasThreshold: false },
  { value: 'memory_pressure_high', label: 'Memory pressure high',            hasThreshold: true, thresholdLabel: '% threshold', defaultThreshold: 85 },
  { value: 'wes_drop',             label: 'WES drops below threshold',       hasThreshold: true, thresholdLabel: 'Min WES',     defaultThreshold: 5  },
  { value: 'ttft_regression',      label: 'TTFT exceeds threshold',          hasThreshold: true, thresholdLabel: 'Max TTFT (ms)', defaultThreshold: 500 },
  { value: 'throughput_low',       label: 'Throughput drops below threshold', hasThreshold: true, thresholdLabel: 'Min tok/s',   defaultThreshold: 5  },
];

const URGENCY_OPTIONS = [
  { value: 'immediate',    label: 'Immediate' },
  { value: 'debounce_5m',  label: '5-min debounce' },
  { value: 'debounce_15m', label: '15-min debounce' },
];

// ── useAlerts hook ─────────────────────────────────────────────────────────────

function useAlerts(getToken: (() => Promise<string | null>) | undefined, isCloudMode: boolean) {
  const [channels, setChannels]   = useState<AlertChannel[]>([]);
  const [rules,    setRules]      = useState<AlertRule[]>([]);
  const [loading,  setLoading]    = useState(false);
  const [error,    setError]      = useState<string | null>(null);

  const authFetch = useCallback(async (path: string, opts?: RequestInit) => {
    if (!getToken) return null;
    const token = await getToken();
    if (!token) return null;
    const res = await fetch(`${CLOUD_URL}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    return res.json();
  }, [getToken]);

  const refresh = useCallback(async () => {
    if (!isCloudMode) return;
    setLoading(true);
    setError(null);
    try {
      const [cRes, rRes] = await Promise.all([
        authFetch('/api/alerts/channels'),
        authFetch('/api/alerts/rules'),
      ]);
      setChannels(cRes?.channels ?? []);
      setRules(rRes?.rules ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [authFetch, isCloudMode]);

  useEffect(() => { refresh(); }, [refresh]);

  const createChannel = useCallback(async (channel_type: string, name: string, config_json: string) => {
    await authFetch('/api/alerts/channels', { method: 'POST', body: JSON.stringify({ channel_type, name, config_json }) });
    await refresh();
  }, [authFetch, refresh]);

  const deleteChannel = useCallback(async (id: string) => {
    await authFetch(`/api/alerts/channels/${id}`, { method: 'DELETE' });
    await refresh();
  }, [authFetch, refresh]);

  const testChannel = useCallback(async (id: string): Promise<string> => {
    try {
      await authFetch(`/api/alerts/channels/${id}/test`, { method: 'POST' });
      return 'ok';
    } catch (e) {
      return (e as Error).message;
    }
  }, [authFetch]);

  const createRule = useCallback(async (payload: {
    node_id: string | null; event_type: string;
    threshold_value: number | null; urgency: string; channel_id: string;
  }) => {
    await authFetch('/api/alerts/rules', { method: 'POST', body: JSON.stringify(payload) });
    await refresh();
  }, [authFetch, refresh]);

  const deleteRule = useCallback(async (id: string) => {
    await authFetch(`/api/alerts/rules/${id}`, { method: 'DELETE' });
    await refresh();
  }, [authFetch, refresh]);

  return { channels, rules, loading, error, refresh, createChannel, deleteChannel, testChannel, createRule, deleteRule };
}

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
  onNavigateToApiKeys?: () => void;
  onNavigateToPricing?: () => void;
  pairingInfo: PairingInfo | null;
  getToken?: () => Promise<string | null>;
  subscriptionTier?: string;
  isLocalHost?: boolean;
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
  <div id={id} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-sm dark:shadow-none overflow-hidden scroll-mt-6">
    <div className="flex items-center gap-2.5 px-6 py-4 border-b border-gray-100 dark:border-gray-700">
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
              : 'bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-indigo-400/50 hover:text-indigo-400'
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
  'h-9 bg-gray-50 dark:bg-gray-700 border rounded-lg px-3 text-sm font-telin text-gray-900 dark:text-white focus:outline-none focus:ring-1 transition-colors';

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
  onNavigateToApiKeys,
  onNavigateToPricing,
  pairingInfo,
  getToken,
  subscriptionTier = 'community',
  isLocalHost = false,
}) => {
  const isCloudMode = (import.meta.env.VITE_BUILD_TARGET as string) !== 'agent';
  const { allNodeMetrics } = useFleetStream();

  // ── Fleet defaults drafts (numbers need validation before commit) ───────────
  const [kwhDraft, setKwhDraft] = useState(settings.fleet.kwhRate.toString());
  const [pueDraft, setPueDraft] = useState(settings.fleet.pue.toString());

  React.useEffect(() => { setKwhDraft(settings.fleet.kwhRate.toString()); }, [settings.fleet.kwhRate]);
  React.useEffect(() => { setPueDraft(settings.fleet.pue.toString()); }, [settings.fleet.pue]);

  const kwhDirty = kwhDraft !== settings.fleet.kwhRate.toString();
  const pueDirty = pueDraft !== settings.fleet.pue.toString();

  // Save display name to cloud backend (Pro+ only)
  const isProOrAbove = subscriptionTier === 'pro' || subscriptionTier === 'team' || subscriptionTier === 'enterprise';
  const saveDisplayNameToCloud = React.useCallback(async (nodeId: string, name: string) => {
    if (!isProOrAbove || !isCloudMode || !getToken) return;
    try {
      const token = await getToken();
      if (!token) return;
      await fetch(`${CLOUD_URL}/api/nodes/${nodeId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name.trim() || null }),
      });
    } catch { /* best-effort sync */ }
  }, [isProOrAbove, isCloudMode, getToken]);

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
  type ClearableField = 'kwhRate' | 'currency' | 'pue' | 'systemIdleW';
  const [confirmClear, setConfirmClear] = useState<ClearableField | null>(null);
  const [successField, setSuccessField] = useState<ClearableField | null>(null);

  const handleClearField = (field: ClearableField) => {
    if (confirmClear === field) {
      clearAllOverridesForField(field);
      setConfirmClear(null);
      setSuccessField(field);
      setTimeout(() => setSuccessField(f => f === field ? null : f), 1000);
    } else {
      setConfirmClear(field);
    }
  };

  const confirmText = (field: ClearableField) => {
    if (field === 'kwhRate')      return `Reset all kWh overrides? Nodes will use ${currSymbol}${settings.fleet.kwhRate}/kWh.`;
    if (field === 'currency')     return `Reset all currency overrides? Nodes will use ${settings.fleet.currency}.`;
    if (field === 'systemIdleW')  return `Reset all Idle W overrides? Nodes will use 0 W.`;
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

          {/* Reference cost benchmark */}
          <div className="rounded-xl bg-gray-50 dark:bg-gray-700/60 border border-gray-100 dark:border-gray-700 px-4 py-3">
            <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
              Reference Benchmark · 100W node running 24/7
            </p>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold font-telin text-gray-900 dark:text-white">
                {currSymbol}{monthlyCost100W.toFixed(2)}
              </span>
              <span className="text-xs text-gray-500">/month</span>
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
              {currSymbol}{effKwh.toFixed(4)}/kWh · PUE {effPue.toFixed(1)} · hypothetical reference cost
            </p>
            <p className="text-[10px] text-gray-600 mt-1">
              Your actual fleet cost is shown on the Intelligence tab based on live power draw.
            </p>
          </div>

          {/* Localhost: single-node idle power setting (cloud uses per-node table) */}
          {!isCloudMode && nodes.length > 0 && (() => {
            const localNodeId = nodes[0].id;
            const localOv = settings.nodes[localNodeId] ?? {};
            const localIdleW = localOv.systemIdleW ?? 0;
            return (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">System Idle Power (Wall)</p>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min="0" step="1"
                    defaultValue={localIdleW || ''}
                    onBlur={e => {
                      const v = parseFloat(e.target.value);
                      if (e.target.value === '' || isNaN(v)) {
                        setNodeOverride(localNodeId, { systemIdleW: undefined });
                      } else if (v >= 0) {
                        setNodeOverride(localNodeId, { systemIdleW: v });
                      }
                    }}
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    placeholder="0"
                    className={`${inputCls(localIdleW > 0)} w-24 tabular-nums`}
                  />
                  <span className="text-[10px] text-gray-500">watts</span>
                </div>
                <p className="text-[10px] text-gray-500">
                  System idle draw at the wall. Added to accelerator power for total cost estimates.
                </p>
              </div>
            );
          })()}

          {isCloudMode && (
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              These values apply to all nodes. Override any setting per-node in Node Configuration below.
            </p>
          )}
        </div>
      </Section>

      {/* ── ② NODE CONFIGURATION (Cloud only — per-node overrides) ─────── */}
      {isCloudMode && <Section id="node-configuration" title="Node Configuration" icon={MapPin} iconBg="bg-indigo-500/10" iconCls="text-indigo-400">
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
            <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-4 flex-wrap border-b border-gray-100 dark:border-gray-700">
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
                  <tr className="border-b border-gray-100 dark:border-gray-700">
                    <th className="text-left px-4 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-24">Node ID</th>
                    <th className="text-left px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-24">Hostname</th>
                    <th className="text-left px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-[180px]">Display Name</th>
                    <th className="text-right px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-32">
                      <div>kWh Rate</div>
                      <ClearColumnButton
                        label="Reset"
                        field="kwhRate"
                        align="right"
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
                        align="right"
                        confirmClear={confirmClear}
                        successField={successField}
                        confirmText={confirmText('pue')}
                        onConfirm={() => handleClearField('pue')}
                        onCancel={() => setConfirmClear(null)}
                      />
                    </th>
                    <th className="text-right px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-24">
                      <div title="System idle power at the wall (watts). Added to accelerator power for cost estimates.">Idle W</div>
                      <ClearColumnButton
                        label="Reset"
                        field="systemIdleW"
                        align="right"
                        confirmClear={confirmClear}
                        successField={successField}
                        confirmText={confirmText('systemIdleW')}
                        onConfirm={() => handleClearField('systemIdleW')}
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
                        onSaveDisplayName={saveDisplayNameToCloud}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>}

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
        </div>
      </Section>

      {/* ── ④ ALERTS & NOTIFICATIONS ─────────────────────────────────────── */}
      <AlertsSection
        pairingInfo={pairingInfo}
        subscriptionTier={subscriptionTier}
        getToken={getToken}
        nodes={nodes}
        onNavigateToPricing={onNavigateToPricing}
      />

      {/* ── ④¾ THRESHOLD WEBHOOKS (Pro+) ─────────────────────────────────── */}
      {isCloudMode && (
        <WebhooksSection
          subscriptionTier={subscriptionTier}
          getToken={getToken}
          nodes={nodes.map(n => ({ node_id: n.id, hostname: n.hostname }))}
          onNavigateToPricing={onNavigateToPricing}
        />
      )}

      {/* ── ④½ API KEYS ───────────────────────────────────────────────────── */}
      {isCloudMode && (
        <Section id="api-keys" title="API Keys" icon={Key} iconBg="bg-cyan-500/10" iconCls="text-cyan-400">
          <div className="px-6 py-5 space-y-4">
            <p className="text-xs text-gray-500 leading-relaxed">
              API keys authenticate programmatic access to the Fleet API v1 — routing recommendations, fleet status, WES leaderboard, and intelligence findings.
            </p>
            <div className="flex items-center gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/40">
              <Key size={16} className="text-cyan-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-gray-200">Manage API Keys</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Create, view, and revoke keys for the Fleet API v1.</p>
              </div>
              <button
                onClick={() => onNavigateToApiKeys?.()}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-xs font-semibold text-white transition-colors shrink-0"
              >
                Open <ChevronRight size={12} />
              </button>
            </div>
            <div className="text-[10px] text-gray-600 font-mono space-y-1">
              <p>GET /api/v1/fleet · GET /api/v1/fleet/wes · GET /api/v1/nodes/:id</p>
              <p>GET /api/v1/route/best · GET /api/v1/insights/latest</p>
            </div>
          </div>
        </Section>
      )}

      {/* ── ④¾ OPENTELEMETRY EXPORT ───────────────────────────────────── */}
      {isCloudMode && (subscriptionTier === 'team' || subscriptionTier === 'enterprise') && (
        <OtelExportSection getToken={getToken} />
      )}

      {/* ── ⑤ ACCOUNT & DATA ─────────────────────────────────────────────── */}
      <Section id="account" title="Account & Data" icon={User} iconBg="bg-gray-500/10" iconCls="text-gray-400">
        <div className="px-6 py-5 space-y-5">

          {/* Version & Fleet Status */}
          {(() => {
            // Compute agent version display from live metrics
            const metricsArr: SentinelMetrics[] = Object.values(allNodeMetrics);
            const versions = metricsArr
              .map(m => m.agent_version)
              .filter((v): v is string => !!v);
            const uniqueVersions = [...new Set(versions)];
            const majorityVersion = uniqueVersions.length > 0
              ? uniqueVersions.reduce((a, b) =>
                  versions.filter(v => v === a).length >= versions.filter(v => v === b).length ? a : b
                )
              : (import.meta.env.VITE_AGENT_VERSION as string | undefined) ?? pkgVersion;
            const isMixed = uniqueVersions.length > 1;
            const outdatedNodes = isMixed
              ? metricsArr
                  .filter(m => m.agent_version && m.agent_version !== majorityVersion)
                  .map(m => m.hostname ?? m.node_id)
              : [];

            // Fleet status
            const onlineCount = nodes.filter(n => n.status === 'online').length;
            const totalCount = nodes.length;
            const isCloud = !isLocalHost && totalCount > 0;

            return (
              <div className="grid grid-cols-3 gap-6">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Agent Version</p>
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-telin text-gray-900 dark:text-white">v{majorityVersion}</p>
                    {isMixed && (
                      <span
                        className="text-[9px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded cursor-help"
                        title={`Version mismatch: ${outdatedNodes.join(', ')} running different versions`}
                      >
                        Mixed
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Fleet Status</p>
                  {isCloud ? (
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                      <p className="text-sm font-telin text-green-400">
                        Connected: {onlineCount} of {totalCount} active
                      </p>
                    </div>
                  ) : pairingInfo?.status === 'connected' ? (
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
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Storage</p>
                  <p className="text-sm font-telin text-gray-500 dark:text-gray-400">
                    {isCloud ? 'Managed Postgres' : 'Local Store'}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* Export */}
          <div className="flex items-center justify-between py-4 border-t border-gray-100 dark:border-gray-700">
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
          <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
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
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-gray-800 border border-gray-700/80 rounded-xl shadow-xl shadow-black/40 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <Check size={13} className="text-green-400 shrink-0" />
          <span className="text-xs font-semibold text-gray-200">Saved</span>
        </div>
      )}
    </div>
  );
};

// ── Alerts & Notifications section ───────────────────────────────────────────

const AlertsSection: React.FC<{
  pairingInfo: PairingInfo | null;
  subscriptionTier: string;
  getToken?: () => Promise<string | null>;
  nodes: NodeAgent[];
  onNavigateToPricing?: () => void;
}> = ({ pairingInfo: _pairingInfo, subscriptionTier, getToken, nodes, onNavigateToPricing }) => {
  // Cloud mode = any build that isn't the embedded agent binary (localhost:7700).
  // pairingInfo.status tracks whether a local node is paired — irrelevant here.
  // On wicklee.dev the user is already in the fleet regardless of local pairing state.
  const isCloudMode    = (import.meta.env.VITE_BUILD_TARGET as string) !== 'agent';
  const isProOrAbove   = subscriptionTier === 'pro' || subscriptionTier === 'team' || subscriptionTier === 'enterprise';
  const isTeam         = subscriptionTier === 'team' || subscriptionTier === 'enterprise';
  const { channels, rules, loading, error, createChannel, deleteChannel, testChannel, createRule, deleteRule } =
    useAlerts(getToken, isCloudMode && isProOrAbove);

  // ── Channel form state ────────────────────────────────────────────────────
  const [showChanForm,  setShowChanForm]  = useState(false);
  const [chanType,      setChanType]      = useState<'slack' | 'email' | 'pagerduty'>('slack');
  const [chanName,      setChanName]      = useState('');
  const [chanValue,     setChanValue]     = useState('');  // webhook URL or email
  const [chanSaving,    setChanSaving]    = useState(false);
  const [chanError,     setChanError]     = useState<string | null>(null);

  // ── Rule form state ───────────────────────────────────────────────────────
  const [showRuleForm,  setShowRuleForm]  = useState(false);
  const [ruleEventType, setRuleEventType] = useState(EVENT_TYPES[0].value);
  const [ruleChannelId, setRuleChannelId] = useState('');
  const [ruleNodeId,    setRuleNodeId]    = useState('');    // '' = fleet-wide
  const [ruleUrgency,   setRuleUrgency]   = useState('immediate');
  const [ruleThreshold, setRuleThreshold] = useState('');
  const [ruleSaving,    setRuleSaving]    = useState(false);
  const [ruleError,     setRuleError]     = useState<string | null>(null);

  // ── Test state per channel ────────────────────────────────────────────────
  const [testState, setTestState] = useState<Record<string, 'idle' | 'sending' | 'ok' | 'fail'>>({});

  const selectedEventType = EVENT_TYPES.find(e => e.value === ruleEventType)!;

  const handleAddChannel = async () => {
    if (!chanName.trim() || !chanValue.trim()) return;
    setChanSaving(true);
    setChanError(null);
    try {
      const configJson = chanType === 'slack'
        ? JSON.stringify({ webhook_url: chanValue.trim() })
        : chanType === 'pagerduty'
        ? JSON.stringify({ routing_key: chanValue.trim() })
        : JSON.stringify({ address: chanValue.trim() });
      await createChannel(chanType, chanName.trim(), configJson);
      setChanName(''); setChanValue(''); setShowChanForm(false);
    } catch (e) {
      setChanError((e as Error).message);
    } finally {
      setChanSaving(false);
    }
  };

  const handleAddRule = async () => {
    if (!ruleChannelId) return;
    setRuleSaving(true);
    setRuleError(null);
    try {
      await createRule({
        node_id:         ruleNodeId || null,
        event_type:      ruleEventType,
        threshold_value: selectedEventType.hasThreshold && ruleThreshold
          ? parseFloat(ruleThreshold) : null,
        urgency:         ruleUrgency,
        channel_id:      ruleChannelId,
      });
      setShowRuleForm(false);
      setRuleThreshold('');
    } catch (e) {
      setRuleError((e as Error).message);
    } finally {
      setRuleSaving(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestState(s => ({ ...s, [id]: 'sending' }));
    const result = await testChannel(id);
    setTestState(s => ({ ...s, [id]: result === 'ok' ? 'ok' : 'fail' }));
    setTimeout(() => setTestState(s => ({ ...s, [id]: 'idle' })), 3000);
  };

  const chanNameForId = (id: string) =>
    channels.find(c => c.id === id)?.name ?? id.slice(0, 8);

  const eventLabel = (et: string) =>
    EVENT_TYPES.find(e => e.value === et)?.label ?? et;

  // ── Locked — not connected to fleet ───────────────────────────────────────
  if (!isCloudMode) {
    return (
      <Section id="alerts" title="Alerts & Notifications" icon={Bell} iconBg="bg-rose-500/10" iconCls="text-rose-400">
        <div className="px-6 py-8 flex flex-col items-center gap-3 text-center">
          <Lock size={20} className="text-gray-600" />
          <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">Fleet connection required</p>
          <p className="text-xs text-gray-500 max-w-xs">
            Alerts are configured and delivered via the cloud dashboard at <strong className="text-gray-400">wicklee.dev</strong>. Connect this node to your fleet, then set up notification channels and alert rules from the cloud Settings tab.
          </p>
          <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-indigo-400 bg-indigo-500/10 border-indigo-500/20 mt-1">
            Pro feature
          </span>
        </div>
      </Section>
    );
  }

  // ── Locked — Community tier ───────────────────────────────────────────────
  if (!isProOrAbove) {
    return (
      <Section id="alerts" title="Alerts & Notifications" icon={Bell} iconBg="bg-rose-500/10" iconCls="text-rose-400">
        <div className="px-6 py-6 space-y-4">
          <div className="rounded-xl bg-indigo-500/5 border border-indigo-500/20 px-5 py-4 flex items-start gap-3">
            <Bell size={14} className="text-indigo-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-xs font-semibold text-gray-200">Alerts & Notifications — Pro+</p>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Custom alert thresholds, Slack notifications, and stateful alerting. Pro: single Slack channel with custom thresholds. Team: unlimited channels + PagerDuty.
              </p>
            </div>
          </div>
          <div className="space-y-2 opacity-40 pointer-events-none select-none">
            {EVENT_TYPES.map(et => (
              <div key={et.value} className="flex items-center justify-between px-4 py-3 rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/40">
                <div>
                  <p className="text-xs font-semibold text-gray-300">{et.label}</p>
                </div>
                <div className="w-8 h-4 rounded-full bg-gray-700 shrink-0" />
              </div>
            ))}
          </div>
          <button
            onClick={() => onNavigateToPricing?.()}
            className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
          >
            Upgrade to Pro — $9/mo
          </button>
        </div>
      </Section>
    );
  }

  // Pro channel limit: 1 Slack channel. Team+: unlimited.
  const channelLimit = isTeam ? Infinity : 1;
  const canAddChannel = channels.length < channelLimit;

  // ── Full UI — Pro+ ─────────────────────────────────────────────────────────
  return (
    <Section id="alerts" title="Alerts & Notifications" icon={Bell} iconBg="bg-rose-500/10" iconCls="text-rose-400">
      <div className="divide-y divide-gray-100 dark:divide-gray-800">

        {error && (
          <div className="px-6 py-3 flex items-center gap-2 bg-rose-500/5 border-b border-rose-500/20">
            <AlertTriangle size={12} className="text-rose-400 shrink-0" />
            <p className="text-xs text-rose-400">{error}</p>
          </div>
        )}

        {/* ── Notification Channels ─────────────────────────────────────── */}
        <div className="px-6 py-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">Notification Channels</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Where alerts are delivered — Slack webhook or email address.</p>
            </div>
            <button
              onClick={() => { setShowChanForm(v => !v); setChanError(null); }}
              disabled={!canAddChannel}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                canAddChannel
                  ? 'border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400/50 hover:text-indigo-400'
                  : 'border-gray-700 text-gray-600 cursor-not-allowed'
              }`}
              title={canAddChannel ? undefined : 'Pro plan: 1 channel max. Upgrade to Team for unlimited.'}
            >
              <Plus size={11} /> {canAddChannel ? 'Add channel' : 'Channel limit reached'}
            </button>
          </div>

          {/* Add channel form */}
          {showChanForm && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/60 p-4 space-y-3">
              {/* Type toggle */}
              <div className="flex items-center gap-2">
                {(['slack', 'email', ...(isTeam ? ['pagerduty' as const] : [])] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => { setChanType(t as typeof chanType); setChanValue(''); }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      chanType === t
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400/50 hover:text-indigo-400'
                    }`}
                  >
                    {t === 'slack' ? <Slack size={11} /> : t === 'pagerduty' ? <Bell size={11} /> : <Mail size={11} />}
                    {t === 'slack' ? 'Slack Webhook' : t === 'pagerduty' ? 'PagerDuty' : 'Email'}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Name</label>
                  <input
                    type="text"
                    value={chanName}
                    onChange={e => setChanName(e.target.value)}
                    placeholder="e.g. Ops Slack"
                    className={`${INPUT_BASE} border-gray-200 dark:border-gray-700 focus:border-indigo-500/60 focus:ring-indigo-500/30 w-full`}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                    {chanType === 'slack' ? 'Webhook URL' : chanType === 'pagerduty' ? 'Integration Key (Routing Key)' : 'Email address'}
                  </label>
                  <input
                    type={chanType === 'email' ? 'email' : 'text'}
                    value={chanValue}
                    onChange={e => setChanValue(e.target.value)}
                    placeholder={chanType === 'slack' ? 'https://hooks.slack.com/...' : 'ops@example.com'}
                    className={`${INPUT_BASE} border-gray-200 dark:border-gray-700 focus:border-indigo-500/60 focus:ring-indigo-500/30 w-full font-telin text-xs`}
                  />
                </div>
              </div>
              {chanError && <p className="text-[10px] text-rose-400">{chanError}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAddChannel}
                  disabled={chanSaving || !chanName.trim() || !chanValue.trim()}
                  className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-semibold text-white transition-colors"
                >
                  {chanSaving ? 'Saving…' : 'Save channel'}
                </button>
                <button onClick={() => setShowChanForm(false)} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Channel list */}
          {loading && channels.length === 0 ? (
            <p className="text-xs text-gray-500 py-2">Loading…</p>
          ) : channels.length === 0 ? (
            <p className="text-[11px] text-gray-500 py-1">No channels configured yet. Add one above to start receiving alerts.</p>
          ) : (
            <div className="space-y-2">
              {channels.map(ch => {
                const ts = testState[ch.id] ?? 'idle';
                const cfg = JSON.parse(ch.config_json ?? '{}');
                const detail = ch.channel_type === 'slack'
                  ? (cfg.webhook_url as string ?? '').replace('https://hooks.slack.com/services/', '…/services/')
                  : ch.channel_type === 'pagerduty'
                  ? `…${((cfg.routing_key as string) ?? '').slice(-8)}`
                  : cfg.address ?? '';
                return (
                  <div key={ch.id} className="flex items-center justify-between px-4 py-3 rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-700/30 gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {ch.channel_type === 'slack'
                        ? <Slack size={13} className="text-indigo-400 shrink-0" />
                        : ch.channel_type === 'pagerduty'
                        ? <Bell  size={13} className="text-green-400 shrink-0" />
                        : <Mail  size={13} className="text-blue-400 shrink-0" />}
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-gray-200 truncate">{ch.name}</p>
                        <p className="text-[10px] text-gray-500 font-telin truncate">{detail}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleTest(ch.id)}
                        disabled={ts === 'sending'}
                        title="Send a test notification"
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                          ts === 'ok'   ? 'border-green-500/40 text-green-400 bg-green-500/5' :
                          ts === 'fail' ? 'border-rose-500/40 text-rose-400 bg-rose-500/5' :
                          'border-gray-700 text-gray-500 hover:border-indigo-400/50 hover:text-indigo-400'
                        }`}
                      >
                        {ts === 'sending' ? '…' : ts === 'ok' ? <><Check size={9} /> Sent</> : ts === 'fail' ? 'Failed' : <><Send size={9} /> Test</>}
                      </button>
                      <button
                        onClick={() => deleteChannel(ch.id)}
                        className="p-1 rounded text-gray-600 hover:text-rose-400 transition-colors"
                        title="Delete channel"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Alert Rules ───────────────────────────────────────────────── */}
        <div className="px-6 py-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">Alert Rules</p>
              <p className="text-[10px] text-gray-500 mt-0.5">When to fire and where to send. One rule per event type + channel pair.</p>
            </div>
            <button
              onClick={() => { setShowRuleForm(v => !v); setRuleError(null); if (channels.length > 0) setRuleChannelId(channels[0].id); }}
              disabled={channels.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-500 hover:border-indigo-400/50 hover:text-indigo-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <Plus size={11} /> Add rule
            </button>
          </div>

          {/* Add rule form */}
          {showRuleForm && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/60 p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Event type */}
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Event</label>
                  <div className="relative">
                    <select
                      value={ruleEventType}
                      onChange={e => { setRuleEventType(e.target.value); setRuleThreshold(''); }}
                      className={`${INPUT_BASE} border-gray-200 dark:border-gray-700 focus:border-indigo-500/60 focus:ring-indigo-500/30 w-full appearance-none pr-7`}
                    >
                      {EVENT_TYPES.map(et => <option key={et.value} value={et.value}>{et.label}</option>)}
                    </select>
                    <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </div>

                {/* Channel */}
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Send to</label>
                  <div className="relative">
                    <select
                      value={ruleChannelId}
                      onChange={e => setRuleChannelId(e.target.value)}
                      className={`${INPUT_BASE} border-gray-200 dark:border-gray-700 focus:border-indigo-500/60 focus:ring-indigo-500/30 w-full appearance-none pr-7`}
                    >
                      {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </div>

                {/* Node scope */}
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Node scope</label>
                  <div className="relative">
                    <select
                      value={ruleNodeId}
                      onChange={e => setRuleNodeId(e.target.value)}
                      className={`${INPUT_BASE} border-gray-200 dark:border-gray-700 focus:border-indigo-500/60 focus:ring-indigo-500/30 w-full appearance-none pr-7`}
                    >
                      <option value="">Fleet-wide (any node)</option>
                      {nodes.map(n => <option key={n.id} value={n.id}>{n.id}{n.hostname ? ` · ${n.hostname}` : ''}</option>)}
                    </select>
                    <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </div>

                {/* Urgency */}
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Urgency</label>
                  <div className="relative">
                    <select
                      value={ruleUrgency}
                      onChange={e => setRuleUrgency(e.target.value)}
                      className={`${INPUT_BASE} border-gray-200 dark:border-gray-700 focus:border-indigo-500/60 focus:ring-indigo-500/30 w-full appearance-none pr-7`}
                    >
                      {URGENCY_OPTIONS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                    </select>
                    <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </div>

                {/* Threshold — only shown when event type uses it */}
                {selectedEventType.hasThreshold && (
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                      {selectedEventType.thresholdLabel}
                    </label>
                    <input
                      type="number"
                      value={ruleThreshold}
                      onChange={e => setRuleThreshold(e.target.value)}
                      placeholder={selectedEventType.defaultThreshold?.toString()}
                      className={`${INPUT_BASE} border-gray-200 dark:border-gray-700 focus:border-indigo-500/60 focus:ring-indigo-500/30 w-full tabular-nums`}
                    />
                  </div>
                )}
              </div>
              {ruleError && <p className="text-[10px] text-rose-400">{ruleError}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAddRule}
                  disabled={ruleSaving || !ruleChannelId}
                  className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-semibold text-white transition-colors"
                >
                  {ruleSaving ? 'Saving…' : 'Save rule'}
                </button>
                <button onClick={() => setShowRuleForm(false)} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Rules list */}
          {rules.length === 0 ? (
            <p className="text-[11px] text-gray-500 py-1">No rules yet. Add a channel first, then create a rule to start receiving alerts.</p>
          ) : (
            <div className="space-y-2">
              {rules.map(rule => (
                <div key={rule.id} className="flex items-center justify-between px-4 py-3 rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-700/30 gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-gray-200">{eventLabel(rule.event_type)}</span>
                      {rule.threshold_value != null && (
                        <span className="text-[10px] font-telin text-amber-400">@ {rule.threshold_value}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-gray-500">
                      <span>{rule.node_id ?? 'Fleet-wide'}</span>
                      <span>·</span>
                      <span>{URGENCY_OPTIONS.find(u => u.value === rule.urgency)?.label ?? rule.urgency}</span>
                      <span>·</span>
                      <span className="text-indigo-400/70">{chanNameForId(rule.channel_id)}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    className="p-1 rounded text-gray-600 hover:text-rose-400 transition-colors shrink-0"
                    title="Delete rule"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </Section>
  );
};

// ── Clear-column button with inline confirm ───────────────────────────────────

type ClearableFieldType = 'kwhRate' | 'currency' | 'pue' | 'systemIdleW';

const ClearColumnButton: React.FC<{
  label: string;
  field: ClearableFieldType;
  confirmClear: ClearableFieldType | null;
  successField: ClearableFieldType | null;
  confirmText: string;
  align?: 'left' | 'right';
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ label, field, confirmClear, successField, confirmText, align = 'left', onConfirm, onCancel }) => {
  const justifyClass = align === 'right' ? 'justify-end' : 'justify-start';
  if (successField === field) {
    return (
      <div className={`flex items-center gap-1 mt-1 ${justifyClass}`}>
        <Check size={9} className="text-green-400" />
        <span className="text-[9px] font-semibold text-green-400">Reset</span>
      </div>
    );
  }
  if (confirmClear === field) {
    return (
      <div className="mt-1 space-y-1">
        <p className={`text-[9px] text-amber-500 leading-tight max-w-[140px] ${align === 'right' ? 'text-right' : ''}`}>{confirmText}</p>
        <div className={`flex items-center gap-2 ${justifyClass}`}>
          <button onClick={onConfirm} className="text-[9px] font-semibold text-red-400 hover:text-red-300 transition-colors">Confirm</button>
          <button onClick={onCancel}  className="text-[9px] text-gray-500 hover:text-gray-300 transition-colors">Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <button
      onClick={onConfirm}
      className={`block w-full mt-1 text-[9px] text-gray-500 hover:text-indigo-400 transition-colors ${align === 'right' ? 'text-right' : 'text-left'}`}
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
  onSaveDisplayName?: (nodeId: string, name: string) => void;
}> = ({ node, eff, ov, fleetSettings, onOverride, onSaveDisplayName }) => {
  const [kwhDraft,  setKwhDraft]  = useState(ov.kwhRate?.toString() ?? '');
  const [pueDraft,  setPueDraft]  = useState(ov.pue?.toString()  ?? '');
  const [idleDraft, setIdleDraft] = useState(ov.systemIdleW?.toString() ?? '');

  React.useEffect(() => { setKwhDraft(ov.kwhRate?.toString() ?? ''); }, [ov.kwhRate]);
  React.useEffect(() => { setPueDraft(ov.pue?.toString()  ?? ''); }, [ov.pue]);
  React.useEffect(() => { setIdleDraft(ov.systemIdleW?.toString() ?? ''); }, [ov.systemIdleW]);

  const [savedCell, setSavedCell] = useState<'kwh' | 'pue' | 'curr' | 'loc' | 'idle' | null>(null);
  const flashSaved = (cell: 'kwh' | 'pue' | 'curr' | 'loc' | 'idle') => {
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

  const commitIdle = () => {
    const v = parseFloat(idleDraft);
    if (idleDraft === '') { onOverride({ systemIdleW: undefined }); flashSaved('idle'); }
    else if (!isNaN(v) && v >= 0) { onOverride({ systemIdleW: v }); flashSaved('idle'); }
    else { setIdleDraft(ov.systemIdleW?.toString() ?? ''); }
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
    <tr className={`hover:bg-gray-50/50 dark:hover:bg-gray-700/30 transition-colors ${eff.hasAnyOverride ? 'border-l-2 border-amber-400/40' : 'border-l-2 border-transparent'}`}>

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

      {/* Display Name */}
      <td className="px-3 py-3 max-w-[180px]">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={ov.locationLabel ?? ''}
            onChange={e => { onOverride({ locationLabel: e.target.value || undefined }); flashSaved('loc'); }}
            onBlur={e => { onSaveDisplayName?.(node.id, e.target.value); }}
            placeholder="e.g. Primary Inference Node"
            title={ov.locationLabel ?? ''}
            maxLength={64}
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

      {/* Idle W — system idle power at the wall */}
      <td className="px-3 py-3 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {savedCell === 'idle' && <SavedMark />}
          <input
            type="number" min="0" step="1"
            value={idleDraft}
            onChange={e => setIdleDraft(e.target.value)}
            onBlur={commitIdle}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder="0"
            title="System idle power at the wall (watts)"
            className={`${cellBase} text-right tabular-nums ${valCls(eff.systemIdleWOverride)}`}
          />
        </div>
      </td>

      {/* Fleet defaults chip */}
      <td className="px-3 py-3 text-right">
        {!eff.hasAnyOverride && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 whitespace-nowrap">
            Fleet defaults
          </span>
        )}
      </td>
    </tr>
  );
};

// ── OpenTelemetry Export Section (Team+ only) ────────────────────────────────

const OtelExportSection: React.FC<{
  getToken: () => Promise<string | null>;
}> = ({ getToken }) => {
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [authHeaders, setAuthHeaders] = useState('{}');
  const [interval, setInterval_] = useState(30);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const resp = await fetch(`${CLOUD_URL}/api/otel/config`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          setEnabled(data.enabled ?? false);
          setEndpoint(data.endpoint_url ?? '');
          setAuthHeaders(data.auth_headers ?? '{}');
          setInterval_(data.export_interval_s ?? 30);
          setLoaded(true);
        }
      } catch { /* ignore */ }
    })();
  }, [getToken]);

  const save = async () => {
    setSaving(true);
    const token = await getToken();
    if (!token) { setSaving(false); return; }
    try {
      await fetch(`${CLOUD_URL}/api/otel/config`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, endpoint_url: endpoint, auth_headers: authHeaders, export_interval_s: interval }),
      });
    } catch { /* ignore */ }
    setSaving(false);
  };

  if (!loaded) return null;

  return (
    <Section id="otel" title="OpenTelemetry Export" icon={Globe} iconBg="bg-amber-500/10" iconCls="text-amber-400">
      <div className="px-6 py-5 space-y-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          Export fleet telemetry as OTLP metrics to Datadog, Grafana Cloud, New Relic, or any OpenTelemetry-compatible collector. Metrics include GPU utilization, power, WES, thermal penalty, TTFT, and inference state per node.
        </p>

        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-gray-300">Enable OTLP Export</label>
          <button
            onClick={() => setEnabled(!enabled)}
            className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-amber-500' : 'bg-gray-700'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">OTLP Endpoint URL</label>
            <input
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://otel.datadoghq.com"
              className="mt-1 w-full px-3 py-2 bg-gray-700/60 border border-gray-700 rounded-lg text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-amber-500/50"
            />
            <p className="mt-1 text-[10px] text-gray-600">The /v1/metrics path is appended automatically.</p>
          </div>

          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Auth Headers (JSON)</label>
            <input
              type="text"
              value={authHeaders}
              onChange={(e) => setAuthHeaders(e.target.value)}
              placeholder='{"DD-API-KEY": "your-key"}'
              className="mt-1 w-full px-3 py-2 bg-gray-700/60 border border-gray-700 rounded-lg text-xs text-gray-200 font-mono placeholder:text-gray-600 focus:outline-none focus:border-amber-500/50"
            />
          </div>

          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Export Interval</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="number"
                min={15}
                max={300}
                value={interval}
                onChange={(e) => setInterval_(Number(e.target.value))}
                className="w-20 px-3 py-2 bg-gray-700/60 border border-gray-700 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-amber-500/50"
              />
              <span className="text-xs text-gray-500">seconds (15–300)</span>
            </div>
          </div>
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save OTel Configuration'}
        </button>

        <div className="text-[10px] text-gray-600 font-mono">
          <p>8 gauges per node: gpu_utilization · power_watts · tokens_per_second · wes_score</p>
          <p>thermal_penalty · memory_pressure · ttft_ms · inference_state</p>
        </div>
      </div>
    </Section>
  );
};

export default SettingsView;
