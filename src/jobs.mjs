// jobs.mjs — background + scheduled task store (lives under ~/.cc-alt/).
//
//   ~/.cc-alt/jobs/<id>.json   one record per background job: { id, task, dir, status, ... }
//   ~/.cc-alt/jobs/<id>.log    captured stdout+stderr of that job
//   ~/.cc-alt/schedule.json    array of scheduled jobs the `scheduler` poller runs when due
//
// Background jobs are run by a DETACHED child that re-invokes cc-alt one-shot --auto (see bin).
// The pure helpers here (id, duration parsing, store read/write, due-check) are unit-tested with
// no child process. HONEST: `scheduler` is a foreground sleep-loop poller, not a system daemon.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ccaltHome() { return path.join(os.homedir(), ".cc-alt"); }
export function jobsDir() { return path.join(ccaltHome(), "jobs"); }
export function schedulePath() { return path.join(ccaltHome(), "schedule.json"); }

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// short, sortable, collision-resistant id: <base36 time>-<rand>.
export function makeId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

// Parse a relative duration like "30m", "2h", "45s", "1d", "90" (bare = seconds) into ms.
// Returns null on garbage.
export function parseDuration(s) {
  if (s == null) return null;
  const str = String(s).trim().toLowerCase();
  const m = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] || "s";
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return Math.round(n * mult);
}

// --- background job records (one json file each) ---

export function jobPath(id) { return path.join(jobsDir(), id + ".json"); }
export function logPath(id) { return path.join(jobsDir(), id + ".log"); }

export function writeJob(rec) {
  ensureDir(jobsDir());
  fs.writeFileSync(jobPath(rec.id), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

export function readJob(id) {
  try { return JSON.parse(fs.readFileSync(jobPath(id), "utf8")); } catch { return null; }
}

// Patch an existing job record on disk (merge fields). No-op if it doesn't exist yet.
export function updateJob(id, patch) {
  const cur = readJob(id);
  if (!cur) return null;
  return writeJob({ ...cur, ...patch });
}

export function listJobs() {
  let files = [];
  try { files = fs.readdirSync(jobsDir()).filter(f => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(jobsDir(), f), "utf8"))); } catch { /* skip */ }
  }
  // newest first (id is time-prefixed base36, but createdAt is authoritative)
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

export function newJobRecord({ task, dir, kind = "bg" }) {
  const id = makeId();
  return { id, kind, task, dir: dir || process.cwd(), status: "queued", createdAt: Date.now(), startedAt: null, endedAt: null, exitCode: null };
}

// --- scheduled jobs (array in one json file) ---

export function readSchedule() {
  try {
    const arr = JSON.parse(fs.readFileSync(schedulePath(), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function writeSchedule(arr) {
  ensureDir(ccaltHome());
  fs.writeFileSync(schedulePath(), JSON.stringify(arr, null, 2) + "\n");
  return arr;
}

export function addScheduled(rec) {
  const arr = readSchedule();
  arr.push(rec);
  writeSchedule(arr);
  return rec;
}

// Build a scheduled record from CLI-ish options. Exactly one timing source should be set.
//   { in: "30m" } | { at: "2026-06-14T15:00:00Z" } | { cron: "*/5 * * * *" }
// Returns { ok, rec } or { ok:false, error }.
export function makeScheduled({ task, dir, in: inDur, at, cron } = {}) {
  if (!task || !String(task).trim()) return { ok: false, error: "NO_TASK" };
  const id = makeId();
  const base = { id, task: String(task), dir: dir || process.cwd(), createdAt: Date.now(), status: "scheduled", lastRun: null };
  if (inDur != null) {
    const ms = parseDuration(inDur);
    if (ms == null) return { ok: false, error: "BAD_DURATION", value: inDur };
    return { ok: true, rec: { ...base, kind: "once", dueAt: Date.now() + ms, spec: `in ${inDur}` } };
  }
  if (at != null) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return { ok: false, error: "BAD_AT", value: at };
    return { ok: true, rec: { ...base, kind: "once", dueAt: t, spec: `at ${at}` } };
  }
  if (cron != null) {
    const next = nextCron(cron, Date.now());
    if (next == null) return { ok: false, error: "BAD_CRON", value: cron };
    return { ok: true, rec: { ...base, kind: "cron", cron: String(cron), dueAt: next, spec: `cron ${cron}` } };
  }
  return { ok: false, error: "NO_TIMING", hint: "pass --in <dur>, --at <ISO>, or --cron <expr>" };
}

// Which scheduled jobs are due at time `now`? (dueAt <= now and not already running)
export function dueJobs(schedule, now = Date.now()) {
  return (schedule || []).filter(j => j && j.status !== "running" && typeof j.dueAt === "number" && j.dueAt <= now);
}

// --- minimal 5-field cron (min hour dom month dow). Supports *, */n, n, lists a,b, ranges a-b.
// Good enough for "every 5 minutes" / "at 9am daily". Returns next epoch-ms after `from`, or null
// on a malformed expression. Steps minute-by-minute up to ~366 days; returns null if none found.
export function nextCron(expr, from = Date.now()) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  let fields;
  try { fields = parts.map((f, i) => parseCronField(f, CRON_RANGES[i])); } catch { return null; }
  if (fields.some(f => f == null)) return null;
  const [min, hour, dom, mon, dow] = fields;
  // start from the next whole minute after `from`
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from + 366 * 86400000;
  while (d.getTime() <= limit) {
    if (min.has(d.getMinutes()) && hour.has(d.getHours()) && mon.has(d.getMonth() + 1)
        && dom.has(d.getDate()) && dow.has(d.getDay())) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function parseCronField(f, [lo, hi]) {
  const set = new Set();
  for (const piece of String(f).split(",")) {
    let m;
    if (piece === "*") { for (let i = lo; i <= hi; i++) set.add(i); }
    else if ((m = piece.match(/^\*\/(\d+)$/))) { const step = +m[1]; if (step <= 0) throw 0; for (let i = lo; i <= hi; i += step) set.add(i); }
    else if ((m = piece.match(/^(\d+)-(\d+)(?:\/(\d+))?$/))) { const a = +m[1], b = +m[2], step = m[3] ? +m[3] : 1; if (step <= 0 || a < lo || b > hi || a > b) throw 0; for (let i = a; i <= b; i += step) set.add(i); }
    else if ((m = piece.match(/^\d+$/))) { const n = +piece; if (n < lo || n > hi) throw 0; set.add(n); }
    else throw 0;
  }
  return set;
}
