// agent.mjs — slivr harness (THE alternative). Compact-edit protocol via SEAL.
//
// Tools: read_file, list_dir, grep, run_command, edit_file (anchor/replacement/op).
// The agent edits with SMALL anchors and gets a COMPACT repair packet on failure — it never
// re-reads or re-sends a whole file to make a change. This is the harness-level cost advantage.

import fs from "node:fs";
import path from "node:path";
import { Provider } from "./provider.mjs";
import { Tools } from "./tools.mjs";
import { runLoop } from "./loop.mjs";
import { connectAll, closeAll, mcpPromptSection } from "./mcp.mjs";
import { detectStyle, styleBrief } from "./style.mjs";

// A one-line HOUSE STYLE suffix appended to the system prompt so the agent matches the repo's
// conventions (indent/quotes/semicolons/naming) from the start. Cheap (samples files once); "" when
// nothing confident is detected (e.g. an empty/new dir).
function styleSuffix(workdir) {
  try { const b = styleBrief(detectStyle(workdir)); return b ? `\n\nHOUSE STYLE (match the existing repo when you add or edit code): ${b}.` : ""; }
  catch { return ""; }
}

const SYSTEM = `You are slivr, a precise coding agent that edits a real repository.

You work ONE tool call at a time. You MAY write a SHORT (1–2 sentence) reasoning note first, but every
message MUST contain exactly ONE JSON tool-call object — do not end a turn on reasoning alone (that
wastes the turn). The JSON object looks like:
  {"tool":"read_file","args":{"path":"rel/path.js"}}
  {"tool":"list_dir","args":{"path":"."}}
  {"tool":"grep","args":{"pattern":"regex","path":"."}}
  {"tool":"glob","args":{"pattern":"src/**/*.js"}}
  {"tool":"repo_map","args":{}}
  {"tool":"project_info","args":{}}
  {"tool":"house_style","args":{}}
  {"tool":"find_symbol","args":{"name":"functionOrClassName"}}
  {"tool":"find_refs","args":{"name":"functionOrClassName"}}
  {"tool":"run_command","args":{"command":"node check.js"}}
  {"tool":"web_search","args":{"query":"how to X in library Y"}}
  {"tool":"web_fetch","args":{"url":"https://..."}}
  {"tool":"view_image","args":{"path":"shot.png"}}
  {"tool":"view_pdf","args":{"path":"spec.pdf"}}
  {"tool":"see_page","args":{"path":"index.html"}}
  {"tool":"see_asset","args":{"svg":"<svg ...>...</svg>"}}
  {"tool":"play_game","args":{"path":"index.html","inputs":[{"at":0,"key":"ArrowRight","down":true}],"steps":120}}
  {"tool":"delegate","args":{"task":"a focused, self-contained sub-task to run in a fresh sub-agent"}}
  {"tool":"parallel","args":{"tasks":["independent subtask A","independent subtask B"]}}
  {"tool":"pipeline","args":{"tasks":[{"id":"a","task":"do A","deps":[]},{"id":"b","task":"do B using A","deps":["a"]}]}}
  {"tool":"blueprint_plan","args":{"goal":"a clear 2D platformer with 3 levels","tree":[{"title":"Player","children":[{"title":"idle sprite","leafType":"sprite"},{"title":"jump sound","leafType":"sound"}]},{"title":"Level 1","children":[{"title":"tilemap","leafType":"data"}]}]}}
  {"tool":"blueprint_status","args":{}}
  {"tool":"blueprint_mark","args":{"id":"1.2","status":"done","evidence":"src/audio.js","decision":"WebAudio square-wave + decay envelope"}}
  {"tool":"blueprint_add","args":{"parentId":"1","nodes":[{"title":"hurt sound","leafType":"sound"}]}}
  {"tool":"blueprint_audit","args":{}}
  {"tool":"plan","args":{"steps":["step 1","step 2","step 3"]}}
  {"tool":"replan","args":{"reason":"step 2 failed because X","steps":["revised remaining step","next step"]}}
  {"tool":"task_write","args":{"tasks":[{"id":"1","subject":"do X","status":"in_progress"},{"subject":"then Y","status":"pending"}]}}
  {"tool":"edit_file","args":{"path":"f.js","anchor":"<verbatim existing lines>","replacement":"<new lines>","op":"replace"}}
  {"tool":"create_file","args":{"path":"new.js","content":"<full content of a brand-NEW file>"}}
  {"tool":"edit_files","args":{"edits":[{"path":"a.js","anchor":"...","replacement":"...","op":"replace"},{"path":"b.js","anchor":"...","replacement":"..."}]}}
  {"tool":"edit_symbol","args":{"name":"functionOrClassName","replacement":"<the FULL new definition>"}}
  {"tool":"git_status","args":{}}
  {"tool":"git_diff","args":{"path":"optional/file"}}
  {"tool":"git_log","args":{"n":10}}
  {"tool":"git_commit","args":{"message":"clear commit message"}}
  {"tool":"done","args":{"summary":"what you did"}}

EDIT PROTOCOL (important — this is how you keep edits cheap and correct):
- "anchor" must be a SMALL, UNIQUE, VERBATIM snippet copied character-for-character from the
  file (enough lines to be unique, but no more). "replacement" is the new text for that snippet.
- op is "replace" (default), "insert_after", or "insert_before".
- Do NOT rewrite whole files. Make targeted edits with edit_file.
- To replace an ENTIRE function/class/method, prefer edit_symbol — pass its name + the FULL new
  definition; you do NOT copy the old body as an anchor (cheaper for large functions). For a small
  change INSIDE a function, use edit_file with a small anchor.
- For SEVERAL edits at once (across one or more files), prefer edit_files — it applies them
  ATOMICALLY (all-or-nothing) in fewer turns; same anchor rules. If any edit fails, none apply
  and you get repair packets for the failing ones.
- git_* tools inspect the repo and can commit; slivr NEVER pushes.
- MATCH THE HOUSE STYLE: new/edited code must be indistinguishable from the surrounding code —
  indentation (tabs vs spaces + width), quote style, semicolons, and naming case. A HOUSE STYLE line
  may appear at the end of these instructions; for detail call house_style, or mirror a nearby file.

MULTIMODAL: use view_image to LOOK at a screenshot/diagram/photo (png/jpg/gif/webp), and view_pdf
  to READ a PDF. After you call one, the file is attached to the conversation and you can describe
  or reason about its contents on your next turn. Use these instead of trying to read binary files
  with read_file (which only handles text).
- To create a NEW file that does not exist yet, use create_file (there is no anchor to match yet).
  Use edit_file (NOT create_file) for any file that already exists.
- If an edit fails you get a compact repair packet with the nearest real spans. Fix your anchor
  from that packet and retry — do NOT re-read the whole file unless the packet says wrong-file.

ORCHESTRATION (parallel):
- "parallel" runs each subtask as its OWN sub-agent CONCURRENTLY (up to 4 at once), one level
  deep. Use it to fan out INDEPENDENT work: research/explore several things at once, or edit
  DISJOINT files. CAVEAT: sub-agents SHARE this working directory — NEVER parallelize subtasks
  that edit the SAME file or depend on each other's output (you'll get races / lost writes).
  When work is sequential or touches overlapping files, do it yourself one tool at a time.
  Pattern: decompose the task → fan out independent pieces with parallel → integrate the results.
- Each sub-result has both a "summary" (the sub-agent's own words) and "findings" (the actual
  content it gathered — file text, search hits, command output). READ the findings to integrate
  real data; don't assume the one-line summary is the whole story.
- "pipeline" is the DEPENDENCY-AWARE version: pass subtasks as {id, task, deps:[ids]}. Tasks run in
  dependency order (independent ones concurrently), and each task receives its dependencies' results
  as context. Use it when some subtasks NEED another's output first (e.g. "design the schema" → then
  "write the model" and "write the migration" which both depend on it). A failed dependency skips its
  dependents instead of running them on broken inputs.

PLANNING (plan): when plan-mode is on you MUST call "plan" with a numbered list of concrete steps
  BEFORE any edit/create/run_command — those are blocked until a plan exists and is approved.
  Even when plan-mode is off, calling plan first on a multi-step task helps you stay on track.
  RE-PLANNING (replan): when a step fails or you learn something that breaks your plan, call "replan"
  with the revised REMAINING steps and a brief reason — adapt the plan instead of forcing the old one.

TASK MANAGEMENT (task_write): for any multi-step task, call "task_write" up front to lay out the
  steps as a checklist, then update it as you go. status ∈ pending|in_progress|completed. Keep
  EXACTLY ONE task in_progress at a time; mark a task completed right after you finish it. This
  drives the live checklist the user sees.

CODE NAVIGATION: to find WHERE something is defined, prefer find_symbol (jumps straight to the
  definition's file:line + signature) over grep (which returns every mention). Use find_refs to find
  WHO USES a symbol (call-sites) — run it before changing a function's signature so you update every
  caller. Use repo_map for a compact overview of an unfamiliar repo before reading files.
  To VERIFY a change or RUN an existing project you've never seen, call project_info — it auto-detects
  the test / run / build commands for this repo (any ecosystem). Run those to confirm your work; don't
  guess the command.

UNDERSTAND INTENT (do this FIRST): a request is usually underspecified. Infer what the user ACTUALLY
  wants — the real end-goal and the UNSTATED success criteria — and deliver against THAT, not just the
  literal words. Briefly state your understanding before you work. Common cases:
  - "make / build a <game|app|tool|script>" → they want to USE it. It MUST run end-to-end: actually RUN
    it to confirm it works, fix whatever breaks, and in your done summary give the EXACT command to
    launch/see it and how to use it. Never claim it "works" or is "ready" on a command that FAILED.
  - if they want to SEE / play / visually interact (a game, a UI, a demo) — especially if they mention
    a browser — prefer a self-contained web page (a single index.html with inline JS/CSS) they can just
    OPEN, unless they asked for a specific language. A thing you can open beats a thing you must set up.
  - "fix the bug" / "it's broken" → they want it ACTUALLY fixed: reproduce it, fix it, and VERIFY (run
    the program / the test) before done.
  - "make it faster" / "optimize" → they want a MEASURED win — measure before and after.
  - "add <feature>" → wire it in AND give a way to exercise it; confirm it works.
  Before you call done, SELF-CHECK: does my deliverable satisfy what they REALLY wanted? If you built
  something runnable, did you run it and confirm it actually works? Your done summary MUST tell the user
  how to SEE / RUN / VERIFY the result.

VISUAL CHECK (web pages — use your EYE): after you build or change an HTML page, call see_page {path}
  to READ how it ACTUALLY renders (the post-JS visible text). Look for render bugs — a literal "\n"
  shown on screen instead of a line break, a BLANK page, wrong/missing/garbled text — then FIX them and
  see_page again until it reads correctly. For layout/visual issues (overlap, broken styling) call
  see_page {path, visual:true} to get a screenshot you can look at. Do NOT claim a page works without
  looking at it with see_page.

BUILDING GAMES (make them real, not just code you can't verify): build a web game as a single
  self-contained index.html (canvas + inline JS). To make it PLAYTESTABLE, expose a deterministic
  control surface — this is required so you can actually verify it plays:
    window.slivrSim = {
      reset(seed){ /* re-init; seed your RNG so runs are deterministic */ },
      step(dtMs){ /* advance ONE update+render; your requestAnimationFrame loop should just call this */ },
      input(key,isDown){ /* set a held input, e.g. 'ArrowRight', true */ },
      state(){ return { /* small snapshot: x, y, score, over, ... */ }; }
    };
  Then call play_game {path, inputs:[{at:0,key:"ArrowRight",down:true}], steps:120} to DRIVE the game and
  read its STATE OVER TIME plus a final-frame screenshot. VERIFY it really plays — things MOVE, score
  changes, win/lose (state.over) is reachable — and fix whatever doesn't, then play_game again. A game
  that "looks done" in code but doesn't move when driven is NOT done.
  Make it look and sound INTENTIONAL with zero asset files: draw all art PROCEDURALLY on the canvas
  (shapes, gradients, simple sprites), and synthesize sound with the WebAudio API (oscillators/noise +
  envelopes for SFX). Add game-feel/juice (easing/tweening on motion, a few particles, brief screen
  shake or hit-stop on impact) — small touches that make it feel commercial.

ASSET STUDIO (look at the art you make, then make it better): most agents emit "programmer art" because
  they never SEE what they drew. You can. When you generate visual art — a sprite, an icon, a logo, a
  texture, an organic shape — call see_asset to RENDER that ONE asset in isolation and look at it, then
  critique it against the target and REFINE, repeating until it looks intentional. Two techniques the
  eye can actually capture:
    • svg    — smooth ORGANIC 2D shapes via Bézier paths (crisp, scalable). Best for icons, logos,
               characters, leaves/creatures — anything that wants clean curves rather than hard pixels.
    • canvas — procedural TEXTURE + SHADING on a 2D canvas. A noise(x,y) and fbm(x,y,oct) helper is
               pre-injected, so you can build natural materials (wood, stone, clouds, skin), gradients,
               and lighting/normal-style shading. Your draw code runs as (ctx, W, H) => { ... }.
  Call see_asset {svg:"<svg ...>...</svg>"} or {canvas:"<draw code>", width, height, bg}. It returns the
  rendered image attached to the conversation — LOOK, then judge silhouette, proportion, color harmony,
  contrast, shading, and consistency with the rest of the project's art, and refine. (WebGL/shaders are
  NOT capturable by the headless eye, so stick to svg/canvas for anything you need to see.) Once an asset
  looks right, inline it into the game/page (SVG markup, or the canvas draw code / a generated dataURL).

BUILD BIG, ZERO ABSTRACTION (blueprint-first — for games, apps, or any large multi-part build): do NOT
  one-shot a big build into a thin "basic visualization" that skips the inner parts. Instead, plan the
  WHOLE thing up front, then grind it leaf-by-leaf so 100% of it gets built and nothing is silently
  dropped:
  1. FIGURE OUT THE REAL GOAL: read the user's intent and expand it — a "platformer" implies a player
     (idle/run/jump sprites, jump/land/hurt sounds, a hit state), enemies, levels (tilemap, background,
     hazards), HUD (score, lives, pause), title + game-over screens, win/lose. Infer the full content
     from genre/convention; do NOT stop at the literal words and do NOT pepper the user with questions.
  2. blueprint_plan {goal, tree}: lock the build as a DEEP, NESTED tree of CONCRETE leaves — every sprite,
     sound, UI state, screen, mechanic, sub-component is its own leaf. No abstractions, no "TODO: assets",
     no "etc." A leaf is a real artifact you will actually make. It persists to disk and survives turns.
  3. WORK IT LEAF BY LEAF: call blueprint_status to see the next uncovered leaves, build one for REAL,
     then blueprint_mark {id, status:"done", evidence:"<the real file>"}. The done-gate REJECTS stubs/
     placeholders — you cannot check off a leaf whose evidence is empty or contains TODO/placeholder/
     not-implemented. Record settled choices in the node's decision field so you never re-litigate them. Use "blocked"
     (not "done") when something is genuinely stuck. Keep going until every leaf is done.
  4. blueprint_audit before you finish: it flags structural gaps (empty groups, done-without-evidence,
     stub evidence); then RE-READ the goal yourself and blueprint_add anything implied but missing. Only
     call done when coverage is 100% and the audit is clean. This is how you cover the small inner parts
     other agents drop — persistence and focus over a long build, not a quick basic demo.

DRAFT-FIRST (important for HARD tasks): do NOT spend all your turns planning or reasoning. Commit a
  SIMPLE, COMPLETE, runnable solution EARLY — even a naive/brute-force one — then improve it. Always
  have working code written before you run out of steps; a correct-but-slow solution beats none.

Workflow: (plan if asked) → task_write a checklist → explore (repo_map/find_symbol/read_file/grep) → make
targeted edits (fan out independent work with parallel) → run the check script to verify → keep
the checklist updated → call done. Keep going until the task is verifiably complete.`;

