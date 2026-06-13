// loop.mjs — the shared tool-use agent loop used by BOTH harnesses.
//
// The model emits exactly one tool call per turn as a JSON object:
//   {"tool": "read_file", "args": {...}}            // act
//   {"tool": "done", "args": {"summary": "..."}}    // finish
// The harness executes it, feeds the result back as a user message, and repeats until `done`
// or the step cap. agent.mjs and baseline.mjs supply DIFFERENT system prompts + tool maps —
// that is the only difference between our harness and the Claude-Code-style baseline.

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

export async function runLoop({ provider, tools, toolMap, systemPrompt, task, maxSteps = 14, onStep }) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `TASK:\n${task}\n\nBegin. Respond with ONE JSON tool call.` },
  ];
  let turns = 0, editFailures = 0, done = false, summary = "";
  const trace = [];

  for (let step = 0; step < maxSteps; step++) {
    turns++;
    let resp;
    try {
      resp = await provider.chat(messages);
    } catch (e) {
      trace.push({ step, error: "PROVIDER_ERROR", detail: e.message });
      break;
    }
    const call = extractJSON(resp.text);
    messages.push({ role: "assistant", content: resp.text });

    if (!call || !call.tool) {
      messages.push({ role: "user", content: 'Your message was not a valid JSON tool call. Respond with exactly one JSON object: {"tool":"...","args":{...}}.' });
      trace.push({ step, badCall: clip(resp.text, 300) });
      continue;
    }

    if (call.tool === "done") {
      done = true; summary = call.args?.summary || "";
      trace.push({ step, tool: "done", summary });
      break;
    }

    const fn = toolMap[call.tool];
    if (!fn) {
      messages.push({ role: "user", content: `Unknown tool "${call.tool}". Available: ${Object.keys(toolMap).join(", ")}, done.` });
      trace.push({ step, unknownTool: call.tool });
      continue;
    }

    let result;
    try { result = fn(call.args || {}); }
    catch (e) { result = { ok: false, error: e.message }; }

    if ((call.tool === "edit_file" || call.tool === "write_file") && result && result.ok === false) {
      editFailures++;
    }
    trace.push({ step, tool: call.tool, ok: result?.ok, tier: result?.tier });
    if (onStep) onStep({ step, tool: call.tool, args: call.args, result });

    messages.push({ role: "user", content: `RESULT (${call.tool}):\n${clip(result)}` });
  }

  return { done, summary, turns, editFailures, trace, totals: provider.totals() };
}
