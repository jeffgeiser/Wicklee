# Wicklee Technical Specification: v0.1.0 (Community Edition)

## 1. Executive Summary
Wicklee is a "Sovereign-First" control plane for local GPU clusters. It replaces cloud-heavy monitoring with a lightweight Rust agent and a high-performance React dashboard.

## 2. Architecture
- **Control Plane (Frontend):** React 19, Vite 6, Tailwind CSS. Hosted on Railway.
- **Sentinel Agent (Edge):** Rust binary running on local nodes (Linux/Mac/Windows).
- **Communication:** Secure WebSockets (WSS) or local polling. 
- **Data Engine:** Local-first telemetry. Dashboards should assume the agent is at `localhost:3000` unless a remote tunnel is provided.

## 3. Core Features (v0.1.0)
- **Node Discovery:** Automatic detection of NVIDIA (NVML) and Apple Silicon (sysinfo) thermals/utilization.
- **Wattage-per-Token:** Real-time calculation of LLM efficiency.
- **The "Flying Blind" UI:** A high-fidelity dashboard that shows "Disconnected" states as an invitation to install the Sentinel Agent.

## 4. Technical Constraints
- **Zero Cloud Leak:** No telemetry should be sent to third-party AI providers (OpenAI/Google) unless explicitly configured by the user.
- **Performance:** Dashboard must handle 100+ telemetry updates per second using `useRef` and canvas-based charts if necessary.
- **Port Management:** Default agent port is 3000. Dashboard must allow override for custom tunnels.
