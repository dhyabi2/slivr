// loop.mjs — the shared tool-use agent loop used by BOTH harnesses.
//
// The model emits exactly one tool call per turn as a JSON object:
//   {"tool": "read_file", "args": {...}}            // act
//   {"tool": "done", "args": {"summary": "..."}}    // finish
// The harness executes it, feeds the result back as a user message, and repeats until `done`
// or the step cap. agent.mjs and baseline.mjs supply DIFFERENT system prompts + tool maps —
// that is the only difference between our harness and the Claude-Code-style baseline.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildMultimodalContent } from "./multimodal.mjs";
import { applyControl, controlToMessage } from "./bridge.mjs";
import { compressContext, fitContext, parseContextLimit } from "./compress.mjs";
import { debugLog } from "./debug.mjs";
import { isWebGLPage, checkPageJs } from "./webcheck.mjs";
import { analyzeStructure, wantsMinimal, assetSourceViolation, animationDriverViolation, bundleGameSource, beyondFrameViolation } from "./structure.mjs";

// Detect a built WEB GAME in the workdir (a canvas + an animation loop / control contract), so the
// done-gate can verify it actually PLAYS before accepting done. Returns the html path or null.
// IMPORTANT: a 2D game has a literal <canvas> tag, but a 3D/Three.js/WebGL game CREATES its canvas
// dynamically (renderer.domElement → appendChild) so the source has NO <canvas> tag. Detecting only the
// literal tag silently skipped the ENTIRE gate for exactly the hardest class of game (3D). So we accept
// EITHER a literal <canvas> OR a WebGL/Three.js page (same signal the renderer uses), plus a loop/contract.
export function isGameHtml(html) {
  const s = String(html || "");
  const hasLoopOrContract = /(requestAnimationFrame|proovSim|slivrSim|getContext\s*\()/i.test(s);
  return hasLoopOrContract && (/<canvas/i.test(s) || isWebGLPage(s));
}
export function detectGameFile(workdir) {
  for (const name of ["index.html", "game.html"]) {
    try {
      if (isGameHtml(fs.readFileSync(path.join(workdir, name), "utf8"))) return name;
    } catch { /* not there */ }
  }
  return null;
}

// Does this task describe a VISUAL build (something whose LOOK matters — a game/UI/site)? Conservative +
// keyword-based: a clear non-visual deliverable (cli/api/script/library/backend) opts out so we never draw a
// reference for a text-only job. Drives the design-first preflight (Block 67).
// Tools that MUTATE the workspace — used by the plan-first gate (Block 73).
const MUTATING_TOOLS = new Set(["edit_file", "edit_files", "edit_symbol", "create_file", "write_file"]);
// READ-ONLY inspection tools — side-effect-free, so MANY can run CONCURRENTLY in one turn (Block 89, read_many)
// without any of the per-call mutation gates (approval / plan / syntax / blast). Collapses N exploration
// round-trips into one. Deliberately excludes anything that writes, runs commands, spawns a browser, or fetches.
const READ_ONLY_TOOLS = new Set([
  "read_file", "list_dir", "grep", "glob", "repo_map", "find_symbol", "find_refs",
  "project_info", "house_style", "git_status", "git_diff", "git_log", "blueprint_status",
]);
// A SUBSTANTIAL task warrants an up-front plan: long, or multi-clause / lists several deliverables. A short
// single-action task ("fix the typo on line 4") never trips the plan-first gate.
export function isSubstantialTask(task) {
  const s = String(task || "").trim();
  if (s.length < 30) return false;                 // truly trivial one-liners never trip it
  const clauses = (s.match(/\b(and|then|also|plus|with|including|as well as)\b|[,;]|\b\d[.)]/gi) || []).length;
  return clauses >= 2 || s.length > 180;
}

// A FAILURE fingerprint for a verification tool's result — same fingerprint recurring means the agent is
// thrashing on the SAME failure (Block 84). Returns a stable key or null (success / not a check).
export function verdictFingerprint(tool, result) {
  if (!result || typeof result !== "object") return null;
  const err = result.error ? String(result.error) : "";
  if (tool === "play_levels") {
    if (err) return "play_levels:" + err;
    if (Array.isArray(result.clones) && result.clones.length) return "play_levels:clones";
    if (result.allDistinct === false) return "play_levels:clones";
    return null;
  }
  if (tool === "play_game") { if (err) return "play_game:" + err; if (result.played === false) return "play_game:notplayable"; return null; }
  if (tool === "see_page") { if (result.broken) return "see_page:broken"; if (result.blank) return "see_page:blank"; if (err) return "see_page:" + err; return null; }
  if (tool === "autoplay") { if (result.responds === false) return "autoplay:frozen"; if (err) return "autoplay:" + err; return null; }
  if (tool === "compare_regions" || tool === "compare_image") { if (result.allPass === false || (typeof result.similarity === "number" && result.similarity < 90)) return tool + ":mismatch"; return null; }
  if (tool === "certify_level") { if (Array.isArray(result.results) && result.results.some((r) => !r.ok)) return "certify_level:unsolvable"; return null; }
  if (result.ok === false && err) return tool + ":" + err;   // generic failing tool
  return null;
}
// Targeted diagnosis for a recurring failure: explain what the CHECK actually compares + how to fix the root
// cause — so the agent stops blindly mutating and pray-re-running (the headline thrash in the eval).
export function diagnoseFor(key) {
  const k = String(key || "");
  if (/^play_levels:clones/.test(k)) return `play_levels marks two levels CLONES when their window.proovSim.state() SNAPSHOT is identical — it HASHES the state() object (IGNORING any level/index/stage field), NOT your tile map. So different MAPS don't help if state() returns the same {x,y,score,…} for each level. FIX the right thing: make state() include data that genuinely DIFFERS per level (player start x/y, enemy count, a layout hash, goal position), or load() must change those. Stop rewriting the maps — change what state() reports.`;
  if (/^play_levels:.*PARSE_FAILED|^see_page:.*broken|^play_game:.*PARSE|parse/i.test(k)) return `this is a JS SYNTAX/RUNTIME error in your last edit — the page threw before exposing window.proovSim. STOP rewriting the whole file. Call see_page {path} to get the EXACT file:line of the error, open that line, fix ONLY it, and retry. A missing semicolon/brace between statements (e.g. init();loop()window.proovSim=…) breaks the parse.`;
  if (/^autoplay:frozen/.test(k)) return `autoplay says FROZEN because the screen doesn't change on real key input — your keydown handler or update loop isn't wired to the game state. Fix the input→state→render path; don't rewrite the art.`;
  if (/mismatch/.test(k)) return `the per-asset visual compare keeps failing on the SAME regions — re-run compare_regions, read WHICH assets are red, and fix those exact positions/colours; don't regenerate the whole scene.`;
  return `you've hit the SAME failure repeatedly. STOP making the same kind of change. Re-read the tool's output carefully and fix the ROOT cause; if you don't understand WHY it fails, inspect exactly what the check compares before editing again.`;
}
// Throwaway "regenerate the whole file" scratch files — the anti-pattern that blew up cost in the eval.
export function isScratchFile(p) {
  const b = String(p || "").split("/").pop() || "";
  return /^(write|gen|make|build|create)[_-].*\.(m?js|cjs)$/i.test(b)
    || /[_-](v\d+|fresh|clean|simple|final|new|distinct|done|copy|temp|tmp|old|fix|fixed|complete|working)\.(html?|m?js|cjs)$/i.test(b)
    || /^index[_-](new|v\d+|simple|distinct|done|fixed|clean|final).*\.html?$/i.test(b);
}

// Quick syntax check of a file the agent just wrote (Block 84): node --check for JS, the inline-script check
// for HTML. Returns an array of error strings (empty = clean / not a code file).
export function quickSyntaxErrors(abs) {
  const ext = path.extname(abs).toLowerCase();
  if (/^\.html?$/.test(ext)) {
    try { const jc = checkPageJs(abs); return (jc.errors || []).map((e) => `${e.where || "script"}${e.line ? ` (line ${e.line})` : ""}: ${e.message}`); } catch { return []; }
  }
  if (/^\.(m?js|cjs)$/.test(ext)) {
    try { execSync(`node --check ${JSON.stringify(abs)}`, { stdio: ["ignore", "ignore", "pipe"], timeout: 8000 }); return []; }
    catch (e) { return String(e.stderr || e.message || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3); }
  }
  return [];
}

export function isVisualBuild(task) {
  const t = String(task || "").toLowerCase();
  if (!t.trim()) return false;
  if (/\b(cli|api|backend|server-only|script|library|package|parser|algorithm|refactor|unit test|regex|sql|cron|webhook|bug ?fix)\b/.test(t)) return false;
  return /\b(game|puzzle|platformer|shooter|rpg|arcade|sokoban|roguelike|metroidvania|maze|tetris|snake|ui|interface|website|web ?app|web ?page|landing ?page|dashboard|portfolio|mockup|design|clone|recreate|render|canvas|webgl|three\.?js|3d|2d|sprite|animation|scene|level)\b/.test(t);
}
// True when the workdir already has a built page/game (a follow-up to existing code) — don't inject a fresh
// reference mid-project; the design should have been drawn at the start.
function hasExistingBuild(workdir) {
  if (detectGameFile(workdir)) return true;
  for (const name of ["index.html", "game.html", "index.htm"]) {
    try { if (fs.statSync(path.join(workdir, name)).size > 400) return true; } catch { /* */ }
  }
  return false;
}

