// config.mjs — layered configuration with explicit precedence.
//
//   flags  >  ./.proov.json (local)  >  ~/.proov.json (home)  >  env  >  defaults
//
// Keys: model, apiKey, baseUrl, approval ('auto'|'edits'|'all'), maxSteps, maxTokensPerTurn.
// resolveConfig() is PURE given its inputs (you inject the file loaders + env), so it's testable
// with no real filesystem. loadConfig() wires it to the real FS/env for production use.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APPROVAL_MODES } from "./safety.mjs";

export const DEFAULTS = {
  model: "google/gemini-2.5-flash",
  apiKey: "",
  baseUrl: "https://openrouter.ai/api/v1",
  // Approval mode. DEFAULT 'auto' = apply edits + run commands WITHOUT prompting (no "apply? [Y/n/a/s]"),
  // so the agent works end-to-end uninterrupted. The destructive-command blocklist and the workdir sandbox
  // still apply in every mode. Set 'edits' to confirm edits-to-existing-files + commands, or 'all' for everything.
  approval: "auto",
  // Rolling context compression (Block 34): elide old reconstructable tool results. true = on (saves tokens).
  compress: true,
  // Model context window in tokens (Block 88). 0 = unknown → proov LEARNS it from the API's overflow error and
  // trims-and-retries; set it to fit proactively from turn one (e.g. 262144 for a 256K model).
  contextLimit: 0,
  // Debug log (Block 90): ON by default. Appends a JSONL trace — RAW provider requests & responses (API key
  // redacted), tool calls + results, errors — to debugFile. "" → ~/.proov/debug.log. Set debug:false to disable.
  debug: true,
  debugFile: "",
  // Prompt-cache TTL for the stable system prefix (Anthropic/Claude models). "" / "5m" = ephemeral 5-min
  // (cheapest write); "1h" = 1-hour cache so the big system prompt survives idle gaps between REPL turns.
  cacheTtl: "",
  // Optional 2nd model for EDITING / bug-fixing (the main `model` creates files). "" = use one model for all.
  editModel: "",
  // STRONG model used ONLY for critical/escalation turns — when the cheap default `model` gets STUCK
  // (no forward progress) the supervisor switches to this for one round to break through, then reverts.
  // Keeps the expensive model to ~1% of turns. "" = never escalate (stay on `model`).
  strongModel: "",
  // Vision JUDGE model: critiques a built game's render against the request in the done-gate (Block 37).
  // Must be multimodal. "none"/"" disables. Default: a strong, cheap vision model.
  verifyModel: "google/gemini-3.5-flash",
  // Image-generation model for DESIGN-FIRST reference mockups (Block 65): proov can generate a reference
  // image of the intended design BEFORE coding, then build to MATCH it (the visual-match gate enforces ≥95%
  // per-asset). Must be an OpenRouter IMAGE-OUTPUT model. "" disables auto reference generation.
  imageModel: "google/gemini-2.5-flash-image",
  // DESIGN-FIRST (Block 67): for a fresh VISUAL build, proov DRAWS a reference image (imageModel) BEFORE the
  // agent codes, deterministically — so the visual-match + beyond-frame gates have a target to enforce
  // (instead of relying on the model to remember to generate one). true = on. Needs imageModel + a key.
  designFirst: true,
  // CLI bottom status box (Block 82): a pinned terminal footer during a run — live elapsed timer + the task
  // tree + the current task. true = on (TTY only). Set false to disable if your terminal mis-renders it.
  liveBox: true,
  // WORKFLOW EVENT EMISSION (Block 76): emit structured, BPMN-step-tagged events so an external monitor can
  // show progress in real time. eventsUrl = HTTP endpoint to POST each event to (the monitor's /ingest);
  // eventsFile = append NDJSON to this path. Either/both; empty = off. Fire-and-forget (never breaks a run).
  eventsUrl: "",
  eventsFile: "",
  // Per-request timeout (ms) for the model call. SLOW or reasoning models (e.g. qwen3-coder-next) and big
  // create turns easily exceed a tight timeout — too short → the request is aborted mid-generation and
  // RETRIED (re-sending the whole context). 120s default gives slow models room; raise for very slow ones.
  requestTimeoutMs: 120000,
  // runUntilDone (Block 46): keep auto-continuing every task until all checklist items are done AND verified,
  // or a budget / no-forward-progress stop. ON BY DEFAULT (the agent doesn't stop half-done and wait for you
  // to retype "continue"). Set untilDone:false to revert to one-turn-at-a-time. untilDoneMaxRounds bounds the
  // continuation rounds; untilDoneCostCap is an optional USD ceiling (0 = none, rely on the round cap).
  untilDone: true,
  untilDoneMaxRounds: 12,
  untilDoneCostCap: 0,
  // No artificial step cap by default — the agent runs until the task is DONE (or a real safety stop:
  // repeated-identical-call spin detection, no-progress, abort, or a provider error). Set a finite
  // --max-steps / maxSteps only if you WANT a hard cap.
  maxSteps: Infinity,
  maxTokensPerTurn: 4000,
};

