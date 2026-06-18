// repl.mjs — interactive multi-turn session.
//
// `proov` (no task) opens this. You type a request, the agent works (streaming each step with a
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
import { freePort, waitForPort } from "./server.mjs";
import { detectCommands } from "./project.mjs";
import { resumeSummary, appendJournal } from "./journal.mjs";
import { detectGameFile } from "./loop.mjs";
import { suggestNextStep } from "./nextstep.mjs";

// Persist an API key to ~/.proov.json (merging into any existing config). Returns true on success.
function saveKeyToConfig(key) {
  try {
    const file = path.join(os.homedir(), ".proov.json");
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
  /key <sk-or-…>   set + save your OpenRouter API key (to ~/.proov.json)
  /model <id>      switch model (e.g. anthropic/claude-sonnet-4, openai/gpt-4o)
  /cost            show session tokens + cost so far
  /plan [on|off]   toggle plan-mode (agent must plan + get approval before editing)
  /skills          list available skills (.proov/skills/*.md, ~/.proov/skills/*.md)
  /run <name> [..] run a skill as a task (also: /<name> [..] if not a built-in command)
  /finish [note]   keep going until ALL tasks are done & verified (auto-continue, budgeted)
  /mcp             list connected MCP servers + tools (and any that failed to connect)
  /jobs            list background jobs started with \`proov bg\`
  /clear           clear the screen
  /reset           clear the conversation context (keeps cost totals)
  /exit            quit
modes: [edits] prompt before edits/commands · [auto] no prompts · [plan] plan + approve before editing
keys: Shift-Tab (or Tab) cycle mode [edits → auto → plan] (at the prompt)  ·  Ctrl-C interrupt turn  ·  ↑/↓ history
background: run \`proov bg "<task>"\`, \`proov jobs\`, \`proov logs <id>\`, \`proov schedule …\` from your shell.
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
    process.stdout.write(p.dim("  set one right here:  ") + p.cyan("/key sk-or-…") + p.dim("   (saved to ~/.proov.json · keys: https://openrouter.ai/keys)\n"));
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
  const promptStr = () => p.cyan("proov ") + p.dim("[" + displayMode() + "]") + p.cyan("› ");
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
    // run / serve → hand the terminal to the program so the user can actually use it. For a SERVER we pick
    // a free PORT, inject it (the app should read process.env.PORT), print the http URL, and open the
    // browser there once it's listening — so "run it" on a Node app actually gives a live URL with a port.
    const isServe = hint.kind === "serve";
    let port = null, url = null;
    if (isServe) { try { port = await freePort(); url = `http://localhost:${port}`; } catch { /* no port → run without */ } }
    process.stdout.write(p.dim(isServe ? "  starting it — press Ctrl-C to stop and return to proov.\n" : "  running it — press Ctrl-C to stop and return.\n"));
    if (url) process.stdout.write(p.green("  ▶ ") + p.cyan(url) + p.dim("  (opening in your browser once it's up)\n"));
    await new Promise((resolve) => {
      inDemo = true;
      rl.pause();
      let child;
      const env = url ? { ...process.env, PORT: String(port) } : process.env;
      try { child = spawn(hint.cmd, { cwd: workdir, shell: true, stdio: "inherit", env }); }
      catch (e) { process.stdout.write(p.yellow(`  could not run it: ${e.message}\n`)); inDemo = false; rl.resume(); return resolve(); }
      if (url) waitForPort(port, { timeoutMs: 20000 }).then((up) => { if (up && inDemo) osOpen(workdir, url); });
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
    if (tool === "run_command" || tool === "start_server") {
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
      else if (tool === "install_deps") preview = p.yellow(`  install dependencies` + (args.allowScripts ? " (allowing install scripts ⚠)" : " (--ignore-scripts)"));
      else if (tool === "start_server") preview = p.yellow(`  start server: ${args.command}`);
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
  const _live = makeLiveRenderer({ out: w, palette: p, isTTY: !!process.stdout.isTTY, getSummary, afterCommit, getStatus, getTasks: () => session.tools.tasks, box: config.liveBox !== false });
  const onStep = _live.onStep;
  const onToolStart = _live.onToolStart;
  const onThinking = _live.onThinking;

  // Manual line queue: 'for await (line of rl)' loses buffered piped lines while a turn awaits.
  // We queue lines, process them serially, and pause input during a turn. Works for TTY and pipes.
  const queue = [];
  // AUTONOMOUS SELF-IMPROVE (Block 79): after a clean done, proov auto-continues to the next improvement
  // without asking. `autoImproved` remembers which structure gaps were already auto-applied (so an
  // un-fillable gap can't loop); `autoTasks` marks the auto-queued continuations so a genuine NEW user
  // request resets the guard.
  const autoImproved = new Set(), autoTasks = new Set();
  let closed = false, busy = false, exited = false, resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const safePrompt = () => { if (!closed && !exited) rl.prompt(); };

  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length && !exited) {
      const input = queue.shift().trim();
      if (autoTasks.has(input)) autoTasks.delete(input); else autoImproved.clear();   // new user request → reset the loop guard
      if (!input) { safePrompt(); continue; }

      const command = parseCommand(input);
      let taskToRun = input;
      let explicitFinish = false;
      if (command) {
        const stop = await handleCommand(command, { session, p, rl, workdir, prompting, get approval() { return approval; }, set approval(v) { approval = v; } });
        if (stop === "exit") { exited = true; break; }
        // A skill command (/run <name> or /<name>) resolves to a task string to run as a turn.
        if (stop && typeof stop === "object" && stop.runTask) { taskToRun = stop.runTask; explicitFinish = !!stop.runUntilDone; }
        else { safePrompt(); continue; }
      }
      // runUntilDone is ON BY DEFAULT (config.untilDone) — every task auto-continues to completion. `/finish`
      // forces it even if the default is off. A 1-round turn (a question, or work that finishes first try)
      // is transparent; only multi-round continuation prints status.
      const untilDone = explicitFinish || config.untilDone !== false;

      // "run it" / "open it" / "run in browser" / "show me" → proov LAUNCHES the artifact directly,
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
      let turnVerify = null;   // ground-truth verification verdict for the journal (Block 85, post-mortem #5)
      _live.begin(taskToRun);   // pin the bottom status box (timer + task tree + current task) for this run
      try {
        if (untilDone) {
          // Keep continuing the SAME thread until done/verified, or a budget / no-progress stop. The banner
          // shows only for an explicit /finish; otherwise continuation is quiet until it actually loops.
          const maxRounds = config.untilDoneMaxRounds || 12;
          const costCap = config.untilDoneCostCap > 0 ? config.untilDoneCostCap : Infinity;
          if (explicitFinish) _live.print(p.dim(`▶ finishing — up to ${maxRounds} rounds${costCap !== Infinity ? `, $${costCap} cap` : ""} (Ctrl-C to stop)\n`));
          const rep = await session.runUntilDone(taskToRun, {
            maxRounds, costCap,
            turnOpts: { onStep, onToolStart, onThinking, beforeTool, signal: currentAbort.signal },
            onRound: ({ round, open, cost }) => {
              if (round > 1) _live.print(p.dim(`  ↻ continuing (round ${round}) · ${open} task(s) left · $${(cost || 0).toFixed(4)}\n`));
            },
          });
          res = rep.last || {};
          turnVerify = { status: rep.verifiedStatus, outcome: rep.outcome, failures: (rep.verification || {}).failures || [] };
          // HONEST verification verdict (Block 70): say 'verified' ONLY when a real check confirmed it; an
          // accepted-but-unchecked done reads as ⚠ UNVERIFIED, and a failing check reads ✗ — never silent.
          const v = rep.verification || {};
          const vran = (v.ran || []).join(", ");
          const vmsg = rep.verifiedStatus === "fail"
            ? p.red(`checks FAILED ✗ — ${(v.failures || []).slice(0, 3).join("; ") || vran}`)
            : p.green(`verified ✓${vran ? ` (${vran})` : ""}`);
          // quiet on a clean single-round verified finish; speak up on anything else.
          if (rep.outcome === "success" && rep.verifiedStatus === "pass") {
            if (explicitFinish || rep.rounds > 1) process.stdout.write(p.green(`✓ finished — all tasks done in ${rep.rounds} round(s) · $${(rep.cost || 0).toFixed(4)} · `) + vmsg + "\n");
          } else if (rep.outcome === "success") {
            process.stdout.write(p.yellow(`⚠ finished in ${rep.rounds} round(s) · $${(rep.cost || 0).toFixed(4)} · `) + vmsg + "\n");
          } else {
            process.stdout.write(p.yellow(`∅ stopped after ${rep.rounds} round(s) — ${rep.outcome}${rep.detail ? `: ${rep.detail}` : ""} · `) + vmsg + (rep.openTasks.length ? p.yellow(` · ${rep.openTasks.length} left: ${rep.openTasks.slice(0, 5).join("; ")}`) : "") + "\n");
          }
        } else {
          res = await session.runTurn(taskToRun, { onStep, onToolStart, onThinking, beforeTool, signal: currentAbort.signal });
        }
      } catch (e) {
        _live.end();
        process.stdout.write(p.red(`error: ${e.message}\n`));
        currentAbort = null;
        safePrompt();
        continue;
      }
      _live.end();   // unpin the bottom box before printing results
      currentAbort = null;

      // Session continuity (Block 25): record a journal handoff so the NEXT session can resume.
      if (res && !res.aborted && !res.error) {
        try { appendJournal(workdir, { task: taskToRun, summary: res.summary || res.stopped || "(no summary)", files: createdThisTurn, next: res.stopped ? "resolve: " + res.stopped : "", verified: turnVerify }); } catch { /* */ }
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
        // when untilDone ran, the supervisor already printed the run-level verdict — don't double-print the
        // last inner turn's stop reason; just carry the footer status.
        if (res.stopped) { if (!untilDone) process.stdout.write(p.yellow(`\n∅ ${res.stopped}\n`)); footerStatus = "incomplete"; }
        else if (!res.summary) process.stdout.write(p.dim("\n(done — no summary)\n"));
        // Show HOW to run the built artifact (informational only). The interactive "run it now?" / open-the-
        // browser step was REMOVED (Block 79) — proov doesn't interrupt the autonomous loop to open a browser.
        if (createdThisTurn.length) {
          const hint = detectRunHint(workdir, createdThisTurn);
          if (hint) process.stdout.write("\n" + p.cyan(`▶ run ${hint.what} with:  ${hint.cmd}`) + "\n");
        }
      }
      if (session.tools.tasks.length) process.stdout.write("\n" + renderTasks(session.tools.tasks, p) + "\n");
      process.stdout.write(footer({ turns: res.turns, totalTokens: res.totals.totalTokens, cachedTokens: res.totals.cachedTokens, cost: res.totals.cost, model: session.provider.model, status: footerStatus }, p) + "\n\n");

      // AUTONOMOUS SELF-IMPROVE (Block 79): on a clean done with no open tasks, AUTOMATICALLY continue to the
      // single most valuable next improvement — grounded in a REAL structure gap in THIS build — WITHOUT asking
      // (no y/N). The suggestion EXPANDS into a fresh task_write checklist the agent implements + verifies.
      // Bounded: the same gap is never auto-applied twice (an un-fillable gap can't loop), and it goes quiet
      // when there's nothing worth doing or the run didn't finish cleanly.
      if (res.done && !res.stopped && !(session.tools.tasks || []).some((t) => t.status !== "completed")) {
        try {
          const gameFile = detectGameFile(workdir);
          const next = gameFile ? suggestNextStep(workdir, taskToRun, { fsMod: fs, pathMod: path, gameFile }) : null;
          if (next && !autoImproved.has(next.id)) {
            autoImproved.add(next.id);
            process.stdout.write(p.cyan("◇ auto-continuing → ") + next.offer + p.dim(`  (${next.reason})`) + "\n");
            autoTasks.add(next.task);
            queue.unshift(next.task);   // applied automatically — no prompt
          }
        } catch { /* a suggestion must never break the REPL */ }
      }
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
  // user discover /key). Reuses the main readline; pressing Enter skips. Saved to ~/.proov.json.
  if (!session.provider.hasKey() && process.stdin.isTTY) {
    const k = await prompting(() => new Promise((resolve) => {
      rl.question(p.cyan("paste your OpenRouter API key (or press Enter to skip): "), (a) => resolve((a || "").trim()));
    }));
    if (k) {
      session.provider.key = k;
      if (saveKeyToConfig(k)) process.stdout.write(p.green(`✓ key saved to ${path.join(os.homedir(), ".proov.json")}\n`));
      else process.stdout.write(p.yellow("key set for this session (could not save to ~/.proov.json)\n"));
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
          : p.dim("no API key set. Usage: /key sk-or-…  (saved to ~/.proov.json · keys: https://openrouter.ai/keys)\n"));
        return;
      }
      session.provider.key = k;   // apply to the live session immediately
      if (saveKeyToConfig(k)) process.stdout.write(p.green(`✓ key set and saved to ${path.join(os.homedir(), ".proov.json")}\n`));
      else process.stdout.write(p.yellow("key set for this session, but could not save it to ~/.proov.json\n"));
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
      if (!cat.length && !errs.length) { process.stdout.write(p.dim("no MCP servers configured. Add them under \"mcpServers\" in .proov.json.\n")); return; }
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
      if (!jobs.length) { process.stdout.write(p.dim("no background jobs. Start one with `proov bg \"<task>\"` from your shell.\n")); return; }
      process.stdout.write(p.bold("background jobs") + "\n");
      for (const j of jobs.slice(0, 20)) {
        const mark = j.status === "done" ? p.green("✓") : j.status === "failed" ? p.red("✗") : p.yellow("●");
        process.stdout.write(`  ${mark} ${p.dim(j.id)} ${p.gray((j.task || "").replace(/\s+/g, " ").slice(0, 60))} ${p.dim(j.status)}\n`);
      }
      process.stdout.write(p.dim("  view a job's log with: proov logs <id>\n"));
      return;
    }
    case "skills": {
      const skills = listSkills(workdir);
      if (!skills.length) { process.stdout.write(p.dim("no skills found. Add prompts under ./.proov/skills/*.md or ~/.proov/skills/*.md\n")); return; }
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
    case "finish": {
      // /finish [extra instruction] — drive the session to GENUINE completion (runUntilDone): keep
      // continuing until every checklist task is done AND verified, or a budget/no-progress stop.
      return { runUntilDone: true, runTask: command.arg || "Finish the task completely: complete every remaining checklist item, verify each one for real, and only then call done." };
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

const BUILTIN_COMMANDS = ["help", "key", "model", "cost", "plan", "skills", "run", "mcp", "jobs", "finish", "clear", "reset", "exit", "quit"];

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
