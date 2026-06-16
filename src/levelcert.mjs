/* Vendored from https://github.com/dhyabi2/esg-coreach (ESG-CoReach, AGPL-3.0-or-later, same
   author + license as proov). EXACT play-state graph + sound co-reachability certificate proving a
   discrete lock-and-key level is solvable AND soft-lock-free. Tiles: # wall, S spawn, G goal,
   . floor, k key (+1 held when first stepped), D door (consumes 1 held key, stays open).
   State = (x,y,doorMask,keyMask). Certified iff every reachable state can still reach the goal.
   Pure, dependency-free, deterministic. Used by certify_level + the lock-and-key done-gate (§61). */


const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const pc = (n) => { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };

export function parse(rows) {
  const grid = rows.map((r) => r.split(""));
  let spawn = null, goal = null; const keys = [], doors = [];
  for (let y = 0; y < grid.length; y++) for (let x = 0; x < grid[y].length; x++) {
    const c = grid[y][x];
    if (c === "S") spawn = [x, y]; else if (c === "G") goal = [x, y];
    else if (c === "k") keys.push([x, y]); else if (c === "D") doors.push([x, y]);
  }
  return { grid, spawn, goal, keys, doors, W: grid[0].length, H: grid.length };
}

/* The transition function delta, as a reusable object — the SAME rules the
   certifier and the playable demo both run (so the demo is provably faithful).
   step(st, dx, dy) returns the next state, or null if the move is blocked. */
export function makeDelta(L) {
  const { grid, keys, doors } = L;
  const keyIdx = new Map(keys.map((k, i) => [k[0] + "," + k[1], i]));
  const doorIdx = new Map(doors.map((d, i) => [d[0] + "," + d[1], i]));
  const enc = (s) => `${s.x},${s.y}|${s.dm}|${s.km}`;
  const held = (s) => pc(s.km) - pc(s.dm);
  function step(st, dx, dy) {
    const nx = st.x + dx, ny = st.y + dy;
    if (ny < 0 || ny >= grid.length || nx < 0 || nx >= grid[ny].length) return null;
    if (grid[ny][nx] === "#") return null;
    let dm = st.dm, km = st.km;
    const dk = doorIdx.get(nx + "," + ny);
    if (dk !== undefined && !(dm & (1 << dk))) {              // closed door ahead
      if (pc(km) - pc(dm) <= 0) return null;                  // no key -> blocked
      dm |= (1 << dk);                                        // consume a key, door opens
    }
    const kk = keyIdx.get(nx + "," + ny);
    if (kk !== undefined && !(km & (1 << kk))) km |= (1 << kk); // pick up key (+1 held)
    return { x: nx, y: ny, dm, km };
  }
  return { step, enc, held, keyIdx, doorIdx };
}

/* Build the EXACT reachable state graph R from the spawn using delta. */
export function build(L) {
  const { spawn, goal } = L;
  const D = makeDelta(L), enc = D.enc;
  const start = { x: spawn[0], y: spawn[1], dm: 0, km: 0 }, s0 = enc(start);
  const meta = new Map([[s0, start]]);
  const adj = new Map(), seen = new Set([s0]), q = [s0], goalStates = new Set();
  while (q.length) {
    const cur = q.shift(), st = meta.get(cur), out = [];
    if (st.x === goal[0] && st.y === goal[1]) goalStates.add(cur);
    for (const [dx, dy] of DIRS) {
      const ns = D.step(st, dx, dy); if (!ns) continue;
      const key = enc(ns); out.push(key);
      if (!seen.has(key)) { seen.add(key); meta.set(key, ns); q.push(key); }
    }
    adj.set(cur, out);
  }
  return { adj, s0, goalStates, states: [...seen], meta, D, goal };
}

/* Backward fixpoint: W = every state from which SOME goal state is reachable. */
export function coReach(G) {
  const rev = new Map(); for (const s of G.states) rev.set(s, []);
  for (const [s, outs] of G.adj) for (const o of outs) rev.get(o).push(s);
  const W = new Set(G.goalStates), q = [...G.goalStates];
  while (q.length) { const s = q.shift(); for (const p of rev.get(s)) if (!W.has(p)) { W.add(p); q.push(p); } }
  return W;
}

/* The CERTIFICATE: a level is certified iff every REACHABLE state is co-reachable
   (R subset of W). That proves NO legal move sequence can ever strand the player.
   Returns the witness needed to re-check independently. */
export function certify(L) {
  const G = build(L), W = coReach(G);
  const softlocks = G.states.filter((s) => !W.has(s));
  const solvable = G.goalStates.size > 0 && W.has(G.s0);
  return {
    ok: solvable && softlocks.length === 0,
    solvable,
    nStates: G.states.length,
    nSoftlock: softlocks.length,
    softlockExample: softlocks[0] || null,
    // witness for a 3rd-party re-checker:
    witness: { s0: G.s0, goalStates: [...G.goalStates], adj: G.adj, states: G.states },
    G, W,
  };
}

/* Independent RE-CHECKER: a third party trusts NOTHING from the generator — it
   re-derives W from the witness graph and re-verifies R subset of W. */
export function recheck(witness) {
  const states = new Set(witness.states);
  const rev = new Map(); for (const s of witness.states) rev.set(s, []);
  for (const [s, outs] of witness.adj) for (const o of outs) if (states.has(o)) rev.get(o).push(s);
  const W = new Set(witness.goalStates), q = [...witness.goalStates];
  while (q.length) { const s = q.shift(); for (const p of rev.get(s) || []) if (!W.has(p)) { W.add(p); q.push(p); } }
  const allCoReach = witness.states.every((s) => W.has(s));
  return { verified: allCoReach && W.has(witness.s0), nSoftlock: witness.states.filter((s) => !W.has(s)).length };
}

/* GROUND-TRUTH ORACLE (slow, independent method): a state is winning iff a FORWARD
   search from it reaches a goal. Used only to prove the fast certificate is SOUND. */
export function oracleWinning(G) {
  const win = new Set();
  for (const s of G.states) {
    const seen = new Set([s]), q = [s]; let ok = false;
    while (q.length) { const c = q.shift(); if (G.goalStates.has(c)) { ok = true; break; } for (const o of G.adj.get(c) || []) if (!seen.has(o)) { seen.add(o); q.push(o); } }
    if (ok) win.add(s);
  }
  return win;
}

export { pc };
