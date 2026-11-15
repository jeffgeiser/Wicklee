#!/usr/bin/env node
// Phase 1, step 8 — fault injection.
//
// Creates each condition the diagnostic rules are meant to catch, then asks
// the agent whether it caught it. No dependencies. Node 18+ (global fetch).
//
//   node scripts/bench/fault-inject.mjs --scenarios scripts/bench/scenarios.json --yes
//
// Options
//   --scenarios <path>  Scenario file (see scenarios.example.json)
//   --only <list>       Comma-separated subset, e.g. --only context_reset,healthy
//   --out <path>        Raw JSON transcript
//   --yes               Skip the consent prompt
//   --plan              Print what each scenario would do and exit
//
// WARNING: every scenario except `healthy` loads and unloads models on the
// target runtime. Point it at one you control — a second `ollama serve` on its
// own port, with the agent pinned to that port via WICKLEE_OLLAMA_PORT and
// started with --no-cloud. Running it against the runtime your installed
// service is watching pollutes that service's own attribution.
//
// WHAT A PASS MEANS. The harness asserts the expected rule fired and prints the
// statement it produced, so the words can be read rather than trusted. A
// scenario that cannot be induced on this hardware is reported as
// `not_inducible` with the reason, which is a result, not a skip. A scenario
// that induces the condition and gets no finding is a failure, and the raw
// transcript holds the whole /v1/inspect body for working out why.

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const SCENARIOS_PATH = String(flag("scenarios", "scripts/bench/scenarios.json"));
const ONLY = flag("only") ? String(flag("only")).split(",").map((s) => s.trim()) : null;
const OUT = String(flag("out", `./fault-inject-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
const YES = args.includes("--yes");
const PLAN = args.includes("--plan");

const fs = await import("node:fs/promises");

let cfg;
try {
  cfg = JSON.parse(await fs.readFile(SCENARIOS_PATH, "utf8"));
} catch (e) {
  console.error(`could not read ${SCENARIOS_PATH}: ${e.message}`);
  console.error("Copy scripts/bench/scenarios.example.json and fill it in for your hardware.");
  process.exit(2);
}

const OLLAMA = String(cfg.ollama_base_url).replace(/\/+$/, "");
const AGENT = String(cfg.agent_base_url).replace(/\/+$/, "");
const M = (key) => {
  const m = cfg.models?.[key];
  if (!m?.name) throw new Error(`scenario file has no models.${key}.name`);
  return m;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The agent polls /api/ps every 5 s and evaluates on request, so a condition
// has to sit still long enough to be seen. 8 s is one poll plus slack; a
// shorter wait makes a rule look broken when it was only early.
const OBSERVE_MS = 8000;

async function j(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // The agent's SPA fallback answers unknown paths with 200 and HTML, so a
    // body that is not JSON means the route is absent, not that it failed.
    throw new Error(`${url} did not return JSON (HTTP ${r.status}) — is this build serving /v1?`);
  }
  return { status: r.status, body };
}

async function generate(model, { num_ctx, keep_alive, prompt = "hi", num_predict = 1 } = {}) {
  const body = { model, prompt, stream: false, options: { num_predict } };
  if (num_ctx !== undefined) body.options.num_ctx = num_ctx;
  if (keep_alive !== undefined) body.keep_alive = keep_alive;
  const started = Date.now();
  const { body: out } = await j(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ...out, wall_ms: Date.now() - started };
}

const unload = (model) => generate(model, { keep_alive: 0, prompt: "" });

async function ps() {
  const { body } = await j(`${OLLAMA}/api/ps`);
  return body.models ?? [];
}

async function inspect() {
  const { body } = await j(`${AGENT}/v1/inspect`);
  return body;
}

/// Wait until the runtime stops listing a model, so a measurement that
/// depends on it being gone is not taken while it is still there.
async function waitAbsent(model, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await ps()).some((m) => m.name === model || m.model === model)) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

function findingsFor(body, rule) {
  return (body.findings ?? []).filter((f) => f.rule === rule);
}

function statementsOf(f) {
  return (f.statements ?? []).map((s) => `${s.label}: ${s.text}`);
}

// ── Scenarios ────────────────────────────────────────────────────────────────
//
// Each returns { status, detail, finding? }. `status` is one of:
//   fired         — the condition was induced and the expected rule caught it
//   missed        — induced, and nothing caught it. A failure
//   not_inducible — this hardware cannot produce the condition. A result
//   quiet         — for the healthy control, where no finding is the pass

const scenarios = {
  cpu_split: {
    expects: "cpu_split",
    plan: () =>
      `load ${M("small").name} at context ${cfg.contexts.too_large_for_accelerator} so part of it ` +
      `sits outside accelerator memory`,
    async run() {
      const model = M("small").name;
      const ctx = cfg.contexts.too_large_for_accelerator;
      await unload(model).catch(() => {});
      await waitAbsent(model);
      const r = await generate(model, { num_ctx: ctx, keep_alive: "300s" });
      await sleep(OBSERVE_MS);

      const live = (await ps()).find((m) => (m.name ?? m.model) === model);
      if (!live) {
        return { status: "missed", detail: `${model} did not stay loaded at context ${ctx}` };
      }
      // Unified memory reports size_vram equal to size: there is one pool, so
      // nothing is "outside" it and the split this rule looks for cannot
      // exist. Reported rather than skipped, because "no finding" here is a
      // property of the hardware and not of the rule.
      if (live.size_vram >= live.size) {
        return {
          status: "not_inducible",
          detail:
            `the runtime reports size_vram (${live.size_vram}) equal to size (${live.size}) at ` +
            `context ${ctx}. On unified memory there is one pool, so no part of the footprint is ` +
            `outside the accelerator and cpu_split has nothing to see. Inducible on a discrete GPU`,
          load_ms: Math.round((r.load_duration ?? 0) / 1e6),
        };
      }
      const got = findingsFor(await inspect(), "cpu_split");
      return got.length
        ? { status: "fired", finding: got[0], detail: statementsOf(got[0]).join(" | ") }
        : { status: "missed", detail: `size_vram ${live.size_vram} < size ${live.size} but no finding` };
    },
  },

  context_reset: {
    expects: "context_reset",
    plan: () =>
      `load ${M("small").name} at ${cfg.contexts.fits}, then request it without num_ctx so the ` +
      `runtime reloads it at ${cfg.contexts.runtime_default}. Twice, because one reset is an ` +
      `event and the rule reports a pattern`,
    async run() {
      const model = M("small").name;
      // Two full cycles: the rule needs more than one reset before it calls
      // this a pattern, and a single drop is a thing that happened once.
      for (let i = 0; i < 2; i++) {
        await generate(model, { num_ctx: cfg.contexts.fits, keep_alive: "900s" });
        await sleep(OBSERVE_MS);
        // No num_ctx at all — this is the caller mistake the rule is about.
        await generate(model, { keep_alive: "900s" });
        await sleep(OBSERVE_MS);
      }
      const got = findingsFor(await inspect(), "context_reset");
      return got.length
        ? { status: "fired", finding: got[0], detail: statementsOf(got[0]).join(" | ") }
        : { status: "missed", detail: "two reloads at the runtime default produced no finding" };
    },
  },

  eviction_churn: {
    expects: "eviction_churn",
    plan: () => {
      const a = M("large"), b = M("other");
      return (
        `alternate requests between ${a.name} (${a.resident_gb} GB) and ${b.name} ` +
        `(${b.resident_gb} GB), which together exceed the declared accelerator budget of ` +
        `${cfg.host.accelerator_budget_gb} GB, so each load evicts the other`
      );
    },
    async run() {
      const a = M("large").name, b = M("other").name;
      const budget = Number(cfg.host.accelerator_budget_gb ?? 0);
      const need = Number(M("large").resident_gb ?? 0) + Number(M("other").resident_gb ?? 0);
      if (budget > 0 && need <= budget) {
        return {
          status: "not_inducible",
          detail:
            `${a} and ${b} need ${need.toFixed(1)} GB together, which fits in the declared ` +
            `${budget} GB budget, so neither evicts the other. Declare two larger models`,
        };
      }
      for (let i = 0; i < 3; i++) {
        await generate(a, { num_ctx: cfg.contexts.fits, keep_alive: "900s" });
        await sleep(OBSERVE_MS);
        await generate(b, { num_ctx: cfg.contexts.fits, keep_alive: "900s" });
        await sleep(OBSERVE_MS);
      }
      const got = findingsFor(await inspect(), "eviction_churn");
      return got.length
        ? { status: "fired", finding: got[0], detail: statementsOf(got[0]).join(" | ") }
        : { status: "missed", detail: `three alternations between ${a} and ${b} produced no finding` };
    },
  },

  expiry_reload: {
    expects: "expiry_reload",
    plan: () =>
      `request ${M("small").name} with keep_alive 10s, pause 15s so it expires, and repeat. The ` +
      `rule counts reload-after-expiry pairs`,
    async run() {
      const model = M("small").name;
      // Four cycles for a rule that wants three pairs: one may be swallowed if
      // a poll lands between the expiry and the reload.
      for (let i = 0; i < 4; i++) {
        await generate(model, { num_ctx: cfg.contexts.fits, keep_alive: "10s" });
        await sleep(15000);
      }
      await sleep(OBSERVE_MS);
      const got = findingsFor(await inspect(), "expiry_reload");
      return got.length
        ? { status: "fired", finding: got[0], detail: statementsOf(got[0]).join(" | ") }
        : { status: "missed", detail: "four expire-and-reload cycles produced no finding" };
    },
  },

  baseline_regression: {
    expects: "baseline_regression",
    plan: () =>
      `fingerprint ${M("small").name}, then co-load ${M("large").name} to contend for memory and ` +
      `fingerprint again at the same context`,
    async run() {
      const small = M("small").name, large = M("large").name;
      const ctx = cfg.contexts.fits;

      // NOTE ON THE SPEC. Its fault-injection table induces this by
      // "fingerprint, then repeat with a larger context". That cannot fire the
      // rule as written: the rule compares a model against its own baseline at
      // the SAME digest and context, precisely so a context change someone
      // made on purpose is not reported as a regression. So the induction here
      // keeps the context fixed and makes the host slower instead.
      await generate(small, { num_ctx: ctx, keep_alive: "900s" });
      await sleep(OBSERVE_MS);
      const before = await fingerprint(small);

      await generate(large, { num_ctx: ctx, keep_alive: "900s" });
      await sleep(OBSERVE_MS);
      const after = await fingerprint(small);

      const got = findingsFor(await inspect(), "baseline_regression");
      const rates = {
        before_tok_s: before?.median ?? null,
        after_tok_s: after?.median ?? null,
      };
      if (got.length) {
        return { status: "fired", finding: got[0], detail: statementsOf(got[0]).join(" | "), rates };
      }
      const drop =
        rates.before_tok_s && rates.after_tok_s
          ? ((rates.before_tok_s - rates.after_tok_s) / rates.before_tok_s) * 100
          : null;
      return {
        status: drop !== null && drop < 20 ? "not_inducible" : "missed",
        detail:
          drop === null
            ? "the two fingerprint runs did not both produce a rate"
            : `the rate moved ${drop.toFixed(1)}%, under the 20% the rule requires. ` +
              `Co-loading ${large} did not slow ${small} enough on this hardware`,
        rates,
      };
    },
  },

  healthy: {
    expects: null,
    plan: () => `steady requests to ${M("small").name} at a context that fits, nothing else loaded`,
    async run() {
      const model = M("small").name;
      for (const other of Object.values(cfg.models)) {
        if (other.name !== model) await unload(other.name).catch(() => {});
      }
      for (let i = 0; i < 4; i++) {
        await generate(model, { num_ctx: cfg.contexts.fits, keep_alive: "900s", num_predict: 8 });
        await sleep(3000);
      }
      await sleep(OBSERVE_MS);
      const body = await inspect();
      // The hardware patterns are not what this control is about: they read
      // the metrics store over its own window and can carry something from
      // before the run. The diagnostic rules are the claim here.
      const rules = ["cpu_split", "context_reset", "eviction_churn", "expiry_reload", "baseline_regression"];
      const noisy = (body.findings ?? []).filter((f) => rules.includes(f.rule));
      return noisy.length
        ? { status: "missed", detail: `expected quiet, got: ${noisy.map((f) => f.rule).join(", ")}` }
        : {
            status: "quiet",
            detail:
              `no diagnostic findings. Other findings present: ` +
              `${(body.findings ?? []).map((f) => f.rule).join(", ") || "none"}`,
          };
    },
  },
};

/// One fingerprint run through the agent, consented from here.
async function fingerprint(model) {
  const { status, body } = await j(`${AGENT}/v1/fingerprint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "decode_rate", models: [model], consent: true, force: true }),
  });
  if (status !== 200) return null;
  return body.outcome?.results?.[0]?.decode_tps ?? null;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const chosen = Object.keys(scenarios).filter((k) => !ONLY || ONLY.includes(k));