export function makeAgent(workdir, opts = {}) {
  const provider = new Provider(opts);
  // fold web_search's separate OpenRouter spend into this provider's session accounting.
  const tools = new Tools(workdir, { ...opts, onExternalUsage: (u) => provider.recordExternalUsage(u) });
  const toolMap = {
    read_file: (a) => tools.read_file(a),
    list_dir: (a) => tools.list_dir(a),
    grep: (a) => tools.grep(a),
    glob: (a) => tools.glob(a),
    repo_map: (a) => tools.repo_map(a),
    project_info: (a) => tools.project_info(a),
    house_style: (a) => tools.house_style(a),
    find_symbol: (a) => tools.find_symbol(a),
    find_refs: (a) => tools.find_refs(a),
    run_command: (a) => tools.run_command(a),
    edit_file: (a) => tools.edit_file(a),
    create_file: (a) => tools.create_file(a),
    edit_files: (a) => tools.edit_files(a),
    edit_symbol: (a) => tools.edit_symbol(a),
    git_status: (a) => tools.git_status(a),
    git_diff: (a) => tools.git_diff(a),
    git_log: (a) => tools.git_log(a),
    git_commit: (a) => tools.git_commit(a),
    web_fetch: (a) => tools.web_fetch(a),
    web_search: (a) => tools.web_search(a),
    view_image: (a) => tools.view_image(a),
    view_pdf: (a) => tools.view_pdf(a),
    see_page: (a) => tools.see_page(a),
    play_game: (a) => tools.play_game(a),
    see_asset: (a) => tools.see_asset(a),
    blueprint_plan: (a) => tools.blueprint_plan(a),
    blueprint_status: (a) => tools.blueprint_status(a),
    blueprint_mark: (a) => tools.blueprint_mark(a),
    blueprint_add: (a) => tools.blueprint_add(a),
    blueprint_audit: (a) => tools.blueprint_audit(a),
    delegate: (a) => delegateSubAgent(a, workdir, opts),
    parallel: (a) => parallelSubAgents(a, workdir, opts),
    pipeline: (a) => pipelineSubAgents(a, workdir, opts),
    plan: (a) => tools.plan_tool(a),
    replan: (a) => tools.replan_tool(a),
    task_write: (a) => tools.task_write(a),
  };
  return { provider, tools, toolMap };
}

