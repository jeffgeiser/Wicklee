import React, { useState } from 'react';
import { ArrowLeft, Terminal, Zap, BookOpen, Settings, Cpu, Globe, Copy, Check, Info, Lightbulb, Shield } from 'lucide-react';
import Logo from '../components/Logo';

interface DocsPageProps {
  onNavigate?: (path: string) => void;
}

// ── Copy button ───────────────────────────────────────────────────────────────

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={handle}
      className="shrink-0 text-gray-600 hover:text-gray-300 transition-colors"
      aria-label="Copy"
    >
      {copied
        ? <Check className="w-3.5 h-3.5 text-green-400" />
        : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

// ── Code block ────────────────────────────────────────────────────────────────

const Code: React.FC<{ children: string; lang?: string }> = ({ children, lang }) => (
  <div className="relative group bg-gray-950 border border-gray-800 rounded-xl overflow-hidden my-4">
    {lang && (
      <span className="absolute top-3 left-4 text-[10px] font-mono text-gray-600 uppercase tracking-wider">
        {lang}
      </span>
    )}
    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
      <CopyButton text={children} />
    </div>
    <pre className={`text-sm font-mono text-gray-300 overflow-x-auto px-5 py-4 ${lang ? 'pt-8' : ''}`}>
      {children}
    </pre>
  </div>
);

// ── Callout boxes ─────────────────────────────────────────────────────────────

const NoteBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex gap-3 bg-blue-500/5 border border-blue-500/20 rounded-xl px-4 py-3 text-sm text-gray-400 leading-relaxed">
    <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
    <span>{children}</span>
  </div>
);

const TipBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex gap-3 bg-amber-500/5 border border-amber-500/20 rounded-xl px-4 py-3 text-sm text-gray-400 leading-relaxed">
    <Lightbulb className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
    <span>{children}</span>
  </div>
);

// ── Section heading ───────────────────────────────────────────────────────────

const Section: React.FC<{
  id: string;
  icon: React.ReactNode;
  accent: string;
  title: string;
  children: React.ReactNode;
}> = ({ id, icon, accent, title, children }) => (
  <section id={id} className="scroll-mt-20">
    <div className={`flex items-center gap-3 mb-5 pb-4 border-b ${accent}`}>
      <div className="text-gray-400">{icon}</div>
      <h2 className="text-xl font-bold text-white tracking-tight">{title}</h2>
    </div>
    <div className="space-y-4 text-gray-400 leading-relaxed text-sm">
      {children}
    </div>
  </section>
);

// ── Table ─────────────────────────────────────────────────────────────────────

const Th: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <th className={`text-left text-xs font-semibold text-gray-500 uppercase tracking-wider pb-2 pr-6 ${className ?? ''}`}>
    {children}
  </th>
);

const Td: React.FC<{ children: React.ReactNode; mono?: boolean; className?: string }> = ({ children, mono, className }) => (
  <td className={`py-2.5 pr-6 text-sm border-b border-gray-800/60 text-gray-300 ${mono ? 'font-mono text-xs' : ''} ${className ?? ''}`}>
    {children}
  </td>
);

// ── Sidebar nav items ─────────────────────────────────────────────────────────

const NAV = [
  { id: 'quickstart',  label: 'Quick Start' },
  { id: 'cli',         label: 'CLI Reference' },
  { id: 'wes',         label: 'WES Score' },
  { id: 'intelligence', label: 'Pattern Intelligence' },
  { id: 'api',         label: 'Agent API v1' },
  { id: 'config',      label: 'Configuration' },
  { id: 'sovereignty', label: 'Sovereignty' },
  { id: 'platforms',   label: 'Platform Support' },
];

// ─────────────────────────────────────────────────────────────────────────────