if (!chosen.length) {
  console.error(`no scenarios matched --only. Available: ${Object.keys(scenarios).join(", ")}`);
  process.exit(2);
}

console.log(`Fault injection — ${cfg.host?.label ?? "unlabelled host"}`);
console.log(`  runtime ${OLLAMA}`);
console.log(`  agent   ${AGENT}`);
console.log("");
for (const name of chosen) {
  console.log(`  ${name}`);
  console.log(`      ${scenarios[name].plan()}`);
}
console.log("");

if (PLAN) process.exit(0);

if (!YES) {
  console.log("This loads and unloads models on that runtime. Re-run with --yes to proceed.");
  process.exit(1);
}

// Refuse to run against the runtime the installed service watches: its probe
// resets expires_at, which the agent attributes to a user request, and the
// transitions this harness is trying to create would be mixed with them.
if (OLLAMA.includes(":11434") || AGENT.includes(":7700")) {
  console.log("Refusing: :11434 and :7700 are the default runtime and the installed agent.");
  console.log("Start a private `ollama serve` on another port and an agent with");
  console.log("WICKLEE_OLLAMA_PORT and --no-cloud, then point the scenario file at those.");
  process.exit(2);
}

const transcript = {
  started_at: new Date().toISOString(),
  host: cfg.host ?? null,
  ollama_base_url: OLLAMA,
  agent_base_url: AGENT,
  env: {},
  results: {},
};

