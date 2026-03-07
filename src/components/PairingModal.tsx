import React, { useState, useEffect } from 'react';
import { X, Cloud, CloudLightning, Copy, CheckCheck, RefreshCw } from 'lucide-react';
import { PairingInfo } from '../types';

interface PairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  pairingInfo: PairingInfo | null;
  onGenerate: () => void;
  onDisconnect: () => void;
}

const PairingModal: React.FC<PairingModalProps> = ({ isOpen, onClose, pairingInfo, onGenerate, onDisconnect }) => {
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (pairingInfo?.status !== 'pending' || !pairingInfo.expires_at) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => {
      const diff = Math.max(0, Math.floor((pairingInfo.expires_at! - Date.now()) / 1000));
      setSecondsLeft(diff);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pairingInfo?.status, pairingInfo?.expires_at]);

  if (!isOpen) return null;

  const handleCopy = () => {
    if (pairingInfo?.code) {
      navigator.clipboard.writeText(pairingInfo.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const formatCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
      <div className="bg-zinc-950 border border-zinc-800 w-full max-w-md rounded-[32px] overflow-hidden shadow-2xl shadow-indigo-500/10 animate-in zoom-in-95 duration-300">
        <div className="relative p-8 space-y-6">
          <button onClick={onClose} className="absolute top-6 right-6 p-2 text-gray-500 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>

          {/* ── Unpaired ── */}
          {(!pairingInfo || pairingInfo.status === 'unpaired') && (
            <div className="space-y-6 text-center">
              <div className="w-16 h-16 bg-indigo-600/20 rounded-2xl border border-indigo-500/30 flex items-center justify-center mx-auto">
                <Cloud className="w-8 h-8 text-indigo-400" />
              </div>
              <div className="space-y-1">
                <h2 className="text-xl font-bold text-white">Connect to Fleet</h2>
                <p className="text-gray-400 text-sm">
                  Link this node to your Wicklee fleet at wicklee.dev.
                </p>
              </div>
              {pairingInfo?.node_id && (
                <p className="text-[11px] font-mono text-gray-500 bg-zinc-900 rounded-lg py-2">
                  Node Identity: <span className="text-indigo-400">{pairingInfo.node_id}</span>
                </p>
              )}
              <button
                onClick={onGenerate}
                className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-2xl transition-all shadow-lg shadow-indigo-500/20"
              >
                Generate Pairing Code
              </button>
              <p className="text-[10px] text-gray-600">Your node data stays local until connected</p>
            </div>
          )}

          {/* ── Pending ── */}
          {pairingInfo?.status === 'pending' && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <div className="relative w-10 h-10 flex items-center justify-center">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-30" />
                  <Cloud className="w-6 h-6 text-amber-400 relative" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">Pairing in Progress</h2>
                  <p className="text-[11px] font-mono text-gray-500">
                    Node: <span className="text-indigo-400">{pairingInfo.node_id}</span>
                  </p>
                </div>
              </div>

              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-3 text-center">
                <p className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">Pairing Code</p>
                <div className="flex items-center justify-center gap-3">
                  <span className="text-5xl font-mono font-bold text-white tracking-[0.4em]">
                    {formatCode(pairingInfo.code ?? '')}
                  </span>
                  <button onClick={handleCopy} className="p-2 text-gray-500 hover:text-white transition-colors">
                    {copied ? <CheckCheck className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <p className={`text-sm font-mono ${secondsLeft < 60 ? 'text-red-400' : 'text-gray-400'}`}>
                  Expires in {formatTime(secondsLeft)}
                </p>
              </div>

              <p className="text-center text-[13px] text-indigo-400 font-medium">
                Enter this code at wicklee.dev → Fleet → Add Node
              </p>

              {/* QR placeholder */}
              <div className="h-28 bg-zinc-900 border border-zinc-800 rounded-xl flex flex-col items-center justify-center gap-1">
                <div className="w-12 h-12 bg-zinc-800 rounded-lg" />
                <span className="text-[10px] text-gray-600">QR Code — Coming Soon</span>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={onGenerate}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 border border-zinc-700 hover:border-zinc-600 text-gray-400 hover:text-white rounded-xl text-sm font-medium transition-all"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Regenerate
                </button>
              </div>
              <p className="text-center text-[10px] text-gray-600">Your node data stays local until connected</p>
            </div>
          )}

          {/* ── Connected ── */}
          {pairingInfo?.status === 'connected' && (
            <div className="space-y-5 text-center">
              <div className="w-16 h-16 bg-green-500/20 rounded-2xl border border-green-500/30 flex items-center justify-center mx-auto">
                <CloudLightning className="w-8 h-8 text-green-400" />
              </div>
              <div className="space-y-1">
                <h2 className="text-xl font-bold text-white">Connected to Fleet</h2>
                <p className="text-[11px] font-mono text-gray-500 break-all">{pairingInfo.fleet_url}</p>
              </div>
              <p className="text-[11px] font-mono text-gray-500 bg-zinc-900 rounded-lg py-2">
                Node Identity: <span className="text-indigo-400">{pairingInfo.node_id}</span>
              </p>
              <button
                onClick={onDisconnect}
                className="w-full py-3 border border-red-500/30 hover:border-red-500/60 text-red-400 hover:text-red-300 font-medium rounded-2xl transition-all text-sm"
              >
                Disconnect — Return to Sovereign Mode
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PairingModal;
