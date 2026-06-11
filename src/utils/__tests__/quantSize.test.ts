import { describe, it, expect } from 'vitest';
import {
  bytesPerWeight,
  quantCompressionRatio,
  quantFamily,
  parseQuantFromAnyModelName,
  estimateModelSizeGbFromName,
  estimateModelSizeGb,
  resolveModelSizeHints,
  FP16_BYTES_PER_WEIGHT,
  OLLAMA_DEFAULT_BYTES_PER_WEIGHT,
} from '../quantSize';
import { makeNode } from './fixtures';

describe('bytesPerWeight', () => {
  it('returns GGUF averages for K-quants', () => {
    expect(bytesPerWeight('Q2_K')).toBe(0.39);
    expect(bytesPerWeight('Q3_K_M')).toBe(0.45);
    expect(bytesPerWeight('Q4_K_M')).toBe(0.60);
    expect(bytesPerWeight('Q5_K_M')).toBe(0.69);
    expect(bytesPerWeight('Q6_K')).toBe(0.82);
    expect(bytesPerWeight('Q8_0')).toBe(1.0);
  });

  it('separates IQ4 from the heavier Q4_K family', () => {
    expect(bytesPerWeight('IQ4_XS')).toBe(0.56);
    expect(bytesPerWeight('Q4_0')).toBe(0.60);
  });

  it('handles full-precision and production vLLM/HF tags', () => {
    expect(bytesPerWeight('FP8')).toBe(1.0);
    expect(bytesPerWeight('BF16')).toBe(2.0);
    expect(bytesPerWeight('F32')).toBe(4.0);
    expect(bytesPerWeight('AWQ')).toBe(0.56);
    expect(bytesPerWeight('GPTQ-INT8')).toBe(1.0);
    expect(bytesPerWeight('NF4')).toBe(0.56);
  });

  it('strips Unsloth UD- prefix and .gguf suffix', () => {
    expect(bytesPerWeight('UD-Q4_K_XL')).toBe(0.60);
    expect(bytesPerWeight('q8_0.gguf')).toBe(1.0);
  });

  it('returns null for unknown or missing tags', () => {
    expect(bytesPerWeight('exotic-quant')).toBeNull();
    expect(bytesPerWeight(null)).toBeNull();
    expect(bytesPerWeight(undefined)).toBeNull();
  });

  it('matches real GGUF file sizes within ±10% (Llama 3.1 8B, 8.03B params)', () => {
    const params = 8.03e9;
    // Published GGUF sizes for Llama 3.1 8B Instruct.
    const realSizes: [string, number][] = [
      ['Q2_K',   3.18],
      ['Q4_K_M', 4.92],
      ['Q6_K',   6.60],
      ['Q8_0',   8.54],
      ['F16',   16.07],
    ];
    for (const [quant, realGb] of realSizes) {
      const est = (params * bytesPerWeight(quant)!) / 1e9;
      expect(est, quant).toBeGreaterThan(realGb * 0.9);
      expect(est, quant).toBeLessThan(realGb * 1.1);
    }
  });
});

describe('quantCompressionRatio', () => {
  it('is exactly bytesPerWeight / 2 — one source of truth', () => {
    for (const family of ['Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q8', 'F16', 'F32']) {
      expect(quantCompressionRatio(family)).toBe(
        bytesPerWeight(family)! / FP16_BYTES_PER_WEIGHT,
      );
    }
  });

  it('matches real-world Q4_K_M / F16 file-size ratio (~0.31)', () => {
    expect(quantCompressionRatio('Q4_K_M')).toBeCloseTo(0.30, 2);
  });

  it('returns null for unknown tags', () => {
    expect(quantCompressionRatio('mystery')).toBeNull();
    expect(quantCompressionRatio(null)).toBeNull();
  });
});

describe('quantFamily', () => {
  it('buckets GGUF quants including IQ variants', () => {
    expect(quantFamily('Q4_K_M')).toBe('Q4');
    expect(quantFamily('IQ2_XS')).toBe('Q2');
    expect(quantFamily('UD-Q5_K_XL')).toBe('Q5');
  });

  it('folds byte-equivalent precision tags', () => {
    expect(quantFamily('FP8')).toBe('Q8');
    expect(quantFamily('INT8')).toBe('Q8');
    expect(quantFamily('BF16')).toBe('F16');
    expect(quantFamily('FP16')).toBe('F16');
    expect(quantFamily('FP32')).toBe('F32');
  });

  it('keeps vLLM/HF-only formats out of GGUF families (no GGUF advice for vLLM users)', () => {
    expect(quantFamily('AWQ')).toBe('Unknown');
    expect(quantFamily('GPTQ-INT4')).toBe('Unknown');
    expect(quantFamily(null)).toBe('Unknown');
  });
});

