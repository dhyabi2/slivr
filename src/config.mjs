// config.mjs — layered configuration with explicit precedence.
//
//   flags  >  ./.slivr.json (local)  >  ~/.slivr.json (home)  >  env  >  defaults
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
  approval: "edits",
  // Rolling context compression (Block 34): elide old reconstructable tool results. true = on (saves tokens).
  compress: true,
  // Optional 2nd model for EDITING / bug-fixing (the main `model` creates files). "" = use one model for all.
  editModel: "",
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
  if (env.MODEL) out.model = env.MODEL;
  if (env.SLIVR_MODEL) out.model = env.SLIVR_MODEL;
  if (env.SLIVR_EDIT_MODEL) out.editModel = env.SLIVR_EDIT_MODEL;
  if (env.OPENROUTER_API_KEY) out.apiKey = env.OPENROUTER_API_KEY;
  if (env.SLIVR_API_KEY) out.apiKey = env.SLIVR_API_KEY;
  if (env.SLIVR_BASE_URL) out.baseUrl = env.SLIVR_BASE_URL;
  if (env.SLIVR_APPROVAL) out.approval = env.SLIVR_APPROVAL;
  if (env.SLIVR_MAX_STEPS) { const ms = parseMaxSteps(env.SLIVR_MAX_STEPS); if (ms !== null) out.maxSteps = ms; }
  if (env.SLIVR_MAX_TOKENS) out.maxTokensPerTurn = Number(env.SLIVR_MAX_TOKENS);
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
    { name: "home", data: sanitize(home, "~/.slivr.json", warn) },
    { name: "local", data: sanitize(local, "./.slivr.json", warn) },
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
  const localPath = path.join(cwd, ".slivr.json");
  const homePath = path.join(os.homedir(), ".slivr.json");
  const local = readJSONSafe(localPath, (m) => fileWarnings.push(m));
  const home = readJSONSafe(homePath, (m) => fileWarnings.push(m));
  // Portable key fallback: if no key in env, read OPENROUTER_API_KEY from a cwd .env/.env.local
  // so `slivr config` reflects the SAME key the provider will actually use (no silent mismatch).
  let env2 = env;
  if (!env.OPENROUTER_API_KEY && !env.SLIVR_API_KEY) {
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
  approval: "edits",
  maxSteps: "unlimited",
  maxTokensPerTurn: 4000,
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
  const target = path.join(cwd, ".slivr.json");
  if (fs.existsSync(target)) return { ok: false, error: "EXISTS", path: target };
  fs.writeFileSync(target, JSON.stringify(STARTER_CONFIG, null, 2) + "\n");
  return { ok: true, path: target };
}
