import React, { useState } from 'react';
import { Cpu, Zap, Activity, Terminal, BrainCircuit, ChevronRight, Lock, Database, Thermometer, Github, Copy, Check, AlertTriangle, Flame, MemoryStick, TrendingDown, Eye, ShieldCheck, BarChart3, Snowflake, Route, ClipboardCheck } from 'lucide-react';
import Logo from './Logo';

interface LandingPageProps {
  onSignIn: () => void;
  onSignUp: () => void;
  onNavigate?: (path: string) => void;
}

const FeatureCard: React.FC<{ icon: React.ElementType, title: string, description: string }> = ({ icon: Icon, title, description }) => (
  <div className="p-6 bg-gray-900 border border-gray-800 rounded-2xl hover:border-blue-500/30 transition-all group">
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

const problemCards = [
  {
    accent: 'border-red-500/40',
    iconBg: 'bg-red-500/10',
    icon: Flame,
    iconColor: 'text-red-400',
    title: 'GPU Throttling',
    body: 'GPU util shows 100% but clock speed dropped 33%. Your tokens/sec silently halved. No alert fired.',
  },
  {
    accent: 'border-amber-500/40',
    iconBg: 'bg-amber-500/10',
    icon: Database,
    iconColor: 'text-amber-400',
    title: 'KV Cache Saturation (vLLM)',
    body: 'KV cache pressure detected natively via the vLLM Prometheus endpoint. Queue backlogs surface before they stall your inference stream.',
  },
  {
    accent: 'border-red-500/40',
    iconBg: 'bg-red-500/10',
    icon: Thermometer,
    iconColor: 'text-red-400',
    title: 'Thermal Degradation',
    body: 'Node-3 crossed into SERIOUS thermal state. Wicklee quantifies the throughput cost in real time — not two unrelated graphs.',
  },
  {
    accent: 'border-amber-500/40',
    iconBg: 'bg-amber-500/10',
    icon: MemoryStick,
    iconColor: 'text-amber-400',
    title: 'Memory Exhaustion',
    body: 'Your 70B model needs 40GB. You have 2GB of unified memory headroom. You\'ll find out when it swaps.',
  },
];

// ── Why Wicklee — Part 2 ──────────────────────────────────────────────────────

const metricCards = [
  {
    iconBg: 'bg-red-500/10',
    icon: Flame,
    iconColor: 'text-red-400',
    title: 'Thermal Degradation Correlation',
    body: 'When thermal state changes, tok/s follows. The gap between your hardware\'s rated speed and its throttled reality is your Thermal Cost — Wicklee quantifies it in real time, not two unrelated graphs.',
  },
  {
    iconBg: 'bg-cyan-500/10',
    icon: Zap,
    iconColor: 'text-cyan-400',
    title: 'Wattage / 1K Tokens',
    body: 'M3 Max vs RTX 4090 vs Jetson Orin — which is cheapest per token for your model? Live answer across mixed hardware.',
  },
  {
    iconBg: 'bg-blue-500/10',
    icon: MemoryStick,
    iconColor: 'text-blue-400',
    title: 'Unified Memory Pressure %',
    body: 'Beyond used/available. The kernel\'s own stress signal — the metric that predicts swap storms before they hit.',
  },
  {
    iconBg: 'bg-amber-500/10',
    icon: AlertTriangle,
    iconColor: 'text-amber-400',
    title: 'Power Anomaly Detection',
    body: '450W draw at 30% GPU util is wrong. Wicklee flags the mismatch. Standard tools see two unrelated numbers.',
  },
  {
    iconBg: 'bg-purple-500/10',
    icon: Activity,
    iconColor: 'text-purple-400',
    title: 'Cold Start Detection',
    body: 'GPU spike + VRAM jump = cold start. Wicklee correlates the hardware pattern directly — no HTTP proxy required. Every TOK/S reading is labeled LIVE, IDLE-SPD, or BUSY so you always know what you\'re looking at.',
  },
  {
    iconBg: 'bg-green-500/10',
    icon: ShieldCheck,
    iconColor: 'text-green-400',
    title: 'Sovereignty Audit Trail',
    body: 'Ensure your inference data never leaves your network. A structural guarantee, not a privacy policy. Audit the open-source agent for total peace of mind.',
  },
];

const LandingPage: React.FC<LandingPageProps> = ({ onSignIn, onSignUp, onNavigate }) => {
  // H4 — Use React state for copy-button feedback instead of direct DOM
  // mutation via btn.innerHTML.  The old pattern bypassed React's virtual DOM,
  // caused unnecessary re-renders of sibling nodes, and created a surface for
  // XSS if the originalText variable ever held non-static content.
  const [copiedMac, setCopiedMac] = useState(false);
  const [copiedWin, setCopiedWin] = useState(false);
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 selection:bg-blue-600 selection:text-white">
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
            className="px-4 sm:px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20"
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
          Routing intelligence. True inference cost. Thermal state. Live, across every node. Built for Ollama and vLLM. Install in 60 seconds — nothing to configure.
        </p>
        <div className="flex items-center justify-center">
          <button
            onClick={onSignUp}
            className="w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-2xl transition-all shadow-xl shadow-blue-500/30 flex items-center justify-center gap-2 text-lg"
          >
            Create Account — Free
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
        <p className="mt-3 text-xs text-gray-600">
          Free forever · up to 3 nodes · no credit card required
        </p>
        <p className="mt-1 text-xs text-gray-600">
          24h rolling history · Keep Warm (1 node) · Quantization ROI
        </p>
        <p className="mt-3 text-sm text-gray-600">
          Prefer local-only? The agent runs a full dashboard at{' '}
          <a
            href="http://localhost:7700"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gray-300 underline underline-offset-2 transition-colors"
          >
            localhost:7700
          </a>
          {' '}— no account needed.
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
                <p className="text-white whitespace-nowrap">curl -fsSL https://wicklee.dev/install.sh | sh</p>
                <p className="text-zinc-500 whitespace-nowrap"># Then: sudo wicklee --install-service &nbsp;<span className="text-green-500/70">← runs on every boot</span></p>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText('curl -fsSL https://wicklee.dev/install.sh | sh');
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
      <section className="max-w-7xl mx-auto px-4 sm:px-8 py-16 sm:py-32 border-t border-gray-900 relative z-10">
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
            While standard tools report raw utilization, Wicklee surfaces the invisible metrics—WES scores, wattage-per-token, and runtime health—that define your real-world performance.
          </p>

          {/* Problem cards 2x2 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            {problemCards.map((card) => (
              <div key={card.title} className={`bg-gray-900 border border-gray-800 border-l-2 ${card.accent} rounded-2xl p-5 flex gap-4`}>
                <div className={`shrink-0 w-9 h-9 ${card.iconBg} rounded-lg flex items-center justify-center mt-0.5`}>
                  <card.icon className={`w-4 h-4 ${card.iconColor}`} />
                </div>
                <div>
                  <p className="text-sm font-bold text-white mb-1">{card.title}</p>
                  <p className="text-xs text-gray-400 leading-relaxed">{card.body}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Terminal log card */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-800 bg-gray-950/60">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
              <div className="w-2.5 h-2.5 rounded-full bg-amber-500/50" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
              <span className="ml-2 text-[10px] text-gray-600 font-mono">wicklee · fleet log</span>
            </div>
            <div className="p-5 font-mono text-xs space-y-1.5">
              <p className="text-gray-500">[09:37] Node-3 &nbsp; GPU: 100% &nbsp; Thermal: <span className="text-green-400">NORMAL</span> &nbsp;&nbsp; tok/s: <span className="text-white">42</span></p>
              <p className="text-gray-500">[09:41] Node-3 &nbsp; GPU: 100% &nbsp; Thermal: <span className="text-red-400">SERIOUS</span> &nbsp; tok/s: <span className="text-red-300">28 ↓</span></p>
              <div className="pt-2 border-t border-gray-800 mt-2">
                <p className="text-green-400">→ Wicklee correlated thermal state → throttling → 33% throughput drop</p>
                <p className="text-green-400/70">&nbsp;&nbsp; Before users notice slower responses</p>
              </div>
            </div>
          </div>
        </div>

        {/* Part 2 — The metrics that matter */}
        <div>
          <p className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-4 text-center">What Wicklee surfaces</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3 tracking-tight max-w-3xl text-center mx-auto">
            The metrics that matter. The ones you can't get elsewhere.
          </h2>
          <p className="text-gray-400 text-base sm:text-lg max-w-2xl mb-10 text-center mx-auto">
            Purpose-built for inference. Every signal is chosen because it directly predicts performance degradation or cost.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {metricCards.map((card) => (
              <div key={card.title} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-gray-700 transition-all">
                <div className={`w-9 h-9 ${card.iconBg} rounded-lg flex items-center justify-center mb-4`}>
                  <card.icon className={`w-4 h-4 ${card.iconColor}`} />
                </div>
                <p className="text-sm font-bold text-white mb-1.5">{card.title}</p>
                <p className="text-xs text-gray-400 leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Part 3 — Sovereign by design */}
        <div className="bg-gray-900/50 border border-gray-800 rounded-[32px] p-6 sm:p-12">
          <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-4">Architecture</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-10 tracking-tight">Sovereign by design.</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-start">
            {/* Left — paragraph */}
            <div className="space-y-4 text-gray-400 text-sm sm:text-base leading-relaxed">
              <p>
                Most fleet monitors require your hardware data to leave your network by default. Wicklee is different.
              </p>
              <p>
                The agent runs entirely on your machine. Nothing leaves until you explicitly pair a node to the Fleet View. For teams handling sensitive workloads, this isn't a nice-to-have — it's a requirement.
              </p>
              <div className="flex items-start gap-3 mt-6 p-4 bg-green-500/5 border border-green-500/20 rounded-xl">
                <ShieldCheck className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                <p className="text-sm text-green-300/80">
                  Structural guarantee, not a privacy policy. The agent has no outbound connections by default — there's nothing to configure or accidentally misconfigure.
                </p>
              </div>
              <div className="flex items-start gap-3 mt-4 p-4 bg-indigo-500/5 border border-indigo-500/20 rounded-xl">
                <Terminal className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                <p className="text-sm text-indigo-300/80">
                  Prefer to run locally? The agent exposes a full local dashboard at{' '}
                  <a href="http://localhost:7700" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-indigo-200 transition-colors">localhost:7700</a>
                  {' '}— no cloud account required, zero configuration, works the moment the agent starts.
                </p>
              </div>
            </div>

            {/* Right — comparison table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
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

      {/* How it works Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-8 pb-20 sm:pb-40 relative z-10">
        <div className="bg-gray-900/50 border border-gray-800 rounded-[32px] p-6 sm:p-12 overflow-hidden relative">
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
                    <h4 className="text-white font-semibold text-lg mb-1">Sentinel watches your hardware</h4>
                    <p className="text-gray-500 leading-relaxed">Set custom thermal thresholds and receive Slack alerts when nodes throttle. Use the Agent API to drive your own failover logic and protect your silicon.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="relative">
              <div className="bg-gray-950 border border-gray-800 rounded-2xl p-6 font-mono text-xs text-gray-500 shadow-2xl overflow-x-auto">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-3 h-3 rounded-full bg-red-500/50"></div>
                  <div className="w-3 h-3 rounded-full bg-amber-500/50"></div>
                  <div className="w-3 h-3 rounded-full bg-green-500/50"></div>
                </div>
                <div className="space-y-1">
                  <p className="text-cyan-400">GET /api/traces</p>
                  <p className="text-gray-300">{"{"}</p>
                  <p className="pl-4">"node_id": "wicklee-worker-01",</p>
                  <p className="pl-4">"model": "llama3:70b",</p>
                  <p className="pl-4">"metrics": {"{"}</p>
                  <p className="pl-8">"ttft": 245.2,</p>
                  <p className="pl-8">"latency": 1202.4,</p>
                  <p className="pl-8">"gpu_temp": 68.2</p>
                  <p className="pl-4">{"}"}</p>
                  <p className="text-gray-300">{"}"}</p>
                  <p className="mt-4 text-green-400">// Scoped to tenant_id: tnt-01</p>
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
      <footer className="border-t border-gray-900 py-16 text-center text-sm text-gray-500">
        <p>&copy; 2026 Wicklee OSS Project. All rights reserved.</p>
        <div className="flex items-center justify-center gap-6 mt-4">
          <button onClick={() => onNavigate('/docs')} className="hover:text-white transition-colors">Documentation</button>
          <a href="#" className="hover:text-white transition-colors">Terms</a>
          <a href="#" className="hover:text-white transition-colors">Privacy</a>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