const DocsPage: React.FC<DocsPageProps> = ({ onNavigate }) => {
  return (
    <div className="min-h-screen bg-gray-950 text-white">

      {/* ── Top nav ── */}
      <nav className="sticky top-0 z-30 bg-gray-950/90 backdrop-blur border-b border-gray-800/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 py-4 flex items-center justify-between">
          <button
            onClick={() => onNavigate?.('/')}
            className="cursor-pointer"
            aria-label="Home"
          >
            <Logo className="text-2xl" connectionState="connected" />
          </button>
          <button
            onClick={() => onNavigate?.(-1 as unknown as string)}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-12 flex gap-12">

        {/* ── Sidebar nav (desktop only) ── */}
        <aside className="hidden lg:block shrink-0 w-48 sticky top-28 self-start">
          <p className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-4">On this page</p>
          <nav className="space-y-1">
            {NAV.map(item => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="block text-sm text-gray-500 hover:text-white transition-colors py-1"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="mt-8 pt-6 border-t border-gray-800 space-y-2">
            <a
              href="https://github.com/jeffgeiser/Wicklee"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-xs text-gray-600 hover:text-gray-300 transition-colors"
            >
              GitHub →
            </a>
            <button
              onClick={() => onNavigate?.('/blog')}
              className="block text-xs text-gray-600 hover:text-gray-300 transition-colors text-left"
            >
              Blog →
            </button>
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className="min-w-0 flex-1 space-y-16">

          {/* Page title */}
          <div>
            <p className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-3">Documentation</p>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-3">
              Wicklee Docs
            </h1>
            <p className="text-gray-400 text-base max-w-2xl leading-relaxed">
              Wicklee is a zero-config control plane for local AI inference.
              One agent binary, live metrics across your entire fleet, sovereign by design.
            </p>
          </div>

          {/* ── Quick Start ── */}
          <Section
            id="quickstart"
            icon={<Terminal className="w-5 h-5" />}
            accent="border-blue-500/20"
            title="Quick Start"
          >
            <p>Install the Wicklee agent with a single command. No account required — the agent runs a full local dashboard at <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">localhost:7700</code>.</p>

            {/* Option 1 — Try it */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="shrink-0 w-5 h-5 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-[10px] font-bold text-blue-400">1</span>
                <p className="font-semibold text-white text-sm">Try it — no account, no sudo</p>
              </div>
              <p>Downloads the agent and starts a live session immediately. Telemetry appears in the local dashboard — no service registration, no commitment. Start here.</p>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">macOS / Linux</p>
                <Code lang="shell">curl -fsSL https://wicklee.dev/install.sh | sh</Code>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Windows (PowerShell)</p>
                <Code lang="powershell">irm https://wicklee.dev/install.ps1 | iex</Code>
              </div>
              <p>Open <a href="http://localhost:7700" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">localhost:7700</a> in your browser to see your local dashboard.</p>
            </div>

            {/* Option 2 — Sudo for full metrics */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="shrink-0 w-5 h-5 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-[10px] font-bold text-blue-400">2</span>
                <p className="font-semibold text-white text-sm">Full hardware metrics — run with sudo <span className="text-gray-500 font-normal">(Linux only)</span></p>
              </div>
              <p>On Linux, CPU power draw (RAPL) and some thermal sensors require elevated access. Running with <code className="font-mono text-xs text-gray-300">sudo</code> unlocks these — you'll see WATTS and full thermal state in the dashboard instead of dashes.</p>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Linux</p>
                <Code lang="shell">sudo wicklee</Code>
              </div>
              <NoteBox>
                macOS does not require <code className="font-mono text-xs text-gray-300">sudo</code> — the agent reads Apple Silicon power, GPU, and thermal data directly via IOKit without elevated permissions.
              </NoteBox>
            </div>

            {/* Option 3 — System service */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="shrink-0 w-5 h-5 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-[10px] font-bold text-blue-400">3</span>
                <p className="font-semibold text-white text-sm">Always-on monitoring — register as a system service</p>
              </div>
              <p>Registers the agent with launchd (macOS) or systemd (Linux) so it starts automatically on every boot. This is the recommended setup for nodes in your fleet.</p>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">macOS / Linux</p>
                <Code lang="shell">sudo wicklee --install-service</Code>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Windows (PowerShell — run as Administrator)</p>
                <Code lang="powershell">wicklee --install-service</Code>
              </div>
              <NoteBox>
                <code className="font-mono text-xs text-gray-300">sudo</code> is required here to write the launchd plist or systemd unit file — not to run inference. The agent process itself drops privileges after registration and runs as your user.
              </NoteBox>
            </div>

            {/* Fleet pairing */}
            <div>
              <p className="font-semibold text-white mb-2">Connect to your fleet dashboard</p>
              <p>To add a node to your hosted fleet at wicklee.dev, generate a 6-digit pairing code from the agent UI and enter it at <span className="text-gray-300">wicklee.dev → Pair a node</span>. No SSH, no firewall changes — the agent initiates the outbound connection.</p>
            </div>
          </Section>

          {/* ── CLI Reference ── */}
          <Section
            id="cli"
            icon={<Terminal className="w-5 h-5" />}
            accent="border-gray-500/20"
            title="CLI Reference"
          >
            <p>All flags are parsed at startup. The agent exits immediately for one-shot commands (<code className="font-mono text-xs text-gray-300">--version</code>, <code className="font-mono text-xs text-gray-300">--install-service</code>, etc.) and runs the full server for everything else.</p>

            {/* Command table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left py-2 pr-6 text-xs font-semibold text-gray-500 uppercase tracking-wider w-64">Command</th>
                    <th className="text-left py-2 pr-6 text-xs font-semibold text-gray-500 uppercase tracking-wider">What it does</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/60">
                  <tr>
                    <td className="py-3 pr-6 font-mono text-xs text-indigo-300 align-top">wicklee</td>
                    <td className="py-3 text-gray-400 align-top">Start the agent. Dashboard at <code className="font-mono text-xs text-gray-300">localhost:7700</code>. Runs in the foreground — press <kbd className="text-xs bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded">Ctrl+C</kbd> to stop.</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-6 font-mono text-xs text-indigo-300 align-top">wicklee --pair</td>
                    <td className="py-3 text-gray-400 align-top">Generate a 6-digit pairing code and print it to the terminal — useful when you can't open <code className="font-mono text-xs text-gray-300">localhost:7700</code> (headless server, SSH session). Enter the code at <span className="text-gray-300">wicklee.dev → Pair a node</span>.</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-6 font-mono text-xs text-indigo-300 align-top">wicklee --version</td>
                    <td className="py-3 text-gray-400 align-top">Print the agent version and exit. Use this to confirm which build is running after an update.</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-6 font-mono text-xs text-indigo-300 align-top whitespace-nowrap">sudo wicklee --install-service</td>
                    <td className="py-3 text-gray-400 align-top">Register the agent as a background service that starts on every boot. Uses <strong className="text-gray-300">launchd</strong> on macOS, <strong className="text-gray-300">systemd</strong> on Linux. Windows: run as Administrator (no sudo). After registration the service starts immediately — no reboot required.</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-6 font-mono text-xs text-indigo-300 align-top whitespace-nowrap">sudo wicklee --uninstall-service</td>
                    <td className="py-3 text-gray-400 align-top">Stop and remove the background service. The binary is not deleted — you can re-register with <code className="font-mono text-xs text-gray-300">--install-service</code> at any time.</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-6 font-mono text-xs text-indigo-300 align-top">sudo wicklee</td>
                    <td className="py-3 text-gray-400 align-top"><strong className="text-gray-300">Linux only.</strong> Run the agent with elevated access for full hardware metrics: CPU power draw (RAPL) and deeper thermal sensor access. Not required on macOS — hardware data is read via IOKit without root.</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Environment variables */}
            <div className="space-y-2 mt-2">
              <p className="font-semibold text-white">Environment variables</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="text-left py-2 pr-6 text-xs font-semibold text-gray-500 uppercase tracking-wider w-48">Variable</th>
                      <th className="text-left py-2 pr-6 text-xs font-semibold text-gray-500 uppercase tracking-wider w-24">Default</th>
                      <th className="text-left py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Effect</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/60">
                    <tr>
                      <td className="py-3 pr-6 font-mono text-xs text-amber-300 align-top">PORT</td>
                      <td className="py-3 pr-6 font-mono text-xs text-gray-500 align-top">7700</td>
                      <td className="py-3 text-gray-400 align-top">Port the agent listens on. Change if 7700 conflicts with another service: <code className="font-mono text-xs text-gray-300">PORT=7701 wicklee</code>.</td>
                    </tr>
                    <tr>
                      <td className="py-3 pr-6 font-mono text-xs text-amber-300 align-top">WICKLEE_FLEET_URL</td>
                      <td className="py-3 pr-6 font-mono text-xs text-gray-500 align-top">wicklee.dev</td>
                      <td className="py-3 text-gray-400 align-top">Override the fleet cloud endpoint. Used for self-hosted or dev fleet deployments.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pairing without localhost */}
            <NoteBox>
              <span>
                <strong className="text-white">Headless pairing</strong> — on a remote server where you can't open a browser, run{' '}
                <code className="font-mono text-xs text-gray-300">wicklee --pair</code>{' '}
                and the 6-digit code prints directly to your terminal. You have 5 minutes to enter it at wicklee.dev.
              </span>
            </NoteBox>
          </Section>

          {/* ── WES Score ── */}
          <Section
            id="wes"
            icon={<Zap className="w-5 h-5" />}
            accent="border-indigo-500/20"
            title="WES — Wicklee Efficiency Score"
          >
            <p>WES is the primary efficiency metric in Wicklee. It measures how many tokens a node generates per watt of board power, adjusted for thermal throttle state.</p>

            <div className="bg-gray-950 border border-indigo-500/20 rounded-xl p-5">
              <p className="text-xs font-bold text-indigo-400 uppercase tracking-wider mb-3">Formula (v2)</p>
              <pre className="font-mono text-sm text-white leading-loose">
{`WES = tok/s ÷ (Watts × ThermalPenalty)`}
              </pre>
              <p className="mt-3 text-xs text-gray-500 leading-relaxed">
                ThermalPenalty is applied as a divisor — acting as a <strong className="text-gray-300">multiplicative penalty</strong> on your WES score. A penalty of 1.75 (Serious) reduces your effective score to ~57% of its thermal-ideal value.
              </p>
              <p className="mt-2 text-xs text-gray-500 leading-relaxed">
                On NVIDIA hardware, ThermalPenalty is derived from the NVML hardware throttle-reason bitmask rather than inferred from temperature — making it authoritative rather than estimated. Source is tagged <code className="text-gray-400">nvml</code> in the payload. On AMD CPUs (Ryzen/EPYC), penalty is derived from the CPU clock ratio (<code className="text-gray-400">scaling_cur_freq ÷ cpuinfo_max_freq</code>) using the k10temp hwmon driver — catching throttle as it happens rather than after temperature peaks. Source is tagged <code className="text-gray-400">clock_ratio</code>. Non-AMD Linux nodes use <code className="text-gray-400">sysfs</code> (thermal zone max temperature). macOS uses <code className="text-gray-400">iokit</code> (pmset thermal level).
              </p>
            </div>

            {/* Penalty impact table */}
            <div>
              <p className="font-semibold text-white mb-2">Penalty impact by thermal state</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>State</Th>
                      <Th>Divisor</Th>
                      <Th>Score multiplier</Th>
                      <Th>Effect</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <Td><span className="text-green-400 font-medium">Normal</span></Td>
                      <Td mono>1.00</Td>
                      <Td mono>1.00×</Td>
                      <Td>No throttle — full score</Td>
                    </tr>
                    <tr>
                      <Td><span className="text-yellow-400 font-medium">Fair</span></Td>
                      <Td mono>1.25</Td>
                      <Td mono>0.80×</Td>
                      <Td>Minor thermal overhead</Td>
                    </tr>
                    <tr>
                      <Td><span className="text-orange-400 font-medium">Serious</span></Td>
                      <Td mono>1.75</Td>
                      <Td mono>0.57×</Td>
                      <Td>Significant heat / throttling risk</Td>
                    </tr>
                    <tr>
                      <Td><span className="text-red-400 font-medium">Critical</span></Td>
                      <Td mono>2.00</Td>
                      <Td mono>0.50×</Td>
                      <Td>Critical threshold — WES halved</Td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Thermal Cost % */}
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
              <p className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">Thermal Cost %</p>
              <p className="text-xs text-gray-400 leading-relaxed mb-2">
                When thermal throttling is active, Wicklee shows a <code className="text-amber-300 font-mono">-N% thermal</code> badge below the WES score in the Fleet Status table. This is the Thermal Cost %: the fraction of potential efficiency lost to throttle state.
              </p>
              <pre className="font-mono text-xs text-gray-300 bg-gray-950 rounded-lg px-4 py-3">
{`Thermal Cost % = (Raw WES − Penalized WES) / Raw WES × 100`}
              </pre>
              <p className="mt-2 text-xs text-gray-500 leading-relaxed">
                Raw WES is computed without any thermal penalty — it represents the hardware ceiling. Penalized WES is the operationally adjusted score. The gap between them is the cost of running hot. A node at Serious thermal state loses ~43% of its potential efficiency.
              </p>
            </div>


            {/* Score interpretation table */}
            <div>
              <p className="font-semibold text-white mb-2">Reading WES scores</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Score range</Th>
                      <Th>Interpretation</Th>
                      <Th>Typical hardware</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><Td mono>&gt; 150</Td><Td>Excellent — efficient high-throughput</Td><Td>Apple M-series</Td></tr>
                    <tr><Td mono>50 – 150</Td><Td>Good — typical desktop GPU range</Td><Td>RTX 4070 / RX 7900</Td></tr>
                    <tr><Td mono>10 – 50</Td><Td>Acceptable — power-hungry server GPUs</Td><Td>A100, H100 at full load</Td></tr>
                    <tr><Td mono>&lt; 10</Td><Td>Investigate — thermal throttle likely</Td><Td>Any platform under sustained load</Td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-xs text-gray-500">WES v1 used Serious = 2.0. WES v2 (current) uses Serious = 1.75. The <code className="text-gray-400">wes_version</code> field in the API payload version-stamps each reading so benchmarks remain comparable across releases.</p>

            {/* Derived metrics reference */}
            <div>
              <p className="font-semibold text-white mb-2">Derived metrics — formulas</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Metric</Th>
                      <Th>Formula</Th>
                      <Th>Notes</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <Td><span className="font-medium text-white">Cost / 1M tokens</span></Td>
                      <Td mono>(kWh_rate × watts) ÷ (tok_s × 3600) × 1,000,000 ÷ 1000</Td>
                      <Td>Displayed to 3 decimal places; shows <code className="text-gray-400">&lt; $0.001</code> for very efficient hardware (Apple Silicon at idle-speed inference). PUE applied when set.</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">W / 1k tokens</span></Td>
                      <Td mono>fleet_watts ÷ (fleet_tok_s ÷ 1000)</Td>
                      <Td>Only reachable nodes (last-seen within 30 s) contribute to <code className="text-gray-400">fleet_watts</code>. Offline nodes are excluded to prevent wattage inflation.</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">Throughput label</span></Td>
                      <Td mono>LIVE · IDLE-SPD · BUSY</Td>
                      <Td><strong className="text-gray-300">LIVE</strong>: active inference (tok/s &gt; 0). <strong className="text-gray-300">IDLE-SPD</strong>: online, no inference — idle-speed baseline. <strong className="text-gray-300">BUSY</strong>: GPU loaded, no inference (non-inference workload).</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">Display smoothing</span></Td>
                      <Td mono>rolling average</Td>
                      <Td>Node tiles: 8-frame window. Fleet aggregates: 12-frame window. Prevents single-frame spikes from skewing dashboard readings.</Td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Benchmark Report */}
            <div>
              <p className="font-semibold text-white mb-2">Benchmark Report — reproducible snapshots</p>
              <p>
                The <strong className="text-white">Export snapshot</strong> button in the Insights → Performance tab captures a full WES reading at a point in time in a format designed for publishing — blog posts, GitHub issues, or the arXiv comment thread.
              </p>
              <Code lang="markdown">{`# Wicklee Benchmark Report

Generated:       2026-03-16T14:23:00Z
Wicklee:         v0.4.33

## Node
Node ID:         WK-C133
Hostname:        jeff-m3max.local
Hardware:        Apple M3 Max
OS:              macOS

## Inference
Runtime:         Ollama
Model:           llama3.2:3b
Quantization:    Q4_K_M
Tokens/sec:      241.3
Board power:     18.4 W

## WES Score
Raw WES:         13.111  (hardware ceiling — no thermal penalty)
Penalized WES:   10.489  (operational score)
Thermal Cost:    20% efficiency lost to thermal throttle
Thermal State:   Fair (IOKit)
WES Version:     2

---
*Generated by Wicklee v0.4.33 · https://wicklee.dev*`}</Code>
              <p>
                Reports are available as <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">.md</code> (human-readable) and <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">.json</code> (machine-readable). The JSON format includes all fields above plus a full provenance record — runtime, quantization, thermal source, and WES version — so comparisons across hardware remain unambiguous.
              </p>
              <p>
                The WES Trend chart (Mission Control, Pro+) also includes a per-node <strong className="text-white">Export</strong> button that snapshots the most recent history point from the selected time window.
              </p>
            </div>
          </Section>

          {/* ── Pattern Intelligence ── */}
          <Section
            id="intelligence"
            icon={<Cpu className="w-5 h-5" />}
            accent="border-violet-500/20"
            title="Pattern Intelligence"
          >
            <p>
              The Insights → Triage tab runs a time-windowed pattern engine against your node's telemetry history. Patterns require a sustained evidence window before firing — single-frame spikes never produce an alert. All computation is local; no data leaves the machine.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Pattern</Th>
                    <Th>What it detects</Th>
                    <Th>Evidence window</Th>
                    <Th>Tier</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td><span className="font-medium text-amber-400">Thermal Drain</span></Td>
                    <Td>Sustained throttle state reducing tok/s vs. the node's own Normal-temperature baseline (&gt; 8% degradation)</Td>
                    <Td mono>5 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-violet-400">Phantom Load</span></Td>
                    <Td>Significant power draw + VRAM allocated with zero inference activity — idle model burning electricity</Td>
                    <Td mono>5 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-indigo-400">WES Velocity Drop</span></Td>
                    <Td>Efficiency score declining at a sustained rate before thermal state has changed — early warning pattern</Td>
                    <Td mono>10 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-cyan-400">Memory Trajectory</span></Td>
                    <Td>Rising memory pressure projected to hit the critical threshold (&gt; 85%) within 30 minutes</Td>
                    <Td mono>10 min</Td>
                    <Td>Community</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="bg-gray-950 border border-violet-500/20 rounded-xl p-4 space-y-2">
              <p className="text-xs font-bold text-violet-400 uppercase tracking-wider">Alert lifecycle</p>
              <p className="text-xs text-gray-400 leading-relaxed">
                <strong className="text-white">Onset gate (15 s):</strong> tier-1 alert cards (Thermal Degradation, Power Anomaly, Memory Exhaustion, Thermal Cost) require the condition to be continuously true for 15 seconds before rendering. This prevents single-frame metric spikes from flashing on screen.
              </p>
              <p className="text-xs text-gray-400 leading-relaxed">
                <strong className="text-white">Hold period (5 min):</strong> once shown, an alert card stays visible for 5 minutes after the condition clears — displaying a <code className="text-gray-300">✓ Resolved</code> badge. Engineers can read the full context before the card disappears.
              </p>
              <p className="text-xs text-gray-400 leading-relaxed">
                <strong className="text-white">Recent Activity log:</strong> when an alert expires its hold period, it moves to the collapsible Recent Activity feed at the bottom of the Triage tab. The log is session-scoped and shows duration + age for each resolved event. Use <em>Clear resolved</em> in the Observations section to acknowledge pattern findings inbox-style.
              </p>
            </div>

            <NoteBox>
              Confidence levels — <strong className="text-white">Building</strong> (under 50% of required window), <strong className="text-white">Moderate</strong> (50–90%), <strong className="text-white">High</strong> (≥ 90%) — are shown in the observation card header and as a progress bar while evidence accumulates. A pattern at High confidence means the condition has been sustained for the full required window.
            </NoteBox>
          </Section>

          {/* ── Agent API v1 ── */}
          <Section
            id="api"
            icon={<Globe className="w-5 h-5" />}
            accent="border-cyan-500/20"
            title="Agent API v1"
          >
            <p>The Agent API provides machine-readable access to your live fleet. All endpoints return JSON. Authenticate with your API key — create one in the <strong className="text-white">API Keys</strong> tab of your fleet dashboard.</p>

            <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div>
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Base URL</p>
                <code className="font-mono text-sm text-cyan-300">https://wicklee.dev</code>
              </div>
              <div className="sm:ml-auto">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Auth header</p>
                <code className="font-mono text-sm text-gray-300">X-API-Key: wk_live_...</code>
              </div>
            </div>

            <Code lang="shell">{`# Example: fetch all nodes with live metrics
curl https://wicklee.dev/api/v1/fleet \\
  -H "X-API-Key: wk_live_<your_key>"`}</Code>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Endpoint</Th>
                    <Th>Description</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td mono>GET /api/v1/fleet</Td>
                    <Td>All nodes — current state, live metrics, WES scores</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/v1/fleet/wes</Td>
                    <Td>WES leaderboard — all nodes ranked by efficiency</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/v1/nodes/:id</Td>
                    <Td>Single node — deep metrics snapshot</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/v1/route/best</Td>
                    <Td>Routing recommendation — optimal node for next inference task</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            <TipBox>
              <span>
                <strong className="text-white">Implementation tip — <code className="font-mono text-xs">/api/v1/route/best</code>:</strong>{' '}
                Use this to feed your existing load balancer or LangChain router with real-time health data. Poll at 1–5s intervals and forward the <code className="font-mono text-xs text-gray-300">default</code> node recommendation upstream — no custom scoring logic required.
              </span>
            </TipBox>

            <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-white mb-2">Route response shape</p>
              <Code lang="json">{`{
  "latency":    { "node": "WK-C133", "tok_s": 240, "reason": "Highest throughput" },
  "efficiency": { "node": "WK-1EFC", "wes": 181.5,  "reason": "20x WES advantage" },
  "default":    "efficiency"
}`}</Code>
            </div>

            <div>
              <p className="font-semibold text-white mb-1">Rate limits</p>
              <p>Community: 60 req/min &nbsp;·&nbsp; Team: 600 req/min &nbsp;·&nbsp; Enterprise: unlimited. Rate limits are operational throttles, not feature gates — API access is available on all tiers.</p>
            </div>
          </Section>

          {/* ── Configuration ── */}
          <Section
            id="config"
            icon={<Settings className="w-5 h-5" />}
            accent="border-amber-500/20"
            title="Configuration"
          >
            <p>Wicklee is zero-config out of the box. The settings below are optional overrides.</p>

            <div>
              <p className="font-semibold text-white mb-2">Dashboard settings (UI)</p>
              <p>Open the <strong className="text-white">Settings</strong> tab from your fleet dashboard to configure:</p>
              <ul className="mt-2 space-y-1 list-none">
                {[
                  ['kWh rate', 'Local electricity rate (default $0.13/kWh). Used to calculate Cost/1K TKN.'],
                  ['PUE multiplier', 'Power Usage Effectiveness for data center / rack overhead.'],
                  ['Per-node overrides', 'Different kWh rates and labels per node — useful for mixed-location fleets.'],
                  ['Temperature units', '°C or °F display preference.'],
                ].map(([label, desc]) => (
                  <li key={label} className="flex gap-2 text-sm">
                    <span className="shrink-0 font-mono text-xs text-gray-500 w-36 pt-0.5">{label}</span>
                    <span>{desc}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Environment variables (cloud backend)</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Variable</Th>
                      <Th>Default</Th>
                      <Th>Purpose</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><Td mono>PORT</Td><Td mono>8080</Td><Td>HTTP listener port</Td></tr>
                    <tr><Td mono>DATABASE_URL</Td><Td mono>—</Td><Td>SQLite path for fleet / auth data</Td></tr>
                    <tr><Td mono>DUCK_DB_PATH</Td><Td mono>~/.wicklee/analytics.duckdb</Td><Td>DuckDB analytics volume (Railway mount)</Td></tr>
                    <tr><Td mono>CLERK_JWKS_URL</Td><Td mono>—</Td><Td>Clerk JWKS endpoint for JWT validation</Td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Tiers &amp; fleet limits</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Tier</Th>
                      <Th>Fleet nodes</Th>
                      <Th>Telemetry window</Th>
                      <Th>DuckDB analytics archive</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <Td><span className="text-gray-300 font-medium">Community</span></Td>
                      <Td>3 nodes free</Td>
                      <Td>24-hour rolling window</Td>
                      <Td>—</Td>
                    </tr>
                    <tr>
                      <Td><span className="text-blue-400 font-medium">Team</span></Td>
                      <Td>Unlimited</Td>
                      <Td>24-hour rolling window</Td>
                      <Td>90-day compressed archive</Td>
                    </tr>
                    <tr>
                      <Td><span className="text-amber-400 font-medium">Enterprise</span></Td>
                      <Td>Unlimited</Td>
                      <Td>Configurable</Td>
                      <Td>Configurable + signed export</Td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Nodes 4+ on Community connect and send heartbeats but their metrics are restricted in the fleet dashboard. Upgrade to Team to unlock full telemetry, alert wiring, and 90-day DuckDB history. DuckDB traces are stored with zstd compression and streamed to the Traces view.
              </p>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Ollama transparent proxy (optional)</p>
              <p>Enable the proxy in your <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">wicklee.toml</code> config to get zero-lag inference detection and exact tok/s from done packets instead of the 30s sampled probe:</p>
              <Code lang="toml">{`[ollama_proxy]
enabled     = true
ollama_port = 11435   # move Ollama here: OLLAMA_HOST=127.0.0.1:11435`}</Code>
            </div>
          </Section>

          {/* ── Sovereignty ── */}
          <Section
            id="sovereignty"
            icon={<Shield className="w-5 h-5" />}
            accent="border-green-500/20"
            title="Sovereignty"
          >
            <p>
              Wicklee is built on a single design constraint: <strong className="text-white">inference content never leaves the machine that runs it.</strong> The Observability tab in your dashboard shows this in real time — telemetry destination, outbound connection manifest, and a live connection event log.
            </p>

            <div className="mt-4">
              <p className="font-semibold text-white mb-3">What is transmitted to the fleet</p>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[10px] text-gray-500 uppercase tracking-widest border-b border-gray-800">
                    <th className="pb-2 pr-4">Data</th>
                    <th className="pb-2 pr-4">Destination</th>
                    <th className="pb-2">Transmitted</th>
                  </tr>
                </thead>
                <tbody className="text-sm divide-y divide-gray-800/50">
                  <tr><td className="py-2 pr-4 text-gray-300">CPU / GPU / memory metrics</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">fleet URL</td><td className="py-2 text-indigo-400">Yes — when paired</td></tr>
                  <tr><td className="py-2 pr-4 text-gray-300">WES score + thermal state</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">fleet URL</td><td className="py-2 text-indigo-400">Yes — when paired</td></tr>
                  <tr><td className="py-2 pr-4 text-gray-300">Active model name</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">fleet URL</td><td className="py-2 text-indigo-400">Yes — when paired</td></tr>
                  <tr><td className="py-2 pr-4 text-gray-300">Inference content / prompts</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">—</td><td className="py-2 text-green-400 font-semibold">Never</td></tr>
                  <tr><td className="py-2 pr-4 text-gray-300">Request payloads / responses</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">—</td><td className="py-2 text-green-400 font-semibold">Never</td></tr>
                  <tr><td className="py-2 pr-4 text-gray-300">User conversations</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">—</td><td className="py-2 text-green-400 font-semibold">Never</td></tr>
                </tbody>
              </table>
            </div>

            <div className="mt-4">
              <p className="font-semibold text-white mb-3">Outbound connections</p>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[10px] text-gray-500 uppercase tracking-widest border-b border-gray-800">
                    <th className="pb-2 pr-4">Connection</th>
                    <th className="pb-2 pr-4">Endpoint</th>
                    <th className="pb-2">Data</th>
                  </tr>
                </thead>
                <tbody className="text-sm divide-y divide-gray-800/50">
                  <tr><td className="py-2 pr-4 text-gray-300">Ollama probe</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">localhost:11434</td><td className="py-2 text-gray-400">Local only — 3-token throughput sample</td></tr>
                  <tr><td className="py-2 pr-4 text-gray-300">Fleet telemetry</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">your fleet URL</td><td className="py-2 text-gray-400">System metrics + WES — paired nodes only</td></tr>
                  <tr><td className="py-2 pr-4 text-gray-300">Clerk auth</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">api.clerk.dev</td><td className="py-2 text-gray-400">Session JWT — cloud dashboard only</td></tr>
                </tbody>
              </table>
            </div>

            <NoteBox>
              The Observability tab in your fleet dashboard shows a live version of this manifest, updated in real time from your active pairing state. The connection event log records every node connect and disconnect for the current session.
            </NoteBox>

            <p className="mt-4 text-sm text-gray-400">
              Unpaired nodes running only the local agent at <code className="text-gray-300">localhost:7700</code> make zero outbound connections. All metrics remain on-device. The fleet pairing is opt-in and can be revoked at any time from <strong className="text-white">Settings → Account & Data</strong>.
            </p>
          </Section>

          {/* ── Platform support ── */}
          <Section
            id="platforms"
            icon={<Cpu className="w-5 h-5" />}
            accent="border-green-500/20"
            title="Platform Support"
          >
            {/* Runtime support matrix */}
            <div>
              <p className="font-semibold text-white mb-2">Agent platform support</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Platform</Th>
                      <Th>CPU power</Th>
                      <Th>GPU metrics</Th>
                      <Th>Thermal state</Th>
                      <Th>VRAM</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <Td><span className="font-medium text-white">macOS — Apple Silicon</span></Td>
                      <Td>✅ powermetrics</Td>
                      <Td>✅ ioreg (GPU%)</Td>
                      <Td>✅ pmset + sysctl</Td>
                      <Td>✅ wired budget¹</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">Linux — NVIDIA (x86)</span></Td>
                      <Td>✅ RAPL powercap</Td>
                      <Td>✅ NVML (sudoless)</Td>
                      <Td>✅ sysfs thermal</Td>
                      <Td>✅ NVML²</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">Linux — NVIDIA (ARM64 / DGX Spark)</span></Td>
                      <Td>— (no RAPL on ARM)</Td>
                      <Td>✅ NVML (sudoless)</Td>
                      <Td>✅ sysfs thermal</Td>
                      <Td>✅ Unified pool⁴</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">Linux — AMD CPU</span></Td>
                      <Td>✅ RAPL powercap</Td>
                      <Td>—</Td>
                      <Td>✅ k10temp clock ratio</Td>
                      <Td>—</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">Linux — Intel CPU</span></Td>
                      <Td>✅ RAPL powercap</Td>
                      <Td>—</Td>
                      <Td>✅ sysfs thermal</Td>
                      <Td>—</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">Windows — NVIDIA</span></Td>
                      <Td>—</Td>
                      <Td>✅ NVML</Td>
                      <Td>⚠ estimated</Td>
                      <Td>✅ NVML</Td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="mt-3 space-y-1.5 text-xs text-gray-500">
                <p><span className="text-gray-400">¹ Apple Silicon VRAM</span> — Apple Silicon has no dedicated VRAM. The GPU shares the unified memory pool. The dashboard shows available headroom against the <em>wired memory budget</em> (<code className="text-gray-400">iogpu.wired_limit_mb</code>), which is the maximum macOS will wire for GPU access — typically ~75% of physical RAM. On a 24 GB M2, expect a ~18 GB GPU budget, not 24 GB. Loading a model larger than the available headroom will trigger compression and swap, degrading throughput.</p>
                <p><span className="text-gray-400">² Linux NVIDIA</span> — VRAM metrics require the <strong className="text-gray-300">GPU-enabled build</strong>. The default install script auto-detects an NVIDIA GPU (<code className="text-gray-400">nvidia-smi</code>) and downloads the glibc binary with NVML enabled. If you installed before this was added, re-run <code className="text-gray-400">curl -fsSL https://wicklee.dev/install.sh | bash</code>.</p>
                <p><span className="text-gray-400">⁴ ARM64 NVIDIA unified memory (GB10 / Grace Blackwell)</span> — The NVIDIA GB10 SoC (DGX Spark) uses LPDDR5x unified memory shared between the Grace CPU and Blackwell GPU. NVML reports <code className="text-gray-400">[N/A]</code> for <code className="text-gray-400">memory.total</code> because there is no dedicated framebuffer. Wicklee tracks VRAM usage via <strong className="text-gray-300">process residency</strong> — the sum of GPU memory reported by all running compute processes — which is the same accounting nvidia-smi uses internally. The capacity figure is system RAM (the full unified pool). The dashboard shows a <strong className="text-gray-300">Unified Memory</strong> badge on these nodes to distinguish them from discrete-VRAM GPUs.</p>
                <p><span className="text-gray-400">³ Inference VRAM threshold</span> — Wicklee only counts GPU devices with <strong className="text-gray-300">≥ 1 GB</strong> of reported VRAM toward fleet totals, the VRAM column, model-fit scoring, and memory-exhaustion alerts. Devices below this threshold — onboard BMC/IPMI video chips (ASPEED AST), motherboard framebuffers, and headless server display adapters — are excluded. This prevents ghost entries from inflating fleet capacity on bare-metal servers that have no inference-capable GPU.</p>
              </div>
            </div>

            {/* Metric availability by inference runtime */}
            <div>
              <p className="font-semibold text-white mb-2">Metric availability by inference runtime</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Metric</Th>
                      <Th>macOS</Th>
                      <Th>Linux (NVIDIA)</Th>
                      <Th>vLLM</Th>
                      <Th>Ollama</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <Td><span className="font-medium text-white">WES Score</span></Td>
                      <Td>✅</Td>
                      <Td>✅</Td>
                      <Td>✅</Td>
                      <Td>✅</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">Wattage</span></Td>
                      <Td>✅</Td>
                      <Td>✅</Td>
                      <Td>—</Td>
                      <Td>—</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">GPU Temp</span></Td>
                      <Td>✅</Td>
                      <Td>✅</Td>
                      <Td>—</Td>
                      <Td>—</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">KV Cache Saturation</span></Td>
                      <Td>—</Td>
                      <Td>—</Td>
                      <Td>
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-purple-400 bg-purple-400/10 px-2 py-0.5 rounded-full">
                          vLLM only
                        </span>
                      </Td>
                      <Td>—</Td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-gray-500">Wattage and GPU Temp are sourced from the OS hardware layer (powermetrics / NVML / RAPL), not from the inference runtime. KV Cache Saturation requires the vLLM Prometheus metrics endpoint at <code className="text-gray-400">:8000/metrics</code>.</p>
            </div>
          </Section>

          {/* Footer */}
          <div className="pt-8 border-t border-gray-800 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between text-xs text-gray-600">
            <span>&copy; 2026 Wicklee. All rights reserved.</span>
            <div className="flex items-center gap-6">
              <button onClick={() => onNavigate?.('/blog')} className="hover:text-gray-300 transition-colors">Blog</button>
              <a href="https://github.com/jeffgeiser/Wicklee" target="_blank" rel="noopener noreferrer" className="hover:text-gray-300 transition-colors">GitHub</a>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};

export default DocsPage;
