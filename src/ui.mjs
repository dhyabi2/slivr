// ui.mjs — terminal presentation: colors, live step rendering, prompts, per-turn footer.
//
// Degrades gracefully: no color when not a TTY, when NO_COLOR is set, or color:false is forced.
// Pure formatting helpers (fmt*, stepLine, footer) are testable without a terminal; the prompt
// helpers (confirm) do real stdin I/O and are only used in the REPL.

import readline from "node:readline";

const RAW = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

export function colorEnabled({ stream = process.stdout, env = process.env } = {}) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR) return true;
  return !!(stream && stream.isTTY);
}

// Build a color palette; when disabled every function is identity (returns the text unchanged).
export function makePalette(enabled) {
  const wrap = (code) => enabled ? (s) => code + s + RAW.reset : (s) => s;
  return {
    enabled,
    reset: RAW.reset,
    bold: wrap(RAW.bold), dim: wrap(RAW.dim),
    red: wrap(RAW.red), green: wrap(RAW.green), yellow: wrap(RAW.yellow),
    blue: wrap(RAW.blue), magenta: wrap(RAW.magenta), cyan: wrap(RAW.cyan), gray: wrap(RAW.gray),
  };
}

// Truncate to `max` chars with a single-char ellipsis so the user can tell output was cut.
function clip(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Pretty-print a tool target, e.g. edit src/foo.js, run `node test.js`, grep "TODO".
export function describeStep({ tool, args = {} }) {
  switch (tool) {
    case "read_file": return `read ${args.path ?? "?"}`;
    case "list_dir": return `list ${args.path ?? "."}`;
    case "grep": return `grep ${clip(String(args.pattern ?? ""), 60)}${args.path && args.path !== "." ? " in " + args.path : ""}`;
    case "find_symbol": return `find_symbol ${args.name ?? "?"}`;
    case "find_refs": return `find_refs ${args.name ?? "?"}`;
    case "repo_map": return `repo_map`;
    case "project_info": return `project_info`;
    case "house_style": return `house_style`;
    case "see_page": return `see_page ${args.path ?? "?"}${args.visual ? " (visual)" : ""}`;
    case "see_asset": return `see_asset ${args.svg ? "svg" : args.canvas ? "canvas" : "html"}`;
    case "blueprint_plan": return `blueprint_plan${Array.isArray(args.tree) ? ` (${args.tree.length} top-level)` : ""}`;
    case "blueprint_status": return `blueprint_status`;
    case "blueprint_mark": return `blueprint_mark ${args.id ?? "?"} → ${args.status ?? "?"}`;
    case "blueprint_add": return `blueprint_add${args.parentId ? ` → ${args.parentId}` : ""}`;
    case "blueprint_audit": return `blueprint_audit`;
    case "resume": return `resume`;
    case "compare_image": return `compare_image ${args.target ?? "?"} vs ${args.render || args.candidate || "?"}`;
    case "compare_regions": return `compare_regions ${args.target ?? "?"}${Array.isArray(args.regions) ? ` (${args.regions.length} assets)` : ""}`;
    case "crop_image": return `crop_image ${args.src ?? "?"} → ${args.out ?? "?"}`;
    case "style_profile": return `style_profile ${args.target ?? "?"}`;
    case "style_check": return `style_check ${args.render || args.candidate || "?"}`;
    case "orbit_scene": return `orbit_scene ${args.path ?? "?"}${Array.isArray(args.angles) ? ` (${args.angles.length} angles)` : ""}`;
    case "world_map": return `world_map ${args.action ?? "show"}${args.name ? " " + args.name : ""}`;
    case "play_game": return `play_game ${args.path ?? "?"}${args.steps ? ` (${args.steps} steps)` : ""}`;
    case "play_levels": return `play_levels ${args.path ?? "?"}`;
    case "run_command": return `run \`${clip(String(args.command ?? ""), 80)}\``;
    case "edit_file": return `edit ${args.path ?? "?"}`;
    case "edit_symbol": return `edit_symbol ${args.name ?? "?"}`;
    case "create_file": return `create ${args.path ?? "?"}`;
    case "write_file": return `write ${args.path ?? "?"}`;
    case "done": return `done`;
    default: return tool;
  }
}

// Format a short elapsed time, e.g. 480ms, 1.2s, 1m03s — so a slow step is visible.
export function fmtElapsed(ms) {
  const n = Number(ms || 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60000), s = Math.round((n % 60000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

// A SEMANTIC one-line summary of a tool result — what actually happened, not the raw dump. Pure +
// testable. `diff`/`diffs` are the recorded edit diffs (from session.lastDiff/lastDiffs) when relevant.
export function summarizeResult({ tool, args = {}, result, diff, diffs } = {}, diffStat) {
  const r = result || {};
  if (r.denied) return "blocked";
  // run_command keeps its exit-code summary even on failure (more useful than the raw error text).
  if (r.ok === false && tool !== "run_command") return clip(String(r.error || "failed").replace(/\s+/g, " "), 80);
  const ds = (a, b) => (typeof diffStat === "function" ? diffStat(a, b) : { add: 0, del: 0 });
  switch (tool) {
    case "edit_file": case "create_file": case "edit_symbol": case "write_file": {
      if (diff) { const s = ds(diff.before, diff.after); return `+${s.add} -${s.del}${r.tier ? ` (${r.tier})` : ""}`; }
      return r.tier ? `(${r.tier})` : "written";
    }
    case "edit_files": {
      if (diffs && diffs.length) { let a = 0, d = 0; for (const x of diffs) { const s = ds(x.before, x.after); a += s.add; d += s.del; } return `${diffs.length} file${diffs.length === 1 ? "" : "s"} +${a} -${d}`; }
      return "applied";
    }
    case "run_command": return r.ok ? "exit 0" : `exit ${r.exitCode ?? "?"}`;
    case "read_file": return r.lines != null ? `${r.lines} lines` : "read";
    case "list_dir": return Array.isArray(r.entries) ? `${r.entries.length} entries` : "listed";
    case "grep": return r.matches != null ? `${r.matches} hit${r.matches === 1 ? "" : "s"}` : (Array.isArray(r.hits) ? `${r.hits.length} hits` : "searched");
    case "glob": return Array.isArray(r.files) ? `${r.files.length} files` : "matched";
    case "find_symbol": case "find_refs": return Array.isArray(r.results) ? `${r.results.length} found` : (r.note ? clip(r.note, 60) : "");
    case "repo_map": return r.files != null ? `${r.files} files` : "mapped";
    case "plan": return `${r.steps?.length ?? args.steps?.length ?? 0} steps`;
    case "replan": return `replanned (${r.steps?.length ?? 0})`;
    case "task_write": return r.tasks != null ? `${r.tasks} tasks` : "updated";
    case "parallel": return `${r.count ?? "?"} subtasks${r.failed ? `, ${r.failed} failed` : ""}`;
    case "pipeline": return `${r.count ?? "?"} stages${r.failed ? `, ${r.failed} failed` : ""}`;
    case "see_page": return clip(r.note || "rendered", 70);
    case "see_asset": return "rendered";
    case "compare_image": return r.similarity != null ? `${r.similarity}% match` : "compared";
    case "compare_regions": return r.whole != null ? `${r.whole}% whole · ${r.assetsOff?.length ? r.assetsOff.length + " off" : "all pass"}` : "compared";
    case "crop_image": return r.width ? `${r.width}×${r.height}` : "cropped";
    case "style_profile": return Array.isArray(r.palette) ? `${r.palette.length} colors` : "profiled";
    case "style_check": return r.adherence != null ? `${r.adherence}% in-style` : "checked";
    case "orbit_scene": return r.responds != null ? `${r.views} views · ${r.responds ? "real 3D" : "flat!"}` : "orbited";
    case "world_map": return r.coverage ? `${r.coverage.regions} regions` : (r.map ? "map" : "ok");
    case "play_game": return r.played ? `played${Array.isArray(r.snapshots) ? ` ${r.snapshots.length} snaps` : ""}` : "no contract";
    case "play_levels": return r.count != null ? `${r.count} levels · ${r.uniqueLevels} distinct${r.clones?.length ? ` · ${r.clones.length} CLONES` : ""}` : "drove levels";
    case "blueprint_plan": return r.coverage ? `${r.coverage.totalLeaves} leaves` : "planned";
    case "blueprint_status": case "blueprint_audit": return r.coverage ? `${r.coverage.done}/${r.coverage.totalLeaves} done (${r.coverage.pct}%)` : "";
    case "resume": return r.hasState ? (r.coverage ? `resumed · ${r.coverage.done}/${r.coverage.totalLeaves} done` : "resumed") : "fresh project";
    case "blueprint_mark": return r.coverage ? `${r.node?.status || "marked"} · ${r.coverage.done}/${r.coverage.totalLeaves}` : "marked";
    case "web_search": return Array.isArray(r.results) ? `${r.results.length} results` : "searched";
    case "web_fetch": return r.title ? clip(r.title, 60) : "fetched";
    case "git_commit": return "committed";
    case "git_status": case "git_diff": return clip(r.note || "ok", 60);
    default: return r.note ? clip(String(r.note).replace(/\s+/g, " "), 70) : "";
  }
}

// The agent's brief reasoning, as a dim "why" line (or "" when there's none). Pure.
export function reasoningLine(text, palette) {
  const t = clip(String(text || "").trim(), 110);
  return t ? `  ${palette.dim("› " + t)}` : "";
}

// The in-progress line shown BEFORE a (possibly slow) tool runs. Pure.
export function runningLine({ tool, args, palette }) {
  return `  ${palette.cyan("●")} ${describeStep({ tool, args })} ${palette.dim("…")}`;
}

// A committed step line WITH a semantic summary and elapsed time. status ∈ 'ok'|'fail'|'skip'.
export function committedLine({ tool, args, status = "ok", summary = "", elapsedMs, palette }) {
  const p = palette;
  const icon = status === "fail" ? p.red("✗") : status === "skip" ? p.yellow("∅") : p.green("✓");
  const desc = describeStep({ tool, args });
  const sum = summary ? "  " + p.dim(summary) : "";
  const time = (elapsedMs != null && elapsedMs >= 800) ? p.dim(" · " + fmtElapsed(elapsedMs)) : "";
  return `  ${icon} ${desc}${sum}${time}`;
}

// A single rendered step line for streaming output. status ∈ 'run'|'ok'|'fail'|'skip'.
export function stepLine({ tool, args, status = "ok", extra = "", palette }) {
  const p = palette;
  const icon = status === "fail" ? p.red("✗") : status === "skip" ? p.yellow("∅")
    : status === "run" ? p.cyan("●") : p.green("✓");
  const desc = describeStep({ tool, args });
  const tail = extra ? p.dim(" " + extra) : "";
  return `  ${icon} ${desc}${tail}`;
}

// A live progress renderer: shows the agent's reasoning (the WHY), a "● doing X …" line BEFORE a tool
// runs (so a slow step never looks frozen), then OVERWRITES it in place on a TTY with a "✓ X  summary ·
// 1.2s" committed line. Off a TTY (piped/CI) it degrades to plain committed lines (no cursor tricks).
//   getSummary(info) -> a semantic one-line summary (caller binds it to session/diff state)
//   afterCommit(info) -> render any extra block (diffs, sub-results, task checklist) after the line
// Returns { onToolStart, onStep } to hand straight to runTurn.
export function makeLiveRenderer({ out, palette, isTTY = false, getSummary = () => "", afterCommit = () => {}, getStatus } = {}) {
  const p = palette;
  let pending = false; // a running line is on screen awaiting overwrite (TTY only)
  const write = (s) => { try { out(s); } catch { /* */ } };
  return {
    onToolStart({ tool, args, reasoning }) {
      if (tool === "done") return;
      const why = reasoningLine(reasoning, p);
      if (why) write(why + "\n");
      if (isTTY) { write(runningLine({ tool, args, palette: p }) + "\n"); pending = true; }
    },
    onStep(info) {
      const { tool, args, result, denied, elapsedMs } = info;
      if (tool === "done") return;
      const status = (typeof getStatus === "function" ? getStatus(info) : null)
        || (denied ? "skip" : result?.ok === false ? "fail" : "ok");
      let summary = ""; try { summary = getSummary(info) || ""; } catch { /* */ }
      const line = committedLine({ tool, args, status, summary, elapsedMs, palette: p });
      if (pending) { write("\x1b[1A\x1b[2K" + line + "\n"); pending = false; } // overwrite the running line
      else write(line + "\n");
      try { afterCommit(info); } catch { /* */ }
    },
  };
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString("en-US");
}

// Format a USD cost without collapsing real spend to "$0.0000". Below the 4-decimal floor we show
// "<$0.0001" so a nonzero cost is never displayed as exactly zero.
export function formatCost(cost) {
  const c = Number(cost || 0);
  if (c <= 0) return "$0.0000";
  if (c < 0.0001) return "<$0.0001";
  return "$" + c.toFixed(4);
}

// Per-turn footer, e.g.  · 4 turns · 5,912 tok · $0.0021
// status: 'ok' (default) | 'error' | 'interrupted' | 'incomplete' — tints the leading marker so a
// failed/aborted turn doesn't read as a successful one.
export function footer({ turns, totalTokens, cost, model, status = "ok" }, palette) {
  const p = palette;
  const parts = [
    `${turns} turn${turns === 1 ? "" : "s"}`,
    `${formatNumber(totalTokens)} tok`,
    formatCost(cost),
  ];
  if (model) parts.push(p.gray(model));
  const body = parts.join(" · ");
  if (status === "error") return p.red("✗") + " " + p.dim(body);
  if (status === "interrupted" || status === "incomplete") return p.yellow("∅") + " " + p.dim(body);
  return p.dim("· " + body);
}

// Keep a path from blowing past the terminal width by eliding the middle of long paths.
function shortPath(cwd, max = 48) {
  const s = String(cwd || "");
  return s.length > max ? "…" + s.slice(-(max - 1)) : s;
}

// Banner shown when the REPL starts.
export function banner({ model, approval, cwd }, palette) {
  const p = palette;
  return [
    p.bold("slivr") + p.dim(" — interactive coding agent"),
    p.gray(`model ${model} · approval ${approval}`),
    p.gray(`dir ${shortPath(cwd)}`),
    p.gray("type a request, or /help for commands. /exit to quit."),
  ].join("\n");
}

// --- plan-mode + task-management presentation ---------------------------------

// Render a recorded plan as a numbered list. plan = { steps:[...], approved }.
export function renderPlan(plan, palette) {
  const p = palette || makePalette(false);
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return p.dim("(no plan)");
  const head = p.bold("plan") + p.dim(` (${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"})`);
  const width = String(plan.steps.length).length; // right-align numbers so 1..10+ stay aligned
  const body = plan.steps.map((s, i) => `  ${p.cyan(String(i + 1).padStart(width) + ".")} ${s}`).join("\n");
  return head + "\n" + body;
}

const TASK_GLYPH = { pending: "☐", in_progress: "◐", completed: "✓" };

// Render the live task checklist. tasks = [{id, subject, status}].
export function renderTasks(tasks, palette) {
  const p = palette || makePalette(false);
  if (!Array.isArray(tasks) || !tasks.length) return p.dim("(no tasks)");
  const lines = tasks.map((t) => {
    const g = TASK_GLYPH[t.status] || "☐";
    const mark = t.status === "completed" ? p.green(g)
      : t.status === "in_progress" ? p.yellow(g) : p.dim(g);
    const label = t.status === "completed" ? p.dim(t.subject) : t.subject;
    return `  ${mark} ${label}`;
  });
  const done = tasks.filter(t => t.status === "completed").length;
  return p.bold("tasks") + p.dim(` (${done}/${tasks.length})`) + "\n" + lines.join("\n");
}

// Consistent wording for prompts that can't run without a TTY.
const NON_INTERACTIVE = "(non-interactive — defaulting to no)";

// Ask a single question. When `rl` is provided we REUSE it (so we don't open a second readline on
// the same stdin, which tangles keystrokes); otherwise we open and close a throwaway interface.
function ask(query, { input = process.stdin, output = process.stdout, rl } = {}) {
  return new Promise((resolve) => {
    if (rl) return rl.question(query, (ans) => resolve(ans));
    const tmp = readline.createInterface({ input, output });
    tmp.question(query, (ans) => { tmp.close(); resolve(ans); });
  });
}

// Three-way plan prompt: yes / edit / no. Returns "yes" | "edit" | "no". Non-TTY -> "no".
// (auto-approval is handled by the caller before this is ever invoked.) Capital letter = default.
export async function planPrompt(question, opts = {}) {
  const { input = process.stdin, output = process.stdout } = opts;
  if (!input.isTTY) { output.write(question + " " + NON_INTERACTIVE + "\n"); return "no"; }
  const ans = (await ask(question + " [y]es / [e]dit / [n]o: ", opts) || "").trim().toLowerCase();
  if (/^e/.test(ans)) return "edit";
  if (/^n/.test(ans)) return "no";
  return "yes"; // default yes (Enter)
}

// Read a multi-line revised plan from the user (one step per line; blank line ends). Returns an
// array of steps, or `null` if the user CANCELS (first line is blank, or "q"/"cancel") — callers
// must treat null as "go back / do not silently approve". `existing` is shown for reference.
export function readPlanEdit({ input = process.stdin, output = process.stdout, rl, existing = [] } = {}) {
  return new Promise((resolve) => {
    if (!input.isTTY) return resolve(null);
    if (existing.length) output.write("current plan:\n" + existing.map((s, i) => `  ${i + 1}. ${s}`).join("\n") + "\n");
    output.write("enter revised plan, one step per line; blank line on the FIRST line cancels, blank line after steps finishes:\n");
    const steps = [];
    const own = !rl;
    const r = rl || readline.createInterface({ input, output });
    r.setPrompt && r.setPrompt("  · ");
    const onLine = (line) => {
      const t = line.trim();
      if (!t) { finish(); return; }
      if (steps.length === 0 && /^(q|cancel)$/i.test(t)) { steps.cancelled = true; finish(); return; }
      steps.push(t);
      r.prompt && r.prompt();
    };
    const finish = () => {
      r.removeListener("line", onLine);
      if (own) r.close();
      resolve(steps.cancelled || steps.length === 0 ? null : steps);
    };
    r.on("line", onLine);
    r.prompt && r.prompt();
  });
}

// y/N confirmation. Returns a Promise<boolean>. Default is NO. Non-TTY -> false.
export async function confirm(question, opts = {}) {
  const { input = process.stdin, output = process.stdout } = opts;
  if (!input.isTTY) { output.write(question + " " + NON_INTERACTIVE + "\n"); return false; }
  const ans = (await ask(question + " [y/N] ", opts) || "").trim();
  return /^y(es)?$/i.test(ans);
}

// Approval prompt with batch controls. Returns "yes" | "no" | "all" | "stop":
//   y = allow this   ·   n/Enter = deny this   ·   a = allow all like this for the rest of the turn
//   s = stop (deny this and everything else this turn). Non-TTY -> "no".
export async function approvalPrompt(question, opts = {}) {
  const { input = process.stdin, output = process.stdout } = opts;
  if (!input.isTTY) { output.write(question + " " + NON_INTERACTIVE + "\n"); return "no"; }
  const ans = (await ask(question + " [y]es / [N]o / [a]ll / [s]top: ", opts) || "").trim().toLowerCase();
  if (/^a/.test(ans)) return "all";
  if (/^s/.test(ans)) return "stop";
  if (/^y(es)?$/.test(ans)) return "yes";
  return "no"; // default deny
}
