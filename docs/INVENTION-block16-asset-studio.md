# Invention Block 16 — Asset Studio: generate → SEE → critique → refine (the artist's feedback loop)

Sixteenth feature — the answer to "you fixed movement, but not the visuals." Block 15 let the agent
*drive* a game; it still drew **programmer art**. The reason is the same blind spot, one layer over:
agents emit visual code (sprites, icons, logos, textures) they have **never looked at**. A human artist
draws, *steps back to look*, judges silhouette/proportion/color, and fixes it. proov now does the same.

## The challenge (researched) and the brainstorm
Professional 2D/3D asset creation is hard for agents on several axes — smooth **organic shapes** (not
blocky paths), believable **textures/materials**, **lighting/shading**, **color harmony**, and
**consistency** across a project's art. We brainstormed each via the engine
(`localhost:8787/api/brainstorm`). The decisive constraint surfaced fast: the cheapest, most universal
"eye" is the **headless screenshot already in `eye.mjs`** — and it can capture **SVG** (DOM) and
**Canvas-2D**, but **NOT WebGL/shaders** (headless renders them blank, verified: 197 bytes vs 4733 for
Canvas-2D). So the disruptive move isn't a fancier renderer — it's closing the **see→refine loop** on the
two techniques the eye can actually capture, which together cover the vast majority of game/UI art.

## What was built — `see_asset`
A tool that renders **ONE asset in isolation** and attaches it to the conversation so the agent can look,
then critique and refine:
- **`svg`** — smooth ORGANIC shapes via Bézier paths (crisp, scalable): icons, logos, characters, flora.
- **`canvas`** — procedural TEXTURE + SHADING on a 2D canvas. A `noise(x,y)` / `fbm(x,y,oct)` helper is
  pre-injected so the agent builds natural materials (wood, stone, clouds, skin), gradients, and lighting
  without reinventing noise. Draw code runs as `(ctx, W, H) => { ... }`.
- **`html`** — arbitrary markup fallback.

```
see_asset {svg:"<svg …>…</svg>"}            → rendered PNG attached, agent LOOKS
see_asset {canvas:"…draw code…", width, height, bg}
```

The loop the agent is told to run (ASSET STUDIO prompt directive): **generate → see_asset → critique
against the target (silhouette, proportion, color harmony, contrast, shading, project-consistency) →
refine → repeat**, then inline the final art into the game/page.

## Why this disrupts
No other coding agent *looks at the art it makes*. Verification-by-seeing is exactly what turns
"programmer art" into something intentional — the same insight as Block 15 (drive what you build) applied
to visuals. WebGL is honestly excluded (and the tool says so) rather than silently shipping blank frames.

## Implementation
- `src/asset.mjs`: `renderAsset(spec)` — writes a temp HTML wrapper (`htmlFor`, with `NOISE_LIB` injected
  for canvas), screenshots it via `eye.mjs`'s `renderShot`, returns a PNG dataURL. Zero new deps.
- `src/tools.mjs`: the `see_asset` tool (returns a multimodal image, or a clear error noting WebGL isn't
  capturable headless).
- `src/agent.mjs`: registered in both tool maps + a FINDING_TOOLS entry + the ASSET STUDIO directive.
- `src/ui.mjs`: `describeStep` label (`see_asset svg|canvas|html`).
- `selftest.mjs` §36: SVG + Canvas-2D renders assert **non-blank** PNGs; spec-required errors.

## Measured
- selftest: **345 passed, 0 failed** (was 340).
- End-to-end (gemini-2.5-flash, `--auto`): asked for an organic maple-leaf SVG. The agent called
  `see_asset` **7×** — drafting, looking, critiquing, and refining the Bézier silhouette before saving
  `leaf.svg`. Final artifact re-renders to a 2227-byte (non-blank) PNG. 16 turns, ~100k tok, ~$0.037.
- WebGL exclusion verified empirically (blank headless capture) — the loop targets SVG + Canvas-2D only.
