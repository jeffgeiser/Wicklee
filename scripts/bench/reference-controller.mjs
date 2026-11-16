#!/usr/bin/env node
// Phase 1, step 8 — the reference controller.
//
// Four policies choose a model for one step of a workflow, on a host where
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
// `smallest_first` is the second baseline, and the harder one. It sorts
// /api/tags by installed size and takes the smallest, which costs one request
// and no Wicklee. Where the smallest option is also the one that coexists,
// that heuristic reaches the same decision readiness does — so the report
// compares the two directly and says plainly when they tie. A readiness answer
// can be more honest than a heuristic and still not change a decision.
//
// So a tie is a real and publishable outcome. On a host with enough memory for
// every option, all four policies make the same choice and the right report
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

/// Every model's readiness answer.
///
/// The all-models form answers under `models`; only `?model=` answers under
/// `readiness`. The first version of this read `readiness` for both, got an
/// empty list for the form it actually calls, and concluded that readiness had
/// no answer for any option — so the wicklee policy deferred its full 30 s on
/// every run and then fell back to the preferred model anyway. Fifteen runs
/// reported a tie that was entirely this bug. Both keys are accepted now, and
/// an empty list is treated as a transport failure rather than as an answer.
async function readiness() {
  const { body } = await j(`${AGENT}/v1/readiness`);
  const rows = Array.isArray(body.models)
    ? body.models
    : Array.isArray(body.readiness)
      ? body.readiness
      : [body.readiness].filter(Boolean);
  if (!rows.length) {
    throw new Error("/v1/readiness returned no model rows — wrong shape or no models known");
  }
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

  /// Always the smallest acceptable model, by the installed size /api/tags
  /// reports. No Wicklee at all.
  ///
  /// The cheap heuristic that happens to reach the same answer as the wicklee
  /// policy on a host where the smallest option is the one that coexists. It
  /// is here to be beaten or to tie: if a one-line sort of /api/tags gets the
  /// same decision, readiness earned nothing on this hardware, however
  /// reasonable its answer was. Installed size is not the resident footprint
  /// — it excludes KV cache and overstates the weights (V7) — so this is a
  /// proxy, which is exactly what a controller without Wicklee has.
  smallest_first: async () => {
    const tags = (await j(`${OLLAMA}/api/tags`)).body.models ?? [];
    const size = new Map(tags.map((m) => [nameOf(m), m.size]));
    const known = ACCEPTABLE.filter((m) => typeof size.get(m.name) === "number");
    if (!known.length) {
      return {
        choice: ACCEPTABLE[0],
        reason: "/api/tags reports no size for any acceptable option, so the preferred one",
      };
    }
    const ranked = [...known].sort((a, b) => size.get(a.name) - size.get(b.name));
    const pick = ranked[0];
    return {
      choice: pick,
      reason: `${pick.name} is the smallest installed (${(size.get(pick.name) / 1e9).toFixed(1)} GB on disk)`,
      considered: { ranked: ranked.map((m) => `${m.name} ${(size.get(m.name) / 1e9).toFixed(1)}GB`) },
    };
  },

  /// Reads /v1/readiness. Skips anything that would displace a model in use,
  /// takes the best of what is left, and defers when nothing is safe.
  ///
  /// An unverified fit counts as a risk. Step 9 measured what the first
  /// version of this policy assumed: `requires_loading` means it fits by
  /// memory accounting, and on the one host tested the runtime still evicted a
  /// resident model in five of six such cases. The agent now marks those
  /// answers `coexistence: "unverified"`, and a policy that reads them as safe
  /// is making exactly the prediction that measurement falsified. So while
  /// something in use is resident, an unverified fit is unsafe.
  ///
  /// When every option is unverified it chooses the smallest footprint
  /// immediately rather than deferring. The first version of this rule waited
  /// out its full 30 s timeout on every run and then took the smallest
  /// footprint as a fallback — the right answer, reached by letting a clock
  /// run out, because "unverified" collapsed a ranking into one bucket.
  /// Waiting cannot help when the thing making the answer unverified is
  /// another workflow holding a model it is still using. The ranking lives
  /// here, in the client: Wicklee reports footprints and does not order them.
  wicklee: async () => {
    const rows = await readiness();
    const by = new Map(rows.map((r) => [r.model, r]));
    const heldInUse = rows
      .filter((x) => x.readiness === "ready_now" && x.in_use === true)
      .map((x) => x.model);

    const safe = [];
    const unsafe = [];
    const unverified = [];
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
      } else if (r.coexistence === "unverified" && heldInUse.length) {
        // Footprint from Wicklee's own answer where it has one, declared size
        // otherwise. Either way the ordering is this policy's, not Wicklee's.
        unverified.push({ model: m, bytes: r.footprint?.bytes ?? (m.resident_gb ?? 0) * 1e9 });
        unsafe.push({
          model: m,
          why: `fits by accounting, but co-residency with ${heldInUse.join(", ")} (in use) is unverified`,
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

    // Nothing is verified safe, and every option that failed failed only
    // because its co-residency is unverified. Deferring cannot change that, so
    // choose now: the smallest footprint is the one least likely to evict
    // anything, and the declared preference order breaks a tie.
    if (unverified.length && unverified.length === unsafe.length) {
      const ranked = [...unverified].sort(
        (a, b) => a.bytes - b.bytes || ACCEPTABLE.indexOf(a.model) - ACCEPTABLE.indexOf(b.model),
      );
      const pick = ranked[0];
      return {
        choice: pick.model,
        reason:
          `no option's co-residency is verified, so ${pick.model.name} — the smallest footprint ` +
          `(${(pick.bytes / 1e9).toFixed(1)} GB), which displaces the least`,
        considered: {
          safe: [],
          unsafe: unsafe.map((u) => `${u.model.name} (${u.why})`),
          ranked: ranked.map((r) => `${r.model.name} ${(r.bytes / 1e9).toFixed(1)}GB`),
        },
      };
    }

    if (DEFER_ALLOWED) {
      return {
        choice: null,
        deferred: true,
        reason: `no acceptable option is safe: ${unsafe.map((u) => `${u.model.name} ${u.why}`).join("; ")}`,
      };
    }
    // Nothing safe and deferring is forbidden. The preferred option is an
    // arbitrary choice here; the smallest footprint is the one least likely to
    // evict anything, which is the only thing left to optimise for.
    const smallest = [...ACCEPTABLE].sort((a, b) => (a.resident_gb ?? 0) - (b.resident_gb ?? 0))[0];
    return {
      choice: smallest,
      reason:
        `nothing is safe and the scenario forbids deferring, so ${smallest.name} — the smallest ` +
        `footprint, which displaces the least`,
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
        decision.considered = retry.considered ?? decision.considered;
        decision.reason = `deferred ${Math.round(deferred_ms / 1000)}s, then ${retry.reason}`;
        break;
      }
      if (Date.now() > until) {
        // Same reasoning as the forbidden-deferral branch: once waiting has
        // not helped, the smallest footprint displaces the least.
        const smallest = [...ACCEPTABLE].sort((a, b) => (a.resident_gb ?? 0) - (b.resident_gb ?? 0))[0];
        deferred_ms = DEFER_TIMEOUT_S * 1000;
        decision.choice = smallest;
        decision.reason = `deferred ${DEFER_TIMEOUT_S}s, nothing became safe, ran ${smallest.name} as the least displacing`;
        break;
      }
    }
  }

  const step = await generate(decision.choice.name, { num_predict: 32 });
  const step_ms = step.wall_ms;

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

// The second comparison, and the one that decides whether readiness earned
// anything here: a one-request sort of /api/tags against the whole thing.
const cheap = byPolicy.smallest_first ?? { displaced_in_use: null, runs: 0 };
const mine = byPolicy.wicklee ?? { displaced_in_use: null, runs: 0 };
transcript.verdict_vs_smallest_first =
  choices.wicklee === choices.smallest_first
    ? {
        outcome: "tie",
        detail:
          `wicklee and smallest_first made the same choices (${choices.wicklee || "none"}), and ` +
          `displaced a model in use ${mine.displaced_in_use}/${mine.runs} against ` +
          `${cheap.displaced_in_use}/${cheap.runs}. Sorting /api/tags by installed size reached the ` +
          `same decision without Wicklee, so on this host readiness changed nothing a one-line ` +
          `heuristic would not have. It says nothing about whether the answer was better founded.`,
      }
    : {
        outcome: "differs",
        detail:
          `wicklee chose ${choices.wicklee} where smallest_first chose ${choices.smallest_first}; ` +
          `displaced a model in use ${mine.displaced_in_use}/${mine.runs} against ` +
          `${cheap.displaced_in_use}/${cheap.runs}.`,
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
  `**vs loaded_check — ${transcript.verdict.outcome}.** ${transcript.verdict.detail}`,
  "",
  `**vs smallest_first — ${transcript.verdict_vs_smallest_first.outcome}.** ` +
    transcript.verdict_vs_smallest_first.detail,
  "",
  `Raw results: \`${OUT}\``,
  "",
].join("\n");
await fs.writeFile(MD, md);

console.log("");
console.log(md.split("\n").slice(8).join("\n"));
console.log(`transcript: ${OUT}`);
console.log(`summary:    ${MD}`);
