#!/usr/bin/env node
// gen-bpmn.mjs — emit valid BPMN 2.0 (semantics + diagram interchange) for proov's agent workflow.
// Two datasets: V1 (the original, pre-audit) and V2 (after the audit fixes — Blocks 70-75: plan-first gate,
// final-verify-on-exit, honest verifiedStatus pass/fail/soft/unverified, quality-triggered escalation).
//   node docs/gen-bpmn.mjs docs/proov-workflow.bpmn          # V1 (old)
//   node docs/gen-bpmn.mjs docs/proov-workflow-v2.bpmn --v2  # V2 (new)
import { writeFileSync } from "node:fs";

const COLX = [150, 480, 820, 1160];
const ROWH = 110, Y0 = 60;
const SIZE = { start: [36, 36], end: [36, 36], task: [200, 72], gw: [50, 50] };

// ---- V1 (old) ----
const N1 = [
  ["start", "start", "Task submitted (REPL / driver)", 0, 0],
  ["sess", "task", "Create Session: Provider + Tools + toolMap + system prompt", 1, 0],
  ["gwPF", "gw", "Fresh VISUAL build, no reference, imageModel+key?", 2, 0],
  ["genRef", "task", "DESIGN-FIRST: generate_image → reference.png", 2, 1],
  ["model", "task", "Model call → extractJSON + normalizeCall → tool call", 3, 0],
  ["gwValid", "gw", "Valid tool call?", 4, 0],
  ["nValid", "task", "Nudge: respond with ONE JSON tool call", 4, 1],
  ["gwDone", "gw", "tool == done?", 5, 0],
  ["appr", "gw", "Approval / safety gate OK? (blocklist + mode)", 6, 2],
  ["nDeny", "task", "Denial nudge / denial-storm → stop", 5, 2],
  ["exec", "task", "Execute tool (toolMap)", 7, 2],
  ["guards", "gw", "Post-tool guards: thrash(59) / replan / anti-stuck", 8, 2],
  ["stopE", "end", "Stopped: budget / dead-end / aborted / error", 9, 2],
  ["g1", "gw", "Open checklist tasks remain?", 6, 0],
  ["nTasks", "task", "Nudge: finish & verify each task", 6, 1],
  ["g2", "gw", "Per-task acceptance check fails? (68)", 7, 0],
  ["nChecks", "task", "Run task.check (exit0); report failing", 7, 1],
  ["g3", "gw", "Task-fidelity: prompt-named lib used nowhere? (58)", 8, 0],
  ["nFidel", "task", "Nudge: actually USE the named repo/lib", 8, 1],
  ["g4", "gw", "Visual-match <95% / beyond-frame? (64/66)", 9, 0],
  ["nVisual", "task", "compare_regions >=95% vs reference; build full game", 9, 1],
  ["g5", "gw", "GAME gate problem? served(62) or static(37-61)", 10, 0],
  ["nGame", "task", "Fix to the bar: broken/frozen/art/structure/asset/anim/level/vision", 10, 1],
  ["g6", "gw", "Project-checks fail? typecheck/lint/build/test", 11, 0],
  ["nProj", "task", "Feed failure back → repair (bounded)", 11, 1],
  ["accept", "task", "Accept done — verified", 12, 0],
  ["succ", "end", "SUCCESS (→ REPL: verify-run-offer + next-step suggester 63)", 13, 0],
];
const F1 = [
  ["start", "sess"], ["sess", "gwPF"],
  ["gwPF", "genRef", "yes"], ["gwPF", "model", "no"], ["genRef", "model"],
  ["model", "gwValid"],
  ["gwValid", "nValid", "no"], ["gwValid", "gwDone", "yes"], ["nValid", "model"],
  ["gwDone", "appr", "no"], ["gwDone", "g1", "yes (DONE-GATE)"],
  ["appr", "nDeny", "deny"], ["appr", "exec", "allow"], ["nDeny", "model"],
  ["exec", "guards"], ["guards", "model", "continue"], ["guards", "stopE", "stuck/spin"],
  ["g1", "nTasks", "yes"], ["g1", "g2", "no"], ["nTasks", "model"],
  ["g2", "nChecks", "fail"], ["g2", "g3", "pass"], ["nChecks", "model"],
  ["g3", "nFidel", "miss"], ["g3", "g4", "ok"], ["nFidel", "model"],
  ["g4", "nVisual", "fail"], ["g4", "g5", "pass"], ["nVisual", "model"],
  ["g5", "nGame", "problem"], ["g5", "g6", "ok"], ["nGame", "model"],
  ["g6", "nProj", "fail"], ["g6", "accept", "pass/none"], ["nProj", "model"],
  ["accept", "succ"],
];

