# Invention Block 11 — `see_page`: the agent's eye (text-first, cheapest)

Eleventh feature — seeded by user feedback: *"when the page opened there are bugs (literal `\n`
shown). Give the agent an eye, and with cheap cost view the screen, then loop: edit and retest."*

## Discovery (this time done right — the engine chose the approach)
I almost built my own guess (always screenshot). Instead, the brainstorm engine explored the **space**
of "eyes" and surfaced a better, cheaper answer. The winning cluster (r85): a **text-first** pipeline —
render headlessly but read the rendered DOM/text as PLAIN TEXT (no vision-token cost), screenshot only
when layout matters.

Ranked outcome:
- **Winner:** system Chrome `--dump-dom` (rendered DOM as text) + `--screenshot` as a second tier.
  Cheapest (text, not an image, catches the literal-`\n` bug directly), zero-dependency (system
  browser), works across cases.
- **Rejected:** `jsdom` ideas — add a dependency *and* don't do real CSS layout; accessibility-tree +
  bounding-box ideas — need Playwright/CDP (heavier, costlier).

Validated before building: `--dump-dom` on a buggy page exposed the literal `\n` in the rendered text;
`--screenshot` produced a PNG.

## The winner — `see_page`
> `see_page {path}` (default, cheap): render the page with the system browser headless and return the
> post-JS **visible text** — catches a literal `\n` on screen, a blank page, wrong/garbled text — with
> **no vision-token cost**. `see_page {path, visual:true}`: a **screenshot** attached to the multimodal
> model when you need to judge layout. The agent loops: see → fix → see, until it reads right.

## Implementation
- `src/eye.mjs`: `findBrowser` (Chrome/Chromium/Edge; `CHROME_PATH` override; `npx playwright`
  fallback), `renderDom` (`--dump-dom`), `renderShot` (`--screenshot`), `visibleText` (strip tags,
  **preserve newlines** so the `\n` bug is visible). Zero dependencies.
- `src/tools.mjs`: the `see_page` tool — text by default, image when `visual:true` (reuses the existing
  multimodal image path). Graceful errors when no browser is installed.
- `src/agent.mjs`: registered + a VISUAL-CHECK directive ("after building a page, see_page it; don't
  claim it works without looking").
- `selftest.mjs`: +7 (pure arg/visibleText checks + a REAL render that exposes the `\n` bug; skipped
  cleanly if no browser). Suite 303 → 310, all green (e2e 10/10).

## Measured (the user's exact bug)
Seeded `index.html` whose JS sets `textContent = "You won!\nGuesses: 3…"` (the `\n` shows literally).
Asked slivr to check + fix it:
```
✓ see_page index.html        ← the EYE: read the rendered text, saw the literal \n
✓ edit index.html            ← fix
✓ see_page index.html        ← look again (loop)
…
final: uses innerHTML + <br>  ← bug fixed; lines render as real breaks
```
The agent now **looks at what it built** and fixes what it sees — cheaply (text-first), with a
screenshot tier for layout.
