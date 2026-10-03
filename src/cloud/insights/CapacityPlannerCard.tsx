/**
 * CapacityPlannerCard — Fleet Capacity Planner with procurement scenarios
 * (Team+, cloud only). Roadmap item 11 of the Business & Enterprise
 * Readiness Program.
 *
 * "Reach 200 tok/s sustained: 2× RTX 4090 vs 1× H100" — scenarios priced
 * from the fleet's OWN measured tok/W per hardware class via
 * GET /api/v1/fleet/capacity. Never vendor benchmarks; every scenario
 * states its estimate basis.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Boxes, Lock, AlertTriangle, Target } from 'lucide-react';
import { SubscriptionTier } from '../../types';
import { CLOUD_URL } from '../../utils/cloudUrl';

interface Scenario {
  profile: string;
  label: string;
  class: string;
  vram_mb: number;
  power_w: number;
  units: number;
  unit_tok_s: number;
  est_added_tok_s: number;
  est_cost_per_day: number;
  basis: string;
}

interface CapacityResponse {
  days: number;
  kwh_rate: number;
  target_tok_s: number;
  target_met: boolean;
  fleet: {
    nodes: unknown[];
    sustained_tok_s: number;
    total_watts: number;
    cost_per_day: number;
  };
  scenarios: Scenario[];
}

interface Props {
  getToken: () => Promise<string | null>;
  subscriptionTier: SubscriptionTier;
  onNavigateToPricing?: () => void;
}

const CapacityPlannerCard: React.FC<Props> = ({ getToken, subscriptionTier, onNavigateToPricing }) => {
  const isTeamOrAbove = ['team', 'business', 'enterprise'].includes(subscriptionTier);

  const [targetDraft, setTargetDraft] = useState('');
  const [target, setTarget] = useState<number | null>(null);   // null = server default (2× current)
  const [classFilter, setClassFilter] = useState<'all' | 'apple' | 'nvidia'>('all');
  const [data, setData] = useState<CapacityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchCapacity = useCallback(async () => {
    if (!isTeamOrAbove) return;
    setError(null);
    try {
      const token = await getToken();
      const t = target != null ? `?target_tok_s=${target}` : '';
      const res = await fetch(`${CLOUD_URL}/api/v1/fleet/capacity${t}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { setError(`Server returned ${res.status}`); return; }
      setData(await res.json());
    } catch {
      setError('Failed to load capacity plan');
    }
  }, [isTeamOrAbove, getToken, target]);

  useEffect(() => { fetchCapacity(); }, [fetchCapacity]);

  const commitTarget = () => {
    const v = parseFloat(targetDraft);
    setTarget(!Number.isNaN(v) && v > 0 ? v : null);
  };

  if (!isTeamOrAbove) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-teal-500/10">
            <Boxes size={11} className="text-teal-400" />
          </span>
          <h3 className="text-sm font-bold text-white">Capacity Planner</h3>
        </div>
        <div className="rounded-xl bg-teal-500/5 border border-teal-500/20 px-4 py-3 flex items-start gap-3">
          <Lock size={13} className="text-teal-400 mt-0.5 shrink-0" />
          <p className="text-[11px] text-gray-500 leading-relaxed">
            <strong className="text-gray-300">Team+:</strong> procurement scenarios priced from your fleet's own measured tok/W — "reach 200 tok/s: 2× RTX 4090 vs 1× H100" with real cost/day, not vendor benchmarks.
          </p>
        </div>
        <button
          onClick={() => onNavigateToPricing?.()}
          className="mt-3 w-full py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
        >
          Upgrade to Team
        </button>
      </div>
    );
  }

  const scenarios = (data?.scenarios ?? []).filter(s =>
    (classFilter === 'all' || s.class === classFilter) && s.units > 0);
  const hasBaseline = data != null && data.fleet.sustained_tok_s > 0;

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-teal-500/10">
            <Boxes size={11} className="text-teal-400" />
          </span>
          <h3 className="text-sm font-bold text-white">Capacity Planner</h3>
          <span className="text-[10px] text-gray-600 uppercase tracking-widest">procurement scenarios</span>
        </div>
        <div className="flex items-center gap-1">
          {(['all', 'apple', 'nvidia'] as const).map(c => (
            <button
              key={c}
              onClick={() => setClassFilter(c)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                classFilter === c ? 'bg-teal-500/20 text-teal-300' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {c === 'all' ? 'All' : c === 'apple' ? 'Apple' : 'NVIDIA'}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3" />{error}</p>
      )}

      {data && !hasBaseline && !error && (
        <p className="text-xs text-gray-600 py-2">
          No observed inference in the window yet — scenarios need measured tok/s and watts from your fleet.
        </p>
      )}

      {data && hasBaseline && (
        <>
          {/* Baseline + target row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600">Fleet sustains</div>
              <div className="text-lg font-mono text-white">
                {data.fleet.sustained_tok_s}<span className="text-[10px] text-gray-600 ml-1">tok/s</span>
              </div>
              <div className="text-[9px] text-gray-600 font-mono">
                {data.fleet.total_watts} W · ${data.fleet.cost_per_day.toFixed(2)}/day
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600 flex items-center gap-1">
                <Target className="w-2.5 h-2.5" /> Target
              </div>
              <div className="flex items-baseline gap-1">
                <input
                  type="number"
                  value={targetDraft}
                  onChange={e => setTargetDraft(e.target.value)}
                  onBlur={commitTarget}
                  onKeyDown={e => e.key === 'Enter' && commitTarget()}
                  placeholder={String(data.target_tok_s)}
                  className="w-20 bg-transparent text-lg font-mono text-teal-300 placeholder:text-teal-300/50 focus:outline-none"
                />
                <span className="text-[10px] text-gray-600">tok/s</span>
              </div>
              <div className="text-[9px] text-gray-600">blank = 2× current</div>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600">Gap to target</div>
              <div className={`text-lg font-mono ${data.target_met ? 'text-emerald-400' : 'text-amber-300'}`}>
                {data.target_met ? 'met' : `+${(data.target_tok_s - data.fleet.sustained_tok_s).toFixed(1)}`}
                {!data.target_met && <span className="text-[10px] text-gray-600 ml-1">tok/s</span>}
              </div>
              <div className="text-[9px] text-gray-600">{data.days}d observed window</div>
            </div>
          </div>

          {/* Scenario table */}
          {data.target_met ? (
            <p className="text-xs text-emerald-400/80">
              Your fleet already sustains the target — no procurement needed.
            </p>
          ) : scenarios.length === 0 ? (
            <p className="text-xs text-gray-600">
              No viable scenarios for this class filter (or the gap needs more than 16 units of a single profile).
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-gray-600 border-b border-gray-700">
                  <th className="py-1.5 font-medium">Scenario</th>
                  <th className="py-1.5 font-medium text-right">Adds</th>
                  <th className="py-1.5 font-medium text-right">Power</th>
                  <th className="py-1.5 font-medium text-right">Est $/day</th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map(s => (
                  <tr key={s.profile} className="border-b border-gray-700/50 last:border-0" title={`Estimate basis: ${s.basis} · ${s.unit_tok_s} tok/s per unit`}>
                    <td className="py-1.5 text-gray-200 font-medium">
                      {s.units}× {s.label}
                      <span className="text-gray-600 font-mono text-[10px] ml-2">{(s.vram_mb / 1024).toFixed(0)}GB</span>
                    </td>
                    <td className="py-1.5 text-right font-mono text-teal-300">+{s.est_added_tok_s}</td>
                    <td className="py-1.5 text-right font-mono text-gray-500">{s.units * s.power_w} W</td>
                    <td className="py-1.5 text-right font-mono text-gray-300">${s.est_cost_per_day.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="text-[10px] text-gray-600 leading-relaxed">
            Scenarios are priced from your fleet's measured tok/W per hardware class at ${data.kwh_rate}/kWh, 24h duty —
            hover a row for its basis. Real throughput varies with model size and memory bandwidth.
          </p>
        </>
      )}
    </div>
  );
};

export default CapacityPlannerCard;
