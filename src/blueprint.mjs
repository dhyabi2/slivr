// blueprint.mjs — the Blueprint (Block 17): a persistent, on-disk HIERARCHICAL build tree that lets the
// agent plan the WHOLE thing up front (every screen, entity, sprite, sound, UI state, sub-component),
// then grind through it leaf-by-leaf over hours WITHOUT losing focus, drifting, or silently dropping
// inner parts. Three fused mechanics (from the brainstorm round):
//   • up-front goal expansion into CONCRETE, zero-abstraction leaves (no static ontology — the model
//     expands it from genre conventions at plan time),
//   • per-node status + settled decisions that survive turns / context compaction (durable JSON on disk),
//   • a MATERIALIZATION-FIRST gate: a leaf can't be marked done while its evidence is a stub/placeholder,
// plus a COMPLETENESS CRITIC (structural + semantic) so 100% of the goal is covered. Zero new deps.

import fs from "node:fs";
import path from "node:path";

export const STATUSES = ["uncovered", "in_progress", "done", "blocked"];
const GLYPH = { uncovered: "☐", in_progress: "◐", done: "✓", blocked: "⚠" };

// Stub/placeholder markers — the zero-abstraction gate rejects "done" when the evidence still looks
// like a stub. Kept deliberately blunt: these almost never appear in finished, concrete artifacts.
const STUB_RE = /\b(TODO|FIXME|placeholder|coming soon|not implemented|your code here|add (?:art|asset|sound|code|content|sprite|image)s? here|lorem ipsum)\b/i;
const STUB_THROW_RE = /throw new Error\(\s*['"`](?:not implemented|unimplemented|stub|todo)/i;

// Does this evidence text look like a stub rather than a finished artifact? Empty/whitespace counts.
export function looksStub(text) {
  const t = String(text == null ? "" : text);
  if (!t.trim()) return true;
  return STUB_RE.test(t) || STUB_THROW_RE.test(t);
}

// Flatten a nested tree the agent supplies — [{title, kind?, leafType?, decision?, children?[]}] — into a
// keyed model with stable path ids ("1", "1.2", "1.2.3"). A node with children is a "group"; a childless
// node is a "leaf". Existing status/evidence are preserved when merging by id (see mergeNodes).
export function parseTree(goal, tree) {
  const nodes = {};
  const roots = [];
  const walk = (arr, parent, prefix) => {
    const ids = [];
    (Array.isArray(arr) ? arr : []).forEach((raw, i) => {
      const id = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      const kids = raw && Array.isArray(raw.children) ? raw.children : [];
      const kind = kids.length ? "group" : (raw && raw.kind === "group" ? "group" : "leaf");
      nodes[id] = {
        id, parent,
        title: String((raw && raw.title) || "").trim() || "(untitled)",
        kind,
        leafType: (raw && raw.leafType) ? String(raw.leafType) : (kind === "leaf" ? "part" : null),
        origin: (raw && (raw.origin === "pictured" || raw.origin === "world")) ? raw.origin : null,
        status: STATUSES.includes(raw && raw.status) ? raw.status : "uncovered",
        evidence: (raw && raw.evidence) ? String(raw.evidence) : "",
        decision: (raw && raw.decision) ? String(raw.decision) : "",
      };
      ids.push(id);
      const childIds = walk(kids, id, id);
      nodes[id].children = childIds;
    });
    return ids;
  };
  roots.push(...walk(tree, null, ""));
  return { goal: String(goal || "").trim(), roots, nodes };
}

function leafIds(model) { return Object.values(model.nodes).filter(n => n.kind === "leaf").map(n => n.id); }

// Coverage stats over LEAF nodes (groups are containers, not work). pct is over leaves.
export function coverage(model) {
  const leaves = leafIds(model).map(id => model.nodes[id]);
  const by = { uncovered: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const n of leaves) by[n.status] = (by[n.status] || 0) + 1;
  const total = leaves.length;
  const pictured = leaves.filter(n => n.origin === "pictured");
  const world = leaves.filter(n => n.origin === "world");
  const byOrigin = (pictured.length || world.length)
    ? { pictured: { total: pictured.length, done: pictured.filter(n => n.status === "done").length }, world: { total: world.length, done: world.filter(n => n.status === "done").length } }
    : null;
  return { totalLeaves: total, ...by, totalNodes: Object.keys(model.nodes).length, pct: total ? Math.round((by.done / total) * 100) : 0, ...(byOrigin ? { byOrigin } : {}) };
}

// Depth-first list of the next uncovered/in_progress leaves — the agent's "what's left" pointer.
export function nextUncovered(model, n = 5) {
  const out = [];
  const walk = (ids) => {
    for (const id of ids) {
      if (out.length >= n) return;
      const node = model.nodes[id];
      if (!node) continue;
      if (node.kind === "leaf" && (node.status === "uncovered" || node.status === "in_progress")) out.push(node);
      if (node.children && node.children.length) walk(node.children);
    }
  };
  walk(model.roots);
  return out;
}

// A compact, readable outline with status glyphs — cheap orientation each turn.
export function renderTree(model, { max = 200 } = {}) {
  const lines = [];
  const walk = (ids, depth) => {
    for (const id of ids) {
      if (lines.length >= max) return;
      const n = model.nodes[id];
      if (!n) continue;
      const g = GLYPH[n.status] || "☐";
      const otag = n.kind === "leaf" && n.origin ? (n.origin === "world" ? " ✦world" : " ◈pic") : "";
      const tag = (n.kind === "leaf" && n.leafType && n.leafType !== "part" ? ` [${n.leafType}]` : "") + otag;
      const ev = n.kind === "leaf" && n.status === "done" && n.evidence ? `  → ${n.evidence}` : "";
      lines.push(`${"  ".repeat(depth)}${g} ${id} ${n.title}${tag}${ev}`);
      if (n.children && n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(model.roots, 0);
  const c = coverage(model);
  const head = `Blueprint — ${c.done}/${c.totalLeaves} leaves done (${c.pct}%)` +
    (c.in_progress ? `, ${c.in_progress} in progress` : "") + (c.blocked ? `, ${c.blocked} blocked` : "");
  return head + "\n" + lines.join("\n");
}

// Completeness critic — the STRUCTURAL half (the agent does the semantic half by re-reading the goal).
// Flags the ways a tree silently under-delivers: groups with no leaves, leaves marked done with no/stub
// evidence, and a quick "is the goal vocabulary represented?" miss list. `readEvidence(path)->string|null`.
export function structuralAudit(model, readEvidence = () => null) {
  const findings = [];
  for (const n of Object.values(model.nodes)) {
    if (n.kind === "group" && (!n.children || n.children.length === 0)) {
      findings.push({ id: n.id, kind: "empty_group", msg: `group "${n.title}" has no children — expand it into concrete leaves` });
    }
    if (n.kind === "leaf" && n.status === "done") {
      if (!n.evidence) {
        findings.push({ id: n.id, kind: "done_no_evidence", msg: `leaf "${n.title}" is done but has no evidence (a real file/artifact path)` });
      } else {
        const txt = readEvidence(n.evidence);
        if (txt != null && looksStub(txt)) findings.push({ id: n.id, kind: "stub_evidence", msg: `leaf "${n.title}" evidence ${n.evidence} still looks like a stub/placeholder` });
        if (txt === null) findings.push({ id: n.id, kind: "missing_evidence", msg: `leaf "${n.title}" evidence ${n.evidence} does not exist or is unreadable` });
      }
    }
  }
  return findings;
}

// --- persistence: durable JSON at <dir>/.slivr/blueprint.json -----------------------------------------
function bpPath(dir) { return path.join(dir, ".slivr", "blueprint.json"); }

export function loadBlueprint(dir) {
  try { return JSON.parse(fs.readFileSync(bpPath(dir), "utf8")); } catch { return null; }
}
export function saveBlueprint(dir, model) {
  const p = bpPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(model, null, 2));
  return p;
}

// Merge a freshly-parsed tree onto an existing model, PRESERVING per-node progress (status/evidence/
// decision) by id — so re-planning or adding nodes never wipes settled work.
export function mergeProgress(prev, next) {
  if (!prev || !prev.nodes) return next;
  for (const [id, n] of Object.entries(next.nodes)) {
    const old = prev.nodes[id];
    if (old && old.title === n.title) {
      if (old.status && old.status !== "uncovered") n.status = old.status;
      if (old.evidence) n.evidence = old.evidence;
      if (old.decision && !n.decision) n.decision = old.decision;
    }
  }
  return next;
}