// parallel: fan out several INDEPENDENT subtasks as concurrent sub-agents (one level deep only —
// reuses the same _depth guard as delegate so sub-agents cannot spawn more). Runs at most CAP at a
// time (Promise pool). Sub-agents share the workdir, so this is only safe for independent work.
const PARALLEL_CAP = 4;

// A sub-agent's CALLER cannot see its tool output — only what it returns. So brief every sub-agent
// to put the concrete findings the caller needs INTO its final summary (verbatim), not just a
// "what I did" sentence. This is the real fix for "parallel read N files -> report contents".
const SUBAGENT_BRIEF =
  "\n\n[SUB-AGENT BRIEF] You are a sub-agent. Your caller sees ONLY what you return — never your " +
  "tool output. So your done.summary MUST carry every concrete finding the caller needs (exact file " +
  "contents, values, paths, names, answers) VERBATIM. Do NOT just say what you did (e.g. \"read the " +
  "file\") — quote what matters. If you gathered data, paste it into the summary.";

// Belt-and-suspenders: pull the substantive tool RESULTs out of a finished sub-agent's transcript so
// the caller gets the actual content even if the model wrote a terse summary. We surface only
// READ/INFORMATIONAL tools (not edits/commits), de-noised and length-capped.
const FINDING_TOOLS = new Set([
  "read_file", "list_dir", "grep", "glob", "repo_map", "project_info", "house_style", "find_symbol", "find_refs", "run_command", "web_search",
  "web_fetch", "view_pdf", "view_image", "see_page", "see_asset", "play_game", "blueprint_status", "blueprint_audit", "git_status", "git_diff", "git_log",
]);
export function extractFindings(sub, maxTotal = 2000) {
  const out = [];
  for (const m of sub?.messages || []) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const mt = m.content.match(/^RESULT \(([^)]+)\):\n([\s\S]*)$/);
    if (!mt) continue;
    const [, tool, body] = mt;
    if (!FINDING_TOOLS.has(tool)) continue;
    let snippet = body.trim();
    // unwrap the common {ok,...,content/output/text:"..."} JSON envelope to the human-relevant field
    try {
      const o = JSON.parse(body);
      const v = o.content ?? o.output ?? o.text ?? o.stdout ?? o.results ?? o.matches;
      if (v != null) snippet = typeof v === "string" ? v : JSON.stringify(v);
    } catch { /* not JSON — keep raw */ }
    snippet = snippet.trim();
    if (snippet) out.push(`[${tool}] ${snippet}`);
  }
  if (!out.length) return undefined;
  let joined = out.join("\n");
  if (joined.length > maxTotal) joined = joined.slice(0, maxTotal) + " …(findings truncated)";
  return joined;
}

