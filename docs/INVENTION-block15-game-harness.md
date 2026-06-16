# Invention Block 15 — Game Harness: drive + observe a running game (the keystone)

Fifteenth feature — the answer to "most agents can't make a commercial-grade game." The research is
blunt: agents *can't see or feel a running game*, only the code. We brainstormed all 10 game-dev
challenges; **7 of them collapse onto one foundational capability**, built here.

## The 10 challenges (brainstormed) and the convergence
See / play / test / perf / state / balance / testability (C1, C2, C3, C6, C8, C9, C10) all need the same
thing: a way to **drive a running game and read its state over time**. The engine's top idea (r90) was
a "Simulacrum" deterministic step; the playtest/see ideas (r85/r75) were CDP drivers. Synthesis: a
zero-dependency harness over the system's headless Chrome — **no CDP/WebSocket**.

## The Simulacrum contract + play_game
A proov-built game exposes a deterministic control surface:
```js
window.proovSim = {
  reset(seed),         // deterministic re-init (seed the RNG)
  step(dtMs),          // advance ONE update+render (RAF loop just calls this)
  input(key, isDown),  // set a held input, e.g. input('ArrowRight', true)
  state(),             // small snapshot: { x, y, score, over, ... }
};
```
`play_game {path, inputs:[{at,key,down}], steps}` injects a driver that `reset`s, applies the input
timeline, `step`s N frames, records `state()` snapshots, and screenshots the final frame — so the agent
**verifies the game actually plays** (things move, score changes, win/lose is reachable) and fixes what
doesn't. eyes (frame) + hands (input) + clock (steps) + X-ray (state), deterministic, zero-dep.

## Coverage of the 10 challenges
- **C1 see it play / C2 playtest / C10 testable** → `play_game` + the Simulacrum contract (direct).
- **C3 feel / C6 perf** → state-over-time + frame stepping make motion & timing inspectable.
- **C8 state / C9 balance** → `state()` exposes it; drive at different values to tune.
- **C4 assets / C5 audio / C7 architecture / juice** → folded into a BUILDING GAMES prompt directive:
  procedural canvas art + WebAudio synthesis (zero asset files), easing/particles/shake, and the
  contract as the structural backbone.

## Implementation
- `src/gameharness.mjs`: `buildHarness` (inject the driver) + `playGame` (render via headless Chrome,
  read the state marker from `--dump-dom`, capture the final-frame screenshot). Reuses `eye.mjs`.
- `src/tools.mjs`: the `play_game` tool (returns state-over-time + a multimodal screenshot).
- `src/agent.mjs`: registered + a BUILDING GAMES directive (the contract, the play_game loop, procedural
  assets/audio/juice).
- `selftest.mjs`: +7 (harness injection; a REAL drive proving move/score/game-over; no-contract flagged;
  graceful when no browser). Suite 333 → 340.

## Measured
A tiny game exposing the contract, driven with `ArrowRight` held for 200 steps:
```
first {x:12, score:1, over:false}  →  last {x:302, score:146, over:true}
moved ✓   scored ✓   reached game-over ✓   + final-frame screenshot
```
The agent can now *play* the games it builds, not just write them — the missing sense that blocks
commercial-grade game work.
