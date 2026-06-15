# Block 27 — Edit reliability + Web verification (catch broken pages) + AGPL-3.0

Three fixes from real usage in one shipment.

## 1. Why "edit_file always failing" — and the fix
Empirically reproduced the common failure modes. The critical one: **models paste anchors that still carry
LINE-NUMBER PREFIXES** (`42  code`, `42:\tcode`, `42 | code`) from a numbered file view — which then never
match the real source → `ANCHOR_NOT_FOUND`. The other: **ambiguous anchors in big HTML/game files** (a line
like `ctx.fillStyle="#111";` appears many times) → `EDIT_AMBIGUOUS` dead-ends.

`src/seal.mjs` (correctness-first preserved):
- **Tier 2.5 — de-line:** if EVERY non-empty anchor line is line-number-prefixed, strip the prefixes and
  retry once. Still must be UNIQUE to apply (no fuzzy guessing), so wrong-location edits remain impossible.
  Conservative: it never strips legitimate leading numbers in real code (every line must match the pattern).
  Applied edits are tagged `…+delined` for traceability.
- **`occurrence: N`** (1-based): when an anchor is ambiguous, the model can keep it and pick the Nth match
  instead of having to craft a unique context anchor. The ambiguous repair packet now advertises this option
  alongside the verbatim nearby spans.

## 2. Why a JS-broken game shipped "looking fine" — and the fix
Reported: `Uncaught SyntaxError: Unexpected token 'else' / '}'`, the page rendered only a background colour,
nothing displayed, and the agent declared done. Root cause: a JS **SyntaxError leaves the DOM structurally
intact** (the `<canvas>` tag is still present), so `--dump-dom` and a screenshot look fine — and **console
errors were never captured**. The agent had no signal that the script never ran.

`src/webcheck.mjs` + `see_page` now run two cheap, zero-dep checks and surface errors FIRST:
- **Static syntax check** — `node --check` on every inline `<script>` and every LOCAL `.js` the page loads
  (remote CDN srcs skipped; ES-module syntax checked as a module). Catches `Unexpected token` with the exact
  `file:line`, no browser needed.
- **Runtime console capture** — inject a `window` error/unhandledrejection listener into a TEMP copy (never
  edits the user's file) and read captured errors back via `--dump-dom`. Catches runtime errors too.
- `see_page` returns `broken: true` + an `errors` list + a directive note; a **VISUAL CHECK** prompt rule
  says NEVER call done on a page `see_page` reports broken or blank.

## 3. License → AGPL-3.0
`LICENSE` replaced with the canonical GNU AGPL-3.0 text; `package.json` → `"AGPL-3.0-or-later"`; README
updated. slivr is now free and open source under the AGPL.

## Measured
- selftest: **449 passed, 0 failed** (was 438; +11).
- Edit: line-number-prefixed anchors (tab/space/colon/pipe + multi-line) now apply; real code numbers are NOT
  stripped; `occurrence:2` targets the 2nd match; ambiguous still rejected (correctness) but now offers
  `occurrence`.
- Web: `nodeCheckCode` catches a syntax error with a line; `checkPageJs` flags the broken `game.js` with
  `game.js:N` + "Unexpected token"; `see_page` on the reported failure returns `broken:true` with the
  SyntaxError surfaced (the exact bug, now caught before done); a clean page is not flagged.
- End-to-end smoke: a deliberately-broken game (`game.js` with an `else` brace error) → `see_page` →
  `broken:true`, `["JS SYNTAX — game.js:10: SyntaxError: Unexpected token '}'", "CONSOLE — Script error."]`.

## Why these matter
The edit engine now recovers the biggest "always failing" classes instead of dead-ending, and a web build can
no longer pass verification while silently broken — closing the "it rendered, assumed working, but only a
colour showed" gap that shipped a dead page.