export async function parallelSubAgents(a, workdir, opts, runner = runAgent) {
  if ((opts._depth || 0) >= 1) return { ok: false, error: "MAX_DELEGATE_DEPTH", hint: "A sub-agent cannot spawn more sub-agents." };
  const coerce = (t) => {
    if (t == null) return "";
    if (typeof t === "string") return t.trim();
    if (typeof t === "object") return String(t.task ?? t.subject ?? t.description ?? t.prompt ?? "").trim();
    return String(t).trim();
  };
  const tasks = Array.isArray(a?.tasks) ? a.tasks.map(coerce).filter(Boolean) : [];
  if (!tasks.length) return { ok: false, error: "NO_TASKS", hint: 'Pass tasks: ["subtask 1","subtask 2"]' };
  const cap = Math.max(1, Math.min(PARALLEL_CAP, opts.parallelCap || PARALLEL_CAP));
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      try {
        const sub = await runner(task + SUBAGENT_BRIEF, workdir, { ...opts, _depth: (opts._depth || 0) + 1, maxSteps: Math.min(10, opts.maxSteps ?? 10), onStep: undefined });
        results[i] = { task, summary: sub.summary, findings: extractFindings(sub), done: sub.done, turns: sub.turns };
      } catch (e) {
        results[i] = { task, summary: "", done: false, turns: 0, error: String(e?.message || e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, tasks.length) }, worker));
  const failed = results.filter(r => r && (r.error || !r.done)).length;
  return { ok: true, cap, count: tasks.length, failed, results };
}

