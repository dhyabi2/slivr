// scheduler.mjs — spawn detached background jobs + a simple foreground poller for scheduled jobs.
//
// spawnBackground(task,dir): forks a DETACHED proov one-shot --auto whose output is redirected to
//   ~/.proov/jobs/<id>.log; a <id>.json status record tracks queued/running/done/failed. The child
//   is the *runner* (bin --__bg-run <id>) which flips status to running, then done/failed on exit.
//
// runScheduler(): a foreground sleep-loop. Every `intervalMs` it reads ~/.proov/schedule.json,
//   spawns any due jobs in the background, and for cron jobs reschedules the next dueAt; once-jobs
//   are marked done. HONEST: this is a poller you keep running (or background) — NOT a system
//   daemon. If the poller isn't running, scheduled jobs don't fire.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  jobsDir, logPath, newJobRecord, writeJob, updateJob,
  readSchedule, writeSchedule, dueJobs, nextCron, ccaltHome,
} from "./jobs.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "proov.mjs");

// Spawn a detached background job. Returns the job record (status starts "queued"; the child flips
// it to running/done/failed). The detached child outlives this process.
export function spawnBackground(task, dir) {
  // The detached-spawn model (unref + stdio ignore) is POSIX-shaped. On win32 the child does not
  // reliably outlive the parent the same way, so fail with a clear, actionable message instead of
  // leaving a half-started ghost job. macOS/Linux are unaffected.
  if (process.platform === "win32") {
    throw new Error("background tasks need a POSIX shell on this platform (win32 not supported); run the task in the foreground or under WSL.");
  }
  fs.mkdirSync(jobsDir(), { recursive: true });
  const rec = newJobRecord({ task, dir, kind: "bg" });
  writeJob(rec);
  // The child is a thin runner mode of the CLI so it can update the status record around the run.
  let child;
  try {
    child = spawn(process.execPath, [BIN, "--__bg-run", rec.id], {
      detached: true,
      stdio: "ignore",            // the runner itself opens the log file for the inner one-shot
      env: process.env,
    });
    child.unref();
  } catch (e) {
    // detached spawn unsupported / blocked on this platform — surface clearly, mark the record failed.
    updateJob(rec.id, { status: "failed", endedAt: Date.now(), exitCode: 1, error: String(e?.message || e) });
    throw new Error(`background tasks need a POSIX shell on this platform: ${String(e?.message || e)}`);
  }
  return { ...rec, pid: child.pid };
}

// The runner the detached child executes (bin dispatches `--__bg-run <id>` here). It marks the job
// running, runs proov one-shot --auto with output appended to the log, then marks done/failed.
export async function runBackgroundJob(id, { loadConfig, runOneShotInProcess }) {
  const { readJob } = await import("./jobs.mjs");
  const rec = readJob(id);
  if (!rec) { process.stderr.write(`bg-run: no job ${id}\n`); return 1; }
  updateJob(id, { status: "running", startedAt: Date.now(), pid: process.pid });
  const lp = logPath(id);
  const log = fs.createWriteStream(lp, { flags: "a" });
  const ts = new Date().toISOString();
  log.write(`=== proov bg job ${id} @ ${ts} ===\ntask: ${rec.task}\ndir:  ${rec.dir}\n\n`);
  let code = 0;
  try {
    code = await runOneShotInProcess(rec.task, rec.dir, log);
  } catch (e) {
    log.write(`\n[bg-run error] ${e?.stack || e?.message || e}\n`);
    code = 1;
  }
  log.write(`\n=== finished exit=${code} @ ${new Date().toISOString()} ===\n`);
  await new Promise(r => log.end(r));
  updateJob(id, { status: code === 0 ? "done" : "failed", endedAt: Date.now(), exitCode: code });
  return code;
}

// Foreground poller. Runs until the process is killed. Each tick: spawn due jobs, reschedule cron.
// When daemon:true it claims the scheduler pidfile and clears it on SIGTERM/SIGINT for clean stop.
export async function runScheduler({ intervalMs = 30000, onTick, daemon = false } = {}) {
  if (daemon) {
    claimSchedulerPidfile();
    const cleanup = () => { try { fs.unlinkSync(schedulerPidPath()); } catch { /* gone */ } process.exit(0); };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  } else {
    process.stdout.write(`proov scheduler: polling every ${Math.round(intervalMs / 1000)}s — file: ${path.join(os.homedir(), ".proov", "schedule.json")}\n`);
    process.stdout.write("(this is a simple foreground poller, not a system daemon — run with --daemon to detach.)\n");
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    tickScheduler();
    if (onTick) onTick();
    await sleep(intervalMs);
  }
}

