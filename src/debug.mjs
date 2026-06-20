// debug.mjs — default-ON debug log (Block 90). Appends a JSONL trace of everything useful for diagnosing a run
// — RAW provider requests & responses (with the API key REDACTED), tool calls + results, gate decisions, and
// errors — to a single file. A configurable singleton: the CLI entry calls configureDebug() once at startup;
// every module then imports debugLog() and writes without threading a logger through constructors. It is OFF by
// default at the module level (so library/test use never writes); the CLI turns it ON (config.debug, default
// true). debugLog NEVER throws — a logging failure must never break a run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = { enabled: false, file: "", started: false };

// The default location: the home .proov dir (already used for the journal/skills) — one discoverable file.
export function defaultDebugFile() { return path.join(os.homedir(), ".proov", "debug.log"); }

// Enable/locate the log. enabled defaults to true (the CLI passes config.debug); file "" → defaultDebugFile().
export function configureDebug({ enabled = true, file = "" } = {}) {
  STATE.enabled = enabled !== false;
  STATE.file = file || defaultDebugFile();
  STATE.started = false;
  return STATE.file;
}
export function debugEnabled() { return !!STATE.enabled; }
export function debugFilePath() { return STATE.file; }

// Redact secrets from anything we serialize: Authorization headers, api-key fields, and OpenRouter "sk-or-…"
// tokens wherever they appear. Used as a JSON.stringify replacer so it's a SINGLE pass (no double-serialize of
// the big request bodies). The raw messages/response bodies are kept in full — that's the point of the log.
function secretReplacer(key, value) {
  if (typeof key === "string" && /^(authorization|api[_-]?key|key|x-api-key|apiKey)$/i.test(key)) return "***REDACTED***";
  if (typeof value === "string") {
    let v = value;
    if (/^Bearer\s+\S+/i.test(v)) v = "Bearer ***REDACTED***";
    v = v.replace(/sk-or-[A-Za-z0-9._-]{6,}/g, "sk-or-***REDACTED***");
    return v;
  }
  return value;
}

// Append one event. `event` is a short tag (e.g. "request", "response", "tool_call"); `data` is any JSON value.
export function debugLog(event, data = {}) {
  if (!STATE.enabled || !STATE.file) return;
  try {
    if (!STATE.started) {
      fs.mkdirSync(path.dirname(STATE.file), { recursive: true });
      fs.appendFileSync(STATE.file, `\n# ===== proov run @ ${new Date().toISOString()} · pid ${process.pid} · ${process.cwd()} =====\n`);
      STATE.started = true;
    }
    fs.appendFileSync(STATE.file, JSON.stringify({ ts: new Date().toISOString(), event, ...data }, secretReplacer) + "\n");
  } catch { /* logging must NEVER break a run */ }
}
