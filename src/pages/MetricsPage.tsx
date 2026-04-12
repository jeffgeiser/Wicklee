import React from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

type DotColor = 'blue' | 'green' | 'emerald' | 'amber' | 'yellow' | 'orange' | 'red' | 'gray';

interface RangeEntry {
  threshold: string;
  color: DotColor;
  label: string;
}

interface MetricCardProps {
  id: string;
  name: string;
  formula?: string;
  description: string;
  ranges?: RangeEntry[];
  action?: string;
}

interface MetricsPageProps {
  onNavigate?: (path: string) => void;
}

// ── Internal components ───────────────────────────────────────────────────────

const Dot: React.FC<{ color: DotColor }> = ({ color }) => {
  const cls: Record<DotColor, string> = {
    blue:    'bg-blue-500',
    green:   'bg-green-500',
    emerald: 'bg-emerald-500',
    amber:   'bg-amber-400',
    yellow:  'bg-yellow-400',
    orange:  'bg-orange-400',
    red:     'bg-red-500',
    gray:    'bg-gray-500',
  };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 mt-0.5 ${cls[color]}`}
      aria-hidden="true"
    />
  );
};

const MetricCard: React.FC<MetricCardProps> = ({
  id,
  name,
  formula,
  description,
  ranges,
  action,
}) => (
  <div
    id={id}
    className="bg-gray-900 border border-gray-800 rounded-2xl p-6 scroll-mt-24"
  >
    <h3 className="text-sm font-semibold text-gray-100 font-sans mb-3 leading-snug">{name}</h3>

    {formula && (
      <p className="font-mono text-xs text-indigo-300 bg-indigo-500/5 border border-indigo-500/10 rounded-lg px-3 py-2 mb-4 leading-relaxed">
        {formula}
      </p>
    )}

    <p className="font-sans text-sm text-gray-400 leading-relaxed mb-4">{description}</p>

    {ranges && ranges.length > 0 && (
      <div className="mb-4">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600 mb-2.5">Ranges</p>
        <div className="space-y-2">
          {ranges.map((r, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <Dot color={r.color} />
              <span className="font-telin text-xs text-gray-300 shrink-0 w-28 leading-tight">{r.threshold}</span>
              <span className="font-sans text-xs text-gray-500 leading-tight">{r.label}</span>
            </div>
          ))}
        </div>
      </div>
    )}

    {action && (
      <div className="border-t border-gray-800/70 pt-4">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600 mb-1.5">If this is low / high</p>
        <p className="font-sans text-xs text-gray-400 leading-relaxed">{action}</p>
      </div>
    )}
  </div>
);

const SectionHeader: React.FC<{ title: string; description: string }> = ({ title, description }) => (
  <div className="mb-5">
    <h2 className="text-base font-bold text-gray-100 font-sans mb-1">{title}</h2>
    <p className="text-xs text-gray-500 font-sans">{description}</p>
  </div>
);

// ── Page ─────────────────────────────────────────────────────────────────────

const MetricsPage: React.FC<MetricsPageProps> = ({ onNavigate }) => {
  const handleBack = () => {
    if (onNavigate) {
      onNavigate('/');
    } else {
      window.history.back();
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">

      {/* ── Top nav ──────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-40 bg-gray-950/90 backdrop-blur-sm border-b border-gray-800/50 px-6 py-3 flex items-center gap-4">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          <ArrowLeft size={13} />
          Back
        </button>
        <span className="text-gray-700 select-none">·</span>
        <span className="text-xs font-semibold text-gray-500 tracking-widest uppercase">Wicklee</span>
      </div>

      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div className="px-6 pt-10 pb-8 max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-100 font-sans mb-2">Metrics Reference</h1>
        <p className="text-sm text-gray-400 font-sans leading-relaxed">
          Every metric Wicklee surfaces — what it means, what to do about it.
        </p>
        <a
          href="/metrics.md"
          className="inline-flex items-center gap-1.5 mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          <ExternalLink size={11} />
          Raw Markdown for agents
        </a>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      <div className="max-w-3xl mx-auto px-6 pb-20 space-y-14">

        {/* ── How Wicklee Works ────────────────────────────────────────────── */}
        <section>
          <SectionHeader
            title="How Wicklee Works: Synchronous Observation"
            description="A sovereign Rust binary that observes your inference fleet without ever touching your private data."
          />
          <div className="bg-gray-900 border border-indigo-500/20 rounded-2xl p-6 space-y-5">
            {([
              {
                label: 'Hardware Harvester (1 Hz)',
                body: 'The agent queries your kernel and GPU drivers (NVML / IOReg / RAPL) once per second to capture micro-spikes in power, thermals, and utilization that 1-minute Prometheus scrapes miss.',
              },
              {
                label: 'Performance Probe (30 s)',
                body: 'Every 30 seconds, the agent fires a 20-token generation request to your local inference API to measure real-time throughput without intercepting actual user traffic. The probe is skipped when GPU utilization is ≥ 40% — at that point the scheduler is under load and a reading would be depressed. Throughput estimation covers the gap (see below).',
              },
              {
                label: 'Local Interpretation',
                body: 'By owning both hardware physics and runtime context, Wicklee triggers Conditional Insights — identifying "invisible" states like a Power Anomaly (high wattage vs. low GPU utilization) or Thermal Degradation (temperature spikes causing silent throughput drops).',
              },
              {
                label: 'Zero-Intercept Privacy',
                body: 'Wicklee does not act as a proxy. It never sees your prompts or model responses — it only measures the hardware "effort" required to produce them, ensuring your data remains entirely within your sovereign boundary.',
              },
            ] as { label: string; body: string }[]).map(({ label, body }) => (
              <div key={label} className="flex gap-3">
                <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" aria-hidden="true" />
                <div>
                  <p className="text-xs font-semibold text-gray-200 font-sans mb-1">{label}</p>
                  <p className="text-sm text-gray-400 font-sans leading-relaxed">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Throughput Measurement ───────────────────────────────────────── */}
        <section>
          <SectionHeader
            title="Throughput Measurement"
            description="How Wicklee measures tok/s without synthetic traffic or request interception."
          />
          <div className="bg-gray-900 border border-indigo-500/20 rounded-2xl p-6 space-y-6">

            {/* Ollama */}
            <div className="flex gap-3">
              <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-xs font-semibold text-gray-200 font-sans mb-1">Ollama — Scheduled Probe</p>
                <p className="text-sm text-gray-400 font-sans leading-relaxed mb-2">
                  Every 30 seconds, the agent fires a 20-token generation request to <code className="text-indigo-300 text-xs">/api/generate</code> and
                  measures <code className="text-indigo-300 text-xs">eval_count ÷ eval_duration</code> — the pure generation phase, isolated from prompt load time.
                </p>
                <p className="text-sm text-gray-400 font-sans leading-relaxed">
                  <span className="text-gray-300 font-medium">Dynamic scheduling:</span> When GPU utilization is ≥ 40%, the probe is skipped.
                  Firing tokens into a loaded scheduler would queue behind the active job and return a depressed reading.
                  The agent writes <code className="text-indigo-300 text-xs">None</code> explicitly so the dashboard
                  switches to the estimation value rather than carrying forward a stale reading.
                  The 5-second <code className="text-indigo-300 text-xs">/api/ps</code> heartbeat continues regardless — keeping model presence and online status current.
                </p>
              </div>
            </div>

            <div className="border-t border-gray-800/60" />

            {/* vLLM */}
            <div className="flex gap-3">
              <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-xs font-semibold text-gray-200 font-sans mb-1">vLLM — Passive Prometheus Scrape</p>
                <p className="text-sm text-gray-400 font-sans leading-relaxed">
                  Zero synthetic tokens. The agent scrapes <code className="text-indigo-300 text-xs">vllm:avg_generation_throughput_toks_per_s</code> from
                  vLLM's Prometheus endpoint every 2 seconds. This gauge represents aggregate server throughput across all concurrent
                  requests — the right signal for fleet monitoring, and more accurate than a latency-inverse formula because vLLM
                  only exposes inter-token latency as a histogram, not a scalar.
                </p>
              </div>
            </div>

            <div className="border-t border-gray-800/60" />

            {/* Estimation Gap */}
            <div className="flex gap-3">
              <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-xs font-semibold text-gray-200 font-sans mb-1">Estimation Gap</p>
                <p className="text-sm text-gray-400 font-sans leading-relaxed mb-3">
                  When an Ollama probe is skipped, Wicklee estimates throughput from the session peak and live GPU utilization:
                </p>
                <p className="font-mono text-xs text-indigo-300 bg-indigo-500/5 border border-indigo-500/10 rounded-lg px-3 py-2 mb-3 leading-relaxed">
                  estimated_tps = Peak_TPS × GPU_Utilization%
                </p>
                <p className="text-sm text-gray-400 font-sans leading-relaxed">
                  <span className="text-gray-300 font-medium">Peak TPS</span> is the session high-water mark for the current model on this
                  node — the highest clean probe reading recorded since the session started or the last model swap. It resets
                  automatically on model change so a new model's throughput doesn't inherit a stale baseline.
                  This keeps TOK/S, WES, and Cost/1M meaningful during active inference rather than falling back to —.
                </p>
              </div>
            </div>

          </div>
        </section>

        {/* ── Node Metrics ─────────────────────────────────────────────────── */}
        <section>
          <SectionHeader
            title="Node Metrics"
            description="Per-node values derived from hardware telemetry and inference runtime."
          />
          <div className="space-y-4">

            <MetricCard
              id="wes"
              name="WES — Wicklee Efficiency Score"
              formula="tok/s ÷ (Watts × ThermalPenalty)"
              description="The single number that captures true inference efficiency. WES is tok/watt made thermally honest — when a node is healthy, WES equals tok/watt. When it's throttling, WES is lower, and the gap is exactly how much efficiency heat is costing you."
              ranges={[
                { threshold: '> 10',  color: 'emerald', label: 'Excellent · highly efficient (Apple M-series idle)' },
                { threshold: '3–10',  color: 'green',  label: 'Good · efficient for the power envelope' },
                { threshold: '1–3',   color: 'yellow', label: 'Acceptable · typical high-power hardware' },
                { threshold: '< 1',   color: 'red',    label: 'Low · check thermal state or model sizing' },
              ]}
              action="Check thermal state first. If throttling, reduce load or improve airflow. If thermal is Normal, the hardware is simply less efficient per watt — compare models or quantizations."
            />

            <MetricCard
              id="tok-s"
              name="TOK/S — Tokens Per Second"
              description="Raw inference throughput. Measured via a scheduled 20-token Ollama probe every 30 seconds, or passively from vLLM's Prometheus metrics endpoint. When the probe is skipped under GPU load, the value shown is an estimate (see Throughput Measurement above)."
              ranges={[
                { threshold: '> 50',  color: 'green', label: 'Fast · responsive for interactive use' },
                { threshold: '10–50', color: 'amber', label: 'Moderate · usable, not snappy' },
                { threshold: '< 10',  color: 'red',   label: 'Slow · model may be too large for hardware' },
              ]}
              action="Check memory headroom (model may be swapping), thermal state (throttling cuts tok/s 30–50%), and GPU utilization (low GPU% with low tok/s = runtime misconfiguration)."
            />

            <MetricCard
              id="tok-w"
              name="TOK/W — Tokens Per Watt"
              formula="tok/s ÷ (Watts / 1000)"
              description="Raw efficiency without thermal penalty — the energy cost of each token before thermal adjustment. When thermal is Normal, TOK/W ≈ WES. The gap between TOK/W and WES is your thermal cost. No universal range — compare nodes within your fleet. Higher is always better."
            />

            <MetricCard
              id="watts"
              name="WATTS — Board Power"
              description="Total power draw of the inference hardware in watts. Apple Silicon: CPU power via powermetrics (requires sudo). NVIDIA: board power via NVML (sudoless)."
              ranges={[
                { threshold: '< 15W',   color: 'green', label: 'Low draw · Apple Silicon or idle GPU' },
                { threshold: '15–150W', color: 'amber', label: 'Moderate · GPU under inference load' },
                { threshold: '> 150W',  color: 'red',   label: 'High draw · monitor for cost and thermals' },
              ]}
              action="Check GPU utilization. High watts + low GPU% = power anomaly (background process consuming power without doing inference work)."
            />

            <MetricCard
              id="gpu-pct"
              name="GPU% — GPU Utilization"
              description="Percentage of GPU compute capacity currently in use. Apple Silicon: read from AGX accelerator via ioreg (sudoless). NVIDIA: read via NVML (sudoless)."
              ranges={[
                { threshold: '60–95%',             color: 'green', label: 'Healthy inference load' },
                { threshold: '95–100%',             color: 'amber', label: 'Saturated · may queue requests' },
                { threshold: '< 30%',              color: 'amber', label: 'Underutilized · model may not be GPU-accelerated' },
                { threshold: '0% during inference', color: 'red',   label: 'Runtime misconfiguration · inference running on CPU' },
              ]}
            />

            <MetricCard
              id="memory"
              name="MEMORY — System Memory Pressure"
              description="Percentage of total system memory in use, combined with kernel memory pressure assessment. On Apple Silicon, unified memory serves both CPU and GPU — the model lives here alongside everything else."
              ranges={[
                { threshold: '< 60%',  color: 'green', label: 'Comfortable headroom' },
                { threshold: '60–80%', color: 'amber', label: 'Monitor · approaching pressure zone' },
                { threshold: '> 80%',  color: 'red',   label: 'High pressure · swap risk, tok/s may drop' },
              ]}
              action="The loaded model may be too large for this hardware. Wicklee's Model Fit Score will flag this before performance collapses."
            />

            <MetricCard
              id="vram"
              name="VRAM — GPU Memory Utilization"
              description="NVIDIA only. Percentage of dedicated GPU memory in use. Apple Silicon shows — · unified memory serves both roles and is covered by the MEMORY metric."
              ranges={[
                { threshold: '< 70%', color: 'green', label: 'Comfortable headroom' },
                { threshold: '70–90%', color: 'amber', label: 'Monitor · approaching limit' },
                { threshold: '> 90%',  color: 'red',   label: 'Near capacity · model eviction or OOM risk' },
              ]}
            />

            <MetricCard
              id="thermal"
              name="THERMAL STATE"
              description="The OS-level assessment of hardware thermal condition. macOS: read from pmset (sudoless). NVIDIA: inferred from GPU temperature via NVML."
              ranges={[
                { threshold: 'Normal',   color: 'green', label: '1.0× penalty — Hardware running within design limits' },
                { threshold: 'Fair',     color: 'amber', label: '1.25× penalty — Mild throttling beginning' },
                { threshold: 'Serious',  color: 'red',   label: '2.0× penalty — Active throttling · tok/s dropping' },
                { threshold: 'Critical', color: 'red',   label: '2.0×+ penalty — Severe throttling · reduce load immediately' },
              ]}
              action="Stop inference if possible. Check airflow, fan curve, and ambient temperature. A node at Serious thermal has already lost 30–50% of its tok/s invisibly."
            />

            <MetricCard
              id="w-1k"
              name="W/1K TKN — Wattage Per 1K Tokens"
              formula="(Watts / tok/s) × 1000"
              description="The energy cost of generating 1,000 tokens on this node right now. Lower is more energy-efficient. No universal range — compare nodes within your fleet and against cloud API pricing."
            />

            <MetricCard
              id="cost-1k"
              name="COST/1M TOKENS"
              formula="(W/1K TKN × (kWh_rate / 1000)) × 1000"
              description="Dollar cost of generating 1 million tokens based on your configured electricity rate (default $0.12/kWh). Shown per-million so you can compare directly against cloud API pricing (e.g. GPT-4o at ~$5/1M). Configure your electricity rate in Settings → Cost & Energy for accurate figures."
            />

          </div>
        </section>

        {/* ── Fleet Metrics ────────────────────────────────────────────────── */}
        <section>
          <SectionHeader
            title="Fleet Metrics"
            description="Aggregated across all paired nodes. Available in the cloud dashboard at wicklee.dev."
          />
          <div className="space-y-4">

            <MetricCard
              id="fleet-avg-wes"
              name="FLEET AVG WES"
              description="Average WES score across all online nodes. Weighted equally — not by throughput. A useful fleet health signal but not a routing decision — use Best Route Now for routing."
            />

            <MetricCard
              id="cost-efficiency"
              name="COST EFFICIENCY — $/1M Tokens"
              description="Fleet-level cost per million tokens at current draw and throughput. Uses per-node electricity rate and PUE multiplier from Settings. The sovereign fleet benchmark — compare to cloud API pricing to quantify your cost advantage."
            />

            <MetricCard
              id="tokens-per-watt"
              name="TOKENS PER WATT (Fleet)"
              formula="fleet_tok/s ÷ (total_fleet_watts / 1000)"
              description="Fleet-wide energy efficiency. Rises when efficient nodes (Apple Silicon) are active, falls when power-hungry nodes dominate the fleet."
            />

            <MetricCard
              id="fleet-health"
              name="FLEET HEALTH"
              description="Distribution of thermal states across all paired nodes. A node at Serious or Critical thermal state is already throttling — fleet health reflects how many nodes are in this condition simultaneously."
              ranges={[
                { threshold: 'All Normal',           color: 'green', label: 'All nodes running within design limits' },
                { threshold: 'Any Fair',             color: 'amber', label: 'Monitor · mild throttling on at least one node' },
                { threshold: 'Any Serious/Critical', color: 'red',   label: 'Active degradation · fleet efficiency is reduced' },
              ]}
            />

          </div>
        </section>

        {/* ── Configuration ────────────────────────────────────────────────── */}
        <section>
          <SectionHeader
            title="Configuration"
            description="User-configured multipliers and scores that affect cost and efficiency calculations."
          />
          <div className="space-y-4">

            <MetricCard
              id="pue"
              name="PUE — Power Usage Effectiveness"
              description="A multiplier accounting for datacenter overhead beyond raw node wattage (cooling, power delivery losses). Configure in Settings → Cost & Energy."
              ranges={[
                { threshold: '1.0',     color: 'gray', label: 'Home lab or direct plug measurement' },
                { threshold: '1.1–1.2', color: 'gray', label: 'Hyperscale colocation' },
                { threshold: '1.4–1.6', color: 'gray', label: 'Standard datacenter' },
              ]}
            />

            <MetricCard
              id="model-fit"
              name="MODEL FIT SCORE"
              description="Correlates loaded model size against available memory and thermal state to assess whether this hardware is well-matched for this model. Appears in the Insights tab when a model is loaded."
              ranges={[
                { threshold: 'Good', color: 'green', label: 'Model fits with >20% memory headroom, Normal thermal' },
                { threshold: 'Fair', color: 'amber', label: 'Model fits but headroom is tight or thermal is Fair' },
                { threshold: 'Poor', color: 'red',   label: 'Model exceeds available memory or thermal is Serious' },
              ]}
            />

          </div>
        </section>

      </div>
    </div>
  );
};

export default MetricsPage;
