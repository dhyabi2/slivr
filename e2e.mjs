// e2e.mjs — END-TO-END tests: drive the real `slivr` CLI as a subprocess across the major flows.
// Deterministic flows always run; LLM-backed flows run only when OPENROUTER_API_KEY is set (cheap,
// google/gemini-2.5-flash). Exit non-zero on any failure.  Run:  node e2e.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const BIN = path.resolve("bin/slivr.mjs");
const STUB = path.resolve("test/stub-mcp.mjs");
const HAS_KEY = !!(process.env.OPENROUTER_API_KEY);
const env = { ...process.env, MODEL: process.env.MODEL || "google/gemini-2.5-flash" };
let pass = 0, fail = 0, skip = 0;
const ok = (b, m) => { console.log(`  ${b ? "PASS" : "FAIL"}  ${m}`); b ? pass++ : fail++; };
const skipIf = (m) => { console.log(`  SKIP  ${m} (no OPENROUTER_API_KEY)`); skip++; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "slivr-e2e-"));
const run = (args, opts = {}) => spawnSync("node", [BIN, ...args], { encoding: "utf8", env, timeout: opts.timeout || 60000, cwd: opts.cwd || process.cwd() });

console.log("E2E: slivr CLI" + (HAS_KEY ? " (with live LLM flows)" : " (deterministic only)"));

// 1. version / help / config (deterministic)
console.log("\n1) CLI basics");
{ const r = run(["--version"]); ok(r.status === 0 && /slivr/.test(r.stdout), "--version prints slivr"); }
{ const r = run(["--help"]); ok(/skills/.test(r.stdout) && /schedule/.test(r.stdout) && /mcp/.test(r.stdout), "--help lists skills/schedule/mcp"); }
{ const r = run(["config"]); ok(/model/.test(r.stdout), "config prints resolved config"); }

// 2. skills (deterministic): list the shipped skills
console.log("\n2) skills");
{ const r = run(["skills"], { cwd: process.cwd() }); ok(/review/.test(r.stdout) && /commit/.test(r.stdout), "skills lists review + commit"); }

// 3. MCP (deterministic): connect the local stub server, list its tools
console.log("\n3) mcp");
{
  const d = tmp();
  fs.writeFileSync(path.join(d, ".slivr.json"), JSON.stringify({ mcpServers: { stub: { command: "node", args: [STUB] } } }));
  const r = run(["mcp", "list"], { cwd: d });
  ok(/mcp__stub__echo/.test(r.stdout) && /mcp__stub__add/.test(r.stdout), "mcp list discovers stub echo+add tools");
}