// Parse a maxSteps value: "unlimited"/"none"/"off"/"inf"/0/negative ⇒ Infinity (no cap); a positive
// number ⇒ that cap. Returns null for junk so the caller can warn.
export function parseMaxSteps(v) {
  if (v === Infinity) return Infinity;
  const s = String(v).trim().toLowerCase();
  if (s === "unlimited" || s === "none" || s === "off" || s === "inf" || s === "infinity" || s === "0" || s === "-1") return Infinity;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

const KNOWN_KEYS = Object.keys(DEFAULTS);

// Map env vars onto config keys. Only set keys that are actually present (so they don't clobber
// a higher-priority undefined with an empty string). MODEL kept for back-compat with the old CLI.
function fromEnv(env) {
  const out = {};
  // BACK-COMPAT: read PROOV_* but fall back to the old SLIVR_* names so existing setups keep working.
  const v = (k) => env["PROOV_" + k] ?? env["SLIVR_" + k];
  if (env.MODEL) out.model = env.MODEL;
  if (v("MODEL")) out.model = v("MODEL");
  if (v("EDIT_MODEL")) out.editModel = v("EDIT_MODEL");
  if (v("VERIFY_MODEL")) out.verifyModel = v("VERIFY_MODEL");
  if (v("IMAGE_MODEL")) out.imageModel = v("IMAGE_MODEL");
  if (v("EVENTS_URL")) out.eventsUrl = v("EVENTS_URL");
  if (v("EVENTS_FILE")) out.eventsFile = v("EVENTS_FILE");
  if (env.OPENROUTER_API_KEY) out.apiKey = env.OPENROUTER_API_KEY;
  if (v("API_KEY")) out.apiKey = v("API_KEY");
  if (v("BASE_URL")) out.baseUrl = v("BASE_URL");
  if (v("APPROVAL")) out.approval = v("APPROVAL");
  if (v("MAX_STEPS")) { const ms = parseMaxSteps(v("MAX_STEPS")); if (ms !== null) out.maxSteps = ms; }
  if (v("MAX_TOKENS")) out.maxTokensPerTurn = Number(v("MAX_TOKENS"));
  if (v("CONTEXT_LIMIT")) { const n = Number(v("CONTEXT_LIMIT")); if (Number.isFinite(n) && n > 0) out.contextLimit = n; }
  if (v("DEBUG") !== undefined && v("DEBUG") !== "") out.debug = !/^(0|false|no|off)$/i.test(String(v("DEBUG")).trim());
  if (v("DEBUG_FILE")) out.debugFile = v("DEBUG_FILE");
  if (v("TIMEOUT")) { const n = Number(v("TIMEOUT")); if (Number.isFinite(n) && n > 0) out.requestTimeoutMs = n; }
  return out;
}

// Keep only known keys with defined, sane values. Coerces numeric strings. Drops junk silently,
// but records a warning (via `warn`) when a KNOWN key has an invalid value, so the user learns
// their setting was ignored instead of it vanishing without a trace.
function sanitize(obj, source, warn) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  const note = (msg) => { if (typeof warn === "function") warn(`${source}: ${msg}`); };
  for (const k of KNOWN_KEYS) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") continue;
    let v = obj[k];
    if (k === "maxSteps") {
      const ms = parseMaxSteps(v);
      if (ms === null) { note(`ignored maxSteps=${JSON.stringify(v)} (use a positive number, or "unlimited")`); continue; }
      v = ms;
    } else if (k === "maxTokensPerTurn") {
      const num = Number(v);
      if (!Number.isFinite(num) || num <= 0) { note(`ignored ${k}=${JSON.stringify(v)} (must be a positive number)`); continue; }
      v = num;
    }
    if (k === "approval" && !APPROVAL_MODES.includes(v)) { note(`ignored approval=${JSON.stringify(v)} (use one of: ${APPROVAL_MODES.join(", ")})`); continue; }
    out[k] = v;
  }
  // mcpServers is a structured passthrough (not a scalar): keep it verbatim if it's an object.
  if (obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)) {
    out.mcpServers = obj.mcpServers;
  }
  return out;
}

