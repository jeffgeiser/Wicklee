import React, { useState } from 'react';
import { version as pkgVersion } from '../../package.json';
import { Zap, Check, ChevronDown, Monitor, User, Download } from 'lucide-react';
import type { NodeAgent } from '../types';
import DeploymentProfileSection from './settings/DeploymentProfileSection';
import {
  CURRENCY_OPTIONS, FLEET_DEFAULTS,
  type FleetSettings, type NodeOverride, type WickleeSettings} from '../hooks/useSettings';

interface SettingsViewProps {
  nodes: NodeAgent[];
  settings: WickleeSettings;
  savedToast: boolean;
  updateFleet: (patch: Partial<FleetSettings>) => void;
  setNodeOverride: (nodeId: string, patch: Partial<NodeOverride>) => void;
  clearAllNodeOverrides: () => void;
}

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

const INPUT_BASE =
  'h-9 bg-gray-50 dark:bg-gray-700 border rounded-lg px-3 text-sm font-telin text-gray-900 dark:text-white focus:outline-none focus:ring-1 transition-colors';

const inputCls = (dirty: boolean) =>
  dirty
    ? `${INPUT_BASE} border-amber-400/60 dark:border-amber-400/50 focus:border-amber-400/60 focus:ring-amber-400/20`
    : `${INPUT_BASE} border-gray-200 dark:border-gray-700 focus:border-indigo-500/60 focus:ring-indigo-500/30`;

const SettingsView: React.FC<SettingsViewProps> = ({
  nodes,
  settings,
  savedToast,
  updateFleet,
  setNodeOverride,
  clearAllNodeOverrides,
}) => {
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

  const draftKwh = parseFloat(kwhDraft);
  const draftPue = parseFloat(pueDraft);
  const effKwh = !isNaN(draftKwh) && draftKwh >= 0 ? draftKwh : settings.fleet.kwhRate;
  const effPue = !isNaN(draftPue) && draftPue >= 1  ? draftPue : settings.fleet.pue;
  const currSymbol = CURRENCY_OPTIONS.find(c => c.value === settings.fleet.currency)?.symbol ?? '$';
  const monthlyCost100W = (100 / 1000) * effPue * 24 * 30.4 * effKwh;

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

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wicklee-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-300 pb-12">

      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-sm text-gray-500">Cost defaults and display preferences.</p>
      </div>

      <Section id="cost-energy" title="Cost & Energy" icon={Zap} iconBg="bg-amber-500/10" iconCls="text-amber-400">
        <div className="px-6 py-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">

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
              Your actual cost is shown on the Overview tab based on live power draw.
            </p>
          </div>

          {nodes.length > 0 && (() => {
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

        </div>
      </Section>

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

      <DeploymentProfileSection />

      <Section id="account" title="Account & Data" icon={User} iconBg="bg-gray-500/10" iconCls="text-gray-400">
        <div className="px-6 py-5 space-y-5">

          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Agent Version</p>
              <p className="text-sm font-telin text-gray-900 dark:text-white">
                v{(import.meta.env.VITE_AGENT_VERSION as string | undefined) ?? pkgVersion}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Storage</p>
              <p className="text-sm font-telin text-gray-500 dark:text-gray-400">Local store</p>
            </div>
          </div>

          <div className="flex items-center justify-between py-4 border-t border-gray-100 dark:border-gray-700">
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Export Settings</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Download your settings as JSON.</p>
            </div>
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 hover:border-indigo-400/50 hover:text-indigo-400 transition-colors"
            >
              <Download size={11} /> Export
            </button>
          </div>

          <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-500/70 mb-3">Danger Zone</p>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Reset all settings</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Restore defaults and clear all overrides.</p>
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

      {savedToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-gray-800 border border-gray-700/80 rounded-xl shadow-xl shadow-black/40 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <Check size={13} className="text-green-400 shrink-0" />
          <span className="text-xs font-semibold text-gray-200">Saved</span>
        </div>
      )}
    </div>
  );
};

export default SettingsView;
