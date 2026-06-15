// run_hint.mjs — anticipate intent (Block 9): when a turn CREATES a runnable/user-facing artifact,
// deterministically tell the user the exact command to run/see it. A prompt can ASK the model to do
// this; this GUARANTEES it (the model often forgets), so "make a game" never ends with the user
// holding code they don't know how to launch. Zero dependencies.

import fs from "node:fs";
import path from "node:path";

function read(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }

// Given the workdir and the paths CREATED during the turn, return { cmd, what } | null. The hint is
// based ONLY on what was created this turn (not pre-existing files), so an unrelated edit in an
// existing repo never produces a misleading "run it" line. Checks are ordered by how user-facing the
// result is.
export function detectRunHint(dir, createdPaths = []) {
  const created = (createdPaths || []).filter(Boolean);
  if (!created.length) return null;
  const abs = (rel) => path.join(dir, rel);
  const isCreated = (name) => created.find(f => f === name || f.endsWith("/" + name));

  // 1) A NEW Node project (package.json created this turn) with a start/dev script
  const pj = isCreated("package.json");
  if (pj) {
    try {
      const s = (JSON.parse(read(abs(pj)) || "{}").scripts) || {};
      const script = s.dev ? "dev" : s.start ? "start" : Object.keys(s)[0];
      if (script) return { cmd: `npm install && npm run ${script}`, what: "the app" };
    } catch { /* fall through */ }
  }

  // 2) A web page → open it in a browser
  const html = created.find(f => /\.html?$/.test(f));
  if (html) return { cmd: `open ${html}`, what: "the page (in your browser)" };

  // 3) A Python entry point (prefer one with a __main__ guard)
  const pys = created.filter(f => f.endsWith(".py"));
  const pyMain = pys.find(f => /if\s+__name__\s*==\s*['"]__main__['"]/.test(read(abs(f)))) || pys[0];
  if (pyMain) return { cmd: `python3 ${pyMain}`, what: "it" };

  // 4) Go / Rust / Make / shell — only when created this turn
  if (isCreated("Cargo.toml")) return { cmd: "cargo run", what: "it" };
  const goMain = created.find(f => f.endsWith(".go") && /func\s+main\s*\(/.test(read(abs(f))));
  if (goMain) return { cmd: `go run ${goMain}`, what: "it" };
  const mk = isCreated("Makefile");
  if (mk && /^run\s*:/m.test(read(abs(mk)))) return { cmd: "make run", what: "it" };
  const sh = created.find(f => f.endsWith(".sh"));
  if (sh) return { cmd: `sh ${sh}`, what: "it" };
  const shebang = created.find(f => read(abs(f)).startsWith("#!"));
  if (shebang) return { cmd: `./${shebang}`, what: "it" };

  return null;
}

// Format the hint as a one-line string (caller colorizes). Returns "" when there's nothing to run.
export function runHintLine(dir, createdPaths = []) {
  const h = detectRunHint(dir, createdPaths);
  return h ? `▶ run ${h.what} with:  ${h.cmd}` : "";
}
