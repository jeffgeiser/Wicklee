#!/usr/bin/env node
// Phase 1, step 8 — the reference controller.
//
// Three policies choose a model for one step of a workflow, on a host where
// another workflow is already holding a model. The question is whether reading
// readiness changes the decision, and whether the change is worth anything.
// No dependencies. Node 18+ (global fetch).
//
//   node scripts/bench/reference-controller.mjs --scenarios scripts/bench/scenarios.json --yes
//
// Options
//   --scenarios <path>  Scenario file (see scenarios.example.json)
//   --runs <n>          Runs per policy (default 5)
//   --out <path>        Raw JSON transcript
//   --md <path>         Summary table as Markdown
//   --yes               Skip the consent prompt
//   --plan              Print what it would do and exit
//
// WHAT IS BEING TESTED, AND WHAT A NULL RESULT MEANS.
//
// `loaded_check` is the honest baseline, not `naive`. Any competent controller
// reads /api/ps before choosing, so beating `naive` proves nothing. Wicklee
// should win only where /api/ps cannot see the answer: when no acceptable
// option is loaded and one choice would evict the model the other workflow is
// using while another would fit beside it.
//
// So a tie is a real and publishable outcome. On a host with enough memory for
// every option, all three policies make the same choice and the right report
// says so. The spec is explicit that this demonstration does not gate the
// release: a null result is a finding about whether readiness adds anything
// beyond a loaded-model check on this hardware, and says nothing about whether
// the diagnostics are useful.
//
// WARNING: loads and unloads models on the target runtime. Point it at one you
// control.

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const SCENARIOS_PATH = String(flag("scenarios", "scripts/bench/scenarios.json"));
const RUNS = Number(flag("runs", 5));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = String(flag("out", `./controller-${stamp}.json`));
const MD = String(flag("md", `./controller-${stamp}.md`));
const YES = args.includes("--yes");
const PLAN = args.includes("--plan");

const fs = await import("node:fs/promises");

let cfg;
try {
  cfg = JSON.parse(await fs.readFile(SCENARIOS_PATH, "utf8"));
} catch (e) {
  console.error(`could not read ${SCENARIOS_PATH}: ${e.message}`);
  process.exit(2);
}

const OLLAMA = String(cfg.ollama_base_url).replace(/\/+$/, "");
const AGENT = String(cfg.agent_base_url).replace(/\/+$/, "");
const W = cfg.workflow ?? {};
const model = (key) => {
  const m = cfg.models?.[key];
  if (!m?.name) throw new Error(`scenario file has no models.${key}.name`);
  return m;
};
const HELD = model(W.held ?? "other");
const ACCEPTABLE = (W.acceptable ?? []).map(model);
if (!ACCEPTABLE.length) {
  console.error("scenario file declares no workflow.acceptable options");
  process.exit(2);
}
const CTX = cfg.contexts?.fits ?? 8192;
const DEFER_ALLOWED = W.defer_allowed !== false;
const DEFER_TIMEOUT_S = Number(W.defer_timeout_s ?? 30);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`${url} did not return JSON (HTTP ${r.status})`);
  }
}

async function generate(name, { num_ctx = CTX, keep_alive = "900s", num_predict = 1, prompt = "hi" } = {}) {
  const started = Date.now();
  const { body } = await j(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, prompt, stream: false, keep_alive, options: { num_ctx, num_predict } }),
  });
  return { ...body, wall_ms: Date.now() - started };
}

const ps = async () => (await j(`${OLLAMA}/api/ps`)).body.models ?? [];
const nameOf = (m) => m.name ?? m.model;

async function readiness() {
  const { body } = await j(`${AGENT}/v1/readiness`);
  const rows = Array.isArray(body.readiness) ? body.readiness : [body.readiness].filter(Boolean);
  return rows;
}

/// Total transitions the agent has recorded, so a run's reload count is a
/// difference rather than a guess. The agent's own count, not the harness's:
/// a reload the harness did not cause still cost the host.
async function transitionCount() {
  try {
    const { body } = await j(`${AGENT}/v1/inspect`);
    return body.history?.transitions ?? null;
  } catch {
    return null;
  }
}

// ── The three policies ───────────────────────────────────────────────────────