// One poll tick (pure-ish: reads/writes the schedule file + spawns bg jobs). Exposed for tests via
// an injectable spawner. Returns the list of fired job ids.
export function tickScheduler(now = Date.now(), spawn = spawnBackground) {
  const schedule = readSchedule();
  if (!schedule.length) return [];
  const due = dueJobs(schedule, now);
  const fired = [];
  for (const job of due) {
    try { spawn(job.task, job.dir); fired.push(job.id); } catch { continue; }
    job.lastRun = now;
    if (job.kind === "cron") {
      const next = nextCron(job.cron, now);
      if (next == null) { job.status = "done"; job.dueAt = null; }
      else { job.dueAt = next; job.status = "scheduled"; }
    } else {
      job.status = "done"; // once: don't run again
    }
  }
  if (fired.length) writeSchedule(schedule);
  return fired;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- scheduler-as-a-service: detach a long-running poller, track it via a pidfile -----------------

export function schedulerPidPath() { return path.join(ccaltHome(), "scheduler.pid"); }

// Is a pid alive? signal 0 probes without sending. Returns false on ESRCH / bad pid.
export function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e && e.code === "EPERM"; } // EPERM = exists but not ours; ESRCH = gone
}

// Read the scheduler pidfile -> { pid, running } (running reflects an actual live process).
export function schedulerStatus() {
  const pf = schedulerPidPath();
  let pid = null;
  try { pid = parseInt(fs.readFileSync(pf, "utf8").trim(), 10); } catch { return { running: false, pid: null, pidfile: pf }; }
  if (!Number.isFinite(pid)) return { running: false, pid: null, pidfile: pf };
  const running = pidAlive(pid);
  return { running, pid, pidfile: pf };
}

// Start a DETACHED scheduler daemon (same shape as spawnBackground: detached + stdio ignore + unref)
// and write its pid to the pidfile. Refuses if one is already running. Returns { ok, pid } / { ok:false }.
export function startSchedulerDaemon({ intervalMs } = {}) {
  if (process.platform === "win32") return { ok: false, error: "background tasks need a POSIX shell on this platform (win32 not supported)" };
  const st = schedulerStatus();
  if (st.running) return { ok: false, error: "ALREADY_RUNNING", pid: st.pid };
  fs.mkdirSync(ccaltHome(), { recursive: true });
  const args = [BIN, "scheduler", "--__daemon-child"];
  if (intervalMs) args.push("--every", String(Math.round(intervalMs / 1000)));
  let child;
  try {
    child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env });
    child.unref();
  } catch (e) {
    return { ok: false, error: `detached spawn failed: ${String(e?.message || e)}` };
  }
  try { fs.writeFileSync(schedulerPidPath(), String(child.pid) + "\n"); } catch { /* best-effort */ }
  return { ok: true, pid: child.pid };
}

// Stop the daemon: read pidfile, kill it (SIGTERM), remove the pidfile. Returns { ok, pid } or reason.
export function stopSchedulerDaemon() {
  const st = schedulerStatus();
  if (!st.pid) return { ok: false, error: "NOT_RUNNING" };
  let killed = false;
  if (st.running) { try { process.kill(st.pid, "SIGTERM"); killed = true; } catch { /* already gone */ } }
  try { fs.unlinkSync(schedulerPidPath()); } catch { /* gone */ }
  return { ok: true, pid: st.pid, killed, wasRunning: st.running };
}

// The detached daemon writes its OWN pid (the real child pid may differ from the recorded one if the
// runtime re-execs). Call at daemon start so `status`/`stop` track the live process accurately.
export function claimSchedulerPidfile() {
  try { fs.mkdirSync(ccaltHome(), { recursive: true }); fs.writeFileSync(schedulerPidPath(), String(process.pid) + "\n"); } catch { /* ignore */ }
}
