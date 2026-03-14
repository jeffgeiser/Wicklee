import React, { useState } from 'react';
import { ArrowLeft, Terminal, Zap, BookOpen, Settings, Cpu, Globe, Copy, Check } from 'lucide-react';
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

const Th: React.FC<{ children: React.ReactNode }> = ({ c: _c, children }) => (
  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider pb-2 pr-6">
    {children}
  </th>
);

const Td: React.FC<{ children: React.ReactNode; mono?: boolean }> = ({ children, mono }) => (
  <td className={`py-2.5 pr-6 text-sm border-b border-gray-800/60 text-gray-300 ${mono ? 'font-mono text-xs' : ''}`}>
    {children}
  </td>
);

// ── Sidebar nav items ─────────────────────────────────────────────────────────

const NAV = [
  { id: 'quickstart',  label: 'Quick Start' },
  { id: 'wes',         label: 'WES Score' },
  { id: 'api',         label: 'Agent API v1' },
  { id: 'config',      label: 'Configuration' },
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

            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">macOS / Linux</p>
              <Code lang="shell">curl -fsSL https://wicklee.dev/install.sh | sh</Code>
            </div>

            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Windows (PowerShell)</p>
              <Code lang="powershell">irm https://wicklee.dev/install.ps1 | iex</Code>
            </div>

            <p>After install, the agent starts automatically. Open <a href="http://localhost:7700" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">localhost:7700</a> in your browser to see your local dashboard.</p>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-white mb-2">Run as a service (optional)</p>
              <Code lang="shell"># macOS / Linux — starts on every boot
wicklee --install-service</Code>
              <Code lang="powershell"># Windows
wicklee --install-service</Code>
            </div>

            <div>
              <p className="font-semibold text-white mb-2">Connect to your fleet dashboard</p>
              <p>To add a node to your hosted fleet at wicklee.dev, generate a 6-digit pairing code from the agent UI and enter it at <span className="text-gray-300">wicklee.dev → Pair a node</span>. No SSH, no firewall changes — the agent initiates the outbound connection.</p>
            </div>
          </Section>

          {/* ── WES Score ── */}
          <Section
            id="wes"
            icon={<Zap className="w-5 h-5" />}
            accent="border-indigo-500/20"
            title="WES — Wicklee Efficiency Score"
          >
            <p>WES is the primary efficiency metric in Wicklee. It measures how many tokens a node generates per watt of board power, adjusted for thermal throttle state.</p>

            <div className="bg-gray-900 border border-indigo-500/20 rounded-xl p-5">
              <p className="text-xs font-bold text-indigo-400 uppercase tracking-wider mb-3">Formula (v2)</p>
              <pre className="font-mono text-sm text-white leading-loose">
{`WES = (tok/s ÷ Watts) × 10 ÷ ThermalPenalty

ThermalPenalty (v2):
  Normal   → 1.00  (no throttle)
  Fair     → 1.25  (light throttle)
  Serious  → 1.75  (active throttle)
  Critical → 2.00  (severe throttle)`}
              </pre>
              <p className="mt-3 text-xs text-gray-500">On NVIDIA hardware, ThermalPenalty is derived from the NVML hardware throttle-reason bitmask rather than inferred from temperature — making it authoritative rather than estimated. Source is tagged <code className="text-gray-300">nvml</code> in the payload.</p>
            </div>

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
          </Section>

          {/* ── Agent API v1 ── */}
          <Section
            id="api"
            icon={<Globe className="w-5 h-5" />}
            accent="border-cyan-500/20"
            title="Agent API v1"
          >
            <p>The Agent API provides machine-readable access to your live fleet. All endpoints return JSON. Authenticate with your API key — create one in the <strong className="text-white">API Keys</strong> tab of your fleet dashboard.</p>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
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

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
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
              <p className="font-semibold text-white mb-2">Ollama transparent proxy (optional)</p>
              <p>Enable the proxy in your <code className="text-gray-300 font-mono text-xs bg-gray-900 px-1.5 py-0.5 rounded">wicklee.toml</code> config to get zero-lag inference detection and exact tok/s from done packets instead of the 30s sampled probe:</p>
              <Code lang="toml">{`[ollama_proxy]
enabled     = true
ollama_port = 11435   # move Ollama here: OLLAMA_HOST=127.0.0.1:11435`}</Code>
            </div>
          </Section>

          {/* ── Platform support ── */}
          <Section
            id="platforms"
            icon={<Cpu className="w-5 h-5" />}
            accent="border-green-500/20"
            title="Platform Support"
          >
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
                    <Td>✅ unified mem</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-white">Linux — NVIDIA</span></Td>
                    <Td>✅ RAPL powercap</Td>
                    <Td>✅ NVML (sudoless)</Td>
                    <Td>✅ sysfs thermal</Td>
                    <Td>✅ NVML</Td>
                  </tr>
                  <tr>
                    <Td><span className="font-medium text-white">Linux — CPU only</span></Td>
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
                  <tr>
                    <Td><span className="font-medium text-white">Inference runtimes</span></Td>
                    <Td colSpan={4}><span className="text-gray-300">Ollama (auto-detect :11434) · vLLM (auto-detect :8000 Prometheus metrics)</span></Td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500">musl Linux builds (e.g. Alpine, older glibc-free servers) run without NVML — GPU metrics fall back gracefully to null.</p>
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
