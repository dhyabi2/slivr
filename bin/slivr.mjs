#!/usr/bin/env node
// slivr — a configurable-LLM coding agent CLI.
//
//   slivr                      open an interactive REPL in the current repo
//   slivr "<task>" [dir]       run one task non-interactively (one-shot)
//   slivr config               print the resolved configuration
//   slivr --init               write a starter ./.slivr.json
//   slivr --help / --version
//
// Flags (override config): --model <id>, --approval <auto|edits|all>, --auto, --dir <path>,
//                          --baseline (compat: run the full-rewrite harness one-shot).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadConfig, writeStarterConfig } from "../src/config.mjs";
import { Session, planGate } from "../src/agent.mjs";
import { runBaseline } from "../src/baseline.mjs";
import { startRepl } from "../src/repl.mjs";
import { makePalette, colorEnabled, stepLine, footer, renderPlan, renderTasks, planPrompt, readPlanEdit } from "../src/ui.mjs";
import { renderDiff, diffStat } from "../src/diff.mjs";
import { isDestructive, needsApproval } from "../src/safety.mjs";
import { connectAll, closeAll } from "../src/mcp.mjs";
import { listSkills, renderSkill } from "../src/skills.mjs";
import { spawnBackground, runBackgroundJob, runScheduler, startSchedulerDaemon, stopSchedulerDaemon, schedulerStatus } from "../src/scheduler.mjs";
import { listJobs, readJob, logPath, makeScheduled, addScheduled, readSchedule, clearSchedule, groupSchedule } from "../src/jobs.mjs";

const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"));
    return pkg.version;
  } catch { return "0.0.0"; }
})();

// ---- tiny flag parser -------------------------------------------------------
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const unknown = [];      // flags we don't recognize (warned about, not silently dropped)
  const missing = [];      // value-flags given with no following value
  let baseline = false, init = false, help = false, version = false, auto = false, plan = false;
  // consume the value after a value-flag; record it as missing if absent (or another flag follows).
  const val = (i, name) => {
    const next = argv[i + 1];
    if (next === undefined || (typeof next === "string" && next.startsWith("--"))) { missing.push(name); return [undefined, i]; }
    return [next, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--version" || a === "-v") version = true;
    else if (a === "--init") init = true;
    else if (a === "--baseline") baseline = true;
    else if (a === "--plan") plan = true;
    else if (a === "--auto") { auto = true; flags.approval = "auto"; }
    else if (a === "--model") { [flags.model, i] = val(i, "--model"); }
    else if (a === "--approval") { [flags.approval, i] = val(i, "--approval"); }
    else if (a === "--dir") { [flags.dir, i] = val(i, "--dir"); }
    else if (a === "--prompt" || a === "-p") { [flags.promptTask, i] = val(i, "--prompt"); }
    else if (a === "--max-steps") { let v; [v, i] = val(i, "--max-steps"); flags.maxSteps = Number(v); }
    else if (a === "--in") { [flags.in, i] = val(i, "--in"); }
    else if (a === "--at") { [flags.at, i] = val(i, "--at"); }
    else if (a === "--cron") { [flags.cron, i] = val(i, "--cron"); }
    else if (a === "--every") { [flags.every, i] = val(i, "--every"); }
    else if (a === "--watch") flags.watch = true;
    else if (a === "--daemon") flags.daemon = true;
    else if (a === "--__daemon-child") flags.daemonChild = true;
    else if (a === "--__bg-run") { [flags.bgRun, i] = val(i, "--__bg-run"); }
    else if (a.startsWith("--model=")) flags.model = a.slice(8);
    else if (a.startsWith("--approval=")) flags.approval = a.slice(11);
    else if (a.startsWith("--dir=")) flags.dir = a.slice(6);
    else if (a.startsWith("--prompt=")) flags.promptTask = a.slice(9);
    else if (a.startsWith("--max-steps=")) flags.maxSteps = Number(a.slice(12));
    else if (a.startsWith("-") && a !== "-") unknown.push(a);   // unrecognized flag -> reported
    else positional.push(a);
  }
  return { flags, positional, baseline, init, help, version, auto, plan, unknown, missing };
}

// Known first-positional subcommands — used to catch typos before a stray word is sent to the model.
const SUBCOMMANDS = ["config", "upgrade", "update", "mcp", "skills", "skill", "bg", "jobs", "logs", "schedule", "scheduler", "help", "version"];

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) { const tmp = dp[i]; dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return dp[m];
}

