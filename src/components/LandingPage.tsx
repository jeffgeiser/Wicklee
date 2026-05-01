import React, { useState } from 'react';
import { Cpu, Zap, Activity, Terminal, ChevronRight, Database, Thermometer, Copy, Check, Flame, MemoryStick, ShieldCheck, Route, ClipboardCheck, TrendingDown, BarChart2, Gauge, Waves, HardDrive, Server } from 'lucide-react';
import Logo from './Logo';

interface LandingPageProps {
  onSignIn: () => void;
  onSignUp: () => void;
  onNavigate?: (path: string) => void;
}

const FeatureCard: React.FC<{ icon: React.ElementType, title: string, description: string }> = ({ icon: Icon, title, description }) => (
  <div className="p-6 bg-gray-800 border border-gray-700 rounded-2xl hover:border-blue-500/30 transition-all group">
    <div className="w-12 h-12 bg-blue-600/10 border border-blue-500/20 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
      <Icon className="w-6 h-6 text-cyan-400" />
    </div>
    <h3 className="text-xl font-bold text-white mb-2">{title}</h3>
    <p className="text-gray-400 leading-relaxed text-sm">
      {description}
    </p>
  </div>
);

// ── Why Wicklee — Part 1 ──────────────────────────────────────────────────────

// ── All 18 observation patterns ──────────────────────────────────────────────

interface ObsTile {
  id: string;
  title: string;
  trigger: string;
  scope: 'Cloud' | null;      // only "Cloud" gets a badge; null = available everywhere
  tier: 'community' | 'pro';  // Pro gets a small badge
  icon: React.ReactElement;
}

const allPatterns: ObsTile[] = [
  // Community patterns (9)
  { id: 'A', title: 'Thermal Performance Drain',   trigger: 'Your GPU is thermally throttling, silently reducing throughput below its rated speed.',                                    scope: null,    tier: 'community', icon: <Thermometer className="w-4 h-4 text-amber-400" />  },
  { id: 'B', title: 'Phantom Load',                trigger: 'A model is loaded in memory and drawing power, but nobody is using it.',                                                    scope: null,    tier: 'community', icon: <Zap         className="w-4 h-4 text-violet-400" /> },
  { id: 'C', title: 'WES Velocity Drop',           trigger: 'Efficiency score is declining steadily before thermal state has changed — an early warning.',                                scope: null,    tier: 'community', icon: <TrendingDown className="w-4 h-4 text-indigo-400" /> },
  { id: 'F', title: 'Memory Pressure Trajectory',  trigger: 'Memory pressure is climbing steadily — projected to reach critical levels and trigger swap.',                               scope: null,    tier: 'community', icon: <MemoryStick className="w-4 h-4 text-cyan-400" />  },
  { id: 'H', title: 'Power Jitter',                trigger: 'Power draw is swinging wildly during inference — unstable delivery or erratic batch scheduling.',                            scope: null,    tier: 'community', icon: <Waves       className="w-4 h-4 text-orange-400" /> },
  { id: 'J', title: 'Swap I/O Pressure',           trigger: 'Model layers are spilling to disk during inference, causing latency spikes.',                                               scope: null,    tier: 'community', icon: <HardDrive   className="w-4 h-4 text-rose-400" />   },
  { id: 'K', title: 'Clock Drift',                 trigger: 'GPU clocks are throttled during inference but thermals are normal — a power cap or driver limit.',                           scope: null,    tier: 'community', icon: <Gauge       className="w-4 h-4 text-lime-400" />   },
  { id: 'N', title: 'NVIDIA Thermal Redline',      trigger: 'GPU temperature is dangerously high — the driver will aggressively throttle clocks.',                                       scope: null,    tier: 'community', icon: <Flame       className="w-4 h-4 text-red-400" />    },
  { id: 'O', title: 'VRAM Overcommit',             trigger: 'The loaded model consumes nearly all available memory — no headroom for KV cache or concurrency.',                          scope: null,    tier: 'community', icon: <MemoryStick className="w-4 h-4 text-emerald-400" /> },
  // Pro patterns (9)
  { id: 'D', title: 'Power-GPU Decoupling',        trigger: 'High power draw but the GPU is barely active — inference is running on CPU instead of GPU.',                                 scope: null,    tier: 'pro', icon: <Cpu         className="w-4 h-4 text-cyan-400" />    },
  { id: 'E', title: 'Fleet Load Imbalance',        trigger: 'This node is stressed while a healthier fleet peer has spare capacity.',                                                     scope: 'Cloud', tier: 'pro', icon: <BarChart2   className="w-4 h-4 text-blue-400" />    },
  { id: 'G', title: 'Bandwidth Saturation',        trigger: 'VRAM is nearly full but the GPU compute is barely used — a memory bandwidth bottleneck, not compute.',                       scope: null,    tier: 'pro', icon: <Gauge       className="w-4 h-4 text-emerald-400" /> },
  { id: 'I', title: 'Efficiency Penalty Drag',     trigger: 'Significant efficiency loss with normal thermals and no memory pressure — a hidden context or batch inefficiency.',           scope: null,    tier: 'pro', icon: <TrendingDown className="w-4 h-4 text-yellow-400" /> },
  { id: 'L', title: 'PCIe Lane Degradation',       trigger: 'GPU is running in a reduced PCIe lane width, limiting data transfer bandwidth.',                                            scope: null,    tier: 'pro', icon: <Server      className="w-4 h-4 text-orange-400" /> },
  { id: 'M', title: 'vLLM KV Cache Saturation',    trigger: 'The vLLM KV cache is nearly full — new sequences will queue or get rejected.',                                              scope: null,    tier: 'pro', icon: <Database    className="w-4 h-4 text-pink-400" />   },
  { id: 'P', title: 'TTFT Regression',             trigger: 'Time to first token has spiked above 2x the recent baseline — queue contention or model swap.',                             scope: null,    tier: 'pro', icon: <Activity    className="w-4 h-4 text-pink-400" />   },
  { id: 'Q', title: 'Latency Spike',               trigger: 'End-to-end request latency exceeds 2 seconds sustained — inference pipeline bottleneck.',                                    scope: null,    tier: 'pro', icon: <Thermometer className="w-4 h-4 text-red-300" />    },
  { id: 'R', title: 'vLLM Queue Saturation',       trigger: 'Requests are queuing faster than the engine can process — scale horizontally or reroute.',                                   scope: null,    tier: 'pro', icon: <Gauge       className="w-4 h-4 text-violet-300" /> },
];

