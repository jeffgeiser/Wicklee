#!/usr/bin/env node
// Phase 1, step 9 — the acceptance run.
//
// Everything the spec's acceptance table can check in one pass, on one host,
// with one transcript to send back. Written for the "other hardware" row:
// three machines with different configurations have to produce this, and
// asking someone to follow a prose checklist would get three different things.
//
//   node scripts/bench/acceptance.mjs --scenarios scripts/bench/scenarios.json --yes
//
// Options
//   --scenarios <path>  Scenario file (see scenarios.example.json)
//   --out <path>        Transcript to send back
//   --label <text>      How to describe this host in the write-up
//   --yes               Skip the consent prompt
//   --plan              Print the checks and exit
//   --skip <list>       Omit checks, e.g. --skip overhead
//
// WHAT IT DOES NOT COVER, and why that is said here rather than discovered:
//
//   - The 24-hour healthy control. A run that takes half a minute cannot make
//     a claim about a day of normal use. `fault-inject.mjs --only healthy`
//     checks the short version; the long one is a day of someone's real work
//     with `wicklee inspect` read at the end.
//   - Inference throughput with and without the agent. That needs the agent
//     stopped and restarted, which this script will not do to a host it does
//     not own. `--only overhead` in the instructions below covers it by hand.
//
// Run it against a runtime you can disturb. It loads and unloads models.

import { loadScenarios, DEFAULT_SCENARIOS_PATH } from "./lib/scenarios.mjs";

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const SCENARIOS_PATH = String(flag("scenarios", DEFAULT_SCENARIOS_PATH));
const OUT = String(flag("out", `./acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
const LABEL = flag("label") ? String(flag("label")) : null;
const SKIP = flag("skip") ? String(flag("skip")).split(",").map((s) => s.trim()) : [];
const YES = args.includes("--yes");
const PLAN = args.includes("--plan");

const fs = await import("node:fs/promises");
const os = await import("node:os");
const cfg = await loadScenarios(SCENARIOS_PATH);
const OLLAMA = String(cfg.ollama_base_url).replace(/\/+$/, "");
const AGENT = String(cfg.agent_base_url).replace(/\/+$/, "");
const CTX = cfg.contexts?.fits ?? 8192;
const SMALL = cfg.models?.small;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    throw new Error(`${url} did not return JSON (HTTP ${r.status}) — is this build serving /v1?`);
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
      options: { num_ctx: opts.num_ctx ?? CTX, num_predict: opts.num_predict ?? 2 },
    }),
  }).then((r) => r.body);

async function fingerprint(model) {
  const { status, body } = await j(`${AGENT}/v1/fingerprint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "decode_rate", models: [model], consent: true, force: true }),
  });
  if (status !== 200) return { error: body.error ?? `HTTP ${status}` };
  return body.outcome?.results?.[0]?.decode_tps ?? { error: "no rate" };
}

// ── Checks ───────────────────────────────────────────────────────────────────
//
// Each returns { pass: true|false|null, detail, data? }. `null` means the check
// could not run on this host, which is a result and not a failure — the
// write-up says which rows were unreachable and why.

