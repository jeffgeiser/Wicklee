# Reference controller — M4 Mac mini, 16 GB unified, 1b-class models

- Agent 0.16.0, Ollama 0.40.16
- Workflow A holds **qwen2.5:1.5b** (1.4 GB); workflow B may use **llama3.2:1b** (1.7 GB) or **gemma3:1b** (1 GB)
- Accelerator budget 12.9 GB
- 5 runs per policy, randomised order

Medians with ranges. `loaded_check` is the baseline that matters: it is what a careful
integration does today without Wicklee.

| Policy | Chose | B step ms | A latency ms | A reloads | In-use displaced | Transitions | Deferrals |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `naive` | llama3.2:1b ×5 | 674 (667–696) | 97 (96–98) | 0/5 | 0/5 | 0 (0–1) | 0 |
| `loaded_check` | llama3.2:1b ×5 | 674 (665–678) | 97 (95–98) | 0/5 | 0/5 | 0 (0–0) | 0 |
| `smallest_first` | gemma3:1b ×5 | 608 (572–880) | 96 (94–97) | 0/5 | 0/5 | 0 (0–0) | 0 |
| `wicklee` | gemma3:1b ×5 | 611 (589–1875) | 95 (93–103) | 0/5 | 0/5 | 0 (0–1) | 0 |

**vs loaded_check — differs.** wicklee chose gemma3:1b where loaded_check chose llama3.2:1b. Compare displaced_in_use and workflow_a_reloads to see whether the difference was worth it.

**vs smallest_first — tie.** wicklee and smallest_first made the same choices (gemma3:1b), and displaced a model in use 0/5 against 0/5. Sorting /api/tags by installed size reached the same decision without Wicklee, so on this host readiness changed nothing a one-line heuristic would not have. It says nothing about whether the answer was better founded.

Raw results: `docs/bench-controller-4policy-m4-1b-2026-11-28.json`
