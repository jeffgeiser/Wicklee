---
title: "Runtime Config Surface: See What Every Node Is Actually Running"
date: "2026-05-28"
description: "Two nodes loaded with the same model produce different WES scores. Why? Wicklee v0.9.0 surfaces the launch config of every Ollama, vLLM, and llama.cpp node so you can find out in one click."
tags: ["v0.9.0", "runtime", "ollama", "vllm", "llamacpp", "debugging"]
---

# Runtime Config Surface: See What Every Node Is Actually Running

You have two nodes in your fleet. Both running Ollama. Both loaded with `llama3.2:8b` at the same quantization. Same hardware class. Both showing as healthy.

Node A produces 28 tok/s with a WES of 14.2. Node B produces 22 tok/s with a WES of 11.1.

Why?

You SSH in. You eyeball logs. You run `ollama show llama3.2:8b` on each node and squint at the output, trying to spot a difference. You wonder if maybe the context length is different, or someone set a custom system prompt months ago, or one node is running an older quantization tag, or the GPU layer offload is different.

Eventually you find it: Node A is running with `num_gpu = 33` (all layers offloaded), Node B is running with `num_gpu = 27` (six layers on CPU because someone tweaked the Modelfile during a memory pressure event and forgot to change it back).

That hunt took an hour. The information you needed was visible the entire time — you just couldn't see it from a dashboard.

That's what v0.9.0 fixes.

## What Runtime Config Surface does

For every model loaded on every node in your fleet, Wicklee now captures the launch-time configuration and surfaces it through a single click in the dashboard. Specifically:

- **Ollama** — `POST /api/show` returns the parameters block, template, system prompt, GPU layer count, quantization level, and the model_info dictionary (context length, parameter count, layer architecture). All of it cached and queryable.
- **vLLM** — `GET /v1/server_info` (vLLM 0.5.0+) returns the served model name, max model length, tensor parallel size, and quantization. For older vLLM versions, Wicklee falls back to parsing the process command line via `ps aux`.
- **llama.cpp / llama-server** — `GET /props` returns the model path, context size, GPU layer count, and default generation settings. Raw llama.cpp without the server gets the process-args fallback.

Each runtime exposes config differently. Wicklee normalizes them into a common shape:

```json
{
  "model": "llama3.2:8b",
  "runtime": "ollama",
  "captured_at_ms": 1779388800000,
  "context_length": 8192,
  "n_gpu_layers": 33,
  "quantization": "Q4_K_M",
  "parameter_count": 8030261312,
  "template": "{{ .System }}\n\n{{ .Prompt }}",
  "system_prompt": "You are a helpful assistant.",
  "raw": { /* full original response */ }
}
```

Available via `GET /api/runtime-config?model=<name>` on every agent, or one click on the "Config" pill in the dashboard's diagnostic rail.

## The use case it was designed for

The Node A vs Node B scenario above is the primary case. With Runtime Config Surface, the hunt looks like this:

1. Notice the WES gap on the leaderboard.
2. Click the model name on each node. Modal opens with the full config.
3. Eyeball the diff. `num_gpu` is different. Done.

Total time: 30 seconds. The information was always there; now it's surfaced where you'd actually look.

## What it doesn't do

This is observability, not enforcement. Wicklee doesn't push configurations to nodes, doesn't change anyone's Modelfile, doesn't modify running processes. It reads what's there and shows it to you. Whether you act on the diff is up to you (or your operator scripts that consume the API).

That's deliberate. Putting Wicklee in the request path or the configuration path would change the failure mode entirely. If Wicklee goes down, you lose visibility — not your inference service. We optimize for that asymmetry on purpose.

## Privacy: what stays local

System prompts can contain proprietary information. Templates can reflect internal product structure. Wicklee handles this with a privacy-first default:

- The **full config** (including `template` and `system_prompt`) lives in the agent's in-memory cache on each node and is served to the localhost dashboard via the agent's local API only.
- The **cloud telemetry path** strips `template` and `system_prompt` by default. Fleet aggregation sees the metadata (model name, context length, quantization, GPU layers) but not the prompt-level content.
- Users who want full config sharing across the fleet (for, say, centralized config audit) can opt in via `config.toml`, but it's off by default.

This isn't a privacy policy. It's a structural default — the cloud-push serialization simply doesn't include those fields unless you turn them on.

## Three things you can do with it today

**1. Diff configs across nodes.** The dashboard's modal shows the per-node view; the API lets you fetch two configs and diff them in any tool. A simple shell example:

```bash
curl -s http://node-a:7700/api/runtime-config?model=llama3.2:8b > a.json
curl -s http://node-b:7700/api/runtime-config?model=llama3.2:8b > b.json
diff <(jq -S . a.json) <(jq -S . b.json)
```

**2. Audit fleet-wide configs.** For Team and Business tiers running multiple nodes, the cloud aggregator (with opt-in full sharing) can answer "show me every node running Llama 3.2 with a context length different from 8192." Useful for compliance and for catching configuration drift before it becomes a performance mystery.

**3. Build a config-history view.** Wicklee captures `captured_at_ms` on every snapshot. With DuckDB enabled (default on glibc Linux and macOS builds), you can query "what was the config 3 days ago, when WES was 23% higher?" The data is local; the queries are SQL.

## Available now

Runtime Config Surface ships in [v0.9.0](https://github.com/jeffgeiser/Wicklee/releases/tag/v0.9.0). All tiers, no upgrade required, no configuration to enable. The harvesters auto-detect each runtime via the same process scanner Wicklee already uses for Ollama/vLLM/llama.cpp.

To upgrade an existing install:

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
sudo ~/.wicklee/bin/wicklee --install-service
```

That's it. The "Config" pill appears next to active models in the diagnostic rail; multi-model nodes get per-row config links in the Active Models panel. The new dedicated [Models tab](https://wicklee.dev/dashboard) (also new this week) gives you a fleet-wide view of discovery, comparison, and configs in one place.

---

*Wicklee is open source under FSL-1.1-Apache-2.0 (converts to Apache 2.0 after 4 years). Source on [GitHub](https://github.com/jeffgeiser/Wicklee).*
