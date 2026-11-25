#!/usr/bin/env node
// Ask several Wicklee nodes the same readiness question and print the answers
// side by side.
//
//   node examples/fanout.mjs --nodes gpu-01,gpu-02:7700 --model llama3.1:8b
//   WICKLEE_TOKEN=... node examples/fanout.mjs --nodes-file nodes.txt --json
//
// Wicklee has no aggregator: every node answers for itself, and the caller
// fans out. This is that caller, in about a hundred lines, with no
// dependencies (Node 18+).
//
// Flags
//   --nodes <a,b,c>     host or host:port, comma separated (port defaults to 7700)
//   --nodes-file <path> one host[:port] per line; blank lines and # comments ignored
//   --model <name>      ask about one model (GET /v1/readiness?model=...)
//                       omit to get every model each node knows
//   --token <t>         bearer token; prefer the WICKLEE_TOKEN environment variable,
//                       which does not show up in `ps`
//   --timeout <ms>      per-node timeout (default 5000)
//   --json              machine-readable output
//
// A node bound to a non-loopback address refuses requests without its
// `auth_token` (config.toml). The token authenticates the caller and does not
// encrypt anything: over plain http it crosses the network readable. Put the
// nodes on a trusted network or behind TLS; this script warns when it sends a
// token over http to a non-loopback host.
//
// Exit status: 0 if every node answered, 1 if any did not, 2 on bad usage.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RANK = { ready_now: 0, requires_loading: 1, may_require_eviction: 2, cannot_determine: 3 };

/** "host" or "host:port" or "http(s)://host[:port]" -> a base URL. */
export function baseUrl(node, defaultPort = 7700) {
  const n = node.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(n)) return n;
  return /:\d+$/.test(n) || n.startsWith("[") ? `http://${n}` : `http://${n}:${defaultPort}`;
}

export function isLoopback(url) {
  const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/** Ask one node. Never throws: a node that fails is a result, not an error. */
export async function askNode(node, { model, token, timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const base = baseUrl(node);
  const url = `${base}/v1/readiness${model ? `?model=${encodeURIComponent(model)}` : ""}`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const started = Date.now();
  try {
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - started;
    let body = null;
    try { body = await r.json(); } catch { /* non-JSON body */ }
    if (r.status === 401) return { node, ok: false, ms, error: token ? "rejected the token" : "needs a token (set WICKLEE_TOKEN)" };
    if (r.status === 404) return { node, ok: false, ms, error: body?.error ?? "model not installed on this node" };
    if (!r.ok) return { node, ok: false, ms, error: `HTTP ${r.status}` };
    const answers = model ? (body?.readiness ? [body.readiness] : []) : (body?.models ?? []);
    return { node, ok: true, ms, node_id: body?.node_id ?? null, headroom: body?.headroom ?? null, answers };
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { node, ok: false, ms: Date.now() - started, error: timedOut ? `no answer in ${timeoutMs} ms` : `unreachable (${e?.cause?.code ?? e?.message})` };
  }
}

/**
 * An example policy, not Wicklee's: the node whose answer for `model` ranks
 * best. Evidence stays attached; an unverified coexistence is called out
 * because it is the answer least safe to act on.
 */
export function pick(results, model) {
  if (!model) return null;
  const rows = results
    .filter((r) => r.ok && r.answers[0])
    .map((r) => ({ node: r.node, a: r.answers[0] }))
    .sort((x, y) => (RANK[x.a.readiness] ?? 9) - (RANK[y.a.readiness] ?? 9));
  if (!rows.length) return null;
  const best = rows[0];
  return {
    node: best.node,
    readiness: best.a.readiness,
    caveat: best.a.coexistence === "unverified" ? "coexistence is unverified: fits by accounting, may still displace a resident model" : null,
  };
}

function gb(bytes) { return bytes == null ? "-" : `${(bytes / 1073741824).toFixed(1)} GB`; }

export function render(results, model) {
  const rows = [];
  for (const r of results) {
    if (!r.ok) { rows.push([r.node, "-", "-", "-", r.error]); continue; }
    if (!r.answers.length) { rows.push([r.node, "-", "-", gb(r.headroom?.free_bytes), model ? "no answer for that model" : "no models seen yet (is the runtime up?)"]); continue; }
    for (const a of r.answers) {
      rows.push([r.node, a.model, a.readiness + (a.coexistence === "unverified" ? " (unverified)" : ""), gb(a.headroom?.free_bytes ?? r.headroom?.free_bytes), `${r.ms} ms`]);
    }
  }
  const head = ["NODE", "MODEL", "READINESS", "HEADROOM", "NOTE"];
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  return all.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd()).join("\n");
}

async function main(argv) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
  let nodes = [];
  if (flag("nodes")) nodes.push(...flag("nodes").split(",").map((s) => s.trim()).filter(Boolean));
  if (flag("nodes-file")) {
    const text = await readFile(flag("nodes-file"), "utf8");
    nodes.push(...text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));
  }
  if (!nodes.length) {
    console.error("usage: node examples/fanout.mjs --nodes host[:port],host[:port] [--model NAME] [--json]");
    process.exit(2);
  }
  const model = flag("model");
  const token = flag("token") ?? process.env.WICKLEE_TOKEN;
  const timeoutMs = Number(flag("timeout") ?? 5000);
  if (!(timeoutMs > 0)) { console.error("--timeout must be a positive number of milliseconds"); process.exit(2); }

  if (token && nodes.some((n) => /^http:\/\//i.test(baseUrl(n)) && !isLoopback(baseUrl(n)))) {
    console.error("note: sending the token over plain http. It authenticates you and does not encrypt it; use a trusted network or TLS.");
  }

  const results = await Promise.all(nodes.map((n) => askNode(n, { model, token, timeoutMs })));
  const choice = pick(results, model);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ model: model ?? null, results, example_policy_choice: choice }, null, 2));
  } else {
    console.log(render(results, model));
    if (choice) {
      console.log(`\nExample policy (yours to replace): ${choice.node} — ${choice.readiness}${choice.caveat ? `. Caveat: ${choice.caveat}` : ""}`);
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main(process.argv.slice(2));
