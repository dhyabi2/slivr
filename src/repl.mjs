// repl.mjs — interactive multi-turn session.
//
// `cc-alt` (no task) opens this. You type a request, the agent works (streaming each step with a
// compact diff for edits), then you type the next — the conversation + tool results PERSIST across
// turns (Session keeps the thread). Ctrl-C interrupts the CURRENT turn without killing the session;
// a second Ctrl-C at the prompt exits. REPL commands: /help /model /cost /reset /exit.

import readline from "node:readline";
import { Session, planGate } from "./agent.mjs";
import { makePalette, colorEnabled, stepLine, footer, banner, confirm, renderPlan, renderTasks, planPrompt, readPlanEdit } from "./ui.mjs";
import { renderDiff, diffStat } from "./diff.mjs";
import { isDestructive, needsApproval } from "./safety.mjs";
import { applyEdit as _applyEdit } from "./seal.mjs";
import { listSkills, renderSkill, discoverSkills } from "./skills.mjs";

// Pure command parser — testable without a terminal. Returns { cmd, arg } or null (not a command).
export function parseCommand(line) {
  const s = (line || "").trim();
  if (!s.startsWith("/")) return null;
  const m = s.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (!m) return { cmd: "", arg: "" };
  return { cmd: m[1].toLowerCase(), arg: (m[2] || "").trim() };
}

const HELP = `commands:
  /help            show this help
  /model <id>      switch model (e.g. anthropic/claude-sonnet-4, openai/gpt-4o)
  /cost            show session tokens + cost so far
  /plan [on|off]   toggle plan-mode (agent must plan + get approval before editing)
  /skills          list available skills (.cc-alt/skills/*.md, ~/.cc-alt/skills/*.md)
  /run <name> [..] run a skill as a task (also: /<name> [..] if not a built-in command)
  /reset           clear the conversation context (keeps cost totals)
  /exit            quit
keys: Shift-Tab (or Tab) cycle mode [edits → auto → plan]  ·  Ctrl-C interrupt turn  ·  ↑/↓ history
anything else is sent to the agent as a request.`;

