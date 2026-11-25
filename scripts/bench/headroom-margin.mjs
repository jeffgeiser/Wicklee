#!/usr/bin/env node
// Phase 1, step 9 — where does the runtime actually evict?
//
// Step 8 found that readiness can predict a fit that does not happen: it
// answered `requires_loading` with nothing displaced for a 5.65 GB model into
// 6.93 GB of reported free memory, and the runtime evicted the in-use model
// anyway, on all fifteen runs. The arithmetic was right. The budget it was
// done against was more generous than the runtime's own eviction policy.
//
// This measures the gap rather than guessing at it. For each ordered pair of
// declared models it loads the first, loads the second, and records whether
// both stayed resident — alongside what `/v1/readiness` predicted beforehand.
// The output is a table of predicted against actual, and the largest total
// that coexisted against the smallest that evicted. Those two numbers bracket
// the runtime's real threshold.
//
//   node scripts/bench/headroom-margin.mjs --scenarios scripts/bench/scenarios.json --yes
//
// Options
//   --scenarios <path>  Scenario file (see scenarios.example.json)
//   --context <n>       Context to load every model at (default: contexts.fits)
//   --out <path>        Raw JSON transcript
//   --yes               Skip the consent prompt
//   --plan              Print the pairs it would try and exit
//
// NOTHING HERE CHANGES A THRESHOLD. One host is not evidence for a constant
// that ships. The point is to produce the same table on several machines so a
// margin can be set from measurements rather than from one M4.

