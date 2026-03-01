import React, { useState } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { BrainCircuit, Loader2, Sparkles, AlertCircle } from 'lucide-react';
import { NodeAgent } from '../types';

const AIInsights: React.FC<{ 
  nodes: NodeAgent[], 
  userApiKey?: string,
  onNavigateToSecurity?: () => void 
}> = ({ nodes, userApiKey, onNavigateToSecurity }) => {
  const [loading, setLoading] = useState(false);
  const [insight, setInsight] = useState<string | null>(null);

  const analyzeFleet = async () => {
    setLoading(true);
    try {
      // Use user-provided key if available, otherwise fallback to default
      const apiKey = userApiKey || process.env.API_KEY;
      if (!apiKey) {
        throw new Error("Local Ollama instance not connected. Please configure your endpoint in Security settings.");
      }
      
      const ai = new GoogleGenAI({ apiKey });
      
      const prompt = `Analyze this AI fleet data and provide a concise JSON-formatted strategic optimization report.
      Fleet Snapshot:
      ${JSON.stringify(nodes, null, 2)}
      
      Requirements:
      1. Identify critical nodes based on Thermal (over 75C) or VRAM (over 90% usage).
      2. Suggest if load balancing should be shifted.
      3. Recommend specific WASM interceptors to improve efficiency.
      
      Format the output as a Markdown report with a "Strategic Optimization" header.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
      });

      setInsight(response.text || "Failed to generate insights.");
    } catch (error) {
      console.error(error);
      setInsight("Error communicating with local model. Please ensure Ollama is running and reachable.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {!userApiKey && !process.env.API_KEY && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500" />
            <p className="text-sm text-amber-600 dark:text-amber-200">
              Connect a local Ollama instance to enable fleet intelligence. Recommended model: phi3:mini or qwen2.5:1.5b
            </p>
          </div>
          <button 
            onClick={onNavigateToSecurity}
            className="text-xs font-bold text-amber-600 dark:text-amber-200 hover:underline"
          >
            Configure Local Model →
          </button>
        </div>
      )}

      <div className="bg-gradient-to-br from-blue-600/20 to-cyan-400/20 border border-blue-500/20 rounded-2xl p-8 flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center shadow-xl shadow-blue-500/40 mb-6">
          <BrainCircuit className="w-8 h-8 text-white" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Local Intelligence</h2>
        <p className="text-gray-600 dark:text-gray-400 max-w-lg mb-8">
          Powered by your local Ollama model — your fleet data never leaves your network. Wicklee analyzes your fleet using a model running on your own hardware. No data is sent to external APIs.
        </p>
        <button 
          onClick={analyzeFleet}
          disabled={loading}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 dark:disabled:bg-gray-800 disabled:text-gray-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/20 flex items-center gap-2"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
          {loading ? 'Analyzing Telemetry...' : 'Analyze My Fleet'}
        </button>
      </div>

      {insight && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 prose prose-invert max-w-none shadow-sm dark:shadow-2xl transition-colors text-gray-700 dark:text-gray-300">
          <div className="flex items-center gap-2 mb-4 text-blue-600 dark:text-cyan-400 text-sm font-bold uppercase tracking-widest">
            <Sparkles className="w-4 h-4" />
            Local Model Analysis Output
          </div>
          <div className="whitespace-pre-wrap leading-relaxed">
            {insight}
          </div>
        </div>
      )}

      {!insight && !loading && (
        <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-600">
          <AlertCircle className="w-8 h-8 mb-2 opacity-20" />
          <p className="text-sm">No analysis has been run for the current session.</p>
        </div>
      )}
    </div>
  );
};

export default AIInsights;