export async function startRepl({ workdir, config, palette } = {}) {
  const p = palette || makePalette(colorEnabled());
  const session = new Session(workdir, {
    model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl,
    maxSteps: config.maxSteps, maxTokensPerTurn: config.maxTokensPerTurn,
  });
  let approval = config.approval;

  if (!session.provider.hasKey()) {
    process.stdout.write(p.yellow("warning: no API key found — set OPENROUTER_API_KEY or apiKey in .cc-alt.json\n"));
  }
  // Connect any configured MCP servers up front; their tools become callable as mcp__<server>__<tool>.
  if (config.mcpServers) {
    const { catalog, errors } = await session.connectMCP(config.mcpServers);
    if (catalog.length) process.stdout.write(p.dim(`mcp · ${catalog.length} tool(s) from ${session.mcpClients.length} server(s)\n`));
    for (const e of errors) process.stdout.write(p.yellow(`mcp · ${e.server} failed: ${e.error}\n`));
  }
  process.stdout.write(banner({ model: config.model, approval, cwd: workdir }, p) + "\n\n");

  // the active mode is shown in the prompt; Shift-Tab / Tab cycles it (wired up below).
  const modeLabel = () => session.tools.planMode ? "plan" : approval;   // edits | auto | plan
  const promptStr = () => p.cyan("cc-alt ") + p.dim("[" + modeLabel() + "]") + p.cyan("› ");
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, prompt: promptStr(),
    completer: (line) => [[], line],         // suppress Tab autocomplete — Tab is used for mode cycling
  });

  // Ctrl-C handling: during a turn -> abort the turn; at the prompt -> a second press exits.
  let currentAbort = null;
  let sigintArmed = false;

  // Keyboard shortcut: Shift-Tab (and Tab) cycle the mode  edits → auto → plan → edits.
  const MODES = ["edits", "auto", "plan"];
  const cycleMode = () => {
    const next = MODES[(MODES.indexOf(modeLabel()) + 1) % MODES.length];
    if (next === "plan") session.tools.planMode = true;
    else { session.tools.planMode = false; approval = next; }
    rl.setPrompt(promptStr());
    if (!currentAbort) rl.prompt(true);      // redraw the prompt label without disturbing a running turn
  };
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on("keypress", (_s, key) => { if (key && key.name === "tab") cycleMode(); });
  }
  rl.on("SIGINT", () => {
    if (currentAbort) { currentAbort.abort(); return; } // interrupt the running turn
    if (sigintArmed) { rl.close(); return; }
    sigintArmed = true;
    process.stdout.write(p.dim("\n(^C again to exit)\n"));
    rl.prompt();
    setTimeout(() => { sigintArmed = false; }, 1500);
  });

  // Plan-approval (interactive): show the recorded plan and ask y/e/n. Edit replaces the steps.
  const approvePlan = async () => {
    const pl = session.tools.plan;
    if (!pl || pl.approved) return;
    process.stdout.write("\n" + renderPlan(pl, p) + "\n");
    if (approval === "auto") { pl.approved = true; process.stdout.write(p.dim("  (auto-approved)\n")); return; }
    const verdict = await planPrompt("proceed?");
    if (verdict === "yes") pl.approved = true;
    else if (verdict === "edit") {
      const steps = await readPlanEdit();
      if (steps.length) { session.tools.plan = { steps, approved: true }; process.stdout.write(renderPlan(session.tools.plan, p) + "\n"); }
      else pl.approved = true;
    } else session.tools._planAborted = true;
  };

  // beforeTool: enforce hard blocklist + plan-gate + approval prompts.
  const beforeTool = async ({ tool, args }) => {
    if (tool === "run_command") {
      const verdict = isDestructive(args.command || "");
      if (verdict.blocked) {
        process.stdout.write(p.red(`  ⛔ blocked: ${args.command}\n`) + p.dim(`     (${verdict.why})\n`));
        return { deny: true, reason: `refused — ${verdict.why} (hard safety block)` };
      }
    }
    if (session.tools.planMode) {
      await approvePlan();
      if (session.tools._planAborted) { session.tools._planAborted = false; return { deny: true, reason: "user aborted the plan; stop and call done." }; }
      const g = planGate({ tool, tools: session.tools });
      if (g.deny) { process.stdout.write(p.yellow(`  ∅ ${tool} blocked — ${g.reason}\n`)); return g; }
    }
    if (needsApproval(tool, approval)) {
      // Show the action (and a diff preview for edits where we can compute it cheaply).
      let preview = "";
      if (tool === "run_command") preview = p.yellow(`  run: ${args.command}`);
      else if (tool === "edit_file") {
        const cur = session._readSafe(args.path).content ?? "";
        const next = previewEdit(cur, args);
        preview = p.dim(`  edit ${args.path}`) + (next != null ? "\n" + renderDiff(cur, next, { color: p.enabled, path: args.path }) : "");
      } else if (tool === "create_file") {
        preview = p.dim(`  create ${args.path}`) + "\n" + renderDiff("", args.content || "", { color: p.enabled, path: args.path });
      }
      process.stdout.write(preview + "\n");
      const yes = await confirm(p.bold("apply?"));
      if (!yes) return { deny: true, reason: "user declined" };
    }
    return { deny: false };
  };

  let lastTasksRender = "";
  const onStep = ({ tool, args, result, denied }) => {
    if (tool === "done") return;
    const status = denied ? "skip" : result?.ok === false ? "fail" : "ok";
    let extra = "";
    if ((tool === "edit_file" || tool === "create_file") && result?.ok && session.lastDiff) {
      const { before, after } = session.lastDiff;
      const stat = diffStat(before, after);
      extra = `+${stat.add} -${stat.del}` + (result.tier ? ` (${result.tier})` : "");
    } else if (tool === "run_command") {
      extra = result?.ok ? `exit 0` : `exit ${result?.exitCode ?? "?"}`;
    } else if (tool === "parallel") {
      extra = result?.ok ? `${result.count} subtasks @${result.cap}` : (result?.error || "");
    } else if (tool === "plan") {
      extra = result?.ok ? `${result.steps?.length || 0} steps` : "";
    } else if (result?.ok === false && result?.error) {
      extra = result.error;
    }
    process.stdout.write(stepLine({ tool, args, status, extra, palette: p }) + "\n");
    if (tool === "parallel" && result?.ok) {
      for (const r of result.results) process.stdout.write(p.dim(`    ↳ ${r.done ? "✓" : "·"} ${r.task.slice(0, 60)} — ${(r.summary || r.error || "").slice(0, 80)}\n`));
    }
    if (tool === "task_write" && result?.ok) {
      const rt = renderTasks(session.tools.tasks, p);
      if (rt !== lastTasksRender) { process.stdout.write(rt + "\n"); lastTasksRender = rt; }
    }
    // For edits, print the compact diff under the step line (skip when we just showed it for approval).
    if ((tool === "edit_file" || tool === "create_file") && result?.ok && session.lastDiff && !needsApproval(tool, approval)) {
      const { before, after, path: dp } = session.lastDiff;
      const d = renderDiff(before, after, { color: p.enabled, path: dp, context: 2 });
      if (d) process.stdout.write(d.split("\n").map(l => "    " + l).join("\n") + "\n");
    }
  };

  // Manual line queue: 'for await (line of rl)' loses buffered piped lines while a turn awaits.
  // We queue lines, process them serially, and pause input during a turn. Works for TTY and pipes.
  const queue = [];
  let closed = false, busy = false, exited = false, resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const safePrompt = () => { if (!closed && !exited) rl.prompt(); };

  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length && !exited) {
      const input = queue.shift().trim();
      if (!input) { safePrompt(); continue; }

      const command = parseCommand(input);
      let taskToRun = input;
      if (command) {
        const stop = await handleCommand(command, { session, p, rl, workdir, get approval() { return approval; }, set approval(v) { approval = v; } });
        if (stop === "exit") { exited = true; break; }
        // A skill command (/run <name> or /<name>) resolves to a task string to run as a turn.
        if (stop && typeof stop === "object" && stop.runTask) { taskToRun = stop.runTask; }
        else { safePrompt(); continue; }
      }

      // A normal request (or a resolved skill) -> run a turn (input paused so Ctrl-C maps to abort).
      // Each turn starts fresh wrt plan approval so a new request must be re-planned in plan-mode.
      session.tools.plan = null; session.tools._planAborted = false;
      currentAbort = new AbortController();
      let res;
      try {
        res = await session.runTurn(taskToRun, { onStep, beforeTool, signal: currentAbort.signal });
      } catch (e) {
        process.stdout.write(p.red(`error: ${e.message}\n`));
        currentAbort = null;
        safePrompt();
        continue;
      }
      currentAbort = null;

      if (res.aborted) process.stdout.write(p.yellow("\n(interrupted)\n"));
      else if (res.summary) process.stdout.write("\n" + res.summary + "\n");
      if (session.tools.tasks.length) process.stdout.write("\n" + renderTasks(session.tools.tasks, p) + "\n");
      process.stdout.write(footer({ turns: res.turns, totalTokens: res.totals.totalTokens, cost: res.totals.cost, model: session.provider.model }, p) + "\n\n");
      safePrompt();
    }
    busy = false;
    if (exited || (closed && queue.length === 0)) resolveDone();
  };

  rl.on("line", (line) => { queue.push(line); pump(); });
  rl.on("close", () => { closed = true; if (!busy) resolveDone(); });

  rl.prompt();
  await done;

  if (!closed) rl.close();
  session.closeMCP();
  const t = session.totals();
  process.stdout.write(p.dim(`\nsession: ${t.calls} calls · ${t.totalTokens.toLocaleString()} tok · $${t.cost.toFixed(4)}\n`));
  process.stdout.write(p.dim("bye.\n"));
}

