import React, { useState } from 'react';
import { Search, Wrench, ClipboardCheck, Copy, Check, ChevronRight, Terminal, ShieldCheck, Eye, HelpCircle, Ruler } from 'lucide-react';
import Logo from '../components/Logo';
import { perfMark } from '../utils/perfMark';

interface LandingPageProps {
  onNavigate?: (path: string) => void;
}

const labels = [
  {
    icon: Eye,
    tag: 'OBSERVED',
    colour: 'text-cyan-400',
    body: 'A transition, a sample or a receipt Wicklee recorded. Never states a cause.',
  },
  {
    icon: HelpCircle,
    tag: 'INFERRED',
    colour: 'text-yellow-400',
    body: 'A likely explanation, always hedged, and only ever on top of something observed.',
  },
  {
    icon: Ruler,
    tag: 'VERIFIED',
    colour: 'text-emerald-400',
    body: 'Exact per-request measurements, with a median and a range.',
  },
];

const agentCards = [
  {
    title: 'Over MCP',
    body: 'Give your editor or agent three tools: wicklee_state, wicklee_readiness and wicklee_inspect. Same answers the CLI prints.',
    code: `claude mcp add -s user wicklee -- \\
  npx -y mcp-remote http://localhost:7700/mcp`,
  },
  {
    title: 'Over HTTP',
    body: 'Plain JSON on /v1. Ask whether a model can run before you start the job that needs it, then re-check after a change.',
    code: `curl -s localhost:7700/v1/inspect
curl -s "localhost:7700/v1/readiness?model=llama3.1:8b"
curl -s -X POST localhost:7700/v1/verify ...`,
  },
  {
    title: 'Across your machines',
    body: 'Run it on every host that serves models and have your agent ask each one. To reach a node from another machine, bind it to the network with a token; it refuses to start without one.',
    code: `# config.toml on each node
bind_address = "0.0.0.0"
auth_token   = "<long random string>"

for h in gpu-01 gpu-02 gpu-03; do
  curl -s -H "Authorization: Bearer $TOKEN" \\
    "http://$h:7700/v1/readiness?model=llama3.1:8b"
done`,
  },
];

const commands = [
  { cmd: 'wicklee inspect', what: 'Findings, readiness and what to change, in one report' },
  { cmd: 'wicklee ready [MODEL]', what: 'Ready now, requires loading, would displace, or cannot determine' },
  { cmd: 'wicklee findings [--all]', what: 'The findings alone; --all includes resolved ones' },
  { cmd: 'wicklee fingerprint MODEL', what: 'Measure a model and store a baseline. Asks first' },
  { cmd: 'wicklee verify F-xxxxxx', what: "Re-run a finding's own test and compare against the last run" },
];

const inspectOutput = `WHAT IS HAPPENING
  F-7fff93  OBSERVED  qwen3.5:4b was reloaded at the default 4096-token context 4
                      times in the last 5 minutes, dropping from as high as 8192
                      tokens. The load cost of each reload is not measured.
            INFERRED  A caller is likely omitting num_ctx, so each such request
                      silently reloads qwen3.5:4b at the default instead of reusing
                      the resident copy.

  F-e0438f  OBSERVED  3 models were cleared 5 times in the last 7 minutes within 10
                      seconds of another model loading, each before its own
                      keep-alive expired: llama3.1:8b, qwen3.5:4b, qwen3.5:9b.
            INFERRED  Memory contention may be causing the reloads: a load that does
                      not fit clears resident models rather than queueing.

WHICH MODELS CAN RUN SAFELY NOW
  llama3.1:8b     May require eviction: likely clears qwen3.5:4b, which is in
                  use
  qwen3.5:4b      Ready now, in use 7 s ago
  qwen3.5:9b      Requires loading, and fits on a measured footprint

WHAT TO CHANGE
  F-7fff93  Re-measure qwen3.5:4b and compare: wicklee verify F-7fff93
  F-e0438f  Re-measure qwen3.5:9b, qwen3.5:4b, llama3.1:8b and compare:
            wicklee verify F-e0438f`;

