// loop.mjs — the shared tool-use agent loop used by BOTH harnesses.
//
// The model emits exactly one tool call per turn as a JSON object:
//   {"tool": "read_file", "args": {...}}            // act
//   {"tool": "done", "args": {"summary": "..."}}    // finish
// The harness executes it, feeds the result back as a user message, and repeats until `done`
// or the step cap. agent.mjs and baseline.mjs supply DIFFERENT system prompts + tool maps —
// that is the only difference between our harness and the Claude-Code-style baseline.

import { buildMultimodalContent } from "./multimodal.mjs";
import { applyControl, controlToMessage } from "./bridge.mjs";

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
//   and call done again, up to `maxRepairs` times (the progress guard). This is what turns slivr from
//   a blind one-shot agent into a self-verifying one — it never finishes "green" on a failing check.
// The agent may write a short reasoning note before its JSON tool call. Pull that prose out (everything
// before the tool object) so the UI can show the WHY. "" when the message is JSON-only.
export function reasoningProse(text) {
  const s = String(text || "");
  const i = s.indexOf("{");
  if (i <= 0) return "";
  return s.slice(0, i).replace(/```\w*/g, "").replace(/\s+/g, " ").trim();
}

export async function runLoop({ provider, tools, toolMap, systemPrompt, task, maxSteps = Infinity, onStep, onToolStart, beforeTool, seedMessages, signal, verify, maxRepairs = 3, bridge }) {
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
      resp = await provider.chat(messages, { signal });
    } catch (e) {
      if (e.name === "AbortError" || signal?.aborted) { aborted = true; trace.push({ step, aborted: true }); break; }
      // Surface the failure to the caller instead of swallowing it. A bare "NO_OPENROUTER_KEY"
      // or "API 401/4xx" otherwise renders as a silent "1 turn · 0 tok" footer with no explanation.
      error = e.message === "NO_OPENROUTER_KEY"
        ? "no API key — set OPENROUTER_API_KEY (or apiKey in ~/.slivr.json)"
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
