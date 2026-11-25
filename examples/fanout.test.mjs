// node --test examples/fanout.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { baseUrl, isLoopback, askNode, pick, render } from "./fanout.mjs";

function node(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, "127.0.0.1", () => resolve({ s, addr: `127.0.0.1:${s.address().port}` }));
  });
}
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

test("baseUrl fills in the default port and keeps explicit ones", () => {
  assert.equal(baseUrl("gpu-01"), "http://gpu-01:7700");
  assert.equal(baseUrl("gpu-01:7800"), "http://gpu-01:7800");
  assert.equal(baseUrl("https://gpu-01.example"), "https://gpu-01.example");
  assert.ok(isLoopback("http://127.0.0.1:7700"));
  assert.ok(!isLoopback("http://10.0.0.4:7700"));
});

test("sends the bearer token, asks for the model, and reads the answer", async () => {
  let seen;
  const { s, addr } = await node((req, res) => {
    seen = { url: req.url, auth: req.headers.authorization };
    json(res, 200, { node_id: "WK-1", headroom: { free_bytes: 8 * 1073741824 }, readiness: { model: "m:1b", readiness: "ready_now" } });
  });
  const r = await askNode(addr, { model: "m:1b", token: "secret" });
  s.close();
  assert.equal(seen.url, "/v1/readiness?model=m%3A1b");
  assert.equal(seen.auth, "Bearer secret");
  assert.equal(r.ok, true);
  assert.equal(r.answers[0].readiness, "ready_now");
});

test("a 401 is a result that says what to do, and never echoes the token", async () => {
  const { s, addr } = await node((req, res) => json(res, 401, { error: "missing bearer token" }));
  const none = await askNode(addr, {});
  const wrong = await askNode(addr, { token: "hunter2" });
  s.close();
  assert.match(none.error, /needs a token/);
  assert.match(wrong.error, /rejected the token/);
  assert.ok(!JSON.stringify(wrong).includes("hunter2"));
});

test("404, a dead node and a slow node each fail on their own", async () => {
  const nf = await node((req, res) => json(res, 404, { error: "m is not installed on this host" }));
  const slow = await node(() => {});
  const results = await Promise.all([
    askNode(nf.addr, { model: "m" }),
    askNode("127.0.0.1:1", {}),
    askNode(slow.addr, { timeoutMs: 150 }),
  ]);
  nf.s.close(); slow.s.closeAllConnections?.(); slow.s.close();
  assert.match(results[0].error, /not installed/);
  assert.match(results[1].error, /unreachable/);
  assert.match(results[2].error, /no answer in 150 ms/);
  assert.ok(results.every((r) => r.ok === false));
});

test("the example policy prefers ready_now and flags unverified coexistence", () => {
  const mk = (node, readiness, coexistence) => ({ node, ok: true, answers: [{ model: "m", readiness, coexistence }] });
  const c = pick([mk("a", "may_require_eviction"), mk("b", "requires_loading", "unverified"), mk("c", "cannot_determine")], "m");
  assert.equal(c.node, "b");
  assert.match(c.caveat, /unverified/);
  assert.equal(pick([mk("a", "ready_now"), mk("b", "requires_loading")], "m").node, "a");
  assert.equal(pick([{ node: "a", ok: false, error: "x" }], "m"), null);
  assert.equal(pick([mk("a", "ready_now")], undefined), null);
});

test("render lines results up and shows failures in the same table", () => {
  const out = render([
    { node: "a", ok: true, ms: 12, headroom: { free_bytes: 4 * 1073741824 }, answers: [{ model: "m", readiness: "ready_now" }] },
    { node: "b", ok: false, ms: 5000, error: "no answer in 5000 ms" },
  ], "m");
  assert.match(out, /NODE\s+MODEL\s+READINESS/);
  assert.match(out, /a\s+m\s+ready_now\s+4\.0 GB/);
  assert.match(out, /b\s+-\s+-\s+-\s+no answer/);
});
