# Invention Block 14 — house_style: match the repo's conventions

Fourteenth feature — gap #2 of the existing-codebase work. When adding/editing code, proov wrote in
its OWN default style (spaces, semicolons, camelCase) instead of the repo's, producing diffs reviewers
reject. Now it matches the house style.

## Brainstorm (12 ideas, avg 83.6; strong consensus)
A **confidence-based style detector that checks config first** (`.editorconfig`, prettier), then samples
existing files to infer indent / quotes / semicolons / naming — feeding a compact "house style" brief
into the agent. Zero LLM, zero dependencies.

## Built
- `src/style.mjs`: `detectStyle(dir)` — **config-first** (`.editorconfig` indent, prettier
  quotes/semi/tabs are authoritative), then **heuristic** sampling of source files counting indent
  (tab vs space + 2/4), quotes (single vs double), semicolons, and naming (camelCase vs snake_case via
  the symbol extractor). Returns confidence-scored fields. `styleBrief(s)` → one compact line.
- `src/agent.mjs`: the brief is **auto-injected** into the agent's system prompt
  (`HOUSE STYLE (match the existing repo …): …`), so it matches from the first edit — plus an EDIT
  PROTOCOL directive ("new code must be indistinguishable from the surrounding code").
- `src/tools.mjs`: `house_style` tool for on-demand detail.
- `selftest.mjs`: +8 (detects two opposite styles; `.editorconfig`/prettier override; brief format;
  empty repo → no brief; tool + prompt wiring). Suite 325 → 333 (fixed a semicolon-counting bug found
  by the tests).

## Measured (end-to-end)
A repo with a deliberately distinctive style — **tabs · single quotes · no semicolons · snake_case** —
detected exactly. Asked proov to add a function:
```
function multiply_nums(a, b) {
	return a * b
}
```
✓ tabs · ✓ no semicolons · ✓ snake_case — matches the repo. Without the injected brief, gemini-2.5-flash
defaults to spaces/semicolons/camelCase; with it, the new code is indistinguishable from the existing
code. This closes the last named gap in "working with an existing codebase."