// Run BEFORE the first build turn: for a fresh VISUAL build with no reference yet, DRAW the target first
// (deterministic — don't rely on the model to remember). Saves reference.png so the visual-match + beyond-
// frame gates have something to enforce. Returns the saved path, or null (no-op). Block 67.
async function designFirstPreflight({ tools, task, provider }) {
  if (!tools || typeof tools.generate_image !== "function" || typeof tools._referenceImage !== "function" || !tools.workdir) return null;
  if (!provider || !provider.imageModel) return null;
  if (typeof provider.hasKey === "function" && !provider.hasKey()) return null;
  if (tools._referenceImage()) return null;            // already have a reference
  if (!isVisualBuild(task)) return null;               // only visual/game builds
  if (hasExistingBuild(tools.workdir)) return null;    // a follow-up to existing code → don't inject one now
  const prompt = `A polished, complete reference screenshot/mockup of the intended visual design — style, characters, colours, UI and layout — for this build: ${String(task).slice(0, 600)}. One representative scene, production quality.`;
  const r = await tools.generate_image({ prompt, out: "reference.png" });
  return r && r.ok ? (r.path || "reference.png") : null;
}

// SEMANTIC VISION CHECKLIST (Block 37): the deterministic gates check STRUCTURE (renders, responds, not
// flat boxes) but not whether the render actually LOOKS like what the user asked for. A single fuzzy
// "fidelity score" is unreliable; instead we ask a strong VISION model to derive a CHECKLIST of the
// concrete things a real, complete version must visibly have — then answer present:yes/no for each by
// LOOKING at the canvas. Verified ⇔ every item is present; otherwise the missing items are the punch-list.
// Returns { items:[{item,present}], missing:[item…], total, present } or null (couldn't run / unparseable).
export async function visionChecklistGame(provider, model, task, dataUrl, signal, votes = 3) {
  if (!provider || typeof provider.chat !== "function" || !model || !dataUrl) return null;
  // One vision call → [{item, present}] (or null). Parses the model's JSON checklist.
  const ask = async (prompt) => {
    try {
      const r = await provider.chat([{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }], { model, temperature: 0, signal });
      const m = String(r?.text || "").match(/\{[\s\S]*\}/);
      if (!m) return null;
      const o = JSON.parse(m[0]);
      const raw = Array.isArray(o.checklist) ? o.checklist : (Array.isArray(o.items) ? o.items : null);
      if (!raw) return null;
      return raw.filter((x) => x && typeof (x.item ?? x.requirement ?? x.q) === "string")
        .map((x) => ({ item: String(x.item ?? x.requirement ?? x.q).slice(0, 80), present: x.present === true || /^(yes|true)$/i.test(String(x.present)) }));
    } catch { return null; }
  };
  const derive = `You are a STRICT visual QA inspector. The user asked for this:\n"${String(task || "").slice(0, 400)}"\n\nThink about what a REAL, complete, polished version MUST visibly contain — the concrete, checkable things (e.g. for a platformer: a recognizable themed CHARACTER that is clearly NOT a plain coloured box; enemies; collectibles/coins; a score/HUD; textured ground or platforms; a themed background; etc. — tailor the list to THIS request). Write 5-9 such items.\nNow LOOK at this screenshot and answer, for EACH item, whether it is genuinely visible. Be strict: a plain rectangle is NOT a character; flat colour is NOT texture.\nReply with ONLY this JSON, no prose:\n{"checklist":[{"item":"<short concrete requirement>","present":true|false}, ...]}`;
  const first = await ask(derive);
  if (!first || !first.length) return null;
  const items = first.map((i) => i.item);
  // If the FIRST strict pass found nothing missing, accept (don't spend more calls). The vote only kicks in to
  // CONFIRM a potential FAILURE — so one flaky "missing" verdict can't false-fail the build (MAJORITY VOTE,
  // audit #1/#2): re-judge the SAME fixed item list and an item is missing only if MOST judges agree.
  const presentCount = new Map(first.map((i) => [i.item, i.present ? 1 : 0]));
  if (![...presentCount.values()].some((v) => v === 0)) return { items: first, missing: [], total: items.length, present: items.length, votes: 1 };
  const reJudge = `You are a STRICT visual QA inspector. LOOK at this screenshot and, for EACH required item below, answer whether it is GENUINELY visible (strict: a plain rectangle is NOT a character; flat colour is NOT texture):\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n")}\nReply with ONLY this JSON, copying each item text: {"checklist":[{"item":"<item>","present":true|false}, ...]}`;
  let rounds = 1;
  for (let k = 1; k < votes; k++) {
    const v = await ask(reJudge);
    if (!v) continue;
    rounds++;
    for (const it of v) {
      const key = items.includes(it.item) ? it.item : items.find((t) => t.includes(it.item) || it.item.includes(t));
      if (key) presentCount.set(key, (presentCount.get(key) || 0) + (it.present ? 1 : 0));
    }
  }
  const missing = items.filter((t) => (presentCount.get(t) || 0) <= rounds / 2);   // not a majority "present"
  return { items: items.map((t) => ({ item: t, present: !missing.includes(t) })), missing, total: items.length, present: items.length - missing.length, votes: rounds };
}

// VISION DESIGN REVIEW (Block 86) — the honest answer to "are these DESIGNED/PAINTED assets, or flat placeholder
// boxes?", handed to a VISION model (verifyModel defaults to a vision-capable model, independent of the coding
// model — so it works even when the coder is a code-only model). The presence checklist asks "is X there?"; this
// asks "is X real ART or a programmer-art box?" — the look/design/paint judgment the user actually cares about.
// One strict pass names the placeholder assets; a potential FAILURE is then confirmed by MAJORITY VOTE so one
// flaky verdict can't false-fail a real build. Returns { placeholders:[name…], total, votes } or null.
export async function visionDesignReview(provider, model, task, dataUrl, signal, votes = 3) {
  if (!provider || typeof provider.chat !== "function" || !model || !dataUrl) return null;
  const ask = async (prompt) => {
    try {
      const r = await provider.chat([{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }], { model, temperature: 0, signal });
      const m = String(r?.text || "").match(/\{[\s\S]*\}/);
      if (!m) return null;
      const o = JSON.parse(m[0]);
      const raw = Array.isArray(o.assets) ? o.assets : (Array.isArray(o.items) ? o.items : null);
      if (!raw) return null;
      return raw.filter((a) => a && typeof (a.name ?? a.asset ?? a.item) === "string")
        .map((a) => ({ name: String(a.name ?? a.asset ?? a.item).slice(0, 60), placeholder: a.placeholder === true || /^(yes|true|box|flat|placeholder)$/i.test(String(a.placeholder ?? a.verdict ?? "")) }));
    } catch { return null; }
  };
  const derive = `You are a STRICT art director reviewing a screenshot of a built game/app for this request:\n"${String(task || "").slice(0, 400)}"\n\nList the MAIN visible assets (each character, enemy, collectible, key prop, the ground/tiles, the HUD). For EACH, judge whether it is a DELIBERATELY DESIGNED / PAINTED asset (a recognizable form with shading and detail) or just a PLACEHOLDER — a plain flat solid-colour box or circle, programmer-art with no real form. Be strict: a coloured rectangle standing in for a character or prop is a PLACEHOLDER, flat colour is not texture.\nReply with ONLY this JSON, no prose:\n{"assets":[{"name":"<short asset name>","placeholder":true|false}, ...]}`;
  const first = await ask(derive);
  if (!first || !first.length) return null;
  const names = first.map((a) => a.name);
  const phCount = new Map(first.map((a) => [a.name, a.placeholder ? 1 : 0]));
  // nothing flagged on the strict first pass → accept (don't spend more vision calls).
  if (![...phCount.values()].some((v) => v === 1)) return { placeholders: [], total: names.length, votes: 1 };
  const reJudge = `You are a STRICT art director. LOOK at this screenshot. For EACH asset below, answer whether it is a PLACEHOLDER — a plain flat solid-colour box/circle / programmer-art with no real form (true) — or a properly designed/painted asset (false):\n${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}\nReply with ONLY this JSON, copying each name: {"assets":[{"name":"<asset>","placeholder":true|false}, ...]}`;
  let rounds = 1;
  for (let k = 1; k < votes; k++) {
    const v = await ask(reJudge);
    if (!v) continue;
    rounds++;
    for (const a of v) { const key = names.includes(a.name) ? a.name : names.find((n) => n.includes(a.name) || a.name.includes(n)); if (key) phCount.set(key, (phCount.get(key) || 0) + (a.placeholder ? 1 : 0)); }
  }
  const placeholders = names.filter((n) => (phCount.get(n) || 0) > rounds / 2);   // MAJORITY say placeholder
  return { placeholders, total: names.length, votes: rounds };
}

