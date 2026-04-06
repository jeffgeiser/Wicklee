# Wicklee Go-to-Market Plan: $500K ARR

**Target:** $500K ARR within 12 months
**Start date:** April 7, 2026
**Product:** Sovereign GPU fleet monitor for local AI inference

---

## ARR Math

| Tier | Price | Annual | Target | Revenue |
|------|-------|--------|--------|---------|
| Pro | $9/mo | $108/yr | 2,000 subs | $216,000 |
| Team | $19/seat x 3 min = $57/mo | $684/yr | 200 teams | $136,800 |
| Enterprise | From $200/mo | ~$3,600/yr avg | 40 accounts | $144,000 |
| **Total** | | | | **$496,800** |

Blended ARPU: ~$222/yr. Need ~2,250 paid accounts total across tiers.

---

## 5 Viral Hooks (strongest narratives)

**1. "Your GPU is burning money and you can't see it"**
Most developers running Ollama have zero visibility into power draw. An M2 Max at idle with a loaded model draws 8-12W doing nothing. At $0.15/kWh, a 3-node homelab wastes $40-80/year on phantom load alone. Wicklee shows this in real time. Screenshot the Cost/Day tile showing $0.47/day for an idle node.

**2. "tok/W is the new tok/s"**
Everyone benchmarks tokens per second. Nobody benchmarks tokens per watt. An M4 Pro gets 12 tok/W. An RTX 4090 gets 2.8 tok/W. A 4x difference nobody talks about because nobody measures it. WES makes this visible. This reframes the entire M-series vs NVIDIA debate.

**3. "18 hardware patterns your monitoring stack can't see"**
Datadog, Prometheus, Grafana -- none of them know what a TTFT regression looks like, or that your PCIe link degraded from x16 to x8, or that your vLLM KV cache is 94% full. Wicklee ships 18 inference-specific observation patterns that fire automatically.

**4. "30 seconds from zero to full observability"**
`curl -fsSL https://wicklee.dev/install.sh | bash` -- one command, no Docker, no Kubernetes, no YAML, no Prometheus config, no Grafana dashboards. Dashboard at localhost:7700 in 30 seconds. Pair to fleet in 60 seconds. This is the anti-complexity pitch.

**5. "Sovereign by design -- your inference content never leaves the machine"**
The agent runs as a system daemon. It reads hardware sensors (powermetrics, NVML, IOKit). It never touches model weights, prompts, or completions. Only telemetry metadata (watts, temperature, tok/s, VRAM) goes to the fleet dashboard. For regulated industries and privacy-conscious teams, this is the entire value proposition.

---

## Channel Strategy

### Reddit Communities (ranked by priority)
1. **r/LocalLLaMA** (430K+ members) -- primary target. Technical audience running Ollama/vLLM. Post format: "I built X" with screenshots. Engage in comments about hardware comparisons.
2. **r/ollama** (50K+) -- Ollama-specific. Share proxy metrics, TTFT insights, model loading analysis.
3. **r/selfhosted** (350K+) -- sovereign design angle. "Monitor your local AI without cloud dependencies."
4. **r/homelab** (1.5M+) -- power monitoring, cost tracking. "I finally know what my inference cluster costs to run."
5. **r/MachineLearning** (3M+) -- WES as a research metric, tok/W analysis.
6. **r/vllm** -- vLLM queue saturation, KV cache patterns.
7. **r/nvidia** -- NVIDIA-specific thermal patterns, power draw analysis.

### Hacker News
- Show HN post in Week 2 (after Reddit validation)
- Target 50+ points for front page
- Title format: "Show HN: Wicklee -- sovereign GPU fleet monitor for local AI inference (Rust)"

### Newsletters to Pitch
1. **TLDR AI** (tldr.tech/ai) -- 500K+ subscribers. Pitch: "New OSS tool measures tokens-per-watt for local AI"
2. **The Batch** (deeplearning.ai) -- Andrew Ng's newsletter. Pitch: efficiency metric angle
3. **Changelog** -- changelog.com/news. OSS Rust project angle
4. **Console.dev** -- weekly OSS roundup. Submit via console.dev/tools
5. **Hacker Newsletter** -- curated from HN. Get on HN first
6. **Benedict Evans Newsletter** -- pitch the "infrastructure layer for local AI" angle
7. **AI Breakfast** -- daily AI news, submit tips
8. **Last Week in AI** -- weekly roundup, submit via their form
9. **Rust Weekly** -- rustlang community newsletter

### Podcasts to Target
1. **Changelog / Ship It** -- OSS infrastructure, Rust
2. **Oxide and Friends** -- systems engineering, Rust
3. **Practical AI** -- applied AI, inference optimization
4. **Latent Space** -- AI engineering depth
5. **The AI Breakdown** -- practical AI applications
6. **Self-Hosted Show** (Jupiter Broadcasting) -- perfect audience overlap
7. **CoRecursive** -- technical deep dives

### Product Hunt
- Target Week 6 (after community traction)
- Need 5+ "hunter" upvotes in first hour
- Prepare: 4 screenshots, 30-second GIF, tagline, description

### SEO Targets (blog posts / landing pages)
- "ollama monitoring" / "monitor ollama" -- near zero competition
- "local llm power consumption"
- "vllm observability"
- "tokens per watt" / "tok/W benchmark"
- "gpu fleet monitoring"
- "apple silicon inference benchmark"
- "local ai cost calculator"

---

## Week 0 -- Pre-Launch Prep (March 30 - April 6)

