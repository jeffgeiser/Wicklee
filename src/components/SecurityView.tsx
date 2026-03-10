
import React, { useState } from 'react';
import { Shield, Key, Smartphone, LogOut, ChevronRight, Monitor, Laptop, ExternalLink, Lock, CheckCircle2, AlertCircle, Loader2, Eye, EyeOff, BarChart3, Cloud, CloudLightning } from 'lucide-react';
import { PairingInfo } from '../types';

interface SecurityViewProps {
  byokMode: boolean;
  setByokMode: (mode: boolean) => void;
  userApiKey: string;
  setUserApiKey: (key: string) => void;
  pairingInfo?: PairingInfo | null;
  onOpenPairing?: () => void;
  onGenerateCode?: () => void;
  onDisconnect?: () => void;
}

const SecurityView: React.FC<SecurityViewProps> = ({ byokMode, setByokMode, userApiKey, setUserApiKey, pairingInfo, onOpenPairing, onGenerateCode, onDisconnect }) => {
  const [isValidating, setIsValidating] = useState(false);
  const [validationStatus, setValidationStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [showKey, setShowKey] = useState(false);

  const validateKey = async () => {
    if (!userApiKey) return;
    setIsValidating(true);
    setValidationStatus('idle');
    try {
      // Test connection by listing available models from the Ollama endpoint
      const response = await fetch(`${userApiKey}/api/tags`);
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      setValidationStatus('success');
    } catch (error) {
      console.error(error);
      setValidationStatus('error');
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-white">Account Security</h1>
        <p className="text-gray-500">Manage your authentication methods, passwords, and active sessions.</p>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {/* BYOK Section */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-glow">
          <div className="p-6 border-b border-gray-800 flex items-center justify-between bg-gradient-to-r from-blue-600/5 to-transparent">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-600/10 rounded-lg"><Key className="w-5 h-5 text-cyan-400" /></div>
              <div>
                <h3 className="font-bold text-white">Local Intelligence Configuration</h3>
                <p className="text-xs text-gray-500">Choose between Wicklee-Hosted or your own Local Model instance.</p>
              </div>
            </div>
            <div className="flex items-center bg-gray-800 p-1 rounded-xl border border-gray-700">
              <button 
                onClick={() => setByokMode(false)}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all ${!byokMode ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Wicklee-Hosted
              </button>
              <button 
                onClick={() => setByokMode(true)}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all ${byokMode ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Local Instance
              </button>
            </div>
          </div>

          <div className="p-6 space-y-6">
            {byokMode ? (
              <div className="space-y-6 animate-in slide-in-from-top-2 duration-300">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Ollama Endpoint (Base URL)</label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input 
                        type="text"
                        value={userApiKey}
                        onChange={(e) => {
                          setUserApiKey(e.target.value);
                          setValidationStatus('idle');
                        }}
                        placeholder="e.g., http://localhost:11434"
                        className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-3 text-sm text-gray-200 focus:outline-none focus:border-blue-600 transition-colors"
                      />
                    </div>
                    <button 
                      onClick={validateKey}
                      disabled={isValidating || !userApiKey}
                      className="px-4 py-3 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-all flex items-center gap-2 border border-gray-700"
                    >
                      {isValidating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                      Test Connection
                    </button>
                  </div>
                  {validationStatus === 'success' && (
                    <p className="text-[10px] text-green-400 flex items-center gap-1 mt-1">
                      <CheckCircle2 className="w-3 h-3" /> Connection established. Local model ready.
                    </p>
                  )}
                  {validationStatus === 'error' && (
                    <p className="text-[10px] text-red-400 flex items-center gap-1 mt-1">
                      <AlertCircle className="w-3 h-3" /> Connection failed. Please ensure Ollama is running.
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 bg-blue-600/5 border border-blue-500/10 rounded-xl space-y-2">
                    <div className="flex items-center gap-2 text-cyan-400">
                      <BarChart3 className="w-4 h-4" />
                      <h4 className="text-xs font-bold uppercase tracking-wider">Sovereign Inference</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      In Local Instance mode, all inference happens on your hardware. No data is sent to external APIs or Wicklee servers.
                    </p>
                    <a 
                      href="https://ollama.com" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[10px] font-bold text-blue-600 hover:text-blue-500 transition-colors"
                    >
                      Ollama Documentation <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>

                  <div className="p-4 bg-gray-950 border border-gray-800 rounded-xl space-y-2">
                    <div className="flex items-center gap-2 text-gray-400">
                      <Lock className="w-4 h-4" />
                      <h4 className="text-xs font-bold uppercase tracking-wider">Security Disclosure</h4>
                    </div>
                    <p className="text-[10px] text-gray-500 leading-relaxed">
                      Your API key is encrypted at rest and stored securely in your browser's local storage. It is never exposed to client-side logs or sent to Wicklee's telemetry servers.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-8 border border-dashed border-gray-800 rounded-2xl flex flex-col items-center text-center space-y-3">
                <div className="p-3 bg-gray-800 rounded-full text-gray-500"><Shield className="w-6 h-6" /></div>
                <div>
                  <h4 className="text-sm font-bold text-gray-300">Wicklee-Hosted Mode Active</h4>
                  <p className="text-xs text-gray-500 max-w-xs mx-auto">
                    You are currently using Wicklee's shared infrastructure. No configuration is required.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        {/* Fleet Connection section */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-gray-800 flex items-center justify-between bg-gradient-to-r from-indigo-600/5 to-transparent">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-600/10 rounded-lg">
                {pairingInfo?.status === 'connected'
                  ? <CloudLightning className="w-5 h-5 text-green-400" />
                  : <Cloud className="w-5 h-5 text-indigo-400" />}
              </div>
              <div>
                <h3 className="font-bold text-white">Fleet Connection</h3>
                <p className="text-xs text-gray-500">Persistent node identity and fleet pairing.</p>
              </div>
            </div>
            <span className={`px-3 py-1 text-[10px] font-bold uppercase rounded-full border tracking-widest ${
              pairingInfo?.status === 'connected'
                ? 'bg-green-500/10 text-green-400 border-green-500/20'
                : pairingInfo?.status === 'pending'
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  : 'bg-gray-500/10 text-gray-400 border-gray-500/20'
            }`}>
              {pairingInfo?.status === 'connected' ? 'Connected' : pairingInfo?.status === 'pending' ? 'Pairing' : 'Sovereign'}
            </span>
          </div>
          <div className="p-6 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500">Node Identity</span>
              <span className="font-telin text-indigo-400">{pairingInfo?.node_id ?? '—'}</span>
            </div>
            <div className="flex items-start justify-between text-sm gap-4">
              <span className="text-gray-500 shrink-0">Status</span>
              <span className="text-gray-300 text-right font-telin text-xs">
                {pairingInfo?.status === 'connected'
                  ? pairingInfo.fleet_url
                  : pairingInfo?.status === 'pending'
                    ? `Code: ${pairingInfo.code} · ${Math.max(0, Math.floor(((pairingInfo.expires_at ?? 0) - Date.now()) / 1000))}s remaining`
                    : 'Unpaired'}
              </span>
            </div>
            <div className="flex gap-3 pt-2">
              {(!pairingInfo || pairingInfo.status === 'unpaired') && (
                <button
                  onClick={onGenerateCode}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition-all"
                >
                  Generate Pairing Code
                </button>
              )}
              {pairingInfo?.status === 'pending' && (
                <>
                  <button
                    onClick={onOpenPairing}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition-all"
                  >
                    View Code
                  </button>
                  <button
                    onClick={onDisconnect}
                    className="px-4 py-2 border border-gray-700 hover:border-gray-600 text-gray-400 hover:text-gray-200 text-xs font-medium rounded-xl transition-all"
                  >
                    Cancel
                  </button>
                </>
              )}
              {pairingInfo?.status === 'connected' && (
                <button
                  onClick={onDisconnect}
                  className="px-4 py-2 border border-red-500/30 hover:border-red-500/60 text-red-400 hover:text-red-300 text-xs font-medium rounded-xl transition-all"
                >
                  Disconnect — Return to Sovereign Mode
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-600/10 rounded-lg"><Smartphone className="w-5 h-5 text-cyan-400" /></div>
              <div>
                <h3 className="font-bold text-white">Two-Factor Authentication</h3>
                <p className="text-xs text-gray-500">Add an extra layer of security to your account.</p>
              </div>
            </div>
            <span className="px-3 py-1 bg-green-500/10 text-green-500 text-[10px] font-bold uppercase rounded-full border border-green-500/20 tracking-widest">
              Enabled
            </span>
          </div>
          <div className="p-6 space-y-4">
            <button className="w-full flex items-center justify-between p-4 bg-gray-800/30 hover:bg-gray-800/50 border border-gray-800 rounded-xl transition-all group">
              <div className="flex items-center gap-3">
                <Shield className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-medium text-gray-300">Authenticator App (TOTP)</span>
              </div>
              <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-300" />
            </button>
            <button className="w-full flex items-center justify-between p-4 bg-gray-800/30 hover:bg-gray-800/50 border border-gray-800 rounded-xl transition-all group">
              <div className="flex items-center gap-3">
                <Key className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-medium text-gray-300">Change Account Password</span>
              </div>
              <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-300" />
            </button>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-gray-800">
            <h3 className="font-bold text-white">Active Sessions</h3>
            <p className="text-xs text-gray-500">Devices currently logged into your account.</p>
          </div>
          <div className="divide-y divide-gray-800">
            {[
              { device: 'MacBook Pro 16"', location: 'San Francisco, US', active: 'Current Session', icon: Laptop },
              { device: 'iPhone 15 Pro', location: 'Palo Alto, US', active: '2 hours ago', icon: Smartphone },
              { device: 'Linux Workstation', location: 'Seattle, US', active: '1 day ago', icon: Monitor }
            ].map((session, i) => (
              <div key={i} className="p-6 flex items-center justify-between hover:bg-gray-800/20 transition-colors">
                <div className="flex items-center gap-4">
                  <div className="p-2 bg-gray-800 rounded-lg text-gray-400"><session.icon className="w-5 h-5" /></div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-200">{session.device}</h4>
                    <p className="text-xs text-gray-500">{session.location} • {session.active}</p>
                  </div>
                </div>
                {i > 0 && (
                  <button className="p-2 text-gray-500 hover:text-red-400 transition-colors">
                    <LogOut className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="p-4 bg-gray-950/50 border-t border-gray-800 text-center">
            <button className="text-xs font-bold text-red-400 hover:text-red-300">Sign Out of All Devices</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SecurityView;
