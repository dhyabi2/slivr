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
    case "run_command": return `run \`${clip(String(args.command ?? ""), 80)}\``;
    case "edit_file": return `edit ${args.path ?? "?"}`;
    case "create_file": return `create ${args.path ?? "?"}`;
    case "write_file": return `write ${args.path ?? "?"}`;
    case "done": return `done`;
    default: return tool;
  }
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
