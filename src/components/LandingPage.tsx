import React from 'react';
import { Cpu, Zap, Activity, Terminal, BrainCircuit, ChevronRight, Lock, Database, Thermometer, Github, Copy } from 'lucide-react';
import Logo from './Logo';

interface LandingPageProps {
  onLogin: () => void;
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

const LandingPage: React.FC<LandingPageProps> = ({ onLogin }) => {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 selection:bg-blue-600 selection:text-white">
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] bg-cyan-400/10 blur-[120px] rounded-full"></div>
      </div>

      {/* Navigation */}
      <nav className="max-w-7xl mx-auto px-4 sm:px-8 py-5 sm:py-8 flex items-center justify-between relative z-10">
        <Logo className="text-3xl" active={true} />
        <div className="flex items-center gap-4 sm:gap-8">
          <a href="#" className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors">Documentation</a>
          <a href="#" className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors">GitHub</a>
          <button
            onClick={onLogin}
            className="px-4 sm:px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20"
          >
            Launch Console
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-5xl mx-auto px-4 sm:px-8 pt-12 sm:pt-20 pb-16 sm:pb-32 text-center relative z-10">
        <h1 className="text-4xl sm:text-6xl md:text-7xl font-extrabold tracking-tight text-white mb-6 leading-[1.1]">
          Your GPU fleet is flying blind. <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-cyan-400">
            Wicklee fixes that in 5 minutes.
          </span>
        </h1>
        <p className="text-base sm:text-xl text-gray-400 max-w-3xl mx-auto mb-10 leading-relaxed">
          Most teams find out a node is thermal throttling from a user complaint — not an alert. Wicklee gives you real-time GPU health, thermal-aware traffic rerouting, and fleet cost visibility in a single binary. Install in 60 seconds. No config required.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
          <button
            onClick={onLogin}
            className="w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-2xl transition-all shadow-xl shadow-blue-500/30 flex items-center justify-center gap-2 text-lg"
          >
            Install Free — 60 seconds
            <ChevronRight className="w-5 h-5" />
          </button>
          <button className="w-full sm:w-auto px-8 py-4 bg-gray-900 border border-gray-800 hover:border-gray-700 text-white font-bold rounded-2xl transition-all text-lg flex items-center justify-center gap-2">
            <Github className="w-5 h-5" />
            View on GitHub →
          </button>
        </div>
      </section>

      {/* Install Command Section */}
      <section className="max-w-3xl mx-auto px-4 sm:px-8 pb-16 sm:pb-32 relative z-10">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 sm:p-6 shadow-2xl relative group overflow-hidden">
          <div className="absolute inset-0 bg-blue-500/5 pointer-events-none"></div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 relative z-10">
            <div className="font-mono text-sm overflow-x-auto w-full space-y-2 min-w-0">
              <p className="text-zinc-500 whitespace-nowrap"># One-line install — works on Linux and macOS</p>
              <p className="text-white whitespace-nowrap">curl -fsSL https://get.wicklee.dev | sh</p>
              <p className="text-zinc-500 whitespace-nowrap"># Then run: wicklee start</p>
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText('curl -fsSL https://get.wicklee.dev | sh');
                const btn = document.getElementById('copy-install-btn');
                if (btn) {
                  const originalText = btn.innerHTML;
                  btn.innerHTML = '<span class="text-green-400 flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg> Copied!</span>';
                  setTimeout(() => {
                    btn.innerHTML = originalText;
                  }, 2000);
                }
              }}
              id="copy-install-btn"
              className="shrink-0 self-end sm:self-auto p-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-400 hover:text-white transition-all flex items-center gap-2 text-xs font-bold whitespace-nowrap"
            >
              <Copy className="w-4 h-4" />
              Copy
            </button>
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
            title="Protect your hardware"
            description="Sentinel monitors thermal thresholds and reroutes traffic before nodes overheat — automatically, while you sleep."
          />
          <FeatureCard 
            icon={Terminal}
            title="Understand your costs"
            description="Wattage-per-Token shows you the true cost of local inference. Most teams have never seen this number before."
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
                    <p className="text-gray-500 leading-relaxed">Thermal thresholds, auto-rerouting, and Slack alerts out of the box. Protect your GPUs while you sleep.</p>
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
        <p>&copy; 2024 Wicklee OSS Project. All rights reserved.</p>
        <div className="flex items-center justify-center gap-6 mt-4">
          <a href="#" className="hover:text-white transition-colors">Documentation</a>
          <a href="#" className="hover:text-white transition-colors">Terms</a>
          <a href="#" className="hover:text-white transition-colors">Privacy</a>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;