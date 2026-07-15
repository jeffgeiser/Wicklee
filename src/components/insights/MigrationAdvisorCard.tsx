/**
 * MigrationAdvisorCard — Cross-Node Model Migration (Team+, cloud only).
 *
 * GET /api/v1/fleet/migration-advisor compares each actively-inferring
 * node's live WES against every peer's 7-day demonstrated efficiency and
 * free memory, and recommends moves with ≥20% estimated gain where the
 * model fits with 1.2× headroom.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ArrowRightLeft, Lock, AlertTriangle, MoveRight } from 'lucide-react';
import { SubscriptionTier } from '../../types';
import { CLOUD_URL } from '../../utils/cloudUrl';

interface Recommendation {
  model: string;
  from_node: string;
  from_hostname: string | null;
  to_node: string;
  to_hostname: string | null;
  from_wes: number;
  to_wes_7d: number;
  est_gain_pct: number;
  to_free_mem_mb: number;
  model_size_mb: number | null;
}

interface Props {
  getToken: () => Promise<string | null>;
  subscriptionTier: SubscriptionTier;
  onNavigateToPricing?: () => void;
}

const MigrationAdvisorCard: React.FC<Props> = ({ getToken, subscriptionTier, onNavigateToPricing }) => {
  const isTeamOrAbove = ['team', 'business', 'enterprise'].includes(subscriptionTier);
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchRecs = useCallback(async () => {
    if (!isTeamOrAbove) return;
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/v1/fleet/migration-advisor`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { setError(`Server returned ${res.status}`); return; }
      const data = await res.json();
      setRecs(data.recommendations ?? []);
    } catch {
      setError('Failed to load migration recommendations');
    }
  }, [isTeamOrAbove, getToken]);

  useEffect(() => {
    fetchRecs();
    const id = setInterval(fetchRecs, 2 * 60_000);
    return () => clearInterval(id);
  }, [fetchRecs]);

  if (!isTeamOrAbove) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-indigo-500/10">
            <ArrowRightLeft size={11} className="text-indigo-400" />
          </span>
          <h3 className="text-sm font-bold text-white">Model Migration Advisor</h3>
        </div>
        <div className="rounded-xl bg-indigo-500/5 border border-indigo-500/20 px-4 py-3 flex items-start gap-3">
          <Lock size={13} className="text-indigo-400 mt-0.5 shrink-0" />
          <p className="text-[11px] text-gray-500 leading-relaxed">
            <strong className="text-gray-300">Team+:</strong> fleet-wide model placement — finds nodes where your models would run more efficiently, from measured WES and free memory: "Llama on WK-A1B2 → WK-C3D4, +47%."
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

  const label = (id: string, hostname: string | null) => hostname ?? id;

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5 space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-indigo-500/10">
          <ArrowRightLeft size={11} className="text-indigo-400" />
        </span>
        <h3 className="text-sm font-bold text-white">Model Migration Advisor</h3>
      </div>

      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3" />{error}</p>
      )}

      {recs && recs.length === 0 && !error && (
        <p className="text-xs text-gray-600 py-2">
          No beneficial migrations found — active models are well-placed for current fleet efficiency.
        </p>
      )}

      {recs && recs.map((r, i) => (
        <div key={i} className="rounded-xl border border-gray-700 bg-gray-900/60 px-3 py-2.5 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-gray-200 truncate font-mono">{r.model}</span>
            <span className="text-xs font-mono text-emerald-400 shrink-0">+{r.est_gain_pct}% WES</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-gray-400 flex-wrap">
            <span className="font-medium">{label(r.from_node, r.from_hostname)}</span>
            <span className="text-gray-600 font-mono">WES {r.from_wes}</span>
            <MoveRight className="w-3 h-3 text-gray-600" />
            <span className="font-medium text-gray-300">{label(r.to_node, r.to_hostname)}</span>
            <span className="text-gray-600 font-mono">7d WES {r.to_wes_7d}</span>
            <span className="ml-auto text-gray-600">{(r.to_free_mem_mb / 1024).toFixed(0)} GB free</span>
          </div>
        </div>
      ))}

      {recs && recs.length > 0 && (
        <p className="text-[10px] text-gray-600 leading-relaxed">
          Target WES is the destination node's 7-day demonstrated efficiency. Requires ≥20% estimated gain and
          free memory ≥1.2× the model footprint. Actual gain depends on the model's behavior on the target hardware.
        </p>
      )}
    </div>
  );
};

export default MigrationAdvisorCard;