const checks = {
  /// Spec: "A finding's test gives overlapping ranges when run twice with no
  /// change." The reproducibility claim the whole verify workflow rests on.
  reproducible: {
    describe: () => `fingerprint ${SMALL?.name} three times with nothing changed; ranges must overlap`,
    async run() {
      if (!SMALL?.name) return { pass: null, detail: "no models.small declared" };
      await generate(SMALL.name, { num_predict: 4 });
      await sleep(9000);
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const r = await fingerprint(SMALL.name);
        if (r.error) return { pass: null, detail: `a run was refused: ${r.error}` };
        runs.push(r);
      }
      // Every pair must overlap. Three runs of one unchanged thing that come
      // back as three separated bands would mean the range is too tight to
      // mean anything, and every verify verdict built on it is noise.
      const overlaps = (a, b) => a.low <= b.high && b.low <= a.high;
      const bad = [];
      for (let i = 0; i < runs.length; i++) {
        for (let k = i + 1; k < runs.length; k++) {
          if (!overlaps(runs[i], runs[k])) bad.push([i, k]);
        }
      }
      const spread =
        (Math.max(...runs.map((r) => r.median)) - Math.min(...runs.map((r) => r.median))) /
        Math.min(...runs.map((r) => r.median)) *
        100;
      return {
        pass: bad.length === 0,
        detail: bad.length
          ? `${bad.length} of 3 pairs did not overlap; medians spread ${spread.toFixed(1)}%`
          : `all three overlap; medians spread ${spread.toFixed(1)}%`,
        data: { runs, median_spread_pct: Math.round(spread * 10) / 10 },
      };
    },
  },

  /// Spec: "Each finding states something the runtime's status command and a
  /// short script would not." Checked structurally rather than by opinion:
  /// every statement must carry a basis, every finding must carry at least one
  /// observed or verified statement, and every inferred one must hedge.
  evidence: {
    describe: () => "every finding on this host carries evidence, and every inference hedges",
    async run() {
      const { body } = await j(`${AGENT}/v1/inspect`);
      const findings = body.findings ?? [];
      if (!findings.length) {
        return {
          pass: null,
          detail: "no findings on this host right now, so there is nothing to check. " +
            "Run fault-inject.mjs first for a populated version of this check",
        };
      }
      const faults = [];
      for (const f of findings) {
        const labels = (f.statements ?? []).map((s) => s.label);
        if (!labels.some((l) => l === "observed" || l === "verified")) {
          faults.push(`${f.id} ${f.rule}: nothing observed or verified`);
        }
        for (const s of f.statements ?? []) {
          if (!(s.basis ?? []).length) faults.push(`${f.id} ${f.rule}: a statement with no basis`);
          if (s.label === "inferred" && !/\b(may|likely|might|could)\b/i.test(s.text)) {
            faults.push(`${f.id} ${f.rule}: an inferred statement that does not hedge`);
          }
        }
      }
      return {
        pass: faults.length === 0,
        detail: faults.length ? faults.join("; ") : `${findings.length} finding(s), all evidenced`,
        data: { findings: findings.map((f) => ({ id: f.id, rule: f.rule, statements: f.statements })) },
      };
    },
  },

  /// Spec: "during inspect and ready, the mock receives no generate requests
  /// from those commands." Checked here against a real runtime by watching the
  /// expiry clock: a generate resets it, so if reading does not move it,
  /// reading sent nothing.
  no_side_effects: {
    describe: () => "reading state, readiness, inspect and findings sends no inference request",
    async run() {
      if (!SMALL?.name) return { pass: null, detail: "no models.small declared" };
      await generate(SMALL.name, { num_predict: 2 });
      await sleep(2000);
      const before = (await j(`${OLLAMA}/api/ps`)).body.models?.find(
        (m) => (m.name ?? m.model) === SMALL.name,
      );
      if (!before?.expires_at) {
        return { pass: null, detail: "this runtime does not report expires_at, so this cannot be checked" };
      }
      for (const route of ["/v1/state", "/v1/readiness", "/v1/inspect", "/v1/findings"]) {
        await j(`${AGENT}${route}`);
      }
      await sleep(1500);
      const after = (await j(`${OLLAMA}/api/ps`)).body.models?.find(
        (m) => (m.name ?? m.model) === SMALL.name,
      );
      const moved = before.expires_at !== after?.expires_at;
      return {
        pass: !moved,
        // The agent's own 10-minute probe can move this clock; it is on its own
        // schedule and is not triggered by these routes. A failure here that
        // cannot be reproduced is worth re-running before it is believed.
        detail: moved
          ? `expires_at moved from ${before.expires_at} to ${after?.expires_at} — either a route ` +
            `sent a request, or the agent's own probe fired during the check. Re-run to tell them apart`
          : "expires_at unchanged across all four reads",
        data: { before: before.expires_at, after: after?.expires_at ?? null },
      };
    },
  },

  /// Spec: "Measure agent CPU and memory." The throughput half needs the agent
  /// stopped, which this script will not do to someone else's host.
  overhead: {
    describe: () => "agent resident memory and CPU, sampled over 20 seconds while idle",
    async run() {
      const { body: health } = await j(`${AGENT}/api/health`);
      const port = new URL(AGENT).port || "7700";
      const { execFile } = await import("node:child_process");
      const run = (cmd, a) =>
        new Promise((res) => execFile(cmd, a, (e, out) => res(e ? "" : out)));

      // The listener's pid, so this measures the agent under test rather than
      // whichever wicklee process happens to be running.
      const lsof = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      const pid = lsof.trim().split(/\s+/)[0];
      if (!pid) return { pass: null, detail: `could not find the process listening on :${port}` };

      const samples = [];
      for (let i = 0; i < 5; i++) {
        const out = await run("ps", ["-o", "rss=,%cpu=", "-p", pid]);
        const [rss, cpu] = out.trim().split(/\s+/).map(Number);
        if (Number.isFinite(rss)) samples.push({ rss_kb: rss, cpu_pct: cpu });
        await sleep(4000);
      }
      if (!samples.length) return { pass: null, detail: `ps gave nothing for pid ${pid}` };
      const med = (xs) => {
        const v = [...xs].sort((a, b) => a - b);
        return v[v.length >> 1];
      };
      const data = {
        agent_version: health.agent_version,
        pid: Number(pid),
        rss_mb_median: Math.round(med(samples.map((s) => s.rss_kb)) / 1024),
        rss_mb_max: Math.round(Math.max(...samples.map((s) => s.rss_kb)) / 1024),
        cpu_pct_median: med(samples.map((s) => s.cpu_pct)),
        cpu_pct_max: Math.max(...samples.map((s) => s.cpu_pct)),
        samples,
      };
      // No pass or fail: there is no declared budget to measure against, and
      // inventing one here would be a threshold nobody agreed to. The numbers
      // are the deliverable.
      return {
        pass: null,
        detail:
          `${data.agent_version}: RSS ${data.rss_mb_median} MB (peak ${data.rss_mb_max}), ` +
          `CPU ${data.cpu_pct_median}% (peak ${data.cpu_pct_max}%). Reported, not judged — ` +
          `the spec asks for the numbers against the 0.12.0 baseline, which needs both builds`,
        data,
      };
    },
  },
};

