# Reference controller — M4 Mac mini, 16 GB unified

- Agent 0.14.0, Ollama 0.40.16
- Workflow A holds **llama3.1:8b** (4.9 GB); workflow B may use **qwen3.5:9b** (6.6 GB) or **qwen3.5:4b** (3.4 GB)
- Accelerator budget 11.6 GB
- 5 runs per policy, randomised order

Medians with ranges. `loaded_check` is the baseline that matters: it is what a careful
integration does today without Wicklee.

| Policy | Chose | B step ms | A latency ms | A reloads | In-use displaced | Transitions | Deferrals |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `naive` | qwen3.5:9b ×5 | 6422 (6413–6761) | 4145 (4139–4189) | 5/5 | 5/5 | 1 (1–2) | 0 |
| `loaded_check` | qwen3.5:9b ×5 | 6625 (6418–6989) | 4155 (4146–4230) | 5/5 | 5/5 | 1 (1–4) | 0 |
| `wicklee` | qwen3.5:9b ×5 | 6500 (6420–6992) | 4151 (4138–4199) | 5/5 | 5/5 | 1 (1–4) | 0 |

**tie.** wicklee and loaded_check made the same choices (qwen3.5:9b). On this host readiness added nothing over a loaded-model check — a null result about the agent demonstration, which says nothing about the diagnostics.

Raw results: `/private/tmp/claude-501/-Users-roamwild-projects-wicklee/815e31f5-174d-481a-a333-151fd383a4c0/scratchpad/ctrl2.json`
