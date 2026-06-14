// livecodebench.mjs — run slivr (the agent) against LiveCodeBench code-generation problems and
// report pass@1.
//
// LiveCodeBench (https://livecodebench.github.io) is a contamination-free coding benchmark of
// competitive-programming problems (LeetCode / AtCoder / Codeforces) with held-out tests. This
// harness drives slivr one problem at a time, extracts the generated solution, executes it against
// the problem's test cases (via python3), and computes pass@1 = (#problems where ALL tests pass).
//
// IMPORTANT — fidelity / scope:
//   * Tests come from each problem's `public_test_cases` (always plain JSON) and, when decodable,
//     `private_test_cases`. The official dataset compresses private cases with base64+zlib+pickle;
//     pickle can't be decoded in pure Node, so for FULL private-test fidelity use the official
//     Python runner (see bench/LIVECODEBENCH.md). Public-test pass@1 is a strong, honest proxy.
//   * `stdin` test type (AtCoder/Codeforces style) is graded by piping input to the program and
//     comparing stdout. `functional` test type (LeetCode style) is graded by importing the solution
//     and calling metadata.func_name with the JSON-decoded args. Both are validated offline below.
//
// USAGE
//   node bench/livecodebench.mjs --data <problems.jsonl> [--limit N] [--model id] [--max-steps N]
//   node bench/livecodebench.mjs --mock                 # validate the harness offline (no API key)
//   npm run bench:lcb -- --data lcb.jsonl --limit 20
//
// Each line of --data is ONE problem object with LiveCodeBench fields (see bench/LIVECODEBENCH.md
// for how to export the HuggingFace dataset to this JSONL shape). --mock ignores the model and uses
// each problem's bundled reference solution, so it exercises extraction + execution + scoring only.
//
// env: OPENROUTER_API_KEY (required unless --mock), MODEL (default google/gemini-2.5-flash).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const o = { data: null, limit: Infinity, model: process.env.MODEL || "google/gemini-2.5-flash", maxSteps: 8, mock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mock") o.mock = true;
    else if (a === "--data") o.data = argv[++i];
    else if (a === "--limit") o.limit = parseInt(argv[++i], 10) || Infinity;
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--max-steps") o.maxSteps = parseInt(argv[++i], 10) || 8;
  }
  return o;
}

