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
import { analyzeStructure, wantsMinimal, assetSourceViolation, animationDriverViolation } from "./structure.mjs";

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
function detectGameFile(workdir) {
  for (const name of ["index.html", "game.html"]) {
    try {
      if (isGameHtml(fs.readFileSync(path.join(workdir, name), "utf8"))) return name;
    } catch { /* not there */ }
  }
  return null;
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
      if (obj.tool) return obj;            // a real tool call — prefer it over any earlier stray object
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
export function reasoningProse(text) {
  const s = String(text || "");
  const i = s.indexOf("{");
  if (i <= 0) return "";
  return s.slice(0, i).replace(/```\w*/g, "").replace(/\s+/g, " ").trim();
}

export async function runLoop({ provider, tools, toolMap, systemPrompt, task, maxSteps = Infinity, onStep, onToolStart, onThinking, beforeTool, seedMessages, signal, verify, maxRepairs = 3, bridge, editModel, compress, verifyModel }) {
  // DUAL-MODEL ROUTING (optional): a CREATOR model (provider.model) builds/creates; an EDITOR model
  // (editModel) handles editing/bug-fixing. We pick per turn from the most recent mutation: while the
  // agent is creating files it stays on the creator; once it edits existing code it uses the editor.
  let editPhase = false;   // false → creator model; true → editor model
  const EDIT_TOOLS = new Set(["edit_file", "edit_files", "edit_symbol"]);
  const messages = seedMessages && seedMessages.length
    ? seedMessages
    : [{ role: "system", content: systemPrompt }];
  messages.push({ role: "user", content: `TASK:\n${task}\n\nBegin. Respond with ONE JSON tool call.` });
  let turns = 0, editFailures = 0, done = false, summary = "", error = null, stopped = null;
  let verified = null, repairs = 0;   // verify-and-repair accounting
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
  let replanNudged = false;   // Block 5: nudge to re-plan once per failure streak (when a plan exists)

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
      // PLAYABILITY GATE (games): if a web game was built, don't accept done until it actually PLAYS — the
      // page must not be broken AND it must respond to REAL input (autoplay). The agent can't pass by just
      // claiming "playable". Push back ONCE; if Chrome can't run the checks, don't block. Games only.
      if (!gameGateDone && tools && typeof tools.autoplay === "function" && tools.workdir) {
        const gameFile = detectGameFile(tools.workdir);
        if (gameFile) {
          gameGateDone = true;
          let problem = null;
          try {
            const sp = tools.see_page ? tools.see_page({ path: gameFile }) : null;
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
                    const html = fs.readFileSync(path.join(tools.workdir, gameFile), "utf8");
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
                      const html = fs.readFileSync(path.join(tools.workdir, gameFile), "utf8");
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
        } else if (typeof tools._verifyServedGame === "function") {
          // SERVED GAME (Block 41): no static index.html, but the project may SERVE a game over HTTP (a
          // Node app). Start it, fetch the entry HTML, and verify it over the URL (broken check + the
          // production-structure contract). Opt-in by being a startable server → never blocks non-server
          // projects; the harness-only checks (autoplay/level-cert/WebGL capture) stay file-only for now.
          let sv = null;
          try { sv = await tools._verifyServedGame({ task }); } catch { sv = null; }
          if (sv && sv.ran) {
            gameGateDone = true;
            if (sv.problem) {
              noProgress = 0;
              messages.push({ role: "user", content: `You called done, but the SERVED app isn't finished to the bar: ${sv.problem}\nFix it for real, then restart and RE-VERIFY over the URL (start_server, see_page {url}, http_request), THEN call done.` });
              trace.push({ step, servedGate: clip(sv.problem, 80) });
              continue;
            }
          }
        }
      }
      summary = call.args?.summary || "";
      // VERIFY-AND-REPAIR gate: before accepting `done`, run the verification (if any). If it fails,
      // feed the failure back and make the model repair instead of finishing — bounded by maxRepairs.
      if (verify) {
        let v;
        try { v = await verify({ messages, summary }); }
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
