// node --test examples/dispatch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callTool, decide, receiptFrom, dispatch, RECEIPT_FIELDS } from "./dispatch.mjs";

const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
const listen = (h) => new Promise((r) => { const s = http.createServer(h).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });

/** A Wicklee agent that speaks MCP and records what it was sent. `answers` may be mutated between polls. */
async function fakeAgent(answers, { token } = {}) {
  const log = { rpc: [], receipts: [] };
  const { s, url } = await listen(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end("{}"); return; }
    const body = JSON.parse(await readBody(req));
    if (req.url === "/v1/receipts") { log.receipts.push(body); res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
    log.rpc.push(body);
    let result = {};
    if (body.method === "tools/call") {
      const m = body.params.arguments.model;
      const a = answers[m];
      const text = a ? JSON.stringify({ node_id: "WK-T", readiness: { model: m, ...a } }) : JSON.stringify({ error: `${m} is not installed on this host, or has not been seen yet` });
      result = { content: [{ type: "text", text }] };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  return { s, url, log };
}

/** A runtime whose reply carries the fields a real one does, including the two Wicklee must never receive. */
async function fakeOllama() {
  const log = { calls: [] };
  const { s, url } = await listen(async (req, res) => {
    log.calls.push(JSON.parse(await readBody(req)));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      model: log.calls.at(-1).model, response: "SECRET MODEL OUTPUT", context: [1, 2, 3],
      total_duration: 900_000_000, load_duration: 6_000_000, prompt_eval_count: 12, eval_count: 40, eval_duration: 700_000_000,
    }));
  });
  return { s, url, log };
}

const base = (agent, ollama, over = {}) => ({
  agent, ollama, models: ["big:8b", "small:4b"], prompt: "PRIVATE PROMPT", numCtx: 8192,
  deferTimeoutS: 1, pollS: 0, acceptUnverified: false, onTimeout: "fail", dryRun: false, ...over,
});
const noWait = { wait: async () => {} };

test("runs the first ready_now model, always sends num_ctx, and reports the receipt", async () => {
  const a = await fakeAgent({ "big:8b": { readiness: "ready_now" }, "small:4b": { readiness: "ready_now" } });
  const o = await fakeOllama();
  const rec = await dispatch(base(a.url, o.url), noWait);
  a.s.close(); o.s.close();
  assert.equal(rec.decision.model, "big:8b");
  assert.equal(o.log.calls.length, 1);
  assert.equal(o.log.calls[0].options.num_ctx, 8192);
  assert.equal(rec.job.load_ms, 6);
  assert.equal(rec.receipt.status, 200);
});

test("the prompt and the output never reach Wicklee; the receipt is numeric fields only", async () => {
  const a = await fakeAgent({ "big:8b": { readiness: "ready_now" }, "small:4b": { readiness: "ready_now" } });
  const o = await fakeOllama();
  await dispatch(base(a.url, o.url), noWait);
  a.s.close(); o.s.close();
  const toAgent = JSON.stringify([a.log.rpc, a.log.receipts]);
  assert.ok(!toAgent.includes("PRIVATE PROMPT"), "prompt leaked to the agent");
  assert.ok(!toAgent.includes("SECRET MODEL OUTPUT"), "output leaked to the agent");
  const r = a.log.receipts[0];
  for (const forbidden of ["prompt", "response", "messages", "context"]) assert.ok(!(forbidden in r), forbidden);
  assert.deepEqual(Object.keys(r).sort(), [...RECEIPT_FIELDS, "num_ctx"].sort());
  assert.equal(r.num_ctx, 8192);
});

test("prefers the earlier model but skips one that is not ready", async () => {
  const a = await fakeAgent({ "big:8b": { readiness: "may_require_eviction" }, "small:4b": { readiness: "ready_now" } });
  const o = await fakeOllama();
  const rec = await dispatch(base(a.url, o.url), noWait);
  a.s.close(); o.s.close();
  assert.equal(rec.decision.model, "small:4b");
  assert.equal(o.log.calls[0].model, "small:4b");
});

