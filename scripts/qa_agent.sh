#!/usr/bin/env bash
# qa_agent.sh — smoke-tests the Wicklee agent API at localhost:7700
# Usage: bash scripts/qa_agent.sh
# Requires: curl, jq

set -uo pipefail

BASE="http://localhost:7700"
PASS=0; FAIL=0; WARN=0

green() { printf '\033[32m'; }
red()   { printf '\033[31m'; }
amber() { printf '\033[33m'; }
reset() { printf '\033[0m'; }

ok()   { green; echo "  OK    $1 = $2"; reset; ((PASS++)) || true; }
fail() { red;   echo "  FAIL  $1 — $2"; reset; ((FAIL++)) || true; }
warn() { amber; echo "  WARN  $1 — $2"; reset; ((WARN++)) || true; }

section() { echo; echo "── $1 ──────────────────────────────────"; }

# ── Fetch metrics SSE (one frame) ────────────────────────────────────────────
METRICS=$(curl -s --max-time 5 "$BASE/api/metrics" | head -1 | sed 's/^data: //')
if [ -z "$METRICS" ] || [ "$METRICS" = "" ]; then
  red; echo "FATAL: /api/metrics returned no data — is the agent running?"; reset
  exit 1
fi

jqv() { echo "$METRICS" | jq -r "$1 // \"null\""; }

# ── Core hardware ─────────────────────────────────────────────────────────────
section "Core hardware"

mp=$(jqv '.memory_pressure_percent')
if [ "$mp" = "null" ]; then
  fail "memory_pressure_percent" "null — vm_stat parse may have failed"
elif (( $(echo "$mp > 100 || $mp < 0" | bc -l) )); then
  fail "memory_pressure_percent" "out of range: $mp"
else
  ok "memory_pressure_percent" "${mp}%"
fi

swap=$(jqv '.swap_write_mb_s')
[ "$swap" = "null" ] && fail "swap_write_mb_s" "null" || ok "swap_write_mb_s" "${swap} MB/s"

thermal=$(jqv '.thermal_state')
[ "$thermal" = "null" ] && fail "thermal_state" "null" || ok "thermal_state" "$thermal"

inf=$(jqv '.inference_state')
[ "$inf" = "null" ] && fail "inference_state" "null" || ok "inference_state" "$inf"

wes=$(jqv '.wes_score')
if [ "$wes" = "null" ]; then
  warn "wes_score" "null (normal if no inference has run yet)"
else
  ok "wes_score" "$wes"
fi

# ── Apple Silicon specific ────────────────────────────────────────────────────
chip=$(jqv '.gpu_name // .chip_name // "n/a"')
if echo "$METRICS" | jq -e '.gpu_name or .soc_power_w' > /dev/null 2>&1; then
  section "Apple Silicon"
  soc=$(jqv '.apple_soc_power_w')
  [ "$soc" = "null" ] && fail "apple_soc_power_w" "null" || ok "apple_soc_power_w" "${soc}W"
  gpu_util=$(jqv '.gpu_utilization_percent')
  [ "$gpu_util" = "null" ] && warn "gpu_utilization_percent" "null (normal when idle)" || ok "gpu_utilization_percent" "${gpu_util}%"
fi

# ── NVIDIA specific ───────────────────────────────────────────────────────────
if echo "$METRICS" | jq -e '.nvidia_gpu_utilization_percent != null' > /dev/null 2>&1; then
  section "NVIDIA"
  ok "nvidia_gpu_utilization_percent" "$(jqv '.nvidia_gpu_utilization_percent')%"
  ok "nvidia_power_draw_w"            "$(jqv '.nvidia_power_draw_w')W"
  ok "nvidia_vram_used_mb"            "$(jqv '.nvidia_vram_used_mb') MB"
  ok "nvidia_vram_total_mb"           "$(jqv '.nvidia_vram_total_mb') MB"
fi

# ── Ollama ───────────────────────────────────────────────────────────────────
section "Ollama"
ollama=$(jqv '.ollama_running')
if [ "$ollama" = "true" ]; then
  ok "ollama_running" "true"
  ok "ollama_active_model" "$(jqv '.ollama_active_model // "none"')"
  tps=$(jqv '.ollama_tokens_per_second')
  [ "$tps" = "null" ] && warn "ollama_tokens_per_second" "null (normal — no probe completed yet)" || ok "ollama_tokens_per_second" "${tps} tok/s"
else
  warn "ollama_running" "false — skipping Ollama fields"
fi

# ── Observations ─────────────────────────────────────────────────────────────
section "Observations"
OBS=$(curl -s --max-time 5 "$BASE/api/observations")
if [ -z "$OBS" ]; then
  fail "GET /api/observations" "no response"
else
  count=$(echo "$OBS" | jq 'length // 0')
  ok "GET /api/observations" "$count observation(s) returned"
fi

# ── Model candidates ─────────────────────────────────────────────────────────
section "Model discovery"
CANDS=$(curl -s --max-time 20 "${BASE}/api/model-candidates" --data-urlencode "limit=3" -G)
if [ -z "$CANDS" ] || ! echo "$CANDS" | jq -e '.models' > /dev/null 2>&1; then
  warn "GET /api/model-candidates" "no JSON response — HF may be slow or agent version too old"
else
  mcount=$(echo "$CANDS" | jq '.models | length // 0')
  hw_vram=$(echo "$CANDS" | jq -r '.hardware.vram_mb // "null"')
  [ "$mcount" = "0" ] && warn "model-candidates" "0 models — HF unreachable or cache empty" || ok "model-candidates" "$mcount models, vram_mb=$hw_vram"
fi

# ── MCP ──────────────────────────────────────────────────────────────────────
section "MCP"
MCP=$(curl -s --max-time 5 -X POST "$BASE/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_node_status"},"id":1}')
if [ -z "$MCP" ]; then
  fail "POST /mcp get_node_status" "no response"
else
  mcp_err=$(echo "$MCP" | jq -r '.error // "none"')
  [ "$mcp_err" != "none" ] && fail "POST /mcp get_node_status" "$mcp_err" || ok "POST /mcp get_node_status" "ok"
fi

MCP2=$(curl -s --max-time 5 -X POST "$BASE/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_model_fit"},"id":2}')
mcp2_err=$(echo "$MCP2" | jq -r '.error // "none"')
[ "$mcp2_err" != "none" ] && warn "POST /mcp get_model_fit" "$mcp2_err (normal if no model loaded)" || ok "POST /mcp get_model_fit" "ok"

# ── History ──────────────────────────────────────────────────────────────────
section "History"
HIST=$(curl -s --max-time 5 "${BASE}/api/history" --data-urlencode "range=1h" -G)
if [ -z "$HIST" ]; then
  fail "GET /api/history" "no response"
else
  hcount=$(echo "$HIST" | jq '.data | length // 0')
  ok "GET /api/history?range=1h" "$hcount data points"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────"
total=$((PASS + FAIL + WARN))
[ $FAIL -gt 0 ] && red || green
echo "  $PASS passed · $FAIL failed · $WARN warnings  ($total checks)"
reset
echo

[ $FAIL -gt 0 ] && exit 1 || exit 0
