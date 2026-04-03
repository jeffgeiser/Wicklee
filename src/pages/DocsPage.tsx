import React, { useState } from 'react';
import { ArrowLeft, Terminal, Zap, BookOpen, Settings, Cpu, Globe, Copy, Check, Info, Lightbulb, Shield, Activity, Clock, BarChart2 } from 'lucide-react';
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
  { id: 'states',      label: 'Node States' },
  { id: 'latency',     label: 'Latency & TTFT' },
  { id: 'intelligence', label: 'Pattern Intelligence' },
  { id: 'event-feeds', label: 'Event Feeds' },
  { id: 'api-local',   label: 'Localhost API' },
  { id: 'api-fleet',   label: 'Fleet API v1' },
  { id: 'mcp',         label: 'MCP Server' },
  { id: 'proxy',       label: 'Inline Proxy' },
  { id: 'otel',        label: 'OTel & Prometheus' },
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
                <Code lang="shell">curl -fsSL https://wicklee.dev/install.sh | bash</Code>
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
                <p className="font-semibold text-white text-sm">Full hardware metrics — elevated access</p>
              </div>
              <p>Some hardware sensors require elevated access to report full data:</p>
              <div className="space-y-2 text-sm">
                <div>
                  <p className="text-white font-medium">Linux</p>
                  <p className="text-gray-400">CPU power draw (RAPL) and some thermal sensors need root. Run <code className="font-mono text-xs text-gray-300">sudo wicklee</code> or install as a service (step 3) to unlock WATTS and full thermal state.</p>
                </div>
                <div>
                  <p className="text-white font-medium">macOS</p>
                  <p className="text-gray-400">GPU utilization and thermal state are read via IOKit without root. However, <strong className="text-gray-300">SoC power draw</strong> (CPU + GPU + ANE combined power, used for WES and Cost/1K) requires <code className="font-mono text-xs text-gray-300">powermetrics</code>, which needs root. Install as a system service (step 3) to get full power metrics — the LaunchDaemon runs as root automatically.</p>
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Linux (one-off)</p>
                <Code lang="shell">sudo wicklee</Code>
              </div>
              <NoteBox>
                On both platforms, the recommended path is step 3 (<code className="font-mono text-xs text-gray-300">--install-service</code>) — it handles root access automatically via launchd/systemd and starts on every boot.
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
                <code className="font-mono text-xs text-gray-300">sudo</code> is required because the agent installs as a system service (LaunchDaemon on macOS, systemd on Linux) and <strong className="text-gray-300">runs as root</strong>. Root access is needed for hardware sensor reads — <code className="font-mono text-xs text-gray-300">powermetrics</code> on macOS, RAPL powercap on Linux, and deeper thermal sensor access.
              </NoteBox>
            </div>

            {/* Fleet pairing */}
            <div>
              <p className="font-semibold text-white mb-2">Connect to your fleet dashboard</p>
              <p>To add a node to your hosted fleet at wicklee.dev, generate a 6-digit pairing code from the agent UI and enter it at <span className="text-gray-300">wicklee.dev → Pair a node</span>. No SSH, no firewall changes — the agent initiates the outbound connection.</p>
            </div>

            {/* Upgrading */}
            <div>
              <p className="font-semibold text-white mb-2">Upgrading Wicklee</p>
              <p className="mb-3">The install script handles everything automatically — it stops any running instance before swapping the binary, so upgrades are one command:</p>
              <div className="mb-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">The easy way (v0.4.36+)</p>
                <Code lang="shell">curl -fsSL https://wicklee.dev/install.sh | bash</Code>
              </div>
              <p className="mb-3 text-gray-400">If you see a version mismatch banner or <span className="font-mono text-xs text-gray-300">Port 7700 is busy</span>, run the manual recovery sequence:</p>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Manual recovery</p>
                <Code lang="shell">{`sudo wicklee --uninstall-service   # stop and remove the daemon
sudo pkill -9 wicklee              # clear any ghost processes
curl -fsSL https://wicklee.dev/install.sh | bash
sudo wicklee --install-service     # re-install as daemon`}</Code>
              </div>
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
                    <td className="py-3 text-gray-400 align-top">Start the agent and generate a 6-digit pairing code — the agent runs normally while displaying the code. Useful for headless servers (SSH session). Enter the code at <span className="text-gray-300">wicklee.dev → Pair a node</span>.</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-6 font-mono text-xs text-indigo-300 align-top">wicklee --version</td>
                    <td className="py-3 text-gray-400 align-top">Print the agent version and exit. Use this to confirm which build is running after an update.</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-6 font-mono text-xs text-indigo-300 align-top">wicklee --status</td>
                    <td className="py-3 text-gray-400 align-top">Check if the agent is running on port 7700. Prints version, port status, and a hint if the agent is not detected.</td>
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
                Wicklee detects thermal state differently per platform, always preferring hardware-authoritative sources over inferred estimates. The <code className="text-gray-400">thermal_source</code> field in each payload identifies which path was used.
              </p>

              {/* Platform thermal detection breakdown */}
              <div className="mt-3 space-y-2">
                <p className="text-[11px] font-semibold text-gray-300">Platform detection hierarchy</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <Th>Platform</Th>
                        <Th>Source tag</Th>
                        <Th>Detection method</Th>
                        <Th>Penalty derivation</Th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <Td>NVIDIA GPU</Td>
                        <Td mono>nvml</Td>
                        <Td>NVML hardware throttle-reason bitmask — authoritative, not estimated</Td>
                        <Td>Direct from bitmask flags (SW Thermal, HW Thermal, Power Brake, etc.)</Td>
                      </tr>
                      <tr>
                        <Td>Apple Silicon</Td>
                        <Td mono>iokit</Td>
                        <Td><code className="text-gray-400">pmset -g therm</code> thermal level (IOKit framework)</Td>
                        <Td>macOS reports "Nominal" which Wicklee maps to Normal. Fair, Serious, Critical map directly.</Td>
                      </tr>
                      <tr>
                        <Td>AMD Linux (k10temp)</Td>
                        <Td mono>clock_ratio</Td>
                        <Td>CPU clock ratio (<code className="text-gray-400">scaling_cur_freq ÷ cpuinfo_max_freq</code>) + Tdie temperature from k10temp hwmon</Td>
                        <Td>≥0.95 Normal · ≥0.80 Fair · ≥0.60 Serious · &lt;0.60 Critical. Tdie &gt; 85°C forces at least Serious.</Td>
                      </tr>
                      <tr>
                        <Td>Intel Linux (coretemp)</Td>
                        <Td mono>coretemp</Td>
                        <Td>Clock ratio (primary) with per-core coretemp temperature as override</Td>
                        <Td>Same clock ratio thresholds as AMD. Coretemp max temp overrides if &gt; 85°C. Without cpufreq: &lt;70°C Normal · 70–79 Fair · 80–89 Serious · ≥90 Critical.</Td>
                      </tr>
                      <tr>
                        <Td>Generic Linux (no hwmon)</Td>
                        <Td mono>clock_ratio</Td>
                        <Td>CPU clock ratio only — no temperature sensor available</Td>
                        <Td>Same ratio thresholds but <strong className="text-gray-300">forced to Normal when CPU &lt; 15%</strong> (idle frequency scaling, not throttling). Capped at Fair without temp confirmation when CPU is active.</Td>
                      </tr>
                      <tr>
                        <Td>Linux (sysfs fallback)</Td>
                        <Td mono>sysfs</Td>
                        <Td>Thermal zone max temperature from <code className="text-gray-400">/sys/class/thermal/</code></Td>
                        <Td>&lt;70°C Normal · 70–79 Fair · 80–89 Serious · ≥90 Critical</Td>
                      </tr>
                      <tr>
                        <Td>Windows</Td>
                        <Td mono>wmi</Td>
                        <Td>WMI <code className="text-gray-400">MSAcpi_ThermalZoneTemperature</code> (tenths-of-Kelvin → Celsius)</Td>
                        <Td>&lt;70°C Normal · 70–79 Fair · 80–89 Serious · ≥90 Critical</Td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] text-gray-600 leading-relaxed">
                  The agent tries each source in priority order (NVML → Apple → AMD/Intel hwmon → generic cpufreq → sysfs → WMI) and uses the first that returns data. If no thermal source is available, <code className="text-gray-500">thermal_state</code> is null and no WES penalty is applied.
                </p>
              </div>
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


            {/* WES Alerting Behavior */}
            <div className="bg-gray-950 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-white uppercase tracking-wider mb-3">WES Cliff — Efficiency Collapse Alert</p>
              <p className="text-xs text-gray-400 leading-relaxed mb-3">
                The cloud evaluator monitors WES across your fleet and fires a <strong className="text-gray-300">WES Cliff</strong> observation when a node's efficiency collapses. To avoid noise from natural fluctuations, the alert has strict gating:
              </p>
              <div className="space-y-2 text-xs text-gray-400">
                <p><strong className="text-gray-300">1. Active inference required</strong> — WES is only meaningful during inference. The alert only evaluates nodes in <code className="text-gray-300 font-mono text-[10px]">live</code> or <code className="text-gray-300 font-mono text-[10px]">idle-spd</code> state. Idle nodes are ignored.</p>
                <p><strong className="text-gray-300">2. Absolute floor</strong> — Current WES must be below <span className="text-yellow-400 font-mono">3.0</span> (the bottom of the "Good" range). A node at WES 5.0 that dropped 70% from baseline is still performing acceptably — no alert.</p>
                <p><strong className="text-gray-300">3. Relative drop</strong> — Current WES must also be below <span className="font-mono text-gray-300">35%</span> of the node's 24-hour baseline. This catches genuine collapses while ignoring normal variation.</p>
                <p><strong className="text-gray-300">4. Cooldown</strong> — After resolving, the same node cannot re-fire WES Cliff for <span className="font-mono text-gray-300">4 hours</span>. This prevents hourly fire/resolve churn when a node hovers near the threshold.</p>
              </div>
              <p className="mt-3 text-[10px] text-gray-600 leading-relaxed">
                Example: a node with a 24h WES baseline of 12.0 would need to drop below both 3.0 (absolute) and 4.2 (35% of 12.0) during active inference to trigger. The effective threshold is whichever is lower — in this case, WES &lt; 3.0.
              </p>
            </div>

            {/* tok/W */}
            <div className="bg-gray-950 border border-blue-500/20 rounded-xl p-5">
              <p className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-3">tok/W — Tokens Per Watt</p>
              <pre className="font-mono text-sm text-white leading-loose">
{`tok/W = tok/s ÷ Watts`}</pre>
              <p className="mt-3 text-xs text-gray-400 leading-relaxed">
                Raw inference efficiency without thermal adjustment. When thermal state is Normal (penalty = 1.0), tok/W and WES are identical. When the node is thermally stressed, tok/W stays higher than WES — the gap between them is the thermal penalty. Displayed alongside WES in the Fleet Status table and as a summary tile on both localhost and cloud dashboards.
              </p>
              <p className="mt-2 text-xs text-gray-500 leading-relaxed">
                tok/W uses the same color scale as WES: <span className="text-emerald-400">&gt; 10 Excellent</span> · <span className="text-green-300">3–10 Good</span> · <span className="text-yellow-400">1–3 Acceptable</span> · <span className="text-red-400">&lt; 1 Low</span>.
              </p>
            </div>

            {/* Score interpretation table */}
            <div>
              <p className="font-semibold text-white mb-2">Reading WES and tok/W scores</p>
              <p className="text-xs text-gray-500 mb-2">Both WES and tok/W use the same four-tier color scale. The scale applies to both metrics identically.</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Score range</Th>
                      <Th>Color</Th>
                      <Th>Label</Th>
                      <Th>Typical hardware</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><Td mono>&gt; 10</Td><Td><span className="text-emerald-400 font-medium">Emerald</span></Td><Td>Excellent — highly efficient inference</Td><Td>Apple M4 / M3 at low-to-moderate load</Td></tr>
                    <tr><Td mono>3 – 10</Td><Td><span className="text-green-300 font-medium">Light Green</span></Td><Td>Good — efficient for the power envelope</Td><Td>Apple M-series at full load, efficient NVIDIA setups</Td></tr>
                    <tr><Td mono>1 – 3</Td><Td><span className="text-yellow-400 font-medium">Yellow</span></Td><Td>Acceptable — typical for high-power hardware</Td><Td>EPYC / Xeon CPU-only, midrange GPUs</Td></tr>
                    <tr><Td mono>&lt; 1</Td><Td><span className="text-red-400 font-medium">Red</span></Td><Td>Low — check thermal state or model sizing</Td><Td>Server GPUs under load, thermal throttle, or misconfigured</Td></tr>
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
                      <Td><span className="font-medium text-white">Cost / Day</span></Td>
                      <Td mono>Σ (node_watts × 24 ÷ 1000) × kWh_rate</Td>
                      <Td>Estimated daily electricity cost based on <strong className="text-gray-300">current instantaneous power draw</strong> projected over 24 hours. Uses each node's configured kWh rate (default $0.12/kWh). This is a <em>projection</em>, not metered consumption — if a node spikes to 200W for 1 hour then idles at 10W for 23 hours, the tile shows cost at whatever wattage is being read <em>right now</em>. Node Cost/Day (localhost) sums a single node; Fleet Cost/Day (cloud) sums all online nodes. PUE multiplier applied when configured in Settings.</Td>
                    </tr>
                    <tr>
                      <Td><span className="font-medium text-white">Throughput label</span></Td>
                      <Td mono>LIVE · IDLE-SPD · BUSY · IDLE</Td>
                      <Td>Four states from the agent's inference state machine. See <a href="#states" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">Node States</a> for full definitions. Tok/s values with a <code className="text-gray-300 font-mono text-xs">~</code> prefix are probe baselines, not live measurements.</Td>
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
Wicklee:         v0.4.36

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
*Generated by Wicklee v0.4.36 · https://wicklee.dev*`}</Code>
              <p>
                Reports are available as <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">.md</code> (human-readable) and <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">.json</code> (machine-readable). The JSON format includes all fields above plus a full provenance record — runtime, quantization, thermal source, and WES version — so comparisons across hardware remain unambiguous.
              </p>
              <p>
                The WES Trend chart (Mission Control, Pro+) also includes a per-node <strong className="text-white">Export</strong> button that snapshots the most recent history point from the selected time window.
              </p>
            </div>
          </Section>

          {/* ── Node States ── */}
          <Section
            id="states"
            icon={<Zap className="w-5 h-5" />}
            accent="border-emerald-500/20"
            title="Node States — Inference Detection"
          >
            <p>
              Every Wicklee node reports an <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">inference_state</code> field that classifies what the hardware is doing right now. This field is computed once per second by the agent's state machine and is the <strong className="text-white">single source of truth</strong> — the dashboard displays it directly and never re-computes it.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>State</Th>
                    <Th>Badge</Th>
                    <Th>Meaning</Th>
                    <Th>Tok/s display</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td mono>live</Td>
                    <Td><span className="text-green-400 font-medium">LIVE</span></Td>
                    <Td>User inference confirmed — model is actively generating tokens for a real request.</Td>
                    <Td>Live-measured tok/s (green, no tilde)</Td>
                  </tr>
                  <tr>
                    <Td mono>idle-spd</Td>
                    <Td><span className="text-gray-400 font-medium">IDLE-SPD</span></Td>
                    <Td>Runtime loaded, no active inference. The agent runs a lightweight probe to measure the hardware's baseline throughput — this is the node's <em>capacity</em>, not current workload.</Td>
                    <Td>Probe baseline tok/s (gray, with <code className="text-gray-300 font-mono text-xs">~</code> tilde)</Td>
                  </tr>
                  <tr>
                    <Td mono>busy</Td>
                    <Td><span className="text-amber-400 font-medium">BUSY</span></Td>
                    <Td>Significant GPU or power activity, but no inference runtime detected — the hardware is doing non-inference work (rendering, training, compilation).</Td>
                    <Td>Last known probe baseline (amber)</Td>
                  </tr>
                  <tr>
                    <Td mono>idle</Td>
                    <Td><span className="text-gray-600 font-medium">IDLE</span></Td>
                    <Td>No inference runtime loaded, no significant GPU activity. The node is available but not running any AI workload.</Td>
                    <Td>— (no value)</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="bg-gray-950 border border-emerald-500/20 rounded-xl p-5">
              <p className="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-3">How inference is detected — three-tier hierarchy</p>
              <p className="text-xs text-gray-400 leading-relaxed mb-3">
                The agent evaluates three tiers of evidence every second. The first tier that fires wins — higher tiers are more precise and take priority.
              </p>
              <div className="space-y-3">
                <div className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-[10px] font-bold text-emerald-400">1</span>
                  <div>
                    <p className="text-sm text-white font-medium">Exact — runtime API</p>
                    <p className="text-xs text-gray-400 mt-0.5">vLLM and llama.cpp/llama-box report active request/slot counts. If <code className="text-gray-300 font-mono text-xs">requests_running &gt; 0</code> (vLLM) or <code className="text-gray-300 font-mono text-xs">slots_processing &gt; 0</code> (llama.cpp), the node is LIVE — no ambiguity.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-[10px] font-bold text-emerald-400">2</span>
                  <div>
                    <p className="text-sm text-white font-medium">Attribution — Ollama activity tracking</p>
                    <p className="text-xs text-gray-400 mt-0.5">When Ollama's <code className="text-gray-300 font-mono text-xs">/api/ps</code> shows a model expiry change that can be attributed to a user request (not the agent's own probe), the node is LIVE for 15 seconds. A one-shot flag (<code className="text-gray-300 font-mono text-xs">probe_caused_next_reset</code>) prevents the probe from being mistaken for user activity.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-[10px] font-bold text-emerald-400">3</span>
                  <div>
                    <p className="text-sm text-white font-medium">Physics — hardware sensors</p>
                    <p className="text-xs text-gray-400 mt-0.5">When no runtime API is available, the agent reads GPU utilization, SoC power, ANE power, and NVIDIA board power directly. If these exceed idle thresholds while a <strong className="text-gray-300">model is loaded in VRAM</strong>, the node is LIVE. A running runtime process (e.g. Ollama) with no model loaded will not trigger Tier 3 — everyday GPU activity from other apps cannot produce a false LIVE. A saturated-GPU override ({'≥'}75%) bypasses the post-probe cooldown window — probe-driven GPU residency never exceeds ~60% on Apple Silicon, so 75%+ can only be real inference.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
              <p className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">The tilde convention</p>
              <p className="text-xs text-gray-400 leading-relaxed">
                Tok/s values prefixed with <code className="text-amber-300 font-mono">~</code> are <strong className="text-gray-300">baseline estimates</strong> from the agent's periodic throughput probe — not live measurements from an active request. The probe sends a short 20-token generation to measure the hardware's current capacity. When inference is active (LIVE state), the tilde disappears and the value reflects real-time measured throughput.
              </p>
            </div>

            <NoteBox>
              The <code className="font-mono text-xs text-gray-300">inference_state</code> field is frozen in the wire format — the agent sends it identically to the local WebSocket dashboard and the fleet cloud backend. The fleet dashboard must display this value directly and never attempt to re-derive it from other fields like <code className="font-mono text-xs text-gray-300">gpu_utilization_percent</code> or <code className="font-mono text-xs text-gray-300">ollama_inference_active</code>.
            </NoteBox>
          </Section>

          {/* ── Latency & TTFT ── */}
          <Section
            id="latency"
            icon={<Clock className="w-5 h-5" />}
            accent="border-cyan-500/20"
            title="Latency & TTFT"
          >
            <p>
              Wicklee measures Time To First Token (TTFT) from three independent sources, each with different characteristics. Understanding which source is active helps interpret the values shown in the Fleet Status table and summary tiles.
            </p>

            <div className="overflow-x-auto mt-4">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <Th>Source</Th>
                    <Th>Field</Th>
                    <Th>Type</Th>
                    <Th>What it measures</Th>
                    <Th>When available</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td><span className="font-medium text-blue-400">Ollama Probe</span></Td>
                    <Td mono>ollama_ttft_ms</Td>
                    <Td><span className="text-amber-400 text-[10px] font-semibold">SYNTHETIC</span></Td>
                    <Td>Prompt eval duration from a 20-token probe request every ~30s. Measures hardware capability under no contention — a baseline, not production latency.</Td>
                    <Td>Ollama running, model loaded</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-green-400">vLLM Histogram</span></Td>
                    <Td mono>vllm_avg_ttft_ms</Td>
                    <Td><span className="text-emerald-400 text-[10px] font-semibold">PRODUCTION</span></Td>
                    <Td>Rolling average from the <code className="text-gray-400">vllm:time_to_first_token_seconds</code> Prometheus histogram. Real production latency including queue wait and scheduling overhead.</Td>
                    <Td>vLLM running + at least 1 request completed</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-purple-400">Proxy</span></Td>
                    <Td mono>ollama_proxy_avg_ttft_ms</Td>
                    <Td><span className="text-emerald-400 text-[10px] font-semibold">PRODUCTION</span></Td>
                    <Td>Rolling average of <code className="text-gray-400">prompt_eval_duration</code> extracted from Ollama done packets flowing through the Wicklee transparent proxy. Real production latency.</Td>
                    <Td>Proxy enabled + requests flowing</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-4 mt-4">
              <p className="text-xs font-bold text-cyan-400 uppercase tracking-wider mb-2">Resolution priority</p>
              <p className="text-xs text-gray-400 leading-relaxed">
                The dashboard resolves TTFT using the best available source: <strong className="text-gray-300">vLLM histogram</strong> (most accurate, real production data) → <strong className="text-gray-300">Proxy rolling average</strong> (real data, Ollama-specific) → <strong className="text-gray-300">Ollama probe</strong> (synthetic baseline). When the source is synthetic, the value represents the hardware floor — actual production TTFT will be higher under concurrent load.
              </p>
            </div>

            <div className="mt-4">
              <p className="font-semibold text-white mb-2">Additional latency metrics</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <Th>Field</Th>
                      <Th>Source</Th>
                      <Th>Description</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <Td mono>vllm_avg_e2e_latency_ms</Td>
                      <Td>vLLM histogram</Td>
                      <Td>End-to-end request latency (queue + prefill + decode). Production only.</Td>
                    </tr>
                    <tr>
                      <Td mono>vllm_avg_queue_time_ms</Td>
                      <Td>vLLM histogram</Td>
                      <Td>Time spent waiting in the scheduler queue before processing begins.</Td>
                    </tr>
                    <tr>
                      <Td mono>ollama_proxy_avg_latency_ms</Td>
                      <Td>Proxy done packets</Td>
                      <Td>Total request duration (prompt eval + generation) for Ollama requests through the proxy.</Td>
                    </tr>
                    <tr>
                      <Td mono>ollama_prompt_eval_tps</Td>
                      <Td>Ollama probe</Td>
                      <Td>Prompt processing speed (tokens/sec). Synthetic baseline — indicates prefill throughput capability.</Td>
                    </tr>
                    <tr>
                      <Td mono>ollama_load_duration_ms</Td>
                      <Td>Ollama probe</Td>
                      <Td>Time to load the model into memory on the most recent probe. High values indicate cold starts or memory pressure.</Td>
                    </tr>
                  </tbody>
                </table>
              </div>
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
              The Insights → Triage tab runs a time-windowed pattern engine against your node's telemetry history. Patterns require a sustained evidence window before firing — single-frame spikes never produce an alert. Each observation includes actionable commands tailored to your platform (macOS, Linux, or NVIDIA).
            </p>
            <p>
              Wicklee evaluates 18 patterns across three scopes: patterns that run on both localhost and the fleet cloud, patterns that require fleet context (cloud-only), and patterns that rely on local-only sensors. 9 patterns are available on the Community tier; 9 additional patterns require Pro.
            </p>

            {/* ── Localhost + Cloud patterns ── */}
            <p className="text-xs font-bold text-emerald-400 uppercase tracking-wider mt-4">Localhost-Only (4 patterns)</p>
            <p className="text-xs text-gray-500 mb-2">Evaluated by the agent against the local 1-hour DuckDB buffer via <code className="text-gray-400 font-mono text-xs">GET /api/observations</code>. No fleet connection required.</p>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Pattern</Th>
                    <Th>What it detects</Th>
                    <Th>Primary action</Th>
                    <Th>Window</Th>
                    <Th>Tier</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td><span className="font-medium text-amber-400">A — Thermal Drain</span></Td>
                    <Td>Sustained throttle state reducing tok/s vs. the node's own Normal-temperature baseline (&gt; 8% degradation)</Td>
                    <Td><code className="text-[10px] text-gray-500">sudo powermetrics --samplers gpu_power</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-violet-400">B — Phantom Load</span></Td>
                    <Td>Model loaded + power &gt; 5W + tok/s &lt; 0.5 — idle model burning electricity with no inference</Td>
                    <Td><code className="text-[10px] text-gray-500">ollama stop &lt;model&gt;</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-rose-400">J — Swap I/O Pressure</span></Td>
                    <Td>Swap write rate &gt; 2 MB/s sustained — model layers spilling to disk, degrading throughput. Escalates to "Swap Storm" at &gt; 10 MB/s</Td>
                    <Td><code className="text-[10px] text-gray-500">ollama ps</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-orange-400">L — PCIe Degradation</span></Td>
                    <Td>PCIe link width below rated maximum (e.g. x8 in x16 slot) — bandwidth loss affecting GPU ↔ CPU transfers. NVIDIA only</Td>
                    <Td><code className="text-[10px] text-gray-500">nvidia-smi -q -d PCIE</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Pro</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* ── Cloud-only patterns ── */}
            <p className="text-xs font-bold text-blue-400 uppercase tracking-wider mt-6">Cloud-Only (4 patterns)</p>
            <p className="text-xs text-gray-500 mb-2">Require fleet context or multi-node comparison. Only available when paired with wicklee.dev.</p>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Pattern</Th>
                    <Th>What it detects</Th>
                    <Th>Primary action</Th>
                    <Th>Window</Th>
                    <Th>Tier</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td><span className="font-medium text-indigo-400">C — WES Velocity Drop</span></Td>
                    <Td>Efficiency score declining &gt; 10% over a sustained period before thermal state has changed — early warning</Td>
                    <Td><code className="text-[10px] text-gray-500">curl localhost:7700/api/metrics</code></Td>
                    <Td mono>10 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-sky-400">E — Fleet Load Imbalance</span></Td>
                    <Td>Node thermally stressed or WES &lt; 50% of best peer while a healthier node has spare capacity</Td>
                    <Td><code className="text-[10px] text-gray-500">Route to healthier peer</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Pro</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-cyan-400">F — Memory Pressure Trajectory</span></Td>
                    <Td>Memory pressure rising &gt; 1 pct/min sustained — projected to hit critical threshold before operator can react</Td>
                    <Td><code className="text-[10px] text-gray-500">ollama ps</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-fuchsia-400">I — Efficiency Penalty Drag</span></Td>
                    <Td>WES penalty_avg &gt; 30% loss with Normal thermal state, active GPU, and no memory pressure — hidden context/batch inefficiency</Td>
                    <Td><code className="text-[10px] text-gray-500">Reduce context length / batch</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Pro</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* ── Localhost-only patterns ── */}
            <p className="text-xs font-bold text-amber-400 uppercase tracking-wider mt-6">Both — Localhost + Cloud (10 patterns)</p>
            <p className="text-xs text-gray-500 mb-2">Evaluated on both the local agent and the cloud pattern engine. Available in standalone and fleet mode.</p>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Pattern</Th>
                    <Th>What it detects</Th>
                    <Th>Primary action</Th>
                    <Th>Window</Th>
                    <Th>Tier</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td><span className="font-medium text-purple-400">D — Power-GPU Decoupling</span></Td>
                    <Td>High power draw (&gt; 50W) with active inference but GPU utilization &lt; 20% — layers running on CPU instead of GPU</Td>
                    <Td><code className="text-[10px] text-gray-500">ollama ps</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Pro</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-teal-400">G — Bandwidth Saturation</span></Td>
                    <Td>GPU utilization &lt; 40% but VRAM &gt; 80% full with WES dropping — memory bandwidth bottleneck, not compute</Td>
                    <Td><code className="text-[10px] text-gray-500">Switch to smaller quantization</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Pro</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-yellow-400">H — Power Jitter</span></Td>
                    <Td>Mean power &gt; 30W with active inference and coefficient of variation &gt; 20% — unstable power delivery or erratic batch scheduling</Td>
                    <Td><code className="text-[10px] text-gray-500">Reduce batch concurrency</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-lime-400">K — Clock Drift</span></Td>
                    <Td>Clock throttle &gt; 15% during inference with Normal thermal state — power cap or driver limit constraining clocks, not heat</Td>
                    <Td><code className="text-[10px] text-gray-500">nvidia-smi -q -d CLOCK</code> / <code className="text-[10px] text-gray-500">sudo cpupower frequency-info</code></Td>
                    <Td mono>5 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-pink-400">M — vLLM Cache Saturation</span></Td>
                    <Td>vLLM KV cache &gt; 90% full — scheduler cannot admit new sequences, requests will queue or return 503</Td>
                    <Td><code className="text-[10px] text-gray-500">curl localhost:8000/metrics | grep cache</code></Td>
                    <Td mono>3 min</Td>
                    <Td>Pro</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-red-400">N — NVIDIA Thermal Redline</span></Td>
                    <Td>GPU temperature &gt; 85°C sustained or &gt; 90°C instantaneous — driver will aggressively throttle clocks. NVIDIA only</Td>
                    <Td><code className="text-[10px] text-gray-500">nvidia-smi -q -d TEMPERATURE</code></Td>
                    <Td mono>2 min</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-emerald-400">O — VRAM Overcommit</span></Td>
                    <Td>Loaded model consumes &gt; 90% of VRAM/unified memory — no headroom for KV cache, context, or concurrency</Td>
                    <Td><code className="text-[10px] text-gray-500">ollama ps</code> / <code className="text-[10px] text-gray-500">nvidia-smi</code></Td>
                    <Td mono>instant</Td>
                    <Td>Community</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-pink-400">P — TTFT Regression</span></Td>
                    <Td>Time to first token spikes &gt; 2× the 5-minute baseline — queue contention, model swap, or prompt complexity increase</Td>
                    <Td><code className="text-[10px] text-gray-500">curl localhost:7700/api/metrics | jq .vllm_requests_waiting</code></Td>
                    <Td mono>2 min</Td>
                    <Td>Pro</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-red-300">Q — Latency Spike</span></Td>
                    <Td>End-to-end request latency exceeds 2 seconds for 3+ consecutive samples — inference pipeline bottleneck</Td>
                    <Td><code className="text-[10px] text-gray-500">Reduce batch concurrency</code></Td>
                    <Td mono>3 min</Td>
                    <Td>Pro</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-violet-300">R — vLLM Queue Saturation</span></Td>
                    <Td>vLLM requests_waiting &gt; 5 sustained — incoming requests exceed engine capacity, needs horizontal scaling or routing</Td>
                    <Td><code className="text-[10px] text-gray-500">curl localhost:8000/metrics | grep vllm_num_requests</code></Td>
                    <Td mono>3 min</Td>
                    <Td>Pro</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="bg-gray-950 border border-violet-500/20 rounded-xl p-4 space-y-2 mt-4">
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

            <div className="bg-gray-950 border border-violet-500/20 rounded-xl p-4 space-y-2">
              <p className="text-xs font-bold text-violet-400 uppercase tracking-wider">Action commands</p>
              <p className="text-xs text-gray-400 leading-relaxed">
                Each observation includes one or two actionable commands you can copy and run. Commands are platform-aware — Pattern O shows <code className="text-gray-300">sysctl iogpu.wired_limit_mb</code> on Apple Silicon and <code className="text-gray-300">nvidia-smi --query-gpu=memory.total,memory.used,memory.free</code> on NVIDIA. Latency patterns (P, Q, R) leverage TTFT and queue depth metrics from vLLM Prometheus, the Ollama proxy, and probe responses. All commands target the local agent or runtime and never send data externally.
              </p>
            </div>

            <NoteBox>
              Confidence levels — <strong className="text-white">Building</strong> (under 50% of required window), <strong className="text-white">Moderate</strong> (50–90%), <strong className="text-white">High</strong> (≥ 90%) — are shown in the observation card header and as a progress bar while evidence accumulates. A pattern at High confidence means the condition has been sustained for the full required window. Point-in-time patterns (Pattern O) always fire at High confidence since a single observation provides complete evidence.
            </NoteBox>
          </Section>

          {/* ── Event Feeds ── */}
          <Section
            id="event-feeds"
            icon={<Activity className="w-5 h-5" />}
            accent="border-blue-500/20"
            title="Event Feeds"
          >
            <p>
              Wicklee has two distinct event surfaces that serve different purposes. They are intentionally separate — one for real-time awareness, one for post-incident review.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <Th></Th>
                    <Th>Live Activity</Th>
                    <Th>Recent Activity</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td><span className="text-gray-300 font-medium">Location</span></Td>
                    <Td>Intelligence page (scrollable feed)</Td>
                    <Td>Insights → Triage (expand on click)</Td>
                  </tr>
                  <tr>
                    <Td><span className="text-gray-300 font-medium">Data source</span></Td>
                    <Td>Fleet events from SSE stream (FleetStreamContext)</Td>
                    <Td>Alert quartet latch system (AIInsights)</Td>
                  </tr>
                  <tr>
                    <Td><span className="text-gray-300 font-medium">What it shows</span></Td>
                    <Td>Connectivity (online/offline), thermal transitions, model swaps, power anomalies, observation onset/resolved (zombied engine, thermal redline, OOM, WES cliff, version mismatch), pattern onset/resolved/dismissed</Td>
                    <Td>Alert card lifecycle only — when did thermal/power/memory/thermal-cost alerts fire and resolve, with duration</Td>
                  </tr>
                  <tr>
                    <Td><span className="text-gray-300 font-medium">Trigger</span></Td>
                    <Td>Immediate — fires on every state transition in the telemetry stream</Td>
                    <Td>Delayed — only fires after the 15-second onset gate, records resolved timestamp + duration</Td>
                  </tr>
                  <tr>
                    <Td><span className="text-gray-300 font-medium">Persistence</span></Td>
                    <Td>Current session only (React state)</Td>
                    <Td>sessionStorage — survives page refresh, cleared on tab close</Td>
                  </tr>
                  <tr>
                    <Td><span className="text-gray-300 font-medium">Purpose</span></Td>
                    <Td>Real-time operational awareness — what is happening right now</Td>
                    <Td>Post-incident review — which alerts fired, how long did they last</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            <NoteBox>
              The Fleet Event Timeline on the Observability tab is a third, separate surface — it shows persisted <code className="font-mono text-xs text-gray-300">node_events</code> from Postgres (cloud) or DuckDB (localhost) with 30-day retention. This is the permanent audit record. Live Activity and Recent Activity are session-scoped and intended for real-time operations, not compliance.
            </NoteBox>
          </Section>

          {/* ── Localhost API ── */}
          <Section
            id="api-local"
            icon={<Globe className="w-5 h-5" />}
            accent="border-emerald-500/20"
            title="Localhost API"
          >
            <p>Every Wicklee agent exposes a local API at <code className="font-mono text-xs text-gray-300">localhost:7700</code>. No authentication required. No internet connection needed. All endpoints return JSON.</p>

            <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div>
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Base URL</p>
                <code className="font-mono text-sm text-emerald-300">http://localhost:7700</code>
              </div>
              <div className="sm:ml-auto">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Auth</p>
                <code className="font-mono text-sm text-gray-400">None required</code>
              </div>
            </div>

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
                    <Td mono>GET /api/metrics</Td>
                    <Td>SSE stream — 1 Hz telemetry with full MetricsPayload (inference_state, WES, power, thermal, GPU, model)</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /ws</Td>
                    <Td>WebSocket — 10 Hz live telemetry for high-frequency charts (localhost only)</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/observations</Td>
                    <Td>Local hardware pattern evaluation — 4 sovereign patterns (A: Thermal Drain, B: Phantom Load, J: Swap Pressure, L: PCIe Degradation) against 1h DuckDB buffer</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/history?node_id=WK-XXXX</Td>
                    <Td>DuckDB metric history — 1h of raw samples (tok/s, GPU util, power, memory pressure, swap)</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/traces</Td>
                    <Td>Inference request traces — TTFT, TPOT, latency per request (localhost-only, never transmitted)</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/events/history</Td>
                    <Td>Persisted Live Activity events from DuckDB (startups, model swaps, thermal changes)</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/events/recent</Td>
                    <Td>Recent in-memory events (last ~50 from current session)</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/export?format=json</Td>
                    <Td>Full export of local events and metrics as JSON or CSV (<code className="text-gray-400 text-xs">format=csv</code>)</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/pair/status</Td>
                    <Td>Agent health — pairing state, node_id, fleet_url, agent version</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/tags</Td>
                    <Td>Ollama model tags — proxied from the local Ollama instance</Td>
                  </tr>
                  <tr>
                    <Td mono>POST /api/insights/dismiss</Td>
                    <Td>Permanently dismiss a local observation pattern — writes to DuckDB audit trail. Pattern will not resurface.</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/insights/dismissed</Td>
                    <Td>List all permanently dismissed pattern IDs for this node</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            <Code lang="shell">{`# Example: stream live metrics
curl http://localhost:7700/api/metrics

# Example: check agent health
curl http://localhost:7700/api/pair/status | jq

# Example: fetch 1h metric history
curl "http://localhost:7700/api/history?node_id=WK-502B" | jq '.samples | length'`}</Code>

            <NoteBox>
              The localhost API is available on every tier including Community — no account, no pairing, no internet required. Ideal for local shell scripts, Ray clusters, or internal tools that need real-time node telemetry without data leaving the network.
            </NoteBox>
          </Section>

          {/* ── Fleet API v1 ── */}
          <Section
            id="api-fleet"
            icon={<Globe className="w-5 h-5" />}
            accent="border-cyan-500/20"
            title="Fleet API v1"
          >
            <p>The Fleet API provides cross-node intelligence, routing recommendations, and fleet-wide telemetry. Authenticate with an API key — create one in <strong className="text-white">Settings → API Keys</strong> in your fleet dashboard.</p>

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

            <p className="text-xs font-bold text-cyan-400 uppercase tracking-wider mt-4">Fleet Status &amp; Routing</p>
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
                    <Td>All nodes — node_id, hostname, online status, full MetricsPayload, WES score</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/v1/fleet/wes</Td>
                    <Td>WES leaderboard — node_id, WES score, and online status for every node</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/v1/nodes/:id</Td>
                    <Td>Single node deep dive — full MetricsPayload with all hardware and runtime fields</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/v1/route/best</Td>
                    <Td>Routing recommendation — returns two candidates: <code className="text-gray-400 text-xs">latency</code> (highest tok/s) and <code className="text-gray-400 text-xs">efficiency</code> (highest WES). Default: efficiency. Only online nodes considered.</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/v1/insights/latest</Td>
                    <Td>Fleet intelligence snapshot — fleet summary (online count, avg WES, fleet tok/s) + findings array (thermal stress, memory pressure, offline nodes, WES below baseline, low throughput)</Td>
                  </tr>
                  <tr>
                    <Td mono>POST /api/v1/keys</Td>
                    <Td>Create a new API key — returns the raw key once (prefix <code className="text-gray-400 text-xs">wk_live_</code>). Stored as SHA-256 hash at rest.</Td>
                  </tr>
                  <tr>
                    <Td mono>GET /api/v1/keys</Td>
                    <Td>List all API keys for the authenticated user — returns key ID, prefix, created date. Hash is never exposed.</Td>
                  </tr>
                  <tr>
                    <Td mono>DELETE /api/v1/keys/:key_id</Td>
                    <Td>Revoke an API key by ID. Takes effect immediately — in-flight requests with the revoked key will fail.</Td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-white mb-2">Route response shape</p>
              <Code lang="json">{`{
  "latency":    { "node": "WK-99E9", "tok_s": 31.9, "wes": 3.3,  "reason": "Highest throughput" },
  "efficiency": { "node": "WK-502B", "tok_s": 19.5, "wes": 56.0, "reason": "Highest WES" },
  "default":    "efficiency"
}`}</Code>
            </div>

            <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-white mb-2">Insights response shape</p>
              <Code lang="json">{`{
  "generated_at_ms": 1774624251478,
  "fleet": { "online_count": 3, "total_count": 3, "avg_wes": 9.9, "fleet_tok_s": 79.0 },
  "findings": [
    {
      "node_id": "WK-99E9", "hostname": "spark-c559",
      "severity": "low", "pattern": "wes_below_baseline",
      "title": "WES below fleet average on spark-c559",
      "detail": "WES 3.3 vs fleet average 9.9",
      "value": 3.3, "unit": "WES"
    }
  ]
}`}</Code>
            </div>

            <TipBox>
              <span>
                <strong className="text-white">Implementation tip — <code className="font-mono text-xs">/api/v1/route/best</code>:</strong>{' '}
                Use this to feed your existing load balancer or LangChain router with real-time health data. Poll at 1–5s intervals and forward the <code className="font-mono text-xs text-gray-300">default</code> node recommendation upstream — no custom scoring logic required.
              </span>
            </TipBox>

            <div>
              <p className="font-semibold text-white mb-1">Rate limits</p>
              <p>Community: 60 req/min &nbsp;·&nbsp; Pro: 300 req/min &nbsp;·&nbsp; Team: 600 req/min &nbsp;·&nbsp; Enterprise: unlimited. Rate limits are operational throttles, not feature gates — API access is available on all tiers.</p>
            </div>
          </Section>

          {/* ── MCP Server ── */}
          <Section
            id="mcp"
            icon={<Cpu className="w-5 h-5" />}
            accent="border-cyan-500/20"
            title="MCP Server"
          >
            <p>Wicklee exposes a local <strong className="text-white">Model Context Protocol</strong> server for AI agents (Cursor, Claude Desktop, custom agents). Available on all tiers.</p>

            <div>
              <p className="font-semibold text-white mb-2">Endpoints</p>
              <table className="w-full text-xs">
                <thead><tr className="border-b border-gray-800"><Th>Method</Th><Th>Path</Th><Th>Description</Th></tr></thead>
                <tbody>
                  <tr className="border-b border-gray-800"><Td>POST</Td><Td>/mcp</Td><Td>JSON-RPC 2.0 MCP endpoint</Td></tr>
                  <tr className="border-b border-gray-800"><Td>GET</Td><Td>/.well-known/mcp.json</Td><Td>MCP server discovery manifest</Td></tr>
                </tbody>
              </table>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Tools</p>
              <table className="w-full text-xs">
                <thead><tr className="border-b border-gray-800"><Th>Tool</Th><Th>Description</Th></tr></thead>
                <tbody>
                  <tr className="border-b border-gray-800"><Td>get_node_status</Td><Td>Full hardware + inference metrics snapshot</Td></tr>
                  <tr className="border-b border-gray-800"><Td>get_inference_state</Td><Td>Live/idle/busy state with sensor context and tier match</Td></tr>
                  <tr className="border-b border-gray-800"><Td>get_active_models</Td><Td>Running models across Ollama, vLLM, llama.cpp</Td></tr>
                  <tr className="border-b border-gray-800"><Td>get_observations</Td><Td>Local hardware pattern evaluation (A, B, J, L)</Td></tr>
                  <tr className="border-b border-gray-800"><Td>get_metrics_history</Td><Td>1-hour rolling telemetry buffer from DuckDB</Td></tr>
                </tbody>
              </table>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Resources</p>
              <table className="w-full text-xs">
                <thead><tr className="border-b border-gray-800"><Th>URI</Th><Th>Description</Th></tr></thead>
                <tbody>
                  <tr className="border-b border-gray-800"><Td>wicklee://node/metrics</Td><Td>Live MetricsPayload JSON</Td></tr>
                  <tr className="border-b border-gray-800"><Td>wicklee://node/thermal</Td><Td>Thermal state + WES penalty values</Td></tr>
                </tbody>
              </table>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Claude Desktop</p>
              <p className="mb-2">Add <code>wicklee</code> to <code>mcpServers</code> in your Claude Desktop config. Open it with:</p>
              <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mb-2">
{`# macOS
nano "$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# Linux
nano ~/.config/Claude/claude_desktop_config.json

# Windows (PowerShell)
notepad "$env:APPDATA\\Claude\\claude_desktop_config.json"`}
              </pre>
              <p className="mb-2 text-xs text-gray-400">Add the <code>wicklee</code> entry inside <code>mcpServers</code> (create the file if it doesn't exist):</p>
              <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mb-2">
{`{
  "mcpServers": {
    "wicklee": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"],
      "env": {
        "HOME": "/Users/YOUR_USERNAME",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}`}
              </pre>
              <p className="text-gray-500 text-xs">Use <code>which npx</code> to find the correct path for your system. Fully quit Claude Desktop (Cmd+Q) and relaunch after editing.</p>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Claude Code (CLI)</p>
              <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`claude mcp add -s user wicklee -- npx -y mcp-remote http://localhost:7700/mcp`}
              </pre>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Cursor</p>
              <p className="mb-2">Open the global config (or use <code>.cursor/mcp.json</code> for project-scoped):</p>
              <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mb-2">
{`nano ~/.cursor/mcp.json`}
              </pre>
              <p className="mb-2 text-xs text-gray-400">Add the <code>wicklee</code> entry (create the file if it doesn't exist):</p>
              <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mb-2">
{`{
  "mcpServers": {
    "wicklee": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"]
    }
  }
}`}
              </pre>
              <p className="text-gray-500 text-xs">If you already have other servers, add the <code>wicklee</code> entry inside the existing <code>mcpServers</code> object.</p>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Windsurf</p>
              <p className="mb-2">Open the config:</p>
              <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mb-2">
{`nano ~/.codeium/windsurf/mcp_config.json`}
              </pre>
              <p className="mb-2 text-xs text-gray-400">Add the <code>wicklee</code> entry (create the file if it doesn't exist):</p>
              <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mb-2">
{`{
  "mcpServers": {
    "wicklee": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"]
    }
  }
}`}
              </pre>
            </div>

            <div>
              <p className="font-semibold text-white mb-1">Test with curl</p>
              <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`curl -X POST http://localhost:7700/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_node_status"},"id":1}'`}
              </pre>
              <p className="text-gray-500 text-xs mt-1">All setups require Node.js for the mcp-remote bridge. Restart your IDE after configuration changes.</p>
            </div>
          </Section>

          {/* ── Inline Proxy ── */}
          <Section
            id="proxy"
            icon={<Activity className="w-5 h-5" />}
            accent="border-purple-500/20"
            title="Inline Proxy (Ollama)"
          >
            <p>
              By default, Wicklee monitors inference using a lightweight synthetic probe (20 tokens every ~30 seconds). The optional <strong className="text-white">inline proxy</strong> intercepts real Ollama traffic to provide continuous, production-grade metrics with zero sampling gap.
            </p>

            <div>
              <p className="font-semibold text-white mb-2">What the proxy adds</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead><tr><Th>Metric</Th><Th>Probe (default)</Th><Th>With Proxy</Th></tr></thead>
                  <tbody>
                    <tr><Td>tok/s</Td><Td>Synthetic baseline (~30s cadence)</Td><Td>Exact from real requests (continuous)</Td></tr>
                    <tr><Td>TTFT</Td><Td>Cold-start synthetic</Td><Td>Rolling average from production traffic</Td></tr>
                    <tr><Td>E2E Latency</Td><Td>—</Td><Td>Full request duration (prompt + generation)</Td></tr>
                    <tr><Td>Request Count</Td><Td>—</Td><Td>Cumulative total since agent start</Td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">How it works</p>
              <p>The proxy binds to <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">localhost:11434</code> (Ollama's default port). Ollama is moved to a different port. All requests flow through Wicklee transparently — the proxy extracts timing metrics from Ollama's done packets and forwards everything unmodified. Your clients (Cursor, Open WebUI, etc.) don't need any configuration changes.</p>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Setup (3 steps)</p>
              <div className="space-y-3 text-xs text-gray-400">
                <div className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-[10px] font-bold text-purple-400">1</span>
                  <div>
                    <p className="text-sm text-white font-medium">Move Ollama to a different port</p>
                    <p className="mt-0.5">Set <code className="text-gray-300 font-mono text-xs">OLLAMA_HOST</code> so Ollama listens on a different port:</p>
                    <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mt-2">
{`# macOS (Ollama desktop app — most common)
launchctl setenv OLLAMA_HOST 127.0.0.1:11435
# Quit Ollama from menu bar, then reopen it.
# Verify: curl -s http://127.0.0.1:11435/api/version

# macOS (Ollama via launchd service — if you have a plist)
# Edit ~/Library/LaunchAgents/com.ollama.startup.plist
# Add EnvironmentVariables with OLLAMA_HOST=127.0.0.1:11435
# Then: launchctl unload / load the plist

# Linux (systemd)
sudo systemctl edit ollama
# Add under [Service]:
#   Environment="OLLAMA_HOST=127.0.0.1:11435"
sudo systemctl restart ollama`}
                    </pre>
                  </div>
                </div>
                <div className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-[10px] font-bold text-purple-400">2</span>
                  <div>
                    <p className="text-sm text-white font-medium">Enable the proxy in Wicklee config</p>
                    <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mt-2">
{`# Open the config:
# macOS: sudo nano "/Library/Application Support/Wicklee/config.toml"
# Linux: sudo nano /etc/wicklee/config.toml

# Add at the bottom:
[ollama_proxy]
enabled     = true
ollama_port = 11435   # port where Ollama now listens`}
                    </pre>
                  </div>
                </div>
                <div className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-[10px] font-bold text-purple-400">3</span>
                  <div>
                    <p className="text-sm text-white font-medium">Restart the Wicklee agent</p>
                    <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mt-2">
{`curl -fsSL https://wicklee.dev/install.sh | bash
# or manually:
# macOS: sudo launchctl kickstart -k system/dev.wicklee.agent
# Linux: sudo systemctl restart wicklee`}
                    </pre>
                    <p className="mt-1">Verify the proxy is active — your dashboard will show <code className="text-gray-300 font-mono text-xs">proxy: :11434 → :11435</code> in the Diagnostics rail.</p>
                  </div>
                </div>
              </div>
            </div>

            <NoteBox>
              <strong className="text-gray-300">Tier note:</strong> The proxy works locally on all tiers (Community included). Proxy-derived metrics (E2E latency, request count, production tok/s) are visible in the fleet dashboard for <strong className="text-gray-300">Pro tier and above</strong>.
            </NoteBox>

            <div>
              <p className="font-semibold text-white mb-2">Why Ollama only?</p>
              <p>vLLM already exposes production latency histograms natively via its <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">/metrics</code> Prometheus endpoint — no proxy needed. Ollama doesn't expose request-level timing, so the proxy fills that gap.</p>
            </div>
          </Section>

          {/* ── OTel & Prometheus ── */}
          <Section
            id="otel"
            icon={<BarChart2 className="w-5 h-5" />}
            accent="border-amber-500/20"
            title="OpenTelemetry & Prometheus"
          >
            <p>Export fleet telemetry to enterprise observability platforms. <strong className="text-white">Team tier required.</strong></p>

            <div>
              <p className="font-semibold text-white mb-2">OpenTelemetry Export</p>
              <p>The cloud backend pushes OTLP JSON metrics to any OpenTelemetry-compatible collector (Datadog, Grafana Cloud, New Relic). Configure in <strong className="text-white">Settings → OpenTelemetry Export</strong>.</p>
              <p className="mt-2">8 gauges per node: <code>wicklee.gpu.utilization</code>, <code>wicklee.power.watts</code>, <code>wicklee.inference.tokens_per_second</code>, <code>wicklee.wes.score</code>, <code>wicklee.thermal.penalty</code>, <code>wicklee.memory.pressure</code>, <code>wicklee.inference.ttft_ms</code>, <code>wicklee.inference.state</code></p>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Prometheus Endpoint</p>
              <p>Pull-based scrape endpoint at <code>GET /metrics</code> with X-API-Key authentication. Returns standard Prometheus text format with the same 7 gauges, labeled by node_id and hostname.</p>
              <pre className="bg-gray-900 rounded-lg p-3 text-xs font-mono overflow-x-auto mt-2">
{`curl -H "X-API-Key: wk_live_..." https://wicklee.dev/metrics`}
              </pre>
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
                  ['kWh rate', 'Local electricity rate (default $0.12/kWh). Used to calculate Cost/Day and Cost/1K TKN.'],
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
              <p className="font-semibold text-white mb-2">Tiers &amp; fleet limits</p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Tier</Th>
                      <Th>Fleet nodes</Th>
                      <Th>Cloud history</Th>
                      <Th>Alerts</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <Td><span className="text-gray-300 font-medium">Community</span></Td>
                      <Td>3 nodes</Td>
                      <Td>24h rolling</Td>
                      <Td>—</Td>
                    </tr>
                    <tr>
                      <Td><span className="text-blue-400 font-medium">Pro ($9/mo)</span></Td>
                      <Td>10 nodes</Td>
                      <Td>7-day history</Td>
                      <Td>Slack (1 channel)</Td>
                    </tr>
                    <tr>
                      <Td><span className="text-amber-400 font-medium">Team ($19/seat/mo)</span></Td>
                      <Td>25 nodes (expandable +50 at $50/mo)</Td>
                      <Td>90-day history (Postgres rollups)</Td>
                      <Td>Slack + PagerDuty + CSV/JSON export</Td>
                    </tr>
                    <tr>
                      <Td><span className="text-purple-400 font-medium">Enterprise</span></Td>
                      <Td>Unlimited</Td>
                      <Td>Configurable + signed export</Td>
                      <Td>All + SIEM integration</Td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                All tiers include the full localhost dashboard (1h DuckDB history), Agent API, and sovereign hardware patterns. The local agent stores metric history in DuckDB; the cloud uses Postgres — independent stores for different roles.
              </p>
            </div>

            <p>For optional production-grade inference metrics, see the <a href="#proxy" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">Inline Proxy</a> section.</p>
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
              <p className="font-semibold text-white mb-3">Agent sampling cadence</p>
              <p className="text-xs text-gray-500 mb-2">Everything the agent does on your machine, how often, and why.</p>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[10px] text-gray-500 uppercase tracking-widest border-b border-gray-800">
                    <th className="pb-2 pr-4">Subsystem</th>
                    <th className="pb-2 pr-4">Cadence</th>
                    <th className="pb-2 pr-4">What it reads</th>
                    <th className="pb-2">Impact</th>
                  </tr>
                </thead>
                <tbody className="text-xs divide-y divide-gray-800/50">
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">Broadcast loop</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">1 Hz</td>
                    <td className="py-2 pr-4 text-gray-400">Assembles latest snapshot from all harvesters, pushes to SSE/WebSocket</td>
                    <td className="py-2 text-gray-500">Negligible — single JSON serialize per tick</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">System metrics (CPU, memory, swap)</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">1 Hz</td>
                    <td className="py-2 pr-4 text-gray-400">sysinfo crate — /proc/stat, /proc/meminfo (Linux), IOKit (macOS), WMI (Windows)</td>
                    <td className="py-2 text-gray-500">Sub-millisecond reads</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">Apple Silicon power</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">5s window</td>
                    <td className="py-2 pr-4 text-gray-400"><code className="text-gray-400 font-mono">powermetrics --samplers cpu_power,gpu_power</code> — requires root</td>
                    <td className="py-2 text-gray-500">Low — runs as a background subprocess</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">NVIDIA GPU</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">1 Hz</td>
                    <td className="py-2 pr-4 text-gray-400">NVML API — utilization, temperature, power, VRAM, clocks, PCIe, throttle reason</td>
                    <td className="py-2 text-gray-500">Zero-privilege NVML calls, &lt; 1ms</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">Ollama harvester</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">2s</td>
                    <td className="py-2 pr-4 text-gray-400"><code className="text-gray-400 font-mono">GET /api/ps</code> — loaded models, VRAM usage, expires_at for inference attribution</td>
                    <td className="py-2 text-gray-500">Lightweight HTTP GET to localhost</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">Ollama probe</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">~30s</td>
                    <td className="py-2 pr-4 text-gray-400">20-token <code className="text-gray-400 font-mono">POST /api/generate</code> — measures tok/s, TTFT, prefill speed, load duration. <strong className="text-gray-300">Disabled when proxy is active.</strong></td>
                    <td className="py-2 text-gray-500">Brief GPU spike (~0.5s). The <code className="text-gray-400 font-mono">probe_caused_next_reset</code> flag prevents the probe from being counted as user inference.</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">vLLM harvester</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">2s</td>
                    <td className="py-2 pr-4 text-gray-400"><code className="text-gray-400 font-mono">GET /metrics</code> — Prometheus gauges (requests running/waiting, KV cache) and histograms (TTFT, E2E latency, queue time)</td>
                    <td className="py-2 text-gray-500">Lightweight HTTP GET to localhost</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">WES thermal sampler</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">2s</td>
                    <td className="py-2 pr-4 text-gray-400">Reads thermal state from NVML/IOKit/hwmon/sysfs/WMI. 30-sample rolling window for penalty averaging.</td>
                    <td className="py-2 text-gray-500">Reuses data from GPU/system harvesters</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">DuckDB local store</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">2s</td>
                    <td className="py-2 pr-4 text-gray-400">Writes tok/s, GPU%, power, memory, swap, TTFT to local metrics_raw table (1-hour buffer)</td>
                    <td className="py-2 text-gray-500">Low — batch INSERT, WAL mode</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-gray-300">Cloud telemetry push</td>
                    <td className="py-2 pr-4 text-gray-400 font-mono">2s</td>
                    <td className="py-2 pr-4 text-gray-400">POST to fleet URL with full MetricsPayload. State-change bypass: immediate push on inference state transitions.</td>
                    <td className="py-2 text-gray-500">~2 KB per push. Only when paired.</td>
                  </tr>
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
                  <tr><td className="py-2 pr-4 text-gray-300">Ollama probe</td><td className="py-2 pr-4 text-gray-500 font-mono text-xs">localhost:11434</td><td className="py-2 text-gray-400">Local only — 20-token throughput sample every ~30s</td></tr>
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
