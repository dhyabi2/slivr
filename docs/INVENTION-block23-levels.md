# Invention Block 23 — Levels: real multi-level games (data-driven, distinct, verified)

Twenty-third feature — the answer to "agents can only build a single-level playground." They hardcode one
scene and stop, or — if they try — clone level 1. proov now builds games with several **meaningfully
different** levels and **verifies every one** loads, is distinct (not a clone), plays, and progresses.

## The challenge, decomposed
1. **Data-driven levels** — separate level DATA from the engine so N levels = N records, not N code copies.
2. **A level manager / flow** — title → level i → win→next / lose→retry → victory, with a deterministic
   surface a harness can drive.
3. **Verify every level** — prove each loads, is DISTINCT from the others, plays, and is completable.

## Brainstorm → rank (engine at localhost:8787)
- Master (LevelManager + generative playtesting): **75**.
- **Data-driven format — 85**: each level a data record (layout + spawns + context overrides + difficulty
  tier); the engine reads data, doesn't duplicate code; difference comes from parameterized modules + a
  difficulty curve, not clones.
- **Level flow / manager — 85**: a data-driven flow graph + a coordinator exposing `GoToState(state,params)`
  / `TriggerEvent` so a harness can jump to any level and drive win/lose/next transitions.
- **Verification — 75**: behavioral-structural FINGERPRINTING — `reset(N)` → loads; scripted input →
  plays; compare each level's fingerprint to flag **clones**; a win-state reachable → completable. (The RL
  completability agent is dropped — proov uses scripted-input + a win flag, and per-level `play_game` for
  deep completability.)

## What was built — `play_levels` (`src/gameharness.mjs`)
Extends the Block-15 Simulacrum contract to be **level-aware**:
```js
window.proovSim.levels      // number of levels (or the level array)
window.proovSim.load(i)     // load level i deterministically (or reset(i))
// + the existing reset / step / input / state
```
`play_levels {path}` injects a driver that iterates EVERY level: `load(i)`, snapshot the initial state
(structural fingerprint — with any level-index field stripped so an index-only difference still counts as a
clone), drive scripted inputs (behavioral check), capture each level's initial frame. It returns a per-level
report — **loads / plays / distinct / completable** — an overall `allDistinct` / `allPlayable`, the list of
`clones`, and a **contact sheet** of every level's first frame. The distinctness fingerprint is the key
anti-pattern detector: cloned levels are caught even when they differ only by index.

`src/agent.mjs` registers it (both maps + FINDING_TOOLS) and adds a **MULTI-LEVEL GAMES** directive
(data-driven levels array, a level manager with transitions, the level-aware contract, verify with
play_levels, each level a blueprint leaf). `src/ui.mjs` adds a label. `selftest.mjs §43` covers it.

## Measured
- selftest: **401 passed, 0 failed** (was 395; +6).
- **The key property (deterministic):** a 3-distinct-level game → `uniqueLevels:3, clones:[], allDistinct`,
  each level loads/plays/distinct/completable; a 3-CLONE game (levels identical but for the index) →
  `uniqueLevels:1, clones:[1,2,3], allDistinct:false`. The selftest asserts exactly this — the usual
  multi-level failure is caught.
- End-to-end (gemini-2.5-flash, `--auto`): "build a 3-level side-scroller, data-driven, verify with
  play_levels." The agent kept level data in a `levelData` array separate from the engine, implemented the
  level manager + the level-aware contract, and used `play_levels` to verify. Independently re-verified:
  **count 3, uniqueLevels 3, no clones, allDistinct + allPlayable true** — a real, data-driven, distinct
  3-level game, not a single playground or a clone.

## Why it disrupts
"Multi-level" from other agents is one playground or three copies of it. proov separates level data from the
engine, drives every level, and *proves* each one is distinct and playable — flagging clones automatically.
Composes with the game harness (per-level `play_game`), the Blueprint (a leaf per level), and the Asset
Studio / world map (distinct level art and layout).
