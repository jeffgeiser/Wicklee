
import React, { useState } from 'react';
import { Key, Plus, Trash2, Eye, EyeOff, Copy, Check } from 'lucide-react';

const APIKeysView: React.FC = () => {
  const [showKey, setShowKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const MOCK_KEYS = [
    { id: '1', name: 'Production Dashboard', key: 'wk_live_72948...81x', created: '2024-03-12', lastUsed: '2m ago' },
    { id: '2', name: 'Local Development', key: 'wk_test_11203...92f', created: '2024-04-01', lastUsed: '14h ago' },
    { id: '3', name: 'GitHub Actions CI', key: 'wk_live_99210...00z', created: '2024-01-20', lastUsed: '3 days ago' },
  ];

  const handleCopy = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-white">API Keys</h1>
          <p className="text-gray-500">Authenticating tokens for interacting with the Wicklee CLI and Orchestrator.</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-all shadow-lg shadow-blue-500/20">
          <Plus className="w-4 h-4" />
          Create New Key
        </button>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-950/50 text-[10px] text-gray-500 uppercase tracking-widest font-bold border-b border-gray-800">
              <th className="px-6 py-4">Key Name</th>
              <th className="px-6 py-4">Token</th>
              <th className="px-6 py-4">Created / Last Used</th>
              <th className="px-6 py-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {MOCK_KEYS.map((key) => (
              <tr key={key.id} className="hover:bg-gray-800/30 transition-colors group">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="p-1.5 bg-gray-800 rounded-lg text-cyan-400"><Key className="w-4 h-4" /></div>
                    <span className="text-sm font-semibold text-gray-200">{key.name}</span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3 font-mono text-xs">
                    <span className="text-gray-500">{showKey === key.id ? key.key : '••••••••••••••••'}</span>
                    <button 
                      onClick={() => setShowKey(showKey === key.id ? null : key.id)}
                      className="text-gray-600 hover:text-gray-300 transition-colors"
                    >
                      {showKey === key.id ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                    <button 
                      onClick={() => handleCopy(key.key)}
                      className="text-gray-600 hover:text-gray-300 transition-colors"
                    >
                      {copied === key.key ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex flex-col text-xs">
                    <span className="text-gray-300">{key.created}</span>
                    <span className="text-gray-500">Used {key.lastUsed}</span>
                  </div>
                </td>
                <td className="px-6 py-4 text-right">
                  <button className="p-2 text-gray-600 hover:text-red-400 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-6 flex items-start gap-4">
        <div className="p-2 bg-amber-500/10 rounded-lg"><Key className="w-5 h-5 text-amber-500" /></div>
        <div className="space-y-1">
          <h4 className="text-sm font-bold text-amber-200 uppercase tracking-wide">Security Warning</h4>
          <p className="text-xs text-amber-500/80 leading-relaxed">
            API Keys have broad access to your fleet orchestrator. Never share them or commit them to source control. Use environment variables to inject them into your workloads.
          </p>
        </div>
      </div>
    </div>
  );
};

export default APIKeysView;