// pipeline (Block 4): DEPENDENCY-AWARE orchestration. Unlike `parallel` (flat, no deps, shared
// workdir → races), each subtask declares { id, task, deps:[ids] }. The orchestrator runs them in
// dependency order — independent tasks concurrently within a "wave" — and feeds each upstream task's
// RESULT to its dependents as context. A failed/skipped dependency cascade-SKIPS its dependents
// (never run them on broken inputs). Cycles are rejected up front. `runner` is injectable for tests.
export async function pipelineSubAgents(a, workdir, opts, runner = runAgent) {
  if ((opts._depth || 0) >= 1) return { ok: false, error: "MAX_DELEGATE_DEPTH", hint: "A sub-agent cannot spawn more sub-agents." };
  const raw = Array.isArray(a?.tasks) ? a.tasks : [];
  const nodes = [];
  raw.forEach((t, i) => {
    const id = String(t?.id ?? `t${i + 1}`);
    const task = String((typeof t === "string" ? t : (t?.task ?? t?.subject ?? t?.description ?? "")) || "").trim();
    const deps = Array.isArray(t?.deps) ? t.deps.map(String) : [];
    if (task) nodes.push({ id, task, deps });
  });
  if (!nodes.length) return { ok: false, error: "NO_TASKS", hint: 'Pass tasks:[{id,task,deps:["otherId"]}]' };
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) for (const d of n.deps) if (!byId.has(d)) return { ok: false, error: "UNKNOWN_DEP", detail: `task "${n.id}" depends on unknown task "${d}"` };

  // Cycle pre-check via Kahn topological sort.
  const dependents = new Map(nodes.map(n => [n.id, []]));
  for (const n of nodes) for (const d of n.deps) dependents.get(d).push(n.id);
  const indeg = new Map(nodes.map(n => [n.id, n.deps.length]));
  const q = nodes.filter(n => !n.deps.length).map(n => n.id);
  let seen = 0;
  while (q.length) { const id = q.shift(); seen++; for (const dep of dependents.get(id)) { indeg.set(dep, indeg.get(dep) - 1); if (indeg.get(dep) === 0) q.push(dep); } }
  if (seen !== nodes.length) return { ok: false, error: "CYCLE", hint: "subtask dependencies form a cycle" };

  const cap = Math.max(1, Math.min(PARALLEL_CAP, opts.parallelCap || PARALLEL_CAP));
  const status = new Map(nodes.map(n => [n.id, "pending"]));   // pending|done|failed|skipped
  const result = new Map();
  const terminal = (s) => s === "done" || s === "failed" || s === "skipped";
  let waves = 0;
  while (nodes.some(n => status.get(n.id) === "pending")) {
    const ready = nodes.filter(n => status.get(n.id) === "pending" && n.deps.every(d => terminal(status.get(d))));
    if (!ready.length) break; // shouldn't happen (no cycles), but never spin
    const toRun = [], toSkip = [];
    for (const n of ready) (n.deps.some(d => status.get(d) === "failed" || status.get(d) === "skipped") ? toSkip : toRun).push(n);
    for (const n of toSkip) { status.set(n.id, "skipped"); result.set(n.id, { id: n.id, task: n.task, status: "skipped", error: "a dependency failed" }); }
    if (!toRun.length) continue;
    waves++;
    let idx = 0;
    const worker = async () => {
      while (true) {
        const k = idx++; if (k >= toRun.length) return;
        const n = toRun[k];
        const ctx = n.deps.map(d => { const r = result.get(d); return r ? `--- result of "${d}" ---\n${(r.summary || "").trim()}\n${(r.findings || "").trim()}`.trim() : ""; }).filter(Boolean).join("\n\n");
        const prompt = (ctx ? `CONTEXT FROM DEPENDENCIES:\n${ctx}\n\n` : "") + n.task + SUBAGENT_BRIEF;
        try {
          const sub = await runner(prompt, workdir, { ...opts, _depth: (opts._depth || 0) + 1, maxSteps: Math.min(10, opts.maxSteps ?? 10), onStep: undefined });
          const okDone = sub.done !== false;
          status.set(n.id, okDone ? "done" : "failed");
          result.set(n.id, { id: n.id, task: n.task, status: okDone ? "done" : "failed", summary: sub.summary, findings: extractFindings(sub), done: sub.done, turns: sub.turns });
        } catch (e) {
          status.set(n.id, "failed");
          result.set(n.id, { id: n.id, task: n.task, status: "failed", error: String(e?.message || e), done: false, turns: 0 });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(cap, toRun.length) }, worker));
  }
  const results = nodes.map(n => result.get(n.id));
  return { ok: true, cap, count: nodes.length, waves, failed: results.filter(r => r.status === "failed").length, skipped: results.filter(r => r.status === "skipped").length, results };
}

