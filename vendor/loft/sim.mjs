/* SPDX-License-Identifier: AGPL-3.0-or-later
   LOFT sim core — a DETERMINISTIC fixed-timestep game state machine.
   "Lazy-Oracle Fixed-Tick": the authority is not a running loop; it is this pure
   step() function + durable state + an input clock. Determinism is the whole game:
   the same (state, inputs) MUST yield a byte-identical next state on every machine,
   forever — that is what lets a serverless function fold ticks on demand and what
   makes the hash-chain + fraud proofs sound.

   Determinism discipline (enforced by construction here):
     - ALL state is integers (fixed-point, SCALE = 1000). No float math on state.
     - No Date / Math.random / iteration-order ambiguity. Inputs are sorted by playerId
       before folding so concurrent arrivals fold in a canonical order.
   The toy game (full-information, fits the colossus use case): N players on a plane
   push a shared "colossus" body. Each player has integer pos/vel; input is a desired
   move dir in {-1,0,1}^2. A player adjacent to the colossus imparts a push. The
   colossus has HP; aggregate pushes toward the arena center drain HP. Goal reachable
   from start => full-information, deterministic, adversarially checkable. */

import { createHash } from "node:crypto";

export const SCALE = 1000;            // fixed-point: 1.0 == 1000
const ARENA = 20 * SCALE;             // +/- bound
const PUSH_RANGE = 3 * SCALE;         // adjacency for pushing the colossus
const fp = (n) => Math.round(n * SCALE);

/* genesis state for P players, deterministic from a seed (seed only places start pos) */
export function genesis(numPlayers, seed = 1) {
  const players = [];
  for (let i = 0; i < numPlayers; i++) {
    // deterministic ring placement (integer trig via a fixed table, no Math.random)
    const ang = (i * 2654435761) % 360;                 // integer hash -> degrees
    const rx = Math.round(Math.cos((ang * Math.PI) / 180) * 8 * SCALE);
    const rz = Math.round(Math.sin((ang * Math.PI) / 180) * 8 * SCALE);
    players.push({ id: i, x: rx, z: rz, vx: 0, vz: 0, score: 0 });
  }
  return { tick: 0, seed: seed | 0, players, boss: { x: 0, z: 0, hp: 100 * SCALE } };
}

const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/* THE PURE TRANSITION. inputs: array of {playerId, dx, dz} (dx,dz in {-1,0,1}).
   Returns a NEW state object; never mutates the argument. */
export function step(state, inputs) {
  const s = { tick: state.tick + 1, seed: state.seed,
    players: state.players.map((p) => ({ ...p })),
    boss: { ...state.boss } };
  const byId = new Map(s.players.map((p) => [p.id, p]));
  // canonical fold order: sort inputs by playerId (concurrency-safe determinism)
  const ins = [...inputs].filter((i) => byId.has(i.playerId))
    .sort((a, b) => a.playerId - b.playerId);
  const ACC = fp(0.6), FRICT = 820;           // 0.82 in fixed point
  for (const inp of ins) {
    const p = byId.get(inp.playerId);
    p.vx += clampI(sgn(inp.dx), -1, 1) * ACC;
    p.vz += clampI(sgn(inp.dz), -1, 1) * ACC;
  }
  // integrate all players (deterministic order: by id)
  let bossDmg = 0;
  for (const p of s.players) {
    p.vx = Math.trunc((p.vx * FRICT) / SCALE);
    p.vz = Math.trunc((p.vz * FRICT) / SCALE);
    p.x = clampI(p.x + p.vx, -ARENA, ARENA);
    p.z = clampI(p.z + p.vz, -ARENA, ARENA);
    const dx = p.x - s.boss.x, dz = p.z - s.boss.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < PUSH_RANGE * PUSH_RANGE && d2 > 0) {
      // player pushes boss away from itself, toward arena center counts as damage
      const towardCenter = -(dx * s.boss.x + dz * s.boss.z);
      const hit = 20 + Math.trunc((Math.abs(p.vx) + Math.abs(p.vz)) / 10);
      bossDmg += hit;
      p.score += hit;
      if (towardCenter >= 0) bossDmg += 5;   // bonus for cornering the colossus
    }
  }
  s.boss.hp = clampI(s.boss.hp - bossDmg, 0, 100 * SCALE);
  // boss drifts deterministically (integer pseudo-walk from tick, no RNG)
  const t = s.tick;
  s.boss.x = clampI(s.boss.x + ((t * 31) % 7) - 3, -ARENA, ARENA);
  s.boss.z = clampI(s.boss.z + ((t * 17) % 7) - 3, -ARENA, ARENA);
  return s;
}

/* goal predicate (reachability / win condition): colossus defeated */
export const isGoal = (s) => s.boss.hp <= 0;

/* CANONICAL SERIALIZATION -> stable hash. Key order is fixed; all values integer,
   so the bytes are identical on every platform (the determinism contract). */
export function serialize(state) {
  const parts = [state.tick, state.seed,
    state.boss.x, state.boss.z, state.boss.hp];
  for (const p of state.players) parts.push(p.id, p.x, p.z, p.vx, p.vz, p.score);
  return parts.join(",");
}
export function stateHash(state) {
  return createHash("sha256").update(serialize(state)).digest("hex");
}
