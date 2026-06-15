// bridge.mjs — the agent-to-agent bridge (Block 22 "Sentinel"): lets ANOTHER agent (e.g. "Hermes") drive
// slivr NON-STOP without a human. Zero new deps — the transport is just stdout + the filesystem:
//   • OUT: a machine-readable NDJSON event stream (one JSON object per line) of everything slivr does.
//   • IN:  an append-only control file the controller writes; slivr polls it between turns (tracking a byte
//          offset so it only reads NEW lines) and appends an "ack" for each command it applies.
// Steering is applied ONLY in the inter-turn window (never mid tool-call), so a half-done edit is never
// mangled. This sits alongside the interactive REPL — it adds a mode, it does not replace anything.

import fs from "node:fs";

// Map a raw control command to a normalized action. PURE (no I/O) so it is trivially testable.
// Commands: {cmd:"inject", text}  {cmd:"redirect", goal|text}  {cmd:"answer", text}
//           {cmd:"abort"}  {cmd:"pause"}  {cmd:"resume"}
export function applyControl(raw) {
  if (!raw || typeof raw !== "object") return { kind: "noop", reason: "not an object" };
  const cmd = String(raw.cmd || raw.type || "").toLowerCase();
  const text = raw.text != null ? String(raw.text) : (raw.goal != null ? String(raw.goal) : (raw.directive != null ? String(raw.directive) : ""));
  switch (cmd) {
    case "inject": case "inject_guidance": case "guide": return { kind: "inject", text, id: raw.id };
    case "redirect": case "disrupt": return { kind: "redirect", text, id: raw.id };
    case "answer": return { kind: "answer", text, id: raw.id };
    case "abort": case "stop": case "cancel": return { kind: "abort", id: raw.id };
    case "pause": return { kind: "pause", id: raw.id };
    case "resume": return { kind: "resume", id: raw.id };
    default: return { kind: "noop", reason: `unknown cmd "${cmd}"`, id: raw.id };
  }
}

// The user-message text a normalized action injects into the loop for the NEXT turn. PURE.
export function controlToMessage(action) {
  switch (action.kind) {
    case "inject": return `CONTROLLER GUIDANCE (from the driving agent — apply going forward): ${action.text}`;
    case "redirect": return `CONTROLLER REDIRECT (from the driving agent): stop the current direction and re-prioritize. New goal/priority: ${action.text}\nRevise your plan accordingly on your next step.`;
    case "answer": return `CONTROLLER ANSWER (from the driving agent): ${action.text}`;
    default: return "";
  }
}

// Build the bridge. `out` is the writable for events (default stdout); `controlFile` is the append-only
// command log (optional — without it the bridge is emit-only). `clock` lets tests inject deterministic ts.
export function makeBridge({ out = process.stdout, controlFile = null, clock = () => Date.now() } = {}) {
  let seq = 0;
  let offset = 0;
  // Start reading the control file from its CURRENT end, so pre-existing lines aren't replayed.
  if (controlFile) { try { offset = fs.statSync(controlFile).size; } catch { offset = 0; } }

  function emit(type, payload = {}) {
    const ev = { seq: seq++, ts: clock(), t: type, ...payload };
    try { out.write(JSON.stringify(ev) + "\n"); } catch { /* never let telemetry crash the run */ }
    return ev;
  }

  // Drain NEW control lines since the last offset. Skips our own "ack" lines and malformed JSON (a bad
  // line never halts processing). Returns an array of raw command objects (each may carry an id).
  function poll() {
    if (!controlFile) return [];
    let buf;
    try { buf = fs.readFileSync(controlFile); } catch { return []; }
    if (buf.length <= offset) { offset = buf.length; return []; }
    const chunk = buf.slice(offset).toString("utf8");
    offset = buf.length;
    const cmds = [];
    for (const line of chunk.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let obj; try { obj = JSON.parse(t); } catch { continue; }
      if (!obj || obj.t === "ack" || obj.ack) continue; // skip our own acks
      cmds.push(obj);
    }
    return cmds;
  }

  // Append an ack for a processed command so the controller can confirm it landed. Advances the offset
  // past our own write so poll() doesn't read it back as a command.
  function ack(id, status = "applied") {
    if (!controlFile) return;
    try {
      fs.appendFileSync(controlFile, JSON.stringify({ t: "ack", ref: id ?? null, status, ts: clock() }) + "\n");
      offset = fs.statSync(controlFile).size;
    } catch { /* best effort */ }
  }

  return { emit, poll, ack };
}
