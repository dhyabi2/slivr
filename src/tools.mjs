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
import { execSync, execFileSync } from "node:child_process";
import { applyEdit } from "./seal.mjs";
import { localPdfText } from "./pdftext.mjs";
import { costUSD } from "./provider.mjs";
import { buildSymbolIndex, findSymbol, repoOverview } from "./repomap.mjs";

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

  _resolve(rel) {
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

  // COMPACT edit protocol (slivr). Returns structured repair packet on failure.
  edit_file({ path: rel, anchor, replacement, op = "replace" }) {
    const abs = this._resolve(rel);
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    const content = fs.readFileSync(abs, "utf8");
    const res = applyEdit(content, { anchor, replacement, op });
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
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { ok: true, path: rel, bytes: Buffer.byteLength(content) };
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
      const res = applyEdit(buffers.get(rel), { anchor: e.anchor, replacement: e.replacement, op: e.op || "replace" });
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
    return { ok: true, files: idx.files.length, symbols: idx.symbols.length, map: repoOverview(idx) };
  }

  // find_symbol: jump straight to a definition (file:line + signature) instead of grepping through
  // every mention. Falls back to case-insensitive / substring matching for slightly-wrong names.
  find_symbol({ name }) {
    if (!name) return { ok: false, error: "NO_NAME", hint: 'pass {"name":"functionOrClassName"}' };
    const hits = findSymbol(this._index(), name);
    if (!hits.length) return { ok: true, name, matches: [], note: `no symbol named "${name}" found — try repo_map or grep` };
    return { ok: true, name, matches: hits.slice(0, 25).map(s => ({ file: s.file, line: s.line, kind: s.kind, signature: s.signature })) };
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
