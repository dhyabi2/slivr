# Game & asset quality — known issue catalogs

Two audited catalogs of 100 issues each that cause poor AI-generated game quality, with concrete
fixes. They drive proov's visual/quality blocks (Asset Studio, art_review, artkit, Orbit, Levels).

- ASSET-QUALITY-100: shape/silhouette, colour/palette, shading/lighting, texture/material,
  detail/resolution, composition, animation, consistency/style, backgrounds, process/verification.
- GAME-SYSTEMS-100: texture & materials, 360°/camera/3D, levels & world, and other gaming
  elements (physics, collision, audio, input, UI/HUD, AI, game-feel, state).

proov already closes several of these: art_review (rate visuals, catch flat art), artkit (draw shaded/
textured/outlined art → richness ~80 vs ~25), see_asset (look at one asset), compare_image/regions
(fidelity), orbit_scene (real 3D camera, skybox check), play_levels (distinct, playable), autoplay
(real-input ground truth). The remaining items are the roadmap for future blocks.

See the full enumerated lists in the project notes; each item has a title, why-it-hurts, and a one-line fix.

## VERIFICATION-100: why completion-verification is weak (and lets "boxes" pass)

A third audited catalog of 100 issues — why an agent's COMPLETION check passes a flat-boxes "Super
Mario": semantic/intent fidelity (no request↔output diff; richness≠correctness; "responds"≠"plays like
Mario"; no gap list), the vision/"eye" judge (weak model, vague prose, no rubric, no reference, leading
prompts), no ground truth (no reference image/exemplar/genre checklist), metric blind spots (richness
rewards any blob; autoplay rewards any motion; no character-vs-box classifier), gameplay completeness
(levels/win/lose/score/enemies/collisions/physics), asset/character correctness (no face/proportion/
identity check), judge rigor (creator self-judges; no adversarial critic), gate design (one-shot pushback;
low thresholds; optional checks), process (no generate→critique→regenerate loop to a target score), and
measurement (no quantified "X% matches", no enumerated missing elements, no scorecard).

proov now closes the worst of these: ADVANCED/complete is the DEFAULT (the user never says "super");
the done-gate verifies a game actually PLAYS (autoplay, real input) AND isn't flat boxes (canvas
art_review < 18 → pushed back) before accepting done.

It also closes the SEMANTIC-FIDELITY gap with a vision CHECKLIST (Block 37): a strong vision model
(gemini-3.5-flash) derives a yes/no punch-list of the concrete things THIS request requires — a
recognizable character (not a box), enemies, collectibles, HUD, textured ground, themed background, the
genre's iconic elements — then answers present:yes/no for each by LOOKING at the rendered canvas. The
game is verified ONLY when every item is "yes"; any "no" becomes the punch-list fed back to the agent.
A checklist beats a single fuzzy score: it forces a commit per requirement and tells the user exactly
WHICH thing is missing, not just "looks ~35% right".

## BLOCK 38 — the 3D blind spot + the PRODUCTION-STRUCTURE MODEL

Observed: a generated "3D Super Mario" (game6) was ~2% of a production game — one stacked-primitive
character, one cube, a SPHERE "coin", flat #00ff00 plane, black-void sky, no enemies/HUD/levels/textures,
saturated primaries — and the agent declared it "verified". Two root causes:

1. THE GATE NEVER FIRED. `detectGameFile` required a literal `<canvas>` tag, but a Three.js game creates
   its canvas dynamically (`renderer.domElement` → appendChild) so the source has none. Every 3D/WebGL
   game silently skipped ALL verification — exactly the hardest class to get right. Fixed: the trigger now
   also accepts a WebGL/Three.js page (`isWebGLPage`, the same signal the renderer uses).

2. NO STRUCTURE MODEL. The quality bar was prose wishes with nothing measuring them, so the agent planned
   and shipped a skeleton. Fixed with `src/structure.mjs` — a typed, genre-keyed SCENE-GRAPH CONTRACT of
   ~18 nodes across 10 layers (ENVIRONMENT, CHARACTER, ENEMIES, COLLECTIBLES, STRUCTURE, CAMERA, HUD,
   LEVELS, MATERIALS, JUICE). Each node has a deterministic STATIC code signal (+ anti-patterns: a black
   "sky", a sphere "coin", all-primary palette hard-zero the node) and a vision question. `analyzeStructure`
   scores the built game; an egregious skeleton (whole required layers empty) is pushed back at done with
   the concrete missing-list. game6 scores ~21% (FAIL, 6 empty layers, sphere-coin flagged); a real game
   scores 90%+. The taxonomy is also in the system prompt so the agent PLANS against it.

The done-gate is now four channels, cheap→expensive: see_page (not broken) → autoplay (responds to real
input) → art_review (not flat boxes) → STRUCTURE (production scene-graph, deterministic, offline) → VISION
checklist (semantic fidelity to the request, all-yes = verified). Static + vision cross-check so neither
token-stuffing nor pretty-but-wrong passes. Remaining roadmap: a genre reference exemplar and a bounded
generate→checklist→regenerate loop until all-yes.