import { loadScenarios, DEFAULT_SCENARIOS_PATH } from "./lib/scenarios.mjs";

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const SCENARIOS_PATH = String(flag("scenarios", DEFAULT_SCENARIOS_PATH));
const OUT = String(flag("out", `./headroom-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
const YES = args.includes("--yes");
const PLAN = args.includes("--plan");

const fs = await import("node:fs/promises");
const cfg = await loadScenarios(SCENARIOS_PATH);
const OLLAMA = String(cfg.ollama_base_url).replace(/\/+$/, "");
const AGENT = String(cfg.agent_base_url).replace(/\/+$/, "");
const CTX = Number(flag("context", cfg.contexts?.fits ?? 8192));
const MODELS = Object.values(cfg.models).filter((m) => m?.name);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GB = (b) => Math.round((b / 1e9) * 100) / 100;

async function j(url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    throw new Error(`${url} did not return JSON (HTTP ${r.status})`);
  }
}

const generate = (name, opts = {}) =>
  j(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: name,
      prompt: opts.prompt ?? "hi",
      stream: false,
      keep_alive: opts.keep_alive ?? "900s",
      options: { num_ctx: CTX, num_predict: opts.num_predict ?? 2 },
    }),
  }).then((r) => r.body);

const unload = (name) => generate(name, { keep_alive: 0, prompt: "" }).catch(() => {});
const ps = async () => (await j(`${OLLAMA}/api/ps`)).body.models ?? [];
const nameOf = (m) => m.name ?? m.model;

/// What readiness says about one model right now.
async function predict(name) {
  const { body } = await j(`${AGENT}/v1/readiness?model=${encodeURIComponent(name)}`);
  const r = body.readiness ?? null;
  return {
    readiness: r?.readiness ?? null,
    fit_basis: r?.fit_basis ?? null,
    footprint_bytes: r?.footprint?.bytes ?? null,
    headroom_bytes: body.headroom?.free_bytes ?? null,
    headroom_source: body.headroom?.source ?? null,
    safety_margin_bytes: r?.safety_margin_bytes ?? null,
    would_displace: (r?.would_displace ?? []).map((v) => ({ model: v.model, in_use: v.in_use })),
  };
}

const pairs = [];
for (const a of MODELS) {
  for (const b of MODELS) {
    if (a.name !== b.name) pairs.push([a, b]);
  }
}

console.log(`Headroom margin — ${cfg.host?.label ?? "unlabelled host"}`);
console.log(`  runtime ${OLLAMA}`);
console.log(`  agent   ${AGENT}`);
console.log(`  every model loaded at context ${CTX}`);
console.log(`  ${pairs.length} ordered pairs: load the first, then the second, see if both stay`);
console.log("");
for (const [a, b] of pairs) console.log(`  ${a.name} then ${b.name}`);
console.log("");

if (PLAN) process.exit(0);
if (!YES) {
  console.log("This loads and unloads models on that runtime. Re-run with --yes to proceed.");
  process.exit(1);
}
if (OLLAMA.includes(":11434") || AGENT.includes(":7700")) {
  console.log("Refusing: :11434 and :7700 are the default runtime and the installed agent.");
  process.exit(2);
}

const transcript = {
  started_at: new Date().toISOString(),
  host: cfg.host ?? null,
  context: CTX,
  env: {},
  pairs: [],
};
try {
  transcript.env.agent_version = (await j(`${AGENT}/api/health`)).body.agent_version;
} catch { /* reported by the first pair */ }
try {
  transcript.env.ollama_version = (await j(`${OLLAMA}/api/version`)).body.version;
} catch { /* not fatal */ }

for (const [a, b] of pairs) {
  process.stdout.write(`  ${a.name} + ${b.name} … `);

  // Start from nothing resident, so the pair is the only thing in memory.
  for (const m of MODELS) await unload(m.name);
  await sleep(1500);

  // First model, then make it recently used so readiness reports it in use —
  // which is the state the displacement question is actually asked in.
  await generate(a.name, { num_predict: 4 });
  await sleep(9000);

  const first = (await ps()).find((m) => nameOf(m) === a.name);
  const predicted = await predict(b.name).catch((e) => ({ error: e.message }));

  await generate(b.name, { num_predict: 2 });
  await sleep(1500);

  const after = await ps();
  const names = after.map(nameOf);
  const both = names.includes(a.name) && names.includes(b.name);
  const total = after.reduce((s, m) => s + (m.size ?? 0), 0);

  // What readiness said, in the terms this measurement can judge.
  const saidWouldDisplace =
    predicted.readiness === "would_displace" ||
    predicted.readiness === "may_require_eviction" ||
    (predicted.would_displace ?? []).length > 0;

  const row = {
    first: a.name,
    second: b.name,
    first_resident_bytes: first?.size ?? null,
    predicted,
    both_resident: both,
    resident_after: names,
    total_bytes_after: total,
    // The number the margin question turns on: what the two would have needed
    // together, from the first model's measured size and the second's.
    attempted_total_bytes:
      (first?.size ?? 0) + (after.find((m) => nameOf(m) === b.name)?.size ?? 0),
    verdict: both
      ? saidWouldDisplace
        ? "pessimistic"
        : "correct"
      : saidWouldDisplace
        ? "correct"
        : "optimistic",
  };
  transcript.pairs.push(row);
  console.log(
    `${both ? "both resident" : "evicted"}  ` +
      `predicted ${predicted.readiness ?? "?"} (${predicted.fit_basis ?? "?"}, ` +
      `${GB(predicted.footprint_bytes ?? 0)}GB into ${GB(predicted.headroom_bytes ?? 0)}GB free) ` +
      `→ ${row.verdict}`,
  );
}

// Bracket the runtime's real threshold.
const coexisted = transcript.pairs.filter((p) => p.both_resident).map((p) => p.total_bytes_after);
const evicted = transcript.pairs
  .filter((p) => !p.both_resident && p.attempted_total_bytes > 0)
  .map((p) => p.attempted_total_bytes);

transcript.bracket = {
  largest_coexisting_bytes: coexisted.length ? Math.max(...coexisted) : null,
  smallest_evicting_attempt_bytes: evicted.length ? Math.min(...evicted) : null,
  agent_budget_bytes: (() => {
    // The budget the agent is working from: reported free plus what was
    // resident when it reported it.
    const p = transcript.pairs.find((x) => x.predicted?.headroom_bytes && x.first_resident_bytes);
    return p ? p.predicted.headroom_bytes + p.first_resident_bytes : null;
  })(),
  headroom_source: transcript.pairs.find((p) => p.predicted?.headroom_source)?.predicted
    ?.headroom_source ?? null,
};

const tally = transcript.pairs.reduce((acc, p) => ({ ...acc, [p.verdict]: (acc[p.verdict] ?? 0) + 1 }), {});
transcript.summary = tally;
transcript.finished_at = new Date().toISOString();
await fs.writeFile(OUT, JSON.stringify(transcript, null, 2));

console.log("");
console.log(Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", "));
const br = transcript.bracket;
if (br.largest_coexisting_bytes) console.log(`largest pair that coexisted:  ${GB(br.largest_coexisting_bytes)} GB`);
if (br.smallest_evicting_attempt_bytes) console.log(`smallest pair that evicted:   ${GB(br.smallest_evicting_attempt_bytes)} GB`);
if (br.agent_budget_bytes) console.log(`budget the agent works from:  ${GB(br.agent_budget_bytes)} GB (${br.headroom_source})`);
console.log(`transcript: ${OUT}`);

// An optimistic prediction is the failure that matters: it is the one that
// costs someone their loaded model. Pessimistic is a missed opportunity.
process.exit(tally.optimistic ? 1 : 0);
