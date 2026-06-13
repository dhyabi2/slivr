// selftest.mjs — DETERMINISTIC tests (no LLM). Validates:
//   1. the compact edit protocol (SEAL): unique apply, ambiguous rejection, repair packet on miss
//   2. the tool sandbox: read/list/grep/edit + sandbox-escape rejection
//   3. a STUBBED agent loop: a scripted "model" drives the loop to done with a real edit
// Exits non-zero on any failure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdit } from "./src/seal.mjs";
import { Tools } from "./src/tools.mjs";
import { runLoop } from "./src/loop.mjs";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name, extra); }
}

console.log("== 1. SEAL compact edit protocol ==");
{
  const src = "function a(){\n  return 1;\n}\nfunction b(){\n  return 2;\n}\n";
  const r1 = applyEdit(src, { anchor: "  return 1;", replacement: "  return 11;" });
  ok("unique exact apply", r1.ok && r1.content.includes("return 11;") && r1.content.includes("return 2;"));

  // ambiguous anchor -> must be REJECTED with a packet (no wrong-location edit)
  const dup = "x = 1;\ny = 0;\nx = 1;\n";
  const r2 = applyEdit(dup, { anchor: "x = 1;", replacement: "x = 2;" });
  ok("ambiguous anchor rejected", !r2.ok && r2.repair && /AMBIGUOUS/.test(r2.repair.error), JSON.stringify(r2).slice(0, 120));

  // anchor not present -> repair packet with nearest spans (NOT the whole file echoed back)
  const r3 = applyEdit(src, { anchor: "  return 99;", replacement: "  return 0;" });
  const packetSize = JSON.stringify(r3.repair || {}).length;
  ok("miss returns repair packet", !r3.ok && r3.repair && Array.isArray(r3.repair.nearestRealSpans));
  ok("repair packet is COMPACT (< raw file*3)", packetSize < src.length * 3 + 800, "packet=" + packetSize);
}

console.log("== 2. tool sandbox ==");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccalt-"));
{
  fs.writeFileSync(path.join(tmp, "f.js"), "export const N = 1;\nexport const M = 2;\n");
  const t = new Tools(tmp);
  ok("read_file", t.read_file({ path: "f.js" }).content.includes("N = 1"));
  ok("list_dir", t.list_dir({}).entries.includes("f.js"));
  ok("grep", t.grep({ pattern: "N = " }).hits.length === 1);

  const e = t.edit_file({ path: "f.js", anchor: "export const N = 1;", replacement: "export const N = 42;" });
  ok("edit_file compact apply", e.ok && t.read_file({ path: "f.js" }).content.includes("N = 42"));

  const w = t.write_file({ path: "f.js", content: "export const N = 0;\n" });
  ok("write_file full rewrite", w.ok && t.read_file({ path: "f.js" }).content === "export const N = 0;\n");

  const cf = t.create_file({ path: "new.js", content: "export const Z = 9;\n" });
  ok("create_file new file", cf.ok && t.read_file({ path: "new.js" }).content.includes("Z = 9"));
  const cf2 = t.create_file({ path: "new.js", content: "x" });
  ok("create_file refuses overwrite", !cf2.ok && cf2.error === "FILE_EXISTS");

  let escaped = false;
  try { t.read_file({ path: "../../../etc/passwd" }); } catch (err) { escaped = /SANDBOX/.test(err.message); }
  ok("sandbox escape rejected", escaped);

  const cmd = t.run_command({ command: "echo hi" });
  ok("run_command in workdir", cmd.ok && cmd.stdout.trim() === "hi");
}

console.log("== 3. stubbed agent loop (no LLM) ==");
{
  fs.writeFileSync(path.join(tmp, "g.js"), "export function val(){ return 1; }\n");
  const t = new Tools(tmp);
  const toolMap = {
    read_file: (a) => t.read_file(a),
    edit_file: (a) => t.edit_file(a),
    run_command: (a) => t.run_command(a),
  };
  // scripted "model": read, edit, then done
  const script = [
    JSON.stringify({ tool: "read_file", args: { path: "g.js" } }),
    JSON.stringify({ tool: "edit_file", args: { path: "g.js", anchor: "return 1;", replacement: "return 2;" } }),
    JSON.stringify({ tool: "done", args: { summary: "changed val to 2" } }),
  ];
  let i = 0;
  const fakeProvider = {
    chat: async () => ({ text: script[i++] ?? '{"tool":"done","args":{}}', usage: {}, raw: {} }),
    totals: () => ({ model: "stub", calls: i, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 }),
  };
  const res = await runLoop({ provider: fakeProvider, tools: t, toolMap, systemPrompt: "stub", task: "set val to 2", maxSteps: 6 });
  ok("loop reaches done", res.done && /val to 2/.test(res.summary));
  ok("loop applied the edit", t.read_file({ path: "g.js" }).content.includes("return 2;"));
  ok("loop counted turns", res.turns === 3, "turns=" + res.turns);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n== selftest: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
