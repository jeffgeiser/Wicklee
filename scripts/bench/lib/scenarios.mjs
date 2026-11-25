// Shared scenario-file loader for the bench scripts.
//
// The scripts load and unload models and then report whether a rule fired or a
// prediction held. A scenario file that describes the wrong machine does not
// make them fail; it makes them induce the wrong condition and report a pass.
// So this refuses the ways that happens, rather than trusting whoever ran it:
//
//   - an unfilled template (the example file is marked `_template` and carries
//     placeholder model names),
//   - a file written for a different platform than the one running the script
//     (`host.platform`, compared with process.platform),
//   - a file missing the keys every script needs.

import { readFile } from "node:fs/promises";

export const DEFAULT_SCENARIOS_PATH = "scripts/bench/scenarios.json";

const PLACEHOLDER = /^FILL[-_ ]?ME/i;

/** Pure check. Returns a list of problems; empty means usable. */
export function validateScenarios(cfg, { platform = process.platform } = {}) {
  const problems = [];
  if (cfg === null || typeof cfg !== "object") return ["the file is not a JSON object"];

  if (cfg._template === true) {
    problems.push("this is the unfilled template (`_template` is true): copy it, fill it in for your hardware, and delete that key");
  }
  for (const key of ["ollama_base_url", "agent_base_url"]) {
    if (typeof cfg[key] !== "string" || !cfg[key]) problems.push(`missing ${key}`);
    else if (PLACEHOLDER.test(cfg[key])) problems.push(`${key} is still a placeholder`);
  }
  if (!cfg.host || typeof cfg.host.label !== "string" || !cfg.host.label) {
    problems.push("missing host.label, which names the machine in every transcript");
  } else if (PLACEHOLDER.test(cfg.host.label)) {
    problems.push("host.label is still a placeholder");
  }
  if (cfg.host?.platform && cfg.host.platform !== platform) {
    problems.push(
      `written for platform "${cfg.host.platform}" but this is "${platform}": ` +
        "its model sizes and contexts describe a different machine",
    );
  }
  if (!cfg.models || typeof cfg.models !== "object" || Object.keys(cfg.models).length === 0) {
    problems.push("missing models");
  } else {
    for (const [k, m] of Object.entries(cfg.models)) {
      if (!m || typeof m.name !== "string" || !m.name) problems.push(`models.${k}.name is missing`);
      else if (PLACEHOLDER.test(m.name)) problems.push(`models.${k}.name is still a placeholder`);
      if (typeof m?.resident_gb !== "number") problems.push(`models.${k}.resident_gb must be a number (read it off \`ollama ps\`)`);
    }
  }
  return problems;
}

/** Read, parse and validate. Prints what is wrong and exits 2 on any problem. */
export async function loadScenarios(path) {
  let cfg;
  try {
    cfg = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    console.error(`could not read ${path}: ${e.message}`);
    if (path === DEFAULT_SCENARIOS_PATH) {
      console.error("There is no default scenario file, on purpose: it has to describe your hardware.");
      console.error(`  cp scripts/bench/scenarios.example.json ${DEFAULT_SCENARIOS_PATH}   # then fill it in`);
      console.error("  (or pass --scenarios <file>; the M4 Mac mini's is scripts/bench/scenarios.m4.json)");
    }
    process.exit(2);
  }
  const problems = validateScenarios(cfg);
  if (problems.length) {
    console.error(`${path} cannot be used:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  return cfg;
}