const HELP = `slivr — configurable-LLM coding agent (any Claude/GPT/Gemini model via OpenRouter)

USAGE
  slivr                       open an interactive REPL in the current directory
  slivr "<task>" [dir]        run one task non-interactively (one-shot)
  slivr config                print the resolved configuration (and where each value came from)
  slivr skills                list available skills (.slivr/skills/*.md, ~/.slivr/skills/*.md)
  slivr skill <name> [args]   run a skill one-shot (a reusable prompt template)
  slivr mcp list              connect configured MCP servers and print their tools
  slivr mcp add <name> -- <cmd...>   add an MCP server to ./.slivr.json
  slivr bg "<task>" [dir]     run a task in a DETACHED background process (POSIX only)
  slivr jobs [--watch]        list background jobs (id, status, task)
  slivr logs <id>             print a background job's log
  slivr schedule "<task>" --in 30m|--at <ISO>|--cron "<expr>"   schedule a task
  slivr schedule list         list scheduled jobs (grouped: active vs done)
  slivr schedule clear        prune completed once-jobs from the schedule
  slivr scheduler             run the foreground poller that fires due scheduled jobs
  slivr scheduler --daemon    start the poller DETACHED (pidfile ~/.slivr/scheduler.pid)
  slivr scheduler status      report whether the daemon is running
  slivr scheduler stop        stop the detached daemon
  slivr upgrade [--check]     update slivr to the latest version (git checkout installs)
  slivr --init                write a starter ./.slivr.json

OPTIONS
  --model <id>                 model id (e.g. anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-2.5-flash)
  --approval <auto|edits|all>  when to ask before acting (default: edits)
  --auto                       shorthand for --approval auto (no prompts; destructive cmds still blocked)
  --plan                       plan-mode: agent must produce + get approval for a numbered plan before editing
  --dir <path>                 working directory (default: cwd or the 2nd positional arg)
  --max-steps <n>              cap tool-calls per turn
  --in/--at/--cron <v>         scheduling timing for "slivr schedule"
  --every <secs>               scheduler poll interval (default 30)
  --watch                      live-refresh "slivr jobs"
  --baseline                   one-shot using the full-rewrite harness (for the cost benchmark)
  -h, --help                   show this help
  -v, --version                show version

CONFIG  (precedence: flags > ./.slivr.json > ~/.slivr.json > env > defaults)
  keys: model, apiKey, baseUrl, approval, maxSteps, maxTokensPerTurn
  key:  set OPENROUTER_API_KEY in the environment (preferred) or apiKey in .slivr.json

EXAMPLES
  slivr                                              # REPL, default model
  slivr "add input validation to src/calc.js"        # one-shot in cwd
  slivr "fix the failing test" ./myrepo --auto       # one-shot, no prompts
  slivr --model anthropic/claude-sonnet-4            # REPL on Claude
  slivr config                                       # show resolved config`;

