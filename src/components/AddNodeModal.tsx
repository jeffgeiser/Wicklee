import React, { useState, useRef, useEffect } from 'react';
import { X, CloudLightning, AlertCircle, CheckCircle2, Copy, Check, ArrowRight, Terminal } from 'lucide-react';
import { useAuth } from '@clerk/clerk-react';

interface AddNodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNodeAdded: () => void;
  cloudUrl: string;
}

// Build-time flag — AddNodeModal is cloud-only; agent builds never need it.
const IS_AGENT = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

// ── Inline copy button ────────────────────────────────────────────────────────
const CopyBtn: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="p-1.5 text-gray-600 hover:text-white transition-colors shrink-0"
      title="Copy"
    >
      {copied
        ? <Check className="w-3.5 h-3.5 text-green-400" />
        : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

// ── Code row: comment + copyable command ──────────────────────────────────────
const CmdRow: React.FC<{ cmd: string; comment?: string }> = ({ cmd, comment }) => (
  <div className="flex items-start justify-between gap-2">
    <div className="min-w-0">
      {comment && <p className="text-[10px] text-gray-600 font-mono mb-0.5">{comment}</p>}
      <p className="text-sm font-mono text-gray-100 break-all leading-snug">{cmd}</p>
    </div>
    <CopyBtn text={cmd} />
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────

const AddNodeModal: React.FC<AddNodeModalProps> = ({ isOpen, onClose, onNodeAdded, cloudUrl }) => {
  // All hooks declared unconditionally (IS_AGENT early return is after hooks).
  const [step, setStep]     = useState(1);
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Reset wizard state each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setDigits(['', '', '', '', '', '']);
      setError('');
      setLoading(false);
      setSuccess(false);
    }
  }, [isOpen]);

  // In agent builds ClerkProvider is absent — bail before calling useAuth().
  if (IS_AGENT) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { getToken } = useAuth();

  if (!isOpen) return null;

  const code = digits.join('');

  const handleDigit = (index: number, value: string) => {
    const char = value.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = char;
    setDigits(next);
    setError('');
    if (char && index < 5) inputRefs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    setError('');
    inputRefs.current[Math.min(pasted.length, 5)]?.focus();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) { setError('Please enter the full 6-digit code from your node.'); return; }
    setLoading(true);
    setError('');
    try {
      const token = await getToken();
      const res = await fetch(`${cloudUrl}/api/pair/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        // Parse server message opportunistically — non-JSON bodies (nginx error pages, etc.)
        // must not throw here and fall through to the generic catch.
        let serverMsg: string | undefined;
        try { serverMsg = (await res.json() as { error?: string }).error; } catch { /* non-JSON body */ }
        const retryAfter = res.headers.get('Retry-After');
        setError(
          res.status === 429 ? `Too many attempts — try again in ${retryAfter ?? '60'}s.` :
          res.status === 401 ? 'Session expired. Sign out and sign back in to continue.' :
          res.status === 402 ? 'Node limit reached. Upgrade to Wicklee Pro to pair unlimited nodes.' :
          res.status >= 500  ? 'Wicklee is temporarily unavailable. Please try again shortly.' :
          (serverMsg ?? 'Pairing failed. Check the code and try again.')
        );
        return;
      }
      setSuccess(true);
      setTimeout(() => { onNodeAdded(); onClose(); }, 1500);
    } catch (err) {
      // TypeError = network failure (fetch couldn't connect); anything else = Clerk / runtime error.
      setError(
        err instanceof TypeError
          ? 'Cannot reach the Wicklee backend. Check your connection and try again.'
          : 'Authentication error. Sign out and sign back in to continue.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-gray-900 border border-gray-700 w-full max-w-md rounded-[28px] overflow-hidden shadow-2xl shadow-blue-500/10 animate-in zoom-in-95 duration-200">
        <div className="p-8">

          {/* Header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-white">Add a Node</h2>
              <p className="text-xs text-gray-600 mt-0.5">macOS &amp; Linux</p>
            </div>
            <button onClick={onClose} className="p-2 text-gray-500 hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* ── Step 0 — Choice: have code or need setup ────────────────── */}
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-gray-400">
                Connect a node running the Wicklee agent to your fleet dashboard.
              </p>

              {/* Option A: I have a code */}
              <button
                type="button"
                onClick={() => setStep(3)}
                className="w-full text-left p-4 bg-blue-600/10 border border-blue-500/30 rounded-2xl hover:bg-blue-600/15 hover:border-blue-500/40 transition-all group"
              >
                <div className="flex items-center gap-3">
                  <CloudLightning className="w-5 h-5 text-blue-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white">I have a pairing code</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      The agent is already running and I have the 6-digit code from my local dashboard.
                    </p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-gray-600 group-hover:text-blue-400 transition-colors shrink-0" />
                </div>
              </button>

              {/* Option B: Need setup help */}
              <button
                type="button"
                onClick={() => setStep(2)}
                className="w-full text-left p-4 bg-gray-700/40 border border-gray-700/50 rounded-2xl hover:bg-gray-700/60 hover:border-gray-700 transition-all group"
              >
                <div className="flex items-center gap-3">
                  <Terminal className="w-5 h-5 text-gray-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white">I need to set up the agent first</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Walk me through installing and starting the agent on a new machine.
                    </p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors shrink-0" />
                </div>
              </button>
            </div>
          )}

          {/* ── Step 2 — Setup guide (install + get code) ──────────────────── */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-1">
                <Terminal className="w-4 h-4 text-indigo-400 shrink-0" />
                <h3 className="text-sm font-semibold text-white">Agent Setup</h3>
              </div>

              {/* Install command */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
                <CmdRow
                  comment="# 1. Install the agent on the machine you want to monitor"
                  cmd="curl -fsSL https://wicklee.dev/install.sh | bash"
                />
              </div>

              {/* Start as service */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3">
                <CmdRow
                  comment="# 2. Start as a service (recommended — auto-starts on boot)"
                  cmd="sudo wicklee --install-service"
                />
              </div>

              {/* Get the code */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  3. Get your pairing code
                </p>
                <p className="text-xs text-gray-500 leading-relaxed">
                  Open{' '}
                  <code className="text-indigo-400 font-mono bg-indigo-500/10 px-1.5 py-0.5 rounded">localhost:7700</code>
                  {' '}on that machine. Click <strong className="text-white">Connect to Fleet</strong> to generate a 6-digit code.
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="flex-1 py-3 border border-gray-700 hover:border-gray-700 text-gray-400 hover:text-white font-medium rounded-2xl transition-all text-sm"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="flex-[2] py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-2xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
                >
                  I have my code
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3 — Enter pairing code ─────────────────────────────────── */}
          {step === 3 && (
            success ? (
              <div className="flex flex-col items-center gap-3 py-6">
                <CheckCircle2 className="w-12 h-12 text-green-400" />
                <p className="text-sm font-semibold text-green-400">Node paired successfully!</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="flex items-center gap-2 mb-3">
                  <CloudLightning className="w-4 h-4 text-indigo-400 shrink-0" />
                  <h3 className="text-sm font-semibold text-white">Enter pairing code</h3>
                </div>

                <p className="text-xs text-gray-500 -mt-2">
                  Enter the 6-digit code shown at{' '}
                  <code className="text-indigo-400 font-mono">localhost:7700</code> on your node.
                </p>

                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">
                    Pairing Code
                  </label>
                  <div className="flex gap-2 justify-center" onPaste={handlePaste}>
                    {digits.map((d, i) => (
                      <input
                        key={i}
                        ref={el => { inputRefs.current[i] = el; }}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={d}
                        autoFocus={i === 0}
                        onChange={e => handleDigit(i, e.target.value)}
                        onKeyDown={e => handleKeyDown(i, e)}
                        className="w-11 h-14 text-center text-2xl font-bold font-mono bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-colors"
                      />
                    ))}
                  </div>
                </div>

                {error && (
                  <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-red-400">{error}</p>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="flex-1 py-3 border border-gray-700 hover:border-gray-700 text-gray-400 hover:text-white font-medium rounded-2xl transition-all text-sm"
                  >
                    ← Back
                  </button>
                  <button
                    type="submit"
                    disabled={loading || code.length !== 6}
                    className="flex-[2] py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
                  >
                    <CloudLightning className="w-4 h-4" />
                    {loading ? 'Pairing…' : 'Pair Node'}
                  </button>
                </div>
              </form>
            )
          )}

        </div>
      </div>
    </div>
  );
};

export default AddNodeModal;
