// loop.mjs — the shared tool-use agent loop used by BOTH harnesses.
//
// The model emits exactly one tool call per turn as a JSON object:
//   {"tool": "read_file", "args": {...}}            // act
//   {"tool": "done", "args": {"summary": "..."}}    // finish
// The harness executes it, feeds the result back as a user message, and repeats until `done`
// or the step cap. agent.mjs and baseline.mjs supply DIFFERENT system prompts + tool maps —
// that is the only difference between our harness and the Claude-Code-style baseline.

import { buildMultimodalContent } from "./multimodal.mjs";

function extractJSON(text) {
  // tolerate ```json fences and leading prose; grab the first balanced {...} object.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
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
export async function runLoop({ provider, tools, toolMap, systemPrompt, task, maxSteps = 14, onStep, beforeTool, seedMessages, signal, verify, maxRepairs = 3 }) {
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

  let aborted = false;
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) { aborted = true; trace.push({ step, aborted: true }); break; }
    // Final-step nudge: on the last allowed step, tell the model to stop exploring and finish, so a
    // turn ends with a usable result instead of silently hitting the step cap.
    if (step === maxSteps - 1 && maxSteps > 1 && !finalNudged) {
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
        if (v.ok) { verified = true; done = true; trace.push({ step, tool: "done", summary }); break; }
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

    let result;
    try { result = await fn(call.args || {}); }
    catch (e) { result = { ok: false, error: e.message }; }

    if ((call.tool === "edit_file" || call.tool === "write_file") && result && result.ok === false) {
      editFailures++;
    }
    trace.push({ step, tool: call.tool, ok: result?.ok, tier: result?.tier });
    if (onStep) onStep({ step, tool: call.tool, args: call.args, result });

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

  // If we fell out of the loop without finishing, aborting, or erroring, we hit the step cap.
  if (!done && !aborted && !error && !stopped) {
    stopped = `reached the ${maxSteps}-step limit before finishing — raise --max-steps or narrow the task`;
  }

  return { done, summary, turns, editFailures, trace, aborted, error, stopped, verified, repairs, messages, totals: provider.totals() };
}