const chosen = Object.keys(checks).filter((k) => !SKIP.includes(k));

console.log(`Acceptance run — ${LABEL ?? cfg.host?.label ?? "unlabelled host"}`);
console.log(`  runtime ${OLLAMA}`);
console.log(`  agent   ${AGENT}`);
console.log("");
for (const k of chosen) console.log(`  ${k}\n      ${checks[k].describe()}`);
console.log("");
console.log("Not covered here: the 24-hour healthy control, and inference throughput with the");
console.log("agent stopped. Both need more than one short run; see the header.");
console.log("");

if (PLAN) process.exit(0);
if (!YES) {
  console.log("This loads and unloads models on that runtime. Re-run with --yes to proceed.");
  process.exit(1);
}

const transcript = {
  started_at: new Date().toISOString(),
  label: LABEL ?? cfg.host?.label ?? null,
  host: {
    declared: cfg.host ?? null,
    platform: `${os.platform()} ${os.arch()} ${os.release()}`,
    cpus: os.cpus().length,
    cpu_model: os.cpus()[0]?.model ?? null,
    total_mem_bytes: os.totalmem(),
  },
  env: {},
  checks: {},
  not_covered: {
    healthy_24h: "a day of normal use with `wicklee inspect` read at the end",
    throughput_without_agent: "needs the agent stopped and restarted; run by hand",
  },
};
try {
  const { body } = await j(`${AGENT}/api/health`);
  transcript.env.agent_version = body.agent_version;
  transcript.env.build_target = body.build_target;
  transcript.env.store_healthy = body.store_healthy;
} catch (e) {
  console.log(`warning: ${e.message}`);
}
try {
  transcript.env.ollama_version = (await j(`${OLLAMA}/api/version`)).body.version;
} catch { /* not fatal */ }

for (const name of chosen) {
  process.stdout.write(`${name} … `);
  const started = Date.now();
  let r;
  try {
    r = await checks[name].run();
  } catch (e) {
    r = { pass: false, detail: `error: ${e.message}` };
  }
  r.took_s = Math.round((Date.now() - started) / 100) / 10;
  transcript.checks[name] = r;
  console.log(`${r.pass === true ? "pass" : r.pass === false ? "FAIL" : "not applicable"} (${r.took_s}s)`);
  console.log(`    ${r.detail}`);
}

transcript.finished_at = new Date().toISOString();
await fs.writeFile(OUT, JSON.stringify(transcript, null, 2));

const vals = Object.values(transcript.checks);
console.log("");
console.log(
  `${vals.filter((v) => v.pass === true).length} pass, ` +
    `${vals.filter((v) => v.pass === false).length} fail, ` +
    `${vals.filter((v) => v.pass === null).length} not applicable`,
);
console.log(`transcript: ${OUT}`);
console.log("");
console.log("Send that file back. It carries the platform, the versions and every number above.");

process.exit(vals.some((v) => v.pass === false) ? 1 : 0);
