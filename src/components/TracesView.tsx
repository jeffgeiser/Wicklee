/**
 * TracesView — Observability tab
 *
 * Two sections:
 *   1. Sovereignty — always visible (cloud + local). Telemetry destination,
 *      outbound connection manifest, and live connection event log. Structural
 *      proof that inference data never left the network.
 *   2. Request Traces — localhost only. DuckDB-backed trace table with
 *      latency / TTFT / TPOT per inference request.
 */

import React, { useState, useEffect } from 'react';
import {
  Database, Clock, RefreshCw, Filter, Activity,
  Shield, Lock, Globe, Radio,
  ArrowUpRight, CheckCircle,
} from 'lucide-react';
import { NodeAgent, TraceRecord, PairingInfo } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';

const isLocalHost =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1';

interface TracesViewProps {
  nodes: NodeAgent[];
  tenantId: string;
  pairingInfo: PairingInfo | null;
}

// ── Sovereignty Section ────────────────────────────────────────────────────────

const SovereigntySection: React.FC<{ pairingInfo: PairingInfo | null }> = ({ pairingInfo }) => {
  const { fleetEvents, connectionState } = useFleetStream();

  const isPaired   = pairingInfo?.status === 'connected';
  const fleetUrl   = pairingInfo?.fleet_url ?? (isPaired ? 'wicklee.dev' : null);
  const nodeId     = pairingInfo?.node_id ?? null;

  // Connection events — most recent first, cap at 8
  const connectionEvents = fleetEvents
    .filter(e => e.type === 'node_online' || e.type === 'node_offline')
    .slice(0, 8);

  const manifest = [
    {
      purpose:  'Ollama inference probe',
      endpoint: 'localhost:11434',
      data:     'Metric only — tok/s sample (3 tokens)',
      status:   'local' as const,
    },
    {
      purpose:  'Fleet telemetry',
      endpoint: fleetUrl ?? '—',
      data:     'System metrics + WES scores',
      status:   isPaired ? 'active' as const : 'inactive' as const,
    },
    {
      purpose:  'Clerk authentication',
      endpoint: 'api.clerk.dev',
      data:     'Session JWT — no inference data',
      status:   isLocalHost ? 'inactive' as const : 'active' as const,
    },
  ];

  return (
    <div className="space-y-4">

      {/* ── Section header ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-center justify-center shrink-0">
          <Shield className="w-4 h-4 text-indigo-400" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-white">Sovereignty</h2>
          <p className="text-xs text-gray-500">
            Structural proof that inference data never left your network
          </p>
        </div>
      </div>

      {/* ── Destination + Manifest ───────────────────────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-4">

        {/* Telemetry Destination */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            Telemetry Destination
          </p>

          <div className="flex items-start gap-3">
            <div className={`mt-0.5 w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
              isPaired
                ? 'bg-indigo-500/10 border border-indigo-500/20'
                : 'bg-green-500/10 border border-green-500/20'
            }`}>
              {isPaired
                ? <Globe className="w-4 h-4 text-indigo-400" />
                : <Lock  className="w-4 h-4 text-green-400"  />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm text-white">
                  {isPaired ? (fleetUrl ?? 'wicklee.dev') : 'localhost:7700'}
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest ${
                  isPaired
                    ? 'bg-indigo-500/10 border border-indigo-500/20 text-indigo-400'
                    : 'bg-green-500/10 border border-green-500/20 text-green-400'
                }`}>
                  {isPaired ? 'Fleet connected' : 'Local only'}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                {isPaired
                  ? 'System metrics and WES scores only — inference content never transmitted.'
                  : 'No outbound telemetry. All data stays on this machine.'}
              </p>
              {isPaired && nodeId && (
                <p className="font-mono text-[11px] text-gray-600 mt-1.5">{nodeId}</p>
              )}
            </div>
          </div>

          {/* What is (and isn't) transmitted */}
          <div className="border-t border-gray-800 pt-4 space-y-3">
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">
                Transmitted to fleet
              </p>
              <div className="space-y-1.5">
                {[
                  'CPU / GPU / memory metrics',
                  'WES score + thermal state',
                  'Active model name',
                ].map(label => (
                  <div key={label} className="flex items-center gap-2">
                    <ArrowUpRight className="w-3 h-3 text-indigo-400 shrink-0" />
                    <span className="text-xs text-gray-400">{label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">
                Never leaves this machine
              </p>
              <div className="space-y-1.5">
                {[
                  'Inference content / prompts',
                  'Request payloads / responses',
                  'User conversations',
                ].map(label => (
                  <div key={label} className="flex items-center gap-2">
                    <CheckCircle className="w-3 h-3 text-green-400 shrink-0" />
                    <span className="text-xs text-green-400/70">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Outbound Connection Manifest */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            Outbound Connection Manifest
          </p>
          <div className="divide-y divide-gray-800/60">
            {manifest.map(row => (
              <div key={row.purpose} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-gray-300">{row.purpose}</span>
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                        row.status === 'local'    ? 'bg-green-500/10 text-green-400'   :
                        row.status === 'active'   ? 'bg-indigo-500/10 text-indigo-400' :
                                                    'bg-gray-500/10 text-gray-500'
                      }`}>
                        {row.status}
                      </span>
                    </div>
                    <p className="font-mono text-[11px] text-gray-500 mt-0.5">{row.endpoint}</p>
                    <p className="text-[11px] text-gray-600 mt-0.5">{row.data}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-gray-800 pt-3">
            <p className="text-[11px] text-gray-600 leading-relaxed">
              <span className="text-green-400/70 font-semibold">No inference data</span>{' '}
              appears in any outbound connection. The Ollama probe issues 3 tokens to measure throughput — the content is discarded. Prompts and responses are processed entirely on-device.
            </p>
          </div>
        </div>
      </div>

      {/* ── Connection Event Log ─────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            Connection Event Log
          </p>
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${
              connectionState === 'connected' ? 'bg-green-400 animate-pulse' : 'bg-gray-600'
            }`} />
            <span className="text-[10px] text-gray-600">Live</span>
          </div>
        </div>

        {connectionEvents.length > 0 ? (
          <div className="divide-y divide-gray-800/50">
            {connectionEvents.map(evt => (
              <div key={evt.id} className="px-5 py-3 flex items-center gap-4">
                <span className="font-mono text-[11px] text-gray-600 shrink-0 w-[4.5rem]">
                  {new Date(evt.ts).toLocaleTimeString([], {
                    hour:   '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  evt.type === 'node_online' ? 'bg-green-400' : 'bg-gray-500'
                }`} />
                <span className="text-xs text-gray-400">
                  <span className="font-mono text-gray-300">
                    {evt.hostname ?? evt.nodeId}
                  </span>
                  {evt.type === 'node_online'
                    ? ' connected to fleet'
                    : ' disconnected from fleet'}
                  {evt.detail ? ` · ${evt.detail}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-10 text-center">
            <Radio className="w-5 h-5 text-gray-700 mx-auto mb-2" />
            <p className="text-xs text-gray-600">No connection events in this session</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Local trace table ──────────────────────────────────────────────────────────

const TraceTable: React.FC<{ tenantId: string }> = ({ tenantId }) => {
  const [traces, setTraces]   = useState<TraceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetchTraces = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/traces', {
        headers: { 'X-Tenant-ID': tenantId },
      });
      if (!response.ok) throw new Error('Failed to reach local Wicklee agent');
      const data = await response.json();
      setTraces(data);
      setError(null);
    } catch {
      setError('Agent disconnected');
      setTraces([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTraces();
    const interval = setInterval(fetchTraces, 5000);
    return () => clearInterval(interval);
  }, [tenantId]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <button
            onClick={fetchTraces}
            className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
          >
            <Database className="w-3.5 h-3.5" />
            Query Local Logs
          </button>
          <button className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs font-medium rounded-lg border border-gray-700 hover:bg-gray-700 transition-colors flex items-center gap-2">
            <Filter className="w-3.5 h-3.5" />
            Filter Logs
          </button>
        </div>
        <div className="flex items-center gap-3">
          {loading && <RefreshCw className="w-3 h-3 text-cyan-400 animate-spin" />}
          <span className="text-xs text-gray-500 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Auto-syncing (5s)
          </span>
          <div className={`w-2 h-2 rounded-full ${
            error         ? 'bg-red-500'                  :
            traces.length > 0 ? 'bg-green-500 animate-pulse' :
                            'bg-gray-500'
          }`} />
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-950/50 text-[10px] text-gray-500 uppercase tracking-widest font-bold border-b border-gray-800">
              <th className="px-6 py-4">Timestamp</th>
              <th className="px-6 py-4">Node / Model</th>
              <th className="px-6 py-4">Latency (ms)</th>
              <th className="px-6 py-4">TTFT</th>
              <th className="px-6 py-4">TPOT</th>
              <th className="px-6 py-4">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 font-telin text-xs">
            {traces.length > 0 ? (
              traces.map(trace => (
                <tr key={trace.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-6 py-4 text-gray-500">{trace.timestamp}</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col">
                      <span className="text-gray-300 font-semibold">{trace.nodeId}</span>
                      <span className="text-cyan-400/80">{trace.model}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-12 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-600"
                          style={{ width: `${Math.min(100, (trace.latency / 1200) * 100)}%` }}
                        />
                      </div>
                      <span className="text-gray-300">{trace.latency}ms</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-400">{trace.ttft}ms</td>
                  <td className="px-6 py-4 text-gray-400">{trace.tpot}ms/tok</td>
                  <td className="px-6 py-4">
                    <span className={trace.status >= 400 ? 'text-red-500' : 'text-green-500'}>
                      {trace.status}
                    </span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-6 py-20 text-center">
                  <div className="flex flex-col items-center justify-center max-w-sm mx-auto">
                    <div className="w-12 h-12 bg-gray-800/50 rounded-2xl flex items-center justify-center mb-4 border border-white/5">
                      <Activity className="w-6 h-6 text-gray-500" />
                    </div>
                    <h3 className="text-lg font-bold text-white mb-2">No traces yet</h3>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      Inference traces will appear here automatically once the Wicklee agent is running.
                      Each request is logged with latency, TTFT, and TPOT.
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────────

const TracesView: React.FC<TracesViewProps> = ({ nodes: _nodes, tenantId, pairingInfo }) => (
  <div className="space-y-8">
    <SovereigntySection pairingInfo={pairingInfo} />
    {isLocalHost && <TraceTable tenantId={tenantId} />}
  </div>
);

export default TracesView;