// 4. background jobs (deterministic infra; the bg run itself needs the key to do the task)
console.log("\n4) background jobs");
if (HAS_KEY) {
  const d = tmp();
  const fname = "bgout_" + Math.floor(Number(process.hrtime.bigint() % 1000000n)) + ".txt"; // unique -> no stale-job collision
  const target = () => [path.join(d, fname), path.join(fs.realpathSync(d), fname)].find(fs.existsSync);
  const r = run(["bg", `create a file ${fname} containing exactly the word ok`], { cwd: d }); // canonical: cd repo && slivr bg "task"
  const id = (r.stdout + r.stderr).match(/job ([a-z0-9-]+) \(pid/)?.[1];
  ok(r.status === 0 && !!id, "bg starts a detached job (returns a job id + log path)");
  // poll up to ~30s for THIS job's output file to actually appear (the real end-to-end goal)
  for (let i = 0; i < 30 && !target(); i++) spawnSync("sleep", ["1"]);
  const f = target();
  ok(!!f, `background job created ${fname}`);
  ok(f && fs.readFileSync(f, "utf8").trim() === "ok", "background job wrote the right content");
} else skipIf("bg job (needs key to run the task)");

// 5. scheduler daemon lifecycle (deterministic)
console.log("\n5) scheduler daemon");
{
  run(["scheduler", "stop"]); // ensure clean
  const start = run(["scheduler", "--daemon"]);
  ok(/started/.test(start.stdout + start.stderr), "scheduler --daemon starts");
  const st = run(["scheduler", "status"]);
  ok(/running/.test(st.stdout + st.stderr), "scheduler status = running");
  const stop = run(["scheduler", "stop"]);
  ok(/stopped/.test(stop.stdout + stop.stderr), "scheduler stop works");
}

// 6. LIVE one-shot edit: add a function + run a check (the core agent loop)
console.log("\n6) one-shot edit (live)");
if (HAS_KEY) {
  const d = tmp();
  fs.writeFileSync(path.join(d, "m.js"), "export function add(a,b){return a+b;}\n");
  fs.writeFileSync(path.join(d, "check.js"), "import {add,mul} from './m.js'; if(mul(3,4)!==12)process.exit(1); console.log('ok');\n");
  const r = run(["add a mul(a,b) export to m.js, then run 'node check.js' to verify it passes", d, "--auto"], { cwd: d, timeout: 120000 });
  const verify = spawnSync("node", ["check.js"], { cwd: d, encoding: "utf8" });
  ok(verify.status === 0 && /ok/.test(verify.stdout), "agent added mul -> node check.js passes");
} else skipIf("one-shot edit");

// 7. LIVE multimodal: agent views a generated PNG and names its color
console.log("\n7) multimodal view_image (live)");
if (HAS_KEY) {
  const d = tmp();
  const W = 24, H = 24, raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) { raw[y * (1 + W * 3)] = 0; for (let x = 0; x < W; x++) { const o = y * (1 + W * 3) + 1 + x * 3; raw[o] = 128; raw[o + 1] = 0; raw[o + 2] = 128; } }
  const crcT = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (t, dt) => { const ty = Buffer.from(t), L = Buffer.alloc(4); L.writeUInt32BE(dt.length); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(Buffer.concat([ty, dt]))); return Buffer.concat([L, ty, dt, cc]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(path.join(d, "p.png"), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
  const r = run(["use view_image on p.png and tell me the single color that fills it", d, "--auto"], { cwd: d, timeout: 90000 });
  ok(/purple/i.test(r.stdout + r.stderr), "agent view_image -> names the color purple");
} else skipIf("multimodal view_image");

// 8. AGENT-DRIVEN tool coverage (live): the model must CHOOSE these tools to finish the task.
console.log("\n8) agent-driven: edit_files (multi-file)");
if (HAS_KEY) {
  const d = tmp();
  fs.writeFileSync(path.join(d, "a.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(d, "b.js"), "export const y = 2;\n");
  const r = run(["in ONE edit_files call, rename the const in a.js from x to alpha and in b.js from y to beta", d, "--auto"], { cwd: d, timeout: 120000 });
  const a = fs.readFileSync(path.join(d, "a.js"), "utf8"), b = fs.readFileSync(path.join(d, "b.js"), "utf8");
  ok(/edit_files/.test(r.stdout + r.stderr), "agent chose edit_files");
  ok(/alpha/.test(a) && /beta/.test(b), "both files edited (a->alpha, b->beta)");
} else skipIf("edit_files");

console.log("\n9) agent-driven: git_commit");
if (HAS_KEY) {
  const d = tmp();
  spawnSync("git", ["init", "-q"], { cwd: d }); spawnSync("git", ["config", "user.email", "e@e"], { cwd: d }); spawnSync("git", ["config", "user.name", "e"], { cwd: d });
  fs.writeFileSync(path.join(d, "m.js"), "export const k = 1;\n"); spawnSync("git", ["add", "-A"], { cwd: d }); spawnSync("git", ["commit", "-qm", "base"], { cwd: d });
  const r = run(["add a function double(n){return n*2} to m.js, then commit it with git_commit", d, "--auto"], { cwd: d, timeout: 120000 });
  const log = spawnSync("git", ["log", "--oneline"], { cwd: d, encoding: "utf8" }).stdout;
  ok(/git_commit/.test(r.stdout + r.stderr), "agent chose git_commit");
  ok(log.trim().split("\n").length >= 2 && /double/.test(fs.readFileSync(path.join(d, "m.js"), "utf8")), "new commit created + double() added");
} else skipIf("git_commit");

console.log("\n10) agent-driven: web_search");
if (HAS_KEY) {
  const r = run(["use web_search to find the current LTS major version of Node.js and report just the number", tmp(), "--auto"], { timeout: 90000 });
  ok(/web_search/.test(r.stdout + r.stderr), "agent chose web_search (web plugin)");
} else skipIf("web_search");

console.log("\n11) agent-driven: view_pdf");
if (HAS_KEY) {
  const d = tmp();
  const mkPdf = (text) => {
    const objs = ["<</Type/Catalog/Pages 2 0 R>>", "<</Type/Pages/Kids[3 0 R]/Count 1>>",
      "<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>"];
    const stream = `BT /F1 18 Tf 30 60 Td (${text}) Tj ET`;
    objs.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
    objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
    let pdf = "%PDF-1.4\n"; const off = [];
    objs.forEach((o, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xr = pdf.length; pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    off.forEach((o) => { pdf += String(o).padStart(10, "0") + " 00000 n \n"; });
    pdf += `trailer\n<</Root 1 0 R/Size ${objs.length + 1}>>\nstartxref\n${xr}\n%%EOF`;
    return Buffer.from(pdf, "latin1");
  };
  fs.writeFileSync(path.join(d, "secret.pdf"), mkPdf("The secret word is BANANA42"));
  const r = run(["use view_pdf on secret.pdf and tell me the secret word", d, "--auto"], { cwd: d, timeout: 90000 });
  ok(/view_pdf/.test(r.stdout + r.stderr), "agent chose view_pdf");
  ok(/BANANA42/i.test(r.stdout + r.stderr), "agent read the PDF text (BANANA42)");
} else skipIf("view_pdf");

console.log("\n12) agent-driven: parallel");
if (HAS_KEY) {
  const d = tmp();
  fs.writeFileSync(path.join(d, "f1.txt"), "alpha-one\n"); fs.writeFileSync(path.join(d, "f2.txt"), "beta-two\n");
  const r = run(["use the parallel tool to read f1.txt and f2.txt at the same time, then report both contents", d, "--auto"], { cwd: d, timeout: 120000 });
  const out = r.stdout + r.stderr;
  ok(/parallel/.test(out), "agent chose parallel");
  // parallel fans out concurrent sub-agents — assert >=2 actually ran (the `↳` sub-result lines).
  const subs = (out.match(/↳/g) || []).length;
  ok(subs >= 2 || /\b2 subtask/.test(out), `parallel fanned out >=2 concurrent sub-agents (saw ${subs})`);
  // findings round-trip: each sub-agent now returns the content it gathered (not just a terse
  // summary), so the parent must be able to report BOTH file contents back to the user.
  ok(/alpha-one/.test(out) && /beta-two/.test(out), "both file contents round-tripped via sub-agent findings");
} else skipIf("parallel");

// 13. REAL MCP server (npx @modelcontextprotocol/server-everything) — network-dependent.
console.log("\n13) real MCP server (npx)");
{
  const d = tmp();
  fs.writeFileSync(path.join(d, ".slivr.json"), JSON.stringify({ mcpServers: { everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] } } }));
  const r = run(["mcp", "list"], { cwd: d, timeout: 120000 });
  if (/mcp__everything__/.test(r.stdout)) ok(true, "real npx everything-server: tools discovered");
  else { console.log("  SKIP  real MCP server (npx/network unavailable)"); skip++; }
}

// 14. Timed scheduled job actually fires (live).
console.log("\n14) timed scheduled job fires");
if (HAS_KEY) {
  const d = tmp();
  const fname = "sched_" + Math.floor(Number(process.hrtime.bigint() % 1000000n)) + ".txt";
  run(["scheduler", "stop"]); // clean
  run(["schedule", `create a file ${fname} containing exactly fired`, "--in", "4s"], { cwd: d });
  run(["scheduler", "--daemon", "--every", "2"]);
  const target = () => [path.join(d, fname), path.join(fs.realpathSync(d), fname)].find(fs.existsSync);
  for (let i = 0; i < 25 && !target(); i++) spawnSync("sleep", ["1"]);
  run(["scheduler", "stop"]);
  ok(!!target(), `scheduled job fired and created ${fname}`);
} else skipIf("timed scheduled job");

// 15. Interactive REPL via a real PTY (Shift-Tab mode cycle, Ctrl-C, slash-commands) — Python pty.
console.log("\n15) interactive REPL (PTY)");
{
  const py = spawnSync("python3", [path.resolve("test/repl_e2e.py")], { encoding: "utf8", env, timeout: 60000 });
  if (py.error && /ENOENT/.test(String(py.error))) { console.log("  SKIP  REPL PTY suite (python3 not found)"); skip++; }
  else {
    const m = (py.stdout || "").match(/REPL E2E: (\d+) passed, (\d+) failed/);
    (py.stdout || "").split("\n").filter((l) => /PASS|FAIL/.test(l)).forEach((l) => console.log("  " + l.trim()));
    ok(py.status === 0 && m && m[2] === "0", `REPL PTY suite (${m ? m[1] : "?"} interactive checks)`);
  }
}

console.log(`\nE2E: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
