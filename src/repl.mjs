// repl.mjs — interactive multi-turn session.
//
// `cc-alt` (no task) opens this. You type a request, the agent works (streaming each step with a
// compact diff for edits), then you type the next — the conversation + tool results PERSIST across
// turns (Session keeps the thread). Ctrl-C interrupts the CURRENT turn without killing the session;
// a second Ctrl-C at the prompt exits. REPL commands: /help /model /cost /reset /exit.

import readline from "node:readline";
import { Session } from "./agent.mjs";
import { makePalette, colorEnabled, stepLine, footer, banner, confirm } from "./ui.mjs";
import { renderDiff, diffStat } from "./diff.mjs";
import { isDestructive, needsApproval } from "./safety.mjs";
import { applyEdit as _applyEdit } from "./seal.mjs";

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
  /reset           clear the conversation context (keeps cost totals)
  /exit            quit
anything else is sent to the agent as a request. Ctrl-C interrupts the current turn.`;

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
  process.stdout.write(banner({ model: config.model, approval, cwd: workdir }, p) + "\n\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: p.cyan("cc-alt› ") });

  // Ctrl-C handling: during a turn -> abort the turn; at the prompt -> a second press exits.
  let currentAbort = null;
  let sigintArmed = false;
  rl.on("SIGINT", () => {
    if (currentAbort) { currentAbort.abort(); return; } // interrupt the running turn
    if (sigintArmed) { rl.close(); return; }
    sigintArmed = true;
    process.stdout.write(p.dim("\n(^C again to exit)\n"));
    rl.prompt();
    setTimeout(() => { sigintArmed = false; }, 1500);
  });

  // beforeTool: enforce hard blocklist + approval prompts.
  const beforeTool = async ({ tool, args }) => {
    if (tool === "run_command") {
      const verdict = isDestructive(args.command || "");
      if (verdict.blocked) {
        process.stdout.write(p.red(`  ⛔ blocked: ${args.command}\n`) + p.dim(`     (${verdict.why})\n`));
        return { deny: true, reason: `refused — ${verdict.why} (hard safety block)` };
      }
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
    } else if (result?.ok === false && result?.error) {
      extra = result.error;
    }
    process.stdout.write(stepLine({ tool, args, status, extra, palette: p }) + "\n");
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
      if (command) {
        const stop = await handleCommand(command, { session, p, rl, get approval() { return approval; }, set approval(v) { approval = v; } });
        if (stop === "exit") { exited = true; break; }
        safePrompt();
        continue;
      }

      // A normal request -> run a turn (input paused so Ctrl-C maps to abort, not a new line).
      currentAbort = new AbortController();
      let res;
      try {
        res = await session.runTurn(input, { onStep, beforeTool, signal: currentAbort.signal });
      } catch (e) {
        process.stdout.write(p.red(`error: ${e.message}\n`));
        currentAbort = null;
        safePrompt();
        continue;
      }
      currentAbort = null;

      if (res.aborted) process.stdout.write(p.yellow("\n(interrupted)\n"));
      else if (res.summary) process.stdout.write("\n" + res.summary + "\n");
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
  const { session, p, rl } = ctx;
  switch (command.cmd) {
    case "help":
      process.stdout.write(p.dim(HELP) + "\n");
      return;
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
    case "reset":
      session.reset();
      process.stdout.write(p.green("context cleared.\n"));
      return;
    case "exit":
    case "quit":
      return "exit";
    default:
      process.stdout.write(p.yellow(`unknown command /${command.cmd} — try /help\n`));
      return;
  }
}