// PURE merge. layers are passed lowest→highest priority; later wins. Returns { config, sources }.
// sources records which layer supplied each final value (handy for `config` output / debugging).
export function resolveConfig({ flags = {}, local = {}, home = {}, env = {} } = {}) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const layers = [
    { name: "default", data: DEFAULTS },
    { name: "env", data: sanitize(fromEnv(env), "env", warn) },
    { name: "home", data: sanitize(home, "~/.proov.json", warn) },
    { name: "local", data: sanitize(local, "./.proov.json", warn) },
    { name: "flags", data: sanitize(flags, "flags", warn) },
  ];
  const config = {};
  const sources = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer.data)) {
      config[k] = v;
      sources[k] = layer.name;
    }
  }
  return { config, sources, warnings };
}

function readJSONSafe(file, warn) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // malformed config never crashes the tool — but tell the user it was ignored.
    if (typeof warn === "function") warn(`${file}: could not parse (${e.message}) — this file was IGNORED`);
    return {};
  }
}

// Wire resolveConfig to the real environment. cwd defaults to process.cwd().
export function loadConfig({ flags = {}, cwd = process.cwd(), env = process.env } = {}) {
  const fileWarnings = [];
  const localPath = path.join(cwd, ".proov.json");
  const homePath = path.join(os.homedir(), ".proov.json");
  // BACK-COMPAT: prefer the new .proov.json, but fall back to the old .slivr.json when the new one is absent,
  // so an existing config keeps working after the rebrand.
  const oldLocal = path.join(cwd, ".slivr.json"), oldHome = path.join(os.homedir(), ".slivr.json");
  const local = readJSONSafe(fs.existsSync(localPath) ? localPath : oldLocal, (m) => fileWarnings.push(m));
  const home = readJSONSafe(fs.existsSync(homePath) ? homePath : oldHome, (m) => fileWarnings.push(m));
  // Portable key fallback: if no key in env, read OPENROUTER_API_KEY from a cwd .env/.env.local
  // so `proov config` reflects the SAME key the provider will actually use (no silent mismatch).
  let env2 = env;
  if (!env.OPENROUTER_API_KEY && !env.PROOV_API_KEY && !env.SLIVR_API_KEY) {
    const k = readDotenvKey(cwd);
    if (k) env2 = { ...env, OPENROUTER_API_KEY: k };
  }
  const { config, sources, warnings } = resolveConfig({ flags, local, home, env: env2 });
  return { config, sources, warnings: [...fileWarnings, ...warnings], paths: { local: localPath, home: homePath } };
}

function readDotenvKey(cwd) {
  for (const f of [".env.local", ".env"]) {
    try {
      for (const l of fs.readFileSync(path.join(cwd, f), "utf8").split("\n")) {
        const m = l.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.*)$/);
        if (m) return m[1].trim().replace(/^["']|["']$/g, "");
      }
    } catch { /* try next */ }
  }
  return "";
}

// Starter config written by `--init`. Comments-as-strings since JSON has no comments.
export const STARTER_CONFIG = {
  model: "google/gemini-2.5-flash",
  baseUrl: "https://openrouter.ai/api/v1",
  approval: "auto",
  maxSteps: "unlimited",
  maxTokensPerTurn: 4000,
  "//approval": "auto = apply edits + run commands without prompting (destructive blocklist + sandbox still apply); use 'edits' or 'all' to confirm more",
  "//maxSteps": 'no step cap by default; set a positive number to cap turns per run (or "unlimited")',
  "//apiKey": "prefer the OPENROUTER_API_KEY env var over storing the key here",
  "//model": "any OpenRouter model id works: anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-2.5-flash",
  "//mcpServers": "optional: connect external MCP servers; their tools appear as mcp__<server>__<tool>",
  mcpServers: {
    "//example": "remove the leading // to enable; Claude-Desktop-compatible shape",
    "//everything": { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], env: {}, disabled: true }
  }
};

export function writeStarterConfig(cwd = process.cwd()) {
  const target = path.join(cwd, ".proov.json");
  if (fs.existsSync(target)) return { ok: false, error: "EXISTS", path: target };
  fs.writeFileSync(target, JSON.stringify(STARTER_CONFIG, null, 2) + "\n");
  return { ok: true, path: target };
}
