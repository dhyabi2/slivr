# Invention Block 24 — Live Progress: always know what the agent is doing, and why

Twenty-fourth feature — a cross-cutting UX gap in every coding agent: poor progress output. Users can't tell
what the agent is doing right now, *why* it's doing it, what each step actually accomplished, or how slow a
step was. slivr now narrates its work clearly: the reasoning (the WHY), a live "doing X…" line before a slow
tool, and a SEMANTIC one-line summary of each result — not a wall of raw tool dumps.

## The challenge, decomposed
1. **Live activity** — a slow tool (tests, screenshot, fetch) shouldn't look frozen.
2. **The WHY** — surface the agent's brief reasoning, not just the action.
3. **Semantic results** — "edited foo.js +12 -3", "exit 0", "92% match" — not raw output.
4. **Graceful off-TTY** — clean plain lines when piped / in CI (no cursor escapes).

## Brainstorm → rank (engine at localhost:8787)
- Master "two-region overlay" — **85**.
- **Live status line — 90** (the highest piece): a "● doing X …" line with elapsed time shown BEFORE a tool
  runs, then OVERWRITTEN in place on a TTY with a "✓ X  summary · 1.2s" committed line; off a TTY it degrades
  to plain committed lines (no cursor tricks). (The brainstorm's fork-a-child-process for animation was
  dropped — overkill; print-running-then-commit covers the need without a worker.)
- **Semantic result summaries — 75**: a per-tool formatter — edits → +adds/-dels, run_command → exit/pass,
  search → hit count, compare → % match — never hiding an error.
- **Progress orientation — 85**: surface the WHY + group under the current task/plan; elapsed + turns/cost.

## What was built
- **`src/ui.mjs`** (pure, testable):
  - `summarizeResult({tool,args,result,diff,diffs})` — a SEMANTIC one-line summary per tool (edits, run,
    grep, read, see_page, compare_image/regions, style_check, orbit_scene, play_game/play_levels, blueprint_*,
    web_*, git_*, …). Errors are always surfaced.
  - `reasoningLine` (dim "› why"), `runningLine` ("● action …"), `committedLine` ("✓ action  summary · 1.2s",
    elapsed shown only for steps ≥ 0.8s), `fmtElapsed`.
  - `makeLiveRenderer({out, palette, isTTY, getSummary, afterCommit, getStatus})` — owns the line lifecycle:
    print the WHY + a running line before the tool, then OVERWRITE it in place on commit (`\x1b[1A\x1b[2K`);
    off-TTY it just prints the committed line. Returns `{onToolStart, onStep}`.
- **`src/loop.mjs`**: `reasoningProse(text)` pulls the note before the JSON; the loop now times each tool and
  calls an optional `onToolStart({tool,args,reasoning})` before it runs, passing `elapsedMs` + `reasoning` to
  `onStep`. All optional/guarded — existing callers unaffected.
- **`bin/slivr.mjs`** (one-shot) and **`src/repl.mjs`** (interactive) both wire `makeLiveRenderer` (replacing
  their scattered, duplicated `extra`-string logic) so the experience is identical and consistent.

## Measured
- selftest: **420 passed, 0 failed** (was 404; +16) — reasoningProse extraction, fmtElapsed, ~10
  summarizeResult cases (incl. error-never-hidden), the line builders, and the renderer lifecycle in both
  TTY (emits the in-place overwrite sequence) and non-TTY (plain lines, no ANSI) modes.
- Live run ("create calc.js, run it, grep it") now prints:
  ```
    › I will create the calc.js file with the add function, then execute it …
    ✓ create calc.js  +5 -0
    ✓ run `node calc.js`  exit 0
    ✓ grep function in calc.js  1 hits
  ```
  The WHY, semantic summaries, and (on a TTY) a live running line + per-step elapsed — instead of silence or
  raw dumps.

## Why it disrupts
Most agents leave the user guessing — a frozen-looking pause, then a wall of raw output. slivr tells you, at a
glance and honestly: what it's doing, why, what each step produced, and how long it took — on a TTY with a
live in-place status line, and degrading cleanly to readable lines in logs/CI.
