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

// 8. Interactive REPL via a real PTY (Shift-Tab mode cycle, Ctrl-C, slash-commands) — Python pty.
console.log("\n8) interactive REPL (PTY)");
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