### Checklist
- [ ] GitHub README polished: hero screenshot, one-line install, feature matrix, architecture diagram
- [ ] wicklee.dev landing page: above-the-fold screenshot, install command, 3-pillar value prop
- [ ] Record 30-second install GIF (terminal -> dashboard in real time)
- [ ] Record 60-second fleet pairing GIF
- [ ] Take 5 high-quality dashboard screenshots (dark mode, real data): Overview, Fleet Status expanded, Diagnostics rail, Observations firing, Performance tab
- [ ] Write 3 blog posts (publish Week 1-3): "Why tok/W matters more than tok/s", "18 patterns your monitoring stack can't detect", "The hidden cost of running Ollama"
- [ ] Set up analytics: GitHub star tracking, install.sh download counter, wicklee.dev analytics
- [ ] Create Twitter/X account (@wickaboratory or @wicklee_dev), LinkedIn company page
- [ ] Prepare Product Hunt draft (don't submit yet)
- [ ] Draft Show HN and r/LocalLLaMA launch posts
- [ ] Set up Buttondown or similar for email newsletter (wicklee.dev/newsletter)
- [ ] Prepare comparison table: Wicklee vs Prometheus+Grafana vs nvtop vs nvidia-smi vs nothing
- [ ] Create a "press kit" page: logo, screenshots, one-pager, founder bio

---

## Monthly Milestones

| Metric | Month 1 (Apr) | Month 2 (May) | Month 3 (Jun) | Month 6 (Sep) | Month 12 (Mar '27) |
|--------|---------------|---------------|---------------|---------------|---------------------|
| GitHub Stars | 500 | 1,500 | 3,000 | 8,000 | 15,000 |
| Installs (cumulative) | 1,000 | 4,000 | 10,000 | 30,000 | 80,000 |
| Pro subscribers | 50 | 200 | 500 | 1,200 | 2,000 |
| Team accounts | 5 | 20 | 50 | 120 | 200 |
| Enterprise | 0 | 1 | 3 | 15 | 40 |
| MRR | $700 | $3,200 | $8,500 | $22,000 | $41,500 |
| ARR run rate | $8,400 | $38,400 | $102,000 | $264,000 | $498,000 |
| X followers | 200 | 800 | 2,000 | 5,000 | 12,000 |
| LinkedIn followers | 100 | 400 | 1,000 | 2,500 | 6,000 |
| Newsletter subs | 50 | 300 | 800 | 2,500 | 6,000 |

---

## WEEK 1: April 7-11, 2026 -- Soft Launch

### Theme: "Your GPU is burning money"

### LinkedIn Posts

**L1 - Tuesday Apr 7: "The Hidden Cost of Local AI Nobody's Measuring"**
Technical post about phantom load. Most devs running Ollama don't realize a loaded model draws 8-12W even when idle. 3 nodes x 10W x 24hrs = 720Wh/day wasted. Show the Wicklee Cost/Day tile screenshot. End with the one-liner install.

**L2 - Thursday Apr 9: "I Built a 'Check Engine Light' for GPUs Running Local Inference"**
Origin story post. Why existing monitoring (nvidia-smi, htop, Activity Monitor) isn't enough for inference workloads. The gap between "GPU is at 80%" and "is my model actually generating tokens?" Introduce inference state machine concept. Screenshot of the 4-state indicator.

**L3 - Saturday Apr 11: "Why Local AI Observability Is Fundamentally Different from Cloud"**
Thought leadership. Cloud inference providers meter everything. Local inference has zero metering. You don't know your tok/s, your cost per query, your TTFT, or whether thermal throttling is silently degrading quality. Frame Wicklee as the missing layer.

### X/Twitter Posts

**X1 - Mon Apr 7:**
Your M4 Mac Mini running Ollama right now: drawing 8W doing absolutely nothing.

That's $11/year per node in phantom load.

And you can't even see it because Activity Monitor doesn't show SoC power.

One command to start seeing it:
curl -fsSL https://wicklee.dev/install.sh | bash

**X2 - Tue Apr 8:**
nvidia-smi: "GPU 82% utilized"

But is it running inference? Training? Just VRAM residency from a loaded model?

nvidia-smi can't tell you. Wicklee can.

4 inference states. 3 detection tiers. 0 guessing.

[screenshot of inference state machine]

**X3 - Wed Apr 9:**
The entire Ollama monitoring stack today:

ollama ps
ollama list

That's it. No power. No TTFT. No efficiency. No cost.

We built the missing layer.

wicklee.dev

**X4 - Thu Apr 10:**
30 seconds from zero to full GPU observability:

curl -fsSL https://wicklee.dev/install.sh | bash

No Docker. No k8s. No Prometheus. No Grafana.

One binary. localhost:7700.

[30-second install GIF]

**X5 - Fri Apr 11:**
Local AI in 2026:

- Ollama: easy to run
- vLLM: easy to serve
- Monitoring: ???

The inference layer got simple. The observability layer didn't exist.

Until now. wicklee.dev

### Marketing Activities

- **Mon Apr 7:** Post to r/LocalLLaMA: "I built a hardware monitor specifically for local AI inference -- here's what I learned about phantom GPU load" (include screenshots, be technical, respond to every comment for 48 hours)
- **Tue Apr 8:** Post to r/ollama: "Ollama monitoring beyond `ollama ps` -- real-time tok/s, power draw, TTFT, and cost tracking" (narrower focus, Ollama-specific details)
- **Wed Apr 9:** Post to r/selfhosted: "Sovereign GPU monitoring for your local inference cluster -- no cloud dependency, one binary per node"
- **Thu-Fri:** Engage heavily in all Reddit comment threads. Answer every question. Share additional screenshots. Be helpful, not salesy.
- **Fri Apr 11:** Submit to Console.dev weekly OSS picks, Changelog News

---

## WEEK 2: April 14-18, 2026 -- Hacker News Launch

### Theme: "tok/W is the new metric"

### LinkedIn Posts

**L4 - Tuesday Apr 14: "tok/W: The Metric Nobody Benchmarks But Everyone Should"**
Deep dive into tokens-per-watt as the real efficiency metric. M4 Pro: ~12 tok/W. RTX 4090: ~2.8 tok/W. This isn't about M-series being "better" -- it's about TCO for inference at different scales. Include a comparison table. Reference the Stanford/Together AI "Intelligence per Watt" paper.

**L5 - Thursday Apr 16: "Show HN Day -- What We Learned Launching Wicklee"**
Real-time commentary on the HN launch. Share the post link. Authentic reflections on what resonated, what people asked, what surprised you. Numbers if they're good.

### X/Twitter Posts

**X6 - Mon Apr 14:**
M4 Pro: 45 tok/s at 3.8W = 11.8 tok/W
RTX 4090: 120 tok/s at 43W = 2.8 tok/W

The 4090 is 2.6x faster.
The M4 is 4.2x more efficient.

Nobody talks about this because nobody measures it.

WES does. wicklee.dev/docs

**X7 - Tue Apr 15 [HN Launch Day]:**
Show HN is live.

Wicklee: sovereign GPU fleet monitor for local AI inference.

One Rust binary. 18 hardware patterns. WES efficiency scoring. 30-second install.

Your inference content never leaves the machine.

[HN link]

**X8 - Wed Apr 16:**
Things Wicklee detects that your monitoring stack doesn't:

- TTFT regression (model cold start vs warm)
- PCIe lane degradation (x16 -> x8)
- vLLM KV cache approaching saturation
- Phantom GPU load from idle loaded models
- Thermal throttling impact on tok/s

18 patterns, zero config.

**X9 - Thu Apr 17:**
"But I already have Prometheus + Grafana"

Cool. Did you write custom exporters for:
- Ollama inference state?
- Apple Silicon SoC power?
- vLLM queue depth?
- Per-model TTFT tracking?
- Thermal-adjusted efficiency scores?

That's 40+ hours of config work. Or 30 seconds:
curl -fsSL https://wicklee.dev/install.sh | bash

**X10 - Fri Apr 18:**
Stack for running local AI in 2026:

Hardware: M4 Mac Mini / RTX box / mixed fleet
Runtime: Ollama + vLLM
Monitoring: Wicklee
Routing: Wicklee Best Route API

Total setup time: under 5 minutes.

### Marketing Activities

- **Tue Apr 15:** Submit Show HN post. Title: "Show HN: Wicklee -- GPU fleet monitor for local AI (Rust, 18 hardware patterns, 30s install)". Be online for 6+ hours to respond to comments.
- **Wed Apr 16:** If HN traction is good (50+ points), pitch TLDR AI newsletter. Subject: "New OSS tool introduces tokens-per-watt metric for local AI inference"
- **Thu Apr 17:** Submit to Rust Weekly newsletter
- **Fri Apr 18:** Post to r/rust: "Wicklee -- a Tokio/Axum service for real-time GPU telemetry (lessons from building a hardware monitor in Rust)"
- **All week:** Monitor HN comments, respond thoughtfully. Cross-post interesting HN discussions to Twitter/X.

---

## WEEK 3: April 21-25, 2026 -- Technical Depth

### Theme: "18 patterns nobody else detects"

### LinkedIn Posts

**L6 - Tuesday Apr 21: "18 Hardware Patterns Your Monitoring Stack Can't See"**
Catalog post. Group the 18 patterns by category: Thermal (A, N), Power (B, D, H), Memory (F, J, O), Inference (M, P, Q, R), Hardware (G, K, L), Fleet (C, E, I). For each, one sentence on what it detects and why traditional monitoring misses it. This is a reference post people will bookmark.

**L7 - Thursday Apr 23: "The Inference State Machine: How We Solved the 'Is It Actually Running?' Problem"**
Technical deep dive. The 3-tier detection hierarchy: Tier 1 (vLLM active requests -- exact), Tier 2 (Ollama expires_at attribution -- user vs probe), Tier 3 (physics -- GPU residency, power, ANE). Why you need all three tiers. The "dead zone" bug story.

**L8 - Saturday Apr 25: "Thermal Throttling Is Silently Destroying Your Inference Quality"**
WES thermal penalty explained. Normal=1.0, Fair=1.25, Serious=1.75, Critical=2.0. A node that looks fine at 40 tok/s but is thermally stressed: same tok/s, but WES drops 25-43% because you're consuming recovery headroom. Show the Thermal Cost % calculation.

### X/Twitter Posts

**X11 - Mon Apr 21:**
Pattern A: Thermal Performance Drain

Your node hits "Serious" thermal state.
tok/s looks the same.
But WES drops 43%.

Why? You burned your thermal headroom. One sustained load and you're clock-throttled.

Wicklee catches this before you notice the slowdown.

**X12 - Tue Apr 22:**
Pattern M: vLLM KV Cache Saturation

kv_cache_usage > 90% for 3+ minutes.

What happens next: requests start swapping to CPU memory. Latency 10x. Queue builds. Users complain.

Wicklee fires Pattern M at 90% so you can act at 90%, not discover at 100%.

**X13 - Wed Apr 23:**
How Wicklee knows if YOU started inference or if the PROBE did:

1. Agent sends 20-token probe every 30s
2. Probe sets a one-shot flag on completion
3. Next expires_at change: flag consumed = probe caused it
4. No flag = user request = LIVE state

No time-based blackout. No false positives. Pure attribution.

**X14 - Thu Apr 24:**
"Why do I need 18 observation patterns?"

You don't. You need the 3 that matter for YOUR hardware.

M-series? A (thermal), B (phantom load), O (VRAM overcommit)
NVIDIA? N (thermal ceiling), D (power decoupling), M (KV cache)
Mixed fleet? E (load imbalance), C (WES velocity), I (efficiency drag)

Wicklee auto-detects your platform.

**X15 - Fri Apr 25:**
Prometheus can monitor your GPU.
Grafana can chart it.
But neither can tell you:

"Your M4's TTFT regressed 2x in the last 2 minutes -- cold model reload detected"

That's Pattern P. One of 18.

wicklee.dev

**X16 - Sat Apr 26:**
Lines of YAML to get Ollama metrics in Grafana: ~200
Lines of config to get the same in Wicklee: 0

curl -fsSL https://wicklee.dev/install.sh | bash

Dashboard at localhost:7700 in 30 seconds.
18 patterns. Zero config. Real data.

### Marketing Activities

- **Mon Apr 21:** Publish blog post: "18 Hardware Patterns Your Monitoring Stack Can't Detect" (long-form version of LinkedIn post). Optimize for "ollama monitoring", "vllm observability", "gpu inference monitoring".
- **Wed Apr 23:** Post to r/MachineLearning: "We built an inference-specific observation engine with 18 hardware patterns -- here's the detection methodology" (academic/research angle, reference the Stanford tok/W paper)
- **Fri Apr 25:** Engage in r/LocalLLaMA hardware comparison threads. Add tok/W data points from Wicklee whenever someone asks "M4 vs RTX for inference?"
- **All week:** Comment on relevant Twitter/X threads about Ollama, vLLM, local AI. Add value first, mention Wicklee only when directly relevant.

---

## WEEK 4: April 28 - May 2, 2026 -- Sovereign Design

### Theme: "Your inference, your data"

### LinkedIn Posts

**L9 - Tuesday Apr 28: "Why We Built Wicklee to Never Touch Your Prompts"**
Sovereign design deep dive. The agent reads hardware sensors only: powermetrics, NVML, IOKit, sysctl. It intercepts Ollama's /api/ps for timing data but never reads request/response content. Only telemetry metadata (watts, temperature, tok/s, VRAM) goes to the fleet aggregator. For healthcare, legal, finance, defense -- this matters.

**L10 - Thursday Apr 30: "The Infrastructure Layer for Local AI Is Missing"**
Bigger picture post. Cloud AI has mature observability (LangSmith, Weights & Biases, Datadog LLM Monitoring). Local AI has nothing. Not because it doesn't need it, but because the economics were wrong. Now, with $500 Mac Minis running 30B models, local inference is real infrastructure. Real infrastructure needs real monitoring.

### X/Twitter Posts

**X17 - Mon Apr 28:**
What Wicklee telemetry contains:
- Watts drawn
- GPU temperature
- tok/s throughput
- VRAM usage
- Inference state

What Wicklee telemetry does NOT contain:
- Prompts
- Completions
- Model weights
- API keys
- User data

Sovereign by design.

**X18 - Tue Apr 29:**
A hospital running local Llama for medical notes.
A law firm running local Mistral for contract review.
A defense contractor running local inference for classified analysis.

All need monitoring. None can send inference data to the cloud.

This is why Wicklee exists.

**X19 - Wed Apr 30:**
Your monitoring options for local AI:

nvidia-smi: power + temp (NVIDIA only)
Activity Monitor: CPU + memory (no GPU power)
htop: processes (no inference awareness)
Prometheus+Grafana: 4 hours of config per node

Wicklee: 30 seconds, all platforms, inference-aware

**X20 - Thu May 1:**
Fleet dashboard for 5 Mac Minis running Ollama:

- Real-time tok/s per node
- Total fleet VRAM capacity
- Best Route API (lowest latency node)
- Cost per day (actual watts x your rate)
- 18 patterns firing across all nodes

$9/mo per node. Or free for 3 nodes.

**X21 - Fri May 2:**
Local AI adoption in 2026:
- 50M+ Ollama downloads
- Apple ships M4 Ultra (192GB unified memory)
- vLLM + SGLang handle production loads
- 70B models run on consumer hardware

Local AI monitoring in 2026:
- nvidia-smi
- ollama ps

We're fixing this. wicklee.dev

### Marketing Activities

- **Tue Apr 29:** Pitch Latent Space podcast (email). Angle: "the missing observability layer for local AI inference"
- **Wed Apr 30:** Pitch Self-Hosted Show (Jupiter Broadcasting). Angle: "sovereign GPU monitoring, zero cloud dependency"
- **Thu May 1:** Post to r/homelab: "I monitor my 5-node inference cluster's power consumption and cost -- here's what I found" (share actual cost data, efficiency comparisons)
- **Fri May 2:** Start reaching out to 5 Ollama/vLLM community members for beta testimonials. Offer Pro accounts in exchange for honest feedback posts.

---

## WEEK 5: May 5-9, 2026 -- Apple Silicon Focus

### Theme: "M-series inference is different"

### LinkedIn Posts

**L11 - Tuesday May 5: "Apple Silicon Changed Inference Economics. Your Monitoring Should Reflect That."**
Unified memory, SoC power reporting (combined CPU+GPU+ANE on a single die), passive thermals, no VRAM boundary -- everything about monitoring M-series inference is different from NVIDIA. Wicklee handles both. Show side-by-side: M4 diagnostics rail vs NVIDIA diagnostics rail.

**L12 - Thursday May 7: "The M4 Mac Mini Is a $500 Inference Server. Here's the Proof."**
Concrete numbers. M4 running Llama 3.1 8B Q4: 45 tok/s at 3.8W SoC power. $0.12/day. Compare to an RTX 4090 rig: 120 tok/s at $1.40/day. Break-even analysis for different workloads. All numbers from Wicklee telemetry.

### X/Twitter Posts

**X22 - Mon May 5:**
Apple Silicon inference monitoring is completely different:

- No nvidia-smi (use powermetrics instead)
- Unified memory (GPU VRAM = system RAM)
- SoC power = CPU + GPU + ANE combined
- Thermal via IOKit, not NVML
- gpu_wired_limit_mb, not vram_total

Wicklee handles all of this natively.

**X23 - Tue May 6:**
M4 Mac Mini inference costs:

Idle (model loaded): 8W = $0.03/day
Active inference: 12W = $0.04/day
24/7 serving: ~$14/year

An RTX 4090 at idle: 30W = $0.11/day
Active: 300W+ = $1.10/day

The efficiency gap is massive. And unmeasured. Until Wicklee.

**X24 - Wed May 7:**
Fun fact: Apple's powermetrics reports SoC power as "Combined Power (CPU + GPU + ANE)".

This single number is the correct denominator for Apple Silicon WES.

Using just cpu_power_w? You're measuring 0.1W idle (CPU cluster only). The real SoC draw is 3-12W.

We spent weeks getting this right.

**X25 - Thu May 8:**
M4 idle board power can read 0.2-0.4W.

This is real, not a sensor fault.

We know because we almost added a minimum-power sanity check that would have discarded these readings.

Hardware is weird. Good monitoring doesn't assume.

**X26 - Fri May 9:**
3 Mac Minis running Ollama.
Total fleet VRAM: 72GB unified.
Total fleet cost: $0.36/day.
Total fleet tok/s: 135.

Same throughput as a single 4090.
1/4 the power. 1/3 the cost. Zero fan noise.

Wicklee shows you these numbers. wicklee.dev

### Marketing Activities

- **Mon May 5:** Publish blog post: "Apple Silicon Inference Economics: Real Numbers from Wicklee Telemetry". Target SEO: "apple silicon inference benchmark", "m4 ollama performance".
- **Wed May 7:** Post to r/mac and r/apple: "Real-world power consumption data from running LLMs on M4" (pure data, no hard sell)
- **Thu May 8:** Pitch Apple-focused tech blogs: 9to5Mac, MacRumors. Angle: "Tool shows exact cost of running AI on your Mac"
- **Fri May 9:** Reach out to popular Ollama YouTube creators (Matt Williams, NetworkChuck) for potential review/demo

---

## WEEK 6: May 12-16, 2026 -- Product Hunt Launch

### Theme: "Product Hunt week"

### LinkedIn Posts

**L13 - Monday May 12: "We're Launching on Product Hunt Tomorrow"**
Announcement post. Recap what Wicklee does, why it matters, call for support. Include the PH preview link.

**L14 - Wednesday May 14: "Product Hunt Launch: Day 1 Results"**
Real-time results post. Share ranking, upvote count, feedback themes. Be authentic about what's working and what people are asking for.

**L15 - Friday May 16: "What Product Hunt Taught Us About Positioning Developer Tools"**
Retrospective. What headline worked, what screenshot got clicks, what questions came up repeatedly. Useful content for other founders.

### X/Twitter Posts

**X27 - Mon May 12:**
Tomorrow: Wicklee launches on Product Hunt.

GPU fleet monitor for local AI inference.
18 hardware patterns. WES efficiency scoring.
One binary. 30-second install.

If you run Ollama or vLLM, this was built for you.

wicklee.dev

**X28 - Tue May 13 [PH Launch Day]:**
We're live on Product Hunt.

Wicklee: the missing monitoring layer for local AI inference.

One command. Every GPU. Every metric that matters.

[Product Hunt link]

Would mean a lot if you checked it out.

**X29 - Wed May 14:**
Product Hunt update: [X] upvotes, #[Y] product of the day.

The #1 question so far: "Does it work with llama.cpp?"

Answer: Yes. Runtime detection covers Ollama, vLLM, and llama.cpp. Hardware telemetry works regardless of runtime.

**X30 - Thu May 15:**
Most requested feature from Product Hunt:

[Insert actual top request here]

Already on the roadmap. Shipping in [timeframe].

This is why you launch publicly. wicklee.dev

**X31 - Fri May 16:**
Product Hunt week recap:

[X] upvotes
[Y] new installs
[Z] new Pro subscribers
[W] GitHub stars gained

Best comment: "[quote from PH]"

Hardest question: "[tough question]"

Next up: [what's shipping next]

### Marketing Activities

- **Tue May 13:** Product Hunt launch. Be online 6am-midnight. Respond to every comment. Share on all social channels. Email newsletter subscribers. Post in Discord/Slack communities.
- **Wed May 14:** Pitch Hacker Newsletter (curated weekly digest) with PH traction numbers
- **Thu May 15:** Pitch TLDR newsletter again with PH numbers if first pitch didn't land
- **Fri May 16:** Write up PH retrospective for the blog. Capture all feedback in a spreadsheet. Prioritize feature requests.

---

## WEEK 7: May 19-23, 2026 -- Fleet & Team Use Cases

### Theme: "Beyond single node"

### LinkedIn Posts

**L16 - Tuesday May 19: "From Homelab to Production: Scaling Local Inference Monitoring"**
The journey from 1 node to 25 nodes. What changes: you need fleet-wide VRAM capacity, load balancing (Best Route API), cross-node pattern detection (Fleet Load Imbalance), and team visibility. Walk through the Team tier features.

**L17 - Thursday May 21: "The Best Route API: Routing Inference to the Right Node"**
Technical post about the Best Route API. It considers: current load, available VRAM, thermal state, recent TTFT. Not just round-robin. Not just least-connections. Inference-aware routing. Show the API response format.

### X/Twitter Posts

**X32 - Mon May 19:**
Running local inference on 1 machine: hobby.
Running it on 5: homelab.
Running it on 25: production.

At 25 nodes, you need:
- Fleet-wide VRAM visibility
- Load-balanced routing
- Cross-node anomaly detection
- Team dashboards
- PagerDuty alerts

Wicklee Team: $19/seat/mo. wicklee.dev

**X33 - Tue May 20:**
The Best Route API in action:

GET /api/v1/route/best

Returns the node with:
- Lowest current load
- Most available VRAM
- Best thermal headroom
- Lowest recent TTFT

Point your load balancer at this endpoint.
Let Wicklee pick the node.

**X34 - Wed May 21:**
Pattern E: Fleet Load Imbalance

Node 1: 95% GPU utilization
Node 2: 12% GPU utilization
Node 3: 88% GPU utilization

Your fleet is imbalanced. Requests aren't distributed. Node 2 is idle while Node 1 is saturated.

Wicklee detects this automatically across your fleet.

**X35 - Thu May 22:**
Wicklee Cloud MCP Server:

Your AI agent can query your fleet status in natural language.

"Which node has the most free VRAM?"
"Is any node thermally throttled?"
"What's the fleet-wide average WES?"

6 tools. Clerk JWT auth. Team+ tier.

wicklee.dev/mcp

**X36 - Fri May 23:**
Alert channels in Wicklee Team:

- PagerDuty (severity-mapped)
- Email
- Webhook

Fires on:
- Zombie engine (inference stopped, VRAM still allocated)
- Thermal redline
- OOM warning
- WES cliff (sudden efficiency drop)

$19/seat/mo. 25 nodes. Real fleet monitoring.

### Marketing Activities

- **Mon May 19:** Create a case study template. Reach out to 3-5 beta teams for case study conversations.
- **Wed May 21:** Post to r/vllm: "How we monitor vLLM queue saturation and KV cache across a fleet" (technical, vLLM-specific)
- **Thu May 22:** Begin outreach to MLOps consultants and freelancers. They're a channel: "recommend Wicklee to clients, get partner commission."
- **Fri May 23:** Pitch Practical AI podcast with fleet management angle

---

## WEEK 8: May 26-30, 2026 -- Enterprise Positioning

### Theme: "Infrastructure grade"

### LinkedIn Posts

**L18 - Tuesday May 26: "What Enterprise AI Teams Need from Inference Monitoring"**
Personas: ML Platform Engineer, DevOps Lead, CISO. Each cares about different things. Platform Engineer: WES trending, model comparison. DevOps: alerts, fleet health, capacity planning. CISO: data sovereignty, audit trail. Map Wicklee features to each persona.

**L19 - Thursday May 28: "PagerDuty Integration: Because 3am GPU Alerts Shouldn't Be Surprises"**
Walk through the alerting pipeline: 5 fleet alerts, severity mapping (zombie engine and OOM = critical, WES cliff = error), dedup keys, auto-resolve when node recovers. Show the PagerDuty UI with a Wicklee alert.

### X/Twitter Posts

**X37 - Mon May 26:**
Enterprise inference monitoring checklist:

[x] Data sovereignty (content never leaves node)
[x] Multi-node fleet aggregation
[x] PagerDuty / webhook alerts
[x] RBAC via Clerk Organizations
[x] SSE real-time stream
[x] REST + MCP APIs
[x] 90-day metric history
[ ] SAML SSO (Q3)
[ ] SOC 2 (Q4)

wicklee.dev/enterprise

**X38 - Tue May 27:**
5 fleet alerts in Wicklee:

1. zombied_engine -- inference stopped, VRAM held hostage
2. thermal_redline -- sustained critical thermal state
3. oom_warning -- 2 consecutive ticks at 95%+ memory pressure
4. wes_cliff -- efficiency dropped off a cliff
5. agent_version_mismatch -- fleet running different versions

All auto-resolve when the condition clears.

**X39 - Wed May 28:**
"We can't send our inference telemetry to Datadog."

Heard this from 3 different enterprise teams this month.

Compliance requirements mean GPU metrics can't leave the network. But they still need monitoring.

Wicklee's agent-only mode: full dashboard at localhost:7700. Zero cloud. Zero egress.

**X40 - Thu May 29:**
Wicklee + PagerDuty alert lifecycle:

1. vLLM KV cache hits 94% (Pattern M fires)
2. Observation created in fleet_observations table
3. Alert evaluated: severity = warning
4. PagerDuty Events API v2: trigger with dedup key
5. KV cache drops to 80% (Pattern M resolves)
6. PagerDuty: resolve with same dedup key

Fully automated. Zero manual triage.

**X41 - Fri May 30:**
Clerk Organizations + Wicklee:

1 team. 5 seats. 25 nodes.
Shared fleet dashboard.
Org-scoped alerts.
Tier inherited from org admin.

No per-user node limits wrestling.
No permission matrix headaches.

$19/seat/mo x 5 = $95/mo for full fleet visibility.

### Marketing Activities

- **Tue May 27:** Begin outbound to ML Platform teams at mid-market companies. Target: companies with 5-50 GPU nodes running local inference. LinkedIn outreach to ML Platform Engineer / MLOps titles.
- **Wed May 28:** Create an "Enterprise One-Pager" PDF: sovereign design, compliance angles, integration points, pricing.
- **Thu May 29:** Attend (virtually or in-person) local AI/ML meetup. Give a 5-minute lightning talk on tok/W.
- **Fri May 30:** Submit to G2 and similar review platforms for discovery.

---

## WEEK 9: June 2-6, 2026 -- Technical Content Blitz

### Theme: "Deep engineering"

### LinkedIn Posts

**L20 - Tuesday Jun 2: "How We Detect PCIe Lane Degradation in Real Time"**
Pattern L deep dive. Reading link width vs max width from sysfs/IOKit. Why x16 to x8 halves your memory bandwidth and tanks throughput for large context windows. The kind of post that gets saved by hardware engineers.

**L21 - Thursday Jun 4: "Building a Transparent Ollama Proxy in Rust"**
Technical post about the proxy architecture. Intercepts :11434, forwards to configurable backend port. Parses "done" packets for exact tok/s, TTFT, latency -- no synthetic probing needed. How we handle streaming responses without adding latency.

**L22 - Saturday Jun 6: "DuckDB as a Local Metrics Store: Lessons from Embedding an Analytics DB in a System Daemon"**
Rust + DuckDB integration. Why DuckDB over SQLite for time-series analytics. The 10-minute observation window. WAL flush on graceful shutdown. Why musl builds don't get DuckDB (no dynamic linking).

### X/Twitter Posts

**X42 - Mon Jun 2:**
The Wicklee proxy intercepts Ollama at :11434.

It reads "done" packets to extract:
- Exact tok/s (not estimated)
- Real TTFT (not probe-based)
- E2E latency per request

Zero overhead. Transparent to clients.
Your existing Ollama calls just work.

**X43 - Tue Jun 3:**
Your GPU has a PCIe link width.
It should be x16.
Sometimes it degrades to x8.

When this happens: memory bandwidth halves. Large context window throughput tanks.

Wicklee Pattern L detects this instantly. Most people never check.

**X44 - Wed Jun 4:**
Wicklee's binary size: ~15MB
Dependencies required: 0

No Python runtime.
No Node.js.
No Docker.
No Java.

One Rust binary. Static linking. Cross-compiled for 5 platforms.

That's what "zero dependencies" actually means.

**X45 - Thu Jun 5:**
powermetrics sampling window: 5000ms

We tried 1000ms. Missed inter-token idle periods.
We tried 2000ms. Still noisy.
5000ms captures the full inference cycle.

Every threshold in Wicklee was calibrated against real hardware.
Not guessed. Measured.

**X46 - Fri Jun 6:**
Wicklee tech stack:

Agent: Rust (Tokio + Axum)
Frontend: React 19 + Vite + Tailwind + Recharts
Local storage: DuckDB
Cloud: Rust (Axum) + Postgres + TimescaleDB
Auth: Clerk
Payments: Paddle
Alerts: PagerDuty
Deploy: Railway

Entire backend is Rust. Frontend is embedded in the binary via RustEmbed.

### Marketing Activities

- **Mon Jun 2:** Publish technical blog: "Building a Hardware Monitor in Rust: Architecture Decisions" (target r/rust, Rust Weekly)
- **Wed Jun 4:** Cross-post proxy architecture to r/LocalLLaMA and r/ollama (people want to understand the proxy)
- **Fri Jun 6:** Compile first "Inference Hardware Report" -- aggregate anonymized data from fleet users showing avg tok/W by chip, most common thermal issues, peak usage patterns. This becomes a recurring quarterly report.

---

## WEEK 10: June 9-13, 2026 -- Community & Partnerships

### Theme: "Growing the ecosystem"

### LinkedIn Posts

**L23 - Tuesday Jun 9: "The State of Local AI Inference: Data from 1,000+ Nodes"**
If you have enough installs by now, publish aggregate data. Average tok/W by chip family. Most common observation patterns. Peak inference hours. Model size distribution. This is the "industry report" play -- positions Wicklee as the authority.

**L24 - Thursday Jun 11: "Why We Open-Sourced the Agent and Keep the Fleet Cloud Commercial"**
Open core business model post. Agent is the trust layer (runs as root, reads hardware). It should be inspectable. Fleet aggregation, history, alerts, teams -- that's the commercial value. Explain the FSL-1.1-Apache-2.0 license and the 4-year conversion.

### X/Twitter Posts

**X47 - Mon Jun 9:**
Most common Wicklee observation patterns firing across our fleet:

1. Phantom Load (B) -- 68% of nodes
2. Thermal Drain (A) -- 41% of nodes
3. VRAM Overcommit (O) -- 23% of nodes

Your loaded model is probably wasting power right now.

[adjust numbers to real data]

**X48 - Tue Jun 10:**
Wicklee now integrates with:

- PagerDuty (alerts)
- Any webhook endpoint
- MCP protocol (AI agent access)
- REST API (programmatic access)
- SSE streams (real-time)

What integration should we build next?

**X49 - Wed Jun 11:**
Pricing transparency:

Community: Free, 3 nodes, 9 patterns
Pro: $9/mo, 10 nodes, 18 patterns
Team: $19/seat, 25 nodes, PagerDuty, MCP
Enterprise: From $200/mo, unlimited, proxy

No per-metric pricing.
No per-query pricing.
No surprise overages.

wicklee.dev/pricing

**X50 - Thu Jun 12:**
If you write Ollama tutorials, vLLM guides, or local AI content:

We'd love to partner. Free Pro account + featured in our docs.

DM me or email hello@wicklee.dev

Specifically looking for:
- YouTube creators doing hardware reviews
- Blog authors covering local AI setup
- Newsletter writers in the ML/AI space

**X51 - Fri Jun 13:**
Week 10 transparency report:

GitHub stars: [X]
Total installs: [X]
Pro subscribers: [X]
Team accounts: [X]
MRR: $[X]

Building in public. wicklee.dev

### Marketing Activities

- **Mon Jun 9:** Launch partner program. Offer: free Pro for content creators who review Wicklee. Free Team for consultants who recommend it to clients.
- **Wed Jun 11:** Sponsor a local AI/ML meetup ($200-500). Get a 5-minute demo slot.
- **Thu Jun 12:** Begin weekly "build in public" Twitter thread. Share metrics, decisions, learnings. Builds trust and followership.
- **Fri Jun 13:** Start outbound email campaign to ML Platform Engineer leads at companies with known local inference deployments (check job postings mentioning Ollama, vLLM, on-prem inference).

---

## WEEK 11: June 16-20, 2026 -- Comparison & Conversion

### Theme: "Why Wicklee vs alternatives"

### LinkedIn Posts

**L25 - Tuesday Jun 16: "Wicklee vs Prometheus+Grafana for GPU Monitoring: An Honest Comparison"**
Fair comparison. Prometheus+Grafana: flexible, battle-tested, free. Wicklee: inference-aware, zero-config, 30 seconds. When to use which. Be honest about where P+G wins (custom dashboards, ecosystem). Win on: time to value, inference-specific patterns, Apple Silicon support, sovereign design.

**L26 - Thursday Jun 18: "3 Months of Building Wicklee: Revenue, Learnings, and What's Next"**
Quarterly retrospective. Share real numbers (MRR, installs, conversions). What content worked. What didn't. What features drove upgrades. Roadmap preview. Authentic founder content.

### X/Twitter Posts

**X52 - Mon Jun 16:**
Wicklee vs the alternatives:

nvidia-smi: NVIDIA only, no inference awareness
htop: CPU focus, no GPU power
Activity Monitor: no SoC power breakdown
Prometheus+Grafana: 4hrs setup per node
nvtop: real-time only, no history

Wicklee: 30s install, all platforms, inference-aware, 18 patterns

**X53 - Tue Jun 17:**
Top 3 reasons people upgrade from Community to Pro:

1. More than 3 nodes (10 with Pro)
2. 18 patterns instead of 9 (P/Q/R catch latency issues)
3. 7-day history (Community is 24h)

$9/mo. Less than a coffee subscription.

wicklee.dev/pricing

**X54 - Wed Jun 18:**
Free -> Pro conversion trigger:

User installs Wicklee on nodes 1, 2, 3.
Hits the 3-node Community limit.
Gets node 4.

That's the moment.

We don't nag. We don't degrade.
3 nodes just work, forever.
Node 4 needs Pro. $9/mo.

**X55 - Thu Jun 19:**
3-month milestone:

[X] total installs
[X] GitHub stars
[X] Pro subscribers
[X] Team accounts
$[X] MRR

Top feature requests:
1. [Feature]
2. [Feature]
3. [Feature]

All shipping in Q3. wicklee.dev

**X56 - Fri Jun 20:**
The hardest part of building Wicklee wasn't the code.

It was calibrating 18 hardware patterns against real silicon.

Every threshold is from real-world measurement:
- GPU saturated override: 75% (measured on M2)
- Probe GPU residency: never exceeds 60%
- powermetrics window: 5000ms
- Tier 2 attribution: 15s

No guessing. Only measuring.

### Marketing Activities

- **Mon Jun 16:** Publish comparison blog post (Wicklee vs Prometheus+Grafana). SEO target: "gpu monitoring tool comparison"
- **Wed Jun 18:** Quarterly newsletter to all subscribers: product update, usage stats, roadmap
- **Thu Jun 19:** Prepare for Q3: plan summer content calendar, schedule conference talk submissions (KubeCon, MLOps World, local meetups)
- **Fri Jun 20:** A/B test pricing page CTA copy based on 3 months of data

---

## WEEK 12: June 23-27, 2026 -- Scale & Systematize

### Theme: "Repeatable growth engine"

### LinkedIn Posts

**L27 - Tuesday Jun 23: "The Content Flywheel for Developer Tools"**
Meta post about what's working. Technical content on LinkedIn > marketing content. Twitter for reach, LinkedIn for depth, Reddit for community. Share the framework other developer tool founders can use.

**L28 - Thursday Jun 25: "Q3 Roadmap: What's Coming to Wicklee"**
Roadmap post. Tease the next quarter's features. SAML SSO, expanded integrations, llama.cpp native harvester, MIG support, SOC 2 timeline. Get people excited about what's next.

### X/Twitter Posts

**X57 - Mon Jun 23:**
12 weeks of building Wicklee in public:

Week 1: 0 -> [X] installs
Week 4: First paying customer
Week 6: Product Hunt #[X]
Week 8: First Enterprise deal
Week 12: $[X] MRR

The playbook: build something real, show the engineering, be helpful in communities, never stop shipping.

**X58 - Tue Jun 24:**
Q3 roadmap preview:

- SAML SSO (Enterprise)
- llama.cpp native metrics harvester
- Slack alert channel
- Custom dashboard layouts
- Historical tok/W trending
- MIG GPU slice monitoring

What should we prioritize? Reply with your vote.

**X59 - Wed Jun 25:**
The Wicklee install base by hardware:

Apple Silicon: [X]%
NVIDIA consumer (RTX): [X]%
NVIDIA datacenter (A100/H100): [X]%
Intel/AMD (CPU-only): [X]%

Local AI runs on surprisingly diverse hardware.

[adjust to real data]

**X60 - Thu Jun 26:**
Year-end goal: $500K ARR

Current MRR: $[X]
Required MRR: $41,500

Gap: $[X]

The plan:
- Pro: volume from community conversion
- Team: outbound to ML platform teams
- Enterprise: 3-5 large deals per quarter

We'll get there. wicklee.dev

**X61 - Fri Jun 27:**
Thank you to everyone who's followed, installed, and given feedback over the last 12 weeks.

[X] GitHub stars
[X] installs
[X] paid accounts
$[X] MRR

This is just the beginning.

If you run local AI inference and don't have monitoring yet:
curl -fsSL https://wicklee.dev/install.sh | bash

### Marketing Activities

- **Mon Jun 23:** Set up automated drip email sequence for new installs (Day 0: welcome + docs, Day 3: "Did you know about observations?", Day 7: "Your first week in metrics", Day 14: "Ready for more nodes?" Pro upgrade prompt)
- **Tue Jun 24:** Systematize content: create templates for weekly X threads, monthly LinkedIn deep dives, quarterly reports. Document the process so it's repeatable.
- **Wed Jun 25:** Plan Q3 conference strategy. Submit CFPs to: KubeCon NA, MLOps World, AI Engineer Summit, local meetups.
- **Thu Jun 26:** Review all metrics. Identify top conversion channels. Double down on what's working. Cut what isn't.
- **Fri Jun 27:** Plan Q3 content calendar using same framework. Identify 12 new technical topics for LinkedIn deep dives.

---

## Ongoing / Recurring Activities (Every Week)

### Daily
- Monitor and respond to GitHub issues within 4 hours
- Check Twitter/X mentions and engage
- Check Reddit mentions in target subreddits

### Twice Weekly
- Engage in r/LocalLLaMA threads (comment helpfully, add tok/W data when relevant)
- Engage in Twitter/X threads about Ollama, vLLM, local AI

### Weekly
- Publish at least 2 LinkedIn posts and 5 X posts (as calendared above)
- Review install and conversion metrics
- Update the "build in public" log

### Monthly
- Newsletter to subscribers (product update + technical insight)
- Review and update SEO content
- Reach out to 5 new potential partners/reviewers
- Update comparison pages with new competitor features

### Quarterly
- Publish "State of Local AI Inference" report with aggregate data
- Review pricing and packaging based on conversion data
- Plan next quarter's content calendar
- Submit conference CFPs

---

## Measurement & Attribution

### Key Metrics to Track Weekly
- **Install.sh downloads** (total + by platform)
- **GitHub stars** (growth rate)
- **Community -> Pro conversion rate** (target: 5-8%)
- **Pro -> Team upgrade rate** (target: 10-15%)
- **Content engagement** (LinkedIn impressions, X impressions, Reddit upvotes)
- **Organic search traffic** to wicklee.dev (by keyword)
- **MRR and subscriber count** (by tier)

### Attribution Setup
- UTM parameters on all links from social (utm_source=linkedin, utm_source=twitter, etc.)
- Unique install.sh referral codes for major content pieces
- Track which Reddit/HN posts drive the most installs (time-correlation analysis)
- Ask "How did you hear about Wicklee?" during Pro onboarding

---

## Budget Estimate (12 weeks)

| Item | Cost |
|------|------|
| Content creation tools (Canva Pro, screen recording) | $30/mo = $90 |
| Twitter/X Premium (analytics, reach) | $8/mo = $24 |
| Product Hunt launch support (no paid, organic only) | $0 |
| Newsletter platform (Buttondown) | $0-29/mo |
| Meetup sponsorships (2x) | $500-1,000 |
| Podcast guest prep / equipment | $200 |
| SEO tools (Ahrefs Lite or similar) | $99/mo = $300 |
| Total 12-week budget | ~$1,500-2,000 |

This is a bootstrapped, content-led GTM. The primary investment is founder time (estimated 8-10 hours/week on marketing activities).

---

## Phased Revenue Strategy (12-18 Month Horizon)

### Phase 1: Days 1-60 — Get to $10K-$20K MRR (Launch + Early Traction)

**Week 1 actions (do immediately):**
- [ ] Launch Reddit (r/LocalLLaMA), HN (Show HN), X thread simultaneously
- [ ] Deploy HuggingFace Space (`wicklee/monitor-your-local-hf-models`)
- [ ] Publish HuggingFace Cookbook ("Monitor Your Local HF Models with Full Hardware Sovereignty")
- [ ] Update pricing page: emphasize Pro hero, add "Local MCP + Optional Proxy + Slack Alerts" under Pro, "Cloud MCP + OTel + PagerDuty + Shared Dashboards" under Team

**Key growth levers:**
- HuggingFace flywheel (Cookbook + Space → drives Community installs → Pro conversions)
- Reddit engagement in r/LocalLLaMA, r/ollama, r/selfhosted (2-3 comments/day, genuine help)
- Install-to-Pro conversion funnel: free dashboard → hit 4-node wall → upgrade prompt

### Phase 2: Months 2-6 — Get to $50K-$80K MRR (Product-Led Growth)

**Land-and-expand:**
- In-product upgrade prompts when user enables proxy or hits 4+ nodes
- "WES Leaderboard" public page (anonymous) to drive virality
- "Share your WES score" campaign on X/Reddit
- Referral program: Pro users get 1 month free for every friend who upgrades

**Content flywheel:**
- MCP templates — ready-to-use Claude/Cursor configs and examples
- Case studies from 10-20 power users (WES savings, thermal wins → testimonials)
- Blog series: "tok/W benchmarks" for every Apple Silicon chip, every NVIDIA card

### Phase 3: Months 6-12 — Push to $150K-$200K MRR (Enterprise Bridge)

**Partnerships:**
- Apply to Datadog Partner Network (Technology Partner) — OTel is live
- Apply to New Relic partnership
- Create one-click "Export to Datadog" and "Export to New Relic" buttons in Team settings
- Target: AI startups, research labs, fintech with compliance needs

**Team tier expansion:**
- Consider raising Team price to $22-25/seat once traction justifies
- Add usage-based enterprise features (dedicated support, SLA, SSO)

### Phase 4: Months 12-18 — $500K ARR

- Expand runtime support (more runtimes, more hardware)
- Small enterprise sales motion (founder or part-time SDR)
- Geographic expansion (EU compliance angle for sovereign monitoring)

---

## Launch Assets (Ready to Deploy)

### Hugging Face Cookbook

**Title:** Monitor Your Local Hugging Face Models with Full Hardware Sovereignty

**Content outline:**
1. Why Wicklee + HuggingFace (efficiency visibility for HF models)
2. Quick Start (`curl | sh`, open localhost:7700)
3. Step-by-step: Run HF model with Ollama/vLLM + Wicklee monitoring
4. Local MCP integration (Claude Desktop / Cursor prompts)
5. Optional proxy for production metrics
6. OTel export for enterprise tools (Team tier)
7. Link to live demo Space

### Hugging Face Space

**Name:** `wicklee/monitor-your-local-hf-models`
**Type:** Gradio app with 3 tabs:
1. Live Dashboard (fetches from localhost:7700 if running, otherwise shows demo data)
2. Local MCP Demo (simulated chat showing MCP queries)
3. Install tab (curl command)

### Reddit Launch Post (r/LocalLLaMA)

**Title:** I built Wicklee — sovereign local inference monitoring with WES, 18 patterns, Local MCP for everyone, and OTel bridge

**Key points:** WES efficiency scores, 18 sovereign patterns, non-proxy by default, optional proxy for production metrics, Local MCP free for all, Slack/PagerDuty alerts, OTel+Prometheus for Datadog/New Relic, shared team dashboards.

### Show HN Post

**Title:** Show HN: Wicklee — Sovereign GPU fleet monitor for local AI inference (Rust)

**Key technical details to lead with:** Single Rust binary (~8MB), RustEmbed dashboard, 3-tier inference state machine, 7 thermal detection paths, DuckDB local + Postgres fleet, 2KB telemetry every 2s, WES formula, 18 observation patterns.

### X/Twitter Launch Thread (3 tweets)

**Tweet 1:** Feature overview (WES, 18 patterns, Local MCP, OTel, Prometheus)
**Tweet 2:** Privacy architecture (non-proxy default, optional proxy for production metrics, MCP free for all)
**Tweet 3:** Call to action (install link, GitHub, "what's your biggest monitoring pain point?")

---

## Weekly Metrics to Track

| Metric | Track Weekly | Tool |
|--------|-------------|------|
| New Community activations | install.sh downloads | Server logs / analytics |
| Pro conversions | Paddle dashboard | Paddle |
| Pro → Team upgrades | Paddle dashboard | Paddle |
| GitHub stars | GitHub | GitHub API |
| HF Space views | HuggingFace | HF dashboard |
| Churn rate | Keep under 5% | Paddle |
| X impressions | Twitter analytics | X Premium |
| LinkedIn engagement | LinkedIn analytics | LinkedIn |
| Newsletter subscribers | Buttondown | Buttondown |

---

## Top 5 Immediate Actions (In Order)

1. **Launch this week** — Reddit + HN + X thread + HF Space + HF Cookbook (all same day or within 48 hours)
2. **Deploy HuggingFace Space** — highest ROI for Community → Pro conversions from ML community
3. **Add in-product upgrade CTAs** — when proxy is enabled or node count > 3, show upgrade prompt
4. **Set up weekly metrics tracking** — install counter, star tracking, subscriber count, MRR
5. **Start the LinkedIn cadence** — 2 posts/week, technical thought leadership, not marketing