// Find the balanced {...} block starting at index `s`, or -1. (string/escape aware)
function balancedEnd(body, s) {
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// RESILIENT tool-call parser (Block 8): a cheap model often wraps its tool call in reasoning prose,
// or the prose itself contains stray braces (set notation, code). The old parser only tried the FIRST
// {...} — so `the set {1,2,3}, so {"tool":"create_file",...}` failed and wasted the whole turn. This
// scans EVERY balanced {...} and returns the first one that parses AND has a `tool` key (so think+act
// in one message works); it falls back to the first valid object (so a missing-tool object is still
// surfaced for the existing correction path).
// Weak/older/varied models emit tool calls in DIFFERENT shapes. The tool name may be under `tool`, `name`,
// or `function`; the arguments under `args`, `arguments` (OpenAI-style), `parameters`, `input`, as a JSON
// STRING, or FLATTENED to the top level. The model thinks it "provided the path in the JSON" — it did, just
// not under `args`. We coalesce all of these so the tool always receives its arguments.
const TOOL_KEYS = ["tool", "name", "tool_name", "toolName", "function", "action"];
const ARG_KEYS = ["args", "arguments", "parameters", "params", "input", "args_json", "argument"];
const CALL_META = new Set([...TOOL_KEYS, ...ARG_KEYS, "type", "id", "reasoning", "thought", "thinking"]);
function callToolName(obj) { for (const k of TOOL_KEYS) { if (typeof obj[k] === "string" && obj[k].trim()) return obj[k]; } return null; }
export function normalizeCall(obj) {
  if (!obj || typeof obj !== "object") return obj;
  // OpenAI tool_calls array shape: {tool_calls:[{function:{name,arguments}}]} or [{name,arguments}]
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length) { const c = obj.tool_calls[0]; obj = c.function ? { tool: c.function.name, args: c.function.arguments } : c; }
  let tool = callToolName(obj);
  if (!tool) return obj.tool ? obj : null;
  tool = String(tool).replace(/^functions[.:]\s*/i, "").trim();   // some models prefix "functions.create_file"
  let args;
  for (const k of ARG_KEYS) { if (obj[k] != null) { args = obj[k]; break; } }
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* leave as a string arg below */ } }
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    // FLATTENED: the arguments are the non-meta top-level keys (e.g. {tool:"create_file", path:"x", content:"y"})
    const rest = {}; for (const k of Object.keys(obj)) if (!CALL_META.has(k)) rest[k] = obj[k];
    args = Object.keys(rest).length ? rest : (args && typeof args === "object" ? args : {});
  }
  return { tool, args };
}

function extractJSON(text) {
  const body = String(text || "");
  let firstObj = null;
  for (let s = 0; s < body.length; s++) {
    if (body[s] !== "{") continue;
    const end = balancedEnd(body, s);
    if (end === -1) break;
    let obj;
    try { obj = JSON.parse(body.slice(s, end + 1)); } catch { continue; }
    if (obj && typeof obj === "object") {
      if (callToolName(obj) || Array.isArray(obj.tool_calls)) return normalizeCall(obj);   // a tool call in ANY shape
      if (!firstObj) firstObj = obj;       // remember the first valid object as a fallback
    }
  }
  return firstObj;
}

// truncate big tool results so feeding them back doesn't blow the context (both harnesses
// get the same cap; the baseline simply produces bigger results because of full-file rewrites).
function clip(obj, max = 6000) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
}

// Replace heavy/binary fields (multimodal data-URLs, long base64) in a tool result with a short marker so the
// debug log stays readable — those exact bytes are already captured in the provider's raw request log (Block 90).
function stripHeavy(result) {
  if (!result || typeof result !== "object") return result;
  try {
    const clone = { ...result };
    if (clone.multimodal) clone.multimodal = `[multimodal ${clone.multimodal.kind || "attachment"} omitted]`;
    for (const k of ["dataUrl", "image", "png", "screenshot", "content"]) {
      if (typeof clone[k] === "string" && clone[k].length > 4000) clone[k] = clone[k].slice(0, 4000) + `…[${clone[k].length - 4000} chars omitted]`;
    }
    return clone;
  } catch { return result; }
}

// onStep({step,tool,args,result})            — called AFTER a tool runs (back-compat).
// beforeTool({step,tool,args})               — optional async hook called BEFORE a tool runs.
//   Return { deny:true, reason } to skip execution (the loop feeds the denial back to the model
//   so it can adapt). Used for the approval/safety layer. Returning falsy/undefined allows it.
// messages can be SEEDED (multi-turn REPL): pass `seedMessages` to continue an existing thread;
//   when present, only the new user turn (task) is appended and the system prompt is reused.
// verify (optional): an async gate run when the model calls `done`. It returns { ok, feedback }.
//   ok:true  → the work passed; the turn finishes.
//   ok:false → the work failed; `feedback` (e.g. test output) is fed back and the model must REPAIR
//   and call done again, up to `maxRepairs` times (the progress guard). This is what turns proov from
//   a blind one-shot agent into a self-verifying one — it never finishes "green" on a failing check.
// The agent may write a short reasoning note before its JSON tool call. Pull that prose out (everything
// before the tool object) so the UI can show the WHY. "" when the message is JSON-only.
// Default done-gate verifier (Block 54, Phase 1): when the caller passed no explicit `verify`, gate `done`
// on the project's OWN checks (typecheck/lint/build/test) — generalizing "prove it works" to all code, with
// verifier-as-reward repair. Only used when the project HAS detectable checks (see _hasProjectChecks), so
// non-project tasks are unchanged. Safe no-op if the tool is missing or nothing fails.
export function makeProjectVerify(tools) {
  return async () => {
    if (!tools || typeof tools._verifyProjectChecks !== "function") return { ok: true };
    let res; try { res = await tools._verifyProjectChecks(); } catch { return { ok: true }; }
    if (!res || !res.ran || !res.failures || !res.failures.length) return { ok: true };
    const detail = res.failures.slice(0, 3).map((f) => `✗ ${f.check} (\`${f.cmd}\`):\n${f.output}`).join("\n\n");
    return { ok: false, feedback: `the project's OWN checks FAILED — fix the CODE until they pass (do NOT delete, weaken, or skip the checks themselves):\n${detail}` };
  };
}

