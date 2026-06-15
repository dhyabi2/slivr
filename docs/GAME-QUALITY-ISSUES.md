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
