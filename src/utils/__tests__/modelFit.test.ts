import { describe, it, expect } from 'vitest';
import { computeModelFitScore } from '../modelFit';
import { makeNode } from './fixtures';

describe('computeModelFitScore', () => {
  it('returns null when no model is loaded on any runtime', () => {
    expect(computeModelFitScore(makeNode())).toBeNull();
  });

  // ── Ollama on NVIDIA (measured VRAM path) ──────────────────────────────────

  it('scores Good with >20% VRAM headroom and Normal thermal', () => {
    const fit = computeModelFitScore(makeNode({
      ollama_active_model: 'llama3.1:8b',
      ollama_model_size_gb: 4.9,
      nvidia_vram_total_mb: 24_576,
      nvidia_vram_used_mb: 6_000,
      thermal_state: 'Normal',
    }))!;
    expect(fit.score).toBe('good');
    expect(fit.isNvidia).toBe(true);
    expect(fit.headroomPct).toBeCloseTo(75.6, 1);
    expect(fit.totalGb).toBeCloseTo(24, 1);
  });

  it('scores Fair at exactly 20% headroom (boundary)', () => {
    const fit = computeModelFitScore(makeNode({
      ollama_active_model: 'llama3.1:8b',
      ollama_model_size_gb: 4.9,
      nvidia_vram_total_mb: 10_000,
      nvidia_vram_used_mb: 8_000,
    }))!;
    expect(fit.headroomPct).toBeCloseTo(20, 5);
    expect(fit.score).toBe('fair');
  });

  it('scores Fair at exactly 10% headroom, Poor below it', () => {
    const at10 = computeModelFitScore(makeNode({
      ollama_active_model: 'llama3.1:8b',
      ollama_model_size_gb: 4.9,
      nvidia_vram_total_mb: 10_000,
      nvidia_vram_used_mb: 9_000,
    }))!;
    expect(at10.score).toBe('fair');

    const below10 = computeModelFitScore(makeNode({
      ollama_active_model: 'llama3.1:8b',
      ollama_model_size_gb: 4.9,
      nvidia_vram_total_mb: 10_000,
      nvidia_vram_used_mb: 9_100,
    }))!;
    expect(below10.score).toBe('poor');
    expect(below10.reason).toMatch(/headroom/i);
  });

  it('scores Poor when the model exceeds total capacity', () => {
    const fit = computeModelFitScore(makeNode({
      ollama_active_model: 'llama3.1:70b',
      ollama_model_size_gb: 40,
      nvidia_vram_total_mb: 24_576,
      nvidia_vram_used_mb: 20_000,
    }))!;
    expect(fit.score).toBe('poor');
    expect(fit.reason).toMatch(/exceeds hardware capacity/);
  });

  it('Serious/Critical thermal forces Poor even with ample headroom', () => {
    for (const state of ['Serious', 'critical']) {
      const fit = computeModelFitScore(makeNode({
        ollama_active_model: 'llama3.1:8b',
        ollama_model_size_gb: 4.9,
        nvidia_vram_total_mb: 24_576,
        nvidia_vram_used_mb: 6_000,
        thermal_state: state,
      }))!;
      expect(fit.score, state).toBe('poor');
    }
  });

  it('Fair thermal caps the score at Fair even with >20% headroom', () => {
    const fit = computeModelFitScore(makeNode({
      ollama_active_model: 'llama3.1:8b',
      ollama_model_size_gb: 4.9,
      nvidia_vram_total_mb: 24_576,
      nvidia_vram_used_mb: 6_000,
      thermal_state: 'Fair',
    }))!;
    expect(fit.score).toBe('fair');
    expect(fit.reason).toMatch(/thermal/i);
  });

  // ── vLLM (synthetic working-set path) ──────────────────────────────────────

  it('Spark scenario: 32GB FP8 model on 128GB does NOT score Poor despite 90% VRAM reservation', () => {
    const fit = computeModelFitScore(makeNode({
      vllm_model_name: 'qwen2.5-32b-instruct-fp8',
      nvidia_vram_total_mb: 131_072,
      nvidia_vram_used_mb: 118_000, // vLLM eager KV reservation
    }))!;
    expect(fit.modelSizeGb).toBeCloseTo(32, 1);
    expect(fit.score).toBe('good');
    // used = 32 GB × 1.30 working-set overhead, not the 115 GB reservation
    expect(fit.headroomGb).toBeCloseTo(128 - 32 * 1.3, 0);
  });

  it('applies 30% working-set overhead to vLLM weights (agent parity)', () => {
    const fit = computeModelFitScore(makeNode({
      vllm_model_name: 'Llama-3.1-8B-Instruct-fp8',
      nvidia_vram_total_mb: 16_384,
      nvidia_vram_used_mb: 15_000,
    }))!;
    // 8 GB weights → 10.4 GB used → headroom (16 − 10.4)/16 = 35%
    expect(fit.headroomPct).toBeCloseTo(35, 0);
    expect(fit.score).toBe('good');
  });

  it('applies the 512 MB floor for small vLLM models', () => {
    const fit = computeModelFitScore(makeNode({
      vllm_model_name: 'llama-3.2-1b-q8_0',
      nvidia_vram_total_mb: 8_192,
      nvidia_vram_used_mb: 7_000,
    }))!;
    // 1 GB weights: 1.3× overhead = 1331 MB, but weights + 512 MB floor = 1536 MB binds.
    const usedMb = (fit.totalGb - fit.headroomGb) * 1024;
    expect(usedMb).toBeCloseTo(1024 + 512, -1);
  });

  it('does not compound overhead onto the VRAM-used proxy (unparseable vLLM names)', () => {
    const fit = computeModelFitScore(makeNode({
      vllm_model_name: 'mystery-finetune',
      nvidia_vram_total_mb: 131_072,
      nvidia_vram_used_mb: 100_000,
    }))!;
    // size = vram_used as-is → headroom (131072−100000)/131072 ≈ 23.7% → good.
    // The old 1.1× compounding would have produced 16% → fair.
    expect(fit.modelSizeGb).toBeCloseTo(100_000 / 1024, 1);
    expect(fit.headroomPct).toBeCloseTo(23.7, 1);
    expect(fit.score).toBe('good');
  });

  // ── llama.cpp on NVIDIA (measured VRAM path) ───────────────────────────────

  it('llama.cpp uses measured VRAM, not a synthetic figure', () => {
    const fit = computeModelFitScore(makeNode({
      llamacpp_model_name: 'Llama-3.1-8B-Q4_K_M.gguf',
      nvidia_vram_total_mb: 24_576,
      nvidia_vram_used_mb: 7_000, // weights + KV + another process
    }))!;
    expect(fit.modelSizeGb).toBeCloseTo(4.8, 1);
    // headroom from the measurement: (24576 − 7000)/1024
    expect(fit.headroomGb).toBeCloseTo(17.16, 1);
    expect(fit.score).toBe('good');
  });

  // ── Apple Silicon / CPU (system RAM path) ──────────────────────────────────

  it('uses system RAM on non-NVIDIA nodes', () => {
    const fit = computeModelFitScore(makeNode({
      ollama_active_model: 'llama3.1:8b',
      ollama_model_size_gb: 4.9,
      total_memory_mb: 16_384,
      available_memory_mb: 6_000,
    }))!;
    expect(fit.isNvidia).toBe(false);
    expect(fit.headroomPct).toBeCloseTo((6_000 / 16_384) * 100, 1);
    expect(fit.score).toBe('good');
  });

  it('falls back to 50% of used system RAM for CPU-only llama.cpp with no name hints', () => {
    const fit = computeModelFitScore(makeNode({
      llamacpp_model_name: 'mystery.gguf',
      total_memory_mb: 16_384,
      available_memory_mb: 8_192,
    }))!;
    expect(fit.modelSizeGb).toBeCloseTo(4, 1);
    expect(fit.score).toBe('good');
  });

  it('returns null on degenerate totals', () => {
    expect(computeModelFitScore(makeNode({
      ollama_active_model: 'llama3.1:8b',
      ollama_model_size_gb: 4.9,
      total_memory_mb: 0,
      available_memory_mb: 0,
    }))).toBeNull();
  });
});