test("requires_loading with unverified coexistence is not treated as safe by default", async () => {
  const answers = { "big:8b": { readiness: "requires_loading", coexistence: "unverified" }, "small:4b": { readiness: "requires_loading", coexistence: "unverified" } };
  const a = await fakeAgent(answers);
  const o = await fakeOllama();
  const rec = await dispatch(base(a.url, o.url, { deferTimeoutS: 0 }), noWait);
  assert.equal(rec.decision.action, "none");
  assert.equal(o.log.calls.length, 0, "must not touch the runtime when nothing was ready");
  const accepted = await dispatch(base(a.url, o.url, { acceptUnverified: true }), noWait);
  a.s.close(); o.s.close();
  assert.equal(accepted.decision.model, "big:8b");
  assert.match(accepted.decision.why, /unverified/);
});

test("defers, asks again, and runs once a model becomes ready", async () => {
  const answers = { "big:8b": { readiness: "may_require_eviction" }, "small:4b": { readiness: "may_require_eviction" } };
  const a = await fakeAgent(answers);
  const o = await fakeOllama();
  let waits = 0;
  const rec = await dispatch(base(a.url, o.url, { deferTimeoutS: 60 }), { wait: async () => { waits++; answers["small:4b"] = { readiness: "ready_now" }; } });
  a.s.close(); o.s.close();
  assert.equal(waits, 1);
  assert.equal(rec.polls.length, 2);
  assert.equal(rec.decision.model, "small:4b");
});

test("--on-timeout proceed runs the first model and records that it was an override", async () => {
  const a = await fakeAgent({ "big:8b": { readiness: "may_require_eviction" }, "small:4b": { readiness: "may_require_eviction" } });
  const o = await fakeOllama();
  const rec = await dispatch(base(a.url, o.url, { deferTimeoutS: 0, onTimeout: "proceed" }), noWait);
  a.s.close(); o.s.close();
  assert.equal(rec.decision.override, true);
  assert.equal(rec.decision.model, "big:8b");
  assert.equal(o.log.calls.length, 1);
});

test("a model the agent has not seen is an answer, not a crash", async () => {
  const a = await fakeAgent({ "small:4b": { readiness: "ready_now" } });
  const o = await fakeOllama();
  const rec = await dispatch(base(a.url, o.url), noWait);
  a.s.close(); o.s.close();
  assert.equal(rec.answers["big:8b"].readiness, "cannot_determine");
  assert.equal(rec.decision.model, "small:4b");
});

test("--dry-run decides and sends nothing to the runtime or the receipts route", async () => {
  const a = await fakeAgent({ "big:8b": { readiness: "ready_now" } });
  const o = await fakeOllama();
  const rec = await dispatch(base(a.url, o.url, { dryRun: true }), noWait);
  a.s.close(); o.s.close();
  assert.equal(rec.decision.model, "big:8b");
  assert.equal(o.log.calls.length, 0);
  assert.equal(a.log.receipts.length, 0);
  assert.equal(rec.job, null);
});

test("a missing or wrong token says so and never echoes the token", async () => {
  const a = await fakeAgent({}, { token: "right" });
  await assert.rejects(callTool(a.url, "wicklee_readiness", {}, {}), /needs a token/);
  await assert.rejects(callTool(a.url, "wicklee_readiness", {}, { token: "hunter2" }), (e) => /rejected the token/.test(e.message) && !e.message.includes("hunter2"));
  const ok = await callTool(a.url, "wicklee_readiness", { model: "x" }, { token: "right" });
  a.s.close();
  assert.ok(ok.error);
});

test("pure helpers: decide and receiptFrom", () => {
  assert.equal(decide(["a", "b"], { a: { readiness: "requires_loading" }, b: { readiness: "ready_now" } }).model, "b");
  assert.equal(decide(["a"], { a: { readiness: "requires_loading", coexistence: "unverified" } }).action, "defer");
  assert.deepEqual(receiptFrom({ model: "m", response: "x", context: [1], eval_count: 3 }, 4096), { model: "m", eval_count: 3, num_ctx: 4096 });
});
