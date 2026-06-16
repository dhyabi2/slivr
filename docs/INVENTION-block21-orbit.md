# Invention Block 21 — Orbit: real 3D (camera + landscape + 360° sight) and outer-world discovery

Twenty-first feature — two challenges at once. **(1)** Most agents ship "3D" games that are actually a flat,
single fixed view: no camera rig, no terrain, no depth — because they never SEE the scene from more than one
angle. **(2)** No agent uses a reference picture + an LLM to DISCOVER the world *outside* the frame and build
it. proov now does both: it drives a real 3D scene's camera around many angles and SEES each view (WebGL is
finally capturable headless), and it grows a traversable world map out from the reference tile.

## The WebGL unlock (the blocker that made this possible)
Block 16 found WebGL renders BLANK in headless screenshots. That was a flags+capture problem, now solved:
with the **SwiftShader ANGLE backend** (`--use-angle=swiftshader`, GPU *not* disabled) and capturing the
page's own canvas via **`canvas.toDataURL()`** (renderer made with `preserveDrawingBuffer:true`) read back
through `--dump-dom`, WebGL renders correctly (verified: a drawn triangle's pixels come back red-on-green).
`src/eye.mjs` gains `renderDomGL` for this path.

## Brainstorm → rank (engine at localhost:8787)
- **Challenge 1 — Visual 3D Verification Loop: 85**: build terrain + objects at varying depths + a camera
  rig, drive the camera through a path, capture a SEQUENCE of views, and verify true 3D (parallax,
  occlusion, depth) by how the views change; refine if flat. → the orbit tool.
- **Challenge 2 — World Inference Graph: 65**: the multimodal LLM reads the reference for "edge-exits"
  (what continues past each border) and "implied features" (haze → mountains beyond), generates connected
  style-consistent regions, re-analyses each for ITS edges, growing an explorable map. (Its assumed diffusion
  image-generator is dropped — proov generates tiles *procedurally* in the Block-20 style anchor.)

## What was built
**Orbit (Challenge 1) — `orbit_scene` (`src/scene3d.mjs`):** a 3D scene exposes a deterministic camera
contract `window.proovView = { setCamera({yaw,pitch,dist,target}), render() }` (renderer with
`preserveDrawingBuffer:true`). `orbit_scene {path}` injects a driver that polls for the contract (so async
Three.js-from-CDN scenes are handled), drives the camera through N angles, captures each via WebGL
`toDataURL`, assembles a **contact sheet** the agent LOOKS at, and reports **`responds`** — whether the view
actually changes as the camera orbits. A flat billboard that ignores the camera (adjDiff ~0) is caught and
NOT shipped; a missing contract reports `NO_VIEW_CONTRACT`.

**World discovery (Challenge 2) — `world_map` (`src/world.mjs`):** the reference is the ORIGIN tile of a grid
map; the agent infers neighbouring regions from the picture + game idea and records them (`seed` / `add`
{fromId, direction n/s/e/w/…} / `tile` {id, file, styleScore}). `world_map {show}` renders a compass map +
coverage (regions / tiled / style-pass) as spatial oversight. Each region is built as a style-consistent
tile (verify with `style_check`, Block 20) — one picture grown into a coherent, traversable world.

`src/agent.mjs` registers both (both maps + FINDING_TOOLS) and adds **BUILDING REAL 3D** (camera rig +
terrain + the view contract + verify with orbit_scene) and **DISCOVER THE OUTER WORLD** (edge-exits/implied
features → world_map → style-checked tiles) directives. `src/ui.mjs` adds labels. `selftest.mjs §41`.

## Measured
- selftest: **386 passed, 0 failed** (was 376; +10) — incl. live WebGL orbit (real 3D detected), flat-
  billboard rejection, missing-contract reporting, and world_map seed/add/tile/compass.
- WebGL capture: a software-rendered triangle's pixels read back correctly (red triangle on green clear).
- **Real Three.js validation:** a CDN Three.js scene (displaced-plane terrain, 3 boxes at different depths,
  orbit camera) → `orbit_scene` captured **5 views, responds=true**, contact sheet generated.
- Flat scene that ignores the camera → **responds=false** (caught). Missing contract → `NO_VIEW_CONTRACT`.
- End-to-end (gemini-2.5-flash, `--auto`): asked to build a Three.js terrain+camera scene and verify, the
  agent used `orbit_scene` as its verify loop **12×**; its scene had a duplicate-`import` bug so the module
  never set the contract, and orbit_scene correctly **refused to pass it** (`NO_VIEW_CONTRACT`) every time —
  i.e. it never green-lit a broken/flat 3D scene, which is exactly the guarantee. (The agent's code bug is
  orthogonal to the tool; the tool's job is to catch precisely that, and it did.)

## Why it disrupts
"3D" from other agents is a still frame. proov builds a real camera rig + landscape and *proves* the world is
3D by orbiting it and seeing parallax/occlusion — and refuses to ship a billboard. And instead of reproducing
one frame, it treats the picture as the origin of a whole map and discovers the world beyond every edge.
Composes with the Asset Studio (see each asset), Match/Atlas (fidelity), and Beyond the Frame (style anchor).
