/**
 * Chargeback / Showback card (Team+, cloud only).
 *
 * Cost and token attribution from measured telemetry: energy (watts × time)
 * priced at the fleet kWh rate, tokens estimated from throughput samples —
 * yielding $/1M tokens by team tag, model, and node, plus a daily trend.
 * The number generic LLM-observability tools can't produce: they see tokens
 * OR watts, never both in one store.
 *
 * Backed by GET /api/v1/fleet/chargeback?days=&kwh_rate=[&format=csv&group=].
 */

import React, { useState, useEffect, useCallback } from 'react';
import { DollarSign, Download, Lock } from 'lucide-react';
import { CLOUD_URL } from '../../utils/cloudUrl';

interface ChargebackRow {
  key:           string;
  energy_kwh:    number;
  cost_usd:      number;
  tokens_m:      number;
  usd_per_mtok:  number | null;
  hours_covered: number;
}

interface ChargebackReport {
  days:     number;
  kwh_rate: number;
  totals:   ChargebackRow;
  by_tag:   ChargebackRow[];
  by_model: ChargebackRow[];
  by_node:  ChargebackRow[];
  daily:    ChargebackRow[];
}

interface Props {
  getToken:         () => Promise<string | null>;
  subscriptionTier: string;
  onNavigateToPricing?: () => void;
}

type Grouping = 'by_tag' | 'by_model' | 'by_node';

const GROUPINGS: { value: Grouping; label: string; csv: string }[] = [
  { value: 'by_tag',   label: 'Teams (tags)', csv: 'tag' },
  { value: 'by_model', label: 'Models',       csv: 'model' },
  { value: 'by_node',  label: 'Nodes',        csv: 'node' },
];

const fmtUsd = (v: number) => v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;

const ChargebackCard: React.FC<Props> = ({ getToken, subscriptionTier, onNavigateToPricing }) => {
  const isTeamOrAbove = ['team', 'business', 'enterprise'].includes(subscriptionTier);

  const [days,     setDays]     = useState(30);
  const [grouping, setGrouping] = useState<Grouping>('by_tag');
  const [report,   setReport]   = useState<ChargebackReport | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    if (!isTeamOrAbove) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/v1/fleet/chargeback?days=${days}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { setError(`Server returned ${res.status}`); return; }
      setReport(await res.json());
    } catch {
      setError('Failed to load chargeback report');
    } finally {
      setLoading(false);
    }
  }, [isTeamOrAbove, getToken, days]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const downloadCsv = async () => {
    try {
      const token = await getToken();
      const g = GROUPINGS.find(g => g.value === grouping)?.csv ?? 'tag';
      const res = await fetch(`${CLOUD_URL}/api/v1/fleet/chargeback?days=${days}&format=csv&group=${g}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wicklee-chargeback-${g}-${days}d.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* best-effort */ }
  };

  if (!isTeamOrAbove) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-500/10">
            <DollarSign size={11} className="text-emerald-400" />
          </span>
          <h3 className="text-sm font-bold text-white">Chargeback & Showback</h3>
        </div>
        <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 px-4 py-3 flex items-start gap-3">
          <Lock size={13} className="text-emerald-400 mt-0.5 shrink-0" />
          <p className="text-[11px] text-gray-500 leading-relaxed">
            <strong className="text-gray-300">Team+:</strong> cost and $/1M-token attribution by team tag, model, and node — from measured watts and throughput, not estimates. The report finance asks for.
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

  const rows = report?.[grouping] ?? [];

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-500/10">
          <DollarSign size={11} className="text-emerald-400" />
        </span>
        <h3 className="text-sm font-bold text-white flex-1">Chargeback & Showback</h3>
        <select
          value={days}
          onChange={e => setDays(parseInt(e.target.value, 10))}
          className="text-[11px] px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-gray-300 focus:border-emerald-500 focus:outline-none"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button
          onClick={downloadCsv}
          className="text-[10px] px-2 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:border-emerald-500/50 hover:bg-emerald-500/10 transition-colors flex items-center gap-1"
          title="Download this grouping as CSV"
        >
          <Download size={11} /> CSV
        </button>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {/* Totals strip */}
      {report && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total cost',   value: fmtUsd(report.totals.cost_usd) },
            { label: 'Energy',       value: `${report.totals.energy_kwh.toFixed(1)} kWh` },
            { label: 'Tokens',       value: `${report.totals.tokens_m.toFixed(1)}M` },
            { label: '$ / 1M tokens', value: report.totals.usd_per_mtok != null ? fmtUsd(report.totals.usd_per_mtok) : '—' },
          ].map(t => (
            <div key={t.label} className="rounded-xl bg-gray-900 border border-gray-700 px-3 py-2.5">
              <p className="text-sm font-bold text-white tabular-nums">{t.value}</p>
              <p className="text-[9px] text-gray-500 uppercase tracking-wider mt-0.5">{t.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Grouping tabs */}
      <div className="flex items-center gap-1.5">
        {GROUPINGS.map(g => (
          <button
            key={g.value}
            onClick={() => setGrouping(g.value)}
            className={`text-[10px] font-semibold px-2.5 py-1 rounded-lg border transition-colors ${
              grouping === g.value
                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                : 'border-gray-700 text-gray-500 hover:text-gray-300'
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* Rows */}
      {loading && !report ? (
        <p className="text-xs text-gray-600">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-600">No telemetry in this window yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[9px] uppercase tracking-widest text-gray-500 border-b border-gray-700">
                <th className="py-1.5 pr-3 font-medium">{GROUPINGS.find(g => g.value === grouping)?.label}</th>
                <th className="py-1.5 pr-3 font-medium text-right">Cost</th>
                <th className="py-1.5 pr-3 font-medium text-right">Tokens</th>
                <th className="py-1.5 pr-3 font-medium text-right">$ / 1M tok</th>
                <th className="py-1.5 font-medium text-right">kWh</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} className="border-b border-gray-800/60">
                  <td className="py-1.5 pr-3 text-[11px] text-gray-300 font-mono max-w-[180px] truncate" title={r.key}>{r.key}</td>
                  <td className="py-1.5 pr-3 text-[11px] text-gray-200 text-right tabular-nums">{fmtUsd(r.cost_usd)}</td>
                  <td className="py-1.5 pr-3 text-[11px] text-gray-400 text-right tabular-nums">{r.tokens_m.toFixed(1)}M</td>
                  <td className="py-1.5 pr-3 text-[11px] text-emerald-300 text-right tabular-nums">{r.usd_per_mtok != null ? fmtUsd(r.usd_per_mtok) : '—'}</td>
                  <td className="py-1.5 text-[11px] text-gray-500 text-right tabular-nums">{r.energy_kwh.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[9px] text-gray-600 leading-relaxed">
        Cost = measured watts × time at ${report?.kwh_rate ?? 0.16}/kWh. Tokens estimated from sampled throughput. Tag rows overlap when a node carries multiple tags — showback, not double-billing. CSV downloads are audit-logged.
      </p>
    </div>
  );
};

export default ChargebackCard;
