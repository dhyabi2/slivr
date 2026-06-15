// repl.mjs — interactive multi-turn session.
//
// `slivr` (no task) opens this. You type a request, the agent works (streaming each step with a
// compact diff for edits), then you type the next — the conversation + tool results PERSIST across
// turns (Session keeps the thread). Ctrl-C interrupts the CURRENT turn without killing the session;
// a second Ctrl-C at the prompt exits. REPL commands: /help /model /cost /reset /exit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Session, planGate } from "./agent.mjs";
import { makePalette, colorEnabled, stepLine, footer, banner, confirm, approvalPrompt, renderPlan, renderTasks, planPrompt, readPlanEdit, makeLiveRenderer, summarizeResult } from "./ui.mjs";
import { renderDiff, diffStat } from "./diff.mjs";
import { isDestructive, needsApproval } from "./safety.mjs";
import { applyEdit as _applyEdit } from "./seal.mjs";
import { listSkills, renderSkill, discoverSkills } from "./skills.mjs";
import { spawn } from "node:child_process";
import { listJobs } from "./jobs.mjs";
import { runHintLine, detectRunHint, findArtifact, osOpen, launchVerb, isDemonstrateRequest } from "./run_hint.mjs";
import { detectCommands } from "./project.mjs";
import { resumeSummary, appendJournal } from "./journal.mjs";

