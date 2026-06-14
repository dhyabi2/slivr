// scheduler.mjs — spawn detached background jobs + a simple foreground poller for scheduled jobs.
//
// spawnBackground(task,dir): forks a DETACHED cc-alt one-shot --auto whose output is redirected to
//   ~/.cc-alt/jobs/<id>.log; a <id>.json status record tracks queued/running/done/failed. The child
//   is the *runner* (bin --__bg-run <id>) which flips status to running, then done/failed on exit.
//
// runScheduler(): a foreground sleep-loop. Every `intervalMs` it reads ~/.cc-alt/schedule.json,
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
  readSchedule, writeSchedule, dueJobs, nextCron,
} from "./jobs.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cc-alt.mjs");

// Spawn a detached background job. Returns the job record (status starts "queued"; the child flips
// it to running/done/failed). The detached child outlives this process.
export function spawnBackground(task, dir) {
  fs.mkdirSync(jobsDir(), { recursive: true });
  const rec = newJobRecord({ task, dir, kind: "bg" });
  writeJob(rec);
  // The child is a thin runner mode of the CLI so it can update the status record around the run.
  const child = spawn(process.execPath, [BIN, "--__bg-run", rec.id], {
    detached: true,
    stdio: "ignore",            // the runner itself opens the log file for the inner one-shot
    env: process.env,
  });
  child.unref();
  return { ...rec, pid: child.pid };
}

// The runner the detached child executes (bin dispatches `--__bg-run <id>` here). It marks the job
// running, runs cc-alt one-shot --auto with output appended to the log, then marks done/failed.
export async function runBackgroundJob(id, { loadConfig, runOneShotInProcess }) {
  const { readJob } = await import("./jobs.mjs");
  const rec = readJob(id);
  if (!rec) { process.stderr.write(`bg-run: no job ${id}\n`); return 1; }
  updateJob(id, { status: "running", startedAt: Date.now(), pid: process.pid });
  const lp = logPath(id);
  const log = fs.createWriteStream(lp, { flags: "a" });
  const ts = new Date().toISOString();
  log.write(`=== cc-alt bg job ${id} @ ${ts} ===\ntask: ${rec.task}\ndir:  ${rec.dir}\n\n`);
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
export async function runScheduler({ intervalMs = 30000, onTick } = {}) {
  process.stdout.write(`cc-alt scheduler: polling every ${Math.round(intervalMs / 1000)}s — file: ${path.join(os.homedir(), ".cc-alt", "schedule.json")}\n`);
  process.stdout.write("(this is a simple foreground poller, not a system daemon — keep it running.)\n");
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
