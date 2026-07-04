# Wicklee — Go-to-Market Plan (July 2026)

> Constraint set: single founder, side hustle, ~zero ad budget. Goal: enterprise
> awareness through distribution, data, and partnerships — not advertising.
> Positioning: **"WES — the MPG for local AI"** / hardware-first observability
> that complements Datadog/Grafana. The moat: watts AND tokens in one store.

The operating rule: **every GTM motion must be durable** (a registry listing, a
ranking page, a partner's docs) or **compounding** (data flywheel, case study).
One-off promotion is a bad trade for founder hours.

---

## 1. Ecosystem embedding — be found inside tools people already use

Distribution through other people's surfaces. Each of these is a PR or a form,
costs hours not dollars, and pays forever.

| Surface | Motion | Why it works |
|---|---|---|
| **Hugging Face** | (a) A **Space** running a live demo dashboard (synthetic fleet) — "see your fleet before installing." (b) Publish the WES benchmark data as a **public HF Dataset** (per-chip × per-model tok/s, watts, WES) — datasets rank in HF search and get cited. (c) A **"hardware fit" badge** for model cards: a tiny SVG/link generator model authors can paste into READMEs ("Will this run on your hardware? → wicklee.dev/fit/<model>") | HF is where the ICP starts every model decision. The fit-check question ("will it run, what will it cost") is asked on every model page and answered nowhere |
| **Ollama / vLLM / llama.cpp ecosystems** | PR into each project's community-integrations / ecosystem docs page (all three accept these) | Perpetual qualified traffic from the exact runtimes Wicklee monitors |
| **MCP registries** | List the local + cloud MCP servers on the Anthropic servers repo, mcp.so, Smithery, Glama | AI-agent developers are early adopters with GPU fleets; Wicklee is one of very few observability MCP servers |
| **awesome-lists** | awesome-selfhosted, awesome-llmops, awesome-mcp, awesome-local-llm | awesome-selfhosted alone reliably drives installs for tools in this category |
| **Package managers** | Homebrew cask, Nixpkgs, (later) winget | "brew install wicklee" removes the last install friction and is itself discovery |
| **Grafana plugin catalog** | Ship the datasource plugin (Roadmap Phase 4) and list it | Enterprises *search the Grafana catalog*; a listing there is enterprise awareness with zero outreach |
| **Artifact Hub** | Helm chart once the K8s operator ships | Same logic for platform teams |

## 2. The data flywheel — WES Leaderboard as the content engine

The single highest-leverage asset on the roadmap. Elevate the planned public
WES Leaderboard from "nice feature" to **the GTM engine**:

- **Programmatic SEO pages** per (chip × model) combo: "RTX 4090 · Llama 3.1 70B —
  measured tok/s, watts, $/1M tokens." These queries have high buyer intent and
  no good answers today (vendor benchmarks are marketing; Reddit threads are
  anecdotes). Every page ends with the install one-liner.
- **Opt-in agent submissions** close the loop: more installs → more data →
  better pages → more installs. (Anonymous: chip, model, quant, tok/s, watts —
  consistent with the sovereignty story; hostnames/prompts never leave.)
- **Quarterly "State of Local Inference Efficiency" report** from the anonymized
  corpus — the artifact that AI newsletters (TLDR AI, Latent Space, Import AI)
  pick up without being paid, and that enterprise slide decks cite.

## 3. Founder-led content — time-boxed, data-first

Cap at 2–4 h/week. The existing blog instinct (thermal throttling deep-dive) is
right: **data posts, not marketing posts**.

- **r/LocalLLaMA is THE channel** — large, exactly ICP, and it *loves* measured
  efficiency data. One data post per major feature ("We measured thermal
  throttling across N Apple Silicon nodes — here's the tok/s cliff"). Also
  r/selfhosted, r/homelab.
- **One proper Show HN** when the leaderboard ships (the demo Space is the
  no-install hook). Feature launches are Reddit posts, not HN posts — save HN
  for moments.
- Blog SEO already works (prerendered pages, sitemap, og:image shipped). Keep
  one post per shipped feature, framed as the problem measured — not the
  feature announced.

## 4. Partnerships — leverage over volume (the enterprise-awareness core)

A single founder can't do outbound sales; partners have the sales teams.

1. **Hardware vendors & system integrators** (the cheat code): pitch Wicklee as
   the bundled observability layer for anyone selling local-AI boxes — NVIDIA
   partners shipping DGX/Spark, TinyBox/Lambda/System76-class vendors,
   Apple-focused MSPs. "Every box you sell ships paired to a fleet dashboard"
   is a value-add for *their* sale; their customers become Wicklee's enterprise
   logos. Offer margin on Team/Business.
2. **MSPs & consultancies deploying on-prem AI for regulated clients**: they
   need monitoring for every fleet they hand over. Build the **multi-org MSP
   console** (added to roadmap) so one MSP manages many client orgs — five MSP
   partners ≈ fifty enterprise deployments.
3. **FinOps Foundation / OpenCost**: export chargeback in the **FOCUS** format
   (the FinOps open billing standard — added to roadmap) and show up at FinOps X.
   Finance leaders are the Business-tier buyer, and "local AI cost governance"
   is an empty booth at that fair.
4. **Runtime/platform vendors' showcases**: Clerk, Railway, Ollama — vendors
   actively look for case studies of their own products; being one is free
   co-marketing.

## 5. Enterprise credibility without a sales team

- **Trust page** on wicklee.dev: data-flow diagram, what leaves the node
  (hardware telemetry) vs what never does (prompts/templates), RBAC + audit +
  SIEM story. The June security-review write-ups are already 80% of the copy.
- **Design-partner program**: 3–5 named companies get Business free for a year
  in exchange for a logo, a case study, and monthly feedback. Case studies are
  the only advertising enterprises trust; they also drive the roadmap.
- SOC 2 only when a real deal demands it (Vanta-class tooling makes it a
  quarter, not a year — don't start it speculatively).

## 6. Product-led loops already in the codebase

- **llms.txt / MCP discoverability** (shipped) — AI assistants recommending
  tools is a real and growing channel; Wicklee is unusually well-positioned.
- **Weekly digest email** (Roadmap item 10) — every forwarded digest is
  internal marketing inside a customer.
- **Read-only fleet share links** (added to roadmap) — "look at our fleet"
  links shared in Slack/Discord are a viral loop.

---

## Cadence (side-hustle budget: ~70% product / 30% GTM)

One GTM "rock" per month, sequenced so each builds on the last:

| Month | Rock |
|---|---|
| 1 | Registry blitz: MCP registries, awesome-lists, Ollama/vLLM/llama.cpp ecosystem PRs, Homebrew cask |
| 2 | HF Space demo fleet + HF benchmark Dataset |
| 3 | WES Leaderboard public pages (programmatic SEO) + opt-in submissions |
| 4 | r/LocalLLaMA data post + Show HN (demo Space as the hook) |
| 5 | First partner outreach: 3 MSPs + 2 hardware vendors, with the MSP console spec in hand |
| 6 | FOCUS export + FinOps Foundation contact; quarterly efficiency report #1 |

**North-star metric**: weekly paired-node activations (not stars, not traffic).
Each motion above should trace to it.