// ---- dataset loading --------------------------------------------------------
// A problem's test fields are JSON STRINGS in the real dataset; tolerate already-parsed arrays too.
function asTests(v) {
  if (!v) return [];
  let arr = v;
  if (typeof v === "string") { try { arr = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  return arr.map(t => ({ input: String(t.input ?? ""), output: String(t.output ?? ""), testtype: t.testtype || t.type || "stdin" }));
}
function funcName(meta) {
  if (!meta) return null;
  let m = meta;
  if (typeof meta === "string") { try { m = JSON.parse(meta); } catch { return null; } }
  return m && (m.func_name || m.fn_name) || null;
}
function loadProblems(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
  return lines.map((l, i) => {
    const o = JSON.parse(l);
    const pub = asTests(o.public_test_cases);
    const priv = asTests(o.private_test_cases);   // plain-JSON private only; compressed ones load as []
    return {
      id: o.question_id || o.id || `p${i}`,
      title: o.question_title || o.title || `problem ${i}`,
      content: o.question_content || o.content || "",
      starter: o.starter_code || "",
      platform: o.platform || "?",
      difficulty: o.difficulty || "?",
      func: funcName(o.metadata),
      tests: [...pub, ...priv],
      reference: o.reference_solution || o.canonical_solution || null, // for --mock self-test
    };
  });
}

// ---- driving slivr ----------------------------------------------------------
// Seed a scratch repo, ask slivr to WRITE solution.py, then read it back. Returns the solution text.
async function solveWithSlivr(prob, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lcb-${prob.id}-`));
  const solPath = path.join(dir, "solution.py");
  // Note: we do NOT pre-create solution.py — a pre-seeded file forces slivr's edit-anchor path for a
  // from-scratch write, which is the wrong tool for codegen. Let the agent create_file cleanly.
  const io = prob.func
    ? `This is a function-style problem: implement \`${prob.func}\` (use this starter signature exactly):\n\n${prob.starter || "(no starter provided)"}\n\nPut the full class/function in solution.py.`
    : `This is a standard-IO problem: read input from STDIN and write the answer to STDOUT. Put a runnable script in solution.py.`;
  const task =
    `Solve this competitive-programming problem in Python 3. Create a file named solution.py containing ONLY the final runnable solution (use the create_file tool). Do not run it.\n\n` +
    `# ${prob.title}\n\n${prob.content}\n\n${io}\n\nAfter creating solution.py, call done.`;
  await runAgent(task, dir, { model: opts.model, apiKey: process.env.OPENROUTER_API_KEY, maxSteps: opts.maxSteps });
  let code = "";
  try { code = fs.readFileSync(solPath, "utf8"); } catch { /* agent may have written elsewhere */ }
  // Fallback: if solution.py is still the placeholder, grab the largest .py file the agent created.
  if (!code.trim() || /write your solution here/.test(code)) {
    const py = fs.readdirSync(dir).filter(f => f.endsWith(".py")).map(f => path.join(dir, f));
    let best = code;
    for (const f of py) { const c = fs.readFileSync(f, "utf8"); if (c.length > best.length && !/write your solution here/.test(c)) best = c; }
    code = best;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return code;
}

// ---- execution / grading ----------------------------------------------------
const PY = process.env.PYTHON || "python3";
const TIMEOUT_MS = 8000;

function normalize(s) {
  return String(s).replace(/\r\n/g, "\n").split("\n").map(l => l.replace(/[ \t]+$/g, "")).join("\n").replace(/\n+$/g, "");
}

// stdin/stdout grading: pipe `input` to the program, compare normalized stdout to `output`.
function runStdin(code, test) {
  const r = spawnSync(PY, ["-c", code], { input: test.input, timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 << 20 });
  if (r.error || r.status !== 0) return { ok: false, why: r.error ? (r.error.code || r.error.message) : `exit ${r.status}`, stderr: (r.stderr || "").slice(-300) };
  return { ok: normalize(r.stdout) === normalize(test.output), got: normalize(r.stdout) };
}

// functional grading (LeetCode style): import the solution, call func(*args) where each line of the
// test input is a JSON-decoded argument; compare the JSON-decoded return to the expected output.
function runFunctional(code, test, func) {
  const harness = [
    "import json, sys",
    "ns = {}",
    "exec(_CODE_, ns)",
    "args = [json.loads(x) for x in _INPUT_.split(chr(10)) if x.strip() != '']",
    "Sol = ns.get('Solution')",
    "fn = getattr(Sol(), _FUNC_) if Sol is not None else ns.get(_FUNC_)",
    "res = fn(*args)",
    "exp = json.loads(_EXPECTED_)",
    "def norm(x):\n  return sorted(x) if isinstance(x, list) and x and all(isinstance(i,(int,float,str)) for i in x) else x",
    "ok = (res == exp) or (norm(res) == norm(exp))",
    "print('__LCB_OK__' if ok else '__LCB_FAIL__' + repr(res))",
  ].join("\n")
    .replace("_CODE_", JSON.stringify(code))
    .replace("_INPUT_", JSON.stringify(test.input))
    .replace("_FUNC_", JSON.stringify(func))
    .replace("_EXPECTED_", JSON.stringify(test.output.trim() || "null"));
  const r = spawnSync(PY, ["-c", harness], { timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 << 20 });
  if (r.error || r.status !== 0) return { ok: false, why: r.error ? (r.error.code || r.error.message) : `exit ${r.status}`, stderr: (r.stderr || "").slice(-300) };
  return { ok: /__LCB_OK__/.test(r.stdout || ""), got: (r.stdout || "").trim().slice(0, 200) };
}

function grade(code, prob) {
  if (!code || !code.trim()) return { pass: false, passed: 0, total: prob.tests.length, reason: "no solution produced" };
  let passed = 0;
  for (const t of prob.tests) {
    const res = (t.testtype === "functional" || prob.func) ? runFunctional(code, t, prob.func) : runStdin(code, t);
    if (res.ok) passed++;
    else if (!res.firstFail) { /* keep going to count, first failure recorded below */ }
  }
  return { pass: passed === prob.tests.length && prob.tests.length > 0, passed, total: prob.tests.length };
}

// ---- main -------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dataFile = opts.data || (opts.mock ? path.join(HERE, "lcb-sample.jsonl") : null);
  if (!dataFile) { console.error("error: --data <problems.jsonl> is required (or use --mock). See bench/LIVECODEBENCH.md"); process.exit(2); }
  if (!opts.mock && !process.env.OPENROUTER_API_KEY) { console.error("error: OPENROUTER_API_KEY is required (or use --mock to validate the harness offline)."); process.exit(3); }
  // sanity: python3 must exist
  const pyv = spawnSync(PY, ["--version"], { encoding: "utf8" });
  if (pyv.error) { console.error(`error: ${PY} not found — needed to execute candidate solutions. Set PYTHON=...`); process.exit(4); }

  const problems = loadProblems(dataFile).slice(0, opts.limit);
  console.log(`LiveCodeBench · ${problems.length} problem(s) · ${opts.mock ? "MOCK (reference solutions)" : "model " + opts.model} · ${pyv.stdout.trim()}`);
  console.log("");

  const results = [];
  let solved = 0;
  for (const prob of problems) {
    const code = opts.mock ? (prob.reference || "") : await solveWithSlivr(prob, opts);
    const g = grade(code, prob);
    if (g.pass) solved++;
    results.push({ id: prob.id, title: prob.title, platform: prob.platform, difficulty: prob.difficulty, type: prob.func ? "functional" : "stdin", ...g });
    const mark = g.pass ? "✓" : "✗";
    console.log(`  ${mark} ${prob.id}  ${String(prob.title).slice(0, 48).padEnd(48)} ${g.passed}/${g.total} tests  [${prob.difficulty}]`);
  }

  const pass1 = problems.length ? (solved / problems.length) : 0;
  console.log("");
  console.log(`pass@1: ${solved}/${problems.length} = ${(pass1 * 100).toFixed(1)}%`);
  const out = path.join(HERE, "results-livecodebench.json");
  fs.writeFileSync(out, JSON.stringify({ model: opts.mock ? "mock" : opts.model, n: problems.length, solved, pass1, results, when: null }, null, 2) + "\n");
  console.log(`wrote ${out}`);
  // In --mock the bundled references MUST all pass, otherwise the harness itself is broken.
  if (opts.mock && solved !== problems.length) { console.error(`\nMOCK SELF-TEST FAILED: ${solved}/${problems.length} reference solutions passed (expected all).`); process.exit(1); }
  if (opts.mock) console.log("\nmock self-test OK — extraction + execution + scoring verified.");
}

main().catch(e => { console.error(e?.stack || e); process.exit(1); });
