// events.mjs — OPTIONAL workflow event emitter. When proov is configured with an event sink (eventsUrl to
// POST to, and/or eventsFile to append NDJSON), it emits structured workflow events tagged with the BPMN
// STEP id (matching docs/proov-workflow-v2.bpmn), so an external monitor can show — in real time — where the
// agent currently is in the workflow. Fire-and-forget: a sink that's down or slow NEVER breaks the run.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

// Map an event to a BPMN node id in proov-workflow-v2.bpmn (the "current step" the monitor highlights).
export function stepFor(evt = {}) {
  const { type, tool, gate, status } = evt;
  switch (type) {
    case "run_start": return "start";
    case "session": return "sess";
    case "preflight": return "genRef";
    case "round": return "model";
    case "model": return "model";
    case "tasks": return null;   // metadata for the monitor's task-tree box — does NOT move the step highlight
    case "tool_start":
    case "tool_result":
      if (tool === "done") return "gwDone";
      if (tool === "task_write" || tool === "plan" || tool === "blueprint_plan") return "model";
      return "exec";
    case "gate":
      return ({ plan: "gwPlan", "task-check": "g2", fidelity: "g3", visual: "g4", beyond: "g4", game: "g5", served: "g5", project: "g6", tasks: "g1" })[gate] || "g1";
    case "verify": return "fv";
    case "done":
      return status === "fail" ? "remediate" : "succ";
    case "stop": return status === "fail" ? "remediate" : "stopE";
    default: return "model";
  }
}

// Build an emitter from config. Returns { emit(evt), enabled }. No sink configured → a cheap no-op.
export function makeEmitter(opts = {}) {
  const url = opts.eventsUrl || "";
  const file = opts.eventsFile || "";
  if (!url && !file) return { emit() {}, enabled: false };
  const runId = opts.runId || `${Date.now().toString(36)}-${process.pid}`;
  let seq = 0;
  let target = null;
  if (url) { try { target = new URL(url); } catch { target = null; } }
  const post = (body) => {
    if (!target) return;
    try {
      const lib = target.protocol === "https:" ? https : http;
      const req = lib.request({
        hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 1500,
      });
      req.on("error", () => {});
      req.on("timeout", () => req.destroy());
      req.end(body);
    } catch { /* never break the run */ }
  };
  const emit = (evt = {}) => {
    try {
      const e = { runId, seq: seq++, ts: Date.now(), step: stepFor(evt), ...evt };
      const body = JSON.stringify(e);
      if (file) { try { fs.appendFileSync(file, body + "\n"); } catch { /* */ } }
      if (url) post(body);
    } catch { /* */ }
  };
  return { emit, enabled: true, runId };
}
