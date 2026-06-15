# Invention Block 19 — Atlas: per-asset extraction & oversight (so a busy picture isn't an averaged blur)

Nineteenth feature — the answer to a real limitation in Block 18: **a whole-image score is too coarse for a
busy picture.** If a target (a city, a UI, a crowded scene) has ~75 assets, one small wrong building averages
out to ~95% similarity and is never caught. The fix: **extract each asset, compare each one separately at high
sensitivity, and keep oversight of the whole composition** — finish only when every asset *and* the whole scene
pass.

## The challenge, decomposed
1. **Extraction** — pull each individual asset out of the reference (and out of your own render) given a box.
2. **Per-asset fidelity** — diff just that asset at high sensitivity, so a small error can't hide.
3. **Composition oversight** — roll up many per-asset scores + a whole-scene score; finish only when all pass.

## Brainstorm → rank (engine at localhost:8787)
- Master (object-detect → per-asset crops → per-asset diff → re-crop rendered scene by the SAME boxes for
  layout oversight): **75**.
- **Facet 8 — the crop+diff mechanic: 90** (the highest-rated piece): two offscreen canvases, `drawImage` the
  bbox onto a new canvas to crop both reference and render, `getImageData` per-pixel diff → score + heatmap.
  Zero-dependency, in-Chrome.
- **Facet 9 — the oversight scorecard: 75**: each asset is a node with a fidelity score; a root "whole-scene"
  node scores layout + the aggregate; **completion requires whole-scene ≥ threshold AND every asset ≥ its
  threshold.** Composes directly with the Blueprint (each asset = a leaf).
- **Facet 10 — strategy: 65**: two phases — layout anchoring (fix positions, re-crop by reference boxes) then
  per-asset fidelity refinement; stability scores prevent oscillation / redoing settled assets.

## What was built — `crop_image` + `compare_regions` (`src/match.mjs`)
Both run **inside the system's headless Chrome** (reuse `eye.mjs`), images embedded as data URLs (same-origin
→ `getImageData` not tainted, zero flags). Boxes are normalized (0–1) or absolute pixels.
- **`crop_image {src, x, y, w, h, out}`** — `drawImage` the bbox onto a new canvas → write a PNG. Pull one
  asset out of a busy reference so you can study (view_image) and recreate (see_asset) it in isolation.
- **`compare_regions {target, render|candidate, regions:[{label,x,y,w,h}]}`** — the granular workhorse: diffs
  EACH asset region of target vs render at high sensitivity AND the whole scene, returns a **worst-first
  per-asset scorecard** + `assetsOff` + `allPass`, and an **annotated composite** (green box = match, red = off)
  the agent SEES. One call = per-asset fidelity + whole-scene oversight.

`src/agent.mjs` registers both (both maps + FINDING_TOOLS) and extends the MATCH directive with a **BUSY
PICTURES WITH MANY ASSETS** section: box each asset (→ a blueprint leaf for oversight), crop_image hard ones
to recreate in isolation, then compare_regions to chase the per-asset REDS, fixing layout first then detail,
not redoing greens, finishing only at `allPass` (every asset ≥90 AND whole ≥90). `src/ui.mjs` adds labels.
`selftest.mjs §39` covers it.

## Measured
- selftest: **368 passed, 0 failed** (was 362; +6).
- **The headline property (deterministic):** a candidate whose RIGHT asset is wrong (red, misplaced) still
  scores **95% whole-image** — looks fine — but `compare_regions` catches it: circle **100%**, square **78%**.
  The selftest asserts exactly this ("catches a wrong asset the whole-image score hides"). This is the failure
  mode whole-image comparison cannot surface.
- `crop_image` extracts a sub-region to a real PNG (verified 144×132 from a 320×240 source).
- End-to-end (gemini-2.5-flash, `--auto`): given a 4-asset "town" reference, the agent recreated it in
  index.html and adopted **`compare_regions` as its verify loop (5 calls)**, getting a per-asset scorecard that
  pinpointed exactly which assets were off (e.g. pond 70%, house 71%, tree 75%, sun 84%) and `allPass:false` —
  actionable per-asset signal instead of one blurry number. (The run was capped before full pixel-convergence;
  hand-coding a 4-asset scene to ≥90 on every asset takes more turns than the cap allowed — the mechanic and
  the agent's adoption of it are what's demonstrated here.)

## Why it disrupts
Whole-image matching reports a confident, wrong "looks ~95% right" on a busy scene. Atlas refuses to average:
it scores each asset on its own crop, names the ones that fail, and keeps oversight of the full composition —
the difference between "approximately a city" and "this city, asset by asset." Composes with the Blueprint
(an asset per leaf), the Asset Studio (build + see each asset), and Match (the whole-scene check).