// ---- one-shot ---------------------------------------------------------------
async function runOneShot(task, dir, config, palette, { auto, plan }) {
  const p = palette;
  const session = new Session(dir, {
    model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl,
    maxSteps: config.maxSteps, maxTokensPerTurn: config.maxTokensPerTurn,
    planMode: !!plan,
    notify: (m) => process.stderr.write(p.dim(`  … ${m}\n`)),
  });
  if (!session.provider.hasKey()) {
    // Stop here rather than running a turn that's guaranteed to fail with a misleading 0-token footer.
    process.stderr.write(p.red("no API key — the agent cannot call the model.\n"));
    process.stderr.write(p.dim("  fix: export OPENROUTER_API_KEY=sk-or-...   (or put \"apiKey\" in .slivr.json, or OPENROUTER_API_KEY in a .env)\n"));
    process.stderr.write(p.dim("  get one at https://openrouter.ai/keys\n"));
    return 3;
  }
  // Connect any configured MCP servers; their tools become callable as mcp__<server>__<tool>.
  if (config.mcpServers) {
    const { catalog, errors } = await session.connectMCP(config.mcpServers);
    if (catalog.length) process.stderr.write(p.dim(`mcp · ${catalog.length} tool(s) from ${session.mcpClients.length} server(s)\n`));
    for (const e of errors) process.stderr.write(p.yellow(`mcp · ${e.server} failed: ${e.error}\n`));
  }
  const approval = auto ? "auto" : config.approval;
  process.stderr.write(p.dim(`slivr · model ${config.model} · ${path.resolve(dir)}${plan ? " · plan-mode" : ""}\n`));

  // Plan-approval: when a plan exists but isn't approved yet, approve it (auto/non-TTY -> auto-approve
  // but still SHOW it; interactive -> y/e/n). Edit lets the user replace the steps.
  const approvePlan = async () => {
    const pl = session.tools.plan;
    if (!pl || pl.approved) return;
    process.stderr.write("\n" + renderPlan(pl, p) + "\n");
    if (auto || !process.stdin.isTTY) { pl.approved = true; process.stderr.write(p.dim("  (auto-approved)\n")); return; }
    const verdict = await planPrompt("proceed?");
    if (verdict === "yes") { pl.approved = true; }
    else if (verdict === "edit") {
      const steps = await readPlanEdit();
      if (steps.length) { session.tools.plan = { steps, approved: true }; process.stderr.write(renderPlan(session.tools.plan, p) + "\n"); }
      else pl.approved = true;
    } else { session.tools._planAborted = true; }
  };

  const beforeTool = async ({ tool, args }) => {
    if (tool === "run_command") {
      const v = isDestructive(args.command || "");
      if (v.blocked) {
        process.stderr.write(p.red(`  ⛔ blocked: ${args.command} (${v.why})\n`));
        return { deny: true, reason: `refused — ${v.why}` };
      }
    }
    // plan-mode gate: block mutating tools until a plan is recorded + approved.
    if (plan) {
      await approvePlan();
      if (session.tools._planAborted) return { deny: true, reason: "user aborted the plan; stop and call done." };
      const g = planGate({ tool, tools: session.tools });
      if (g.deny) { process.stderr.write(p.yellow(`  ∅ ${tool} blocked — ${g.reason}\n`)); return g; }
    }
    if (approval !== "auto" && needsApproval(tool, approval) && !process.stdin.isTTY) {
      process.stderr.write(p.yellow(`  ∅ skipped ${tool} (needs approval; re-run with --auto to allow)\n`));
      return { deny: true, reason: "approval required but session is non-interactive; user must pass --auto" };
    }
    return { deny: false };
  };

  let lastTasksRender = "";
  const onStep = ({ tool, args, result, denied }) => {
    if (tool === "done") return;
    const status = denied ? "skip" : result?.ok === false ? "fail" : "ok";
    let extra = "";
    if ((tool === "edit_file" || tool === "create_file") && result?.ok && session.lastDiff) {
      const s = diffStat(session.lastDiff.before, session.lastDiff.after);
      extra = `+${s.add} -${s.del}` + (result.tier ? ` (${result.tier})` : "");
    } else if (tool === "edit_files" && result?.ok && session.lastDiffs) {
      let add = 0, del = 0;
      for (const d of session.lastDiffs) { const s = diffStat(d.before, d.after); add += s.add; del += s.del; }
      extra = `${session.lastDiffs.length} file${session.lastDiffs.length === 1 ? "" : "s"} +${add} -${del}`;
    } else if (tool === "run_command") extra = result?.ok ? "exit 0" : `exit ${result?.exitCode ?? "?"}`;
    else if (tool === "parallel") extra = result?.ok ? `${result.count} subtasks @${result.cap}${result.failed ? `, ${result.failed} failed` : ""}` : (result?.error || "");
    else if (tool === "plan") extra = result?.ok ? `${result.steps?.length || 0} steps` : "";
    process.stderr.write(stepLine({ tool, args, status, extra, palette: p }) + "\n");
    if ((tool === "edit_file" || tool === "create_file") && result?.ok && session.lastDiff) {
      const d = renderDiff(session.lastDiff.before, session.lastDiff.after, { color: p.enabled, path: session.lastDiff.path });
      if (d) process.stderr.write(d.split("\n").map(l => "    " + l).join("\n") + "\n");
    }
    if (tool === "edit_files" && result?.ok && session.lastDiffs) {
      for (const dd of session.lastDiffs) {
        const d = renderDiff(dd.before, dd.after, { color: p.enabled, path: dd.path });
        if (d) process.stderr.write(d.split("\n").map(l => "    " + l).join("\n") + "\n");
      }
    }
    if (tool === "parallel" && result?.ok) {
      for (const r of result.results) process.stderr.write(p.dim(`    ↳ ${r.done ? "✓" : "·"} ${r.task.slice(0, 60)} — ${(r.summary || r.findings || r.error || "").replace(/\s+/g, " ").slice(0, 120)}\n`));
    }
    // live checklist: re-render when task_write changes it.
    if (tool === "task_write" && result?.ok) {
      const r = renderTasks(session.tools.tasks, p);
      if (r !== lastTasksRender) { process.stderr.write(r + "\n"); lastTasksRender = r; }
    }
  };

  let res;
  try {
    res = await session.runTurn(task, { onStep, beforeTool });
  } finally {
    session.closeMCP();
  }
  // Surface the outcome explicitly (a provider error / step-limit must not look like a silent finish).
  let footerStatus = "ok";
  if (res.error) { process.stderr.write(p.red(`\n✗ ${res.error}\n`)); footerStatus = "error"; }
  else {
    if (res.summary) process.stderr.write("\n" + res.summary + "\n");
    if (res.stopped) { process.stderr.write(p.yellow(`\n∅ ${res.stopped}\n`)); footerStatus = "incomplete"; }
    else if (!res.summary) process.stderr.write(p.dim("\n(done — no summary)\n"));
  }
  if (session.tools.tasks.length) process.stderr.write("\n" + renderTasks(session.tools.tasks, p) + "\n");
  process.stderr.write(footer({ turns: res.turns, totalTokens: res.totals.totalTokens, cost: res.totals.cost, model: session.provider.model, status: footerStatus }, p) + "\n");
  // exit 0 only on a clean finish; nonzero when errored or stopped short.
  return res.error ? 1 : (res.done ? 0 : 1);
}