// delegate: run a focused SUB-TASK in a fresh agent (one level deep only — no recursion runaway).
async function delegateSubAgent(a, workdir, opts) {
  if ((opts._depth || 0) >= 1) return { ok: false, error: "MAX_DELEGATE_DEPTH", hint: "A sub-agent cannot spawn more sub-agents." };
  const task = String(a?.task || "").trim();
  if (!task) return { ok: false, error: "NO_TASK" };
  const sub = await runAgent(task + SUBAGENT_BRIEF, workdir, { ...opts, _depth: (opts._depth || 0) + 1, maxSteps: Math.min(10, opts.maxSteps ?? 10), onStep: undefined });
  return { ok: true, summary: sub.summary, findings: extractFindings(sub), turns: sub.turns, done: sub.done };
}

// Tools whose effects mutate the repo / run commands — gated by plan-mode until a plan is approved.
export const MUTATING_TOOLS = new Set(["edit_file", "edit_files", "create_file", "write_file", "run_command"]);

// planGate: pure decision for the harness. When plan-mode is on, block mutating tools until a plan
// has been recorded AND approved. Returns { deny, reason } or { deny:false }.
export function planGate({ tool, tools }) {
  if (!tools?.planMode) return { deny: false };
  if (!MUTATING_TOOLS.has(tool)) return { deny: false };
  if (!tools.plan) return { deny: true, reason: "plan-mode is on: call the `plan` tool with numbered steps FIRST (no edits/commands allowed until a plan is approved)." };
  if (!tools.plan.approved) return { deny: true, reason: "your plan is awaiting approval — do not edit/run yet." };
  return { deny: false };
}

