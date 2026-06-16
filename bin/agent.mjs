#!/usr/bin/env node
// CLI: node bin/agent.mjs "<task>" <repoDir> [--baseline]
// Runs the proov harness (or the Claude-Code-style baseline with --baseline) on a real repo.

import { runAgent } from "../src/agent.mjs";
import { runBaseline } from "../src/baseline.mjs";

const args = process.argv.slice(2);
const useBaseline = args.includes("--baseline");
const positional = args.filter(a => !a.startsWith("--"));
const task = positional[0];
const repoDir = positional[1];

if (!task || !repoDir) {
  console.error('usage: node bin/agent.mjs "<task>" <repoDir> [--baseline]');
  console.error("env: MODEL (default google/gemini-2.5-flash), OPENROUTER_API_KEY");
  process.exit(2);
}

const run = useBaseline ? runBaseline : runAgent;
const label = useBaseline ? "baseline (Claude-Code-style)" : "proov (compact-edit)";
console.error(`[${label}] model=${process.env.MODEL || "google/gemini-2.5-flash"} repo=${repoDir}`);

const res = await run(task, repoDir, {
  onStep: ({ step, tool, result }) =>
    console.error(`  step ${step}: ${tool} -> ${result?.ok === false ? "FAIL" : "ok"}${result?.tier ? " (" + result.tier + ")" : ""}`),
});

console.error("\n--- result ---");
console.error("done:", res.done, "| turns:", res.turns, "| editFailures:", res.editFailures);
console.error("summary:", res.summary);
console.error("totals:", JSON.stringify(res.totals));