const policies = {
  /// Always the preferred option. The strawman, included because it is what a
  /// controller written without any of this does.
  naive: async () => ({ choice: ACCEPTABLE[0], reason: "preferred option, unconditionally" }),

  /// Reads /api/ps and prefers something already loaded. The real baseline:
  /// this is what a careful integration does today, with no Wicklee at all.
  loaded_check: async () => {
    const loaded = (await ps()).map(nameOf);
    const hit = ACCEPTABLE.find((m) => loaded.includes(m.name));
    return hit
      ? { choice: hit, reason: `${hit.name} is already loaded` }
      : { choice: ACCEPTABLE[0], reason: "none of the acceptable options is loaded" };
  },

  /// Reads /v1/readiness. Skips anything that would displace a model in use,
  /// takes the best of what is left, and defers when nothing is safe.
  wicklee: async () => {
    const rows = await readiness();
    const by = new Map(rows.map((r) => [r.model, r]));

    const safe = [];
    const unsafe = [];
    for (const m of ACCEPTABLE) {
      const r = by.get(m.name);
      if (!r) {
        // No answer is not a safe answer. Treated as unsafe rather than
        // optimistically allowed, which is the whole point of the policy.
        unsafe.push({ model: m, why: "readiness has no answer for it" });
        continue;
      }
      // in_use is Option<bool>: null means this runtime gives no activity
      // signal at all. Treated as unsafe rather than as "not in use", because
      // an optimistic reading of an unknown is the exact mistake this policy
      // exists to avoid — and because the first draft of it read null as
      // false, which would have made the policy identical to loaded_check on
      // any runtime without expires_at.
      const victims = r.would_displace ?? [];
      const inUse = victims.filter((v) => v.in_use === true);
      const unknown = victims.filter((v) => v.in_use === null || v.in_use === undefined);
      if (inUse.length) {
        unsafe.push({ model: m, why: `would displace ${inUse.map((v) => v.model).join(", ")}, in use` });
      } else if (unknown.length) {
        unsafe.push({
          model: m,
          why: `would displace ${unknown.map((v) => v.model).join(", ")}, and this runtime reports no activity signal`,
        });
      } else if (r.readiness === "cannot_determine") {
        unsafe.push({ model: m, why: "readiness cannot determine it" });
      } else {
        safe.push({ model: m, readiness: r.readiness });
      }
    }

    if (safe.length) {
      // Already resident beats needing a load, and the declared preference
      // order breaks the remaining tie. Preference is the operator's; Wicklee
      // does not judge whether two models are equivalent.
      safe.sort((a, b) => {
        const rank = (x) => (x.readiness === "ready_now" ? 0 : 1);
        return rank(a) - rank(b) || ACCEPTABLE.indexOf(a.model) - ACCEPTABLE.indexOf(b.model);
      });
      const pick = safe[0];
      return {
        choice: pick.model,
        reason: `${pick.model.name} is ${pick.readiness} and displaces nothing in use`,
        considered: { safe: safe.map((s) => s.model.name), unsafe: unsafe.map((u) => `${u.model.name} (${u.why})`) },
      };
    }

    if (DEFER_ALLOWED) {
      return {
        choice: null,
        deferred: true,
        reason: `no acceptable option is safe: ${unsafe.map((u) => `${u.model.name} ${u.why}`).join("; ")}`,
      };
    }
    return {
      choice: ACCEPTABLE[0],
      reason: `nothing safe and the scenario forbids deferring, so the preferred option anyway`,
      considered: { safe: [], unsafe: unsafe.map((u) => `${u.model.name} (${u.why})`) },
    };
  },
};

// ── One run ──────────────────────────────────────────────────────────────────

/// Put the host into the state the demo is about: workflow A's model loaded
/// and recently used, nothing else resident.
async function setup() {
  for (const m of Object.values(cfg.models)) {
    if (m.name !== HELD.name) {
      await generate(m.name, { keep_alive: 0, prompt: "" }).catch(() => {});
    }
  }
  await generate(HELD.name, { num_predict: 4 });
  // Long enough for the agent to poll /api/ps and attribute the expiry reset
  // to a real caller, which is what makes HELD read as in use.
  await sleep(8000);
}

