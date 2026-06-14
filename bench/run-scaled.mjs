// run-scaled.mjs — SCALED, statistically-honest head-to-head: cc-alt (compact-edit) vs a
// Claude-Code-style full-rewrite baseline, SAME model on both sides, oracle-judged, with
// REPS per (task,harness) to quantify LLM nondeterminism.
//
// env:
//   MODEL       (default google/gemini-2.5-flash)
//   REPS        (default 3) repetitions per (task,harness)
//   CCALT_TASKS (csv subset of task ids; else all)
//   MAX_STEPS   (default 16) — the baseline's runaway-context cap; hitting it on large files is
//               the failure mode we are measuring.
//   COST_CAP    (USD) — if cumulative spend across this run exceeds it, STOP launching new runs
//               and record that we stopped (used to bound the expensive claude runs).
//   OUT         (default results-scaled-<modelslug>.json)
//
// Output: a JSON file with every raw row + aggregate stats (success, mean/stddev/median/IQR of
// tokens/cost/turns, per-regime breakdown, runaway-failure rate) and a printed summary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TASKS, genSeed, seedLines } from "./tasks-scaled.mjs";
import { runAgent } from "../src/agent.mjs";
import { runBaseline } from "../src/baseline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL || "google/gemini-2.5-flash";
const REPS = +(process.env.REPS || 3);
const MAX_STEPS = +(process.env.MAX_STEPS || 16);
const COST_CAP = process.env.COST_CAP ? +process.env.COST_CAP : Infinity;
const modelSlug = MODEL.replace(/[\/:]/g, "-");
const OUT = process.env.OUT || `results-scaled-${modelSlug}.json`;

