
import React, { useState } from 'react';
import { Copy, Check, FileCode, FolderTree, Terminal, Cpu, Database, ShieldCheck, Users, Lock, Zap } from 'lucide-react';

const ScaffoldingView: React.FC = () => {
  const [copied, setCopied] = useState<string | null>(null);
  const [activeHardware, setActiveHardware] = useState<'nvidia' | 'apple' | 'jetson'>('nvidia');

  const HARDWARE_CONFIGS = {
    nvidia: {
      title: "NVIDIA (CUDA)",
      icon: <Cpu className="w-4 h-4" />,
      setup: `# Install NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
# Register Wicklee Node
wicklee-agent register --backend-url $VITE_WICKLEE_AGENT_URL --runtime nvidia`
    },
    apple: {
      title: "Apple Silicon (Metal)",
      icon: <Zap className="w-4 h-4" />,
      setup: `# Optimized for Mac Studio / M2 Ultra
# Requires macOS 14.0+
brew install wicklee-agent
wicklee-agent register --backend-url $VITE_WICKLEE_AGENT_URL --runtime metal`
    },
    jetson: {
      title: "Jetson Orin (Edge)",
      icon: <Database className="w-4 h-4" />,
      setup: `# JetPack 6.0+ Required
# Low-power autonomous mode
sudo apt install wicklee-agent-jetson
wicklee-agent register --mode autonomous`
    }
  };

  const CARGO_TOML = `[package]
name = "wicklee-backend"
version = "0.3.0"
edition = "2021"

[dependencies]
# HTTP & Async
axum = { version = "0.7", features = ["ws", "macros"] }
tokio = { version = "1.0", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tower = "0.4"
tower-http = { version = "0.5", features = ["cors", "request-id"] }

# Storage & Identity
duckdb = { version = "0.9", features = ["bundled"] }
uuid = { version = "1.0", features = ["v4", "serde"] }

# Utilities
chrono = { version = "0.4", features = ["serde"] }`;

  const RBAC_RS = `use ax_auth::{FromRequestParts, async_trait};
use axum::{http::StatusCode, middleware::Next, response::Response, extract::Request};

#[derive(Debug, PartialEq, Eq, serde::Deserialize)]
pub enum UserRole {
    Owner,
    Collaborator,
    Viewer,
}

pub struct UserContext {
    pub role: UserRole,
    pub user_id: String,
}

/// Middleware to enforce Collaborator or higher access
pub async fn require_collaborator(
    user: UserContext,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    match user.role {
        UserRole::Owner | UserRole::Collaborator => Ok(next.run(request).await),
        UserRole::Viewer => Err(StatusCode::FORBIDDEN),
    }
}

/// Middleware to enforce Owner-only access
pub async fn require_owner(
    user: UserContext,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if user.role == UserRole::Owner {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}`;

  const MAIN_RS = `use axum::{
    routing::{get, post},
    middleware::from_fn,
    Router,
};

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/api/traces", get(get_traces))
        // Scaffolding & Fleet updates require Collaborator access
        .route("/api/scaffolding", get(get_scaffolding))
        .layer(from_fn(require_collaborator))
        // Team Management requires Owner access
        .route("/api/team", post(update_team))
        .layer(from_fn(require_owner))
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}`;

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Hardware Abstraction Tabs */}
      <div className="bg-[#030712]/80 backdrop-blur-xl border border-white/5 rounded-[24px] p-6">
        <div className="mb-4">
          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest flex items-center gap-2">
            <Cpu className="w-4 h-4" /> Node Registration
          </h3>
          <p className="text-[10px] text-blue-400/60 mt-1 font-medium">Select target silicon to generate secure bootstrapping commands.</p>
        </div>
        <div className="flex gap-2 mb-6">
          {(['nvidia', 'apple', 'jetson'] as const).map((hw) => (
            <button
              key={hw}
              onClick={() => setActiveHardware(hw)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                activeHardware === hw 
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' 
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {HARDWARE_CONFIGS[hw].icon}
              {HARDWARE_CONFIGS[hw].title}
            </button>
          ))}
        </div>
        <div className="bg-gray-950 p-6 rounded-2xl border border-white/5 font-mono text-xs text-cyan-400 relative group overflow-hidden">
          <div className="absolute inset-0 bg-blue-500/5 pointer-events-none"></div>
          <pre className="relative z-10">{HARDWARE_CONFIGS[activeHardware].setup}</pre>
          <button 
            onClick={() => handleCopy(HARDWARE_CONFIGS[activeHardware].setup, 'hw')}
            className="absolute right-4 top-4 p-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            {copied === 'hw' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-6">
        <div className="bg-[#030712]/80 backdrop-blur-xl border border-white/5 rounded-[24px] p-6">
          <div className="mb-4">
            <div className="flex items-center gap-3">
              <Lock className="w-5 h-5 text-cyan-400" />
              <h3 className="font-semibold text-gray-200">Identity & Access Control</h3>
            </div>
            <p className="text-[10px] text-blue-400/60 mt-1 font-medium ml-8">Enforce fine-grained tenant isolation and hardware-bound role permissions.</p>
          </div>
          <div className="relative group">
            <button 
              onClick={() => handleCopy(RBAC_RS, 'rbac')}
              className="absolute right-4 top-4 p-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-400 transition-all opacity-0 group-hover:opacity-100"
            >
              {copied === 'rbac' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <div className="font-mono text-[10px] text-gray-400 bg-gray-950 p-6 rounded-2xl border border-white/5 overflow-x-auto max-h-[300px] relative">
              <div className="absolute inset-0 bg-blue-500/5 pointer-events-none"></div>
              <pre className="relative z-10">{RBAC_RS}</pre>
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="mb-4">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-cyan-400" />
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-200">Global Routing Policy</h3>
                {/* Status Dot */}
                <div className="w-2 h-2 bg-cyan-400 rounded-full shadow-[0_0_8px_#22d3ee] animate-pulse"></div>
              </div>
            </div>
            <p className="text-[10px] text-blue-400/60 mt-1 font-medium ml-8">Declarative safety guardrails and autonomous failover logic at the edge.</p>
          </div>
          <div className="relative group">
            <button 
              onClick={() => handleCopy(MAIN_RS, 'main')}
              className="absolute right-4 top-4 p-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-400 transition-all opacity-0 group-hover:opacity-100"
            >
              {copied === 'main' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <div className="font-mono text-[10px] text-gray-400 bg-gray-950 p-6 rounded-2xl border border-white/5 overflow-x-auto max-h-[300px] relative">
              <div className="absolute inset-0 bg-blue-500/5 pointer-events-none"></div>
              <pre className="relative z-10">{MAIN_RS}</pre>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-[#030712]/80 backdrop-blur-xl border border-white/5 rounded-[24px] p-6 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <FileCode className="w-5 h-5 text-cyan-400" />
            <div>
              <h3 className="font-semibold text-gray-200">Runtime Manifest</h3>
              <p className="text-[10px] text-blue-400/60 mt-0.5 font-medium">The core engine definition, including embedded local store and mTLS security stacks.</p>
            </div>
          </div>
          <button 
            onClick={() => handleCopy(CARGO_TOML, 'toml')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-xs font-bold transition-all text-white shadow-lg shadow-blue-500/20"
          >
            {copied === 'toml' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied === 'toml' ? 'Manifest Copied' : 'Copy Manifest'}
          </button>
        </div>
        <div className="flex-1 font-mono text-sm text-gray-400 bg-gray-950 p-6 rounded-2xl border border-white/5 whitespace-pre overflow-y-auto max-h-[600px] relative">
          <div className="absolute inset-0 bg-blue-500/5 pointer-events-none"></div>
          <div className="relative z-10">{CARGO_TOML}</div>
        </div>
      </div>
    </div>
  </div>
  );
};

export default ScaffoldingView;