async function runOnce(policyName) {
  const before = await transitionCount();
  const heldBefore = (await ps()).some((m) => nameOf(m) === HELD.name);

  const decided = Date.now();
  const decision = await policies[policyName]();
  const decide_ms = Date.now() - decided;

  let step_ms = null;
  let deferred_ms = 0;

  if (decision.deferred) {
    // A deferral is not free and must not be scored as if it were. The step
    // waits, then runs on whatever has become safe — or on the preferred
    // option once the wait runs out, which is the honest worst case.
    const until = Date.now() + DEFER_TIMEOUT_S * 1000;
    for (;;) {
      await sleep(2000);
      const retry = await policies.wicklee();
      if (retry.choice) {
        deferred_ms = Date.now() - (until - DEFER_TIMEOUT_S * 1000);
        decision.choice = retry.choice;
        decision.reason = `deferred ${Math.round(deferred_ms / 1000)}s, then ${retry.reason}`;
        break;
      }
      if (Date.now() > until) {
        deferred_ms = DEFER_TIMEOUT_S * 1000;
        decision.choice = ACCEPTABLE[0];
        decision.reason = `deferred ${DEFER_TIMEOUT_S}s, nothing became safe, ran the preferred option`;
        break;
      }
    }
  }

  const step = await generate(decision.choice.name, { num_predict: 32 });
  step_ms = step.wall_ms;

  // Workflow A's next request. Its latency is the cost of workflow B's
  // decision: if B evicted A's model, A pays the reload here.
  const a = await generate(HELD.name, { num_predict: 8 });
  const a_reloaded = (a.load_duration ?? 0) > 100e6;

  const after = await transitionCount();
  return {
    policy: policyName,
    chose: decision.choice.name,
    reason: decision.reason,
    considered: decision.considered ?? null,
    held_loaded_before: heldBefore,
    decide_ms,
    deferred_ms,
    // End to end for workflow B's step, deferral included, because a decision
    // that waits has spent the operator's time too.
    step_total_ms: step_ms + deferred_ms,
    step_ms,
    workflow_a_ms: a.wall_ms,
    workflow_a_reloaded: a_reloaded,
    workflow_a_load_ms: Math.round((a.load_duration ?? 0) / 1e6),
    displaced_in_use: heldBefore && a_reloaded,
    transitions_added: before !== null && after !== null ? after - before : null,
  };
}

// ── Stats ────────────────────────────────────────────────────────────────────

function stats(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return {
    median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2,
    low: v[0],
    high: v[v.length - 1],
    n: v.length,
  };
}

const fmt = (s) => (s ? `${Math.round(s.median)} (${Math.round(s.low)}–${Math.round(s.high)})` : "—");

// ── Run ──────────────────────────────────────────────────────────────────────

console.log(`Reference controller — ${cfg.host?.label ?? "unlabelled host"}`);
console.log(`  runtime ${OLLAMA}`);
console.log(`  agent   ${AGENT}`);
console.log(`  workflow A holds ${HELD.name} (${HELD.resident_gb} GB)`);
console.log(`  workflow B may use ${ACCEPTABLE.map((m) => `${m.name} (${m.resident_gb} GB)`).join(" or ")}`);
console.log(`  accelerator budget ${cfg.host?.accelerator_budget_gb ?? "undeclared"} GB`);
console.log(`  ${RUNS} runs per policy, randomised order, deferring ${DEFER_ALLOWED ? "allowed" : "forbidden"}`);
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

// Randomised order, so a thermal drift over the session cannot be read as one
// policy being faster than another.
const order = [];
for (let i = 0; i < RUNS; i++) order.push(...Object.keys(policies));
for (let i = order.length - 1; i > 0; i--) {
  const k = Math.floor(Math.random() * (i + 1));
  [order[i], order[k]] = [order[k], order[i]];
}

const transcript = {
  started_at: new Date().toISOString(),
  host: cfg.host ?? null,
  workflow: { held: HELD, acceptable: ACCEPTABLE, defer_allowed: DEFER_ALLOWED },
  runs_per_policy: RUNS,
  order,
  env: {},
  runs: [],
};
try {
  const { body } = await j(`${AGENT}/api/health`);
  transcript.env.agent_version = body.agent_version;
} catch { /* reported below */ }
try {
  const { body } = await j(`${OLLAMA}/api/version`);
  transcript.env.ollama_version = body.version;
} catch { /* not fatal */ }
try {
  const { body } = await j(`${AGENT}/v1/state`);
  transcript.env.models = (body.models ?? []).map((m) => ({
    model: m.model,
    installed_size_bytes: m.installed_size_bytes,
  }));
} catch { /* not fatal */ }