describe('parseQuantFromAnyModelName', () => {
  const cases: [string, string | null][] = [
    ['Llama-3.1-8B-Q4_K_M.gguf',           'Q4_K_M'],
    ['qwen2.5-32b-instruct-fp8',           'FP8'],
    ['Mixtral-8x7B-bf16',                  'BF16'],
    ['phi-3-mini-Q8_0',                    'Q8_0'],
    ['Qwen2.5-32B-Instruct-AWQ',           'AWQ'],
    ['Llama-3.1-70B-Instruct-GPTQ-Int4',   'GPTQ-INT4'],
    ['org/Repo-Name-IQ2_XXS',              'IQ2_XXS'],
    ['Qwen/Qwen2.5-32B-Instruct',          null],
    ['llama3.1:8b',                        null],
  ];
  it.each(cases)('%s → %s', (name, expected) => {
    expect(parseQuantFromAnyModelName(name)).toBe(expected);
  });
});

describe('estimateModelSizeGbFromName', () => {
  it('uses parsed quant when present', () => {
    expect(estimateModelSizeGbFromName('Llama-3.1-8B-Q4_K_M.gguf')).toBeCloseTo(4.8, 1);
    expect(estimateModelSizeGbFromName('qwen2.5-32b-instruct-fp8')).toBeCloseTo(32, 1);
  });

  it('defaults un-tagged names to FP16 (vLLM convention)', () => {
    expect(estimateModelSizeGbFromName('Qwen/Qwen2.5-32B-Instruct')).toBeCloseTo(64, 1);
  });

  it('respects a caller-supplied fallback bpw for Ollama defaults', () => {
    expect(
      estimateModelSizeGbFromName('llama3.1:8b', null, OLLAMA_DEFAULT_BYTES_PER_WEIGHT),
    ).toBeCloseTo(4.8, 1);
  });

  it('quant hint overrides name parsing', () => {
    expect(estimateModelSizeGbFromName('llama3.1:8b', 'Q8_0')).toBeCloseTo(8, 1);
  });

  it('returns null when no parameter count is parseable', () => {
    expect(estimateModelSizeGbFromName('phi-3-mini')).toBeNull();
  });
});

describe('estimateModelSizeGb (node-level)', () => {
  it('prefers explicit ollama_model_size_gb', () => {
    const node = makeNode({ ollama_active_model: 'llama3.1:8b', ollama_model_size_gb: 4.9 });
    expect(estimateModelSizeGb(node)).toBe(4.9);
  });

  it('assumes Q4_K_M (not FP16) for un-tagged Ollama names', () => {
    const node = makeNode({ ollama_active_model: 'llama3.1:8b' });
    expect(estimateModelSizeGb(node)).toBeCloseTo(4.8, 1);
  });

  it('assumes FP16 for un-tagged vLLM names', () => {
    const node = makeNode({ vllm_model_name: 'Qwen/Qwen2.5-32B-Instruct' });
    expect(estimateModelSizeGb(node)).toBeCloseTo(64, 1);
  });

  it('returns null when no model name is present', () => {
    expect(estimateModelSizeGb(makeNode())).toBeNull();
  });
});

describe('resolveModelSizeHints (vllm_dtype capture)', () => {
  it('prefers the cmdline-captured vllm_dtype over name parsing', () => {
    // Un-tagged vLLM name + FP8 engine: without vllm_dtype this sized as
    // FP16 (64 GB); the cmdline capture halves it to the true 32 GB.
    const node = makeNode({
      vllm_model_name: 'Qwen/Qwen2.5-32B-Instruct',
      vllm_dtype: 'FP8',
    });
    expect(resolveModelSizeHints(node).quantHint).toBe('FP8');
    expect(estimateModelSizeGb(node)).toBeCloseTo(32, 1);
  });

  it('sizes AWQ vLLM deployments at 4-bit instead of FP16', () => {
    const node = makeNode({
      vllm_model_name: 'Qwen/Qwen2.5-32B-Instruct',
      vllm_dtype: 'AWQ',
    });
    expect(estimateModelSizeGb(node)).toBeCloseTo(32 * 0.56, 0); // ~17.9 GB (0.56 B/W)
  });

  it('keeps hints matched to the runtime the name came from', () => {
    // A stale Ollama quant field must not leak onto a vLLM model name.
    const node = makeNode({
      vllm_model_name: 'Qwen/Qwen2.5-32B-Instruct',
      ollama_quantization: 'Q4_K_M',
    });
    expect(resolveModelSizeHints(node).quantHint).toBeNull();
    expect(estimateModelSizeGb(node)).toBeCloseTo(64, 1); // FP16 fallback
  });

  it('falls back to name parsing when vllm_dtype is absent (--dtype auto)', () => {
    const node = makeNode({ vllm_model_name: 'qwen2.5-32b-instruct-fp8' });
    expect(resolveModelSizeHints(node).quantHint).toBe('FP8');
  });
});
