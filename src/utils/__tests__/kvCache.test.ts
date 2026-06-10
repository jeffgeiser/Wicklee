import { describe, it, expect } from 'vitest';
import { parseParamCountFromModelName, computeContextRunway } from '../kvCache';
import { makeNode } from './fixtures';

describe('parseParamCountFromModelName', () => {
  it('parses standard <n>b tags', () => {
    expect(parseParamCountFromModelName('qwen2.5-32b')).toBe(32e9);
    expect(parseParamCountFromModelName('Llama-3.1-8B-Instruct')).toBe(8e9);
    expect(parseParamCountFromModelName('deepseek-coder-6.7b')).toBe(6.7e9);
    expect(parseParamCountFromModelName('llama3.1:8b')).toBe(8e9);
  });

  it('returns null when no size tag exists', () => {
    expect(parseParamCountFromModelName('phi-3-mini')).toBeNull();
    expect(parseParamCountFromModelName(null)).toBeNull();
  });

  it('applies the shared-weight discount to MoE names (Mixtral 8x7B is 46.7B, not 56B)', () => {
    const mixtral = parseParamCountFromModelName('Mixtral-8x7B-Instruct')!;
    expect(mixtral).toBe(Math.round(8 * 7 * 0.83 * 1e9));
    // Within 5% of the published 46.7B total.
    expect(Math.abs(mixtral - 46.7e9) / 46.7e9).toBeLessThan(0.05);
  });
});

describe('computeContextRunway', () => {
  const llama8bArch = {
    ollama_num_layers: 32,
    ollama_kv_heads: 8,
    ollama_num_heads: 32,
    ollama_embedding_dim: 4096,
    ollama_context_length: 131_072,
  };

  it('returns null with no model or no headroom', () => {
    expect(computeContextRunway(makeNode(), 10)).toBeNull();
    expect(computeContextRunway(
      makeNode({ ollama_active_model: 'llama3.1:8b', ...llama8bArch }), 0,
    )).toBeNull();
  });

  it('computes exact KV size from /api/show architecture (Llama 3.1 8B @ 4k = 0.5 GB)', () => {
    const runway = computeContextRunway(
      makeNode({ ollama_active_model: 'llama3.1:8b', ...llama8bArch }),
      20,
    )!;
    expect(runway.arch.isExact).toBe(true);
    expect(runway.arch.headDim).toBe(128);
    const at4k = runway.points.find(p => p.tokens === 4_096)!;
    // 2 × 32 layers × 8 KV heads × 128 dim × 4096 tokens × 2 bytes = 0.5 GiB
    expect(at4k.kvGb).toBeCloseTo(0.5, 2);
  });

  it('reports the largest fitting milestone', () => {
    const runway = computeContextRunway(
      makeNode({ ollama_active_model: 'llama3.1:8b', ...llama8bArch }),
      1.0, // 1 GB headroom: 4k (0.5 GB) fits, 16k (2 GB) does not
    )!;
    expect(runway.maxFitsCtx).toBe(4_096);
  });

  it('works for vLLM models via name-based estimation (previously always null)', () => {
    const runway = computeContextRunway(
      makeNode({ vllm_model_name: 'Qwen/Qwen2.5-32B-Instruct', vllm_max_model_len: 32_768 }),
      20,
    )!;
    expect(runway.arch.isExact).toBe(false);
    expect(runway.arch.maxCtx).toBe(32_768);
    expect(runway.points.length).toBeGreaterThan(0);
  });

  it('works for llama.cpp models via name-based estimation', () => {
    const runway = computeContextRunway(
      makeNode({ llamacpp_model_name: 'Llama-3.1-8B-Q4_K_M.gguf' }),
      8,
    );
    expect(runway).not.toBeNull();
    expect(runway!.arch.isExact).toBe(false);
  });

  it('uses the corrected 16-layer pattern for ~1B models', () => {
    const runway = computeContextRunway(
      makeNode({ vllm_model_name: 'llama-3.2-1b-instruct' }),
      4,
    )!;
    expect(runway.arch.layers).toBe(16);
  });
});
