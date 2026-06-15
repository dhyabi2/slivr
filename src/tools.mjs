// tools.mjs — the agent's tools, operating on a real working directory.
//
// Tools: read_file, list_dir, grep, run_command (sandboxed to workdir), and the two edit
// protocols that distinguish the harnesses:
//   - edit_file   : COMPACT protocol. {anchor, replacement, op} via the vendored SEAL applier.
//                   On failure returns a small structured repair packet (NEVER the whole file).
//   - write_file  : NAIVE protocol. Full-file content replaces the file (Claude-Code-style rewrite).
//
// All paths are resolved INSIDE the workdir; escapes (.. , absolute outside) are rejected.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { applyEdit } from "./seal.mjs";
import { localPdfText } from "./pdftext.mjs";
import { costUSD } from "./provider.mjs";
import { buildSymbolIndex, findSymbol, findReferences, repoOverview, langOf, symbolSpan } from "./repomap.mjs";
import { renderDom, renderShot, visibleText, screenshotWebGL, screenshotWebGLUrl } from "./eye.mjs";
import { detectCommands, describeCommands } from "./project.mjs";
import { detectStyle, styleBrief } from "./style.mjs";
import { playGame, playLevels, autoPlay, extractLevels, autoPlayUrl, extractLevelsUrl } from "./gameharness.mjs";
import { parse as parseLevel, certify as certifyLevel, recheck as recheckLevel } from "./levelcert.mjs";
import { startServer, stopServer, listServers } from "./server.mjs";
import { analyzeStructure, wantsMinimal } from "./structure.mjs";
import { isDestructive } from "./safety.mjs";
import { renderAsset } from "./asset.mjs";
import * as bp from "./blueprint.mjs";
import { resumeSummary, appendJournal } from "./journal.mjs";
import { checkPageJs, pageConsoleErrors, isWebGLPage } from "./webcheck.mjs";
import { compareImages, cropImage, compareRegions, styleProfile, styleAdherence, hexColor, artReview } from "./match.mjs";
import { ARTKIT, ARTKIT3D, NOISE_FBM_SRC } from "./artkit.mjs";
import { orbitScene } from "./scene3d.mjs";
import * as world from "./world.mjs";

// Re-indent a replacement block to a target base indent (strip its own common indent, prepend target).
function reindentBlock(block, indent) {
  const lines = block.split("\n");
  const nonEmpty = lines.filter(l => l.trim());
  const min = nonEmpty.length ? Math.min(...nonEmpty.map(l => (l.match(/^[ \t]*/)[0].length))) : 0;
  return lines.map(l => l.trim() ? indent + l.slice(min) : l).join("\n");
}

export class Tools {
  constructor(workdir, opts = {}) {
    this.workdir = path.resolve(workdir);
    this.opts = opts; // { apiKey, model, baseUrl } — used by the web tools
    // --- plan-mode + task-management state (lives on the Tools instance so both the tool
    //     implementations and the harness gate/UI can read it for the duration of a session) ---
    this.planMode = !!opts.planMode;     // when true, mutating tools are gated until a plan is approved
    this.plan = null;                    // { steps:[...], approved:bool } once the model calls `plan`
    this.tasks = [];                     // [{ id, subject, status }] maintained via task_write
  }