for (const [i, policy] of order.entries()) {
  process.stdout.write(`  ${String(i + 1).padStart(2)}/${order.length} ${policy.padEnd(13)} `);
  await setup();
  try {
    const r = await runOnce(policy);
    transcript.runs.push(r);
    console.log(
      `chose ${r.chose.padEnd(14)} step ${String(r.step_total_ms).padStart(6)}ms  ` +
        `A ${String(r.workflow_a_ms).padStart(5)}ms${r.displaced_in_use ? "  DISPLACED" : ""}`,
    );
  } catch (e) {
    transcript.runs.push({ policy, error: e.message });
    console.log(`error: ${e.message}`);
  }
}

const byPolicy = {};
for (const name of Object.keys(policies)) {
  const rs = transcript.runs.filter((r) => r.policy === name && !r.error);
  byPolicy[name] = {
    runs: rs.length,
    chose: rs.reduce((acc, r) => ({ ...acc, [r.chose]: (acc[r.chose] ?? 0) + 1 }), {}),
    step_total_ms: stats(rs.map((r) => r.step_total_ms)),
    workflow_a_ms: stats(rs.map((r) => r.workflow_a_ms)),
    workflow_a_reloads: rs.filter((r) => r.workflow_a_reloaded).length,
    displaced_in_use: rs.filter((r) => r.displaced_in_use).length,
    transitions_added: stats(rs.map((r) => r.transitions_added)),
    deferrals: rs.filter((r) => r.deferred_ms > 0).length,
  };
}
transcript.summary = byPolicy;

// Did reading readiness change the decision at all? If every policy chose the
// same model every time, the answer is no on this hardware, and that is the
// result rather than a failed run.
const choices = Object.fromEntries(
  Object.entries(byPolicy).map(([k, v]) => [k, Object.keys(v.chose).sort().join("+")]),
);
transcript.verdict =
  choices.wicklee === choices.loaded_check
    ? {
        outcome: "tie",
        detail:
          `wicklee and loaded_check made the same choices (${choices.wicklee || "none"}). On this ` +
          `host readiness added nothing over a loaded-model check — a null result about the agent ` +
          `demonstration, which says nothing about the diagnostics.`,
      }
    : {
        outcome: "differs",
        detail:
          `wicklee chose ${choices.wicklee} where loaded_check chose ${choices.loaded_check}. ` +
          `Compare displaced_in_use and workflow_a_reloads to see whether the difference was worth it.`,
      };

transcript.finished_at = new Date().toISOString();
await fs.writeFile(OUT, JSON.stringify(transcript, null, 2));

const md = [
  `# Reference controller — ${cfg.host?.label ?? "unlabelled host"}`,
  "",
  `- Agent ${transcript.env.agent_version ?? "?"}, Ollama ${transcript.env.ollama_version ?? "?"}`,
  `- Workflow A holds **${HELD.name}** (${HELD.resident_gb} GB); workflow B may use ` +
    ACCEPTABLE.map((m) => `**${m.name}** (${m.resident_gb} GB)`).join(" or "),
  `- Accelerator budget ${cfg.host?.accelerator_budget_gb ?? "undeclared"} GB`,
  `- ${RUNS} runs per policy, randomised order`,
  "",
  "Medians with ranges. `loaded_check` is the baseline that matters: it is what a careful",
  "integration does today without Wicklee.",
  "",
  "| Policy | Chose | B step ms | A latency ms | A reloads | In-use displaced | Transitions | Deferrals |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...Object.entries(byPolicy).map(([name, s]) =>
    `| \`${name}\` | ${Object.entries(s.chose).map(([m, n]) => `${m} ×${n}`).join(", ") || "—"} | ` +
      `${fmt(s.step_total_ms)} | ${fmt(s.workflow_a_ms)} | ${s.workflow_a_reloads}/${s.runs} | ` +
      `${s.displaced_in_use}/${s.runs} | ${fmt(s.transitions_added)} | ${s.deferrals} |`,
  ),
  "",
  `**${transcript.verdict.outcome}.** ${transcript.verdict.detail}`,
  "",
  `Raw results: \`${OUT}\``,
  "",
].join("\n");
await fs.writeFile(MD, md);

console.log("");
console.log(md.split("\n").slice(8).join("\n"));
console.log(`transcript: ${OUT}`);
console.log(`summary:    ${MD}`);
