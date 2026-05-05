/**
 * ThermalBudgetCard — Pro feature on Insights → Performance.
 *
 * Predicts when pushing a node harder backfires: at what tok/s level
 * thermal Fair triggers, how long that takes, and whether the resulting
 * penalized rate produces more or fewer net tokens over a 1-hour window
 * than holding a sustainable rate.
 *
 * Fed by GET /api/v1/thermal-budget?node_id=X — server walks the
 * 7-day metrics_5min rollup, identifies sustained Normal blocks and
 * Normal→Fair transitions, returns the budget summary + advice string.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Thermometer, AlertTriangle, Lock, RefreshCw } from 'lucide-react';
import { SubscriptionTier } from '../../types';

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL as string) ?? '';
  if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
  if (v === '/') return '';
  return v.startsWith('http') ? v : `https://${v}`;
})();

interface ThermalBudgetResponse {
  node_id:               string;
  samples_analyzed:      number;
  transitions_detected:  number;
  confidence:            'insufficient' | 'low' | 'medium' | 'high';
  sustainable_tps:       number;
  sustainable_watts:     number;
  push_threshold_tps?:   number | null;
  push_threshold_watts?: number | null;
  time_to_fair_min?:     number | null;
  fair_penalized_tps?:   number | null;
  advice:                string;
}

interface ThermalBudgetCardProps {
  getToken:         () => Promise<string | null>;
  subscriptionTier: SubscriptionTier;
  /** Currently selected node id (synced with WESHistoryChart). */
  selectedNodeId?:  string | null;
}

const CONFIDENCE_LABEL: Record<ThermalBudgetResponse['confidence'], string> = {
  insufficient: 'Insufficient data',
  low:          'Low confidence',
  medium:       'Medium confidence',
  high:         'High confidence',
};

const CONFIDENCE_TONE: Record<ThermalBudgetResponse['confidence'], string> = {
  insufficient: 'text-gray-500 bg-gray-700/30 border-gray-700',
  low:          'text-amber-400 bg-amber-500/10 border-amber-500/25',
  medium:       'text-cyan-300 bg-cyan-500/10 border-cyan-500/25',
  high:         'text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
};

const ThermalBudgetCard: React.FC<ThermalBudgetCardProps> = ({
  getToken,
  subscriptionTier,
  selectedNodeId,
}) => {
  const [data,    setData]    = useState<ThermalBudgetResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const isProOrAbove = ['pro', 'team', 'business', 'enterprise'].includes(subscriptionTier);

  const fetchBudget = useCallback(async () => {
    if (!selectedNodeId || !isProOrAbove) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/v1/thermal-budget?node_id=${encodeURIComponent(selectedNodeId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 403) {
        setError('Pro tier required for Thermal Budget.');
      } else if (!res.ok) {
        setError(`Server returned ${res.status}`);
      } else {
        setData(await res.json());
      }
    } catch {
      setError('Failed to load thermal budget');
    } finally {
      setLoading(false);
    }
  }, [getToken, selectedNodeId, isProOrAbove]);

  useEffect(() => { fetchBudget(); }, [fetchBudget]);

  // Pro upgrade gate
  if (!isProOrAbove) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Thermometer className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Thermal Budget
            </span>
            <span className="text-[9px] uppercase tracking-widest text-blue-400 ml-1">Pro</span>
          </div>
          <Lock className="w-3.5 h-3.5 text-gray-600" />
        </div>
        <p className="text-xs text-gray-500 mt-2 leading-relaxed">
          Predicts when pushing harder backfires. Computes your sustainable tok/s rate, the load level that triggers Fair thermal, and whether pushing produces more or fewer net tokens over time. Requires 7-day history (Pro tier).
        </p>
      </div>
    );
  }

  const fmtTps = (v: number | null | undefined): string =>
    v == null ? '—' : v.toFixed(v >= 100 ? 0 : 1);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Thermometer className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Thermal Budget
          </span>
          {data?.confidence && (
            <span className={`text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border ${CONFIDENCE_TONE[data.confidence]}`}>
              {CONFIDENCE_LABEL[data.confidence]}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={fetchBudget}
          disabled={loading || !selectedNodeId}
          className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1 disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Computing…' : 'Refresh'}
        </button>
      </div>

      {/* Empty / loading / error states */}
      {!selectedNodeId && (
        <p className="text-xs text-gray-600 py-2">Select a node above to compute its thermal budget.</p>
      )}

      {error && (
        <p className="text-xs text-red-400 py-2 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3" />
          {error}
        </p>
      )}

      {data && data.confidence === 'insufficient' && (
        <p className="text-xs text-gray-500 leading-relaxed py-2">{data.advice}</p>
      )}

      {data && data.confidence !== 'insufficient' && (
        <>
          {/* Stat strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600">Sustainable</div>
              <div className="text-lg font-mono text-emerald-400">
                {fmtTps(data.sustainable_tps)}<span className="text-[10px] text-gray-600 ml-1">tok/s</span>
              </div>
              <div className="text-[9px] text-gray-600 font-mono">at {data.sustainable_watts.toFixed(1)} W</div>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600">Push Threshold</div>
              <div className="text-lg font-mono text-amber-300">
                {fmtTps(data.push_threshold_tps)}<span className="text-[10px] text-gray-600 ml-1">tok/s</span>
              </div>
              <div className="text-[9px] text-gray-600 font-mono">
                {data.push_threshold_watts != null ? `at ${data.push_threshold_watts.toFixed(1)} W` : '—'}
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600">Time → Fair</div>
              <div className="text-lg font-mono text-orange-300">
                {data.time_to_fair_min != null ? data.time_to_fair_min.toFixed(0) : '—'}<span className="text-[10px] text-gray-600 ml-1">min</span>
              </div>
              <div className="text-[9px] text-gray-600 font-mono">{data.transitions_detected} transitions</div>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600">Penalized Rate</div>
              <div className="text-lg font-mono text-red-300">
                {fmtTps(data.fair_penalized_tps)}<span className="text-[10px] text-gray-600 ml-1">tok/s</span>
              </div>
              <div className="text-[9px] text-gray-600 font-mono">at Fair thermal (1.25×)</div>
            </div>
          </div>

          {/* Plain-English advice */}
          <p className="text-xs text-gray-300 leading-relaxed">
            {data.advice}
          </p>

          {/* Footer with sample density */}
          <p className="text-[9px] text-gray-700 font-mono">
            {data.samples_analyzed} samples · 7-day window · 5-min rollups
          </p>
        </>
      )}
    </div>
  );
};

export default ThermalBudgetCard;
