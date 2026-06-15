# Game & asset quality — known issue catalogs

Two audited catalogs of 100 issues each that cause poor AI-generated game quality, with concrete
fixes. They drive slivr's visual/quality blocks (Asset Studio, art_review, artkit, Orbit, Levels).

- ASSET-QUALITY-100: shape/silhouette, colour/palette, shading/lighting, texture/material,
  detail/resolution, composition, animation, consistency/style, backgrounds, process/verification.
- GAME-SYSTEMS-100: texture & materials, 360°/camera/3D, levels & world, and other gaming
  elements (physics, collision, audio, input, UI/HUD, AI, game-feel, state).

slivr already closes several of these: art_review (rate visuals, catch flat art), artkit (draw shaded/
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

slivr now closes the worst of these: ADVANCED/complete is the DEFAULT (the user never says "super");
the done-gate verifies a game actually PLAYS (autoplay, real input) AND isn't flat boxes (canvas
art_review < 18 → pushed back) before accepting done.

It also closes the SEMANTIC-FIDELITY gap with a vision CHECKLIST (Block 37): a strong vision model
(gemini-3.5-flash) derives a yes/no punch-list of the concrete things THIS request requires — a
recognizable character (not a box), enemies, collectibles, HUD, textured ground, themed background, the
genre's iconic elements — then answers present:yes/no for each by LOOKING at the rendered canvas. The
game is verified ONLY when every item is "yes"; any "no" becomes the punch-list fed back to the agent.
A checklist beats a single fuzzy score: it forces a commit per requirement and tells the user exactly
WHICH thing is missing, not just "looks ~35% right". Remaining roadmap: a reference exemplar per genre
and a bounded generate→checklist→regenerate loop until all-yes.
