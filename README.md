
# Wicklee Control Plane

Wicklee is a high-performance, distributed control plane designed for orchestrating local AI inference fleets. It provides a unified interface for managing clusters of local engines like Ollama and vLLM, ensuring optimal hardware utilization through thermal-aware load balancing.

## Core Pillars

- **Fleet Orchestration**: Scalable reverse-proxy architecture built for low-latency inference routing across heterogeneous local hardware.
- **Analytical Observability**: Native integration with **DuckDB** for high-resolution telemetry, request tracing, and performance benchmarking (TTFT/TPOT).
- **WASM Interceptors**: Secure, high-speed request/response modification using a **Wasmtime** runtime for PII redaction and prompt safety.
- **Thermal Intelligence**: Real-time monitoring of GPU temperatures, power draw, and VRAM pressure to prevent hardware throttling and ensure fleet longevity.

## Tech Stack

- **Frontend**: React 19, Tailwind CSS, Lucide Icons, Recharts.
- **Backend (Agent)**: Rust, Axum, Sysinfo, NVML.
- **Data Engine**: DuckDB (Embedded).
- **Security**: WebAssembly (WASM-edge) interceptors.

## Getting Started

1. Deploy the Wicklee Rust Agent on your local worker nodes.
2. Connect the Control Plane via the dashboard.
3. Configure your tenant ID and start routing inference requests.

---
*Wicklee is an Open Source project dedicated to high-performance local AI infrastructure.*
