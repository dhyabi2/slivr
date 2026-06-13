// demo.mjs — live end-to-end on ONE fixture repo. Seeds a fresh copy of the large-file task
// (where the compact-edit win is biggest), runs cc-alt and the baseline, runs the oracle, prints
// the side-by-side. Real LLM via OpenRouter (MODEL env, default google/gemini-2.5-flash).
//
//   node demo.mjs            # default task = fix-bug-largefile
//   node demo.mjs <taskId>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { TASKS } from "./bench/tasks.mjs";
import { runAgent } from "./src/agent.mjs";
import { runBaseline } from "./src/baseline.mjs";

const id = process.argv[2] || "fix-bug-largefile";
const task = TASKS.find(t => t.id === id) || TASKS[0];
const MODEL = process.env.MODEL || "google/gemini-2.5-flash";

function genLargeFile() {
  let s = "// large utility module\n";
  for (let i = 0; i < 120; i++) s += `export function helper${i}(x){ return x + ${i}; }\n`;
  s += `export function computeTotal(items){\n  let total = 0;\n  for (const it of items){ total = total - it.price * it.qty; }\n  return total;\n}\n`;
  for (let i = 120; i < 240; i++) s += `export function helper${i}(x){ return x * ${i}; }\n`;
  return s;
}
function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccalt-demo-"));
  if (task.seed.__generate === "largefile") {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "math.js"), genLargeFile());
  } else for (const [rel, c] of Object.entries(task.seed)) {
    const abs = path.join(dir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c);
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return dir;
}
function oracle(dir) { try { execSync(task.oracle, { cwd: dir, timeout: 15000, stdio: "ignore", shell: "/bin/bash" }); return true; } catch { return false; } }

console.log(`DEMO  task=${task.id}  model=${MODEL}\n`);
for (const [name, run] of [["cc-alt (compact-edit)", runAgent], ["baseline (Claude-Code-style)", runBaseline]]) {
  const dir = seed();
  console.log(`--- ${name} ---`);
  const res = await run(task.task, dir, { maxSteps: 16, onStep: ({ step, tool, result }) =>
    console.log(`  step ${step}: ${tool} ${result?.ok === false ? "FAIL" : "ok"}${result?.tier ? "(" + result.tier + ")" : ""}`) });
  const success = oracle(dir);
  const t = res.totals;
  console.log(`  => oracle=${success ? "PASS" : "FAIL"} turns=${res.turns} tokens=${t.totalTokens} cost=$${t.cost.toFixed(5)} editFail=${res.editFailures}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
}
