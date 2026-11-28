#!/usr/bin/env node
// A job dispatcher that asks Wicklee before it loads a model.
//
//   node examples/dispatch.mjs --acceptable llama3.1:8b,qwen3.5:4b \
//        --num-ctx 8192 --prompt "Summarise this changelog: ..."
//
// This is the Stage 2 consumer: something that would otherwise just call
// Ollama makes a better choice by reading readiness first. It speaks MCP
// (JSON-RPC over HTTP, the same `wicklee_readiness` tool an editor or agent
// framework would call), then runs the job on the model it chose and hands
// the completion metadata back to Wicklee as a receipt.
//
// What it decides, and what it does not
//   Wicklee answers: ready_now, requires_loading, may_require_eviction or
//   cannot_determine, per model. It does not choose. The rule below is the
//   operator's, written in this file, and meant to be replaced:
//     1. the first --acceptable model that is ready_now runs;
//     2. otherwise wait (defer) and ask again every --poll seconds;
//     3. a requires_loading answer is NOT treated as safe, because while
//        another model is resident it carries coexistence: "unverified" and on
//        the one host measured the runtime evicted a resident model in 5 of 6
//        such cases (docs/PHASE1_RESULTS.md). --accept-unverified opts in;
//     4. after --defer-timeout seconds, --on-timeout decides: `fail` (default,
//        nothing runs, exit 3) or `proceed` (run the first model anyway,
//        recorded as an override).
//
// Privacy: the prompt goes to your runtime and nowhere else. The receipt sent
// to Wicklee is built from an allowlist of numeric fields; the runtime's reply
// also contains `response` and `context`, which the receipts route refuses and
// which are never copied.
//
// Flags
//   --acceptable a,b,c   models in order of preference (required)
//   --prompt <text> | --prompt-file <path>    the job (required unless --dry-run)
//   --num-ctx <n>        context to run at (required unless --dry-run). Always
//                        sent: omitting it reloads the model at the runtime's
//                        4096 default, which is the finding `context_reset`
//   --agent <url>        Wicklee agent   (default http://127.0.0.1:7700)
//   --ollama <url>       the runtime     (default http://127.0.0.1:11434)
//   --token <t>          agent bearer token; prefer WICKLEE_TOKEN
//   --defer-timeout <s>  (default 30)   --poll <s> (default 3)
//   --accept-unverified  treat requires_loading as safe to run
//   --on-timeout fail|proceed           (default fail)
//   --dry-run            decide and print; send nothing to the runtime
//   --json               print the decision record as JSON
//
// Exit: 0 ran, 3 nothing ran (deferred out), 1 error, 2 usage.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One MCP tool call. Returns the parsed JSON the tool returned. */
export async function callTool(agent, name, args, { token, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const rpc = async (id, method, params) => {
    const r = await fetchImpl(`${agent.replace(/\/+$/, "")}/mcp`, {
      method: "POST", headers, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (r.status === 401) throw new Error(token ? "agent rejected the token" : "agent needs a token (set WICKLEE_TOKEN)");
    if (!r.ok) throw new Error(`agent answered HTTP ${r.status}`);
    const body = await r.json();
    if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
    return body.result;
  };
  await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wicklee-dispatch-example", version: "1" } });
  const result = await rpc(2, "tools/call", { name, arguments: args });
  const text = result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { throw new Error(`tool ${name} returned non-JSON: ${text.slice(0, 120)}`); }
}

/**
 * Readiness for each model, asked one at a time. The all-models form answers
 * under `models` and the single-model form under `readiness`; asking per model
 * keeps one shape. A model the agent has not seen is a 404 from the route,
 * which the tool returns as `{error}`: that is an answer ("unknown"), not a
 * failure of the call.
 */
export async function readinessFor(agent, models, opts) {
  const out = {};
  for (const m of models) {
    const body = await callTool(agent, "wicklee_readiness", { model: m }, opts);
    out[m] = body.readiness ?? { model: m, readiness: "cannot_determine", unknown: body.error ?? "no answer" };
  }
  return out;
}

/** Pure: given the answers, what does this operator's rule say? */
export function decide(models, answers, { acceptUnverified = false } = {}) {
  const ready = models.find((m) => answers[m]?.readiness === "ready_now");
  if (ready) return { action: "run", model: ready, why: "ready_now" };
  if (acceptUnverified) {
    const load = models.find((m) => answers[m]?.readiness === "requires_loading");
    if (load) {
      const unverified = answers[load].coexistence === "unverified";
      return { action: "run", model: load, why: unverified ? "requires_loading, accepted although coexistence is unverified" : "requires_loading" };
    }
  }
  const reasons = models.map((m) => `${m}: ${answers[m]?.readiness ?? "no answer"}${answers[m]?.coexistence === "unverified" ? " (unverified)" : ""}`);
  return { action: "defer", why: reasons.join("; ") };
}

/** Numeric completion metadata only. Never `response`, never `context`. */
export const RECEIPT_FIELDS = ["model", "total_duration", "load_duration", "prompt_eval_count", "eval_count", "eval_duration"];
export function receiptFrom(reply, numCtx) {
  const r = {};
  for (const k of RECEIPT_FIELDS) if (reply[k] !== undefined) r[k] = reply[k];
  r.num_ctx = numCtx;
  return r;
}

export async function dispatch(cfg, { fetchImpl = fetch, now = Date.now, wait = sleep } = {}) {
  const { agent, ollama, token, models, prompt, numCtx, deferTimeoutS, pollS, acceptUnverified, onTimeout, dryRun } = cfg;
  const record = { started_at: new Date(now()).toISOString(), models, polls: [], decision: null, job: null, receipt: null };
  const deadline = now() + deferTimeoutS * 1000;
  let decision;
  for (;;) {
    const answers = await readinessFor(agent, models, { token, fetchImpl });
    decision = decide(models, answers, { acceptUnverified });
    record.polls.push({ at_ms: now(), summary: decision.action === "run" ? `${decision.model}: ${decision.why}` : decision.why });
    record.answers = answers;
    if (decision.action === "run") break;
    if (now() >= deadline) {
      if (onTimeout === "proceed") {
        decision = { action: "run", model: models[0], why: `override: deferred ${deferTimeoutS} s without a ready model, ran ${models[0]} anyway`, override: true };
      } else {
        decision = { action: "none", why: `nothing was ready within ${deferTimeoutS} s; nothing ran` };
      }
      break;
    }
    await wait(pollS * 1000);
  }
  record.decision = decision;
  if (decision.action !== "run" || dryRun) return record;

  const started = now();
  const r = await fetchImpl(`${ollama.replace(/\/+$/, "")}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: decision.model, prompt, stream: false, options: { num_ctx: numCtx } }),
  });
  if (!r.ok) throw new Error(`runtime answered HTTP ${r.status} for ${decision.model}`);
  const reply = await r.json();
  record.job = { model: decision.model, wall_ms: now() - started, load_ms: reply.load_duration != null ? reply.load_duration / 1e6 : null, eval_count: reply.eval_count ?? null };
  record.output = reply.response ?? "";

  const receipt = receiptFrom(reply, numCtx);
  const rr = await fetchImpl(`${agent.replace(/\/+$/, "")}/v1/receipts`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(receipt),
  });
  record.receipt = { sent: receipt, status: rr.status };
  return record;
}

async function main(argv) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
  const has = (n) => argv.includes(`--${n}`);
  const usage = (m) => { console.error(`${m}\nusage: node examples/dispatch.mjs --acceptable a,b --num-ctx N --prompt TEXT [--dry-run] [--json]`); process.exit(2); };

  const models = (flag("acceptable") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!models.length) usage("--acceptable is required");
  const dryRun = has("dry-run");
  const prompt = flag("prompt-file") ? await readFile(flag("prompt-file"), "utf8") : flag("prompt");
  const numCtx = Number(flag("num-ctx"));
  if (!dryRun) {
    if (!prompt) usage("--prompt or --prompt-file is required (or --dry-run)");
    if (!(numCtx > 0)) usage("--num-ctx is required: omitting it reloads the model at the runtime's 4096 default");
  }
  const onTimeout = flag("on-timeout") ?? "fail";
  if (!["fail", "proceed"].includes(onTimeout)) usage("--on-timeout must be fail or proceed");

  const cfg = {
    agent: flag("agent") ?? "http://127.0.0.1:7700",
    ollama: flag("ollama") ?? "http://127.0.0.1:11434",
    token: flag("token") ?? process.env.WICKLEE_TOKEN,
    models, prompt, numCtx, dryRun, onTimeout,
    deferTimeoutS: Number(flag("defer-timeout") ?? 30),
    pollS: Number(flag("poll") ?? 3),
    acceptUnverified: has("accept-unverified"),
  };

  let record;
  try { record = await dispatch(cfg); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }

  if (has("json")) {
    console.log(JSON.stringify(record, null, 2));
  } else {
    for (const p of record.polls) console.log(`ask   ${p.summary}`);
    console.log(`decision  ${record.decision.action}${record.decision.model ? ` ${record.decision.model}` : ""} — ${record.decision.why}`);
    if (record.job) console.log(`ran   ${record.job.model} in ${record.job.wall_ms} ms (load ${record.job.load_ms ?? "?"} ms, ${record.job.eval_count ?? "?"} tokens)`);
    if (record.receipt) console.log(`receipt sent to Wicklee: HTTP ${record.receipt.status}`);
    if (record.output) console.log(`\n${record.output}`);
  }
  process.exit(record.decision.action === "run" ? 0 : 3);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main(process.argv.slice(2));