// Persist an API key to ~/.slivr.json (merging into any existing config). Returns true on success.
function saveKeyToConfig(key) {
  try {
    const file = path.join(os.homedir(), ".slivr.json");
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* new or unparseable → start fresh */ }
    cfg.apiKey = key;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    return true;
  } catch { return false; }
}

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
  /key <sk-or-…>   set + save your OpenRouter API key (to ~/.slivr.json)
  /model <id>      switch model (e.g. anthropic/claude-sonnet-4, openai/gpt-4o)
  /cost            show session tokens + cost so far
  /plan [on|off]   toggle plan-mode (agent must plan + get approval before editing)
  /skills          list available skills (.slivr/skills/*.md, ~/.slivr/skills/*.md)
  /run <name> [..] run a skill as a task (also: /<name> [..] if not a built-in command)
  /mcp             list connected MCP servers + tools (and any that failed to connect)
  /jobs            list background jobs started with \`slivr bg\`
  /clear           clear the screen
  /reset           clear the conversation context (keeps cost totals)
  /exit            quit
modes: [edits] prompt before edits/commands · [auto] no prompts · [plan] plan + approve before editing
keys: Shift-Tab (or Tab) cycle mode [edits → auto → plan] (at the prompt)  ·  Ctrl-C interrupt turn  ·  ↑/↓ history
background: run \`slivr bg "<task>"\`, \`slivr jobs\`, \`slivr logs <id>\`, \`slivr schedule …\` from your shell.
anything else is sent to the agent as a request.`;

export async function startRepl({ workdir, config, palette } = {}) {
  const p = palette || makePalette(colorEnabled());
  const session = new Session(workdir, {
    model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl,
    maxSteps: config.maxSteps, maxTokensPerTurn: config.maxTokensPerTurn,
    // surface transient provider events (retry / timeout) so a slow call isn't a silent hang.
    notify: (m) => process.stdout.write(p.dim(`  … ${m}\n`)),
  });
  let approval = config.approval;

  // No key: show clear, actionable guidance (the agent still opens so the user can read it).
  if (!session.provider.hasKey()) {
    process.stdout.write(p.yellow("no API key — the agent can't call the model.\n"));
    process.stdout.write(p.dim("  set one right here:  ") + p.cyan("/key sk-or-…") + p.dim("   (saved to ~/.slivr.json · keys: https://openrouter.ai/keys)\n"));
  }
  // Connect any configured MCP servers up front; their tools become callable as mcp__<server>__<tool>.
  if (config.mcpServers) {
    const { catalog, errors } = await session.connectMCP(config.mcpServers);
    if (catalog.length) process.stdout.write(p.dim(`mcp · ${catalog.length} tool(s) from ${session.mcpClients.length} server(s)\n`));
    for (const e of errors) process.stdout.write(p.yellow(`mcp · ${e.server} failed to connect — see /mcp for details\n`));
  }
  process.stdout.write(banner({ model: session.provider.model, approval, cwd: workdir }, p) + "\n\n");
  // Session continuity (Block 25): if prior work exists here, show "where you left off" so a NEW window
  // immediately has context instead of starting blind.
  try {
    const r = resumeSummary(workdir);
    if (r.hasState) process.stdout.write(p.bold("↩ resuming") + "\n" + r.text.split("\n").map((l) => p.dim("  " + l)).join("\n") + "\n\n");
  } catch { /* never block startup on orientation */ }

  // the active mode is shown in the prompt; Shift-Tab / Tab (at the prompt) cycles it.
  const modeKey = () => session.tools.planMode ? "plan" : approval;   // edits | auto | all | plan
  const displayMode = () => modeKey();
  const promptStr = () => p.cyan("slivr ") + p.dim("[" + displayMode() + "]") + p.cyan("› ");
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, prompt: promptStr(),
    completer: (line) => [[], line],         // suppress Tab autocomplete — Tab is used for mode cycling
  });

  // Ctrl-C handling: during a turn -> abort the turn; at the prompt -> a second press exits.
  let currentAbort = null;
  let sigintArmed = false;
  // True while an in-turn prompt (approval / plan) owns stdin, so the main line handler stands down.
  let inPrompt = false;
  const prompting = async (fn) => { inPrompt = true; try { return await fn(); } finally { inPrompt = false; } };
  // Per-turn approval state (reset at the start of every turn): "allow the rest" / "stop the turn".
  let approveAll = false, stopTurn = false;
  let createdThisTurn = [];   // files the agent created this turn → drives the "▶ run it" hint

  // Tab cycles the mode  ask → auto → plan → ask — at the prompt AND mid-turn. Switching mid-turn
  // takes effect for the REST of the running turn (e.g. flip to [auto] to stop being asked), so it's
  // always announced clearly so it never feels silent.
  const MODES = ["edits", "auto", "plan"];
  const cycleMode = () => {
    const next = MODES[(MODES.indexOf(modeKey()) + 1) % MODES.length];
    if (next === "plan") session.tools.planMode = true;
    else { session.tools.planMode = false; approval = next; }
    rl.setPrompt(promptStr());
    const note = currentAbort ? " (applies to the rest of this turn)" : "";
    process.stdout.write("\n" + p.cyan(`  mode → ${displayMode()}`) + p.dim(note) + "\n");
    if (!currentAbort && !inPrompt) rl.prompt(true);   // redraw the prompt only when idle
  };
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on("keypress", (_s, key) => {
      // Allow mode-cycling any time EXCEPT while an approval/plan prompt owns stdin (Tab there is the
      // user's answer, not a mode switch). Works mid-turn so you can flip to [auto] while it runs.
      if (key && key.name === "tab" && !inPrompt) cycleMode();
    });
  }
  let inDemo = false;   // true while a demonstrated artifact is running attached to the terminal
  rl.on("SIGINT", () => {
    if (inDemo) return;                                  // Ctrl-C belongs to the running demo child
    if (currentAbort) { currentAbort.abort(); return; }  // interrupt the running turn
    if (sigintArmed) { rl.close(); return; }
    sigintArmed = true;
    process.stdout.write(p.dim("\n(^C again to exit)\n"));
    rl.prompt();
    setTimeout(() => { sigintArmed = false; }, 1500);
  });

  // Demonstrate a just-built artifact: offer to OPEN it (browser) or RUN it (terminal) — the "show me"
  // the user actually wanted, not just a command to copy. Default yes; declining leaves the hint.
  const demonstrate = async (hint, { ask = true } = {}) => {
    if (ask) {
      const yes = await prompting(() => new Promise((resolve) => {
        rl.question(p.bold(`  ${launchVerb(hint.kind)} now?`) + p.dim(" [Y/n] "), (a) => resolve(!/^\s*n/i.test(a || "")));
      }));
      if (!yes) return;
    }
    if (hint.kind === "open") {
      const ok = osOpen(workdir, hint.target);
      process.stdout.write(ok ? p.green(`  ✓ opened ${hint.target} in your browser\n`) : p.yellow("  couldn't open it automatically — run it yourself with the command above\n"));
      return;
    }
    // run / serve → hand the terminal to the program so the user can actually use it.
    process.stdout.write(p.dim(hint.kind === "serve" ? "  starting it — press Ctrl-C to stop and return to slivr.\n" : "  running it — press Ctrl-C to stop and return.\n"));
    await new Promise((resolve) => {
      inDemo = true;
      rl.pause();
      let child;
      try { child = spawn(hint.cmd, { cwd: workdir, shell: true, stdio: "inherit" }); }
      catch (e) { process.stdout.write(p.yellow(`  could not run it: ${e.message}\n`)); inDemo = false; rl.resume(); return resolve(); }
      const finish = () => { inDemo = false; rl.resume(); resolve(); };
      child.on("exit", finish);
      child.on("error", (e) => { process.stdout.write(p.yellow(`  could not run it: ${e.message}\n`)); finish(); });
    });
  };

  // Plan-approval (interactive): show the recorded plan and ask y/e/n. Edit replaces the steps.
  const approvePlan = async () => {
    const pl = session.tools.plan;
    if (!pl || pl.approved) return;
    process.stdout.write("\n" + renderPlan(pl, p) + "\n");
    if (approval === "auto") {
      pl.approved = true;
      // Make the interaction between plan-mode and auto-approval explicit instead of silent.
      process.stdout.write(p.yellow("  (auto-approved — approval mode is 'auto'; switch to [ask] to review plans before they run)\n"));
      return;
    }
    // Loop so that cancelling an edit returns to the y/e/n prompt rather than silently approving.
    while (true) {
      const verdict = await prompting(() => planPrompt("proceed?", { rl }));
      if (verdict === "yes") { pl.approved = true; return; }
      if (verdict === "no") { session.tools._planAborted = true; return; }
      const steps = await prompting(() => readPlanEdit({ rl, existing: pl.steps }));
      if (steps && steps.length) {
        session.tools.plan = { steps, approved: true };
        process.stdout.write(renderPlan(session.tools.plan, p) + "\n");
        return;
      }
      process.stdout.write(p.dim("  (edit cancelled — choose again)\n"));
    }
  };

  // beforeTool: enforce hard blocklist + plan-gate + approval prompts.
  const beforeTool = async ({ tool, args }) => {
    if (stopTurn) return { deny: true, reason: "user stopped this turn; call done." };
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
      if (approveAll) return { deny: false };   // user already chose "all" this turn
      // Show the action with a diff preview wherever we can compute one.
      let preview = "";
      if (tool === "run_command") preview = p.yellow(`  run: ${args.command}`);
      else if (tool === "edit_file") {
        const cur = session._readSafe(args.path).content ?? "";
        const next = previewEdit(cur, args);
        preview = p.dim(`  edit ${args.path}`) + (next != null
          ? "\n" + renderDiff(cur, next, { color: p.enabled, path: args.path })
          : p.yellow("  (preview unavailable — anchor may not match; you'd be approving blind)"));
      } else if (tool === "create_file") {
        preview = p.dim(`  create ${args.path}`) + "\n" + renderDiff("", args.content || "", { color: p.enabled, path: args.path });
      } else if (tool === "edit_symbol") {
        const pv = session.tools.previewSymbolEdit(args);
        preview = pv.ok
          ? p.dim(`  edit_symbol ${args.name} → ${pv.path}:${pv.range[0]}-${pv.range[1]}`) + "\n" + renderDiff(pv.before, pv.after, { color: p.enabled, path: pv.path })
          : p.dim(`  edit_symbol ${args.name}`) + p.yellow(`  (cannot preview: ${pv.error})`);
      } else if (tool === "edit_files") {
        const previews = previewEdits(session, args);
        const n = Array.isArray(args.edits) ? args.edits.length : 0;
        preview = p.dim(`  edit_files (${n} edit${n === 1 ? "" : "s"} across ${previews.length} file${previews.length === 1 ? "" : "s"})`);
        for (const pv of previews) {
          preview += pv.next != null
            ? "\n" + renderDiff(pv.before, pv.next, { color: p.enabled, path: pv.path })
            : "\n" + p.dim(`  ${pv.path}`) + p.yellow("  (preview unavailable — approving blind)");
        }
      } else {
        preview = p.dim(`  ${tool} ${args.path || ""}`);
      }
      process.stdout.write(preview + "\n");
      const verdict = await prompting(() => approvalPrompt(p.bold("apply?"), { rl }));
      if (verdict === "all") { approveAll = true; return { deny: false }; }
      if (verdict === "stop") { stopTurn = true; process.stdout.write(p.dim("  (stopping — denying the rest of this turn)\n")); return { deny: true, reason: "user chose to stop; call done." }; }
      if (verdict === "yes") return { deny: false };
      return { deny: true, reason: "user declined this action" };
    }
    return { deny: false };
  };

  let lastTasksRender = "";
  const w = (s) => process.stdout.write(s);
  const getStatus = ({ tool, result, denied }) => {
    if (denied) return "skip";
    if (tool === "parallel" && result?.ok && result.failed > 0) return "fail"; // partial = not clean
    return result?.ok === false ? "fail" : "ok";
  };
  const getSummary = ({ tool, args, result }) => {
    if (result?.ok) {
      if ((tool === "create_file" || tool === "edit_file") && args?.path) createdThisTurn.push(args.path);
      else if (tool === "edit_symbol" && result.file) createdThisTurn.push(result.file);
      else if (tool === "edit_files" && Array.isArray(result.files)) createdThisTurn.push(...result.files);
    }
    const diff = (tool === "edit_file" || tool === "create_file" || tool === "edit_symbol") ? session.lastDiff : undefined;
    const diffs = tool === "edit_files" ? session.lastDiffs : undefined;
    return summarizeResult({ tool, args, result, diff, diffs }, diffStat);
  };
  const afterCommit = ({ tool, result }) => {
    if (tool === "parallel" && result?.ok) {
      for (const r of result.results) w(p.dim(`    ↳ ${r.done ? "✓" : r.error ? "✗" : "·"} ${r.task.slice(0, 60)} — ${(r.summary || r.findings || r.error || "").replace(/\s+/g, " ").slice(0, 120)}\n`));
    }
    if (tool === "task_write" && result?.ok) {
      const rt = renderTasks(session.tools.tasks, p); if (rt !== lastTasksRender) { w(rt + "\n"); lastTasksRender = rt; }
    }
    const showDiff = !needsApproval(tool, approval) && !approveAll;
    if ((tool === "edit_file" || tool === "create_file" || tool === "edit_symbol") && result?.ok && session.lastDiff && showDiff) {
      const { before, after, path: dp } = session.lastDiff;
      const d = renderDiff(before, after, { color: p.enabled, path: dp, context: 2 });
      if (d) w(d.split("\n").map(l => "    " + l).join("\n") + "\n");
    }
    if (tool === "edit_files" && result?.ok && session.lastDiffs && showDiff) {
      for (const dd of session.lastDiffs) { const d = renderDiff(dd.before, dd.after, { color: p.enabled, path: dd.path, context: 2 }); if (d) w(d.split("\n").map(l => "    " + l).join("\n") + "\n"); }
    }
  };
  const _live = makeLiveRenderer({ out: w, palette: p, isTTY: !!process.stdout.isTTY, getSummary, afterCommit, getStatus });
  const onStep = _live.onStep;
  const onToolStart = _live.onToolStart;
  const onThinking = _live.onThinking;

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
        const stop = await handleCommand(command, { session, p, rl, workdir, prompting, get approval() { return approval; }, set approval(v) { approval = v; } });
        if (stop === "exit") { exited = true; break; }
        // A skill command (/run <name> or /<name>) resolves to a task string to run as a turn.
        if (stop && typeof stop === "object" && stop.runTask) { taskToRun = stop.runTask; }
        else { safePrompt(); continue; }
      }

      // "run it" / "open it" / "run in browser" / "show me" → slivr LAUNCHES the artifact directly,
      // instead of sending it to the model (which just describes how to open it). This is what the
      // user means by "run in browser": actually open it.
      if (!command) {
        const demo = isDemonstrateRequest(taskToRun);
        if (demo) {
          const art = findArtifact(workdir, { preferWeb: demo.browser });
          // also handle an EXISTING project (no artifact built this session): use its run command.
          const proj = !art ? detectCommands(workdir) : null;
          const projCmd = proj && (proj.run?.cmd || proj.test?.cmd);
          const hint = art || (projCmd ? { what: proj.ecosystem || "the project", cmd: projCmd, kind: "serve" } : null);
          if (hint) {
            if (process.stdin.isTTY) await demonstrate(hint, { ask: false });
            else process.stdout.write(p.cyan(`▶ run ${hint.what} with:  ${hint.cmd}\n`));
          } else {
            process.stdout.write(p.yellow("nothing runnable found here yet — build something first, then say \"run it\".\n"));
          }
          safePrompt();
          continue;
        }
      }

      // A normal request (or a resolved skill) -> run a turn (input paused so Ctrl-C maps to abort).
      // Each turn starts fresh wrt plan approval so a new request must be re-planned in plan-mode.
      session.tools.plan = null; session.tools._planAborted = false;
      approveAll = false; stopTurn = false;   // per-turn approval state
      createdThisTurn = [];
      currentAbort = new AbortController();
      let res;
      try {
        res = await session.runTurn(taskToRun, { onStep, onToolStart, onThinking, beforeTool, signal: currentAbort.signal });
      } catch (e) {
        process.stdout.write(p.red(`error: ${e.message}\n`));
        currentAbort = null;
        safePrompt();
        continue;
      }
      currentAbort = null;

      // Session continuity (Block 25): record a journal handoff so the NEXT session can resume.
      if (res && !res.aborted && !res.error) {
        try { appendJournal(workdir, { task: taskToRun, summary: res.summary || res.stopped || "(no summary)", files: createdThisTurn, next: res.stopped ? "resolve: " + res.stopped : "" }); } catch { /* */ }
      }

      // Surface the turn's outcome clearly: interrupted / hard error / stopped (step-limit or stuck)
      // / normal summary — so a turn never ends as just a bare footer with no explanation.
      let footerStatus = "ok";
      if (res.aborted) { process.stdout.write(p.yellow("\n∅ interrupted\n")); footerStatus = "interrupted"; }
      else if (res.error) {
        process.stdout.write(p.red(`\n✗ ${res.error}\n`)); footerStatus = "error";
        if (/no API key/i.test(res.error)) process.stdout.write(p.dim("  set one now:  ") + p.cyan("/key sk-or-…") + "\n");
      }
      else {
        if (res.summary) process.stdout.write("\n" + res.summary + "\n");
        if (res.stopped) { process.stdout.write(p.yellow(`\n∅ ${res.stopped}\n`)); footerStatus = "incomplete"; }
        else if (!res.summary) process.stdout.write(p.dim("\n(done — no summary)\n"));
        // Anticipate intent (Blocks 9 & 10): if the turn built a runnable artifact, show how to run it
        // AND offer to actually demonstrate it (open the browser / run it), so "show me" really shows.
        if (createdThisTurn.length) {
          const hint = detectRunHint(workdir, createdThisTurn);
          if (hint) {
            process.stdout.write("\n" + p.cyan(`▶ run ${hint.what} with:  ${hint.cmd}`) + "\n");
            // Only OFFER to open it when the work is COMPLETELY done: the turn finished cleanly (done,
            // not stopped) AND — for a web page — it actually WORKS (no JS/console errors, not blank).
            // Otherwise just show the command; never ask to open an unfinished or broken page.
            let okToOpen = process.stdin.isTTY && res.done && !res.stopped;
            // not "completely done" if the agent's OWN task checklist still has incomplete items.
            const openTasks = (session.tools.tasks || []).filter((t) => t.status !== "completed");
            if (okToOpen && openTasks.length) {
              okToOpen = false;
              process.stdout.write(p.yellow(`  ⚠ not opening — ${openTasks.length} task${openTasks.length === 1 ? "" : "s"} still incomplete (the work isn't finished):\n`) + openTasks.slice(0, 4).map((t) => p.dim("    ☐ " + t.subject)).join("\n") + "\n" + p.dim("    ask me to finish, then it'll offer to open.\n"));
            }
            if (okToOpen && hint.kind === "open" && /\.html?$/i.test(hint.target || "")) {
              try {
                const chk = session.tools.see_page({ path: hint.target });
                if (chk && chk.broken) {
                  okToOpen = false;
                  process.stdout.write(p.yellow(`  ⚠ not opening — ${hint.target} has errors (it won't display right):\n`) + (chk.errors || []).slice(0, 4).map((e) => p.dim("    - " + e)).join("\n") + "\n" + p.dim("    fix these, then it'll offer to open.\n"));
                }
              } catch { /* if the check itself fails, fall back to offering */ }
            }
            if (okToOpen) await demonstrate(hint);
            else if (res.stopped) process.stdout.write(p.dim("  (the turn stopped before finishing — the page is likely incomplete; fix the errors above first)\n"));
          }
        }
      }
      if (session.tools.tasks.length) process.stdout.write("\n" + renderTasks(session.tools.tasks, p) + "\n");
      process.stdout.write(footer({ turns: res.turns, totalTokens: res.totals.totalTokens, cachedTokens: res.totals.cachedTokens, cost: res.totals.cost, model: session.provider.model, status: footerStatus }, p) + "\n\n");
      safePrompt();
    }
    busy = false;
    if (exited || (closed && queue.length === 0)) resolveDone();
  };

  // Paste coalescing (TTY only): an interactive multi-line paste fires one 'line' event per newline
  // in the SAME tick. We buffer them and flush on the next tick so a pasted multi-line request runs
  // as ONE turn instead of N broken ones. Piped/non-TTY input stays strictly line-oriented (scripts
  // and the e2e harness depend on one command per line), and we flush any buffer before closing.
  const coalesce = !!process.stdin.isTTY;
  let pasteBuf = [];
  let flushTimer = null;
  const flushPaste = () => {
    flushTimer = null;
    if (!pasteBuf.length) return;
    queue.push(pasteBuf.join("\n"));
    pasteBuf = [];
    pump();
  };
  rl.on("line", (line) => {
    if (inPrompt) return;                       // an in-turn prompt owns stdin right now
    if (!coalesce) { queue.push(line); pump(); return; }
    pasteBuf.push(line);
    if (!flushTimer) flushTimer = setTimeout(flushPaste, 0);
  });
  rl.on("close", () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pasteBuf.length) { queue.push(pasteBuf.join("\n")); pasteBuf = []; }
    closed = true;
    pump();   // drains any remaining queued input, then resolves via pump's end-check
  });

  // First-run onboarding: if there's no key and we're interactive, ASK for it (rather than make the
  // user discover /key). Reuses the main readline; pressing Enter skips. Saved to ~/.slivr.json.
  if (!session.provider.hasKey() && process.stdin.isTTY) {
    const k = await prompting(() => new Promise((resolve) => {
      rl.question(p.cyan("paste your OpenRouter API key (or press Enter to skip): "), (a) => resolve((a || "").trim()));
    }));
    if (k) {
      session.provider.key = k;
      if (saveKeyToConfig(k)) process.stdout.write(p.green(`✓ key saved to ${path.join(os.homedir(), ".slivr.json")}\n`));
      else process.stdout.write(p.yellow("key set for this session (could not save to ~/.slivr.json)\n"));
    } else {
      process.stdout.write(p.dim("skipped — set it any time with  /key sk-or-…\n"));
    }
  }

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
  const { session, p, rl, workdir, prompting } = ctx;
  switch (command.cmd) {
    case "":
      process.stdout.write(p.dim("type /help to see commands, or just type a request.\n"));
      return;
    case "help":
      process.stdout.write(p.dim(HELP) + "\n");
      return;
    case "key": {
      const k = (command.arg || "").trim();
      if (!k) {
        process.stdout.write(session.provider.hasKey()
          ? p.dim("an API key is set. To replace it: /key sk-or-…\n")
          : p.dim("no API key set. Usage: /key sk-or-…  (saved to ~/.slivr.json · keys: https://openrouter.ai/keys)\n"));
        return;
      }
      session.provider.key = k;   // apply to the live session immediately
      if (saveKeyToConfig(k)) process.stdout.write(p.green(`✓ key set and saved to ${path.join(os.homedir(), ".slivr.json")}\n`));
      else process.stdout.write(p.yellow("key set for this session, but could not save it to ~/.slivr.json\n"));
      if (!/^sk-/.test(k)) process.stdout.write(p.yellow("  note: that doesn't look like an OpenRouter key (expected sk-or-…).\n"));
      return;
    }
    case "clear":
      // Clear the screen + scrollback (ANSI). Distinct from /reset which clears the conversation.
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      return;
    case "mcp": {
      const cat = session.mcpCatalog || [];
      const errs = session.mcpErrors || [];
      if (!cat.length && !errs.length) { process.stdout.write(p.dim("no MCP servers configured. Add them under \"mcpServers\" in .slivr.json.\n")); return; }
      if (cat.length) {
        const byServer = {};
        for (const t of cat) (byServer[t.server] ||= []).push(t.name || t.id);
        process.stdout.write(p.bold("mcp servers") + "\n");
        for (const [srv, tools] of Object.entries(byServer)) {
          process.stdout.write(`  ${p.cyan(srv)} ${p.dim(`(${tools.length} tool${tools.length === 1 ? "" : "s"})`)}\n`);
          process.stdout.write(p.gray("    " + tools.join(", ")) + "\n");
        }
      }
      for (const e of errs) process.stdout.write(p.yellow(`  ✗ ${e.server}: `) + p.dim(String(e.error || "failed").replace(/\s+/g, " ").slice(0, 200)) + "\n");
      return;
    }
    case "jobs": {
      const jobs = (() => { try { return listJobs(); } catch { return []; } })();
      if (!jobs.length) { process.stdout.write(p.dim("no background jobs. Start one with `slivr bg \"<task>\"` from your shell.\n")); return; }
      process.stdout.write(p.bold("background jobs") + "\n");
      for (const j of jobs.slice(0, 20)) {
        const mark = j.status === "done" ? p.green("✓") : j.status === "failed" ? p.red("✗") : p.yellow("●");
        process.stdout.write(`  ${mark} ${p.dim(j.id)} ${p.gray((j.task || "").replace(/\s+/g, " ").slice(0, 60))} ${p.dim(j.status)}\n`);
      }
      process.stdout.write(p.dim("  view a job's log with: slivr logs <id>\n"));
      return;
    }
    case "skills": {
      const skills = listSkills(workdir);
      if (!skills.length) { process.stdout.write(p.dim("no skills found. Add prompts under ./.slivr/skills/*.md or ~/.slivr/skills/*.md\n")); return; }
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
      const id = command.arg.trim();
      session.setModel(id);
      process.stdout.write(p.green(`model → ${id}\n`));
      // Can't verify a model without a network round-trip, but most OpenRouter ids look like
      // "vendor/name"; flag a likely typo instead of failing silently on the next turn.
      if (!/^[\w.-]+\/[\w.:-]+$/.test(id)) process.stdout.write(p.yellow(`  note: "${id}" doesn't look like an OpenRouter model id (expected vendor/name); the next turn will fail if it's invalid.\n`));
      return;
    }
    case "cost": {
      const t = session.totals();
      process.stdout.write(p.dim(`${t.calls} calls · ${t.promptTokens.toLocaleString()} prompt / ${t.completionTokens.toLocaleString()} completion · ${t.totalTokens.toLocaleString()} tok total · $${t.cost.toFixed(4)} · ${t.model}\n`));
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
    case "reset": {
      // Wiping the conversation is irreversible — confirm first (unless context is already empty).
      if (session.messages && session.messages.length > 1 && process.stdin.isTTY) {
        const yes = await (prompting ? prompting(() => confirm("clear the conversation context? (cost totals are kept)", { rl })) : confirm("clear the conversation context?", { rl }));
        if (!yes) { process.stdout.write(p.dim("kept.\n")); return; }
      }
      session.reset();
      process.stdout.write(p.green("context cleared.\n"));
      return;
    }
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
      const suggestion = nearestCommand(command.cmd, [...BUILTIN_COMMANDS, ...skills.keys()]);
      process.stdout.write(p.yellow(`unknown command /${command.cmd}`) + (suggestion ? p.yellow(` — did you mean /${suggestion}?`) : p.dim(" — try /help or /skills")) + "\n");
      return;
    }
  }
}

const BUILTIN_COMMANDS = ["help", "key", "model", "cost", "plan", "skills", "run", "mcp", "jobs", "clear", "reset", "exit", "quit"];

// Cheap edit-distance "did you mean" for command typos. Returns the closest name within distance 2.
function nearestCommand(input, names) {
  let best = null, bestD = 3;
  for (const n of names) {
    const d = levenshtein(input, n);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}

// Like previewEdit but for a batch edit_files call: returns [{path, before, next}] applying each
// edit in order on an in-memory buffer per file (next=null if an edit's anchor wouldn't match).
function previewEdits(session, args) {
  const edits = Array.isArray(args?.edits) ? args.edits : [];
  const original = new Map(), current = new Map(), failed = new Set(), order = [];
  for (const e of edits) {
    const rel = e && e.path;
    if (!rel) continue;
    if (!original.has(rel)) {
      const c = session._readSafe(rel).content ?? "";
      original.set(rel, c); current.set(rel, c); order.push(rel);
    }
    const next = previewEdit(current.get(rel), e);
    if (next == null) failed.add(rel);
    else current.set(rel, next);
  }
  return order.map(rel => ({ path: rel, before: original.get(rel), next: failed.has(rel) ? null : current.get(rel) }));
}
