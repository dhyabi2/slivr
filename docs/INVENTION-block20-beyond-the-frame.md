# Invention Block 20 — Beyond the Frame: the picture is a baseline; build the bigger world, in style

Twentieth feature — the answer to "the reference picture is only a window into a larger world." A game needs
far more than one frame shows: off-screen areas, other levels, enemies, items, menus, weather, day/night,
win/lose screens — all implied by the GAME IDEA, none of it in the picture. Blocks 18–19 made slivr faithful
to *what's shown*; this makes it **extrapolate what isn't** — and verify the invented content is consistent
with the picture's world even though there's nothing in the reference to diff it against.

## The challenge, decomposed
1. **Style baseline** — derive the picture's visual identity (palette, tone) cheaply and deterministically.
2. **Verify the invented** — an asset *not* in the picture can't be pixel-diffed; score its STYLE-consistency.
3. **Plan both** — in the build tree, distinguish leaves SHOWN in the picture (verify by fidelity) from leaves
   EXTRAPOLATED beyond the frame (verify by style), and keep oversight that both sets are complete.

## Brainstorm → rank (engine at localhost:8787)
- Master (style baseline + parse game idea → world requirements; verify off-frame by coherence not diff): **65**
  — but over-reached into trained "style-coherence evaluators." The facets stripped that out:
- **Facet 11 — deterministic style baseline: 85**: a fixed 3D RGB histogram (no nondeterministic clustering)
  → dominant palette; HSL averages for brightness/saturation; stddev of lightness for contrast. In-Chrome.
- **Facet 12 — verify an invented asset: 85**: a quantitative palette-adherence score (each asset colour's
  nearest anchor colour) PLUS a composite (asset beside the anchor palette) the multimodal eye judges as
  "same world?" — explicitly noting a general LMM is *not* a "trained model" in the prohibited sense.
- **Facet 13 — plan/oversight: 75**: tag each leaf PICTURED vs EXTRAPOLATED; PICTURED → fidelity diff,
  EXTRAPOLATED → style check; a coherence report tracking completeness of both sets.

## What was built — `style_profile` + `style_check` + blueprint `origin` (`src/match.mjs`, `src/blueprint.mjs`)
- **`style_profile {target}`** — extract the style anchor (dominant palette + brightness/saturation/contrast)
  from the reference and persist it to `.slivr/style-anchor.json`. Deterministic, in-Chrome, zero deps.
- **`style_check {candidate|render, target?}`** — verify an INVENTED asset against the anchor: a 0–100
  **adherence** score (palette 70% + tone 30%) with per-metric deltas, plus a composite (the asset beside the
  anchor palette + its own palette) the agent LOOKS at to judge fit. Anchor from the persisted file or a
  `target` profiled on the fly. The verifiable signal for things *not* in the picture.
- **Blueprint `origin`** — leaves carry `origin:"pictured"` (verify with compare_regions) or `origin:"world"`
  (verify with style_check); coverage breaks down `byOrigin`, the tree shows ◈pic / ✦world tags. So oversight
  spans both the faithful-to-picture parts AND the invented world.

`src/agent.mjs` registers both tools (both maps + FINDING_TOOLS) and adds a **THE PICTURE IS A BASELINE, NOT
THE WHOLE GAME** directive: style_profile the reference once → blueprint_plan the FULL world tagging pictured
vs world → build pictured to match (compare_regions) and invent world parts in the same style (style_check,
rework < ~85) → finish only when both are complete and coherent. `src/ui.mjs` adds labels. `selftest.mjs §40`.

## Measured
- selftest: **376 passed, 0 failed** (was 368; +8).
- Style engine (deterministic): from an earthy/sky reference, an in-style invented asset scores **96%**
  adherence; an off-style neon asset scores **69%** — clear, deterministic separation. Asserted in selftest.
- End-to-end (gemini-2.5-flash, `--auto`): given a daytime-town reference "as a baseline for a bigger game,"
  the agent locked the style anchor (palette `#d0eaf9 #7bc96a #d94b3b #3a7bd5 #ffd23f #2e8b3d`), planned the
  full game with **6 `pictured` leaves** (sun/house/pond/tree/sky/grass) **+ 5 `world` leaves** (player,
  enemy, coin, score, health — none in the frame), reached **11/11 = 100%**, and verified invented assets with
  **style_check (4 calls)**. The finished game — invented enemy/coin/HUD included — independently scores **96%
  adherence** (palette 100, tone 87) to the picture-derived anchor: the extrapolated world stayed in the
  picture's family.

## Why it disrupts
Other agents stop at the frame — they reproduce the screenshot and call it a game. slivr treats the picture as
a style + world *baseline*, extrapolates everything the game idea needs beyond it, and verifies the invented
content is coherent with the original world — a deterministic adherence score plus an eye check — so the result
is a whole game in one consistent style, not a single static frame. Composes with the Blueprint (pictured vs
world leaves), the Asset Studio (build + see each invented asset), Match and Atlas (fidelity for what's shown).
