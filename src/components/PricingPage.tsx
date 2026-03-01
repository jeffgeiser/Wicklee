import React, { useState } from 'react';
import { Check, Zap, Shield, Globe, Server, Cpu, Handshake } from 'lucide-react';

const PricingPage: React.FC = () => {
  const [infraPreference, setInfraPreference] = useState<'byok' | 'managed'>('byok');

  const tiers = [
    {
      name: 'Free',
      badge: 'Community Edition',
      price: '$0',
      description: 'Perfect for local experimentation and single-node setups.',
      features: [
        'Single-node monitoring',
        'Local DuckDB traces',
        'Community support',
        'Standard dashboard access'
      ],
      cta: 'Get Started',
      highlight: false
    },
    {
      name: 'Pro',
      badge: 'Professional',
      price: infraPreference === 'byok' ? '$39' : '$79',
      description: 'Advanced orchestration for scaling production AI fleets.',
      features: [
        'Sentinel Auto-Failover',
        'Multi-node fleet management',
        infraPreference === 'managed' ? '10M Analysis Tokens' : 'Unlimited BYOK Tokens',
        'Advanced telemetry retention',
        'Priority email support'
      ],
      cta: 'Upgrade to Pro',
      highlight: true
    },
    {
      name: 'Enterprise',
      badge: 'Sovereign Fabric',
      price: 'Contact Us',
      description: 'Custom infrastructure for mission-critical sovereign AI.',
      features: [
        'mTLS Fabric encryption',
        'Custom WASM Interceptors',
        'SLA-backed uptime',
        'Dedicated account engineer',
        'On-prem air-gapped support'
      ],
      cta: 'Talk to Sales',
      highlight: false
    }
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-12 animate-in fade-in duration-700">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold text-white tracking-tight">Sovereign-First Pricing</h1>
        <p className="text-gray-400 max-w-2xl mx-auto">
          Scale your local AI fleet with confidence. Choose between bringing your own keys or letting Wicklee manage the orchestration fabric.
        </p>

        {/* Infra Toggle */}
        <div className="flex items-center justify-center pt-4">
          <div className="bg-zinc-900 border border-zinc-800 p-1 rounded-2xl flex items-center gap-1">
            <button
              onClick={() => setInfraPreference('byok')}
              className={`px-6 py-2 rounded-xl text-xs font-bold transition-all ${
                infraPreference === 'byok' 
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' 
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              BYOK (Self-Hosted)
            </button>
            <button
              onClick={() => setInfraPreference('managed')}
              className={`px-6 py-2 rounded-xl text-xs font-bold transition-all ${
                infraPreference === 'managed' 
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' 
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              Wicklee Managed
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {tiers.map((tier) => (
          <div 
            key={tier.name}
            className={`relative flex flex-col p-8 rounded-[32px] border transition-all duration-500 ${
              tier.highlight 
                ? 'bg-zinc-950 border-blue-500/50 shadow-[0_0_40px_rgba(34,211,238,0.1)] scale-105 z-10' 
                : 'bg-zinc-950 border-zinc-800 hover:border-zinc-700'
            }`}
          >
            {tier.highlight && (
              <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 px-4 py-1 bg-blue-600 text-white text-[10px] font-bold uppercase tracking-widest rounded-full shadow-lg shadow-blue-500/40">
                Most Popular
              </div>
            )}

            <div className="space-y-2 mb-8">
              <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest">{tier.badge}</span>
              <h3 className="text-2xl font-bold text-white">{tier.name}</h3>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-bold text-white">{tier.price}</span>
                {tier.price !== 'Contact Us' && <span className="text-gray-500 text-sm">/mo</span>}
              </div>
              <p className="text-sm text-gray-500 leading-relaxed">{tier.description}</p>
            </div>

            <div className="flex-1 space-y-4 mb-8">
              {tier.features.map((feature) => (
                <div key={feature} className="flex items-start gap-3">
                  <div className="mt-1 p-0.5 bg-blue-600/10 rounded-full">
                    <Check className="w-3 h-3 text-blue-400" />
                  </div>
                  <span className="text-sm text-gray-300">{feature}</span>
                </div>
              ))}
            </div>

            <button 
              className={`w-full py-4 rounded-2xl text-sm font-bold transition-all ${
                tier.highlight
                  ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-xl shadow-blue-500/20'
                  : 'bg-zinc-900 hover:bg-zinc-800 text-gray-300 border border-zinc-800'
              }`}
            >
              {tier.cta}
            </button>
          </div>
        ))}
      </div>

      <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-8 flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-blue-600/10 rounded-2xl border border-blue-500/20">
            <Shield className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <h4 className="text-lg font-bold text-white">Security First Architecture</h4>
            <p className="text-sm text-gray-500">All tiers include end-to-end encryption and local-first data persistence.</p>
          </div>
        </div>
        <button className="px-8 py-3 bg-transparent hover:bg-zinc-800 text-gray-300 text-sm font-bold rounded-xl border border-zinc-700 transition-all">
          View Security Whitepaper
        </button>
      </div>
    </div>
  );
};

export default PricingPage;
