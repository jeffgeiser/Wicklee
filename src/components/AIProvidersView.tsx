import React, { useState } from 'react';
import { BrainCircuit, Shield, Globe, Server, Key, Zap, Check, AlertCircle, RefreshCw, Terminal, Cpu } from 'lucide-react';

interface Provider {
  id: string;
  name: string;
  icon: React.ElementType;
  status: 'connected' | 'disconnected' | 'error';
  latency?: number;
  type: 'cloud' | 'on-prem';
}

const AIProvidersView: React.FC = () => {
  const [activeProvider, setActiveProvider] = useState<string>('on-prem');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  const providers: Provider[] = [
    { id: 'on-prem', name: 'On-Prem (Ollama/vLLM)', icon: Server, status: 'connected', latency: 12, type: 'on-prem' },
    { id: 'gemini', name: 'Google Gemini', icon: BrainCircuit, status: 'connected', latency: 240, type: 'cloud' },
    { id: 'claude', name: 'Anthropic Claude', icon: Shield, status: 'connected', latency: 310, type: 'cloud' },
    { id: 'openai', name: 'OpenAI GPT', icon: Zap, status: 'disconnected', type: 'cloud' },
    { id: 'deepseek', name: 'DeepSeek', icon: Globe, status: 'error', type: 'cloud' },
  ];

  const toggleKeyVisibility = (id: string) => {
    setShowKeys(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-700">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-white">AI Key Vault</h1>
          <p className="text-gray-500">Manage your sovereign AI provider credentials and local inference endpoints.</p>
        </div>
        <div className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          <div className="px-3 py-1.5 text-[10px] font-bold text-cyan-400 uppercase tracking-widest">Vault Status: Encrypted</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {providers.map((provider) => (
          <div 
            key={provider.id}
            onClick={() => setActiveProvider(provider.id)}
            className={`relative p-6 rounded-3xl border transition-all cursor-pointer group ${
              activeProvider === provider.id 
                ? 'bg-zinc-950 border-blue-500/50 shadow-[0_0_30px_rgba(59,130,246,0.15)]' 
                : 'bg-zinc-950 border-zinc-800 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-start justify-between mb-6">
              <div className={`p-3 rounded-2xl border transition-colors ${
                activeProvider === provider.id ? 'bg-blue-600/10 border-blue-500/30' : 'bg-zinc-900 border-zinc-800'
              }`}>
                <provider.icon className={`w-6 h-6 ${activeProvider === provider.id ? 'text-blue-400' : 'text-gray-500'}`} />
              </div>
              
              <div className="flex flex-col items-end gap-2">
                <div className="flex items-center gap-2">
                  {provider.status === 'connected' && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-green-500 uppercase tracking-wider">Connected</span>
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.6)]"></div>
                    </div>
                  )}
                  {provider.status === 'disconnected' && (
                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Disconnected</span>
                  )}
                  {provider.status === 'error' && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">Auth Error</span>
                      <AlertCircle className="w-3 h-3 text-red-500" />
                    </div>
                  )}
                </div>
                {provider.latency && (
                  <span className="text-[10px] font-mono text-gray-500">{provider.latency}ms latency</span>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-bold text-white">{provider.name}</h3>
                <p className="text-xs text-gray-500">{provider.type === 'cloud' ? 'Cloud Provider' : 'Local Infrastructure'}</p>
              </div>

              {provider.type === 'cloud' ? (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">API Key</label>
                    <div className="relative">
                      <input 
                        type={showKeys[provider.id] ? 'text' : 'password'}
                        readOnly
                        value="sk-wicklee-vault-encrypted-token"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2 text-xs text-gray-400 outline-none focus:border-blue-500/50 transition-colors font-mono"
                      />
                      <button 
                        onClick={(e) => { e.stopPropagation(); toggleKeyVisibility(provider.id); }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 transition-colors"
                      >
                        <Key className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Base URL</label>
                    <input 
                      type="text"
                      defaultValue="http://localhost:11434"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2 text-xs text-gray-400 outline-none focus:border-blue-500/50 transition-colors font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Auth Token (Optional)</label>
                    <input 
                      type="password"
                      placeholder="••••••••••••••••"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2 text-xs text-gray-400 outline-none focus:border-blue-500/50 transition-colors font-mono"
                    />
                  </div>
                </div>
              )}

              <div className="pt-2 flex items-center justify-between">
                <button className="text-[10px] font-bold text-blue-400 hover:text-blue-300 transition-colors uppercase tracking-widest flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> Test Connectivity
                </button>
                <button className={`p-2 rounded-lg transition-colors ${
                  activeProvider === provider.id ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-gray-500 hover:bg-zinc-700'
                }`}>
                  <Check className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}

        {/* Add New Provider Card */}
        <div className="p-6 rounded-3xl border border-dashed border-zinc-800 hover:border-zinc-700 transition-all flex flex-col items-center justify-center gap-4 group cursor-pointer bg-zinc-950/50">
          <div className="p-4 bg-zinc-900 rounded-2xl border border-zinc-800 group-hover:scale-110 transition-transform">
            <Terminal className="w-6 h-6 text-gray-600 group-hover:text-blue-400 transition-colors" />
          </div>
          <div className="text-center">
            <h3 className="text-sm font-bold text-gray-400 group-hover:text-gray-200 transition-colors">Add Custom Provider</h3>
            <p className="text-[10px] text-gray-600">Connect any OpenAI-compatible API</p>
          </div>
        </div>
      </div>

      <div className="bg-blue-600/5 border border-blue-500/10 rounded-3xl p-8 flex items-center gap-6">
        <div className="p-4 bg-blue-600/10 rounded-2xl border border-blue-500/20">
          <Cpu className="w-8 h-8 text-blue-400" />
        </div>
        <div className="flex-1">
          <h4 className="text-lg font-bold text-white">Hardware-Accelerated Vault</h4>
          <p className="text-sm text-gray-500 max-w-2xl">
            Wicklee uses hardware-backed encryption (TPM/Secure Enclave) where available to ensure your API keys never leave the sovereign memory space of your orchestrator.
          </p>
        </div>
        <button className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20">
          Vault Settings
        </button>
      </div>
    </div>
  );
};

export default AIProvidersView;
