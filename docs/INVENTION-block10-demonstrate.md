# Invention Block 10 — Demonstrate it (actually show/open the result)

Tenth feature — a direct follow-up to your critique of Block 9: *"you only print the command; my
intention was to actually SHOW the app — open it in the browser."* Block 9's run-hint **told**; this
**shows**.

## The gap (named honestly)
Block 9 guaranteed a `▶ run it with: …` line. But "show me" means *proov* opens it — a browser for a
web app, your terminal for a game. It still required you to copy a command. Three concrete gaps:
1. It **told, didn't show** — no actual launch/open.
2. The detection knew "this is a web page" only to print text, not to `open` it.
3. The intent prompt didn't bias toward a *showable* (browser-openable) artifact when you want to *see*
   something.

## The fix
1. **Intent prompt (`src/agent.mjs`):** when you want to SEE / play / visually interact — especially if
   you mention a browser — prefer a self-contained `index.html` (inline JS/CSS) you can just open,
   unless you asked for a specific language. *A thing you can open beats a thing you must set up.*
2. **Demonstrate (`src/run_hint.mjs` + `src/repl.mjs`):** `detectRunHint` now classifies HOW to launch
   (`open` a web page · `run` a terminal program · `serve` an app). After a build, the REPL offers
   **"open it in your browser now? [Y/n]"** (default yes) and actually does it:
   - **open** → launches the OS default browser (`open` / `xdg-open` / `cmd start`), non-blocking.
   - **run / serve** → hands your terminal to the program (stdio inherited) so you really play/use it;
     Ctrl-C stops it and returns you to proov.

## Tests
- `selftest.mjs`: +5 (kind classification open/run/serve, `launchVerb`, and a pure `openCommand`
  per-platform check — no browser is launched during the suite). Suite 293 → 298, all green (e2e 10/10).

## Measured (your exact scenario, fixed)
"make a simple browser game I can open and play":
```
✓ create index.html                       ← intent prompt → a browser-openable artifact
summary: "…open index.html in any web browser. Click cells to make your moves…"
▶ run the page with:  open index.html
  open it in your browser now? [Y/n]       ← REPL OFFERS, then actually opens it
```

Before: a Python terminal game + a command you had to copy. After: a web app proov builds *and opens
for you*. The engine now demonstrates the result instead of just describing it.