// ---- V2 (new — after the audit, Blocks 70-75) ----
const N2 = [
  ["start", "start", "Task submitted (REPL / driver)", 0, 0],
  ["sess", "task", "Create Session: Provider + Tools + toolMap + system prompt", 1, 0],
  ["gwPF", "gw", "Fresh VISUAL build, no reference, imageModel+key?", 2, 0],
  ["genRef", "task", "DESIGN-FIRST: generate_image → reference.png (67)", 2, 1],
  ["model", "task", "Model call → normalizeCall → tool call (57)", 3, 0],
  ["gwValid", "gw", "Valid tool call?", 4, 0],
  ["nValid", "task", "Nudge: respond with ONE JSON tool call", 4, 1],
  ["gwDone", "gw", "tool == done?", 5, 0],
  ["gwPlan", "gw", "NEW Substantial task, NO plan, first edit? (73)", 6, 2],
  ["nPlan", "task", "NEW Nudge: task_write a plan first — decompose (73)", 5, 2],
  ["appr", "gw", "Approval / safety gate OK? (blocklist + mode)", 7, 2],
  ["nDeny", "task", "Denial nudge / denial-storm → stop", 6, 3],
  ["exec", "task", "Execute tool (toolMap)", 8, 2],
  ["guards", "gw", "Post-tool guards: thrash(59) / replan / anti-stuck", 9, 2],
  ["stopE", "end", "Stopped: budget / dead-end", 10, 2],
  ["g1", "gw", "Open checklist tasks remain?", 6, 0],
  ["nTasks", "task", "Nudge: finish & verify each task", 6, 1],
  ["g2", "gw", "Per-task acceptance check fails? (68)", 7, 0],
  ["nChecks", "task", "Run task.check (exit0); report failing", 7, 1],
  ["g3", "gw", "Task-fidelity: prompt-named lib used nowhere? (58)", 8, 0],
  ["nFidel", "task", "Nudge: actually USE the named repo/lib", 8, 1],
  ["g4", "gw", "Visual-match <95% / beyond-frame? (64/66/72)", 9, 0],
  ["nVisual", "task", "compare_regions >=95% vs reference; build full game", 9, 1],
  ["g5", "gw", "GAME gate problem? served(62)/static(37-61)", 10, 0],
  ["nGame", "task", "Fix to the bar: broken/frozen/art/structure/asset/anim/level/vision", 10, 1],
  ["g6", "gw", "Project-checks fail? typecheck/lint/build/test", 11, 0],
  ["nProj", "task", "Feed failure back → repair (bounded)", 11, 1],
  ["accept", "task", "Accept done (inner gates passed)", 12, 0],
  ["fv", "task", "NEW FINAL VERIFY (task + project checks)", 13, 0],
  ["gwV", "gw", "NEW verification passed?", 14, 0],
  ["succ", "end", "SUCCESS — verified", 15, 0],
  ["remediate", "task", "NEW FAIL → detailed failures + GENERATE NEW CHECKLIST of fixes, same model (77)", 14, 3],
];
const F2 = [
  ["start", "sess"], ["sess", "gwPF"],
  ["gwPF", "genRef", "yes"], ["gwPF", "model", "no"], ["genRef", "model"],
  ["model", "gwValid"],
  ["gwValid", "nValid", "no"], ["gwValid", "gwDone", "yes"], ["nValid", "model"],
  ["gwDone", "gwPlan", "no"], ["gwDone", "g1", "yes (DONE-GATE)"],
  ["gwPlan", "nPlan", "plan first"], ["gwPlan", "appr", "ok"], ["nPlan", "model"],
  ["appr", "nDeny", "deny"], ["appr", "exec", "allow"], ["nDeny", "model"],
  ["exec", "guards"], ["guards", "model", "continue"], ["guards", "stopE", "stuck/spin"],
  ["g1", "nTasks", "yes"], ["g1", "g2", "no"], ["nTasks", "model"],
  ["g2", "nChecks", "fail"], ["g2", "g3", "pass"], ["nChecks", "model"],
  ["g3", "nFidel", "miss"], ["g3", "g4", "ok"], ["nFidel", "model"],
  ["g4", "nVisual", "fail"], ["g4", "g5", "pass"], ["nVisual", "model"],
  ["g5", "nGame", "problem"], ["g5", "g6", "ok"], ["nGame", "model"],
  ["g6", "nProj", "fail"], ["g6", "accept", "pass/none"], ["nProj", "model"],
  ["accept", "fv"], ["fv", "gwV"],
  ["gwV", "succ", "pass"], ["gwV", "remediate", "FAIL"], ["remediate", "model", "next iteration"],
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function emit(N, F, outPath) {
  const byId = Object.fromEntries(N.map(([id, type, label, rank, col]) => [id, { id, type, label, rank, col }]));
  const pos = (n) => { const [w, h] = SIZE[n.type]; const x = COLX[n.col] + (n.type === "task" ? 0 : (200 - w) / 2); const y = Y0 + n.rank * ROWH + (72 - h) / 2; return { x, y, w, h }; };
  const box = (n) => { const p = pos(n); return { ...p, cx: p.x + p.w / 2, cy: p.y + p.h / 2, r: p.x + p.w, b: p.y + p.h }; };
  const bx = Object.fromEntries(N.map(([id]) => [id, box(byId[id])]));
  const waypoints = (a, b) => {
    if (b.cy > a.cy + 10) return [[a.cx, a.b], [b.cx, b.y]];
    if (b.cy < a.cy - 10) return [[a.cx, a.y], [b.cx, b.b]];
    if (b.cx > a.cx) return [[a.r, a.cy], [b.x, b.cy]];
    return [[a.x, a.cy], [b.r, b.cy]];
  };
  const shapeXml = N.map(([id, type]) => { const p = bx[id]; return `      <bpmndi:BPMNShape id="di_${id}" bpmnElement="${id}"${type === "gw" ? ' isMarkerVisible="true"' : ""}>\n        <dc:Bounds x="${Math.round(p.x)}" y="${Math.round(p.y)}" width="${p.w}" height="${p.h}" />\n      </bpmndi:BPMNShape>`; }).join("\n");
  const flowDefs = F.map(([from, to, label], i) => `    <bpmn:sequenceFlow id="f${i}" sourceRef="${from}" targetRef="${to}"${label ? ` name="${esc(label)}"` : ""} />`).join("\n");
  const edgeXml = F.map(([from, to], i) => { const wps = waypoints(bx[from], bx[to]).map(([x, y]) => `        <di:waypoint x="${Math.round(x)}" y="${Math.round(y)}" />`).join("\n"); return `      <bpmndi:BPMNEdge id="di_f${i}" bpmnElement="f${i}">\n${wps}\n      </bpmndi:BPMNEdge>`; }).join("\n");
  const nodeDefs = N.map(([id, type, label]) => {
    const tag = type === "start" ? "startEvent" : type === "end" ? "endEvent" : type === "gw" ? "exclusiveGateway" : "task";
    const inc = F.map((f, k) => [f, k]).filter(([f]) => f[1] === id).map(([, k]) => `      <bpmn:incoming>f${k}</bpmn:incoming>`).join("\n");
    const out = F.map((f, k) => [f, k]).filter(([f]) => f[0] === id).map(([, k]) => `      <bpmn:outgoing>f${k}</bpmn:outgoing>`).join("\n");
    return `    <bpmn:${tag} id="${id}" name="${esc(label)}">\n${[inc, out].filter(Boolean).join("\n")}\n    </bpmn:${tag}>`;
  }).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="proov_defs" targetNamespace="http://proov/workflow">
  <bpmn:process id="proov_agent" name="Proov coding-agent workflow" isExecutable="false">
${nodeDefs}
${flowDefs}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="proov_agent">
${shapeXml}
${edgeXml}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
  writeFileSync(outPath, xml);
  process.stderr.write(`wrote ${outPath} — ${N.length} elements, ${F.length} flows\n`);
}

const v2 = process.argv.includes("--v2");
const outPath = process.argv.find((a) => a.endsWith(".bpmn")) || (v2 ? "docs/proov-workflow-v2.bpmn" : "docs/proov-workflow.bpmn");
emit(v2 ? N2 : N1, v2 ? F2 : F1, outPath);
