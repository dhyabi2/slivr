# Invention Block 17 — The Blueprint: plan the whole build, zero abstraction, 100% coverage

Seventeenth feature — the answer to "agents one-shot a big build into a basic visualization and silently
drop the inner parts." Building something large (a real game, a real app) is a **structuring + memory +
persistence** problem: you must know what will be in it *in advance*, decompose it with **no abstraction**
down to the small parts, and then grind through *all of them* one by one over hours without losing focus
or the thread. Most agents can't — they lose coverage as context grows. proov now holds the whole plan on
disk and works it leaf by leaf.

## The challenge, decomposed
1. **Goal visualization / intent** — derive the *complete* intended thing from a one-line request.
2. **Hierarchical decomposition, zero abstraction** — expand into a deep tree of *concrete* leaves
   (every sprite, sound, UI state, sub-component), nothing implicit or hand-waved.
3. **100% coverage** — no inner part silently dropped; re-check the goal against the tree.
4. **Persistence over hours** — a durable store that survives turns / context compaction.
5. **Long-job management** — always know what's done / next / uncovered; never re-litigate settled choices.

## Brainstorm → rank (via the engine at localhost:8787)
Five seeds, each through brainstorm→challenges. Convergence and the winner:
- **Hierarchical Decision Log — rating 85** (the winner's backbone): a single on-disk tree of Task nodes
  with status + *settled* decisions, loaded selectively so settled choices are enforced without burning
  context. → persistence + focus + no-drift.
- **Materialization-first / Concrete Asset Manifest — 70**: a leaf can't be marked done while it's a stub;
  done requires a real, validated artifact. → zero abstraction.
- **Game-Spec-Ontology + completeness validation — 75 / RGCO bidirectional critic — 65**: up-front
  expansion + a critic that compares goal vs tree. → 100% coverage.

Then an **exclusion round** designed away the two killers — *needing a maintained external ontology* and
*user-fatigue from clarifying questions* — yielding the shipped design: the **model itself** expands the
tree from genre/convention at plan time (no static ontology), and intent is **inferred** (no Q&A).

## What was built — the Blueprint (`src/blueprint.mjs` + 5 tools)
A persistent, on-disk hierarchical build tree at `<workdir>/.proov/blueprint.json`:
- **`blueprint_plan {goal, tree}`** — lock the whole build as a NESTED tree of concrete leaves (childless
  node = a real artifact to make; node with children = a group). Persists; re-planning **preserves** prior
  progress by id (settled work is never wiped).
- **`blueprint_status`** — cheap orientation: coverage (done/total leaves, %) + the next uncovered leaves.
- **`blueprint_mark {id, status, evidence, decision}`** — update a node. **Materialization-first gate:** a
  leaf only becomes `done` with `evidence` (a real file/artifact) whose content is **not** a stub — empty,
  `TODO`/`FIXME`/`placeholder`/`not implemented`/`throw …not implemented` is rejected. `decision` records
  settled choices so they're never re-litigated.
- **`blueprint_add {parentId, nodes}`** — graft newly-found inner parts (e.g. after the critic).
- **`blueprint_audit`** — the completeness critic: STRUCTURAL findings (empty groups, done-without-evidence,
  stub/missing evidence) + the goal + tree, so the agent does the SEMANTIC pass and adds anything missing.

`src/agent.mjs` registers all five (both tool maps), adds the read-only ones to FINDING_TOOLS, and carries
a **BUILD BIG, ZERO ABSTRACTION (blueprint-first)** directive: figure out the real goal → plan the whole
tree of concrete leaves → work leaf by leaf marking each done against real evidence → audit before done.
`src/ui.mjs` adds step labels. `selftest.mjs §37` covers it.

## Measured
- selftest: **355 passed, 0 failed** (was 345; +10).
- End-to-end (gemini-2.5-flash, `--auto`): "build a complete catch-the-falling-fruit game." The agent
  called blueprint_plan and laid out **21 concrete leaves** across 5 groups (Game Core, Player, Fruit,
  Visuals, Audio), then ground through them leaf-by-leaf — **25 blueprint tool calls** — reaching
  **21/21 leaves = 100% coverage**, each marked done against real evidence. It even generated separate
  dataURL generators for apple/banana/orange sprites (concrete assets, not placeholders). Result: a real
  12.5 KB `index.html` with **zero stub markers**, a working game loop, WebAudio SFX/music, input handling,
  and all three game states (start / playing / game-over). Every inner part the goal implied — collision,
  lives, both HUDs, both screens, catch/miss/game-over sounds, background music — was covered, none dropped.

## Why it disrupts
Other agents produce a thin demo and lose the small parts as the build grows. The Blueprint turns implicit
intent into an explicit, exhaustive, **durable** checklist, enforces concrete artifacts at every leaf, and
keeps focus across a multi-hour build via on-disk memory + a completeness critic — structuring + memory +
visualization + persistence, the things big-code game/app building actually needs.