// Run a task in-process for a background job, writing all step output to `log` (a write stream).
// No prompts (auto), no MCP, no color. Returns the exit code (0 = done).
async function runOneShotInProcess(task, dir, log) {
  const { config } = loadConfig({});
  const session = new Session(dir, {
    model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl,
    maxSteps: config.maxSteps, maxTokensPerTurn: config.maxTokensPerTurn,
  });
  const w = (s) => { try { log.write(s); } catch { /* ignore */ } };
  if (!session.provider.hasKey()) w("warning: no API key found\n");
  const onStep = ({ tool, args, result, denied }) => {
    if (tool === "done") return;
    const status = denied ? "skip" : result?.ok === false ? "fail" : "ok";
    const a = args?.path || args?.command || args?.pattern || args?.url || "";
    w(`  [${status}] ${tool} ${typeof a === "string" ? a : ""}\n`);
  };
  // auto approval: allow edits/commands (destructive still hard-blocked).
  const beforeTool = async ({ tool, args }) => {
    if (tool === "run_command") {
      const v = isDestructive(args.command || "");
      if (v.blocked) { w(`  blocked: ${args.command} (${v.why})\n`); return { deny: true, reason: v.why }; }
    }
    return { deny: false };
  };
  let res;
  try { res = await session.runTurn(task, { onStep, beforeTool }); }
  catch (e) { w(`error: ${e?.message || e}\n`); return 1; }
  if (res.error) w(`\nERROR: ${res.error}\n`);
  if (res.stopped) w(`\nSTOPPED: ${res.stopped}\n`);
  w("\nSUMMARY:\n" + (res.summary || "(no summary)") + "\n");
  const t = res.totals;
  w(`\n${res.turns} turns · ${t.totalTokens} tok · $${t.cost.toFixed(4)} · ${session.provider.model}\n`);
  return res.done ? 0 : 1;
}

