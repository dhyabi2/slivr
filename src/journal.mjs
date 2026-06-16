// journal.mjs — session continuity (Block 25, Challenge 1): coding agents lose their place between
// sessions — open a new window and there's no clarity on what was done or where to continue. proov keeps
// a durable on-disk JOURNAL and reconstructs a "where you left off" briefing on startup from the persisted
// blueprint + world map + git state + the last handoff. Zero dependencies (files + an optional git call).

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadBlueprint, coverage, nextUncovered } from "./blueprint.mjs";
import { loadWorld, worldCoverage } from "./world.mjs";

function journalPath(dir) { return path.join(dir, ".proov", "journal.md"); }

// Append a session entry (a dated handoff). entry: { task, summary, next, files }.
export function appendJournal(dir, entry = {}, when) {
  const p = journalPath(dir);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* */ }
  const ts = when || new Date().toISOString().replace("T", " ").slice(0, 16);
  const files = Array.isArray(entry.files) && entry.files.length ? `\n- files: ${[...new Set(entry.files)].slice(0, 12).join(", ")}` : "";
  const next = entry.next ? `\n- next: ${String(entry.next).replace(/\s+/g, " ").trim()}` : "";
  const block = `\n## ${ts}\n- task: ${String(entry.task || "(session)").replace(/\s+/g, " ").trim().slice(0, 200)}\n- did: ${String(entry.summary || "").replace(/\s+/g, " ").trim().slice(0, 400)}${files}${next}\n`;
  try { fs.appendFileSync(p, block); return true; } catch { return false; }
}

// The last N journal entries (most recent first), parsed lightly into { when, lines }.
export function readJournal(dir, n = 3) {
  let txt = "";
  try { txt = fs.readFileSync(journalPath(dir), "utf8"); } catch { return []; }
  const blocks = txt.split(/\n## /).slice(1).map((b) => "## " + b);
  return blocks.slice(-n).reverse().map((b) => {
    const lines = b.split("\n").filter(Boolean);
    return { when: (lines[0] || "## ?").replace(/^##\s*/, ""), lines: lines.slice(1) };
  });
}

// Read short git orientation (uncommitted file count + last commit). Best-effort; "" when not a repo.
function gitState(dir, run = (cmd) => execSync(cmd, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) {
  try {
    const status = run("git status --porcelain").trim();
    const changed = status ? status.split("\n").length : 0;
    let last = ""; try { last = run("git log -1 --pretty=%s").trim().slice(0, 80); } catch { /* */ }
    return { changed, last, files: status ? status.split("\n").map((l) => l.slice(3)).slice(0, 10) : [] };
  } catch { return null; }
}

// Build the "where you left off" briefing from everything persisted. Returns { hasState, text, data }.
// `git` can be injected for tests; defaults to a real git call.
export function resumeSummary(dir, { git } = {}) {
  const bp = loadBlueprint(dir);
  const world = loadWorld(dir);
  const journal = readJournal(dir, 2);
  const g = git === undefined ? gitState(dir) : git;
  const hasState = !!(bp || world || journal.length || (g && g.changed));
  if (!hasState) return { hasState: false, text: "", data: {} };

  const out = [];
  if (journal.length) {
    out.push("Last session" + (journal[0].when ? ` (${journal[0].when})` : "") + ":");
    for (const l of journal[0].lines) out.push("  " + l);
  }
  let cov = null, next = [];
  if (bp) {
    cov = coverage(bp);
    next = nextUncovered(bp, 5).map((node) => `${node.id} ${node.title}`);
    out.push(`Blueprint: ${cov.done}/${cov.totalLeaves} leaves done (${cov.pct}%)` + (cov.blocked ? `, ${cov.blocked} blocked` : ""));
    if (next.length) out.push("  next: " + next.join(" · "));
    else if (cov.totalLeaves) out.push("  all leaves done — verify + finish");
  }
  if (world) { const wc = worldCoverage(world); out.push(`World map: ${wc.regions} regions, ${wc.tiled} tiled`); }
  if (g && g.changed) out.push(`Git: ${g.changed} uncommitted file${g.changed === 1 ? "" : "s"}${g.last ? ` · last commit: "${g.last}"` : ""}`);

  return { hasState: true, text: out.join("\n"), data: { coverage: cov, next, git: g, journal } };
}