// Compute what edit_file WOULD produce, for an approval preview, without writing. Best-effort:
// reuses the SEAL applier in-memory; returns null if it can't (then we just show the action).
function previewEdit(current, args) {
  try {
    if (!_applyEdit) return null;
    const res = _applyEdit(current, { anchor: args.anchor, replacement: args.replacement, op: args.op || "replace" });
    return res.ok ? res.content : null;
  } catch { return null; }
}

async function handleCommand(command, ctx) {
  const { session, p, rl, workdir } = ctx;
  switch (command.cmd) {
    case "help":
      process.stdout.write(p.dim(HELP) + "\n");
      return;
    case "skills": {
      const skills = listSkills(workdir);
      if (!skills.length) { process.stdout.write(p.dim("no skills found. Add prompts under ./.cc-alt/skills/*.md or ~/.cc-alt/skills/*.md\n")); return; }
      process.stdout.write(p.bold("skills") + p.dim("  (run with /run <name> [args] or /<name> [args])") + "\n");
      for (const s of skills) process.stdout.write(`  ${p.cyan(s.name.padEnd(14))} ${p.gray((s.description || "").slice(0, 70))}\n`);
      return;
    }
    case "run": {
      const parts = (command.arg || "").trim().split(/\s+/);
      const name = parts.shift();
      if (!name) { process.stdout.write(p.yellow("usage: /run <skill-name> [args]\n")); return; }
      const r = renderSkill(name, parts, workdir);
      if (!r.ok) { process.stdout.write(p.yellow(`no skill "${name}". available: ${r.available.join(", ") || "(none)"}\n`)); return; }
      process.stdout.write(p.dim(`running skill: ${name}\n`));
      return { runTask: r.prompt };
    }
    case "model": {
      if (!command.arg) { process.stdout.write(p.dim(`model: ${session.provider.model}\n`)); return; }
      session.setModel(command.arg);
      process.stdout.write(p.green(`model → ${command.arg}\n`));
      return;
    }
    case "cost": {
      const t = session.totals();
      process.stdout.write(p.dim(`${t.calls} calls · ${t.promptTokens.toLocaleString()} in / ${t.completionTokens.toLocaleString()} out · ${t.totalTokens.toLocaleString()} tok · $${t.cost.toFixed(4)} · ${t.model}\n`));
      return;
    }
    case "plan": {
      const arg = (command.arg || "").toLowerCase();
      if (arg === "on") session.tools.planMode = true;
      else if (arg === "off") session.tools.planMode = false;
      else session.tools.planMode = !session.tools.planMode;
      process.stdout.write(p.green(`plan-mode ${session.tools.planMode ? "ON — agent will plan + ask before editing" : "OFF"}\n`));
      return;
    }
    case "reset":
      session.reset();
      process.stdout.write(p.green("context cleared.\n"));
      return;
    case "exit":
    case "quit":
      return "exit";
    default: {
      // not a built-in command: try to run it as a skill (/<name> [args]).
      const skills = discoverSkills(workdir);
      if (skills.has(command.cmd)) {
        const args = (command.arg || "").trim().split(/\s+/).filter(Boolean);
        const r = renderSkill(command.cmd, args, workdir);
        if (r.ok) { process.stdout.write(p.dim(`running skill: ${command.cmd}\n`)); return { runTask: r.prompt }; }
      }
      process.stdout.write(p.yellow(`unknown command /${command.cmd} — try /help or /skills\n`));
      return;
    }
  }
}