try {
  const { body } = await j(`${AGENT}/api/health`);
  transcript.env.agent_version = body.agent_version;
  transcript.env.store_healthy = body.store_healthy;
} catch {
  console.log("warning: could not read /api/health — is the agent running?");
}
try {
  const { body } = await j(`${OLLAMA}/api/version`);
  transcript.env.ollama_version = body.version;
} catch { /* not fatal */ }

for (const name of chosen) {
  process.stdout.write(`${name} … `);
  const started = Date.now();
  let result;
  try {
    result = await scenarios[name].run();
  } catch (e) {
    result = { status: "error", detail: e.message };
  }
  result.took_s = Math.round((Date.now() - started) / 100) / 10;
  result.expects = scenarios[name].expects;
  transcript.results[name] = result;
  console.log(`${result.status} (${result.took_s}s)`);
  if (result.detail) console.log(`    ${result.detail}`);
  if (result.rates) console.log(`    rates: ${JSON.stringify(result.rates)}`);
}

// A final /v1/inspect, whole, so a missed scenario can be worked out from the
// transcript rather than re-run.
try {
  transcript.final_inspect = await inspect();
} catch { /* already reported */ }

transcript.finished_at = new Date().toISOString();
await fs.writeFile(OUT, JSON.stringify(transcript, null, 2));

console.log("");
const tally = Object.entries(transcript.results).reduce((acc, [, r]) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});
console.log(Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", "));
console.log(`transcript: ${OUT}`);

// Missed and error are failures; not_inducible is a result about the hardware.
const failed = Object.values(transcript.results).filter((r) => r.status === "missed" || r.status === "error");
process.exit(failed.length ? 1 : 0);
