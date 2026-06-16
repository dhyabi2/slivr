// run_hint.mjs — anticipate intent (Blocks 9 & 10): when a turn CREATES a runnable/user-facing
// artifact, proov both TELLS the user how to run it AND can actually DEMONSTRATE it (open a web app in
// the browser, run a program in the terminal). A prompt can ask the model to do this; this guarantees
// it — so "make a game / app" never ends with the user holding code they can't see. Zero dependencies.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function read(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }

// Given the workdir and the paths CREATED during the turn, return a launch descriptor or null:
//   { what, cmd, kind, target? }
//   kind: 'open'  → a web page to open in the browser (target = the file)
//         'run'   → a terminal program to run interactively
//         'serve' → a long-running app/server (run it, Ctrl-C to stop)
// Based ONLY on what was created this turn, so an unrelated edit never produces a misleading hint.
export function detectRunHint(dir, createdPaths = []) {
  const created = (createdPaths || []).filter(Boolean);
  if (!created.length) return null;
  const abs = (rel) => path.join(dir, rel);
  const isCreated = (name) => created.find(f => f === name || f.endsWith("/" + name));

  // 1) A NEW Node project (package.json created this turn) with a start/dev script — but if it also
  //    ships a web page, prefer opening that (more "showable").
  const pj = isCreated("package.json");
  if (pj) {
    try {
      const s = (JSON.parse(read(abs(pj)) || "{}").scripts) || {};
      const script = s.dev ? "dev" : s.start ? "start" : Object.keys(s)[0];
      if (script) return { what: "the app", cmd: `npm install && npm run ${script}`, kind: "serve" };
    } catch { /* fall through */ }
  }

  // 2) A web page → open it in a browser
  const html = created.find(f => /\.html?$/.test(f));
  if (html) return { what: "the page", cmd: `open ${html}`, kind: "open", target: html };

  // 3) A Python entry point (prefer one with a __main__ guard)
  const pys = created.filter(f => f.endsWith(".py"));
  const pyMain = pys.find(f => /if\s+__name__\s*==\s*['"]__main__['"]/.test(read(abs(f)))) || pys[0];
  if (pyMain) return { what: "it", cmd: `python3 ${pyMain}`, kind: "run" };

  // 4) Go / Rust / Make / shell — only when created this turn
  if (isCreated("Cargo.toml")) return { what: "it", cmd: "cargo run", kind: "run" };
  const goMain = created.find(f => f.endsWith(".go") && /func\s+main\s*\(/.test(read(abs(f))));
  if (goMain) return { what: "it", cmd: `go run ${goMain}`, kind: "run" };
  const mk = isCreated("Makefile");
  if (mk && /^run\s*:/m.test(read(abs(mk)))) return { what: "it", cmd: "make run", kind: "run" };
  const sh = created.find(f => f.endsWith(".sh"));
  if (sh) return { what: "it", cmd: `sh ${sh}`, kind: "run" };
  const shebang = created.find(f => read(abs(f)).startsWith("#!"));
  if (shebang) return { what: "it", cmd: `./${shebang}`, kind: "run" };

  return null;
}

// One-line hint string (caller colorizes). Returns "" when there's nothing to run.
export function runHintLine(dir, createdPaths = []) {
  const h = detectRunHint(dir, createdPaths);
  return h ? `▶ run ${h.what} with:  ${h.cmd}` : "";
}

// Scan the workdir (and common subfolders) for an EXISTING launchable artifact — used when the user
// says "run it" / "open in browser" so proov can launch what was built in a previous turn. Prefers a
// web page (most "showable"). Returns a launch descriptor or null.
export function findArtifact(dir, { preferWeb = false } = {}) {
  const found = [];
  for (const sub of ["", "public", "dist", "build", "src", "web", "www"]) {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const f of entries) found.push(sub ? `${sub}/${f}` : f);
  }
  if (preferWeb) {
    const html = found.find(f => /(^|\/)index\.html?$/.test(f)) || found.find(f => /\.html?$/.test(f));
    if (html) return { what: "the page", cmd: `open ${html}`, kind: "open", target: html };
  }
  return detectRunHint(dir, found);
}

// Recognize a short "show me the result" request (run / open / play / "run in browser") so proov can
// LAUNCH the artifact itself rather than handing it to the model. Strict so it never hijacks a real
// task: only bare imperatives about a generic result, optionally "in (the) browser". Returns
// { browser } | null. "run the tests", "open src/x.js", etc. do NOT match.
const DEMO_RE = /^(run|open|launch|preview|show|play|start|see|view|demo)( (it|this|me|us|the (app|game|page|site|server|project|result|demo|thing|code)))?( (in|on)( the)? browser)?$/i;
export function isDemonstrateRequest(line) {
  const s = (line || "").trim().replace(/[!.?]+$/, "");
  if (!DEMO_RE.test(s)) return null;
  return { browser: /browser/i.test(s) };
}

// The verb to offer the user, given the launch kind.
export function launchVerb(kind) {
  return kind === "open" ? "open it in your browser" : kind === "serve" ? "start it" : "run it";
}

// The OS command to open a file/URL with the default handler (pure — for testing). macOS `open`,
// Windows `cmd /c start`, Linux `xdg-open`.
export function openCommand(target, platform = process.platform) {
  if (platform === "darwin") return { cmd: "open", args: [target] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", target] };
  return { cmd: "xdg-open", args: [target] };
}

// Open a file/URL with the OS default handler (browser for .html). Non-blocking. Returns true if the
// open command was spawned.
export function osOpen(dir, target) {
  try {
    const { cmd, args } = openCommand(target);
    const child = spawn(cmd, args, { cwd: dir, stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch { return false; }
}