// ---- mcp subcommand ---------------------------------------------------------
//   slivr mcp list                       connect configured servers, print their tools
//   slivr mcp add <name> -- <command...> write a server into ./.slivr.json
// slivr upgrade — update a git-checkout install (the curl|bash / clone path) to the latest version.
// `--check` only reports whether a newer version is available without changing anything.
function runUpgrade(args, p) {
  const checkOnly = args.includes("--check");
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const verOf = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version; } catch { return "?"; } };

  // Not a git checkout → can't self-update; tell the user how they installed and what to run.
  if (!fs.existsSync(path.join(ROOT, ".git"))) {
    process.stderr.write(p.yellow("slivr is not a git checkout, so `upgrade` can't update it in place.\n"));
    process.stderr.write(p.dim("  • installed via npx:   re-run `npx github:dhyabi2/slivr` (always pulls latest)\n"));
    process.stderr.write(p.dim("  • installed a tarball: re-run the installer:\n"));
    process.stderr.write(p.dim("      curl -fsSL https://raw.githubusercontent.com/dhyabi2/slivr/main/install.sh | bash\n"));
    return 1;
  }

  let branch = "main";
  try { const b = git("rev-parse", "--abbrev-ref", "HEAD"); if (b && b !== "HEAD") branch = b; } catch {}

  process.stderr.write(p.dim(`checking ${branch} @ ${ROOT} …\n`));
  // NB: no --depth here. A shallow fetch severs the fetched commit's history locally, which would
  // make the ancestor check below unable to see the fast-forward and wrongly cry "diverged".
  try { git("fetch", "--quiet", "origin", branch); }
  catch (e) { process.stderr.write(p.yellow(`could not reach the remote: ${String(e.message || e).split("\n")[0]}\n`)); return 1; }

  const local = git("rev-parse", "HEAD");
  let remote;
  try { remote = git("rev-parse", "FETCH_HEAD"); } catch { remote = git("rev-parse", `origin/${branch}`); }

  if (local === remote) { process.stderr.write(p.green(`already up to date (slivr ${verOf()}).\n`)); return 0; }

  // upgrade only moves FORWARD: remote must be a descendant of local (local is an ancestor of remote).
  // If the install is ahead of or diverged from origin, a hard reset would lose commits — refuse.
  // Skip this on a SHALLOW checkout (the curl|bash `--depth 1` install): history is truncated so
  // ancestry is undecidable, and such installs are never committed to — dirty-check + reset is safe.
  const shallow = (() => { try { return git("rev-parse", "--is-shallow-repository") === "true"; } catch { return false; } })();
  const isAncestor = (a, b) => { try { git("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } };
  if (!shallow && !isAncestor(local, remote)) {
    process.stderr.write(p.yellow("your install is ahead of or has diverged from origin — not changing it.\n"));
    process.stderr.write(p.dim(`  ${ROOT}\n  local ${local.slice(0, 7)} vs remote ${remote.slice(0, 7)}\n`));
    return 1;
  }

  const before = verOf();
  if (checkOnly) {
    process.stderr.write(p.cyan(`an update is available.`) + p.dim(`  current ${before} (${local.slice(0, 7)}) → remote ${remote.slice(0, 7)}\n`));
    process.stderr.write(p.dim("  run `slivr upgrade` to apply.\n"));
    return 0;
  }

  // refuse to clobber local edits — a hard reset would lose them
  let dirty = "";
  try { dirty = git("status", "--porcelain"); } catch {}
  if (dirty) {
    process.stderr.write(p.yellow("refusing to upgrade: the install directory has local changes.\n"));
    process.stderr.write(p.dim(`  ${ROOT}\n  commit/stash them, or re-clone, then retry.\n`));
    return 1;
  }

  try { git("reset", "--quiet", "--hard", remote); }
  catch (e) { process.stderr.write(p.yellow(`upgrade failed: ${String(e.message || e).split("\n")[0]}\n`)); return 1; }

  // verify the new checkout actually runs
  try { execFileSync("node", [path.join(ROOT, "bin", "slivr.mjs"), "--version"], { stdio: "ignore" }); }
  catch { process.stderr.write(p.yellow("upgraded, but the new version failed its --version check. Consider re-installing.\n")); return 1; }

  const after = verOf();
  process.stderr.write(p.green(`upgraded slivr ${before === after ? after : `${before} → ${after}`}`) + p.dim(`  (${local.slice(0, 7)} → ${remote.slice(0, 7)})\n`));
  return 0;
}

async function runMcpCommand(args, config, p) {
  const sub = args[0];

  if (sub === "add") {
    // Re-read the raw argv so the `-- <command...>` part survives the flag parser.
    const raw = process.argv.slice(2);
    const i = raw.indexOf("add");
    const after = raw.slice(i + 1);
    const dashdash = after.indexOf("--");
    const name = after[0];
    if (!name || dashdash === -1 || dashdash === 0) {
      process.stderr.write(p.yellow("usage: slivr mcp add <name> -- <command> [args...]\n"));
      return 1;
    }
    const cmd = after.slice(dashdash + 1);
    if (!cmd.length) { process.stderr.write(p.yellow("no command after --\n")); return 1; }
    const target = path.join(process.cwd(), ".slivr.json");
    let cfg = {};
    try { if (fs.existsSync(target)) cfg = JSON.parse(fs.readFileSync(target, "utf8")); } catch { cfg = {}; }
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers[name] = { command: cmd[0], args: cmd.slice(1), env: {} };
    fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n");
    process.stdout.write(p.green(`added mcp server "${name}" → ${target}\n`));
    process.stdout.write(p.dim(`  ${cmd.join(" ")}\n`));
    return 0;
  }

  if (sub && sub !== "list") {
    process.stderr.write(p.yellow(`unknown: slivr mcp ${sub}\nusage: slivr mcp list | slivr mcp add <name> -- <command...>\n`));
    return 1;
  }

  // default: list
  if (!config.mcpServers || !Object.keys(config.mcpServers).length) {
    process.stdout.write(p.dim("no mcpServers configured (add an \"mcpServers\" block to .slivr.json or run: slivr mcp add <name> -- <command...>)\n"));
    return 0;
  }
  process.stderr.write(p.dim("connecting MCP servers…\n"));
  const { clients, catalog, errors } = await connectAll(config.mcpServers);
  try {
    const byServer = new Map();
    for (const t of catalog) {
      if (!byServer.has(t.server)) byServer.set(t.server, []);
      byServer.get(t.server).push(t);
    }
    for (const [server, tools] of byServer) {
      process.stdout.write(p.bold(`\n${server}`) + p.dim(`  (${tools.length} tool${tools.length === 1 ? "" : "s"})`) + "\n");
      for (const t of tools) {
        const desc = (t.description || "").replace(/\s+/g, " ").trim().slice(0, 80);
        process.stdout.write(`  ${p.cyan(t.id)}  ${p.gray(desc)}\n`);
      }
    }
    for (const e of errors) process.stdout.write(p.red(`\n${e.server}: ${e.error}\n`));
    if (!catalog.length && !errors.length) process.stdout.write(p.dim("no tools discovered.\n"));
  } finally {
    closeAll(clients);
  }
  return 0;
}

// ---- main -------------------------------------------------------------------
async function main() {
  const { flags, positional, baseline, init, help, version, auto, plan, unknown, missing } = parseArgs(process.argv.slice(2));
  const palette = makePalette(colorEnabled());
  const p = palette;

  // hidden runner: the detached background child re-invokes us as `--__bg-run <id>` to execute the
  // job and update its status record. Never user-facing.
  if (flags.bgRun) {
    return runBackgroundJob(flags.bgRun, { loadConfig, runOneShotInProcess });
  }

  // A value-flag with no value is a usage error — fail loudly instead of silently using a default.
  if (missing.length) {
    process.stderr.write(p.red(`missing value for: ${missing.join(", ")}\n`) + p.dim("  see `slivr --help`\n"));
    return 2;
  }
  // Unrecognized flags are reported (not silently ignored) so a typo'd override can't pass unnoticed.
  for (const u of unknown) process.stderr.write(p.yellow(`warning: unknown flag ${u} (ignored) — see \`slivr --help\`\n`));

  // Accept bare `help` / `version` words in addition to the --flags.
  if (version || positional[0] === "version") { process.stdout.write(`slivr ${VERSION}\n`); return 0; }
  if (help || positional[0] === "help") { process.stdout.write(HELP + "\n"); return 0; }

  if (init) {
    const r = writeStarterConfig(process.cwd());
    if (!r.ok) { process.stderr.write(p.yellow(`.slivr.json already exists at ${r.path}\n`)); return 1; }
    process.stdout.write(p.green(`wrote ${r.path}\n`));
    return 0;
  }

  // Resolve config (flags win). dir comes from --dir, the 2nd positional, or cwd.
  const subcommand = positional[0];
  const { config, sources, paths, warnings } = loadConfig({ flags });
  // Tell the user when a config file/value was ignored, instead of silently falling back.
  for (const w of (warnings || [])) process.stderr.write(p.yellow(`config warning: ${w}\n`));

  if (subcommand === "config") {
    process.stdout.write(p.bold("resolved config") + p.dim("  (precedence: flags > local > home > env > defaults)") + "\n");
    for (const [k, v] of Object.entries(config)) {
      const shown = k === "apiKey" ? (v ? "****(set)" : "(unset)") : v;
      process.stdout.write(`  ${k.padEnd(16)} ${String(shown).padEnd(40)} ${p.gray("← " + (sources[k] || "default"))}\n`);
    }
    process.stdout.write(p.gray(`  local: ${paths.local}${fs.existsSync(paths.local) ? "" : " (none)"}\n`));
    process.stdout.write(p.gray(`  home:  ${paths.home}${fs.existsSync(paths.home) ? "" : " (none)"}\n`));
    return 0;
  }

  if (subcommand === "upgrade" || subcommand === "update") {
    return runUpgrade(positional.slice(1), p);
  }

  if (subcommand === "mcp") {
    return runMcpCommand(positional.slice(1), config, p);
  }

  // skills: list available skills. skill <name> [args...]: render a skill + run it one-shot.
  if (subcommand === "skills") {
    const skills = listSkills(process.cwd());
    if (!skills.length) { process.stdout.write(p.dim("no skills found. Add prompts under ./.slivr/skills/*.md or ~/.slivr/skills/*.md\n")); return 0; }
    process.stdout.write(p.bold("skills") + p.dim("  (run: slivr skill <name> [args...])") + "\n");
    for (const s of skills) process.stdout.write(`  ${p.cyan(s.name.padEnd(14))} ${p.gray((s.description || "").slice(0, 70))}\n`);
    return 0;
  }
  if (subcommand === "skill") {
    const name = positional[1];
    if (!name) { process.stderr.write(p.yellow("usage: slivr skill <name> [args...]\n")); return 1; }
    const r = renderSkill(name, positional.slice(2), process.cwd());
    if (!r.ok) { process.stderr.write(p.yellow(`no skill "${name}". available: ${r.available.join(", ") || "(none)"}\n`)); return 1; }
    const dir = flags.dir || process.cwd();
    process.stderr.write(p.dim(`skill: ${name}\n`));
    return runOneShot(r.prompt, dir, config, palette, { auto, plan });
  }

  // ---- background jobs --------------------------------------------------------
  if (subcommand === "bg") {
    const task = positional[1];
    if (!task) { process.stderr.write(p.yellow('usage: slivr bg "<task>" [dir]\n')); return 1; }
    const dir = flags.dir || positional[2] || process.cwd();
    if (!fs.existsSync(dir)) { process.stderr.write(p.red(`directory not found: ${dir}\n`)); return 2; }
    const rec = spawnBackground(task, dir);
    process.stdout.write(p.green(`started background job ${rec.id}`) + p.dim(` (pid ${rec.pid})\n`));
    process.stdout.write(p.dim(`  log: ${logPath(rec.id)}\n  watch: slivr jobs   ·   slivr logs ${rec.id}\n`));
    return 0;
  }
  if (subcommand === "jobs") {
    const render = () => {
      const jobs = listJobs();
      if (!jobs.length) { process.stdout.write(p.dim("no background jobs. start one: slivr bg \"<task>\"\n")); return; }
      process.stdout.write(p.bold("jobs") + p.dim("  (logs: slivr logs <id>)") + "\n");
      for (const j of jobs) {
        const color = j.status === "done" ? p.green : j.status === "failed" ? p.red : j.status === "running" ? p.cyan : p.dim;
        process.stdout.write(`  ${p.gray(j.id)}  ${color((j.status || "?").padEnd(8))} ${String(j.task).replace(/\s+/g, " ").slice(0, 64)}\n`);
      }
    };
    if (flags.watch) {
      process.stdout.write(p.dim("watching jobs (Ctrl-C to stop)…\n"));
      // simple repaint loop
      // eslint-disable-next-line no-constant-condition
      while (true) { process.stdout.write("\x1b[2J\x1b[H"); render(); await new Promise(r => setTimeout(r, 2000)); }
    }
    render();
    return 0;
  }
  if (subcommand === "logs") {
    const id = positional[1];
    if (!id) { process.stderr.write(p.yellow("usage: slivr logs <id>\n")); return 1; }
    const lp = logPath(id);
    if (!fs.existsSync(lp)) { process.stderr.write(p.yellow(`no log for job ${id} (yet)\n`)); return 1; }
    process.stdout.write(fs.readFileSync(lp, "utf8"));
    return 0;
  }

  // ---- scheduled jobs ---------------------------------------------------------
  if (subcommand === "schedule") {
    // `slivr schedule clear` prunes completed once-jobs.
    if (positional[1] === "clear") {
      const r = clearSchedule();
      process.stdout.write(p.green(`pruned ${r.removed} completed job(s)`) + p.dim(` — ${r.remaining} remaining\n`));
      return 0;
    }
    // `slivr schedule list` shows scheduled jobs, grouped active vs done; otherwise schedule a new one.
    if (positional[1] === "list") {
      const sched = readSchedule();
      if (!sched.length) { process.stdout.write(p.dim("no scheduled jobs. add one: slivr schedule \"<task>\" --in 30m\n")); return 0; }
      const { active, done } = groupSchedule(sched);
      const row = (j) => {
        const when = j.status === "done" ? "(done)" : typeof j.dueAt === "number" ? new Date(j.dueAt).toISOString() : "(done)";
        return `  ${p.gray(j.id)}  ${p.cyan((j.spec || j.kind || "?").padEnd(16))} next:${p.dim(when)}  ${String(j.task).replace(/\s+/g, " ").slice(0, 48)}\n`;
      };
      const running = schedulerStatus().running;
      process.stdout.write(p.bold("scheduled") + (running ? p.green("  (scheduler running)") : p.yellow("  (scheduler NOT running — active jobs will not fire: slivr scheduler --daemon)")) + "\n");
      if (active.length) { process.stdout.write(p.bold("\n  active\n")); for (const j of active) process.stdout.write(row(j)); }
      if (done.length) { process.stdout.write(p.dim("\n  done") + p.dim("  (prune: slivr schedule clear)") + "\n"); for (const j of done) process.stdout.write(row(j)); }
      return 0;
    }
    const task = positional[1];
    if (!task) { process.stderr.write(p.yellow('usage: slivr schedule "<task>" --in 30m | --at <ISO> | --cron "<expr>"   ·   slivr schedule list\n')); return 1; }
    const dir = flags.dir || process.cwd();
    const r = makeScheduled({ task, dir, in: flags.in, at: flags.at, cron: flags.cron });
    if (!r.ok) { process.stderr.write(p.red(`schedule error: ${r.error}${r.value ? ` (${r.value})` : ""}\n`)); return 1; }
    addScheduled(r.rec);
    process.stdout.write(p.green(`scheduled job ${r.rec.id}`) + p.dim(` — ${r.rec.spec}, next ${new Date(r.rec.dueAt).toISOString()}\n`));
    // A scheduled job only fires while the poller runs. Make that explicit instead of leaving the
    // user thinking it's armed — this is the #1 "my scheduled task never ran" footgun.
    if (!schedulerStatus().running) {
      process.stdout.write(p.yellow("  ⚠ the scheduler is NOT running — this job will NOT fire until you start it:\n"));
      process.stdout.write(p.dim("     slivr scheduler --daemon    (background)   ·   slivr scheduler   (foreground)\n"));
    } else {
      process.stdout.write(p.dim("  the scheduler is running and will fire it.\n"));
    }
    return 0;
  }
  if (subcommand === "scheduler") {
    const intervalMs = flags.every ? (parseInt(flags.every, 10) * 1000 || 30000) : 30000;
    const action = positional[1];
    if (action === "stop") {
      const r = stopSchedulerDaemon();
      if (!r.ok) { process.stdout.write(p.dim(`scheduler not running (no pidfile)\n`)); return 0; }
      process.stdout.write(p.green(`stopped scheduler`) + p.dim(` (pid ${r.pid}${r.wasRunning ? "" : ", was already gone"})\n`));
      return 0;
    }
    if (action === "status") {
      const s = schedulerStatus();
      if (s.running) process.stdout.write(p.green(`scheduler running`) + p.dim(` (pid ${s.pid})\n`));
      else process.stdout.write(p.yellow("scheduler not running") + p.dim(s.pid ? ` (stale pidfile for pid ${s.pid})\n` : "\n"));
      return s.running ? 0 : 1;
    }
    if (flags.daemon) {
      const r = startSchedulerDaemon({ intervalMs });
      if (!r.ok) {
        if (r.error === "ALREADY_RUNNING") { process.stderr.write(p.yellow(`scheduler already running (pid ${r.pid})\n`)); return 1; }
        process.stderr.write(p.red(`could not start scheduler daemon: ${r.error}\n`)); return 1;
      }
      process.stdout.write(p.green(`scheduler daemon started`) + p.dim(` (pid ${r.pid}) — stop: slivr scheduler stop · status: slivr scheduler status\n`));
      return 0;
    }
    await runScheduler({ intervalMs, daemon: !!flags.daemonChild });   // foreground; never returns until killed
    return 0;
  }

  // One-shot vs REPL. An explicit `-p/--prompt` is always a task. Otherwise the first positional is
  // the task — but if it's a SINGLE word that looks like a mistyped subcommand, refuse (so a typo
  // like `slivr confgi` doesn't silently become a paid model call) and suggest the fix.
  if (!flags.promptTask && subcommand && !/\s/.test(subcommand) && !SUBCOMMANDS.includes(subcommand)) {
    const near = SUBCOMMANDS.find(s => levenshtein(subcommand, s) <= 2 && Math.abs(s.length - subcommand.length) <= 2);
    if (near) {
      process.stderr.write(p.yellow(`unknown command "${subcommand}" — did you mean \`slivr ${near}\`?\n`));
      process.stderr.write(p.dim(`  to run "${subcommand}" as a task instead, use: slivr -p "${subcommand}"\n`));
      return 2;
    }
  }
  const task = flags.promptTask || subcommand;
  const hasTask = !!task;
  const dir = flags.dir || (subcommand && !flags.promptTask ? positional[1] : undefined) || process.cwd();
  if (!fs.existsSync(dir)) { process.stderr.write(p.red(`directory not found: ${dir}\n`)); return 2; }

  if (hasTask) {
    if (baseline) {
      process.stderr.write(p.dim(`slivr --baseline · model ${config.model}\n`));
      const res = await runBaseline(task, dir, { model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl, maxSteps: config.maxSteps });
      process.stderr.write(`\ndone=${res.done} turns=${res.turns} ${JSON.stringify(res.totals)}\n`);
      return res.done ? 0 : 1;
    }
    return runOneShot(task, dir, config, palette, { auto, plan });
  }

  // REPL
  await startRepl({ workdir: dir, config, palette });
  return 0;
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  process.stderr.write(`fatal: ${e?.stack || e?.message || e}\n`);
  process.exit(1);
});
