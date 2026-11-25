// node --test scripts/bench/lib/scenarios.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateScenarios } from "./scenarios.mjs";

const good = () => ({
  host: { label: "rented box", platform: "linux" },
  ollama_base_url: "http://127.0.0.1:11999",
  agent_base_url: "http://127.0.0.1:7999",
  models: { small: { name: "a:1b", resident_gb: 1.2 } },
});

test("a filled-in file for this platform is usable", () => {
  assert.deepEqual(validateScenarios(good(), { platform: "linux" }), []);
});

test("the unfilled template is refused", async () => {
  const ex = JSON.parse(await readFile(new URL("../scenarios.example.json", import.meta.url), "utf8"));
  const p = validateScenarios(ex, { platform: "linux" });
  assert.ok(p.some((m) => m.includes("template")), p.join("; "));
});

test("a file written for another platform is refused", () => {
  const cfg = good();
  cfg.host.platform = "darwin";
  const p = validateScenarios(cfg, { platform: "linux" });
  assert.ok(p.some((m) => m.includes("darwin")), p.join("; "));
});

test("the M4 file is usable on a Mac and refused elsewhere", async () => {
  const m4 = JSON.parse(await readFile(new URL("../scenarios.m4.json", import.meta.url), "utf8"));
  assert.deepEqual(validateScenarios(m4, { platform: "darwin" }), []);
  assert.ok(validateScenarios(m4, { platform: "linux" }).length > 0);
});

test("placeholders and missing keys are named", () => {
  const cfg = good();
  cfg.models.small.name = "FILL-ME-IN";
  delete cfg.agent_base_url;
  const p = validateScenarios(cfg, { platform: "linux" }).join("; ");
  assert.match(p, /placeholder/);
  assert.match(p, /agent_base_url/);
});
