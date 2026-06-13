// config.mjs — layered configuration with explicit precedence.
//
//   flags  >  ./.cc-alt.json (local)  >  ~/.cc-alt.json (home)  >  env  >  defaults
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
  maxSteps: 16,
  maxTokensPerTurn: 4000,
};

const KNOWN_KEYS = Object.keys(DEFAULTS);

// Map env vars onto config keys. Only set keys that are actually present (so they don't clobber
// a higher-priority undefined with an empty string). MODEL kept for back-compat with the old CLI.
function fromEnv(env) {
  const out = {};
  if (env.MODEL) out.model = env.MODEL;
  if (env.CCALT_MODEL) out.model = env.CCALT_MODEL;
  if (env.OPENROUTER_API_KEY) out.apiKey = env.OPENROUTER_API_KEY;
  if (env.CCALT_API_KEY) out.apiKey = env.CCALT_API_KEY;
  if (env.CCALT_BASE_URL) out.baseUrl = env.CCALT_BASE_URL;
  if (env.CCALT_APPROVAL) out.approval = env.CCALT_APPROVAL;
  if (env.CCALT_MAX_STEPS) out.maxSteps = Number(env.CCALT_MAX_STEPS);
  if (env.CCALT_MAX_TOKENS) out.maxTokensPerTurn = Number(env.CCALT_MAX_TOKENS);
  return out;
}

// Keep only known keys with defined, sane values. Coerces numeric strings. Drops junk silently.
function sanitize(obj, source) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of KNOWN_KEYS) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") continue;
    let v = obj[k];
    if (k === "maxSteps" || k === "maxTokensPerTurn") {
      v = Number(v);
      if (!Number.isFinite(v) || v <= 0) continue;
    }
    if (k === "approval" && !APPROVAL_MODES.includes(v)) continue;
    out[k] = v;
  }
  return out;
}

// PURE merge. layers are passed lowest→highest priority; later wins. Returns { config, sources }.
// sources records which layer supplied each final value (handy for `config` output / debugging).
export function resolveConfig({ flags = {}, local = {}, home = {}, env = {} } = {}) {
  const layers = [
    { name: "default", data: DEFAULTS },
    { name: "env", data: sanitize(fromEnv(env), "env") },
    { name: "home", data: sanitize(home, "home") },
    { name: "local", data: sanitize(local, "local") },
    { name: "flags", data: sanitize(flags, "flags") },
  ];
  const config = {};
  const sources = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer.data)) {
      config[k] = v;
      sources[k] = layer.name;
    }
  }
  return { config, sources };
}

function readJSONSafe(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return {}; } // malformed config never crashes the tool
}

// Wire resolveConfig to the real environment. cwd defaults to process.cwd().
export function loadConfig({ flags = {}, cwd = process.cwd(), env = process.env } = {}) {
  const localPath = path.join(cwd, ".cc-alt.json");
  const homePath = path.join(os.homedir(), ".cc-alt.json");
  const local = readJSONSafe(localPath);
  const home = readJSONSafe(homePath);
  const { config, sources } = resolveConfig({ flags, local, home, env });
  return { config, sources, paths: { local: localPath, home: homePath } };
}

// Starter config written by `--init`. Comments-as-strings since JSON has no comments.
export const STARTER_CONFIG = {
  model: "google/gemini-2.5-flash",
  baseUrl: "https://openrouter.ai/api/v1",
  approval: "edits",
  maxSteps: 16,
  maxTokensPerTurn: 4000,
  "//apiKey": "prefer the OPENROUTER_API_KEY env var over storing the key here",
  "//model": "any OpenRouter model id works: anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-2.5-flash"
};

export function writeStarterConfig(cwd = process.cwd()) {
  const target = path.join(cwd, ".cc-alt.json");
  if (fs.existsSync(target)) return { ok: false, error: "EXISTS", path: target };
  fs.writeFileSync(target, JSON.stringify(STARTER_CONFIG, null, 2) + "\n");
  return { ok: true, path: target };
}