function seedWorkdir(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ccalt-${task.id}-`));
  const files = genSeed(task.seed);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return dir;
}

function runOracle(dir, oracle) {
  try {
    execSync(oracle, { cwd: dir, timeout: 15000, stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash" });
    return true;
  } catch { return false; }
}

async function runOne(task, harness, runner, rep) {
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
  // "runaway": the agent never called done AND used (nearly) the whole step budget — the
  // full-rewrite context-blowup failure mode. We flag it when turns >= MAX_STEPS and not done.
  const runaway = !res.done && (res.turns >= MAX_STEPS);
  return {
    task: task.id, kind: task.kind, harness, rep, success,
    done: !!res.done, turns: res.turns, editFailures: res.editFailures, runaway,
    tokens: res.totals.totalTokens, promptTokens: res.totals.promptTokens,
    completionTokens: res.totals.completionTokens, cost: res.totals.cost,
    wallMs, error: err,
  };
}

// ----- stats helpers -----
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function stddev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); // sample stddev
}
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function median(a) { return quantile([...a].sort((x, y) => x - y), 0.5); }
function iqr(a) { const s = [...a].sort((x, y) => x - y); return [quantile(s, 0.25), quantile(s, 0.75)]; }

function summarize(rows) {
  const n = rows.length;
  const tokens = rows.map(r => r.tokens);
  const cost = rows.map(r => r.cost);
  const turns = rows.map(r => r.turns);
  const successes = rows.filter(r => r.success).length;
  return {
    n, successes, successRate: n ? successes / n : 0,
    runawayCount: rows.filter(r => r.runaway).length,
    runawayRate: n ? rows.filter(r => r.runaway).length / n : 0,
    editFailures: rows.reduce((s, r) => s + r.editFailures, 0),
    tokens: { mean: +mean(tokens).toFixed(1), stddev: +stddev(tokens).toFixed(1), median: median(tokens), iqr: iqr(tokens).map(x => +x.toFixed(1)), total: tokens.reduce((s, x) => s + x, 0) },
    cost:   { mean: +mean(cost).toFixed(6), stddev: +stddev(cost).toFixed(6), median: +median(cost).toFixed(6), iqr: iqr(cost).map(x => +x.toFixed(6)), total: +cost.reduce((s, x) => s + x, 0).toFixed(6) },
    turns:  { mean: +mean(turns).toFixed(2), stddev: +stddev(turns).toFixed(2), median: median(turns) },
  };
}

async function main() {
  const subset = process.env.CCALT_TASKS ? process.env.CCALT_TASKS.split(",") : null;
  const tasks = subset ? TASKS.filter(t => subset.includes(t.id)) : TASKS;
  const rows = [];
  let cumCost = 0, stopped = false, stoppedReason = null;
  const startedAt = new Date().toISOString();
  console.error(`SCALED benchmark: ${tasks.length} tasks x 2 harnesses x ${REPS} reps, model=${MODEL}, costCap=${COST_CAP}`);

  outer:
  for (const task of tasks) {
    for (let rep = 0; rep < REPS; rep++) {
      for (const [harness, runner] of [["cc-alt", runAgent], ["baseline", runBaseline]]) {
        if (cumCost > COST_CAP) {
          stopped = true;
          stoppedReason = `cumulative cost $${cumCost.toFixed(4)} exceeded cap $${COST_CAP} before [${task.id}/${harness}/rep${rep}]`;
          console.error(`\n!! STOPPING: ${stoppedReason}`);
          break outer;
        }
        console.error(`[${task.id} / ${harness} / rep${rep}] running... (cum $${cumCost.toFixed(4)})`);
        const row = await runOne(task, harness, runner, rep);
        rows.push(row);
        cumCost += row.cost;
        console.error(`  -> success=${row.success} done=${row.done} turns=${row.turns} tokens=${row.tokens} cost=$${row.cost.toFixed(5)} runaway=${row.runaway}${row.error ? " ERR:" + row.error : ""}`);
      }
    }
  }

  const ccaltRows = rows.filter(r => r.harness === "cc-alt");
  const baseRows = rows.filter(r => r.harness === "baseline");

  // per-regime breakdown
  const regimes = [...new Set(rows.map(r => r.kind))];
  const byRegime = regimes.map(k => {
    const ca = ccaltRows.filter(r => r.kind === k);
    const bl = baseRows.filter(r => r.kind === k);
    const cas = summarize(ca), bls = summarize(bl);
    const costSavedPct = bls.cost.mean > 0 ? +((1 - cas.cost.mean / bls.cost.mean) * 100).toFixed(1) : null;
    const tokSavedPct = bls.tokens.mean > 0 ? +((1 - cas.tokens.mean / bls.tokens.mean) * 100).toFixed(1) : null;
    return { regime: k, ccalt: cas, baseline: bls, costSavedPct, tokenSavedPct: tokSavedPct };
  });

  // per-task breakdown (useful for the report appendix)
  const byTask = tasks.map(t => {
    const ca = ccaltRows.filter(r => r.task === t.id);
    const bl = baseRows.filter(r => r.task === t.id);
    const sl = seedLines(t.seed);
    return {
      task: t.id, kind: t.kind, maxFileLines: sl.maxFileLines, files: sl.files,
      ccalt: ca.length ? summarize(ca) : null,
      baseline: bl.length ? summarize(bl) : null,
    };
  });

  const overall = { ccalt: summarize(ccaltRows), baseline: summarize(baseRows) };
  const aggCostSavedPct = overall.baseline.cost.total > 0
    ? +((1 - overall.ccalt.cost.total / overall.baseline.cost.total) * 100).toFixed(1) : null;

  const out = {
    startedAt, finishedAt: new Date().toISOString(), model: MODEL, reps: REPS, maxSteps: MAX_STEPS,
    costCap: COST_CAP === Infinity ? null : COST_CAP, stopped, stoppedReason,
    cumulativeCost: +cumCost.toFixed(6),
    tasksRun: tasks.length, rowsCollected: rows.length,
    overall, byRegime, byTask, rows,
  };
  const outPath = path.join(HERE, OUT);
  // merge into a combined results-scaled.json keyed by model (so both model runs coexist)
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  // print summary
  console.log(`\n================ SCALED HEAD-TO-HEAD (${MODEL}, reps=${REPS}) ================`);
  console.log(`harness    succ      cost/run(mean±sd)        tokens/run(mean±sd)     runaway`);
  for (const h of ["ccalt", "baseline"]) {
    const s = overall[h];
    console.log(`${(h === "ccalt" ? "cc-alt" : "baseline").padEnd(10)} ${(s.successes + "/" + s.n).padEnd(9)} $${s.cost.mean.toFixed(5)}±${s.cost.stddev.toFixed(5)}   ${String(Math.round(s.tokens.mean)).padStart(7)}±${String(Math.round(s.tokens.stddev)).padStart(7)}   ${s.runawayCount}/${s.n}`);
  }
  if (aggCostSavedPct != null) console.log(`\nAGGREGATE: cc-alt ${aggCostSavedPct}% cheaper; success cc-alt ${(overall.ccalt.successRate*100).toFixed(0)}% vs baseline ${(overall.baseline.successRate*100).toFixed(0)}%`);
  console.log(`\nPER-REGIME (mean cost/run, % saved by cc-alt):`);
  for (const r of byRegime) {
    console.log(`  ${r.regime.padEnd(14)} cc-alt=$${r.ccalt.cost.mean.toFixed(5)} base=$${r.baseline.cost.mean.toFixed(5)} saved=${r.costSavedPct}%  | succ cc-alt ${r.ccalt.successes}/${r.ccalt.n} base ${r.baseline.successes}/${r.baseline.n}  | base runaway ${r.baseline.runawayCount}/${r.baseline.n}`);
  }
  if (stopped) console.log(`\n!! RUN STOPPED EARLY: ${stoppedReason}`);
  console.log(`\nwrote ${outPath} (cumulative spend this run: $${cumCost.toFixed(4)})`);
}

main().catch(e => { console.error("BENCH FATAL:", e); process.exit(1); });
