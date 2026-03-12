import React, { useState, useRef } from 'react';
import { X, CloudLightning, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@clerk/clerk-react';

interface AddNodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNodeAdded: () => void;
  cloudUrl: string;
}

// Build-time flag — AddNodeModal is cloud-only; agent builds never need it.
const IS_AGENT = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

const AddNodeModal: React.FC<AddNodeModalProps> = ({ isOpen, onClose, onNodeAdded, cloudUrl }) => {
  // Standard React hooks — always called so hook order is consistent.
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // In agent builds ClerkProvider is absent — bail before calling useAuth().
  // IS_AGENT is a build-time constant so this early return is always taken
  // (agent) or never taken (cloud), keeping hook call count consistent.
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
    if (char && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
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
    const focusIdx = Math.min(pasted.length, 5);
    inputRefs.current[focusIdx]?.focus();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) {
      setError('Please enter the full 6-digit code from your node.');
      return;
    }
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
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Code not found. Make sure the agent is running and try again.');
        return;
      }
      setSuccess(true);
      setTimeout(() => {
        onNodeAdded();
        onClose();
      }, 1500);
    } catch {
      setError('Unable to reach the cloud backend. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-gray-950 border border-gray-800 w-full max-w-sm rounded-[28px] overflow-hidden shadow-2xl shadow-indigo-500/10 animate-in zoom-in-95 duration-200">
        <div className="p-8 space-y-6">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <h2 className="text-xl font-bold text-white">Add Node</h2>
              <p className="text-xs text-gray-500">Enter the 6-digit code shown in your terminal after running <code className="text-indigo-400 font-mono">wicklee --pair</code></p>
            </div>
            <button onClick={onClose} className="p-2 text-gray-500 hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {success ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <CheckCircle2 className="w-12 h-12 text-green-400" />
              <p className="text-sm font-semibold text-green-400">Node paired successfully!</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Pairing Code</label>
                <div className="flex gap-2 justify-center" onPaste={handlePaste}>
                  {digits.map((d, i) => (
                    <input
                      key={i}
                      ref={el => { inputRefs.current[i] = el; }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={d}
                      onChange={e => handleDigit(i, e.target.value)}
                      onKeyDown={e => handleKeyDown(i, e)}
                      className="w-11 h-14 text-center text-2xl font-bold font-mono bg-gray-900 border border-gray-700 rounded-xl text-white focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-colors"
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

              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20"
              >
                <CloudLightning className="w-4 h-4" />
                {loading ? 'Pairing…' : 'Pair Node'}
              </button>

              <p className="text-center text-[11px] text-gray-600">
                Don't have the agent yet?{' '}
                <a href="https://github.com/jeffgeiser/Wicklee#readme" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 transition-colors">
                  Install guide →
                </a>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default AddNodeModal;
