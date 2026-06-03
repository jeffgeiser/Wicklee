/**
 * Frontend-side category inference for HuggingFace GGUF models.
 *
 * The agent's discovery endpoint doesn't carry a `pipeline_tag` field today
 * (would require three-way wire format sync + DuckDB schema migration), so
 * we resolve categories on the client from the model_id alone. Name-regex
 * heuristics cover ~80% of the cases that matter for LLM users — anything
 * not matched falls through to "General".
 *
 * Categories deliberately mirror runthisllm.com's taxonomy so users coming
 * from there have a mental model that transfers:
 *   General, Code, Reasoning, Vision, Embedding, Audio
 *
 * Future Phase 2.5: propagate HF `pipeline_tag` + `tags` through the agent
 * and cloud responses; prefer them over name-regex when present. Tracked in
 * ROADMAP.md.
 */

export type ModelCategory =
  | 'General'
  | 'Code'
  | 'Reasoning'
  | 'Vision'
  | 'Embedding'
  | 'Audio';

export const ALL_CATEGORIES: ModelCategory[] = [
  'General',
  'Code',
  'Reasoning',
  'Vision',
  'Embedding',
  'Audio',
];

/**
 * Resolve a category from the HuggingFace model_id (e.g. "unsloth/Qwen3-VL-2B-Instruct-GGUF").
 *
 * Resolution order is intentional:
 *   1. Vision   — most specific modality, often overlaps with "code"/"general" naming
 *   2. Audio    — second specific modality
 *   3. Embedding — pulled out before "general" because embedding models often share
 *                  a base-model name (e.g. nomic-embed-text)
 *   4. Code     — has explicit naming convention
 *   5. Reasoning — has explicit naming convention, but lower priority than code
 *                  because some code models also have "reasoning" capabilities
 *   6. General  — fallback
 */
export function inferCategory(modelId: string): ModelCategory {
  const id = modelId.toLowerCase();

  // ── Vision (multimodal) ─────────────────────────────────────────────────
  // Llava, moondream, Qwen-VL, Phi-Vision, Gemma-Vision, internvl, cogvlm,
  // pixtral, Idefics, BunnY, Mini-CPM-V
  if (
    /\bvl\b/.test(id) ||                   // "Qwen3-VL", "InternVL"
    /-vl-|vl-/.test(id) ||
    /vision/.test(id) ||
    /llava/.test(id) ||
    /moondream/.test(id) ||
    /paddleocr/.test(id) ||                // OCR is a vision task
    /pixtral/.test(id) ||
    /idefics/.test(id) ||
    /cogvlm/.test(id) ||
    /minicpm-?v/.test(id) ||
    /-v\d+\.\d+(?:-|$)/.test(id) === false && /florence/.test(id)
  ) {
    return 'Vision';
  }

  // ── Audio (ASR + TTS) ───────────────────────────────────────────────────
  if (
    /whisper/.test(id) ||
    /\bsts?\b/.test(id) ||                 // standalone "tts" / "stt"
    /-tts(?:-|$)/.test(id) ||
    /parler/.test(id) ||
    /seamless/.test(id) ||
    /fish-?audio/.test(id) ||
    /\baudio\b/.test(id) ||
    /xtts/.test(id) ||
    /bark/.test(id)
  ) {
    return 'Audio';
  }

  // ── Embedding ───────────────────────────────────────────────────────────
  // bge-*, e5-*, gte-*, nomic-embed-*, jina-embeddings, mxbai-embed,
  // snowflake-arctic-embed
  if (
    /\bembed/.test(id) ||
    /\bembedding/.test(id) ||
    /\bbge-/.test(id) ||
    /\be5-/.test(id) ||
    /\bgte-/.test(id) ||
    /nomic-embed/.test(id) ||
    /mxbai-embed/.test(id) ||
    /jina-embeddings/.test(id) ||
    /snowflake.*embed/.test(id) ||
    /\bbge\b/.test(id)
  ) {
    return 'Embedding';
  }

  // ── Code ────────────────────────────────────────────────────────────────
  // qwen-coder, deepseek-coder, starcoder, codellama, granite-code, codegemma
  if (
    /\bcoder\b/.test(id) ||
    /\bcode\b/.test(id) ||
    /starcoder/.test(id) ||
    /codellama/.test(id) ||
    /codegemma/.test(id) ||
    /granite-?code/.test(id) ||
    /codestral/.test(id) ||
    /devstral/.test(id) ||
    /\bsql-?coder/.test(id)
  ) {
    return 'Code';
  }

  // ── Reasoning ───────────────────────────────────────────────────────────
  // qwq, deepseek-r1, openthinker, marco-o1, reflection, thinking-models,
  // r1-distill, openrlhf
  if (
    /\bqwq\b/.test(id) ||
    /deepseek-?r1/.test(id) ||
    /\br1-/.test(id) ||
    /-r1[-_]/.test(id) ||
    /\bo1\b/.test(id) ||
    /-o1-/.test(id) ||
    /openthinker/.test(id) ||
    /\bthink(?:ing)?\b/.test(id) ||
    /reflection/.test(id) ||
    /reasoning/.test(id) ||
    /-cot-/.test(id) ||
    /marco-?o1/.test(id) ||
    /openrlhf/.test(id) ||
    /chain-of-thought/.test(id)
  ) {
    return 'Reasoning';
  }

  // ── General fallback ────────────────────────────────────────────────────
  return 'General';
}

/**
 * Short hover hint describing the category — used as tooltip on chip row.
 */
export function categoryDescription(cat: ModelCategory): string {
  switch (cat) {
    case 'General':   return 'General-purpose instruction-tuned chat models.';
    case 'Code':      return 'Code-specialized models (Qwen Coder, DeepSeek Coder, StarCoder, Codestral, etc).';
    case 'Reasoning': return 'Reasoning / chain-of-thought tuned (QwQ, DeepSeek R1, OpenThinker, o1-style).';
    case 'Vision':    return 'Vision-language multimodal (LLaVA, Qwen-VL, Moondream, Phi Vision, etc).';
    case 'Embedding': return 'Sentence/document embedding models (BGE, E5, Nomic, Jina, etc).';
    case 'Audio':     return 'Speech-to-text and text-to-speech (Whisper, Parler, Bark, etc).';
  }
}
