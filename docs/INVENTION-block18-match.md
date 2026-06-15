# Invention Block 18 — Match: recreate a reference picture, verified in plan and execution

Eighteenth feature — the answer to "agents can't build a game/scene that actually LOOKS LIKE a target
picture." They produce something loosely related, never a faithful match, because they never *measure*
the rendered result against the reference. slivr now closes that loop: read the picture into a plan, build
it, then **diff the render against the target** and refine the worst regions until it matches.

## The challenge, decomposed
1. **Ingest the picture** — turn a reference image into a concrete, buildable element list (no heavy 3D).
2. **Quantitative fidelity** — a cheap, deterministic way to score render-vs-target + locate *where* they
   differ, so the agent knows what to fix.
3. **Plan-and-execute verification** — the plan must cover every element in the picture *before* building,
   and execution must be measured against the target and refined, never declaring done on a poor match.

## Brainstorm → rank (engine at localhost:8787)
- Master (render → compare → actionable feedback → refine): **75**, but over-reached into 3D scene graphs.
- **Facet 5 — the diff engine: 75** — load target + render into canvases in headless Chrome, compute a
  deterministic pixel diff (score + per-region heatmap), hand the heatmap to the multimodal eye for "what's
  wrong where." Zero-dep, reuses the eye.
- **Facet 7 — plan-and-execute loop: 75** — verify the plan covers every picture element, then render →
  perceptual diff → targeted fix → repeat, with a **hard stop on non-convergence**.
- Facet 6 (image → spec): the *light* form — the existing vision model reads the picture into elements +
  palette + style → feeds `blueprint_plan` (Block 17).
- **Exclusion round** removed the two killers — *heavy 3D reconstruction/material inference* and *training
  custom vision/diffusion models* — leaving a lightweight design that reuses what slivr already has.

## What was built — `compare_image` (`src/match.mjs`)
A diff that runs **inside the system's headless Chrome** (reuses `eye.mjs`); both images are embedded as
data URLs (same-origin → `getImageData` is not tainted, no special Chrome flags):
- **`compare_image {target, render}`** — screenshots the page and diffs it against the reference; or
  **`{target, candidate}`** to diff two existing images.
- Returns a deterministic **similarity 0–100**, the **worst-matching regions** (top-left / middle / …
  with a per-region score), and **ONE composite image — target | yours | heatmap (red = mismatch)** —
  attached for the agent's eye.
- `target` may live outside the workdir (a reference the user named); it's read-only.

`src/agent.mjs` registers it (both tool maps + FINDING_TOOLS) and carries a **MATCH A REFERENCE PICTURE**
directive: view_image the target → blueprint_plan a leaf per visible element (plan verification) → build →
`compare_image` → fix the worst regions → re-compare until similarity is high (≥90), never declaring a
visual match done on a low score, changing approach if it stops converging. `src/ui.mjs` adds the label.
`selftest.mjs §38` covers it.

## Measured
- selftest: **362 passed, 0 failed** (was 355; +7).
- Diff engine sanity: identical images → **100%** (mae 0); very different → **40%** with the worst regions
  correctly located; close always scores strictly higher than far.
- End-to-end (gemini-2.5-flash, `--auto`): given a reference scene (sky gradient, green ground, sun, player
  block), "recreate it in index.html and verify with compare_image until ≥85." The agent ran the compare
  loop **4×**, refining to **92% similarity** (independently re-verified: 92%, mae 20) in 10 turns — a
  faithful, *measured* match, not an approximation.

## Why it disrupts
Other agents eyeball a reference and approximate it. slivr turns the picture into a covered plan and then
holds its own output up against the target — a deterministic score plus a heatmap the model reads — and
refines the exact regions that are off. Composes with the Blueprint (plan a leaf per element) and the Asset
Studio (build each sprite, look at it): plan it, build it, prove it matches.