  // plan (slivr): record a numbered list of concrete steps BEFORE mutating the repo. In plan-mode
  // the harness blocks all edits/commands until a plan exists and is approved. Calling plan again
  // REPLACES the steps and resets approval (the harness re-asks). Returns the recorded steps.
  plan_tool({ steps } = {}) {
    let arr = steps;
    if (typeof arr === "string") arr = arr.split("\n").map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(arr) || arr.length === 0) return { ok: false, error: "NO_STEPS", hint: 'Pass steps: ["step 1","step 2", ...]' };
    const clean = arr.map(s => String(s).trim()).filter(Boolean).slice(0, 50);
    if (!clean.length) return { ok: false, error: "NO_STEPS" };
    this.plan = { steps: clean, approved: false, revisions: 0, history: [] };
    return { ok: true, steps: clean, note: "Plan recorded. In plan-mode it must be approved before edits/commands run." };
  }

  // replan (slivr, Block 5): dynamic re-planning. When a step fails or the situation changes, revise
  // the REMAINING steps locally instead of abandoning the plan. Keeps a revision count + history.
  replan_tool({ reason, steps } = {}) {
    if (!this.plan) return { ok: false, error: "NO_PLAN", hint: "Call plan first; replan revises an existing plan." };
    let arr = steps;
    if (typeof arr === "string") arr = arr.split("\n").map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(arr) || !arr.length) return { ok: false, error: "NO_STEPS", hint: 'Pass the revised remaining steps: ["step 1", ...]' };
    const clean = arr.map(s => String(s).trim()).filter(Boolean).slice(0, 50);
    if (!clean.length) return { ok: false, error: "NO_STEPS" };
    const prev = this.plan.steps;
    this.plan = {
      steps: clean,
      approved: this.plan.approved,   // keep approval — this is adapting an already-running plan
      revisions: (this.plan.revisions || 0) + 1,
      history: [...(this.plan.history || []), { reason: String(reason || "").slice(0, 300), replaced: prev }],
    };
    return { ok: true, steps: clean, revisions: this.plan.revisions, note: "Plan revised." };
  }

  // task_write (slivr): replace/update the live task checklist. tasks = [{id?, subject, status}],
  // status ∈ pending|in_progress|completed. Items WITH a matching id update in place; items without
  // an id (or a new id) are appended/created. Keep exactly one task in_progress at a time.
  task_write({ tasks } = {}) {
    if (!Array.isArray(tasks)) return { ok: false, error: "NO_TASKS", hint: 'Pass tasks: [{subject, status}]' };
    const VALID = new Set(["pending", "in_progress", "completed"]);
    const byId = new Map(this.tasks.map(t => [t.id, t]));
    let nextId = this.tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
    const order = [];
    const seen = new Set();
    for (const raw of tasks) {
      if (!raw || typeof raw !== "object") continue;
      const subject = String(raw.subject ?? "").trim();
      let status = String(raw.status ?? "pending").trim();
      if (!VALID.has(status)) status = "pending";
      let id = raw.id != null ? String(raw.id) : null;
      if (id && byId.has(id)) {
        const ex = byId.get(id);
        if (subject) ex.subject = subject;
        ex.status = status;
        if (!seen.has(id)) { order.push(ex); seen.add(id); }
      } else {
        if (!subject) continue;
        id = id || String(++nextId);
        const t = { id, subject, status };
        byId.set(id, t);
        if (!seen.has(id)) { order.push(t); seen.add(id); }
      }
    }
    // task_write replaces the list with exactly what was passed (in the given order).
    this.tasks = order;
    return { ok: true, tasks: this.tasks.map(t => ({ ...t })) };
  }

  // Visual richness of a game's CANVAS (not the surrounding page) — captures the canvas via toDataURL
  // (works for 2D + WebGL), then rates it. Used by the done-gate to catch flat "boxes" art. null = couldn't.
  _gameArtRichness(rel) {
    try {
      const abs = this._resolve(rel);
      const cap = path.join(os.tmpdir(), `slivr-gameart-${process.pid}-${Date.now()}.png`);
      const shot = screenshotWebGL(abs, cap);
      if (!shot.ok) { try { fs.unlinkSync(cap); } catch { /* */ } return null; }
      const a = artReview(cap);
      try { fs.unlinkSync(cap); } catch { /* */ }
      return a.ok ? a.richness : null;
    } catch { return null; }
  }

  // Capture a game's CANVAS (2D + WebGL, via toDataURL) as a base64 PNG data-url, for a vision judge to
  // critique fidelity-to-request. Returns "data:image/png;base64,…" or null if it couldn't render.
  _gameCanvasDataURL(rel) {
    try {
      const abs = this._resolve(rel);
      const cap = path.join(os.tmpdir(), `slivr-gameshot-${process.pid}-${Date.now()}.png`);
      const shot = screenshotWebGL(abs, cap);
      if (!shot.ok) { try { fs.unlinkSync(cap); } catch { /* */ } return null; }
      const b64 = fs.readFileSync(cap).toString("base64");
      try { fs.unlinkSync(cap); } catch { /* */ }
      return b64 ? "data:image/png;base64," + b64 : null;
    } catch { return null; }
  }

  // Normalize one level into an array of row-strings (accepts ["..."], {rows:[...]}, or {grid:[["#"...]]}).
  _levelRows(lvl) {
    if (Array.isArray(lvl) && lvl.every((r) => typeof r === "string")) return lvl;
    if (lvl && Array.isArray(lvl.rows) && lvl.rows.every((r) => typeof r === "string")) return lvl.rows;
    if (lvl && Array.isArray(lvl.grid)) return lvl.grid.map((r) => (Array.isArray(r) ? r.join("") : String(r)));
    return null;
  }

  // PROVE a discrete lock-and-key level is solvable AND soft-lock-free (no key spent into an unwinnable
  // state) — ESG-CoReach co-reachability certificate. Tiles: # wall, S spawn, G goal, . floor, k key,
  // D door. Pass {rows:[...]} for one level or {levels:[[...],[...]]} for many. Catches the soft-locks
  // that "a path exists" / "I played it once" miss. Returns per-level verdicts + an independent re-check.
  certify_level({ rows, levels } = {}) {
    const list = levels != null ? levels : (rows != null ? [rows] : null);
    if (!Array.isArray(list) || !list.length) return { ok: false, error: "NO_LEVEL", hint: 'pass {rows:["#S.G#",...]} or {levels:[rows,...]}; tiles: # wall, S spawn, G goal, k key, D door' };
    const results = [];
    for (let i = 0; i < list.length; i++) {
      const r = this._levelRows(list[i]);
      if (!r) { results.push({ index: i, ok: false, error: "BAD_ROWS" }); continue; }
      try {
        const L = parseLevel(r);
        if (!L.spawn || !L.goal) { results.push({ index: i, ok: false, error: "NO_SPAWN_OR_GOAL", hint: "every level needs an S and a G" }); continue; }
        const c = certifyLevel(L);
        results.push({ index: i, ok: c.ok, solvable: c.solvable, nStates: c.nStates, nSoftlock: c.nSoftlock, softlockExample: c.softlockExample, reverified: recheckLevel(c.witness).verified });
      } catch (e) { results.push({ index: i, ok: false, error: String(e && e.message || e) }); }
    }
    const bad = results.filter((r) => !r.ok);
    return { ok: bad.length === 0, levels: results.length, certified: results.length - bad.length, failures: bad, results };
  }

  // GATE helper: a game can expose window.slivrLevels (array of row-string levels). If it does, certify
  // each; returns { checked, failures:[{index,reason}] } or null when the game doesn't expose levels (→
  // never blocks games that don't opt in). Reads the page via the harness (browser); errors → null.
  _certifyGameLevels(rel) {
    try {
      const abs = this._resolve(rel);
      const levels = extractLevels(abs);
      if (!Array.isArray(levels) || !levels.length) return null;
      const cert = this.certify_level({ levels });
      const failures = cert.results.filter((r) => !r.ok).map((r) => ({
        index: r.index,
        reason: r.error ? r.error : (!r.solvable ? "UNSOLVABLE (the goal can't be reached at all)" : `SOFT-LOCK (${r.nSoftlock} states can never reach the goal — a wasted key/door)`),
      }));
      return { checked: cert.levels, failures };
    } catch { return null; }
  }

  _resolve(rel) {
    if (typeof rel !== "string" || !rel) throw new Error("a 'path' string argument is required (you passed none)");
    const abs = path.resolve(this.workdir, rel);
    const wd = this.workdir.endsWith(path.sep) ? this.workdir : this.workdir + path.sep;
    if (abs !== this.workdir && !abs.startsWith(wd)) {
      throw new Error(`SANDBOX_VIOLATION: ${rel} escapes workdir`);
    }
    return abs;
  }

  read_file({ path: rel }) {
    const abs = this._resolve(rel);
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    const content = fs.readFileSync(abs, "utf8");
    return { ok: true, path: rel, content, lines: content.split("\n").length };
  }

  list_dir({ path: rel = "." } = {}) {
    const abs = this._resolve(rel);
    if (!fs.existsSync(abs)) return { ok: false, error: "DIR_NOT_FOUND", path: rel };
    const out = [];
    const walk = (dir, prefix) => {
      for (const name of fs.readdirSync(dir).sort()) {
        if (name === "node_modules" || name === ".git") continue;
        const full = path.join(dir, name);
        const r = path.join(prefix, name);
        if (fs.statSync(full).isDirectory()) { out.push(r + "/"); walk(full, r); }
        else out.push(r);
      }
    };
    walk(abs, rel === "." ? "" : rel);
    return { ok: true, entries: out };
  }

  grep({ pattern, path: rel = "." }) {
    const abs = this._resolve(rel);
    let re;
    try { re = new RegExp(pattern); } catch { return { ok: false, error: "BAD_REGEX" }; }
    const hits = [];
    const scan = (file, relpath) => {
      const text = fs.readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (re.test(line)) hits.push({ file: relpath, line: i + 1, text: line.trim().slice(0, 200) });
      });
    };
    const walk = (dir, prefix) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === "node_modules" || name === ".git") continue;
        const full = path.join(dir, name);
        const r = path.join(prefix, name);
        if (fs.statSync(full).isDirectory()) walk(full, r);
        else { try { scan(full, r); } catch { /* binary/unreadable */ } }
      }
    };
    if (fs.statSync(abs).isDirectory()) walk(abs, rel === "." ? "" : rel);
    else scan(abs, rel);
    return { ok: true, hits: hits.slice(0, 100) };
  }

  // Sandboxed shell: runs inside workdir, short timeout, no network assumptions.
  run_command({ command }) {
    try {
      const out = execSync(command, {
        cwd: this.workdir, timeout: 20000, encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash",
      });
      return { ok: true, stdout: out.slice(-4000), exitCode: 0 };
    } catch (e) {
      return {
        ok: false,
        stdout: (e.stdout || "").toString().slice(-2000),
        stderr: (e.stderr || e.message || "").toString().slice(-2000),
        exitCode: e.status ?? 1,
      };
    }
  }

  // Detect the package manager from a lockfile (default npm).
  _detectPackageManager() {
    try { if (fs.existsSync(this._resolve("pnpm-lock.yaml"))) return "pnpm"; } catch { /* */ }
    try { if (fs.existsSync(this._resolve("yarn.lock"))) return "yarn"; } catch { /* */ }
    return "npm";
  }

  // Build the install command. --ignore-scripts by DEFAULT (a dependency's install/postinstall script is
  // arbitrary code execution); allowScripts:true opts back in (needed for native/build-step packages).
  _installCommand(mgr, { allowScripts = false, args = "" } = {}) {
    const ig = allowScripts ? "" : " --ignore-scripts";
    const extra = args ? " " + args : "";
    if (mgr === "pnpm") return `pnpm install${ig}${extra}`;
    if (mgr === "yarn") return `yarn install${ig}${extra}`;
    return `npm install${ig}${extra}`;
  }

  // Install a Node app's dependencies (approval-gated — runs npm/pnpm/yarn, which may execute install
  // scripts). --ignore-scripts unless allowScripts:true. Longer timeout than run_command (installs are slow).
  install_deps({ manager, allowScripts = false, timeoutMs = 180000, args } = {}) {
    let pkg; try { pkg = this._resolve("package.json"); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(pkg)) return { ok: false, error: "NO_PACKAGE_JSON", hint: "create a package.json with your dependencies first, then install_deps" };
    const mgr = manager || this._detectPackageManager();
    const command = this._installCommand(mgr, { allowScripts, args });
    try {
      const out = execSync(command, { cwd: this.workdir, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash" });
      return { ok: true, manager: mgr, command, stdout: out.slice(-3000) };
    } catch (e) {
      return { ok: false, manager: mgr, command, stderr: (e.stderr || e.message || "").toString().slice(-3000), exitCode: e.status ?? 1, hint: allowScripts ? undefined : "if a dependency needs its build/install scripts, retry install_deps with allowScripts:true" };
    }
  }

  // The command that STARTS this project's server, or null. Prefers a direct `node <entry>` for an entry
  // file that clearly listens; falls back to an npm start/dev script. Used to verify a SERVED game.
  _serverStartCommand() {
    for (const f of ["server.js", "app.js", "index.js", "main.js", "src/server.js", "src/index.js", "src/app.js"]) {
      try {
        const abs = this._resolve(f);
        if (fs.existsSync(abs) && /\.listen\s*\(|createServer|express\s*\(|new\s+Koa|Fastify|process\.env\.PORT/.test(fs.readFileSync(abs, "utf8"))) return `node ${f}`;
      } catch { /* */ }
    }
    try {
      const s = (JSON.parse(fs.readFileSync(this._resolve("package.json"), "utf8")).scripts) || {};
      if (s.start) return "npm start";
      if (s.dev) return "npm run dev";
    } catch { /* */ }
    return null;
  }

  // Canvas richness of a SERVED game (over HTTP via the injecting proxy) — the served analog of
  // _gameArtRichness. null = couldn't capture (no browser / blank).
  async _servedCanvasRichness(url) {
    const cap = path.join(os.tmpdir(), `slivr-servedart-${process.pid}-${Date.now()}.png`);
    try {
      const shot = await screenshotWebGLUrl(url, cap);
      if (!shot.ok) { try { fs.unlinkSync(cap); } catch { /* */ } return null; }
      const a = artReview(cap);
      try { fs.unlinkSync(cap); } catch { /* */ }
      return a.ok ? a.richness : null;
    } catch { try { fs.unlinkSync(cap); } catch { /* */ } return null; }
  }

  // DONE-GATE helper for SERVED games (Blocks 41–42): when there's no static game file but the project
  // serves one, start the server (or reuse a running one), fetch the entry HTML, and verify it over HTTP at
  // FULL parity with the static gate — broken (see_page {url}), FROZEN (autoplay over HTTP), flat-boxes art
  // (canvas capture over HTTP), structure contract, and lock-and-key solvability (window.slivrLevels over
  // HTTP). All HTTP-harness checks degrade gracefully (no browser → skipped). Returns { ran, problem }.
  async _verifyServedGame({ task } = {}) {
    let url = null, startedPid = null;
    const running = listServers();
    if (running.length) url = running[0].url;
    else {
      const cmd = this._serverStartCommand();
      if (!cmd) return { ran: false };
      const s = await startServer({ command: cmd, cwd: this.workdir, readyTimeoutMs: 12000 });
      if (!s.ok) return { ran: false };
      url = s.url; startedPid = s.pid;
    }
    try {
      const res = await this.http_request({ url, timeoutMs: 8000 });
      const html = res && res.ok ? res.body : "";
      const isGame = /<canvas/i.test(html) && /(requestAnimationFrame|slivrSim|getContext\s*\()/i.test(html);
      if (!html || !isGame) return { ran: false };
      const sp = this.see_page({ url });
      if (sp && sp.broken) return { ran: true, problem: `the served page at ${url} is BROKEN: ${(sp.errors || []).slice(0, 3).join("; ")}` };
      if (!wantsMinimal(task)) {
        // FROZEN — drive it with real input over HTTP
        try {
          const ap = await autoPlayUrl(url, { keys: ["ArrowRight", "ArrowUp", "Space"], holdMs: 400 });
          if (ap && ap.ok && ap.responds === false) return { ran: true, problem: `the served game is FROZEN — it does NOT respond to real keyboard/click input (only ${ap.maxChange}% screen change). It isn't actually playable.` };
        } catch { /* no browser → skip */ }
        // FLAT-BOXES art — capture the served canvas over HTTP and rate it
        try {
          const rich = await this._servedCanvasRichness(url);
          if (rich != null && rich < 18) return { ran: true, problem: `the served game's ART is flat PROGRAMMER ART (canvas richness ${rich}/100) — coloured boxes, not a real themed game.` };
        } catch { /* skip */ }
        // STRUCTURE contract on the served HTML
        const st = analyzeStructure(html, task);
        if (!st.pass) {
          const punch = st.missing.slice(0, 9).map((m) => "  ✗ " + m.label + (m.anti ? " (placeholder / wrong primitive)" : "")).join("\n");
          return { ran: true, problem: `the SERVED game's STRUCTURE is only ~${st.requiredScore}% of a production game — ${st.zeroCategories.length} whole layer${st.zeroCategories.length === 1 ? "" : "s"} missing (${st.zeroCategories.join(", ") || "—"}):\n${punch}` };
        }
        // LOCK-AND-KEY solvability — certify window.slivrLevels exposed over HTTP
        try {
          const levels = await extractLevelsUrl(url);
          if (Array.isArray(levels) && levels.length) {
            const cert = this.certify_level({ levels });
            const fails = cert.results.filter((r) => !r.ok);
            if (fails.length) return { ran: true, problem: `${fails.length} of ${cert.levels} served level${cert.levels === 1 ? "" : "s"} can permanently STRAND the player (soft-lock / unsolvable). Fix the key/door economy.` };
          }
        } catch { /* skip */ }
      }
      return { ran: true, problem: null };
    } finally {
      if (startedPid) stopServer(startedPid);
    }
  }

  // Run a generated app as a LONG-LIVED SERVER (Node or anything that listens on $PORT) and hand back its
  // URL — the thing run_command (execSync, blocks until exit) can't do. Spawns the command, injects a free
  // PORT, waits for the port to listen, returns { ok, url, pid, port }. Same destructive-command guard as
  // run_command. The server is tracked + killed on stop_server / process exit (no orphaned ports).
  async start_server({ command, port, readyTimeoutMs } = {}) {
    if (typeof command !== "string" || !command.trim()) return { ok: false, error: "NO_COMMAND", hint: 'pass the command to start the server, e.g. {"tool":"start_server","args":{"command":"node server.js"}} — your server must listen on process.env.PORT.' };
    const block = isDestructive(command);
    if (block.blocked) return { ok: false, error: "BLOCKED", why: block.why, rule: block.rule };
    const res = await startServer({ command, cwd: this.workdir, port, readyTimeoutMs });
    if (res.ok) { this._servers = this._servers || new Set(); this._servers.add(res.pid); }
    return res;
  }

  // Stop a server started with start_server (its whole process group). No pid → stop them all.
  stop_server({ pid } = {}) {
    if (pid == null) { const all = listServers(); for (const s of all) stopServer(s.pid); if (this._servers) this._servers.clear(); return { ok: true, stopped: all.map((s) => s.pid) }; }
    stopServer(pid); this._servers && this._servers.delete(pid);
    return { ok: true, stopped: pid };
  }

  // Hit an HTTP endpoint and report the result — verify a running server's ROUTES (status/body/json), the
  // server-side analog of see_page. { url, method, headers, body, timeoutMs }. Body is truncated.
  async http_request({ url, method = "GET", headers, body, timeoutMs = 10000 } = {}) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return { ok: false, error: "NO_URL", hint: 'pass a full url, e.g. {"tool":"http_request","args":{"url":"http://localhost:3000/api/health"}}' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { /* not json */ }
      const hdrs = {}; for (const [k, v] of r.headers) hdrs[k] = v;
      return { ok: r.ok, status: r.status, statusText: r.statusText, contentType: hdrs["content-type"] || "", headers: hdrs, body: text.slice(0, 4000), json };
    } catch (e) {
      return { ok: false, error: e.name === "AbortError" ? `request timed out after ${Math.round(timeoutMs / 1000)}s` : String(e.message || e) };
    } finally { clearTimeout(timer); }
  }

  // COMPACT edit protocol (slivr). Returns structured repair packet on failure.
  edit_file({ path: rel, anchor, replacement, op = "replace", occurrence }) {
    if (typeof rel !== "string" || !rel) return { ok: false, error: "NO_PATH", hint: 'edit_file needs a "path" (string), an "anchor" (a small VERBATIM snippet copied from the file to locate the edit), and a "replacement". Example: {"tool":"edit_file","args":{"path":"index.html","anchor":"<old lines>","replacement":"<new lines>"}}' };
    if (typeof anchor !== "string" || !anchor) return { ok: false, error: "NO_ANCHOR", path: rel, hint: 'edit_file needs an "anchor": a small verbatim snippet copied character-for-character from the file at the spot to change. To create a NEW file use create_file instead.' };
    if (replacement == null) return { ok: false, error: "NO_REPLACEMENT", path: rel, hint: 'pass "replacement": the new text to put in place of the anchor (use "" to delete the anchor).' };
    const abs = this._resolve(rel);
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    const content = fs.readFileSync(abs, "utf8");
    const res = applyEdit(content, { anchor, replacement, op, occurrence });
    if (!res.ok) return { ok: false, repair: res.repair };
    fs.writeFileSync(abs, res.content);
    return { ok: true, tier: res.tier, path: rel };
  }

  // create_file (slivr): write a NEW file. Refuses to overwrite an existing one — for changes to
  // existing files the compact edit_file protocol must be used. This is NOT a full-rewrite escape
  // hatch; it only covers the legitimate "no anchor exists yet" case (creating a file).
  create_file({ path: rel, content }) {
    const abs = this._resolve(rel);
    if (fs.existsSync(abs)) return { ok: false, error: "FILE_EXISTS", path: rel, hint: "Use edit_file to modify an existing file." };
    const body = content == null ? "" : String(content);   // a missing/null content must NOT crash the turn
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return { ok: true, path: rel, bytes: Buffer.byteLength(body) };
  }

  // NAIVE edit protocol (baseline). Full-file overwrite.
  write_file({ path: rel, content }) {
    const abs = this._resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { ok: true, path: rel, bytes: Buffer.byteLength(content) };
  }

  // edit_files (slivr): apply MANY compact edits ATOMICALLY (all-or-nothing) — fewer turns for
  // multi-file/multi-edit changes. edits = [{path, anchor, replacement, op}]. Edits to the same
  // file apply IN ORDER on the evolving buffer. If ANY edit fails to apply uniquely, NOTHING is
  // written and per-edit repair packets are returned (so the model fixes and resends all edits).
  edit_files({ edits }) {
    if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: "NO_EDITS", hint: "Pass edits: [{path, anchor, replacement, op}]" };
    const buffers = new Map();          // rel -> working content
    const failures = [], applied = [];
    edits.forEach((e, i) => {
      const rel = e && e.path;
      let abs;
      try { abs = this._resolve(rel); } catch (err) { failures.push({ index: i, path: rel, error: err.message }); return; }
      if (!buffers.has(rel)) {
        if (!fs.existsSync(abs)) { failures.push({ index: i, path: rel, error: "FILE_NOT_FOUND" }); return; }
        buffers.set(rel, fs.readFileSync(abs, "utf8"));
      }
      const res = applyEdit(buffers.get(rel), { anchor: e.anchor, replacement: e.replacement, op: e.op || "replace", occurrence: e.occurrence });
      if (!res.ok) { failures.push({ index: i, path: rel, repair: res.repair }); return; }
      buffers.set(rel, res.content);
      applied.push({ index: i, path: rel, tier: res.tier });
    });
    if (failures.length) return { ok: false, error: "ATOMIC_ABORT", failures, note: "No files were written — fix the failing edits and resend ALL edits in one edit_files call." };
    for (const [rel, content] of buffers) fs.writeFileSync(this._resolve(rel), content);
    return { ok: true, applied, files: [...buffers.keys()] };
  }

  // --- git: read tools + a GUARDED commit. Never pushes (push/force is also hard-blocked upstream).
  _git(argv) {
    try { const out = execFileSync("git", argv, { cwd: this.workdir, timeout: 15000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return { ok: true, out: (out || "").slice(-4000) }; }
    catch (e) { return { ok: false, error: ((e.stderr || e.message || "") + "").slice(-1000) }; }
  }
  git_status() { const r = this._git(["status", "--porcelain=v1", "-b"]); return r.ok ? { ok: true, status: r.out || "(clean)" } : r; }
  git_diff({ path: rel = "", staged = false } = {}) { const a = ["diff"]; if (staged) a.push("--staged"); if (rel) a.push("--", rel); const r = this._git(a); return r.ok ? { ok: true, diff: r.out || "(no changes)" } : r; }
  git_log({ n = 10 } = {}) { const r = this._git(["log", "--oneline", "-n", String(Math.max(1, Math.min(50, (n | 0) || 10)))]); return r.ok ? { ok: true, log: r.out } : r; }
  git_commit({ message }) {
    if (!message || !String(message).trim()) return { ok: false, error: "NO_MESSAGE", hint: "Pass a commit message." };
    const add = this._git(["add", "-A"]); if (!add.ok) return add;
    const r = this._git(["commit", "-m", String(message).slice(0, 500)]);   // args array -> no shell injection; never pushes
    return r.ok ? { ok: true, committed: r.out } : r;
  }

  // --- gap-closers: file discovery + web access ---

  // glob: fast filename matching by pattern (** = any dirs, * = within a segment, ? = one char).
  glob({ pattern }) {
    if (!pattern) return { ok: false, error: "NO_PATTERN", hint: 'e.g. "src/**/*.js"' };
    const esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const rx = "^" + esc
      .replace(/\*\*\//g, "@@DIRS@@").replace(/\*\*/g, "@@ANY@@")
      .replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
      .replace(/@@DIRS@@/g, "(?:[^/]+/)*").replace(/@@ANY@@/g, ".*") + "$";
    let re; try { re = new RegExp(rx); } catch { return { ok: false, error: "BAD_PATTERN" }; }
    const out = [];
    const walk = (dir, prefix) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === "node_modules" || name === ".git") continue;
        const full = path.join(dir, name), r = prefix ? prefix + "/" + name : name;
        if (fs.statSync(full).isDirectory()) walk(full, r);
        else if (re.test(r)) out.push(r);
      }
    };
    walk(this.workdir, "");
    return { ok: true, matches: out.slice(0, 300) };
  }

  // --- repo symbol index (Block 3) -------------------------------------------
  // Lazily build + cache a zero-dependency symbol index over the workdir.
  _index() {
    if (!this._symbolIndex) this._symbolIndex = buildSymbolIndex(this.workdir);
    return this._symbolIndex;
  }

  // repo_map: shallow global map — files and their top-level symbols. Cheaper than reading files to
  // orient in an unfamiliar repo.
  repo_map() {
    const idx = this._index();
    const st = idx.stats || {};
    return {
      ok: true, files: idx.files.length, symbols: idx.symbols.length, indexedFiles: st.total,
      note: `whole-repo memory: ${idx.symbols.length} symbols across ${st.total ?? idx.allFiles.length} files (persistent + incremental: ${st.reused ?? 0} reused / ${st.parsed ?? 0} re-parsed this build). Query it free with find_symbol / find_refs.`,
      map: repoOverview(idx),
    };
  }

  // project_info (gap #1): auto-detect how to TEST / RUN / BUILD this project (any ecosystem) so you
  // can verify your change or run it WITHOUT being told the command. Pure manifest inspection, no cost.
  project_info() {
    const d = detectCommands(this.workdir);
    return { ok: true, ecosystem: d.ecosystem, test: d.test?.cmd || null, run: d.run?.cmd || null, build: d.build?.cmd || null, evidence: d.evidence, note: describeCommands(d) };
  }

  // house_style (Block 14): detect the repo's coding conventions (indent / quotes / semicolons /
  // naming) from its config + existing files, so new/edited code MATCHES the house style. Zero cost.
  house_style() {
    const s = detectStyle(this.workdir);
    return { ok: true, brief: styleBrief(s) || "(no strong convention detected)", indent: s.indent, quote: s.quote?.value || null, semicolons: s.semi?.value ?? null, naming: s.naming?.value || null, basis: s.basis };
  }

  // find_symbol: jump straight to a definition (file:line + signature) instead of grepping through
  // every mention. Falls back to case-insensitive / substring matching for slightly-wrong names.
  find_symbol({ name }) {
    if (!name) return { ok: false, error: "NO_NAME", hint: 'pass {"name":"functionOrClassName"}' };
    const hits = findSymbol(this._index(), name);
    if (!hits.length) return { ok: true, name, matches: [], note: `no symbol named "${name}" found — try repo_map or grep` };
    return { ok: true, name, matches: hits.slice(0, 25).map(s => ({ file: s.file, line: s.line, kind: s.kind, signature: s.signature })) };
  }

  // find_refs: who USES this symbol (call-sites / references), excluding its definition. Run this
  // before changing a signature so you can update every caller.
  find_refs({ name } = {}) {
    if (!name) return { ok: false, error: "NO_NAME", hint: 'pass {"name":"functionOrClassName"}' };
    const refs = findReferences(this._index(), name);
    const calls = refs.filter(r => r.isCall).length;
    return { ok: true, name, count: refs.length, calls, references: refs.slice(0, 100) };
  }

  // Shared, READ-ONLY resolver for edit_symbol: find the unique definition, detect its span, and
  // compute before/after. Returns {ok:false,error} on any uncertainty (CORRECTNESS-FIRST). No writes.
  _resolveSymbolEdit({ name, replacement, file } = {}) {
    if (!name) return { ok: false, error: "NO_NAME", hint: 'pass {"name":"...","replacement":"<new full definition>"}' };
    if (replacement == null) return { ok: false, error: "NO_REPLACEMENT", hint: "pass the new full definition as `replacement`" };
    const idx = this._index();
    let defs = (idx.byName.get(name) || []).filter(s => ["function", "class", "method"].includes(s.kind));
    if (file) defs = defs.filter(s => s.file === file || s.file.endsWith("/" + file));
    if (!defs.length) return { ok: false, error: "NOT_FOUND", hint: "no function/class/method by that name — use find_symbol then edit_file" };
    if (defs.length > 1) return { ok: false, error: "AMBIGUOUS", occurrences: defs.map(d => `${d.file}:${d.line}`), hint: "pass `file` to disambiguate, or use edit_file" };
    const def = defs[0];
    let abs; try { abs = this._resolve(def.file); } catch (e) { return { ok: false, error: e.message }; }
    let before; try { before = fs.readFileSync(abs, "utf8"); } catch { return { ok: false, error: "READ_FAILED", path: def.file }; }
    const span = symbolSpan(before, langOf(def.file), def.line);
    if (!span) return { ok: false, error: "SPAN_UNCERTAIN", hint: "could not determine the symbol's exact span — use edit_file with an anchor" };
    const lines = before.split("\n");
    const indent = (lines[span.start].match(/^[ \t]*/) || [""])[0];
    const repl = reindentBlock(String(replacement), indent);
    const after = [...lines.slice(0, span.start), ...repl.split("\n"), ...lines.slice(span.end + 1)].join("\n");
    return { ok: true, rel: def.file, abs, before, after, range: [span.start + 1, span.end + 1], replacedLines: span.end - span.start + 1 };
  }

  // edit_symbol (Block 7): replace a whole function/class/method by NAME — the model sends only the
  // NEW definition, never the old body as an anchor (big output-token savings on large functions).
  edit_symbol(a = {}) {
    const r = this._resolveSymbolEdit(a);
    if (!r.ok) return r;
    fs.writeFileSync(r.abs, r.after);
    this._symbolIndex = null;  // definitions changed → invalidate the cached index
    return { ok: true, tier: "symbol", file: r.rel, path: r.rel, range: r.range, replacedLines: r.replacedLines };
  }

  // READ-ONLY preview (before/after) for the approval gate — does not write.
  previewSymbolEdit(a = {}) {
    const r = this._resolveSymbolEdit(a);
    return r.ok ? { ok: true, path: r.rel, before: r.before, after: r.after, range: r.range } : r;
  }

  // web_fetch: GET a URL and return readable text (scripts/styles/tags stripped).
  async web_fetch({ url, max = 8000 }) {
    if (!/^https?:\/\//i.test(url || "")) return { ok: false, error: "BAD_URL", hint: "Pass a full http(s) URL." };
    try {
      const r = await fetch(url, { headers: { "User-Agent": "slivr/0.1" }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, url };
      let text = await r.text();
      text = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/&(nbsp|amp|lt|gt|quot|#39);/g, " ").replace(/\s+/g, " ").trim();
      return { ok: true, url, text: text.slice(0, max) };
    } catch (e) { return { ok: false, error: String(e.message || e), url }; }
  }

  // --- multimodal: let the model SEE images / READ pdfs ---
  // view_image / view_pdf only READ + validate the file here and return a small marker; the LOOP
  // detects { multimodal: ... } in the result and pushes a user message whose `content` is an
  // ARRAY of blocks (text + image_url / file) so the model actually receives the bytes.
  view_image({ path: rel } = {}) {
    if (!rel) return { ok: false, error: "NO_PATH", hint: "Pass path: rel/to/image.png" };
    let abs; try { abs = this._resolve(rel); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    const ext = path.extname(abs).slice(1).toLowerCase();
    const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
    const mime = MIME[ext];
    if (!mime) return { ok: false, error: "UNSUPPORTED_IMAGE", ext, hint: "png/jpg/jpeg/gif/webp/bmp" };
    let b64; try { b64 = fs.readFileSync(abs).toString("base64"); } catch (e) { return { ok: false, error: String(e.message || e) }; }
    const bytes = Buffer.byteLength(b64, "utf8");
    // marker the loop turns into an image block; result stays small in the trace.
    return { ok: true, path: rel, multimodal: { kind: "image", path: rel, mime, dataUrl: `data:${mime};base64,${b64}` }, note: `image loaded (${ext}, ~${Math.round((bytes * 3) / 4)} bytes); shown to the model` };
  }

  // see_page (Block 11): the agent's EYE on a web page it built. Renders the HTML headlessly with the
  // system browser. DEFAULT is text-first + cheap: returns the post-JS RENDERED visible text (catches a
  // literal "\n" on screen, a blank page, wrong text) with no vision-token cost. Pass visual:true for a
  // SCREENSHOT (attached to the model) when you need to judge layout/visual appearance.
  see_page({ path: rel, url, visual } = {}) {
    // SERVED PAGE: a running Node app (start_server) is checked over http://localhost:PORT, not file://.
    // The static JS-syntax / file checks don't apply to a served route, so this renders the URL and
    // reports the post-JS visible text (or a screenshot with visual:true) + a blank-page check.
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      if (visual) {
        const out = path.join(os.tmpdir(), `slivr-shot-${process.pid}-${Date.now()}.png`);
        const r = renderShot(url, out);
        if (!r.ok) return { ok: false, error: r.error, hint: "couldn't screenshot the URL — is the server running? try see_page (text mode) or http_request" };
        let b64; try { b64 = fs.readFileSync(out).toString("base64"); } catch (e) { return { ok: false, error: String(e.message || e) }; }
        try { fs.unlinkSync(out); } catch { /* */ }
        return { ok: true, url, multimodal: { kind: "image", path: `${url} (rendered)`, mime: "image/png", dataUrl: `data:image/png;base64,${b64}` }, note: `rendered ${url} (${r.browser}) — screenshot shown to you` };
      }
      const d = renderDom(url);
      if (!d.ok) return { ok: false, error: d.error, hint: "couldn't load the URL — is the server up? (start_server returns the url + port)" };
      const text = visibleText(d.dom);
      if (!text) return { ok: true, url, rendered: "", blank: true, note: `${url} loaded but rendered BLANK (no visible text). Check the server actually returns content for this route (http_request {url}) and the client script runs.` };
      return { ok: true, url, rendered: text.slice(0, 4000), note: `served page at ${url} — VISIBLE rendered text (post-JS). For layout call see_page {url, visual:true}; for API routes use http_request.` };
    }
    if (!rel) return { ok: false, error: "NO_PATH", hint: 'pass {"path":"index.html"} for a file, or {"url":"http://localhost:PORT"} for a running server (visual:true for a screenshot)' };
    let abs; try { abs = this._resolve(rel); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    if (visual) {
      const out = path.join(os.tmpdir(), `slivr-shot-${process.pid}-${Date.now()}.png`);
      let isGL = false; try { isGL = isWebGLPage(fs.readFileSync(abs, "utf8")); } catch { /* */ }
      const r = isGL ? screenshotWebGL(abs, out) : renderShot(abs, out);
      if (!r.ok) return { ok: false, error: r.error, hint: "couldn't get a visual — use see_page (text mode) or reason about the code" };
      let b64; try { b64 = fs.readFileSync(out).toString("base64"); } catch (e) { return { ok: false, error: String(e.message || e) }; }
      try { fs.unlinkSync(out); } catch { /* ignore */ }
      return { ok: true, path: rel, multimodal: { kind: "image", path: `${rel} (rendered)`, mime: "image/png", dataUrl: `data:image/png;base64,${b64}` }, note: `rendered ${rel} (${r.browser}) — screenshot shown to you` };
    }
    // CATCH BROKEN PAGES (Block 27): static JS syntax check + runtime console-error capture. A SyntaxError
    // leaves the DOM intact (so it "looks fine") but nothing runs → blank page. Surface these FIRST.
    const jsErrors = [];
    try { const jc = checkPageJs(abs, (s) => this._resolve(path.join(path.dirname(rel), s))); for (const e of jc.errors) jsErrors.push(`${e.where}: ${e.message}`); } catch { /* */ }
    let consoleErrors = [], canvasBlank = null;
    // WebGL/Three.js pages must be checked on the GPU path (else WebGL fails to init in headless and
    // reports a BOGUS context error while hiding the REAL runtime error, e.g. an undefined-var TypeError).
    try { const ce = pageConsoleErrors(abs); consoleErrors = ce.errors || []; canvasBlank = ce.blank; } catch { /* */ }
    const allErrors = [...jsErrors.map((e) => "JS SYNTAX — " + e), ...consoleErrors.map((e) => "CONSOLE — " + e)];

    const d = renderDom(abs);
    if (!d.ok) return { ok: false, error: d.error, hint: "couldn't render the page — install Chrome, or reason about the code directly" };
    const text = visibleText(d.dom);
    if (allErrors.length) {
      return { ok: true, path: rel, errors: allErrors, broken: true, rendered: text.slice(0, 2000),
        note: `THIS PAGE IS BROKEN — ${allErrors.length} error(s) found; the script never ran (that's why it looks blank):\n- ${allErrors.slice(0, 8).join("\n- ")}\nFIX these (open the file:line and correct the syntax), then see_page again. Do NOT declare done while errors remain.` };
    }
    // A canvas/WebGL game with NO error but a blank canvas is still broken (drew nothing / wrong camera).
    if (canvasBlank === true) {
      return { ok: true, path: rel, broken: true, blank: true, rendered: text.slice(0, 500),
        note: "THIS PAGE IS BROKEN — the canvas rendered BLANK (one flat colour, nothing drawn) even though no JS error fired. Common causes: the render loop never runs, the camera looks at nothing, geometry/material missing, or an early return. Look with see_page visual:true, check the scene/camera/render-loop, and fix it. Do NOT declare done on a blank canvas." };
    }
    if (!text && canvasBlank !== false) return { ok: true, path: rel, rendered: "", blank: true, note: "the page rendered BLANK (no visible text) and no JS error was detected — the script may not be drawing anything. Verify it actually renders content (a game: use play_game; a canvas scene: see_page visual:true and look)." };
    return { ok: true, path: rel, rendered: text.slice(0, 4000), note: "no JS/console errors and the canvas drew content. This is the VISIBLE rendered text (post-JS). Check it reads correctly. For layout, call see_page with visual:true." };
  }

  // play_game (Block 15): DRIVE a web game headlessly and observe it — the keystone for making real
  // games. The game must expose window.slivrSim={reset,step,input,state}; this resets it, applies a
  // scripted input timeline, steps N frames, and returns the game STATE over time + a final-frame
  // screenshot, so you can verify it actually plays (moves, scores, ends) and fix what doesn't.
  play_game({ path: rel, steps, dt, inputs, seed } = {}) {
    if (!rel) return { ok: false, error: "NO_PATH", hint: 'pass {"path":"index.html","inputs":[{"at":0,"key":"ArrowRight","down":true}],"steps":120}' };
    let abs; try { abs = this._resolve(rel); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    const r = playGame(abs, { steps, dt, inputs, seed });
    if (!r.ok) return { ok: false, error: r.error, hint: "couldn't drive the game — is Chrome installed?" };
    const res = r.result || {};
    const img = r.screenshot ? { multimodal: { kind: "image", path: `${rel} (frame)`, mime: "image/png", dataUrl: r.screenshot } } : {};
    if (res.error) return { ok: true, played: false, note: `could not drive the game: ${res.error}. Expose window.slivrSim={reset,step,input,state} to make it playtestable.${r.screenshot ? " (final frame attached)" : ""}`, ...img };
    const snaps = res.snapshots || [];
    return { ok: true, played: true, snapshots: snaps, note: `played ${res.steps} steps · ${snaps.length} state snapshots:\n${JSON.stringify(snaps).slice(0, 2200)}`, ...img };
  }

  // autoplay (Block 28 — play the REAL game): dispatch REAL KeyboardEvent/MouseEvent into the running page
  // and watch whether the SCREEN actually changes. Unlike play_game/play_levels (which drive the
  // window.slivrSim contract — and the agent can stub that with a no-op input), this drives the game's OWN
  // keydown/click handlers, so a frozen/dead game is caught even when the contract lies. Returns whether it
  // RESPONDS to input, the per-input screen-change %, console errors, and a contact sheet you SEE.
  autoplay({ path: rel, keys, clicks, holdMs } = {}) {
    if (!rel) return { ok: false, error: "NO_PATH", hint: 'pass {"path":"index.html"} — drives real arrow/space/click input' };
    let abs; try { abs = this._resolve(rel); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    const r = autoPlay(abs, { keys, clicks, holdMs });
    if (!r.ok) return { ok: false, error: r.error, hint: "couldn't autoplay — is Chrome installed?" };
    const errs = r.errors && r.errors.length ? ` Console errors: ${r.errors.slice(0, 4).join("; ")}.` : "";
    const verdict = r.responds
      ? `the screen RESPONDS to real input (max ${r.maxChange}% change) — it plays.`
      : `the screen does NOT change when real keys/clicks are sent (${r.maxChange}% change) — the game is FROZEN/DEAD as the user would experience it. Fix the real input + update loop (not just the slivrSim contract).`;
    const out = { ok: true, responds: r.responds, maxChange: r.maxChange, perStep: r.perStep, errors: r.errors,
      note: `Autoplayed with REAL keyboard/mouse input: ${verdict}${errs} Look at the contact sheet — the player/screen should visibly change between frames.` };
    if (r.dataUrl) out.multimodal = { kind: "image", path: "autoplay", mime: "image/png", dataUrl: r.dataUrl };
    return out;
  }

  // play_levels (Block 23 — multi-level): drive EVERY level of a multi-level game and verify each one
  // loads, is DISTINCT (not a clone of level 1 — the usual failure), plays, and (if state exposes a win
  // flag) is completable, plus a contact sheet of every level's initial frame. The game must extend the
  // Simulacrum contract with window.slivrSim.levels (count or array) + load(i) (or reset(i)).
  play_levels({ path: rel, steps, dt, inputs, cap } = {}) {
    if (!rel) return { ok: false, error: "NO_PATH", hint: 'pass {"path":"index.html"} — the multi-level game' };
    let abs; try { abs = this._resolve(rel); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    const r = playLevels(abs, { steps, dt, inputs, cap });
    if (!r.ok) return { ok: false, error: r.error, hint: r.hint || "couldn't drive levels — is Chrome installed? expose slivrSim.levels + load(i)" };
    const broken = r.levels.filter((l) => !l.loads || !l.plays).map((l) => l.level);
    const clonesNote = r.clones.length ? ` CLONES: levels ${r.clones.join(",")} are identical to another level — make them meaningfully different (layout/enemies/goal).` : "";
    const allGood = r.clones.length === 0 && broken.length === 0 && r.count > 1;
    const out = {
      ok: true, count: r.count, declared: r.declared, uniqueLevels: r.uniqueLevels, clones: r.clones,
      levels: r.levels, allDistinct: r.clones.length === 0, allPlayable: broken.length === 0,
      note: `${r.count} level${r.count === 1 ? "" : "s"} driven · ${r.uniqueLevels} distinct.${clonesNote}${broken.length ? ` BROKEN: levels ${broken.join(",")} didn't load or didn't respond.` : ""}${allGood ? " All levels load, play, and are distinct." : " Look at the contact sheet — each level should look and play differently."}`,
    };
    if (r.dataUrl) out.multimodal = { kind: "image", path: "levels", mime: "image/png", dataUrl: r.dataUrl };
    return out;
  }

  // see_asset (Block 16 — Asset Studio): render ONE generated asset in isolation and SEE it, so you can
  // critique + refine it toward a professional look. Pass `svg` (Bézier organic shapes), `canvas` (2D
  // draw code — a `noise(x,y)`/`fbm(x,y)` helper is available for natural textures), or `html`. Returns
  // the rendered image (attached). Loop: generate → see_asset → critique vs the target → refine → repeat.
  see_asset({ svg, canvas, html, width, height, bg } = {}) {
    const r = renderAsset({ svg, canvas, html, width, height, bg });
    if (!r.ok) return { ok: false, error: r.error, hint: "couldn't render the asset — is Chrome installed? (note: WebGL/shader output is NOT captured headless; use svg or canvas-2d)" };
    return { ok: true, note: `asset rendered ${r.width}x${r.height} — look at it, then refine if it's not professional yet`, multimodal: { kind: "image", path: "asset", mime: "image/png", dataUrl: r.dataUrl } };
  }

  // --- Blueprint (Block 17): plan the WHOLE build up front as a deep, concrete, on-disk tree, then
  // grind it leaf-by-leaf over hours without drifting or dropping inner parts. -------------------------

  // blueprint_plan: lock in the full hierarchical build tree from the goal. `tree` is nested:
  // [{title, leafType?, decision?, children?:[...]}]. Childless nodes are leaves (real work);
  // nodes with children are groups. Persists to .slivr/blueprint.json (re-planning preserves progress).
  blueprint_plan({ goal, tree } = {}) {
    if (!goal || !String(goal).trim()) return { ok: false, error: "NO_GOAL", hint: "pass goal: the one-line description of what you're building" };
    if (!Array.isArray(tree) || !tree.length) return { ok: false, error: "NO_TREE", hint: "pass tree: a NESTED array of concrete nodes [{title, leafType?, children?[]}] — expand to real leaves (every sprite/sound/UI state/sub-component), no abstractions" };
    let model = bp.parseTree(goal, tree);
    const prev = bp.loadBlueprint(this.workdir);
    if (prev) model = bp.mergeProgress(prev, model);
    const p = bp.saveBlueprint(this.workdir, model);
    const cov = bp.coverage(model);
    return { ok: true, saved: path.relative(this.workdir, p) || ".slivr/blueprint.json", coverage: cov, tree: bp.renderTree(model), note: `Blueprint locked: ${cov.totalLeaves} concrete leaves. Work them one by one; mark each done only when it's a real, finished artifact.` };
  }

  // blueprint_status: cheap orientation — the tree, coverage, and the next uncovered leaves to do.
  blueprint_status({ next = 5 } = {}) {
    const model = bp.loadBlueprint(this.workdir);
    if (!model) return { ok: false, error: "NO_BLUEPRINT", hint: "call blueprint_plan first to lock in the build tree" };
    const upcoming = bp.nextUncovered(model, next).map(n => ({ id: n.id, title: n.title, leafType: n.leafType }));
    return { ok: true, coverage: bp.coverage(model), next: upcoming, tree: bp.renderTree(model) };
  }

  // blueprint_mark: update a node's status (+evidence/decision). MATERIALIZATION-FIRST gate: a leaf can
  // only become "done" with `evidence` (a real file/artifact path) whose content is NOT a stub/placeholder.
  blueprint_mark({ id, status, evidence, decision } = {}) {
    const model = bp.loadBlueprint(this.workdir);
    if (!model) return { ok: false, error: "NO_BLUEPRINT", hint: "call blueprint_plan first" };
    const node = model.nodes[id];
    if (!node) return { ok: false, error: "NO_SUCH_NODE", id, hint: "use blueprint_status to see node ids" };
    if (status && !bp.STATUSES.includes(status)) return { ok: false, error: "BAD_STATUS", hint: `status ∈ ${bp.STATUSES.join("|")}` };
    if (status === "done" && node.kind === "leaf") {
      const ev = evidence || node.evidence;
      if (!ev) return { ok: false, error: "NO_EVIDENCE", hint: "to mark a leaf done, pass evidence: the real file/artifact that satisfies it (zero-abstraction — no stubs)" };
      // read the evidence file (if it's a path in the workdir) and reject stubs/placeholders — but tell
      // the agent EXACTLY where the stub is so it fixes the real content instead of re-marking blindly.
      let txt = null;
      try { txt = fs.readFileSync(this._resolve(ev), "utf8"); } catch { txt = null; }
      if (txt !== null) {
        const f = bp.findStub(txt);
        if (f) return { ok: false, error: "STUB_EVIDENCE", at: `${ev}:${f.line}`, marker: f.marker, snippet: f.snippet,
          hint: `${ev}:${f.line} still contains a stub/placeholder ("${f.marker}"): ${f.snippet}\nEDIT that line to finish the real content (remove the ${f.marker}), THEN mark done. Do NOT re-call blueprint_mark until the file no longer contains it. (Many leaves can share ${ev} — ONE stray marker blocks them all, so fixing this line unblocks the rest.)` };
      }
    }
    if (status) node.status = status;
    if (evidence != null) node.evidence = String(evidence);
    if (decision != null) node.decision = String(decision);
    bp.saveBlueprint(this.workdir, model);
    const cov = bp.coverage(model);
    const upcoming = bp.nextUncovered(model, 3).map(n => ({ id: n.id, title: n.title }));
    return { ok: true, node: { id: node.id, title: node.title, status: node.status, evidence: node.evidence }, coverage: cov, next: upcoming };
  }

  // blueprint_add: graft newly-discovered nodes under a parent (e.g. after the completeness critic finds
  // a missing part). parentId omitted/"" = add as new roots. `nodes` is the same nested shape as plan.
  blueprint_add({ parentId = "", nodes } = {}) {
    const model = bp.loadBlueprint(this.workdir);
    if (!model) return { ok: false, error: "NO_BLUEPRINT", hint: "call blueprint_plan first" };
    if (!Array.isArray(nodes) || !nodes.length) return { ok: false, error: "NO_NODES", hint: "pass nodes: a nested array to add" };
    const parent = parentId ? model.nodes[parentId] : null;
    if (parentId && !parent) return { ok: false, error: "NO_SUCH_PARENT", id: parentId };
    // build a sub-model rooted at the parent's id-space, then splice it in.
    const base = parent ? parent.children.length : model.roots.length;
    const walk = (arr, par, prefix, startIdx) => {
      const ids = [];
      arr.forEach((raw, i) => {
        const idx = startIdx + i + 1;
        const id = prefix ? `${prefix}.${idx}` : `${idx}`;
        const kids = Array.isArray(raw.children) ? raw.children : [];
        const kind = kids.length ? "group" : (raw.kind === "group" ? "group" : "leaf");
        model.nodes[id] = { id, parent: par, title: String(raw.title || "").trim() || "(untitled)", kind, leafType: raw.leafType ? String(raw.leafType) : (kind === "leaf" ? "part" : null), origin: (raw.origin === "pictured" || raw.origin === "world") ? raw.origin : null, status: "uncovered", evidence: "", decision: raw.decision ? String(raw.decision) : "" };
        ids.push(id);
        model.nodes[id].children = walk(kids, id, id, 0);
      });
      return ids;
    };
    const newIds = walk(nodes, parent ? parent.id : null, parent ? parent.id : "", base);
    if (parent) { parent.children.push(...newIds); if (parent.kind === "leaf") parent.kind = "group"; }
    else model.roots.push(...newIds);
    bp.saveBlueprint(this.workdir, model);
    return { ok: true, added: newIds.length, coverage: bp.coverage(model), tree: bp.renderTree(model) };
  }

  // blueprint_audit: the completeness critic. Returns the original goal, the full tree, and STRUCTURAL
  // findings (empty groups, done-without-evidence, stub/missing evidence). The agent then does the
  // SEMANTIC pass: re-read the goal and add (blueprint_add) anything in it not yet a leaf — 100% coverage.
  blueprint_audit() {
    const model = bp.loadBlueprint(this.workdir);
    if (!model) return { ok: false, error: "NO_BLUEPRINT", hint: "call blueprint_plan first" };
    const findings = bp.structuralAudit(model, (rel) => {
      try { return fs.readFileSync(this._resolve(rel), "utf8"); } catch { return null; }
    });
    return { ok: true, goal: model.goal, coverage: bp.coverage(model), structural: findings, tree: bp.renderTree(model), note: "Now do the SEMANTIC check: re-read the goal above and list anything implied but NOT present as a leaf (inner parts, small assets, edge states). Add them with blueprint_add so coverage is 100%." };
  }

  // resume (Block 25 — session continuity): orient yourself when picking up work in an existing project.
  // Reconstructs "where you left off" from the persisted blueprint + world map + git state + the last
  // session journal handoff, so you continue instead of re-reading everything and guessing.
  resume() {
    const r = resumeSummary(this.workdir);
    if (!r.hasState) return { ok: true, hasState: false, note: "Fresh project — no prior slivr session, blueprint, or git changes found. Start from the task." };
    return { ok: true, hasState: true, summary: r.text, coverage: r.data.coverage, next: r.data.next, note: `Resuming. ${r.text}\n\nContinue from the NEXT items above (don't redo done work). If a blueprint exists, blueprint_status for detail.` };
  }

  // compare_image (Block 18 — Match a reference picture): diff your built result against a TARGET image and
  // get a SIMILARITY score 0–100 + the worst-matching regions + a composite (target | yours | heatmap) you
  // can SEE. Pass `target` (the reference image) and EITHER `candidate` (an image to compare) OR `render`
  // (an .html/page path — it's screenshotted first). Loop: build → compare_image → fix the worst regions →
  // re-compare, until similarity is high. Never declare a visual match done on a low score.
  compare_image({ target, candidate, render, grid } = {}) {
    if (!target) return { ok: false, error: "NO_TARGET", hint: "pass target: the reference image path to match" };
    if (!candidate && !render) return { ok: false, error: "NO_CANDIDATE", hint: "pass candidate: an image path, OR render: an html/page path to screenshot and compare" };
    const readable = (rel) => { // allow a target outside the workdir (a reference picture the user named), read-only
      try { const a = this._resolve(rel); if (fs.existsSync(a)) return a; } catch { /* fall through */ }
      if (path.isAbsolute(rel) && fs.existsSync(rel)) return rel;
      try { return this._resolve(rel); } catch (e) { return null; }
    };
    const targetAbs = readable(target);
    if (!targetAbs || !fs.existsSync(targetAbs)) return { ok: false, error: "TARGET_NOT_FOUND", path: target };

    let candAbs, tmpShot = null;
    if (render) {
      let pageAbs; try { pageAbs = this._resolve(render); } catch (e) { return { ok: false, error: e.message }; }
      if (!fs.existsSync(pageAbs)) return { ok: false, error: "RENDER_NOT_FOUND", path: render };
      tmpShot = path.join(os.tmpdir(), `slivr-cand-${process.pid}-${Date.now()}.png`);
      const shot = renderShot(pageAbs, tmpShot, { width: 1000, height: 750 });
      if (!shot.ok) return { ok: false, error: "RENDER_SCREENSHOT_FAILED", hint: shot.error };
      candAbs = tmpShot;
    } else {
      candAbs = readable(candidate);
      if (!candAbs || !fs.existsSync(candAbs)) return { ok: false, error: "CANDIDATE_NOT_FOUND", path: candidate };
    }

    try {
      const r = compareImages(targetAbs, candAbs, { grid });
      if (!r.ok) return { ok: false, error: r.error, hint: "couldn't diff — is Chrome installed and are both files real images?" };
      const worst = r.worst.map((w) => `${w.region} (${w.sim}% match)`).join(", ");
      const verdict = r.similarity >= 90 ? "close match" : r.similarity >= 75 ? "getting there — keep refining" : "far off — fix the worst regions and re-compare";
      const out = { ok: true, similarity: r.similarity, mae: r.mae, worstRegions: r.worst, note: `${r.similarity}% similar to the target — ${verdict}. Worst regions: ${worst || "n/a"}. Look at the heatmap (red = mismatch), fix those areas, and compare again.` };
      if (r.dataUrl) out.multimodal = { kind: "image", path: "diff", mime: "image/png", dataUrl: r.dataUrl };
      return out;
    } finally { if (tmpShot) { try { fs.unlinkSync(tmpShot); } catch { /* */ } } }
  }

  // crop_image (Block 19): extract ONE asset/region out of an image into a new PNG, given a bounding box
  // {x,y,w,h} that is normalized (0–1, fractions of the image) OR absolute pixels. Use it to pull a single
  // asset out of a busy reference picture so you can study and recreate it in isolation (see_asset).
  crop_image({ src, x, y, w, h, out } = {}) {
    if (!src) return { ok: false, error: "NO_SRC", hint: "pass src: the image to crop from" };
    if ([x, y, w, h].some((v) => typeof v !== "number")) return { ok: false, error: "NO_BBOX", hint: "pass x,y,w,h (normalized 0–1 or pixels)" };
    if (!out) return { ok: false, error: "NO_OUT", hint: "pass out: the destination .png path (in the workdir)" };
    const readable = (rel) => { try { const a = this._resolve(rel); if (fs.existsSync(a)) return a; } catch { /* */ } if (path.isAbsolute(rel) && fs.existsSync(rel)) return rel; return null; };
    const srcAbs = readable(src);
    if (!srcAbs) return { ok: false, error: "SRC_NOT_FOUND", path: src };
    let outAbs; try { outAbs = this._resolve(out); } catch (e) { return { ok: false, error: e.message }; }
    const r = cropImage(srcAbs, { x, y, w, h }, outAbs);
    if (!r.ok) return { ok: false, error: r.error, hint: "couldn't crop — is Chrome installed and src a real image?" };
    return { ok: true, path: path.relative(this.workdir, outAbs) || out, width: r.width, height: r.height, note: `cropped ${r.width}x${r.height} asset → ${out}. Study it (view_image) and recreate it (see_asset).` };
  }

  // compare_regions (Block 19 — the granular fix for busy pictures): a whole-image score HIDES a small
  // wrong asset (it averages out). Pass the asset bounding boxes and this diffs EACH region of target vs
  // your render AT HIGH SENSITIVITY, plus the whole scene — a per-asset SCORECARD (worst-first) so you fix
  // the exact assets that are off, with an annotated composite (green box = match, red = off) you SEE.
  // target + regions required; pass render (an html/page to screenshot) OR candidate (an image).
  compare_regions({ target, render, candidate, regions } = {}) {
    if (!target) return { ok: false, error: "NO_TARGET", hint: "pass target: the reference image" };
    if (!Array.isArray(regions) || !regions.length) return { ok: false, error: "NO_REGIONS", hint: "pass regions: [{label, x, y, w, h}] — the asset boxes (view_image the target first to find them)" };
    if (!render && !candidate) return { ok: false, error: "NO_CANDIDATE", hint: "pass render: an html/page path, OR candidate: an image path" };
    const readable = (rel) => { try { const a = this._resolve(rel); if (fs.existsSync(a)) return a; } catch { /* */ } if (path.isAbsolute(rel) && fs.existsSync(rel)) return rel; return null; };
    const targetAbs = readable(target);
    if (!targetAbs) return { ok: false, error: "TARGET_NOT_FOUND", path: target };
    let candAbs, tmpShot = null;
    if (render) {
      let pageAbs; try { pageAbs = this._resolve(render); } catch (e) { return { ok: false, error: e.message }; }
      if (!fs.existsSync(pageAbs)) return { ok: false, error: "RENDER_NOT_FOUND", path: render };
      tmpShot = path.join(os.tmpdir(), `slivr-rcand-${process.pid}-${Date.now()}.png`);
      const shot = renderShot(pageAbs, tmpShot, { width: 1000, height: 750 });
      if (!shot.ok) return { ok: false, error: "RENDER_SCREENSHOT_FAILED", hint: shot.error };
      candAbs = tmpShot;
    } else {
      candAbs = readable(candidate);
      if (!candAbs) return { ok: false, error: "CANDIDATE_NOT_FOUND", path: candidate };
    }
    try {
      const r = compareRegions(targetAbs, candAbs, regions);
      if (!r.ok) return { ok: false, error: r.error, hint: "couldn't diff regions — is Chrome installed and both files real images?" };
      const off = r.regions.filter((x) => x.similarity < 90);
      const worst = r.regions.slice(0, 6).map((x) => `${x.label}: ${x.similarity}%`).join(", ");
      const pass = off.length === 0 && r.whole >= 90;
      const out = { ok: true, whole: r.whole, regions: r.regions, assetsOff: off.map((x) => x.label), allPass: pass,
        note: `whole scene ${r.whole}% · ${r.regions.length - off.length}/${r.regions.length} assets ≥90%. ${pass ? "All assets and the whole scene pass." : `Fix these assets next (worst first): ${worst}. A high whole-scene score can still hide a wrong asset — chase the per-asset reds.`}` };
      if (r.dataUrl) out.multimodal = { kind: "image", path: "scorecard", mime: "image/png", dataUrl: r.dataUrl };
      return out;
    } finally { if (tmpShot) { try { fs.unlinkSync(tmpShot); } catch { /* */ } } }
  }

  // style_profile (Block 20 — Beyond the Frame): the picture is only a BASELINE for a bigger world. Derive
  // a STYLE ANCHOR from it — dominant palette + brightness/saturation/contrast — and persist it to
  // .slivr/style-anchor.json, so assets you INVENT beyond the frame (not in the picture) can be checked for
  // consistency. Call this once on the reference before extrapolating the world.
  style_profile({ target } = {}) {
    if (!target) return { ok: false, error: "NO_TARGET", hint: "pass target: the reference image to derive the style anchor from" };
    const readable = (rel) => { try { const a = this._resolve(rel); if (fs.existsSync(a)) return a; } catch { /* */ } if (path.isAbsolute(rel) && fs.existsSync(rel)) return rel; return null; };
    const targetAbs = readable(target);
    if (!targetAbs) return { ok: false, error: "TARGET_NOT_FOUND", path: target };
    const r = styleProfile(targetAbs);
    if (!r.ok) return { ok: false, error: r.error, hint: "couldn't profile — is Chrome installed and target a real image?" };
    try {
      const p = path.join(this.workdir, ".slivr", "style-anchor.json");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(r.profile, null, 2));
    } catch { /* best effort */ }
    const hexes = r.profile.palette.map((c) => hexColor(c.rgb));
    return { ok: true, palette: hexes, brightness: r.profile.brightness, saturation: r.profile.saturation, contrast: r.profile.contrast, saved: ".slivr/style-anchor.json", note: `Style anchor saved: palette ${hexes.join(" ")}. When you build assets NOT in the picture, keep them in this family and verify with style_check.` };
  }

  // style_check (Block 20): verify an INVENTED asset (not in the picture, so it can't be pixel-diffed) is
  // consistent with the picture's world — a deterministic palette/tone ADHERENCE score 0–100 plus a
  // composite (the asset beside the anchor palette) you LOOK at to judge "same game/world?". Pass
  // candidate (an image) or render (an html/page to screenshot); anchor comes from style_profile (or pass
  // target to profile on the fly).
  style_check({ candidate, render, target } = {}) {
    if (!candidate && !render) return { ok: false, error: "NO_CANDIDATE", hint: "pass candidate: an image path, OR render: an html/page path" };
    const readable = (rel) => { try { const a = this._resolve(rel); if (fs.existsSync(a)) return a; } catch { /* */ } if (path.isAbsolute(rel) && fs.existsSync(rel)) return rel; return null; };
    // resolve the anchor: explicit target → profile it; else the persisted anchor.
    let anchor = null;
    if (target) {
      const tAbs = readable(target);
      if (!tAbs) return { ok: false, error: "TARGET_NOT_FOUND", path: target };
      const tp = styleProfile(tAbs);
      if (!tp.ok) return { ok: false, error: tp.error };
      anchor = tp.profile;
    } else {
      try { anchor = JSON.parse(fs.readFileSync(path.join(this.workdir, ".slivr", "style-anchor.json"), "utf8")); }
      catch { return { ok: false, error: "NO_ANCHOR", hint: "call style_profile on the reference first, or pass target" }; }
    }
    let assetAbs, tmpShot = null;
    if (render) {
      let pageAbs; try { pageAbs = this._resolve(render); } catch (e) { return { ok: false, error: e.message }; }
      if (!fs.existsSync(pageAbs)) return { ok: false, error: "RENDER_NOT_FOUND", path: render };
      tmpShot = path.join(os.tmpdir(), `slivr-style-${process.pid}-${Date.now()}.png`);
      const shot = renderShot(pageAbs, tmpShot, { width: 600, height: 600 });
      if (!shot.ok) return { ok: false, error: "RENDER_SCREENSHOT_FAILED", hint: shot.error };
      assetAbs = tmpShot;
    } else {
      assetAbs = readable(candidate);
      if (!assetAbs) return { ok: false, error: "CANDIDATE_NOT_FOUND", path: candidate };
    }
    try {
      const r = styleAdherence(anchor, assetAbs);
      if (!r.ok) return { ok: false, error: r.error };
      const verdict = r.adherence >= 85 ? "consistent with the world" : r.adherence >= 70 ? "borderline — nudge its palette toward the anchor" : "off-style — rework its colours/tone to match the picture's world";
      const out = { ok: true, adherence: r.adherence, palette: r.palette, tone: r.tone, brightnessDelta: r.brightnessDelta, saturationDelta: r.saturationDelta, contrastDelta: r.contrastDelta, note: `${r.adherence}% style-consistent with the picture's world — ${verdict}. Look at the composite: this asset's palette should live in the same family as the anchor.` };
      if (r.dataUrl) out.multimodal = { kind: "image", path: "style", mime: "image/png", dataUrl: r.dataUrl };
      return out;
    } finally { if (tmpShot) { try { fs.unlinkSync(tmpShot); } catch { /* */ } } }
  }

  // art_review (Block 29 — don't ship programmer art): rate the VISUAL RICHNESS of a render/image so flat
  // coloured-rectangle "programmer art" is caught, not shipped. Returns a 0–100 richness score + colour
  // count / flat-fill % / edge % / gradient %, and attaches the image so you LOOK. Pass render (an
  // html/page to screenshot) or candidate (an image). Low richness + high flat% = blobs → use see_asset.
  art_review({ render, candidate } = {}) {
    if (!render && !candidate) return { ok: false, error: "NO_INPUT", hint: "pass render: an html/page path, OR candidate: an image path" };
    const readable = (rel) => { try { const a = this._resolve(rel); if (fs.existsSync(a)) return a; } catch { /* */ } if (path.isAbsolute(rel) && fs.existsSync(rel)) return rel; return null; };
    let imgAbs, tmpShot = null;
    if (render) {
      let pageAbs; try { pageAbs = this._resolve(render); } catch (e) { return { ok: false, error: e.message }; }
      if (!fs.existsSync(pageAbs)) return { ok: false, error: "RENDER_NOT_FOUND", path: render };
      tmpShot = path.join(os.tmpdir(), `slivr-art-${process.pid}-${Date.now()}.png`);
      // WebGL/Three.js pages render BLANK with --screenshot (--disable-gpu) — capture on the GPU path.
      let isGL = false; try { isGL = isWebGLPage(fs.readFileSync(pageAbs, "utf8")); } catch { /* */ }
      const shot = isGL ? screenshotWebGL(pageAbs, tmpShot) : renderShot(pageAbs, tmpShot, { width: 800, height: 500 });
      if (!shot.ok) return { ok: false, error: "RENDER_SCREENSHOT_FAILED", hint: shot.error + (isGL ? " (WebGL page — the scene may be blank; check see_page first)" : "") };
      imgAbs = tmpShot;
    } else { imgAbs = readable(candidate); if (!imgAbs) return { ok: false, error: "CANDIDATE_NOT_FOUND", path: candidate }; }
    try {
      const a = artReview(imgAbs);
      if (!a.ok) return { ok: false, error: a.error, hint: "couldn't analyze — is Chrome installed and the input a real image?" };
      const verdict = a.richness >= 60 ? "visually rich — real detail/shading."
        : a.richness >= 35 ? "some detail, but it could be richer — add texture/shading/outlines."
        : `looks like FLAT PROGRAMMER ART (${a.flatPct}% flat fill, ${a.gradientPct}% gradients, ${a.colors} colours). If you intended detailed sprites/textures, draw them with see_asset (organic shapes + procedural texture) and re-check; if a flat/minimalist style is intentional, that's fine.`;
      const out = { ok: true, richness: a.richness, colors: a.colors, flatPct: a.flatPct, edgePct: a.edgePct, gradientPct: a.gradientPct,
        note: `Visual richness ${a.richness}/100 — ${verdict} Look at the image: are the player/enemies/props real little drawings, or just coloured rectangles?` };
      try { out.multimodal = { kind: "image", path: "art", mime: "image/png", dataUrl: "data:image/png;base64," + fs.readFileSync(imgAbs).toString("base64") }; } catch { /* */ }
      return out;
    } finally { if (tmpShot) { try { fs.unlinkSync(tmpShot); } catch { /* */ } } }
  }

  // artkit (Block 30 — draw rich art, not blocks): returns the slivr ARTKIT source — canvas helpers that
  // bake in the techniques that move art_review richness toward 100: palette() (harmonized, no raw
  // primaries), shadedBall()/shadedBox() (gradient shading + outline + rim + AO), eyes() (with catchlights),
  // grain() (procedural texture), contactShadow(), sky() + hills() (gradient + parallax depth). Paste the
  // returned source into the game's <script> (the noise/fbm helpers are included) and draw with these
  // instead of fillRect. (see_asset already has them built in for single assets.)
  artkit({ mode } = {}) {
    if (mode === "3d") {
      return { ok: true, mode: "3d", source: ARTKIT3D,
        note: "Inline this into your Three.js game. Add lights3d(scene), then build entities with character3d({mustache:true}) for the player, enemy3d() for enemies, coin3d(), tree3d(), ground3d() — NEVER a single BoxGeometry per character (that's the 'everything is a box' failure). Each factory returns a THREE.Group of grouped primitives with MeshStandard materials + CanvasTexture faces. After building, run art_review {render:'index.html'} (it renders WebGL on the GPU path) and aim for richness ≥ 60." };
    }
    return { ok: true, mode: "2d", source: NOISE_FBM_SRC + ARTKIT,
      note: "Inline this <script> source into your 2D canvas game, then draw with sky/hills/shadedBox/shadedBall/eyes/contactShadow/grain/palette instead of flat fillRect (light is top-left). For a 3D/Three.js game call artkit {mode:'3d'} instead. After building, run art_review {render:'index.html'} and aim for richness ≥ 60." };
  }

  // orbit_scene (Block 21 — the 3D eye): drive a WebGL/Three.js scene's CAMERA to many angles and SEE each
  // view as a contact sheet, so you build REAL 3D (camera rig + landscape + 360°) instead of a flat
  // single-view billboard. The scene must expose window.slivrView={setCamera({yaw,pitch,dist,target}),
  // render()} and create its renderer with preserveDrawingBuffer:true. Returns whether the view actually
  // RESPONDS to the camera (true 3D) vs ignores it (a flat billboard), plus the contact-sheet image.
  orbit_scene({ path: rel, angles, pitch, dist, target, budget } = {}) {
    if (!rel) return { ok: false, error: "NO_PATH", hint: "pass path: the html scene to orbit" };
    let abs; try { abs = this._resolve(rel); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    const r = orbitScene(abs, { angles, pitch, dist, target, budget });
    if (!r.ok) return { ok: false, error: r.error, hint: r.hint || "couldn't orbit — is Chrome installed? the scene must expose window.slivrView and use preserveDrawingBuffer:true" };
    const verdict = r.responds ? "the view CHANGES as the camera orbits — real 3D" : "the view does NOT change as the camera orbits — it's a flat billboard / the camera isn't wired. Build a real camera rig + depth.";
    const out = { ok: true, views: r.views, responds: r.responds, adjDiff: r.adjDiff, note: `Orbited ${r.views} camera angles. ${verdict} Look at the contact sheet: check for parallax, occlusion, and that the landscape has depth.` };
    if (r.dataUrl) out.multimodal = { kind: "image", path: "orbit", mime: "image/png", dataUrl: r.dataUrl };
    return out;
  }

  // world_map (Block 21, Challenge 2 — discover the OUTER world): the reference is the ORIGIN tile; infer
  // the neighbouring regions (what's north / over the hill / inside) from the picture + game idea and record
  // them as a traversable grid map, building each as a style-consistent tile (verify with style_check).
  // action: "seed" {name, description}; "add" {name, description, fromId, direction|x,y}; "tile" {id, file,
  // styleScore}; "show" (default) renders the compass map + coverage.
  world_map({ action = "show", name, description, fromId, direction, x, y, id, file, styleScore } = {}) {
    let model = world.loadWorld(this.workdir);
    if (action === "seed") {
      model = world.seedWorld(name || "origin (the reference)", description || "");
      world.saveWorld(this.workdir, model);
      return { ok: true, seeded: "r0", map: world.renderWorld(model), note: "Origin tile set from the reference. Now infer neighbouring regions from the picture + game idea and world_map add them (n/s/e/w…), then build each as a style-consistent tile." };
    }
    if (!model) return { ok: false, error: "NO_WORLD", hint: 'call world_map {action:"seed", name, description} first (the reference is the origin)' };
    if (action === "add") {
      const r = world.addRegion(model, { name, description, x, y, fromId, direction });
      if (!r.ok) return { ok: false, error: r.error, hint: r.hint };
      world.saveWorld(this.workdir, model);
      return { ok: true, added: r.id, at: [r.x, r.y], coverage: world.worldCoverage(model), map: world.renderWorld(model) };
    }
    if (action === "tile") {
      if (!id) return { ok: false, error: "NO_ID", hint: "pass id: the region to attach a built tile to" };
      const r = world.setTile(model, id, file, styleScore);
      if (!r.ok) return { ok: false, error: r.error };
      world.saveWorld(this.workdir, model);
      return { ok: true, coverage: world.worldCoverage(model), map: world.renderWorld(model) };
    }
    return { ok: true, coverage: world.worldCoverage(model), map: world.renderWorld(model) };
  }

  // view_pdf: PRIMARY path sends the PDF to the model via OpenRouter's file-parser plugin (so the
  // model reads it directly). FALLBACK: pass { local:true } (or call when no OpenRouter key is set)
  // to extract text LOCALLY via poppler's pdftotext / mutool and return it as a text result. If the
  // PDF has no extractable text (scanned/image), we say so clearly instead of failing silently.
  view_pdf({ path: rel, local = false } = {}) {
    if (!rel) return { ok: false, error: "NO_PATH", hint: "Pass path: rel/to/file.pdf" };
    let abs; try { abs = this._resolve(rel); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    if (path.extname(abs).toLowerCase() !== ".pdf") return { ok: false, error: "NOT_A_PDF", path: rel, hint: "view_pdf expects a .pdf file" };
    const name = path.basename(abs);
    // No OpenRouter key OR explicit local:true -> local extraction is the only sensible path.
    const noKey = !(this.opts.apiKey || process.env.OPENROUTER_API_KEY);
    if (local || noKey) {
      const r = localPdfText(abs);
      if (r.ok) return { ok: true, path: rel, text: r.text, chars: r.chars, source: `local:${r.tool}`, note: `pdf text extracted locally via ${r.tool} (${r.chars} chars)` };
      // NO_TOOL with a key available -> fall through to the multimodal path; otherwise surface clearly.
      if (r.reason === "NO_TOOL" && !noKey && !local) { /* fall through to multimodal */ }
      else return { ok: false, error: r.reason, path: rel, note: r.note };
    }
    let b64; try { b64 = fs.readFileSync(abs).toString("base64"); } catch (e) { return { ok: false, error: String(e.message || e) }; }
    return { ok: true, path: rel, multimodal: { kind: "pdf", path: rel, filename: name, dataUrl: `data:application/pdf;base64,${b64}` }, note: `pdf loaded (${name}); sent to the model via OpenRouter's file-parser plugin (pass local:true to extract text locally instead)` };
  }

  // web_search: grounded web search via OpenRouter's `web` plugin. This makes its OWN OpenRouter
  // call (separate from the agent loop). Because it's a separate call, its tokens are NOT counted in
  // the session totals automatically — so we SURFACE the usage in the result (tokens + est. cost) and,
  // if the host wired one in via opts.onExternalUsage, report it back so cost isn't silently hidden.
  async web_search({ query, max = 5 }) {
    const key = this.opts.apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) return { ok: false, error: "NO_KEY", hint: "Set OPENROUTER_API_KEY to enable web search." };
    if (!query) return { ok: false, error: "NO_QUERY" };
    const model = this.opts.model || "google/gemini-2.5-flash";
    try {
      const r = await fetch((this.opts.baseUrl || "https://openrouter.ai/api/v1") + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          model,
          plugins: [{ id: "web", max_results: Math.max(1, Math.min(10, max | 0 || 5)) }],
          messages: [{ role: "user", content: `Search the web and answer concisely WITH source URLs: ${query}` }],
        }),
      });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = await r.json();
      const u = j.usage || {};
      const pt = u.prompt_tokens ?? 0, ct = u.completion_tokens ?? 0;
      const usage = { promptTokens: pt, completionTokens: ct, totalTokens: pt + ct, cost: +costUSD(model, pt, ct).toFixed(6) };
      // give the host a chance to fold this external spend into session accounting.
      if (typeof this.opts.onExternalUsage === "function") { try { this.opts.onExternalUsage(usage); } catch { /* ignore */ } }
      return { ok: true, query, answer: (j.choices?.[0]?.message?.content || "").slice(0, 4000), usage, note: `web_search billed separately: ${usage.totalTokens} tok ≈ $${usage.cost.toFixed(4)}` };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }
}
