/**
 * Deployment Profile settings section (localhost / agent-only).
 *
 * A single intent selector that coherently shifts the sensitivity of every
 * local observation pattern — replacing per-pattern threshold knobs. The
 * agent applies the choice within one 10s evaluation cycle and persists it
 * to config.toml.
 *
 * Backed by (same-origin, agent binary on :7700):
 *   GET /api/deployment-profile → { profile, available: [{ id, density_scale, evidence_ratio, min_confidence }] }
 *   PUT /api/deployment-profile   { profile }
 */

import React, { useState, useEffect, useCallback } from 'react';
import { SlidersHorizontal, Check, AlertTriangle, Laptop, Server, Rocket } from 'lucide-react';

type ProfileId = 'sovereign_dev' | 'dedicated_server' | 'production_fleet';

interface ProfileMeta {
  id:    ProfileId;
  icon:  React.ElementType;
  label: string;
  blurb: string;
}

const PROFILES: ProfileMeta[] = [
  {
    id: 'sovereign_dev',
    icon: Laptop,
    label: 'Sovereign Dev',
    blurb: 'Laptop or workstation running inference alongside other work. High evidence bar and a confidence floor so mixed-use noise stays quiet.',
  },
  {
    id: 'dedicated_server',
    icon: Server,
    label: 'Dedicated Server',
    blurb: 'Single-purpose inference node. Standard thresholds — the baseline the observation patterns were tuned for.',
  },
  {
    id: 'production_fleet',
    icon: Rocket,
    label: 'Production Fleet',
    blurb: 'Serving real users where latency matters. Aggressive early warning — less sustained evidence required, so degradations surface sooner.',
  },
];

const DeploymentProfileSection: React.FC = () => {
  const [current,  setCurrent]  = useState<ProfileId | null>(null);
  const [saving,   setSaving]   = useState<ProfileId | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [loaded,   setLoaded]   = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/deployment-profile');
      if (!res.ok) { setError(`Server returned ${res.status}`); return; }
      const data = await res.json();
      setCurrent((data.profile as ProfileId) ?? 'dedicated_server');
    } catch {
      setError('Failed to load deployment profile');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const select = async (id: ProfileId) => {
    if (id === current || saving) return;
    setSaving(id);
    setError(null);
    try {
      const res = await fetch('/api/deployment-profile', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ profile: id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? `Server returned ${res.status}`);
        return;
      }
      const data = await res.json();
      setCurrent((data.profile as ProfileId) ?? id);
    } catch {
      setError('Failed to update deployment profile');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div id="deployment-profile" className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-sm dark:shadow-none overflow-hidden scroll-mt-6">
      <div className="flex items-center gap-2.5 px-6 py-4 border-b border-gray-100 dark:border-gray-700">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-500/10 shrink-0">
          <SlidersHorizontal size={11} className="text-emerald-400" />
        </span>
        <h2 className="text-sm font-bold text-gray-900 dark:text-white tracking-tight">Deployment Profile</h2>
      </div>

      <div className="px-6 py-5 space-y-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          One intent declaration that tunes how sensitively this node's observation patterns fire — evidence window, sustained-signal threshold, and confidence floor move together. Applies within ~10 seconds; no per-pattern knobs to manage.
        </p>

        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-rose-500/5 border border-rose-500/20 px-3 py-2">
            <AlertTriangle size={12} className="text-rose-400 shrink-0" />
            <p className="text-xs text-rose-400">{error}</p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {PROFILES.map(p => {
            const Icon = p.icon;
            const active = current === p.id;
            const busy = saving === p.id;
            return (
              <button
                key={p.id}
                onClick={() => select(p.id)}
                disabled={!loaded || saving !== null}
                className={`text-left rounded-xl border p-4 transition-colors disabled:opacity-60 ${
                  active
                    ? 'border-emerald-500/60 bg-emerald-500/5'
                    : 'border-gray-200 dark:border-gray-700 hover:border-emerald-500/40 bg-gray-50 dark:bg-gray-700/30'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <Icon size={16} className={active ? 'text-emerald-400' : 'text-gray-400'} />
                  {active && <Check size={14} className="text-emerald-400" />}
                  {busy && <span className="text-[10px] text-gray-500">saving…</span>}
                </div>
                <p className={`text-xs font-semibold ${active ? 'text-emerald-300' : 'text-gray-200'}`}>{p.label}</p>
                <p className="text-[10px] text-gray-500 mt-1 leading-relaxed">{p.blurb}</p>
              </button>
            );
          })}
        </div>

        <p className="text-[10px] text-gray-600 leading-relaxed">
          Node-local setting, persisted in <code className="font-mono text-gray-500">config.toml</code>. It governs which observations this node raises; it does not change fleet-wide alert rules.
        </p>
      </div>
    </div>
  );
};

export default DeploymentProfileSection;