const LandingPage: React.FC<LandingPageProps> = ({ onNavigate }) => {
  React.useEffect(() => { perfMark('wk:page-landing'); }, []);
  const [copiedMac, setCopiedMac] = useState(false);
  const [copiedWin, setCopiedWin] = useState(false);

  const go = (path: string) => onNavigate?.(path);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 selection:bg-blue-600 selection:text-white">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] bg-cyan-400/10 blur-[120px] rounded-full"></div>
      </div>

      <nav className="max-w-7xl mx-auto px-4 sm:px-8 py-5 sm:py-8 flex items-center justify-between relative z-10">
        <Logo className="text-3xl" connectionState="connected" />
        <div className="flex items-center gap-4 sm:gap-8">
          <button onClick={() => go('/docs')} className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors">Documentation</button>
          <button onClick={() => go('/blog')} className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors">Blog</button>
          <a
            href="https://github.com/jeffgeiser/Wicklee"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-gray-400 hover:text-white transition-colors"
          >
            GitHub
          </a>
        </div>
      </nav>

      <section className="max-w-5xl mx-auto px-4 sm:px-8 pt-12 sm:pt-20 pb-14 sm:pb-24 text-center relative z-10">
        <p className="text-[11px] sm:text-xs font-bold uppercase tracking-[0.2em] text-cyan-400/80 mb-5">
          Built for agents to ask · Evidence for self-hosted inference
        </p>
        <h1 className="text-4xl sm:text-6xl md:text-7xl font-extrabold tracking-tight text-white mb-6 leading-[1.1]">
          Stop guessing why your{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-cyan-400">
            local AI is slow.
          </span>
        </h1>
        <p className="text-base sm:text-xl text-gray-400 max-w-3xl mx-auto mb-6 leading-relaxed">
          A small agent runs on each machine that serves your models. Your own agents,
          orchestrators and editors ask it over MCP or HTTP what is wrong, what will run
          right now without displacing what is already loaded, and whether a change
          actually helped. You can ask it from the command line too. One binary, over
          localhost. No account.
        </p>
        <div className="flex items-center justify-center mt-10">
          <button
            onClick={() => document.getElementById('install-snippet')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-2xl transition-all shadow-xl shadow-blue-500/30 flex items-center justify-center gap-2 text-lg"
          >
            Install it
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
        <p className="mt-4 text-xs text-gray-600">
          Open source, Apache 2.0 · Nothing leaves the machine · No account · Reads hardware without sudo
        </p>
      </section>

      <section id="install-snippet" className="max-w-3xl mx-auto px-4 sm:px-8 pb-16 sm:pb-28 relative z-10 scroll-mt-20">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 sm:p-6 shadow-2xl relative overflow-hidden">
          <div className="absolute inset-0 bg-blue-500/5 pointer-events-none"></div>
          <div className="relative z-10 space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="font-mono text-sm overflow-x-auto w-full space-y-2 min-w-0">
                <p className="text-zinc-500 whitespace-nowrap"># macOS &amp; Linux &nbsp;<span className="text-green-500/70">— no sudo, installs to ~/.wicklee/bin/</span></p>
                <p className="text-white whitespace-nowrap">curl -fsSL https://wicklee.dev/install.sh | bash</p>
                <p className="text-zinc-500 whitespace-nowrap"># Then: wicklee inspect</p>
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
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 pt-3 border-t border-zinc-800">
              <div className="font-mono text-sm overflow-x-auto w-full space-y-2 min-w-0">
                <p className="text-zinc-500 whitespace-nowrap"># Windows (PowerShell)</p>
                <p className="text-white whitespace-nowrap">irm https://wicklee.dev/install.ps1 | iex</p>
                <p className="text-zinc-500 whitespace-nowrap"># Optional: wicklee --install-service &nbsp;<span className="text-green-500/70">← runs on every boot</span></p>
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

      <section className="max-w-7xl mx-auto px-4 sm:px-8 py-16 sm:py-24 border-t border-gray-800 relative z-10">
        <p className="text-[11px] sm:text-xs font-bold uppercase tracking-[0.2em] text-cyan-400/80 mb-4 text-center">
          Built for agents
        </p>
        <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight text-center mb-4">
          Your agents ask. Every node answers.
        </h2>
        <p className="text-gray-400 text-center max-w-3xl mx-auto mb-14 leading-relaxed">
          Wicklee is built first for software to ask: an orchestrator deciding where a job
          runs, a coding agent about to start a long task, a script checking a host before
          a deploy. Each machine runs its own Wicklee, and each answers the same three
          questions &mdash; what is wrong, what can run right now, did the change help &mdash; as
          structured JSON with the evidence attached, so an agent can act on it without
          scraping a dashboard.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {agentCards.map((c) => (
            <div key={c.title} className="bg-gray-800/40 border border-gray-700/60 rounded-3xl p-7 flex flex-col">
              <h3 className="text-base font-bold text-white mb-2">{c.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed mb-5">{c.body}</p>
              <pre className="mt-auto bg-zinc-950 border border-zinc-800 rounded-xl p-4 overflow-x-auto font-mono text-[11px] leading-relaxed text-gray-300 whitespace-pre">{c.code}</pre>
            </div>
          ))}
        </div>
        <p className="mt-6 text-xs text-gray-500 text-center max-w-3xl mx-auto leading-relaxed">
          Today there is no aggregator and nothing phones home: every node answers for
          itself, and the agent that asks decides what to do with the answers. Wicklee
          publishes evidence; it does not route or schedule. An optional, self-hostable
          coordinator for aggregating across a larger fleet is planned (not started),
          and local use will never require it.
        </p>
      </section>

      <section className="max-w-7xl mx-auto px-4 sm:px-8 py-16 sm:py-24 border-t border-gray-800 relative z-10">
        <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight text-center mb-4">
          Find it, check it, prove it.
        </h2>
        <p className="text-gray-400 text-center max-w-2xl mx-auto mb-14">
          Three questions, in the order you actually hit them. Each one is a command.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[
            {
              icon: Search,
              step: 'Find',
              cmd: 'wicklee inspect',
              body: 'Shows what’s broken and backs it up with evidence. Typical catches include a model quietly reloading at the runtime’s 4096 default context, two models evicting each other before their keep-alive expires, weights spilling out of accelerator memory, or a model running slower than its own baseline. Skipped checks are listed with the reason why.',
            },
            {
              icon: Wrench,
              step: 'Check',
              cmd: 'wicklee ready llama3.1:8b',
              body: 'Run this before starting a job so you don’t hit an OOM or eviction halfway through. You’ll get one of four calls: ready now, needs a load, may need to evict something, or can’t tell. It also breaks down your available memory headroom, where the size estimate came from, and what would get evicted. Note that it doesn’t reserve memory—another process can still grab it before you load.',
            },
            {
              icon: ClipboardCheck,
              step: 'Verify',
              cmd: 'wicklee verify F-7fff93',
              body: 'Re-runs the test behind a finding and compares the runs side by side, including medians, ranges, and config diffs. It only counts as a real change if there are at least three runs on each side, the ranges don’t overlap, and the medians are at least 5% apart. Anything less—like a 1.5% gap on an idle machine—gets dismissed as noise.',
            },
          ].map((s) => (
            <div key={s.step} className="bg-gray-800/40 border border-gray-700/60 rounded-3xl p-7 hover:border-blue-500/40 transition-colors">
              <div className="w-11 h-11 rounded-2xl bg-blue-600/15 border border-blue-500/25 flex items-center justify-center mb-5">
                <s.icon className="w-5 h-5 text-blue-400" />
              </div>
              <h3 className="text-xl font-bold text-white mb-2">{s.step}</h3>
              <p className="font-mono text-xs text-cyan-400 mb-4">$ {s.cmd}</p>
              <p className="text-sm text-gray-400 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-4 sm:px-8 pb-16 sm:pb-28 relative z-10">
        <div className="flex items-center gap-3 mb-5">
          <Terminal className="w-4 h-4 text-gray-500" />
          <p className="text-xs font-bold uppercase tracking-widest text-gray-500">
            wicklee inspect, on a 16 GB M4 Mac mini
          </p>
        </div>
        <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-5 sm:p-7 overflow-x-auto">
          <pre className="font-mono text-[11px] sm:text-xs leading-relaxed text-gray-300 whitespace-pre">{inspectOutput}</pre>
        </div>
        <p className="mt-4 text-xs text-gray-600">
          Real output, two of that run&rsquo;s five findings. The whole transcript, including
          the three left out, is{' '}
          <a
            href="https://github.com/jeffgeiser/Wicklee/blob/main/docs/bench-fault-inject-m4-2026-11-15.json"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
          >
            in the repository
          </a>.
        </p>
      </section>

      <section className="max-w-7xl mx-auto px-4 sm:px-8 py-16 sm:py-24 border-t border-gray-800 relative z-10">
        <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight text-center mb-4">
          Every line says what kind of claim it is.
        </h2>
        <p className="text-gray-400 text-center max-w-2xl mx-auto mb-14">
          The labels are enforced where statements are built, not checked in review. A
          finding whose statements are all inference is never shown at all.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {labels.map((l) => (
            <div key={l.tag} className="bg-gray-800/40 border border-gray-700/60 rounded-3xl p-7">
              <l.icon className={`w-5 h-5 mb-4 ${l.colour}`} />
              <p className={`font-mono text-xs font-bold tracking-widest mb-3 ${l.colour}`}>{l.tag}</p>
              <p className="text-sm text-gray-400 leading-relaxed">{l.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-10 rounded-3xl border border-gray-700/60 bg-gray-800/20 p-7 max-w-3xl mx-auto">
          <p className="text-sm text-gray-400 leading-relaxed">
            <span className="text-white font-bold">Anything it could not check, it lists.</span>{' '}
            A rule with no data to read reports that, with the reason. An empty result
            means every rule ran and found nothing &mdash; which is a real answer, and not
            the same as silence.
          </p>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-4 sm:px-8 pb-16 sm:pb-28 relative z-10">
        <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-3">
          Five commands
        </h2>
        <p className="text-gray-400 mb-8 text-sm">
          Add <code className="font-mono text-xs text-cyan-400">--json</code> to any of
          them for the route&rsquo;s body verbatim. The same answers are on{' '}
          <code className="font-mono text-xs text-cyan-400">/v1</code> over HTTP and
          through three MCP tools, each calling the same function its route calls.
        </p>
        <div className="rounded-3xl border border-gray-700/60 overflow-hidden">
          {commands.map((c, i) => (
            <div
              key={c.cmd}
              className={`flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-6 px-6 py-4 ${i % 2 ? 'bg-gray-800/20' : 'bg-gray-800/40'}`}
            >
              <p className="font-mono text-xs text-cyan-400 sm:w-72 shrink-0">{c.cmd}</p>
              <p className="text-sm text-gray-400">{c.what}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-4">
          <button
            onClick={() => go('/docs')}
            className="px-6 py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold transition-all flex items-center gap-2"
          >
            Read the documentation
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-4 sm:px-8 py-16 sm:py-24 border-t border-gray-800 relative z-10">
        <div className="flex items-center gap-3 mb-5 justify-center">
          <ShieldCheck className="w-5 h-5 text-emerald-400" />
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight text-center">
            What it will not do
          </h2>
        </div>
        <p className="text-gray-400 text-center max-w-2xl mx-auto mb-14">
          Most of these are enforced by the code refusing, not by a setting you have to
          find.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
          {[
            {
              title: 'It never stores your content',
              body: 'The receipt route refuses any payload carrying prompt, response, messages or context, with a 400 naming the field, rather than storing the body minus them. A careless integration fails loudly instead of quietly sending text.',
            },
            {
              title: 'It does not send inference requests without asking',
              body: 'Only fingerprint and verify load models or generate tokens. Both print what they will do and wait for a yes, both are restricted to the local machine, and every request they send is tagged so a measurement never shows up later as the churn it was taken to look for.',
            },
            {
              title: 'It is not in the request path',
              body: 'Passive by default: no proxy, no wrapper, nothing between your application and your runtime. An optional proxy exists if you want exact per-request numbers, and so does a callback route that needs no proxy at all.',
            },
            {
              title: 'It does not route or schedule',
              body: 'Wicklee publishes evidence. It does not decide where a request goes, does not own admissions or reservations, and does not embed a particular controller’s policy. Translating its answers into another system’s schema belongs in that system.',
            },
          ].map((c) => (
            <div key={c.title} className="bg-gray-800/40 border border-gray-700/60 rounded-3xl p-7">
              <h3 className="text-base font-bold text-white mb-3">{c.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-4 sm:px-8 pb-20 sm:pb-32 relative z-10">
        <div className="rounded-[32px] border border-yellow-500/25 bg-yellow-500/[0.03] p-7 sm:p-10">
          <p className="text-xs font-bold text-yellow-400 uppercase tracking-widest mb-4">
            Known wrong, and published
          </p>
          <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4 tracking-tight">
            Readiness is optimistic about eviction.
          </h2>
          <p className="text-sm sm:text-base text-gray-400 leading-relaxed mb-4">
            Six ordered pairs of models on a 16 GB M4, each loaded with the first in use.
            Readiness said the second would fit without displacing anything every time,
            and the runtime evicted the resident model in five of the six. The decisive
            pair coexists at 9.32 GB in one load order and evicts in the other,
            reproducibly &mdash; so eviction there is not a function of total resident
            size, and no safety margin reproduces it.
          </p>
          <p className="text-sm sm:text-base text-gray-400 leading-relaxed mb-6">
            So nothing was patched. Until it is measured on more than one machine, those
            answers carry{' '}
            <code className="font-mono text-xs text-yellow-400">coexistence: &quot;unverified&quot;</code>{' '}
            and say in words that they may still displace something. The method, the raw
            transcripts and the three candidate fixes &mdash; none of them chosen &mdash;
            are all published.
          </p>
          <a
            href="https://github.com/jeffgeiser/Wicklee/blob/main/docs/PHASE1_RESULTS.md"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl border border-yellow-500/40 hover:border-yellow-400 text-yellow-300 hover:text-yellow-200 text-sm font-bold transition-all"
          >
            Read the results
            <ChevronRight className="w-4 h-4" />
          </a>
        </div>
      </section>

      <footer className="border-t border-gray-800 py-16 text-center text-sm text-gray-500">
        <p>&copy; 2026 Wicklee OSS Project. Apache 2.0.</p>
        <div className="flex flex-wrap items-center justify-center gap-6 mt-4">
          <button onClick={() => go('/docs')} className="hover:text-white transition-colors">Documentation</button>
          <button onClick={() => go('/blog')} className="hover:text-white transition-colors">Blog</button>
          <a href="https://github.com/jeffgeiser/Wicklee" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
          <button onClick={() => go('/trust')} className="hover:text-white transition-colors">Trust &amp; Security</button>
          <button onClick={() => go('/terms')} className="hover:text-white transition-colors">Terms</button>
          <button onClick={() => go('/privacy')} className="hover:text-white transition-colors">Privacy</button>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