const LandingPage: React.FC<LandingPageProps> = ({ onSignIn, onSignUp, onNavigate }) => {
  // H4 — Use React state for copy-button feedback instead of direct DOM
  // mutation via btn.innerHTML.  The old pattern bypassed React's virtual DOM,
  // caused unnecessary re-renders of sibling nodes, and created a surface for
  // XSS if the originalText variable ever held non-static content.
  const [copiedMac, setCopiedMac] = useState(false);
  const [copiedWin, setCopiedWin] = useState(false);
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 selection:bg-blue-600 selection:text-white">
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] bg-cyan-400/10 blur-[120px] rounded-full"></div>
      </div>

      {/* Navigation */}
      <nav className="max-w-7xl mx-auto px-4 sm:px-8 py-5 sm:py-8 flex items-center justify-between relative z-10">
        <Logo className="text-3xl" connectionState="connected" />
        <div className="flex items-center gap-4 sm:gap-8">
          <button onClick={() => onNavigate('/docs')} className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors">Documentation</button>
          <button onClick={() => onNavigate?.('/pricing')} className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors">Pricing</button>
          <button
            onClick={() => onNavigate?.('/blog')}
            className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors"
          >
            Blog
          </button>
          <a
            href="https://github.com/jeffgeiser/Wicklee"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors"
          >
            GitHub
          </a>
          <button
            onClick={onSignIn}
            className="px-4 sm:px-6 py-2 border border-gray-700 hover:border-gray-500 text-white text-sm font-bold rounded-xl transition-all"
          >
            Sign In
          </button>
          <button
            onClick={onSignUp}
            className="px-4 sm:px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20"
          >
            Get Started
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-5xl mx-auto px-4 sm:px-8 pt-12 sm:pt-20 pb-16 sm:pb-32 text-center relative z-10">
        <h1 className="text-4xl sm:text-6xl md:text-7xl font-extrabold tracking-tight text-white mb-6 leading-[1.1]">
          Local AI inference,{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-cyan-400">
            finally observable.
          </span>
        </h1>
        <p className="text-base sm:text-xl text-gray-400 max-w-3xl mx-auto mb-10 leading-relaxed">
          Thermal intelligence. WES (thermally-honest MPG for AI) and 18 observation patterns. No proxy unless you want production-grade metrics. Install in 60 seconds — nothing to configure.
        </p>
        <div className="flex items-center justify-center">
          <button
            onClick={onSignUp}
            className="w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-2xl transition-all shadow-xl shadow-blue-500/30 flex items-center justify-center gap-2 text-lg"
          >
            Create Account — Free
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          No account needed for local-only
        </p>
        <p className="mt-1 text-xs text-gray-600">
          100% local by default · Nothing leaves your machine · Optional cloud pairing &amp; enterprise exports
        </p>
      </section>

      {/* Install Command Section */}
      <section className="max-w-3xl mx-auto px-4 sm:px-8 pb-16 sm:pb-32 relative z-10">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 sm:p-6 shadow-2xl relative group overflow-hidden">
          <div className="absolute inset-0 bg-blue-500/5 pointer-events-none"></div>
          <div className="relative z-10 space-y-4">
            {/* macOS / Linux */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="font-mono text-sm overflow-x-auto w-full space-y-2 min-w-0">
                <p className="text-zinc-500 whitespace-nowrap"># macOS &amp; Linux</p>
                <p className="text-white whitespace-nowrap">curl -fsSL https://wicklee.dev/install.sh | bash</p>
                <p className="text-zinc-500 whitespace-nowrap"># Then: sudo wicklee --install-service &nbsp;<span className="text-green-500/70">← runs on every boot</span></p>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText('curl -fsSL https://wicklee.dev/install.sh | bash');
                  setCopiedMac(true);
                  setTimeout(() => setCopiedMac(false), 2000);
                }}
                className="shrink-0 self-end sm:self-auto p-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-400 hover:text-white transition-all flex items-center gap-2 text-xs font-bold whitespace-nowrap"
              >
                {copiedMac
                  ? <><Check className="w-4 h-4 text-green-400" /><span className="text-green-400">Copied!</span></>
                  : <><Copy className="w-4 h-4" />Copy</>
                }
              </button>
            </div>
            {/* Windows */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 pt-3 border-t border-zinc-800">
              <div className="font-mono text-sm overflow-x-auto w-full space-y-2 min-w-0">
                <p className="text-zinc-500 whitespace-nowrap"># Windows (PowerShell)</p>
                <p className="text-white whitespace-nowrap">irm https://wicklee.dev/install.ps1 | iex</p>
                <p className="text-zinc-500 whitespace-nowrap"># Then: wicklee --install-service &nbsp;<span className="text-green-500/70">← runs on every boot</span></p>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText('irm https://wicklee.dev/install.ps1 | iex');
                  setCopiedWin(true);
                  setTimeout(() => setCopiedWin(false), 2000);
                }}
                className="shrink-0 self-end sm:self-auto p-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-400 hover:text-white transition-all flex items-center gap-2 text-xs font-bold whitespace-nowrap"
              >
                {copiedWin
                  ? <><Check className="w-4 h-4 text-green-400" /><span className="text-green-400">Copied!</span></>
                  : <><Copy className="w-4 h-4" />Copy</>
                }
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Feature Grid */}
      <section className="max-w-7xl mx-auto px-4 sm:px-8 py-16 sm:py-32 border-t border-gray-800 relative z-10">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <FeatureCard
            icon={Cpu}
            title="See every node"
            description="Live GPU temp, VRAM usage, and inference throughput across your entire fleet — auto-detected, zero configuration."
          />
          <FeatureCard
            icon={Activity}
            title="Thermal Intelligence"
            description="Monitor thermal thresholds and health signals across your entire fleet. Prevent hardware degradation with real-time alerts and WES-aware health telemetry."
          />
          <FeatureCard
            icon={Terminal}
            title="Understand your costs"
            description="WES — the MPG for AI — scores each node on tok/s per watt, thermally adjusted. Wattage-per-Token is the metric cloud providers don't surface. Now you have it for your local fleet."
          />
        </div>
      </section>

      {/* ── Why Wicklee Section ─────────────────────────────────────────────────── */}
      <section className="max-w-7xl mx-auto px-4 sm:px-8 pb-20 sm:pb-40 relative z-10 space-y-16 sm:space-y-24">

        {/* Part 1 — Standard monitors stop at the hardware */}
        <div>
          <p className="text-xs font-bold text-red-400 uppercase tracking-widest mb-4 text-center">The problem</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3 tracking-tight max-w-3xl text-center mx-auto">
            Standard monitors stop at the hardware. We see the inference layer.
          </h2>
          <p className="text-gray-400 text-base sm:text-lg max-w-2xl mb-10 text-center mx-auto">
            vLLM and Ollama report throughput and queue depth. Wicklee adds power, thermal, and fleet intelligence — the metrics that define your real-world efficiency.
          </p>

          {/* 2-column comparison: Runtime vs Wicklee */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {/* Left: What your runtime shows */}
            <div className="bg-gray-800/40 border border-gray-700 rounded-2xl p-6">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-4">Your runtime</p>
              <div className="space-y-3">
                {([
                  { icon: <Activity  className="w-4 h-4 text-gray-500" />, title: 'Tokens Per Second',  desc: 'Raw throughput from your runtime response' },
                  { icon: <Database  className="w-4 h-4 text-gray-500" />, title: 'VRAM & Model Size',  desc: 'Which model is loaded and how much memory it uses' },
                  { icon: <BarChart2 className="w-4 h-4 text-gray-500" />, title: 'Queue Depth',        desc: 'How many requests are waiting (vLLM only)' },
                ] as const).map(item => (
                  <div key={item.title} className="bg-gray-700/50 border border-gray-700/50 rounded-xl p-4 flex items-start gap-3">
                    <span className="shrink-0 mt-0.5">{item.icon}</span>
                    <div>
                      <p className="text-sm font-semibold text-gray-400">{item.title}</p>
                      <p className="text-xs text-gray-600 mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: What Wicklee adds */}
            <div className="bg-gray-800/40 border border-gray-700 rounded-2xl p-6">
              <p className="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-4">Wicklee adds</p>
              <div className="space-y-3">
                {([
                  { icon: <Zap          className="w-4 h-4 text-emerald-400" />, title: 'WES — tok/watt',            desc: 'Thermally-honest efficiency. The metric neither runtime exposes.',            border: 'border-emerald-500/30' },
                  { icon: <Thermometer  className="w-4 h-4 text-amber-400" />,   title: 'Power & Thermal',           desc: 'Real-time watts and thermal state from NVML, IOKit, and RAPL.',               border: 'border-amber-500/30' },
                  { icon: <Route        className="w-4 h-4 text-blue-400" />,    title: 'Fleet Routing',             desc: 'Cross-node routing decisions based on live WES and availability.',             border: 'border-blue-500/30' },
                  { icon: <ShieldCheck  className="w-4 h-4 text-violet-400" />,  title: '18 Observation Patterns',   desc: 'Correlate signals no single runtime exposes — from TTFT regression to queue saturation.', border: 'border-violet-500/30' },
                ] as const).map(item => (
                  <div key={item.title} className={`bg-gray-700/50 border ${item.border} rounded-xl p-4 flex items-start gap-3`}>
                    <span className="shrink-0 mt-0.5">{item.icon}</span>
                    <div>
                      <p className="text-sm font-semibold text-white">{item.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Part 2 — 18 Hardware Observation Patterns */}
        <div>
          <p className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-4 text-center">What Wicklee surfaces</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3 tracking-tight max-w-3xl text-center mx-auto">
            18 hardware observation patterns. Zero AI hallucination.
          </h2>
          <p className="text-gray-400 text-base sm:text-lg max-w-2xl mb-10 text-center mx-auto">
            Pure arithmetic over time-windowed telemetry. Every pattern requires sustained evidence before firing — single-frame spikes never produce an alert.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {allPatterns.map((p) => (
              <div key={p.id} className="bg-gray-800 border border-gray-700 rounded-2xl p-5 hover:border-gray-700 transition-all">
                <div className="flex items-center gap-2 mb-3">
                  {p.icon}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-white truncate">{p.title}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {p.scope === 'Cloud' && (
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded">Cloud</span>
                      )}
                      {p.tier === 'pro' && (
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 rounded">Pro</span>
                      )}
                    </div>
                  </div>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed">{p.trigger}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Part 3 — Sovereign by design */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-[32px] p-6 sm:p-12">
          <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-4 text-center">Architecture</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-10 tracking-tight text-center">Sovereign by design.</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-start">
            {/* Left — paragraph */}
            <div className="space-y-4 text-gray-400 text-sm sm:text-base leading-relaxed">
              <p>
                Most fleet monitors require your hardware data to leave your network by default. Wicklee is different.
              </p>
              <p>
                The agent runs entirely on your machine. Nothing leaves until you explicitly pair a node to the Fleet View. For teams handling sensitive workloads, this isn't a nice-to-have — it's a requirement.
              </p>
            </div>

            {/* Right — comparison table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700">
                    <th className="text-left text-xs text-gray-500 font-medium pb-3 pr-6 uppercase tracking-wider w-1/2"></th>
                    <th className="text-center text-xs text-gray-500 font-medium pb-3 px-4 uppercase tracking-wider">Others</th>
                    <th className="text-center text-xs text-blue-400 font-bold pb-3 pl-4 uppercase tracking-wider">Wicklee</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/60">
                  {[
                    ['Default mode',    'Cloud-first',   'Local-first'],
                    ['Data residency',  'Their servers', 'Your machine'],
                    ['Config required', 'Yes',           'Zero'],
                    ['Purpose-built',   'General',       'Inference'],
                    ['Audit trail',     'Trust us',      'Structural'],
                  ].map(([label, other, us]) => (
                    <tr key={label} className="group">
                      <td className="py-3 pr-6 text-gray-400 text-xs font-medium">{label}</td>
                      <td className="py-3 px-4 text-center text-xs text-gray-500">{other}</td>
                      <td className="py-3 pl-4 text-center text-xs font-semibold text-green-400">{us}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {/* Callout tiles — side by side below the grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-8">
            <div className="flex items-start gap-3 p-4 bg-green-500/5 border border-green-500/20 rounded-xl">
              <ShieldCheck className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <p className="text-sm text-green-300/80">
                Structural guarantee, not a privacy policy. The agent has no outbound connections by default — there's nothing to configure or accidentally misconfigure.
              </p>
            </div>
            <div className="flex items-start gap-3 p-4 bg-indigo-500/5 border border-indigo-500/20 rounded-xl">
              <Terminal className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
              <p className="text-sm text-indigo-300/80">
                Prefer to run locally? The agent exposes a full local dashboard at{' '}
                <a href="http://localhost:7700" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-indigo-200 transition-colors">localhost:7700</a>
                {' '}— no cloud account required, zero configuration, works the moment the agent starts.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Observe Without Interfering Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-8 pb-20 sm:pb-32 relative z-10">
        <div className="bg-gray-800/50 border border-gray-700 rounded-[32px] p-6 sm:p-12">
          <p className="text-xs font-bold text-cyan-400 uppercase tracking-widest mb-4 text-center">Zero Interference</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-6 tracking-tight text-center">Observe without interfering.</h2>
          <p className="text-gray-400 text-sm sm:text-base leading-relaxed max-w-3xl mx-auto mb-10 text-center">
            Wicklee is designed not to sit in your inference path by default.
            We use a lightweight synthetic probe (20 tokens every ~30 seconds) to status your models while keeping your real traffic private and untouched.
            For users who need deeper real-traffic visibility — true RPS, queue depth, exact KV cache hit rate, production latency histograms — enable the optional inline proxy: a transparent layer with near-zero overhead.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
            <div className="p-5 bg-green-500/5 border border-green-500/20 rounded-2xl">
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="w-5 h-5 text-green-400" />
                <h4 className="text-sm font-bold text-green-300 uppercase tracking-wider">Default</h4>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">
                Maximum privacy + zero added latency. Recommended for most users. Your real inference traffic is never touched.
              </p>
            </div>
            <div className="p-5 bg-indigo-500/5 border border-indigo-500/20 rounded-2xl">
              <div className="flex items-center gap-2 mb-3">
                <Activity className="w-5 h-5 text-indigo-400" />
                <h4 className="text-sm font-bold text-indigo-300 uppercase tracking-wider">With Proxy</h4>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">
                Full production metrics from real requests. Per-request TTFT, end-to-end latency, throughput aggregates, and queue depth. Opt-in only.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Multi-Model Intelligence Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-8 pb-20 sm:pb-32 relative z-10">
        <div className="bg-gray-800/50 border border-gray-700 rounded-[32px] p-6 sm:p-12">
          <p className="text-xs font-bold text-cyan-400 uppercase tracking-widest mb-4 text-center">Multi-Model</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-6 tracking-tight text-center">Every model. Tracked independently.</h2>
          <p className="text-gray-400 text-sm sm:text-base leading-relaxed max-w-3xl mx-auto mb-10 text-center">
            Your agents use multiple models — a coding model, a chat model, an embedding model. Every other monitoring tool collapses them into one GPU metric. Wicklee tracks each model's performance, cost, and resource consumption independently.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto mb-8">
            {[
              { label: 'Per-Model tok/s', desc: 'Independent throughput measurement for each loaded model from real production requests.' },
              { label: 'Per-Model VRAM', desc: 'Exact GPU memory allocation per model — see how your VRAM budget is divided across concurrent models.' },
              { label: 'Per-Model TTFT', desc: 'Time to first token tracked independently — find which model is slowing your agent pipeline.' },
              { label: 'Per-Model Cost', desc: 'Daily electricity cost per model based on actual power draw at your local rate.' },
              { label: 'Model Comparison', desc: 'Side-by-side WES, tok/s, watts, TTFT, and cost for every model that has run on your hardware.' },
              { label: 'Automatic Detection', desc: 'No configuration. Wicklee reads all loaded models from Ollama and tracks them as they come and go.' },
            ].map((t) => (
              <div key={t.label} className="p-4 bg-gray-700/40 border border-gray-700/50 rounded-xl">
                <p className="text-sm font-semibold text-white mb-1">{t.label}</p>
                <p className="text-[11px] text-gray-500 leading-relaxed">{t.desc}</p>
              </div>
            ))}
          </div>
          <div className="flex items-start gap-3 p-4 bg-cyan-500/5 border border-cyan-500/20 rounded-xl max-w-3xl mx-auto">
            <Cpu className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
            <p className="text-sm text-cyan-300/80">
              With the optional proxy enabled, every request is attributed to its model automatically. Without the proxy, Wicklee still tracks all loaded models and their VRAM — full per-model analytics require the proxy for production request metrics.
            </p>
          </div>
        </div>
      </section>

      {/* Built for Agents & LLMs Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-8 pb-20 sm:pb-32 relative z-10">
        <div className="bg-gray-800/50 border border-gray-700 rounded-[32px] p-6 sm:p-12">
          <p className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-4 text-center">MCP</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-6 tracking-tight text-center">Built for agents &amp; LLMs.</h2>
          <p className="text-gray-400 text-sm sm:text-base leading-relaxed max-w-3xl mx-auto mb-10 text-center">
            Wicklee includes a Local MCP Server (available to everyone) so AI agents and tools like Claude Desktop and Cursor
            can directly query your fleet status, WES scores, thermal state, and observations — all while staying fully on-device.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto mb-8">
            {[
              { tool: 'get_node_status', desc: 'Full hardware + inference snapshot' },
              { tool: 'get_inference_state', desc: 'Live/idle/busy with sensor context' },
              { tool: 'get_active_models', desc: 'Models across Ollama, vLLM, llama.cpp' },
              { tool: 'get_observations', desc: 'Thermal, power, memory patterns' },
              { tool: 'get_metrics_history', desc: '1-hour rolling telemetry buffer' },
              { tool: 'wicklee://node/*', desc: 'MCP resources for live metrics' },
            ].map((t) => (
              <div key={t.tool} className="p-3 bg-gray-700/40 border border-gray-700/50 rounded-xl">
                <p className="text-xs font-mono text-blue-400 mb-1">{t.tool}</p>
                <p className="text-[10px] text-gray-500">{t.desc}</p>
              </div>
            ))}
          </div>
          <div className="text-center">
            <div className="inline-block bg-gray-900 border border-gray-700 rounded-xl px-5 py-3 font-mono text-xs text-gray-400">
              <span className="text-cyan-400">POST</span> localhost:7700/mcp
              <span className="text-gray-600 ml-2">// JSON-RPC 2.0 · no auth · all tiers</span>
            </div>
          </div>
        </div>
      </section>

      {/* The Programmable Fleet Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-8 pb-20 sm:pb-32 relative z-10">
        <div className="text-center mb-4">
          <span className="font-mono text-xs text-indigo-400/70 tracking-wider">
            GET /api/v1/fleet · GET /api/v1/route/best
          </span>
        </div>
        <div className="text-center mb-12">
          <h2 className="text-4xl sm:text-5xl font-bold text-white mb-6 tracking-tight">
            The Programmable Fleet
          </h2>
          <p className="text-gray-400 text-lg leading-relaxed max-w-2xl mx-auto">
            Build automation on real-time fleet intelligence. Every metric Wicklee collects
            is queryable via a rate-limited REST API designed for operator scripting.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-6">
          <FeatureCard
            icon={Route}
            title="Programmable Routing"
            description="Route requests with efficiency-aware intelligence. Query /api/v1/route/best to select the optimal node for each task based on live thermal health, runtime backlogs, and Efficiency Score."
          />
          <FeatureCard
            icon={Zap}
            title="Reactive Automation"
            description="Drive rerouting and rebalancing scripts from live fleet telemetry. Set thresholds on memory saturation, thermal state, or WES to programmatically shift load to a healthier node — before users notice degradation."
          />
          <FeatureCard
            icon={ClipboardCheck}
            title="Performance CI/CD"
            description="Plug node-level tok/s into your deployment pipeline. Automatically flag model quantizations that regress performance on your specific hardware mix before they reach production."
          />
        </div>
      </section>

      {/* Grows With You Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-8 pb-20 sm:pb-32 relative z-10">
        <div className="bg-gray-800/50 border border-gray-700 rounded-[32px] p-6 sm:p-12">
          <p className="text-xs font-bold text-amber-400 uppercase tracking-widest mb-4 text-center">Scale</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-6 tracking-tight text-center">Grows with you — from local to enterprise.</h2>
          <p className="text-gray-400 text-sm sm:text-base leading-relaxed max-w-3xl mx-auto mb-10 text-center">
            Start 100% locally with full sovereignty.
            When your fleet scales or your organization requires enterprise observability, Wicklee becomes the bridge — enriching your existing tools with the hardware context they're missing.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div className="p-5 bg-gray-700/40 border border-gray-700/50 rounded-2xl">
              <BarChart2 className="w-6 h-6 text-amber-400 mb-3" />
              <h4 className="text-sm font-bold text-white mb-2">OpenTelemetry Export</h4>
              <p className="text-xs text-gray-500 leading-relaxed">
                Enrich Datadog, Grafana, and New Relic LLM traces with GPU utilization, thermal state, and WES context from every node.
              </p>
            </div>
            <div className="p-5 bg-gray-700/40 border border-gray-700/50 rounded-2xl">
              <Gauge className="w-6 h-6 text-amber-400 mb-3" />
              <h4 className="text-sm font-bold text-white mb-2">Prometheus Endpoint</h4>
              <p className="text-xs text-gray-500 leading-relaxed">
                Expose WES scores, thermal patterns, and node intelligence as Prometheus metrics for your existing alerting stack.
              </p>
            </div>
            <div className="p-5 bg-gray-700/40 border border-gray-700/50 rounded-2xl">
              <Server className="w-6 h-6 text-amber-400 mb-3" />
              <h4 className="text-sm font-bold text-white mb-2">MCP Server</h4>
              <p className="text-xs text-gray-500 leading-relaxed">
                Give AI agents direct access to fleet state, routing recommendations, and hardware-aware inference decisions via Model Context Protocol.
              </p>
            </div>
          </div>
          <p className="mt-6 text-xs text-gray-600">
            Team tier unlocks enterprise bridge features, shared dashboards, and the MCP server.
          </p>
        </div>
      </section>

      {/* How it works Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-8 pb-20 sm:pb-40 relative z-10">
        <div className="bg-gray-800/50 border border-gray-700 rounded-[32px] p-6 sm:p-12 overflow-hidden relative">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 sm:gap-16 items-center">
            <div>
              <h2 className="text-4xl font-bold text-white mb-8 tracking-tight">How it works</h2>
              <div className="space-y-8">
                <div className="flex items-start gap-6">
                  <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold shrink-0 shadow-lg shadow-blue-500/20">1</div>
                  <div>
                    <h4 className="text-white font-semibold text-lg mb-1">Install the agent</h4>
                    <p className="text-gray-500 leading-relaxed">One curl command, works on Linux and macOS. The binary is self-contained with zero dependencies.</p>
                  </div>
                </div>
                <div className="flex items-start gap-6">
                  <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold shrink-0 shadow-lg shadow-blue-500/20">2</div>
                  <div>
                    <h4 className="text-white font-semibold text-lg mb-1">Your fleet appears automatically</h4>
                    <p className="text-gray-500 leading-relaxed">Wicklee detects Ollama and vLLM nodes with no configuration. Instant telemetry across your entire network.</p>
                  </div>
                </div>
                <div className="flex items-start gap-6">
                  <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold shrink-0 shadow-lg shadow-blue-500/20">3</div>
                  <div>
                    <h4 className="text-white font-semibold text-lg mb-1">Wicklee watches your hardware</h4>
                    <p className="text-gray-500 leading-relaxed">Set custom thermal thresholds and receive Slack or email alerts when nodes throttle. Use the Agent API to drive your own failover logic and protect your silicon.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="relative">
              <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 font-mono text-xs text-gray-500 shadow-2xl overflow-x-auto">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-3 h-3 rounded-full bg-red-500/50"></div>
                  <div className="w-3 h-3 rounded-full bg-amber-500/50"></div>
                  <div className="w-3 h-3 rounded-full bg-green-500/50"></div>
                </div>
                <div className="space-y-1">
                  <p className="text-cyan-400">GET /api/metrics  <span className="text-gray-600">— 1 Hz SSE stream</span></p>
                  <p className="text-gray-300">{"{"}</p>
                  <p className="pl-4">"node_id": "<span className="text-blue-400">WK-3A7F</span>",</p>
                  <p className="pl-4">"hostname": "mac-studio-01",</p>
                  <p className="pl-4">"inference_state": "<span className="text-green-400">live</span>",</p>
                  <p className="pl-4">"gpu_utilization_percent": 94.2,</p>
                  <p className="pl-4">"apple_soc_power_w": 28.6,</p>
                  <p className="pl-4">"thermal_state": "<span className="text-green-400">Normal</span>",</p>
                  <p className="pl-4">"ollama_active_model": "llama3:70b-q4_K_M",</p>
                  <p className="pl-4">"ollama_tokens_per_second": 18.4,</p>
                  <p className="pl-4">"penalty_avg": 1.0</p>
                  <p className="text-gray-300">{"}"}</p>
                  <p className="mt-4 text-green-400">// localhost:7700 — no auth required</p>
                </div>
              </div>
              {/* Floating decorative elements */}
              <div className="absolute -top-6 -right-6 w-32 h-32 bg-blue-600/20 rounded-full blur-3xl"></div>
              <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-cyan-400/10 rounded-full blur-3xl"></div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-16 text-center text-sm text-gray-500">
        <p>&copy; 2026 Wicklee OSS Project. All rights reserved.</p>
        <div className="flex items-center justify-center gap-6 mt-4">
          <button onClick={() => onNavigate('/docs')} className="hover:text-white transition-colors">Documentation</button>
          <button onClick={() => onNavigate('/terms')} className="hover:text-white transition-colors">Terms</button>
          <button onClick={() => onNavigate('/privacy')} className="hover:text-white transition-colors">Privacy</button>
          <button onClick={() => onNavigate('/refund')} className="hover:text-white transition-colors">Refunds</button>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
