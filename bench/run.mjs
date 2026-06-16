// run.mjs — head-to-head benchmark: proov (compact-edit) vs Claude-Code-style baseline.
//
// For each task and each harness: seed a FRESH workdir, run the harness on the SAME model,
// then run the task's behavioral oracle (exit 0 == success). Record success/tokens/$/turns/
// editFailures. Writes bench/results.json and prints a head-to-head table.
//
// env: MODEL (default google/gemini-2.5-flash), PROOV_TASKS (csv of task ids to run a subset),
//      MAX_STEPS (default 16).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.mjs";
import { runAgent } from "../src/agent.mjs";
import { runBaseline } from "../src/baseline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL || "google/gemini-2.5-flash";
const MAX_STEPS = +(process.env.MAX_STEPS || 16);

function genLargeFile() {
  let s = "// large utility module\n";
  for (let i = 0; i < 120; i++) s += `export function helper${i}(x){ return x + ${i}; }\n`;
  s += `export function computeTotal(items){\n  let total = 0;\n  for (const it of items){ total = total - it.price * it.qty; }\n  return total;\n}\n`;
  for (let i = 120; i < 240; i++) s += `export function helper${i}(x){ return x * ${i}; }\n`;
  return s;
}

function seedWorkdir(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `proov-${task.id}-`));
  if (task.seed.__generate === "largefile") {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "math.js"), genLargeFile());
  } else {
    for (const [rel, content] of Object.entries(task.seed)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
  // package.json so node treats .js as ESM in the oracle
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return dir;
}

function runOracle(dir, oracle) {
  try {
    execSync(oracle, { cwd: dir, timeout: 15000, stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash" });
    return true;
  } catch { return false; }
}

async function runOne(task, harness, runner) {
  const dir = seedWorkdir(task);
  let res, err = null;
  const t0 = Date.now();
  try {
    res = await runner(task.task, dir, { maxSteps: MAX_STEPS });
  } catch (e) {
    err = e.message;
    res = { done: false, turns: 0, editFailures: 0, totals: { totalTokens: 0, cost: 0 } };
  }
  const success = err ? false : runOracle(dir, task.oracle);
  const wallMs = Date.now() - t0;
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    task: task.id, kind: task.kind, harness, success,
    turns: res.turns, editFailures: res.editFailures,
    tokens: res.totals.totalTokens, promptTokens: res.totals.promptTokens,
    completionTokens: res.totals.completionTokens, cost: res.totals.cost,
    wallMs, error: err,
  };
}

async function main() {
  const subset = process.env.PROOV_TASKS ? process.env.PROOV_TASKS.split(",") : null;
  const tasks = subset ? TASKS.filter(t => subset.includes(t.id)) : TASKS;
  const rows = [];
  console.error(`benchmark: ${tasks.length} tasks x 2 harnesses, model=${MODEL}`);

  for (const task of tasks) {
    for (const [harness, runner] of [["proov", runAgent], ["baseline", runBaseline]]) {
      process.error?.write?.("");
      console.error(`\n[${task.id} / ${harness}] running...`);
      const row = await runOne(task, harness, runner);
      rows.push(row);
      console.error(`  -> success=${row.success} turns=${row.turns} tokens=${row.tokens} cost=$${row.cost.toFixed(5)} editFail=${row.editFailures}${row.error ? " ERR:" + row.error : ""}`);
    }
  }

  // aggregate
  const agg = (harness) => {
    const r = rows.filter(x => x.harness === harness);
    const n = r.length || 1;
    return {
      harness, n: r.length,
      successRate: r.filter(x => x.success).length / n,
      successes: r.filter(x => x.success).length,
      totalTokens: r.reduce((a, x) => a + x.tokens, 0),
      totalCost: +r.reduce((a, x) => a + x.cost, 0).toFixed(6),
      totalTurns: r.reduce((a, x) => a + x.turns, 0),
      totalEditFailures: r.reduce((a, x) => a + x.editFailures, 0),
    };
  };
  const summary = { model: MODEL, proov: agg("proov"), baseline: agg("baseline") };

  // per-kind cost comparison (where is the win biggest?)
  const kinds = [...new Set(rows.map(r => r.kind))];
  summary.byKind = kinds.map(k => {
    const a = rows.filter(r => r.harness === "proov" && r.kind === k);
    const b = rows.filter(r => r.harness === "baseline" && r.kind === k);
    const ac = a.reduce((s, x) => s + x.cost, 0), bc = b.reduce((s, x) => s + x.cost, 0);
    return { kind: k, ccaltCost: +ac.toFixed(6), baselineCost: +bc.toFixed(6),
             costSavedPct: bc > 0 ? +((1 - ac / bc) * 100).toFixed(1) : null };
  });

  const out = { ts: new Date().toISOString(), model: MODEL, rows, summary };
  const outPath = path.join(HERE, `results${subset ? "-subset" : ""}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log("\n================ HEAD-TO-HEAD (" + MODEL + ") ================");
  console.log(`harness   success      tokens     cost($)     turns  editFail`);
  for (const h of ["proov", "baseline"]) {
    const s = summary[h];
    console.log(`${(h === "proov" ? "proov" : "baseline").padEnd(9)} ${(s.successes + "/" + s.n).padEnd(11)} ${String(s.totalTokens).padEnd(11)} ${s.totalCost.toFixed(5).padEnd(11)} ${String(s.totalTurns).padEnd(6)} ${s.totalEditFailures}`);
  }
  const ca = summary.proov, bl = summary.baseline;
  if (bl.totalCost > 0) {
    const saved = (1 - ca.totalCost / bl.totalCost) * 100;
    console.log(`\ncost: proov is ${saved.toFixed(1)}% ${saved >= 0 ? "CHEAPER" : "MORE EXPENSIVE"} than baseline (same model).`);
    console.log(`success: proov ${(ca.successRate * 100).toFixed(0)}% vs baseline ${(bl.successRate * 100).toFixed(0)}%`);
  }
  console.log("\nby kind (cost saved by proov vs baseline):");
  for (const k of summary.byKind) console.log(`  ${k.kind.padEnd(14)} proov=$${k.ccaltCost.toFixed(5)} baseline=$${k.baselineCost.toFixed(5)} saved=${k.costSavedPct}%`);
  console.log(`\nwrote ${outPath}`);
}

main().catch(e => { console.error("BENCH FATAL:", e); process.exit(1); });