export function reasoningProse(text) {
  const s = String(text || "");
  const i = s.indexOf("{");
  if (i <= 0) return "";
  return s.slice(0, i).replace(/```\w*/g, "").replace(/\s+/g, " ").trim();
}

export async function runLoop({ provider, tools, toolMap, systemPrompt, task, maxSteps = Infinity, onStep, onToolStart, onThinking, beforeTool, seedMessages, signal, verify, maxRepairs = 3, bridge, editModel, compress, verifyModel, designFirst = true, emit = () => {} }) {
  // DUAL-MODEL ROUTING (optional): a CREATOR model (provider.model) builds/creates; an EDITOR model
  // (editModel) handles editing/bug-fixing. We pick per turn from the most recent mutation: while the
  // agent is creating files it stays on the creator; once it edits existing code it uses the editor.
  let editPhase = false;   // false → creator model; true → editor model
  let consecEdits = 0; let batchNudged = false;   // Block 87: nudge to BATCH after several single edit_file calls
  const EDIT_TOOLS = new Set(["edit_file", "edit_files", "edit_symbol"]);
  // Visual-verification tools (Block 59): used to detect the screenshot-thrash anti-pattern. see_page counts
  // only with visual:true (text-mode see_page is a cheap, legit syntax/blank check). 4 visual checks with no
  // task completed between them ⇒ the agent is steering by eye instead of building → one nudge to go work.
  const VISUAL_TOOLS = new Set(["art_review", "compare_image", "compare_regions", "see_asset", "style_check"]);
  const VISUAL_THRASH_CAP = 4;
  const messages = seedMessages && seedMessages.length
    ? seedMessages
    : [{ role: "system", content: systemPrompt }];
  messages.push({ role: "user", content: `TASK:\n${task}\n\nBegin. Respond with ONE JSON tool call.` });
  let turns = 0, editFailures = 0, done = false, summary = "", error = null, stopped = null;
  let verified = null, repairs = 0;   // verify-and-repair accounting
  // When no explicit verify was passed, default to the PROJECT-CHECKS gate — but only if the project has
  // detectable checks, so non-project tasks (and games, which have their own gate) are unchanged.
  const effectiveVerify = verify || ((tools && typeof tools._hasProjectChecks === "function" && tools._hasProjectChecks()) ? makeProjectVerify(tools) : null);
  const trace = [];

  // Bail out of a stuck loop: if the model keeps emitting non-JSON / unknown-tool calls it makes no
  // progress and just burns paid turns. Count consecutive wasted steps and stop after a few.
  let noProgress = 0;
  const NO_PROGRESS_CAP = 4;

  // PROGRESS SENTINEL (Block 2): a non-LLM guard against the *valid-but-spinning* failure mode — the
  // model keeps making the SAME tool call with the same args and no new result. We escalate: a one-time
  // recovery hint, then a clean stop. (NO_PROGRESS_CAP above only covers non-JSON / unknown-tool calls.)
  let lastFp = null, repeatCount = 0, finalNudged = false;
  const SPIN_HINT = 3, SPIN_STOP = 5;
  // FAILURE-FINGERPRINT sentinel (Block 25): catches a stuck loop where the SAME tool keeps FAILING with
  // the SAME error across a recent window — even with DIFFERENT args or successes interleaved (which the
  // consecutive-identical spin check above misses, e.g. blueprint_mark on 5.2 then 6.1 both STUB_EVIDENCE).
  const failWindow = []; const FAIL_WIN = 14, FAIL_HINT = 3, FAIL_STOP = 7; const failHinted = new Set();
  let denials = 0; const DENIAL_STOP = 6;   // bail out of a denial storm (every edit refused → no progress)
  let doneTaskNudged = false;   // push back ONCE when done is called with incomplete checklist tasks
  let gameGateDone = false;     // push back ONCE when done is called on a game that doesn't actually play
  let taskFidelityDone = false; // Block 58: push back ONCE when done is called but a prompt-named requirement is unreferenced
  let planNudges = 0;           // Block 73/85: BLOCK edits until a plan exists for a substantial task (bounded)
  const verdictCount = new Map(); const diagnosed = new Set(); let scratchNudged = false;   // Block 84: diagnose-on-repeat + anti-regenerate
  let blastWarned = 0;          // Block 85: cap the in-place-edit blast-radius warnings so they can't loop
  let visualMatchTries = 0;     // Block 64: block done until the render matches a reference image per-asset ≥95% (capped)
  let taskCheckTries = 0;       // Block 68: block done while any task's executable acceptance check fails (capped)
  let replanNudged = false;   // Block 5: nudge to re-plan once per failure streak (when a plan exists)
  // SCREENSHOT-THRASH guard (Block 59): a weak model falls into edit→see_page→edit→see_page — micro-edits
  // each followed by a visual check, burning turns while the real tasks never get built. Count visual checks
  // since the last task COMPLETION; past a cap with work still open, nudge ONCE to go build, then watch.
  let visualSinceProgress = 0, visualThrashNudged = false, lastCompletedCount = 0;

  let aborted = false;
  // CONTROL CHECKPOINT (Block 22): drain any control commands from the driving agent in the inter-turn
  // window and apply them — inject guidance / redirect / answer push a message for the NEXT turn; abort
  // stops cleanly; pause blocks (still polling) until resume or abort. Never runs mid tool-call.
  const applyBridgeControl = async () => {
    if (!bridge) return;
    let paused = false;
    const handle = (raw) => {
      const a = applyControl(raw);
      if (a.kind === "abort") { aborted = true; bridge.emit("control", { applied: "abort" }); bridge.ack(a.id, "applied"); return; }
      if (a.kind === "pause") { paused = true; bridge.emit("control", { applied: "pause" }); bridge.ack(a.id, "applied"); return; }
      if (a.kind === "resume") { paused = false; bridge.emit("control", { applied: "resume" }); bridge.ack(a.id, "applied"); return; }
      const msg = controlToMessage(a);
      if (msg) { messages.push({ role: "user", content: msg }); bridge.emit("control", { applied: a.kind }); bridge.ack(a.id, "applied"); noProgress = 0; }
      else { bridge.emit("control", { applied: "noop", reason: a.reason }); bridge.ack(a.id, "noop"); }
    };
    for (const raw of bridge.poll()) { handle(raw); if (aborted) return; }
    while (paused && !aborted) {
      if (signal?.aborted) { aborted = true; return; }
      await new Promise((r) => setTimeout(r, 250));
      for (const raw of bridge.poll()) { handle(raw); if (aborted) return; }
    }
  };
  // DESIGN-FIRST PREFLIGHT (Block 67): the design-first rule was prompt-only, so a weak model just skipped
  // generate_image and the visual-match/beyond-frame gates stayed dormant (no reference → nothing to enforce).
  // Make it deterministic: for a FRESH visual build with no reference yet, proov DRAWS the reference itself
  // BEFORE the agent codes — so the gates have a target to enforce. No-op for non-visual tasks, follow-ups to
  // existing code, or when image gen isn't available. Runs once (guarded by _referenceImage()).
  if (designFirst) {
    try {
      const made = await designFirstPreflight({ tools, task, provider });
      if (made) { trace.push({ step: 0, designFirst: made }); if (onStep) onStep({ step: 0, tool: "generate_image", args: { out: made }, result: { ok: true, note: `drew a reference (${made}) before coding — building to match it` } }); }
    } catch { /* preflight must never break the run */ }
  }
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) { aborted = true; trace.push({ step, aborted: true }); break; }
    if (bridge) { await applyBridgeControl(); if (aborted) { trace.push({ step, aborted: true }); break; } }
    // Final-step nudge: on the last allowed step, tell the model to stop exploring and finish, so a
    // turn ends with a usable result instead of silently hitting the step cap.
    if (Number.isFinite(maxSteps) && step === maxSteps - 1 && maxSteps > 1 && !finalNudged) {
      messages.push({ role: "user", content: "This is your FINAL step. Stop exploring and call done now with your best result." });
      finalNudged = true;
    }
    turns++;
    let resp;
    {
      const turnModel = (editModel && editPhase) ? editModel : undefined;   // undefined → provider's creator model
      const outReserve = (provider && provider.maxTokens) || 8000;          // leave room for the model's reply
      let fitRetries = 0;
      for (;;) {
        try {
          // ROLLING COMPRESSION (Block 34): shrink the thread before sending — elide OLD reconstructable tool
          // results + already-viewed images to stubs (the model re-calls the tool if it needs them). Lossless,
          // any-prompt, stable (so prompt-cache hits survive). compress === false opts out.
          if (compress !== false) compressContext(messages, typeof compress === "object" ? compress : undefined);
          // PROACTIVE FIT (Block 88): once we've LEARNED the model's context window (from a prior 400), trim the
          // thread to it BEFORE sending so we never hit the hard overflow again. Margin: output reservation + 2k.
          if (provider && provider.contextLimit > 0) fitContext(messages, provider.contextLimit - outReserve - 2000);
          if (onThinking) { try { onThinking(true, turnModel); } catch { /* */ } }
          try { resp = await provider.chat(messages, { signal, model: turnModel }); }
          finally { if (onThinking) { try { onThinking(false); } catch { /* */ } } }
          break;   // got a response
        } catch (e) {
          if (e.name === "AbortError" || signal?.aborted) { aborted = true; trace.push({ step, aborted: true }); break; }
          // CONTEXT OVERFLOW (Block 88): the request exceeded the model's window. The API told us the real limit —
          // TRIM the thread to fit and RETRY this same turn (not a hard failure). Remember the limit (on the
          // provider) so every later turn fits proactively. Bounded retries so a pathological case still surfaces.
          const limit = e.contextLimit || parseContextLimit(e.message);
          if (limit && fitRetries < 3) {
            fitRetries++;
            if (provider) provider.contextLimit = provider.contextLimit ? Math.min(provider.contextLimit, limit) : limit;
            const r = fitContext(messages, limit - outReserve - 2000);
            trace.push({ step, contextFit: { limit, tokens: r.tokens, dropped: r.dropped, retry: fitRetries } });
            emit({ type: "context_fit", limit, tokens: r.tokens, retry: fitRetries });
            if (provider && typeof provider.notify === "function") provider.notify(`context over ${limit} — trimmed to ~${r.tokens} tokens, retrying`);
            continue;   // retry the chat with the trimmed thread
          }
          // Surface the failure to the caller instead of swallowing it. A bare "NO_OPENROUTER_KEY"
          // or "API 401/4xx" otherwise renders as a silent "1 turn · 0 tok" footer with no explanation.
          error = e.message === "NO_OPENROUTER_KEY"
            ? "no API key — set OPENROUTER_API_KEY (or apiKey in ~/.proov.json)"
            : `provider error: ${e.message}`;
          trace.push({ step, error: "PROVIDER_ERROR", detail: e.message });
          break;
        }
      }
    }
    if (aborted) { break; }
    if (error) { break; }
    const call = extractJSON(resp.text);
    messages.push({ role: "assistant", content: resp.text });
    debugLog("assistant", { step, turn: turns, text: resp.text, tool: call?.tool || null, args: call?.args });

    if (!call || !call.tool) {
      messages.push({ role: "user", content: 'Your message was not a valid JSON tool call. Respond with exactly one JSON object: {"tool":"...","args":{...}}.' });
      trace.push({ step, badCall: clip(resp.text, 300) });
      if (++noProgress >= NO_PROGRESS_CAP) { stopped = `the model did not produce a valid tool call after ${noProgress} attempts`; break; }
      continue;
    }

    if (call.tool === "done") {
      // DONE-GATE (task completeness): if the agent's OWN checklist still has incomplete tasks, push back
      // ONCE — finish them or update the checklist — rather than declaring done on unfinished work.
      const openTasks = (tools && Array.isArray(tools.tasks)) ? tools.tasks.filter((t) => t.status !== "completed") : [];
      if (openTasks.length && !doneTaskNudged) {
        doneTaskNudged = true; noProgress = 0;
        messages.push({ role: "user", content: `You called done, but ${openTasks.length} task${openTasks.length === 1 ? " is" : "s are"} still NOT completed on your checklist:\n${openTasks.slice(0, 8).map((t) => "  ☐ " + t.subject).join("\n")}\nDo NOT declare done with unfinished tasks. FINISH each one for real and VERIFY it (a game: see_page/play_levels/autoplay), then mark it completed with task_write — only THEN call done. If a listed task is genuinely already done, mark it completed first.` });
        trace.push({ step, doneTaskNudge: openTasks.length });
        emit({ type: "gate", gate: "tasks", ok: false, detail: ` open task(s)` });
        continue;
      }
      // PER-TASK ACCEPTANCE GATE (Block 68, from DTP — "never stack work on an unmet criterion"): a task can
      // carry an executable `check` (its ground-truth acceptance criterion). Don't accept done while any task's
      // check FAILS — re-run them and push back with the failing ones. Ground-truth (runs the command), bounded
      // (≤3) so a flaky/slow check can't deadlock. Dormant when no task carries a check.
      if (taskCheckTries < 3 && tools && typeof tools._verifyTaskChecks === "function") {
        let tc = null;
        try { tc = tools._verifyTaskChecks(); } catch { tc = null; }
        if (tc && tc.failures && tc.failures.length) {
          taskCheckTries++; noProgress = 0;
          const punch = tc.failures.slice(0, 6).map((f) => `  ✗ ${f.subject}: ${f.reason}`).join("\n");
          messages.push({ role: "user", content: `You called done, but ${tc.failures.length} task acceptance check${tc.failures.length === 1 ? "" : "s"} FAIL:\n${punch}\nA task's \`check\` is its ground-truth acceptance criterion — fix the code so each check passes (exit 0), then call done.` });
          trace.push({ step, taskCheckGate: tc.failures.length });
          emit({ type: "gate", gate: "task-check", ok: false, detail: ` failing check(s)` });
          continue;
        }
      }
      // TASK-FIDELITY GATE (Block 58): the other gates prove the artifact WORKS; this proves it did what was
      // ASKED. If the prompt explicitly NAMED something to use (a github repo, a quoted library) and that name
      // appears NOWHERE in the produced code, the central requirement was almost certainly skipped. One-shot,
      // advisory (never a hard block): nudge once, then let the agent stop on the next done. Pure mechanical
      // grep — no model call, near-zero false-rejection risk for the "named thing entirely absent" case.
      if (!taskFidelityDone && tools && typeof tools._verifyTaskFidelity === "function" && tools.workdir) {
        taskFidelityDone = true;   // checked once — clean or not, don't re-run every done
        let tf = null;
        try { tf = tools._verifyTaskFidelity(task); } catch { tf = null; }
        if (tf && tf.misses && tf.misses.length) {
          noProgress = 0;
          const punch = tf.misses.slice(0, 6).map((m) => `  ✗ "${m.entity}" — searched for ${m.stems.slice(0, 3).map((s) => "`" + s + "`").join(", ")}; found in NO code file`).join("\n");
          messages.push({ role: "user", content: `You called done, but the prompt explicitly asked you to USE something your code never references:\n${punch}\n(checked ${tf.files} code file${tf.files === 1 ? "" : "s"}, excluding docs + .proov metadata.)\nThis usually means you built a generic solution and skipped the actual requirement. Go ACTUALLY use it — import or vendor it, call its API, wire it into the program — then verify and call done. If you addressed it under a different name, make that reference explicit in the code (an import or a comment naming it) so it's verifiable.` });
          trace.push({ step, taskFidelity: { misses: tf.misses.map((m) => m.entity), files: tf.files } });
          emit({ type: "gate", gate: "fidelity", ok: false, detail: tf.misses.map((m) => m.entity).join(", ") });
          continue;
        }
      }
      // VISUAL-MATCH GATE (Block 64): when the build is meant to reproduce a REFERENCE image (a mockup/design),
      // don't accept done until the render MATCHES it PER-ASSET at the bar (≥95%) — a whole-scene score averages
      // out a single wrong asset, so per-asset is required. Only fires when a reference image is present (a
      // from-scratch build has none → never blocks). Bounded (≤3 push-backs) so a model that can't reach the bar
      // can't deadlock. Two cases: a per-asset compare ran but FAILED → name the assets; no per-asset compare
      // was run yet → require compare_regions.
      if (visualMatchTries < 3 && tools && typeof tools._referenceImage === "function" && tools.workdir) {
        const refImg = tools._referenceImage();
        if (refImg) {
          const lm = tools.lastVisualMatch;
          let problem = null;
          if (lm && lm.ran && lm.perAsset && !lm.allPass) {
            problem = `the render does NOT match the reference (${refImg}) yet — assets below 95%: ${(lm.assetsOff || []).slice(0, 8).join(", ") || lm.worst || "see the scorecard"}. Fix those exact assets/positions, re-run compare_regions, and only finish when EVERY asset ≥95% AND the whole scene ≥95% (allPass).`;
          } else if (!lm || !lm.perAsset || lm.target !== refImg) {
            problem = `there's a reference image (${refImg}) this build must match, but you haven't verified the render against it PER-ASSET. Run compare_regions {target:"${refImg}", render:"<your page>", regions:[…one box per asset…]} and fix until EVERY asset ≥95% AND the whole scene ≥95% (allPass), THEN call done. A whole-scene compare_image score averages out a wrong asset — verify per-asset.`;
          } else {
            // BEYOND THE FRAME (Block 66): the per-asset match passed — but the reference is a ~1% SAMPLE of
            // ONE scene. Don't accept a single-screen reproduction; require the full game beyond the frame.
            try {
              const gf = detectGameFile(tools.workdir);
              let entry = ""; try { entry = gf ? fs.readFileSync(path.join(tools.workdir, gf), "utf8") : ""; } catch { /* */ }
              const bf = beyondFrameViolation(bundleGameSource(entry, tools.workdir, fs, path), task);
              if (bf) { problem = bf; trace.push({ step, beyondFrame: 1 }); emit({ type: "gate", gate: "beyond", ok: false }); }
            } catch { /* couldn't read → don't block */ }
          }
          if (problem) {
            visualMatchTries++; noProgress = 0;
            messages.push({ role: "user", content: `You called done, but the visual match to the reference isn't met: ${problem}` });
            trace.push({ step, visualMatchGate: clip(problem, 80) });
            emit({ type: "gate", gate: "visual", ok: false, detail: clip(problem, 100) });
            continue;
          }
        }
      }
      // PLAYABILITY GATE (games): if a web game was built, don't accept done until it actually PLAYS — the
      // page must not be broken AND it must respond to REAL input (autoplay). The agent can't pass by just
      // claiming "playable". Push back ONCE; if Chrome can't run the checks, don't block. Games only.
      if (!gameGateDone && tools && typeof tools.autoplay === "function" && tools.workdir) {
        const gameFile = detectGameFile(tools.workdir);
        // PREFER THE SERVED REALITY (Block 62): if the project is a startable server, judge the game as the
        // user actually RUNS it — over HTTP — even when a static index.html exists. A file:// check of the file
        // misses server-only behavior (ES modules, fetch, server-served assets) and silently passes. Fall back
        // to the static file gate only when there's no server (or the server yielded no game).
        let servedHandled = false;
        const hasServer = typeof tools._serverStartCommand === "function" && !!tools._serverStartCommand();
        if (hasServer && typeof tools._verifyServedGame === "function") {
          // The vision judge runs INSIDE _verifyServedGame while the server is alive; gated on a real key so
          // offline/selftest runs skip it (identical to the static branch's visionChecklistGame call).
          const visionCheck = (verifyModel && provider && typeof provider.hasKey === "function" && provider.hasKey())
            ? async (dataUrl) => {
                const crit = await visionChecklistGame(provider, verifyModel, task, dataUrl, signal);
                if (crit && crit.total >= 3 && crit.missing.length) {
                  trace.push({ step, visionChecklist: { present: crit.present, total: crit.total, missing: crit.missing.slice(0, 8), served: true } });
                  return `the vision QA checklist (${String(verifyModel).split("/").pop()}) found ${crit.present}/${crit.total} required things present — these are NOT visible in your served render yet:\n${crit.missing.slice(0, 8).map((m) => "  ✗ " + m).join("\n")}\nAdd each so EVERY checklist item is present, then verify again.`;
                }
                // VISION DESIGN REVIEW (Block 86): flat-placeholder assets in the served render (same model, vote).
                const dr = await visionDesignReview(provider, verifyModel, task, dataUrl, signal);
                if (dr && dr.placeholders.length) {
                  trace.push({ step, designReview: { placeholders: dr.placeholders.slice(0, 8), total: dr.total, served: true } });
                  return `the vision art-director (${String(verifyModel).split("/").pop()}) found ${dr.placeholders.length}/${dr.total} asset${dr.placeholders.length === 1 ? "" : "s"} that look like PLAIN FLAT PLACEHOLDER boxes, not designed/painted art:\n${dr.placeholders.slice(0, 8).map((m) => "  ✗ " + m).join("\n")}\nRedraw EACH as a real designed asset — recognizable form, shading/gradients, drawn detail — not a solid-colour rectangle, then verify again.`;
                }
                return null;
              }
            : null;
          let sv = null;
          try { sv = await tools._verifyServedGame({ task, visionCheck }); } catch { sv = null; }
          if (sv && sv.ran) {
            gameGateDone = true; servedHandled = true;
            if (sv.problem) {
              noProgress = 0;
              messages.push({ role: "user", content: `You called done, but the SERVED app isn't finished to the bar: ${sv.problem}\nFix it for real, then restart and RE-VERIFY over the URL (start_server, see_page {url}, http_request), THEN call done.` });
              trace.push({ step, servedGate: clip(sv.problem, 80) });
              emit({ type: "gate", gate: "served", ok: false, detail: clip(sv.problem, 100) });
              continue;
            }
          }
        }
        if (!servedHandled && gameFile) {
          gameGateDone = true;
          let problem = null;
          try {
            const sp = tools.see_page ? await tools.see_page({ path: gameFile }) : null;
            if (sp && sp.broken) problem = `${gameFile} is BROKEN: ${(sp.errors || []).slice(0, 3).join("; ")}`;
            else {
              const ap = tools.autoplay({ path: gameFile, keys: ["ArrowRight", "ArrowUp", "Space"], holdMs: 400 });
              if (ap && ap.ok && ap.responds === false) problem = `${gameFile} is FROZEN — it does NOT respond to real keyboard/click input (only ${ap.maxChange}% screen change). The game isn't actually playable.`;
              // not frozen → unless the user EXPLICITLY asked for a minimal/simple game, check the CANVAS
              // ART isn't flat coloured "boxes" (advanced/complete is the default). Rate the canvas, not
              // the page; a low threshold catches only egregious programmer-art (boxes), not modest art.
              else if (!wantsMinimal(task)) {
                const rich = typeof tools._gameArtRichness === "function" ? tools._gameArtRichness(gameFile) : null;
                if (rich != null && rich < 18) problem = `the ART is flat PROGRAMMER ART (canvas richness ${rich}/100) — coloured boxes/blocks, not a real themed game. Build recognizable characters/enemies + textured art with the artkit (the user expects the ADVANCED game by default).`;
                else {
                  // STRUCTURE GATE (Block 38): the deterministic production-scene-graph contract. A game that
                  // renders + responds + isn't flat boxes can STILL be a ~2% skeleton (one character, one cube,
                  // a sphere "coin", black sky, no enemies/HUD/levels/textures). Score the built code against
                  // the genre's required layers; an egregious skeleton (whole layers empty) is pushed back with
                  // the concrete missing list. Deterministic + offline (no key) — the cheap first channel.
                  try {
                    // Bundle index.html + the project's client .js so a split-file game (logic in engine.js/
                    // game.js) is mapped against the standard, not just its HTML shell (Block 61).
                    const html = bundleGameSource(fs.readFileSync(path.join(tools.workdir, gameFile), "utf8"), tools.workdir, fs, path);
                    const st = analyzeStructure(html, task);
                    if (!st.pass) {
                      const punch = st.missing.slice(0, 9).map((m) => "  ✗ " + m.label + (m.anti ? " (placeholder / wrong primitive)" : "")).join("\n");
                      problem = `the STRUCTURE is only ~${st.requiredScore}% of a production game — ${st.zeroCategories.length} whole layer${st.zeroCategories.length === 1 ? "" : "s"} are missing (${st.zeroCategories.join(", ") || "—"}). Build these, real (use the artkit), not placeholders:\n${punch}`;
                      trace.push({ step, structure: { requiredScore: st.requiredScore, zero: st.zeroCategories, missing: st.missing.map((m) => m.id) } });
                    }
                  } catch { /* couldn't read the file → don't block */ }
                  // 3D ASSET SOURCE (Block 43): a 3D game's assets MUST come from the vgsds MCP (verified,
                  // textured GLB) — hand-rolled THREE primitives are not allowed. One-shot push-back.
                  if (!problem) {
                    try {
                      const html = bundleGameSource(fs.readFileSync(path.join(tools.workdir, gameFile), "utf8"), tools.workdir, fs, path);
                      const av = assetSourceViolation(html, task);
                      if (av) { problem = av; trace.push({ step, assetGate: clip(av, 80) }); }
                      // ANIMATION (Block 48): a 3D character must animate its parts, not just translate
                      // ("static Mario"). Deterministic static-driver check; one-shot push-back.
                      else { const anv = animationDriverViolation(html, task); if (anv) { problem = anv; trace.push({ step, animGate: clip(anv, 80) }); } }
                    } catch { /* */ }
                  }
                  // LOCK-AND-KEY SOLVABILITY (Block 39): if the game OPTS IN by exposing window.proovLevels,
                  // prove every level is solvable AND soft-lock-free (ESG-CoReach) — no key spent into an
                  // unwinnable state, the soft-lock that "a path exists / I played it once" can't see. Opt-in
                  // via the contract → never blocks games without keys/doors. A browser-read failure → no block.
                  if (!problem && typeof tools._certifyGameLevels === "function") {
                    const lc = tools._certifyGameLevels(gameFile);
                    if (lc && lc.failures.length) {
                      const punch = lc.failures.slice(0, 6).map((f) => `  ✗ level ${f.index}: ${f.reason}`).join("\n");
                      problem = `${lc.failures.length} of ${lc.checked} level${lc.checked === 1 ? "" : "s"} can permanently STRAND the player (not soundly completable):\n${punch}\nFix the key/door economy so every reachable state can still reach the goal, then re-verify with certify_level.`;
                      trace.push({ step, levelCert: { checked: lc.checked, failures: lc.failures } });
                    }
                  }
                  // DETERMINISTIC VISUAL LINT (Block 80): render-level look bugs the LLM judge misses — a HUD or
                  // sprite the code DEFINES but draws OFF-CANVAS, at ZERO size, or in the SAME colour as the
                  // background (invisible). The canvas is instrumented while the game RUNS. No model needed, so
                  // it verifies visuals even when the vision judge can't run (fail-closed coverage).
                  if (!problem && typeof tools._visualLint === "function") {
                    const vl = tools._visualLint(gameFile);
                    if (vl && vl.issues && vl.issues.length) {
                      problem = `the render has VISUAL bugs the player would SEE:\n${vl.issues.slice(0, 5).map((i) => "  ✗ " + i).join("\n")}\nFix so every element is ON-screen, has a real size, and contrasts with its background.`;
                      trace.push({ step, visualLint: vl.issues.length });
                    }
                  }
                  // SEMANTIC FIDELITY (Block 37): pixel-richness + static structure can't tell "looks like
                  // Mario" from "colourful blobs". If structure passed and a vision judge is configured, have it
                  // derive a yes/no CHECKLIST of what the request requires and answer each by LOOKING at the
                  // canvas — verified ⇔ every item present. Gated on a real key so offline/selftest runs skip it.
                  if (!problem && verifyModel && provider && typeof provider.hasKey === "function" && provider.hasKey() && typeof tools._gameCanvasDataURL === "function") {
                    const dataUrl = tools._gameCanvasDataURL(gameFile);
                    const crit = await visionChecklistGame(provider, verifyModel, task, dataUrl, signal);
                    if (crit && crit.total >= 3 && crit.missing.length) {
                      const punch = crit.missing.slice(0, 8).map((m) => "  ✗ " + m).join("\n");
                      problem = `the vision QA checklist (${String(verifyModel).split("/").pop()}) found ${crit.present}/${crit.total} required things present — these are NOT visible in your render yet:\n${punch}\nAdd each so EVERY checklist item is present, then verify again.`;
                      trace.push({ step, visionChecklist: { present: crit.present, total: crit.total, missing: crit.missing.slice(0, 8) } });
                    }
                    // VISION DESIGN REVIEW (Block 86): the look/design/paint judgment — the same vision model
                    // names assets that read as plain flat PLACEHOLDER boxes (majority-vote). Reuses the capture.
                    if (!problem) {
                      const dr = await visionDesignReview(provider, verifyModel, task, dataUrl, signal);
                      if (dr && dr.placeholders.length) {
                        problem = `the vision art-director (${String(verifyModel).split("/").pop()}) found ${dr.placeholders.length}/${dr.total} asset${dr.placeholders.length === 1 ? "" : "s"} that look like PLAIN FLAT PLACEHOLDER boxes, not designed/painted art:\n${dr.placeholders.slice(0, 8).map((m) => "  ✗ " + m).join("\n")}\nRedraw EACH as a real designed asset — recognizable form, shading/gradients, drawn detail (sprites / paths / textures), not a solid-colour rectangle — then verify again.`;
                        trace.push({ step, designReview: { placeholders: dr.placeholders.slice(0, 8), total: dr.total } });
                      }
                    }
                  }
                }
              }
            }
          } catch { /* checks couldn't run (no Chrome) → don't block */ }
          if (problem) {
            noProgress = 0;
            messages.push({ role: "user", content: `You called done, but the GAME isn't finished to the bar: ${problem}\nFix it for real (recognizable characters not boxes, real input + render loop, and it must actually play), verify again with see_page/autoplay/art_review, THEN call done. The DEFAULT is an advanced, complete game — do not declare a boxes/basic prototype done.` });
            trace.push({ step, gameGate: clip(problem, 80) });
            emit({ type: "gate", gate: "game", ok: false, detail: clip(problem, 100) });
            continue;
          }
        }
      }
      summary = call.args?.summary || "";
      // VERIFY-AND-REPAIR gate: before accepting `done`, run the verification (if any). If it fails,
      // feed the failure back and make the model repair instead of finishing — bounded by maxRepairs.
      if (effectiveVerify) {
        let v;
        try { v = await effectiveVerify({ messages, summary }); }
        catch (e) { v = { ok: false, feedback: `the verification step itself errored: ${e.message}` }; }
        trace.push({ step, tool: "verify", ok: !!v.ok, repair: repairs });
        emit({ type: "verify", ok: !!v.ok, detail: v.ok ? "passed" : clip(v.feedback || "failed", 120) });
        if (onStep) onStep({ step, tool: "verify", args: {}, result: { ok: !!v.ok, note: v.ok ? "passed" : clip(v.feedback || "failed", 200) } });
        if (v.ok) { verified = true; done = true; trace.push({ step, tool: "done", summary }); if (bridge) bridge.emit("done", { summary, verified: true }); break; }
        verified = false;
        if (repairs >= maxRepairs) {
          done = true;   // accept the (unverified) result, but say so loudly — never a silent green.
          stopped = `verification still failing after ${repairs} repair attempt${repairs === 1 ? "" : "s"}`;
          trace.push({ step, tool: "done", summary, unverified: true });
          break;
        }
        repairs++;
        noProgress = 0;   // repairing IS progress
        messages.push({ role: "user", content: `VERIFICATION FAILED (repair attempt ${repairs}/${maxRepairs}). Do NOT call done yet — fix the problem and try again.\n\n${clip(v.feedback || "the verification check failed", 2500)}` });
        continue;
      }
      done = true;
      trace.push({ step, tool: "done", summary });
      emit({ type: "done", summary: clip(summary, 120) });
      if (bridge) bridge.emit("done", { summary });
      break;
    }

    // BATCH EDITS IN ONE EXECUTE (Block 87): an edit_file carrying an "edits":[…] array is a batch — normalize it
    // to an edit_files call so the agent makes MANY edits in a SINGLE tool execution and every consumer (preview,
    // capture, diff, trace, syntax-check) handles it uniformly. Per-edit path defaults to the call's "path".
    if (call.tool === "edit_file" && call.args && Array.isArray(call.args.edits) && call.args.edits.length && toolMap.edit_files) {
      const basePath = call.args.path;
      call.tool = "edit_files";
      call.args = { edits: call.args.edits.map((e) => ({ op: "replace", ...(e || {}), path: (e && e.path) || basePath })) };
    }

    // PARALLEL READS IN ONE EXECUTE (Block 89): `read_many` runs several READ-ONLY inspections CONCURRENTLY in a
    // single turn — collapsing N exploration round-trips into 1. Only side-effect-free tools are allowed, so it
    // needs none of the per-call mutation gates. Results are concatenated for the model to read next turn.
    if (call.tool === "read_many" || call.tool === "read_files") {
      const raw = Array.isArray(call.args?.calls) ? call.args.calls
        : Array.isArray(call.args?.reads) ? call.args.reads
        : Array.isArray(call.args?.paths) ? call.args.paths.map((p) => ({ tool: "read_file", args: { path: p } }))
        : [];
      const valid = raw.map((c) => (c && typeof c === "object" && typeof c.tool === "string") ? c : null)
        .filter((c) => c && READ_ONLY_TOOLS.has(c.tool) && typeof toolMap[c.tool] === "function").slice(0, 16);
      const rejected = raw.length - valid.length;
      if (!valid.length) {
        messages.push({ role: "user", content: `read_many runs several READ-ONLY tools at once: {"calls":[{"tool":"read_file","args":{"path":"a.js"}},{"tool":"grep","args":{"pattern":"foo"}}, …]} (or {"paths":["a.js","b.js"]} for files). Allowed: ${[...READ_ONLY_TOOLS].join(", ")}. For edits use edit_files; run commands one at a time.` });
        trace.push({ step, badReadMany: raw.length });
        if (++noProgress >= NO_PROGRESS_CAP) { stopped = "the model kept calling read_many with no valid read-only calls"; break; }
        continue;
      }
      noProgress = 0;
      const _rt0 = Date.now();
      const results = await Promise.all(valid.map(async (c) => {
        try { return { tool: c.tool, args: c.args || {}, result: await toolMap[c.tool](c.args || {}) }; }
        catch (e) { return { tool: c.tool, args: c.args || {}, result: { ok: false, error: String((e && e.message) || e).slice(0, 200) } }; }
      }));
      const elapsedMs = Date.now() - _rt0;
      const okCount = results.filter((r) => r.result && r.result.ok !== false).length;
      const combined = results.map(({ tool, args, result }) => {
        const lbl = args && (args.path || args.pattern || args.name || args.query) ? ` ${args.path || args.pattern || args.name || args.query}` : "";
        return `--- ${tool}${lbl} ---\n${clip(result, 3500)}`;
      }).join("\n\n");
      messages.push({ role: "user", content: `RESULT (read_many): ${valid.length} read${valid.length === 1 ? "" : "s"} run in parallel (${okCount} ok${rejected > 0 ? `, ${rejected} non-read-only skipped` : ""}):\n\n${combined}` });
      if (onStep) onStep({ step, tool: "read_many", args: call.args, result: { ok: true, count: valid.length, okCount, results }, elapsedMs, reasoning });
      trace.push({ step, tool: "read_many", ok: true, count: valid.length });
      emit({ type: "tool_result", tool: "read_many", ok: true, step: undefined, note: `${valid.length} parallel reads`, turn: turns, ms: elapsedMs });
      consecEdits = 0;
      continue;
    }

    const fn = toolMap[call.tool];
    if (!fn) {
      messages.push({ role: "user", content: `Unknown tool "${call.tool}". Available: ${Object.keys(toolMap).join(", ")}, read_many, done.` });
      trace.push({ step, unknownTool: call.tool });
      if (++noProgress >= NO_PROGRESS_CAP) { stopped = `the model kept calling unknown tools (last: ${call.tool})`; break; }
      continue;
    }
    noProgress = 0; // a real, known tool call — making progress again

    // PLAN-FIRST gate (Block 73/85): a SUBSTANTIAL, multi-part task should be DECOMPOSED before building. BLOCK
    // the first mutating action while the checklist is EMPTY — not just once: the agent overran the one-shot
    // nudge in the Mario run and only wrote a plan at the very end. Bounded to 3 blocks so a model that refuses
    // to plan isn't deadlocked. Trivial/short tasks never trigger; one task_write call clears the gate forever.
    if (planNudges < 3 && MUTATING_TOOLS.has(call.tool) && tools && Array.isArray(tools.tasks) && tools.tasks.length === 0 && isSubstantialTask(task)) {
      planNudges++;
      messages.push({ role: "user", content: `${planNudges > 1 ? `Still NO plan (attempt ${planNudges}/3) — ` : ""}Before building this multi-part task, DECOMPOSE it: call task_write with a concrete checklist (one step per deliverable), give each mechanically-testable step a 'check' (a shell command that exits 0 when it's truly done). I will NOT apply edits until a plan exists. Plan first, then build to it and mark steps completed as you verify them.` });
      trace.push({ step, planNudge: planNudges });
      emit({ type: "gate", gate: "plan", ok: false });
      continue;
    }

    if (bridge) bridge.emit("turn", { n: turns, tool: call.tool, args: call.args || {} });

    // approval/safety gate: let the host veto a tool BEFORE it runs.
    if (beforeTool) {
      let gate;
      try { gate = await beforeTool({ step, tool: call.tool, args: call.args || {} }); }
      catch (e) { gate = { deny: true, reason: e.message }; }
      if (gate && gate.deny) {
        const result = { ok: false, denied: true, reason: gate.reason || "denied by user/policy" };
        trace.push({ step, tool: call.tool, denied: true });
        if (onStep) onStep({ step, tool: call.tool, args: call.args, result, denied: true });
        // A DENIAL STORM (every edit refused — e.g. approval can't be granted) strands the agent: it can
        // make NO progress, so stop cleanly instead of burning turns. (Denials bypass the post-tool
        // sentinels, so count them here.)
        denials++;
        if (denials >= DENIAL_STOP) { stopped = `stopped: ${denials} tool calls were DENIED — the agent can't make progress (approval can't be granted here). Re-run with --auto, or interactively to approve.`; trace.push({ step, denialStop: denials }); break; }
        messages.push({ role: "user", content: `RESULT (${call.tool}): DENIED — ${result.reason}. Do not retry this exact action; choose a different approach or call done.` });
        continue;
      }
    }

    // Tell the UI what we're about to do (+ the WHY) so it can show a live "running" line before a
    // possibly slow tool, and time how long it takes.
    const reasoning = reasoningProse(resp.text);
    if (onToolStart) { try { onToolStart({ step, tool: call.tool, args: call.args || {}, reasoning }); } catch { /* UI must never break the run */ } }
    emit({ type: "tool_start", tool: call.tool, turn: turns, reason: clip(reasoning || "", 120) });
    let result; const _t0 = Date.now();
    try { result = await fn(call.args || {}); }
    catch (e) { result = { ok: false, error: e.message }; }
    const elapsedMs = Date.now() - _t0;
    // DEBUG (Block 90): record the tool call + its result. Heavy multimodal bytes (screenshots) are already in
    // the provider's raw request log, so swap them for a marker here to keep the line readable.
    debugLog("tool", { step, turn: turns, tool: call.tool, args: call.args, ok: result?.ok, ms: elapsedMs, result: stripHeavy(result) });

    if ((call.tool === "edit_file" || call.tool === "write_file") && result && result.ok === false) {
      editFailures++;
    }
    // dual-model phase: editing existing code → editor model next turn; creating a file → creator model.
    if (editModel) { if (EDIT_TOOLS.has(call.tool)) editPhase = true; else if (call.tool === "create_file") editPhase = false; }
    trace.push({ step, tool: call.tool, ok: result?.ok, tier: result?.tier });
    if (onStep) onStep({ step, tool: call.tool, args: call.args, result, elapsedMs, reasoning });
    if (bridge) bridge.emit("result", { tool: call.tool, ok: result?.ok !== false, note: clip(result?.note || result?.error || "", 300), ms: elapsedMs });
    emit({ type: "tool_result", tool: call.tool, ok: result?.ok !== false, step: undefined, note: clip(result?.note || result?.error || "", 140), turn: turns, ms: elapsedMs });
    // Stream the live task TREE whenever it changes (Block 82) — the monitor's bottom box shows it + the
    // current in-progress task.
    if (call.tool === "task_write" && tools && Array.isArray(tools.tasks)) {
      emit({ type: "tasks", tasks: tools.tasks.map((t) => ({ subject: t.subject, status: t.status })) });
    }

    // DIAGNOSE-ON-REPEAT (Block 84): the SAME verification failure ≥3× means the agent is thrashing on one
    // problem it doesn't understand (the headline eval failure: rewriting maps 20× to beat a CLONE verdict it
    // never investigated). Inject a targeted diagnosis of WHAT THE CHECK COMPARES + the real fix — once per key.
    {
      const vk = verdictFingerprint(call.tool, result);
      if (vk) {
        const n = (verdictCount.get(vk) || 0) + 1; verdictCount.set(vk, n);
        if (n >= 3 && !diagnosed.has(vk)) {
          diagnosed.add(vk); noProgress = 0;
          messages.push({ role: "user", content: `You've hit the SAME failure ("${vk}") ${n} times now — STOP making the same kind of change and re-running. DIAGNOSE the check first:\n${diagnoseFor(vk)}\nDo NOT rewrite the whole file again; make the one correct change.` });
          trace.push({ step, diagnoseRepeat: vk });
          continue;
        }
      }
    }
    // EDIT, DON'T REGENERATE (Block 84): scratch "rewrite the whole file" generators (write_*.js, index_v3.html)
    // burn tokens and ship syntax errors. Nudge ONCE to edit the real file in place.
    if (!scratchNudged && (call.tool === "create_file" || call.tool === "write_file") && call.args && isScratchFile(call.args.path) && result && result.ok !== false) {
      scratchNudged = true; noProgress = 0;
      messages.push({ role: "user", content: `Don't create throwaway "${call.args.path}" generators / versioned copies — re-emitting the whole file each time burns tokens and is how the syntax errors creep in. EDIT the real deliverable in place with edit_file (small anchored changes — they're auto syntax-checked). Work on the ONE real file, not scratch copies.` });
      trace.push({ step, scratchNudge: call.args.path });
      continue;
    }
    // AUTO SYNTAX-CHECK (Block 84): catch a syntax error the agent just introduced IMMEDIATELY (it shipped
    // missing-semicolon / typo'd-loop bugs and discovered them rounds later). One-shot-ish per fix. Checks EVERY
    // file a batch edit touched (Block 87) — a multi-edit execute can break more than one file.
    if (MUTATING_TOOLS.has(call.tool) && result && result.ok !== false && tools && tools.workdir) {
      const touched = Array.isArray(result.files) ? result.files : ((call.args && call.args.path) ? [call.args.path] : []);
      const syntaxErrs = [];
      for (const fpath of touched) {
        if (!fpath || !/\.(m?js|cjs|html?)$/i.test(fpath)) continue;
        try {
          const abs = path.join(tools.workdir, fpath);
          const errs = fs.existsSync(abs) ? quickSyntaxErrors(abs) : [];
          if (errs.length) syntaxErrs.push(`${fpath}: ${errs.join("; ")}`);
        } catch { /* */ }
      }
      if (syntaxErrs.length) {
        noProgress = 0;
        messages.push({ role: "user", content: `⚠ Your edit${syntaxErrs.length > 1 ? "s" : ""} introduced a SYNTAX ERROR — fix THAT line now, do not rewrite the file:\n${syntaxErrs.join("\n")}` });
        trace.push({ step, syntaxError: touched.find((f) => syntaxErrs.some((e) => e.startsWith(f + ":"))) || touched[0] });
        continue;
      }
    }

    // BLAST-RADIUS guard (Block 85, post-mortem #4): a `sed -i` / `perl -pi` that matches more than intended
    // silently DUPLICATES or GUTS a file — exactly how the Mario run got "24 levels · 24 clones" from one sed.
    // run_command measured the target before/after; if it ballooned/gutted, STOP and make the agent verify the
    // diff before building on a corrupted file. Capped so an agent that ignores it can't loop forever.
    if (call.tool === "run_command" && result && Array.isArray(result.blastRadius) && result.blastRadius.length && blastWarned < 3) {
      blastWarned++; noProgress = 0;
      const lines = result.blastRadius.map((b) => `  ${b.file}: ${b.before} → ${b.after} lines (${b.kind})`).join("\n");
      messages.push({ role: "user", content: `⚠ That command MASSIVELY changed a file's size:\n${lines}\nAn in-place stream edit (sed/perl -i) that matches more than intended silently DUPLICATES or GUTS content — this is how a "N levels · N clones" corruption happens. STOP: read the file (or git diff) and confirm the change is what you meant. If it's wrong, restore it before doing anything else — don't build on a corrupted file.` });
      trace.push({ step, blastRadius: result.blastRadius.map((b) => b.file) });
      continue;
    }

    // BATCH NUDGE (Block 87): several single edit_file calls in a row = a turn wasted per edit. Nudge ONCE to
    // batch future edits into ONE execute. (A batched edit was normalized to edit_files above, so it resets this.)
    if (call.tool === "edit_file" && result && result.ok !== false) consecEdits++;
    else consecEdits = 0;   // any other tool (a batch, a read, a verify) breaks the single-edit streak
    if (!batchNudged && consecEdits >= 3) {
      batchNudged = true;
      messages.push({ role: "user", content: `You've made ${consecEdits} separate edit_file calls in a row — that's a whole turn per edit. When you have several changes, make them in ONE execute: edit_files {"edits":[{path,anchor,replacement},…]} (or edit_file {"path":…,"edits":[…]}). They apply atomically in a single turn. Group your remaining related edits into one call.` });
      trace.push({ step, batchNudge: consecEdits });
    }

    // SCREENSHOT-THRASH guard (Block 59): completing a task = real progress → reset the counter. A visual
    // check (a screenshot / art_review / compare) with NO task completed since the last one accumulates; past
    // the cap with work still OPEN, nudge ONCE to stop eyeballing and build the next task to completion.
    {
      const completedNow = (tools && Array.isArray(tools.tasks)) ? tools.tasks.filter((t) => t.status === "completed").length : 0;
      if (completedNow > lastCompletedCount) { lastCompletedCount = completedNow; visualSinceProgress = 0; visualThrashNudged = false; }
      const isVisualCheck = (call.tool === "see_page" && call.args && call.args.visual) || VISUAL_TOOLS.has(call.tool);
      const openTasks = (tools && Array.isArray(tools.tasks)) ? tools.tasks.filter((t) => t.status !== "completed") : [];
      if (isVisualCheck && result && result.ok !== false) {
        if (++visualSinceProgress >= VISUAL_THRASH_CAP && openTasks.length && !visualThrashNudged) {
          visualThrashNudged = true;
          const seen = visualSinceProgress; visualSinceProgress = 0;
          const next = openTasks[0];
          messages.push({ role: "user", content: `You've run ${seen} visual checks in a row without completing a task — that's steering by eye, not building. STOP screenshotting after small edits. Build the next unfinished task to COMPLETION now${next ? `: "${next.subject}"` : ""} — write the REAL code (several substantial edits), mark it completed with task_write, and only THEN verify. Work, then watch.` });
          trace.push({ step, visualThrash: seen });
          continue;
        }
      }
    }

    // MULTIMODAL: when a tool loaded an image/pdf, push a user message whose content is an ARRAY of
    // blocks so the model actually SEES the bytes (provider passes array content through unchanged).
    if (result && result.ok && result.multimodal) {
      const blocks = buildMultimodalContent(result.multimodal);
      if (blocks) {
        // strip the heavy dataUrl out of the trace-facing result so the loop stays cheap.
        messages.push({ role: "user", content: `RESULT (${call.tool}): ${result.note || "attachment loaded"} — attaching below.` });
        messages.push({ role: "user", content: blocks });
        continue;
      }
    }

    messages.push({ role: "user", content: `RESULT (${call.tool}):\n${clip(result)}` });

    // DYNAMIC RE-PLAN (Block 5): a step FAILED and a plan exists ⇒ nudge the agent to revise its plan
    // (once per failure streak) rather than blindly executing a plan that no longer fits. Reset on a
    // successful step so each new failure streak gets exactly one nudge.
    if (result && result.ok === false && tools && tools.plan) {
      if (!replanNudged) {
        messages.push({ role: "user", content: `That step FAILED${result.error ? `: ${clip(result.error, 200)}` : ""}. If your plan no longer fits, call replan with the revised remaining steps and a brief reason; otherwise fix the issue and continue.` });
        replanNudged = true;
        trace.push({ step, replanNudge: true });
      }
    } else if (result && result.ok) {
      replanNudged = false;
    }

    // PROGRESS SENTINEL: same tool + same args repeated with no new result ⇒ the agent is spinning.
    // Escalate: a one-time recovery hint, then a clean stop (never burn the whole budget spinning).
    const fp = `${call.tool}|${clip(JSON.stringify(call.args || {}), 200)}`;
    if (fp === lastFp) repeatCount++; else { lastFp = fp; repeatCount = 1; }
    if (repeatCount >= SPIN_STOP) {
      stopped = `stopped: repeated the same ${call.tool} call ${repeatCount}× with no progress`;
      trace.push({ step, spinStop: call.tool, count: repeatCount });
      break;
    } else if (repeatCount === SPIN_HINT) {
      messages.push({ role: "user", content: `You have called ${call.tool} with identical arguments ${repeatCount}× in a row with no new result — you appear to be stuck. Try a DIFFERENT approach, or call done.` });
      trace.push({ step, spinHint: call.tool, count: repeatCount });
    }

    // FAILURE-FINGERPRINT sentinel: the same tool repeatedly FAILING with the same error code (normalized,
    // ignoring args) ⇒ retrying won't help; the root cause is unfixed. Strong actionable hint, then a stop.
    if (result && result.ok === false) {
      const ferr = `${call.tool}|${(result.error || "FAIL")}`;
      failWindow.push(ferr); if (failWindow.length > FAIL_WIN) failWindow.shift();
      const n = failWindow.filter((x) => x === ferr).length;
      if (n >= FAIL_STOP) {
        stopped = `stopped: ${call.tool} kept failing with ${result.error || "an error"} (${n}× in the last ${failWindow.length} steps) — the underlying problem was never fixed`;
        trace.push({ step, failStop: ferr, count: n });
        break;
      } else if (n === FAIL_HINT && !failHinted.has(ferr)) {
        failHinted.add(ferr);
        const detail = result.hint ? `\n${clip(result.hint, 500)}` : "";
        messages.push({ role: "user", content: `STUCK PATTERN: ${call.tool} has failed with "${result.error || "the same error"}" ${n} times recently. Retrying it will NOT help — FIX THE ROOT CAUSE first.${detail}\nDo that exact fix, THEN continue. If you genuinely can't, mark the item "blocked" and move on — do not keep retrying.` });
        trace.push({ step, failHint: ferr, count: n });
      }
    } else if (result && result.ok) {
      // a success clears that fingerprint's hint latch so a LATER recurrence can warn again.
      const okfp = `${call.tool}|`;
      for (const k of [...failHinted]) if (k.startsWith(okfp)) failHinted.delete(k);
    }
  }

  // If we fell out of the loop without finishing, aborting, or erroring, we hit a FINITE step cap (only
  // possible when the user opted into one with --max-steps; the default is unlimited).
  if (!done && !aborted && !error && !stopped) {
    stopped = Number.isFinite(maxSteps)
      ? `reached the ${maxSteps}-step cap you set — raise --max-steps, remove it for no cap, or narrow the task`
      : "stopped before finishing";
  }

  // SOFT verification this run (Block 75): which in-loop gates actually verified the build — so a game that
  // passed its gates isn't mis-reported as "unverified" by the supervisor (which re-runs only HARD checks).
  // These are heuristic/visual gates (weaker than an executable check), so they're surfaced as 'soft', not 'pass'.
  const verifiedBy = [];
  if (done) {
    if (gameGateDone) verifiedBy.push("game-gate");
    try { const lm = tools && tools.lastVisualMatch; if (lm && lm.perAsset && lm.allPass) verifiedBy.push("visual-match"); } catch { /* */ }
  }
  return { done, summary, turns, editFailures, trace, aborted, error, stopped, verified, verifiedBy, repairs, messages, totals: provider.totals() };
}
