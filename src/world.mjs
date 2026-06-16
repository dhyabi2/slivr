// world.mjs — outer-world discovery (Block 21, Challenge 2): no agent uses a reference picture + an LLM to
// DISCOVER the world beyond the frame — what's north, over the hill, inside the building, the rest of the
// map. proov does: it treats the reference as the ORIGIN tile of a spatial grid map, the model infers the
// neighbouring regions (edge-exits + implied features), and each is built as a style-consistent tile (verify
// with style_check, Block 20). This module is the persistent, traversable map + oversight. Zero deps.

import fs from "node:fs";
import path from "node:path";

const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };

function mapPath(dir) { return path.join(dir, ".proov", "world-map.json"); }
export function loadWorld(dir) { try { return JSON.parse(fs.readFileSync(mapPath(dir), "utf8")); } catch { return null; } }
export function saveWorld(dir, model) { const p = mapPath(dir); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(model, null, 2)); return p; }

function key(x, y) { return `${x},${y}`; }

// Seed the map with the ORIGIN region (the reference picture itself), at grid (0,0).
export function seedWorld(name, description) {
  const id = "r0";
  return { seed: { name: String(name || "origin"), description: String(description || "") }, next: 1,
    regions: { [id]: { id, name: String(name || "origin"), x: 0, y: 0, description: String(description || ""), origin: true, tile: "", styleScore: null } } };
}

// Place a region. Either absolute {x,y} or relative {fromId, direction}. Returns {ok, id} | {ok:false,error}.
export function addRegion(model, { name, description = "", x, y, fromId, direction } = {}) {
  if (!name) return { ok: false, error: "NO_NAME" };
  let gx = x, gy = y;
  if (gx == null || gy == null) {
    if (!fromId || !model.regions[fromId]) return { ok: false, error: "NO_ANCHOR", hint: "pass x,y OR fromId+direction" };
    const d = DIRS[String(direction || "").toLowerCase()];
    if (!d) return { ok: false, error: "BAD_DIRECTION", hint: "direction ∈ n s e w ne nw se sw" };
    gx = model.regions[fromId].x + d[0]; gy = model.regions[fromId].y + d[1];
  }
  const occupied = Object.values(model.regions).find((r) => r.x === gx && r.y === gy);
  if (occupied) return { ok: false, error: "CELL_OCCUPIED", id: occupied.id, hint: `(${gx},${gy}) is already "${occupied.name}"` };
  const id = "r" + (model.next++);
  model.regions[id] = { id, name: String(name), x: gx, y: gy, description: String(description), origin: false, tile: "", styleScore: null };
  return { ok: true, id, x: gx, y: gy };
}

// Attach a built, style-checked tile to a region.
export function setTile(model, id, file, styleScore) {
  const r = model.regions[id];
  if (!r) return { ok: false, error: "NO_SUCH_REGION", id };
  r.tile = String(file || ""); if (styleScore != null) r.styleScore = styleScore;
  return { ok: true };
}

export function worldCoverage(model) {
  const rs = Object.values(model.regions);
  const tiled = rs.filter((r) => r.tile);
  const styled = rs.filter((r) => typeof r.styleScore === "number" && r.styleScore >= 85);
  return { regions: rs.length, tiled: tiled.length, stylePass: styled.length };
}

// Render the map as an ASCII compass grid (origin marked) + a legend — the agent's spatial oversight.
export function renderWorld(model) {
  const rs = Object.values(model.regions);
  if (!rs.length) return "(empty world — seed it from the reference first)";
  const xs = rs.map((r) => r.x), ys = rs.map((r) => r.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const at = {}; rs.forEach((r) => { at[key(r.x, r.y)] = r; });
  const lines = [];
  for (let y = minY; y <= maxY; y++) {
    let row = "";
    for (let x = minX; x <= maxX; x++) {
      const r = at[key(x, y)];
      if (!r) { row += " ·· "; continue; }
      const mark = r.origin ? "◎" : r.tile ? (r.styleScore >= 85 ? "■" : "▣") : "□";
      row += ` ${mark}${r.id.replace("r", "")} `;
    }
    lines.push(row);
  }
  const cov = worldCoverage(model);
  const legend = rs.map((r) => `  ${r.id} (${r.x},${r.y})${r.origin ? " ◎origin" : ""}: ${r.name}${r.tile ? ` → ${r.tile}${typeof r.styleScore === "number" ? ` [style ${r.styleScore}]` : ""}` : ""}`).join("\n");
  return `World map — ${cov.regions} regions, ${cov.tiled} tiled, ${cov.stylePass} style-pass (◎origin ■tiled+instyle ▣tiled □planned)\nN↑\n${lines.join("\n")}\n${legend}`;
}
