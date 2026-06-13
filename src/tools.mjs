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

export class Tools {
  constructor(workdir) {
    this.workdir = path.resolve(workdir);
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

  // COMPACT edit protocol (cc-alt). Returns structured repair packet on failure.
  edit_file({ path: rel, anchor, replacement, op = "replace" }) {
    const abs = this._resolve(rel);
    if (!fs.existsSync(abs)) return { ok: false, error: "FILE_NOT_FOUND", path: rel };
    const content = fs.readFileSync(abs, "utf8");
    const res = applyEdit(content, { anchor, replacement, op });
    if (!res.ok) return { ok: false, repair: res.repair };
    fs.writeFileSync(abs, res.content);
    return { ok: true, tier: res.tier, path: rel };
  }

  // create_file (cc-alt): write a NEW file. Refuses to overwrite an existing one — for changes to
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

  // edit_files (cc-alt): apply MANY compact edits ATOMICALLY (all-or-nothing) — fewer turns for
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
}
