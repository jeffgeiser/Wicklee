# Wicklee Project Guide for Claude

You are acting as a Senior Principal Engineer working on **Wicklee**, a high-performance control plane for local AI orchestration. This document outlines the technical constraints, design language, and patterns required for this project.

## 🚀 Tech Stack
- **Frontend**: React 19 (Functional Components, Hooks).
- **Styling**: Tailwind CSS (Utility-first, dark mode focus).
- **Icons**: Lucide React.
- **Charts**: Recharts (Customized for dark-mode telemetry).
- **AI**: Local Ollama REST API (`/api/generate`, `/api/tags`) — no cloud dependency. Default model: `phi3:mini`.
- **Backend (Contextual)**: Rust (Axum) with DuckDB for analytical storage.
- **Communication**: WebSockets for real-time telemetry updates.

## 🎨 Design Language & UI/UX
Wicklee follows a "High-Tech Dark" aesthetic designed for systems engineers.

### Color Palette (Tailwind Tokens)
- **Background**: `gray-950` (#030712)
- **Primary Action**: `indigo-600` (#4f46e5) with `indigo-500/30` shadow glows.
- **Surface**: `gray-900` / `gray-800` for cards and borders.
- **Role Badges**:
  - **Owner**: `indigo-500/10` background, `indigo-500` text.
  - **Collaborator**: `blue-500/10` background, `blue-400` text.
  - **Viewer**: `gray-500/10` background, `gray-400` text.

### Typography
- **UI**: Inter (San Serif).
- **Telemetry/Logs**: JetBrains Mono.

## 🏗️ Architectural Patterns

### 1. Multi-Tenancy
- Every request and WebSocket connection must be scoped by `tenantId`.
- Use the `X-Tenant-ID` header for REST API calls.

### 2. Role-Based Access Control (RBAC)
- **Owner**: Full access including Team Management and Security.
- **Collaborator**: Access to Fleet Overview, Node Registry, and Scaffolding.
- **Viewer**: Read-only access to basic dashboards.
- *Implementation*: Use the `usePermissions` hook in `hooks/usePermissions.ts`.

### 3. Resilience & Mocking
- The dashboard operates in a "Mock-First" mode. If the local Rust agent at `localhost:7700` is unavailable, the UI must gracefully fall back to high-fidelity mock data and show a "Disconnected" warning with a link to the Scaffolding setup guide.

### 4. Fleet Intelligence Lab
- Uses local Ollama for analyzing node JSON telemetry — no data leaves the machine.
- Focus on: Thermal-aware load balancing suggestions and WASM interceptor recommendations.

## 🛠️ Coding Guidelines
- **Strict Typing**: All shared data structures must be defined in `types.ts`.
- **Minimal Renders**: Use `useRef` for WebSocket instances and event listeners.
- **Atomic Components**: Keep UI components (Cards, Tables, Modals) modular.
- **Tailwind JIT**: Avoid custom CSS files; rely exclusively on Tailwind utility classes in `index.html` and component props.

## 📂 Key Files Reference
- `App.tsx`: Central orchestrator, WebSocket lifecycle, and tab routing.
- `types.ts`: Source of truth for NodeAgent, TraceRecord, and User interfaces.
- `ScaffoldingView.tsx`: Technical reference for Rust backend implementations.
- `AIInsights.tsx`: Implementation of local Ollama-driven telemetry analysis.

## 🎯 Current Objectives
- Implementing WASM binary upload flows.
- Enhancing DuckDB-rs trace visualization.
- Strengthening mTLS secure fabric UI representations.