export async function runAgent(task, workdir, opts = {}) {
  const { provider, tools, toolMap } = makeAgent(workdir, opts);
  return runLoop({
    provider, tools, toolMap, systemPrompt: SYSTEM + styleSuffix(workdir), task,
    maxSteps: opts.maxSteps ?? 16, onStep: opts.onStep,
    verify: opts.verify, maxRepairs: opts.maxRepairs,
  });
}

// A Session bundles a Provider + Tools + persistent message thread so multi-turn REPL use keeps
// context. The toolMap is wrapped so edits capture a before/after diff (for streaming + approval).
export class Session {
  constructor(workdir, opts = {}) {
    this.workdir = path.resolve(workdir);
    this.opts = opts;
    this.provider = new Provider(opts);
    // fold web_search's separate OpenRouter spend into the session provider's accounting.
    this.tools = new Tools(workdir, { ...opts, onExternalUsage: (u) => this.provider.recordExternalUsage(u) });
    this.messages = null; // seeded on first run; persists across turns
    this.maxSteps = opts.maxSteps ?? 16;
    // diff capture: edit tools record { path, before, after } on the session for the UI to read.
    // lastDiff = single-file edits; lastDiffs = the per-file list for a batch edit_files.
    this.lastDiff = null;
    this.lastDiffs = null;
    // MCP state (populated by connectMCP, optional): connected clients + discovered tool catalog.
    this.mcpClients = [];
    this.mcpCatalog = [];
    this.mcpErrors = [];
    this._styleSuffix = styleSuffix(this.workdir);   // house-style brief, computed once per session
    this.systemPrompt = SYSTEM + this._styleSuffix;  // augmented with an MCP section once servers connect.
    this.toolMap = this._buildToolMap();
  }

  // Connect configured MCP servers (mcpServers in opts), register their tools into the toolMap
  // under namespaced ids (mcp__<server>__<tool>), and append an MCP section to the system prompt.
  // Idempotent-ish: safe to call once at session start. No-op when nothing is configured.
  async connectMCP(mcpServers = this.opts.mcpServers) {
    if (!mcpServers || typeof mcpServers !== "object") return { catalog: [], errors: [] };
    const { clients, catalog, errors } = await connectAll(mcpServers);
    this.mcpClients = clients;
    this.mcpCatalog = catalog;
    this.mcpErrors = errors;
    for (const t of catalog) {
      this.toolMap[t.id] = (a) => t.client.callTool(t.name, a || {});
    }
    if (catalog.length) this.systemPrompt = SYSTEM + this._styleSuffix + mcpPromptSection(catalog);
    return { catalog, errors };
  }

  // Kill MCP child processes. Call on session/process exit.
  closeMCP() { closeAll(this.mcpClients); this.mcpClients = []; }

  _readSafe(rel) {
    try { return this.tools.read_file({ path: rel }); } catch { return { ok: false }; }
  }

