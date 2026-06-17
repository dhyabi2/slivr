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
import { buildMultimodalContent } from "./multimodal.mjs";
import { applyControl, controlToMessage } from "./bridge.mjs";
import { compressContext } from "./compress.mjs";
import { isWebGLPage } from "./webcheck.mjs";
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
// A SUBSTANTIAL task warrants an up-front plan: long, or multi-clause / lists several deliverables. A short
// single-action task ("fix the typo on line 4") never trips the plan-first gate.
export function isSubstantialTask(task) {
  const s = String(task || "").trim();
  if (s.length < 30) return false;                 // truly trivial one-liners never trip it
  const clauses = (s.match(/\b(and|then|also|plus|with|including|as well as)\b|[,;]|\b\d[.)]/gi) || []).length;
  return clauses >= 2 || s.length > 180;
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
async function visionChecklistGame(provider, model, task, dataUrl, signal) {
  if (!provider || typeof provider.chat !== "function" || !model || !dataUrl) return null;
  const prompt = `You are a STRICT visual QA inspector. The user asked for this:\n"${String(task || "").slice(0, 400)}"\n\nThink about what a REAL, complete, polished version MUST visibly contain — the concrete, checkable things (e.g. for a platformer: a recognizable themed CHARACTER that is clearly NOT a plain coloured box; enemies; collectibles/coins; a score/HUD; textured ground or platforms; a themed background; etc. — tailor the list to THIS request). Write 5-9 such items.\nNow LOOK at this screenshot of the actual rendered output and answer, for EACH item, whether it is genuinely visible. Be strict: a plain rectangle is NOT a character; flat colour is NOT texture.\nReply with ONLY this JSON, no prose:\n{"checklist":[{"item":"<short concrete requirement>","present":true|false}, ...]}`;
  try {
    const r = await provider.chat(
      [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }],
      { model, temperature: 0, signal },
    );
    const m = String(r?.text || "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const raw = Array.isArray(o.checklist) ? o.checklist : (Array.isArray(o.items) ? o.items : null);
    if (!raw || !raw.length) return null;
    const items = raw
      .filter((x) => x && typeof (x.item ?? x.requirement ?? x.q) === "string")
      .map((x) => ({ item: String(x.item ?? x.requirement ?? x.q).slice(0, 80), present: x.present === true || /^(yes|true)$/i.test(String(x.present)) }));
    if (!items.length) return null;
    const missing = items.filter((i) => !i.present).map((i) => i.item);
    return { items, missing, total: items.length, present: items.length - missing.length };
  } catch { return null; }
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
    let res; try { res = tools._verifyProjectChecks(); } catch { return { ok: true }; }
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

export async function runLoop({ provider, tools, toolMap, systemPrompt, task, maxSteps = Infinity, onStep, onToolStart, onThinking, beforeTool, seedMessages, signal, verify, maxRepairs = 3, bridge, editModel, compress, verifyModel, designFirst = true }) {
  // DUAL-MODEL ROUTING (optional): a CREATOR model (provider.model) builds/creates; an EDITOR model
  // (editModel) handles editing/bug-fixing. We pick per turn from the most recent mutation: while the
  // agent is creating files it stays on the creator; once it edits existing code it uses the editor.
  let editPhase = false;   // false → creator model; true → editor model
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
  let planNudged = false;       // Block 73: push back ONCE to decompose a substantial task before the first edit
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
    try {
      // ROLLING COMPRESSION (Block 34): shrink the thread before sending — elide OLD reconstructable tool
      // results + already-viewed images to stubs (the model re-calls the tool if it needs them). Lossless,
      // any-prompt, stable (so prompt-cache hits survive). compress === false opts out.
      if (compress !== false) compressContext(messages, typeof compress === "object" ? compress : undefined);
      const turnModel = (editModel && editPhase) ? editModel : undefined;   // undefined → provider's creator model
      if (onThinking) { try { onThinking(true, turnModel); } catch { /* */ } }
      try { resp = await provider.chat(messages, { signal, model: turnModel }); }
      finally { if (onThinking) { try { onThinking(false); } catch { /* */ } } }
    } catch (e) {
      if (e.name === "AbortError" || signal?.aborted) { aborted = true; trace.push({ step, aborted: true }); break; }
      // Surface the failure to the caller instead of swallowing it. A bare "NO_OPENROUTER_KEY"
      // or "API 401/4xx" otherwise renders as a silent "1 turn · 0 tok" footer with no explanation.
      error = e.message === "NO_OPENROUTER_KEY"
        ? "no API key — set OPENROUTER_API_KEY (or apiKey in ~/.proov.json)"
        : `provider error: ${e.message}`;
      trace.push({ step, error: "PROVIDER_ERROR", detail: e.message });
      break;
    }
    const call = extractJSON(resp.text);
    messages.push({ role: "assistant", content: resp.text });

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
              if (bf) { problem = bf; trace.push({ step, beyondFrame: 1 }); }
            } catch { /* couldn't read → don't block */ }
          }
          if (problem) {
            visualMatchTries++; noProgress = 0;
            messages.push({ role: "user", content: `You called done, but the visual match to the reference isn't met: ${problem}` });
            trace.push({ step, visualMatchGate: clip(problem, 80) });
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
                if (crit && crit.total >= 4 && crit.missing.length) {
                  trace.push({ step, visionChecklist: { present: crit.present, total: crit.total, missing: crit.missing.slice(0, 8), served: true } });
                  return `the vision QA checklist (${String(verifyModel).split("/").pop()}) found ${crit.present}/${crit.total} required things present — these are NOT visible in your served render yet:\n${crit.missing.slice(0, 8).map((m) => "  ✗ " + m).join("\n")}\nAdd each so EVERY checklist item is present, then verify again.`;
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
                  // SEMANTIC FIDELITY (Block 37): pixel-richness + static structure can't tell "looks like
                  // Mario" from "colourful blobs". If structure passed and a vision judge is configured, have it
                  // derive a yes/no CHECKLIST of what the request requires and answer each by LOOKING at the
                  // canvas — verified ⇔ every item present. Gated on a real key so offline/selftest runs skip it.
                  if (!problem && verifyModel && provider && typeof provider.hasKey === "function" && provider.hasKey() && typeof tools._gameCanvasDataURL === "function") {
                    const dataUrl = tools._gameCanvasDataURL(gameFile);
                    const crit = await visionChecklistGame(provider, verifyModel, task, dataUrl, signal);
                    if (crit && crit.total >= 4 && crit.missing.length) {
                      const punch = crit.missing.slice(0, 8).map((m) => "  ✗ " + m).join("\n");
                      problem = `the vision QA checklist (${String(verifyModel).split("/").pop()}) found ${crit.present}/${crit.total} required things present — these are NOT visible in your render yet:\n${punch}\nAdd each so EVERY checklist item is present, then verify again.`;
                      trace.push({ step, visionChecklist: { present: crit.present, total: crit.total, missing: crit.missing.slice(0, 8) } });
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
      if (bridge) bridge.emit("done", { summary });
      break;
    }

    const fn = toolMap[call.tool];
    if (!fn) {
      messages.push({ role: "user", content: `Unknown tool "${call.tool}". Available: ${Object.keys(toolMap).join(", ")}, done.` });
      trace.push({ step, unknownTool: call.tool });
      if (++noProgress >= NO_PROGRESS_CAP) { stopped = `the model kept calling unknown tools (last: ${call.tool})`; break; }
      continue;
    }
    noProgress = 0; // a real, known tool call — making progress again

    // PLAN-FIRST gate (Block 73): a SUBSTANTIAL, multi-part task should be DECOMPOSED before building. If the
    // first mutating action happens with an EMPTY checklist, push back ONCE to lay out a task_write plan —
    // planning first beats building blind (audit #1). One-shot; trivial/short tasks never trigger.
    if (!planNudged && MUTATING_TOOLS.has(call.tool) && tools && Array.isArray(tools.tasks) && tools.tasks.length === 0 && isSubstantialTask(task)) {
      planNudged = true;
      messages.push({ role: "user", content: `Before you start building: this is a multi-part task — DECOMPOSE it first. Call task_write with a concrete checklist (one step per deliverable), give each mechanically-testable step a 'check' (a shell command that exits 0 when it's truly done), then build to the plan and mark steps completed as you verify them. Planning first prevents stacking work on the wrong foundation.` });
      trace.push({ step, planNudge: 1 });
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
    let result; const _t0 = Date.now();
    try { result = await fn(call.args || {}); }
    catch (e) { result = { ok: false, error: e.message }; }
    const elapsedMs = Date.now() - _t0;

    if ((call.tool === "edit_file" || call.tool === "write_file") && result && result.ok === false) {
      editFailures++;
    }
    // dual-model phase: editing existing code → editor model next turn; creating a file → creator model.
    if (editModel) { if (EDIT_TOOLS.has(call.tool)) editPhase = true; else if (call.tool === "create_file") editPhase = false; }
    trace.push({ step, tool: call.tool, ok: result?.ok, tier: result?.tier });
    if (onStep) onStep({ step, tool: call.tool, args: call.args, result, elapsedMs, reasoning });
    if (bridge) bridge.emit("result", { tool: call.tool, ok: result?.ok !== false, note: clip(result?.note || result?.error || "", 300), ms: elapsedMs });

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

  return { done, summary, turns, editFailures, trace, aborted, error, stopped, verified, repairs, messages, totals: provider.totals() };
}
