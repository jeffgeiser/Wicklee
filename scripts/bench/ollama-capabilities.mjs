#!/usr/bin/env node
// Phase 1, step 0 — Ollama capability verification.
//
// Records real Ollama responses and answers V1..V9 from docs/PHASE1_SPEC.md.
// No dependencies. Node 18+ (global fetch).
//
//   node scripts/bench/ollama-capabilities.mjs --base-url http://127.0.0.1:11500
//
// Options
//   --base-url <url>   Ollama base URL            (default http://127.0.0.1:11434)
//   --model <name>     Model for load/expiry tests (default: first in /api/tags)
//   --big-model <name> Larger model for V1/V4 partial-offload and eviction tests
//   --out <path>       Raw JSON transcript        (default ./ollama-caps-<ts>.json)
//   --checks <list>    Comma-separated subset, e.g. --checks V2,V5
//   --passive          V2/V7/V8-style checks only. Sends NO generate requests
//   --yes              Skip the consent prompt for the mutating checks
//   --keepalive <s>    keep_alive for probe requests (default: omitted)
//
// WARNING: every check except --passive loads and unloads models on the target
// host. Run it against an Ollama instance you control, with the Wicklee agent's
// probe stopped or disabled, or the probe's own resets will pollute V3 and V5.

const NS_PER_MS = 1e6;
const args = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const BASE = String(flag("base-url", "http://127.0.0.1:11434")).replace(/\/+$/, "");
const PASSIVE = args.includes("--passive");
const YES = args.includes("--yes");
const ONLY = flag("checks") ? String(flag("checks")).split(",").map((s) => s.trim().toUpperCase()) : null;
const OUT = flag("out", `./ollama-caps-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const KEEPALIVE = flag("keepalive");

const transcript = { base_url: BASE, started_at: new Date().toISOString(), passive: PASSIVE, env: {}, raw: {}, findings: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body, timeoutMs = 300_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      signal: ctl.signal,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body kept as text */ }
    return { ok: r.ok, status: r.status, json, text, wall_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e), wall_ms: Date.now() - t0, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

const ps = () => req("GET", "/api/ps", null, 10_000);
const tags = () => req("GET", "/api/tags", null, 30_000);

/** Fire a tiny generation. num_ctx is passed through only when given (see V3). */
function generate(model, { numCtx, numPredict = 8, prompt = " ", keepAlive = KEEPALIVE } = {}) {
  const body = { model, prompt, stream: false, options: { num_predict: numPredict, temperature: 0, seed: 1 } };
  if (numCtx) body.options.num_ctx = Number(numCtx);
  if (keepAlive !== undefined && keepAlive !== true) body.keep_alive = isNaN(Number(keepAlive)) ? keepAlive : Number(keepAlive);
  return req("POST", "/api/generate", body);
}
const loadOnly = (model, numCtx) => {
  const body = { model };
  if (numCtx) body.options = { num_ctx: Number(numCtx) };
  return req("POST", "/api/generate", body);
};
const unload = (model) => req("POST", "/api/generate", { model, keep_alive: 0 }, 60_000);

const entryFor = (psRes, model) =>
  (psRes.json?.models ?? []).find((m) => m.name === model || m.model === model) ?? null;

function record(id, question, answer, evidence) {
  transcript.findings[id] = { question, answer, evidence };
  const head = `${id}  ${answer.verdict}`;
  console.log(`\n── ${head} ${"─".repeat(Math.max(0, 60 - head.length))}`);
  console.log(`   ${question}`);
  for (const line of answer.notes) console.log(`   · ${line}`);
}

function run(id) { return !ONLY || ONLY.includes(id); }

// ── Environment ───────────────────────────────────────────────────────────────
async function environment() {
  const v = await req("GET", "/api/version", null, 10_000);
  transcript.env.version = v.json?.version ?? null;
  transcript.raw.version = v.json ?? v.text;
  const t = await tags();
  transcript.raw.tags = t.json;
  const p = await ps();
  transcript.raw.ps_initial = p.json;
  transcript.env.ollama_env_vars = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /^OLLAMA_/.test(k)),
  );
  console.log(`Ollama ${transcript.env.version ?? "unknown"} at ${BASE}`);
  console.log(`${(t.json?.models ?? []).length} installed models, ${(p.json?.models ?? []).length} loaded`);
  return { tags: t.json?.models ?? [], ps: p.json?.models ?? [] };
}

// ── V1: does size - size_vram equal the non-accelerator residue? ──────────────
async function v1(model) {
  const q = "Does `size` minus `size_vram` equal the part of the model outside accelerator memory?";
  const before = await ps();
  let entry = entryFor(before, model);
  if (!entry && !PASSIVE) { await loadOnly(model); await sleep(1500); entry = entryFor(await ps(), model); }
  if (!entry) return record("V1", q, { verdict: "UNANSWERED", notes: [`${model} not loaded and --passive set`] }, null);

  const { size, size_vram: vram } = entry;
  const residue = size - vram;
  const notes = [
    `size=${size} size_vram=${vram} residue=${residue} (${((residue / size) * 100).toFixed(1)}% outside)`,
  ];
  // A fully-resident model proves the fields exist and agree, but not the split
  // arithmetic. Force a split by reloading at a context too large to fit.
  let split = null;
  if (residue === 0 && !PASSIVE) {
    const ctx = Number(entry.context_length || 4096) * 8;
    notes.push(`fully resident at context ${entry.context_length}; retrying at num_ctx=${ctx} to force a split`);
    await unload(model); await sleep(1000);
    await loadOnly(model, ctx); await sleep(2000);
    split = entryFor(await ps(), model);
    if (split) notes.push(`at num_ctx=${ctx}: size=${split.size} size_vram=${split.size_vram} residue=${split.size - split.size_vram}`);
  }
  const observed = split ?? entry;
  const verdict = observed.size === undefined || observed.size_vram === undefined ? "UNANSWERED"
    : observed.size - observed.size_vram > 0 ? "CONFIRMED-SPLIT"
    : "NO-SPLIT-OBSERVED";
  return record("V1", q, { verdict, notes }, { fully_resident: entry, forced_split: split });
}

// ── V2: does /api/ps return context_length? ───────────────────────────────────
async function v2(psModels, model) {
  const q = "Does this install return `context_length` in /api/ps?";
  // /api/ps lists loaded models only, so an empty host answers nothing. Load
  // the subject model first unless we are forbidden from sending requests.
  if (!psModels.length && !PASSIVE && model) {
    await loadOnly(model);
    await sleep(2000);
    psModels = (await ps()).json?.models ?? [];
  }
  const present = psModels.filter((m) => m.context_length !== undefined);
  const fields = psModels.length
    ? Object.keys(psModels[0]) : [];
  const verdict = !psModels.length ? "UNANSWERED (no model loaded)"
    : present.length === psModels.length ? "YES" : "PARTIAL";
  return record("V2", q, {
    verdict,
    notes: [
      `${present.length}/${psModels.length} loaded models carry context_length`,
      present.length ? `values: ${present.map((m) => `${m.name}=${m.context_length}`).join(", ")}` : "none",
      `all /api/ps per-model keys: ${fields.join(", ") || "(none)"}`,
    ],
  }, psModels);
}

// ── V3: does a request omitting num_ctx reload a non-default context? ─────────
async function v3(model) {
  const q = "If a model is loaded with a non-default context, does a request that omits num_ctx reload it at the default?";
  if (PASSIVE) return record("V3", q, { verdict: "SKIPPED (--passive)", notes: [] }, null);

  // Establish the server default from a clean load, not from whatever a
  // previous check left resident — reading the live value conflated "default"
  // with "previously requested".
  await unload(model); await sleep(1000);
  await loadOnly(model); await sleep(2000);
  const defaultCtx = Number(entryFor(await ps(), model)?.context_length ?? 4096);
  const bigCtx = defaultCtx * 2;

  await unload(model); await sleep(1000);
  await loadOnly(model, bigCtx); await sleep(2000);
  const loadedBig = entryFor(await ps(), model);

  // The decisive request: no num_ctx, exactly what the Wicklee probe sends.
  const noCtx = await generate(model);
  await sleep(1500);
  const after = entryFor(await ps(), model);

  const reloaded = (loadedBig?.context_length ?? null) !== (after?.context_length ?? null);
  const loadNs = noCtx.json?.load_duration ?? null;
  return record("V3", q, {
    verdict: reloaded ? "YES — omitting num_ctx reloads at the default" : "NO — running context survived",
    notes: [
      `server default context, from a clean load: ${defaultCtx}`,
      `after explicit num_ctx=${bigCtx}: context_length=${loadedBig?.context_length ?? "n/a"}`,
      `after a request with no num_ctx: context_length=${after?.context_length ?? "n/a"}`,
      `that request reported load_duration=${loadNs === null ? "n/a" : (loadNs / NS_PER_MS).toFixed(0) + " ms"} (>0 means it reloaded)`,
      reloaded
        ? "CONSEQUENCE: the existing probe and every test request MUST pass the running context_length."
        : "CONSEQUENCE: requests omitting num_ctx are safe for the loaded configuration.",
    ],
  }, { loaded_big: loadedBig, after_no_ctx: after, generate: noCtx.json });
}

// ── V4: which model does Ollama unload under pressure, and how many stay? ─────
async function v4(small, big) {
  const q = "Which model does Ollama unload when memory is short, and what limits how many stay loaded?";
  if (PASSIVE || !big) {
    return record("V4", q, { verdict: PASSIVE ? "SKIPPED (--passive)" : "UNANSWERED (no --big-model given)", notes: [] }, null);
  }
  const seq = [];
  await loadOnly(small); await sleep(2000);
  seq.push({ step: `load ${small}`, ps: (await ps()).json?.models?.map((m) => m.name) });
  await loadOnly(big); await sleep(3000);
  const afterBig = (await ps()).json?.models ?? [];
  seq.push({ step: `load ${big}`, ps: afterBig.map((m) => m.name) });

  const smallSurvived = afterBig.some((m) => m.name === small || m.model === small);
  return record("V4", q, {
    verdict: smallSurvived ? "BOTH STAYED LOADED" : `${small} WAS UNLOADED`,
    notes: [
      `after loading ${small}: [${seq[0].ps?.join(", ")}]`,
      `after loading ${big}:   [${seq[1].ps?.join(", ")}]`,
      smallSurvived
        ? "no eviction at these sizes — a victim cannot be named from this run"
        : `${small} went when ${big} arrived — one occurrence, not yet a Confirmed basis`,
      "OLLAMA_MAX_LOADED_MODELS / OLLAMA_NUM_PARALLEL on the server set the ceiling; neither is exposed over the API.",
    ],
  }, seq);
}

// ── V5: does expires_at move on every request, per model? ─────────────────────
async function v5(model) {
  const q = "Does expires_at move on every request, per model, and how closely does unload time follow it?";
  if (PASSIVE) return record("V5", q, { verdict: "SKIPPED (--passive)", notes: [] }, null);

  const ctx = Number(entryFor(await ps(), model)?.context_length) || undefined;
  const stamps = [];
  for (let i = 0; i < 3; i++) {
    const e = entryFor(await ps(), model);
    await generate(model, { numCtx: ctx });
    await sleep(1200);
    const after = entryFor(await ps(), model);
    stamps.push({ before: e?.expires_at ?? null, after: after?.expires_at ?? null, moved: e?.expires_at !== after?.expires_at });
  }
  const moved = stamps.filter((s) => s.moved).length;

  // Unload fidelity: set a 5 s keep-alive and watch when /api/ps drops it.
  await generate(model, { numCtx: ctx, keepAlive: 5 });
  const expiresAt = entryFor(await ps(), model)?.expires_at;
  const deadline = expiresAt ? new Date(expiresAt).getTime() : null;
  let goneAt = null;
  for (let i = 0; i < 40 && goneAt === null; i++) {
    await sleep(500);
    if (!entryFor(await ps(), model)) goneAt = Date.now();
  }
  const lag = deadline && goneAt ? goneAt - deadline : null;

  return record("V5", q, {
    verdict: moved === stamps.length ? "YES — every request moved expires_at" : `PARTIAL — ${moved}/${stamps.length} requests moved it`,
    notes: [
      ...stamps.map((s, i) => `request ${i + 1}: ${s.before} → ${s.after} (${s.moved ? "moved" : "unchanged"})`),
      deadline === null ? "keep_alive=5 did not yield an expires_at" :
        goneAt === null ? `still loaded 20 s past expires_at=${expiresAt}` :
        `unload observed ${lag >= 0 ? "+" : ""}${lag} ms relative to expires_at (poll resolution 500 ms)`,
    ],
  }, { stamps, expires_at: expiresAt, unload_lag_ms: lag });
}

// ── V6: is there any signal that a prompt was truncated? ──────────────────────
async function v6(model) {
  const q = "Is there any signal that a prompt was cut to fit the context?";
  if (PASSIVE) return record("V6", q, { verdict: "SKIPPED (--passive)", notes: [] }, null);

  const ctx = 512; // small, so an oversized prompt must be cut
  await unload(model); await sleep(1000);
  const oversized = "word ".repeat(4000); // ≈4k tokens into a 512-token context
  const r = await req("POST", "/api/generate", {
    model, prompt: oversized, stream: false,
    options: { num_ctx: ctx, num_predict: 4, temperature: 0, seed: 1 },
  });
  const keys = r.json ? Object.keys(r.json) : [];
  const pec = r.json?.prompt_eval_count ?? null;
  const truncationish = keys.filter((k) => /trunc|cut|drop|shift|discard|overflow/i.test(k));
  return record("V6", q, {
    verdict: truncationish.length ? `SIGNAL FOUND: ${truncationish.join(", ")}`
      : pec !== null && pec <= ctx ? "NO EXPLICIT SIGNAL (only prompt_eval_count <= num_ctx, which is indirect)"
      : "NO SIGNAL",
    notes: [
      `num_ctx=${ctx}, prompt ≈4000 words`,
      `prompt_eval_count=${pec}, done_reason=${r.json?.done_reason ?? "n/a"}`,
      `response keys: ${keys.join(", ")}`,
      truncationish.length ? "" : "CONSEQUENCE: the context_limit rule stays experimental and off by default.",
    ].filter(Boolean),
  }, r.json);
}

// ── V7: what does /api/tags return per installed model? ───────────────────────
async function v7(tagModels) {
  const q = "What does GET /api/tags return per installed model?";
  const first = tagModels[0] ?? null;
  return record("V7", q, {
    verdict: tagModels.length ? "ANSWERED" : "UNANSWERED (no installed models)",
    notes: [
      `${tagModels.length} models`,
      first ? `top-level keys: ${Object.keys(first).join(", ")}` : "",
      first ? `details keys: ${Object.keys(first.details ?? {}).join(", ")}` : "",
      first ? `size is the installed file size, e.g. ${first.name}=${first.size} bytes` : "",
    ].filter(Boolean),
  }, first);
}

// ── V8: do the agent's POST routes check the peer address? ────────────────────
// Answered by reading agent/src, not over HTTP — recorded here for completeness.
async function v8() {
  const q = "The agent binds 127.0.0.1 by default and can be set to 0.0.0.0. Do the POST routes check the peer address?";
  return record("V8", q, {
    verdict: "NO — verify against agent/src",
    notes: [
      "grep agent/src for ConnectInfo / into_make_service_with_connect_info / SocketAddr: no hits.",
      "main.rs serves `axum::serve(listener, app)`, so no handler can see the peer address.",
      "Phase 1 must add into_make_service_with_connect_info::<SocketAddr> before the first /v1 POST ships.",
    ],
  }, null);
}

// ── V9: can a model's blob be found and its page-cache state read? ────────────
async function v9(model, tagModels) {
  const q = "Can the agent find a model's file on disk and tell whether it is in the page cache?";
  const t = tagModels.find((m) => m.name === model);
  const digest = (t?.digest ?? "").replace(/^sha256[:-]/, "");
  const modelsDir = process.env.OLLAMA_MODELS ?? `${process.env.HOME}/.ollama/models`;
  const blob = digest ? `${modelsDir}/blobs/sha256-${digest}` : null;
  let exists = false, size = null;
  if (blob) {
    try { const fs = await import("node:fs"); const st = fs.statSync(blob); exists = true; size = st.size; } catch { /* not found */ }
  }
  return record("V9", q, {
    verdict: exists ? "FILE LOCATABLE, PAGE-CACHE STATE NOT READABLE" : "FILE NOT LOCATABLE FROM THE API ALONE",
    notes: [
      `/api/tags digest for ${model}: ${digest || "n/a"}`,
      blob ? `candidate blob: ${blob} (${exists ? `${size} bytes` : "missing"})` : "no digest to resolve",
      "The manifest digest is NOT the weights blob digest, so the mapping needs the manifest file, not just /api/tags.",
      "macOS has no mincore-equivalent reachable without unsafe FFI, which the no-unsafe rule forbids.",
      "CONSEQUENCE: cold receipts record ColdUnknown, as the spec already allows.",
    ],
  }, { digest, blob, exists, size });
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  const { tags: tagModels, ps: psModels } = await environment();
  if (!tagModels.length) { console.error("No installed models at this base URL."); process.exit(1); }

  const model = String(flag("model", psModels[0]?.name ?? tagModels[0].name));
  const big = flag("big-model") ? String(flag("big-model")) : null;

  if (!PASSIVE && !YES) {
    console.log(`\nThis will load and unload models on ${BASE} (${model}${big ? `, ${big}` : ""}).`);
    console.log("Stop or disable the Wicklee agent's probe first. Re-run with --yes to proceed, or --passive for read-only checks.");
    process.exit(2);
  }

  if (run("V2")) await v2(psModels, model);
  if (run("V7")) await v7(tagModels);
  if (run("V8")) await v8();
  if (run("V9")) await v9(model, tagModels);
  if (run("V1")) await v1(model);
  if (run("V3")) await v3(model);
  if (run("V5")) await v5(model);
  if (run("V4")) await v4(model, big);
  if (run("V6")) await v6(model);

  transcript.finished_at = new Date().toISOString();
  const fs = await import("node:fs");
  fs.writeFileSync(OUT, JSON.stringify(transcript, null, 2));
  console.log(`\nRaw transcript: ${OUT}`);
})();