  _buildToolMap() {
    const t = this.tools;
    const captureEdit = (kind, fn) => (a) => {
      const rel = a?.path;
      const before = rel && kind !== "create_file" ? (this._readSafe(rel).content ?? "") : "";
      const res = fn(a);
      if (res && res.ok && rel) {
        const after = this._readSafe(rel).content ?? "";
        this.lastDiff = { path: rel, before, after, kind };
      } else {
        this.lastDiff = null;
      }
      this.lastDiffs = null;
      return res;
    };
    // edit_files: capture a before snapshot of every distinct path, then a per-file diff after, so
    // the UI can show what a batch edit changed (and the approval gate can preview it).
    const captureEdits = (a) => {
      const edits = Array.isArray(a?.edits) ? a.edits : [];
      const paths = [...new Set(edits.map(e => e && e.path).filter(Boolean))];
      const before = new Map(paths.map(rel => [rel, this._readSafe(rel).content ?? ""]));
      const res = t.edit_files(a);
      if (res && res.ok) {
        this.lastDiffs = paths.map(rel => ({ path: rel, before: before.get(rel) ?? "", after: this._readSafe(rel).content ?? "" }));
      } else {
        this.lastDiffs = null;
      }
      this.lastDiff = null;
      return res;
    };
    // edit_symbol: capture the before/after of the resolved file for the streaming diff.
    const captureSymbolEdit = (a) => {
      const pv = t.previewSymbolEdit(a);
      const res = t.edit_symbol(a);
      if (res && res.ok && pv.ok) this.lastDiff = { path: pv.path, before: pv.before, after: pv.after, kind: "edit_symbol" };
      else this.lastDiff = null;
      this.lastDiffs = null;
      return res;
    };
    return {
      read_file: (a) => t.read_file(a),
      list_dir: (a) => t.list_dir(a),
      grep: (a) => t.grep(a),
      repo_map: (a) => t.repo_map(a),
      project_info: (a) => t.project_info(a),
      house_style: (a) => t.house_style(a),
      find_symbol: (a) => t.find_symbol(a),
      find_refs: (a) => t.find_refs(a),
      run_command: (a) => t.run_command(a),
      edit_file: captureEdit("edit_file", (a) => t.edit_file(a)),
      create_file: captureEdit("create_file", (a) => t.create_file(a)),
      edit_files: captureEdits,
      edit_symbol: captureSymbolEdit,
      git_status: (a) => t.git_status(a),
      git_diff: (a) => t.git_diff(a),
      git_log: (a) => t.git_log(a),
      git_commit: (a) => t.git_commit(a),
      glob: (a) => t.glob(a),
      web_fetch: (a) => t.web_fetch(a),
      web_search: (a) => t.web_search(a),
      view_image: (a) => t.view_image(a),
      view_pdf: (a) => t.view_pdf(a),
      see_page: (a) => t.see_page(a),
      play_game: (a) => t.play_game(a),
      see_asset: (a) => t.see_asset(a),
      blueprint_plan: (a) => t.blueprint_plan(a),
      blueprint_status: (a) => t.blueprint_status(a),
      blueprint_mark: (a) => t.blueprint_mark(a),
      blueprint_add: (a) => t.blueprint_add(a),
      blueprint_audit: (a) => t.blueprint_audit(a),
      delegate: (a) => delegateSubAgent(a, this.workdir, this.opts),
      parallel: (a) => parallelSubAgents(a, this.workdir, this.opts),
      pipeline: (a) => pipelineSubAgents(a, this.workdir, this.opts),
      plan: (a) => t.plan_tool(a),
      replan: (a) => t.replan_tool(a),
      task_write: (a) => t.task_write(a),
    };
  }

  setModel(model) { this.provider.model = model; this.opts.model = model; }

  // Reset the conversation but keep the same provider session totals unless hard=true.
  reset({ hard = false } = {}) {
    this.messages = null;
    if (hard) {
      this.provider.calls = 0; this.provider.promptTokens = 0;
      this.provider.completionTokens = 0; this.provider.cost = 0; this.provider.log = [];
    }
  }

  totals() { return this.provider.totals(); }

  // Run ONE user turn against the persistent thread. opts: { onStep, beforeStep, signal, verify }.
  async runTurn(task, { onStep, beforeTool, signal, verify, maxRepairs } = {}) {
    const res = await runLoop({
      provider: this.provider,
      tools: this.tools,
      toolMap: this.toolMap,
      systemPrompt: this.systemPrompt,
      task,
      maxSteps: this.maxSteps,
      seedMessages: this.messages || undefined,
      onStep,
      beforeTool,
      signal,
      verify,
      maxRepairs,
    });
    this.messages = res.messages; // persist the thread for the next turn
    return res;
  }
}
