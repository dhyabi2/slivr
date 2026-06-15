# Invention Block 25 — Continuity & Anti-Stuck: resume between sessions, escape failing loops

Twenty-fifth feature — two related failures of an agent knowing its own state. **(1)** Coding agents lose
their place between sessions: open a new window and there's no clarity on what was done or where to continue.
**(2)** They get stuck in loops — re-issuing a call that keeps failing the same way instead of fixing the
root cause. Both came straight from real usage (the second from a log of `blueprint_mark … STUB_EVIDENCE`
repeating ~10×).

## Brainstorm → rank (engine at localhost:8787)
- **Continuity — 85** ("Contextual Activity Ledger"): persist a session journal + handoff; on startup,
  reconstruct "what's done / in progress / next" from the blueprint + world map + git + the last handoff.
- **Anti-stuck — 85**: (a) make the failure ACTIONABLE — a stub rejection returns the exact file:line +
  marker so the agent fixes the spot; (b) a "Failure Fingerprint" sliding window detects the same tool
  failing the same way across a recent window (even with different args / interleaved successes) and stops.

## What was built

### Challenge 2 — anti-stuck (the active bug)
- **Actionable stub errors** (`src/blueprint.mjs` `findStub`): instead of a boolean, it returns
  `{line, col, snippet, marker}`. `blueprint_mark`'s `STUB_EVIDENCE` now returns `at: "index.html:42"`, the
  `marker`, the offending `snippet`, and a hint that says *edit that line, then mark* — and notes that many
  leaves can share one file so one stray marker blocks them all (the exact root cause in the log).
- **Failure-fingerprint sentinel** (`src/loop.mjs`): a sliding window over recent FAILURES keyed by
  `tool|errorCode` (args ignored). The old spin-stop needed *consecutive identical* calls, so alternating
  `blueprint_mark 5.2` / `6.1` (both `STUB_EVIDENCE`) with edits between never tripped it. Now both collapse
  to `blueprint_mark|STUB_EVIDENCE`; at 3 occurrences it issues a strong hint (including the actionable
  error detail) telling the agent to fix the root cause or mark the node "blocked", and at 7 it stops
  cleanly — instead of looping forever. A success clears the hint latch.

### Challenge 1 — session continuity
- **Journal** (`src/journal.mjs`): `appendJournal` writes a dated handoff (`task / did / files / next`) to
  `.slivr/journal.md` at the end of every run (one-shot AND each REPL turn). `resumeSummary` reconstructs a
  "where you left off" briefing from the persisted blueprint (coverage + next uncovered leaves) + world map
  + git state (uncommitted files, last commit) + the last journal handoff.
- **`resume` tool + auto-orientation**: the agent can call `resume` to orient itself; the REPL prints a
  `↩ resuming` briefing on startup when prior state exists; a **CONTINUITY** prompt directive tells the
  agent to `resume` first and continue from the NEXT items, not redo finished work. A **DON'T GET STUCK**
  directive tells it to read the error and fix the root cause, never re-issue a failing call.

## Measured
- selftest: **430 passed, 0 failed** (was 420; +10).
- **Anti-stuck (reproduces the bug):** a loop that alternates two failing `mark` calls (different args) with
  successful reads between — the exact shape from the log — is now caught and **stopped** (`kept failing
  with STUB_EVIDENCE`), in well under 30 turns, after a strong hint. The old consecutive-spin check missed it.
- **Actionable error:** `blueprint_mark` on a file with a stray `<!-- TODO -->` now returns `at: index.html:2`,
  `marker: TODO`, and the snippet — the agent can fix the exact line.
- **Continuity (end-to-end):** after a one-shot run, `.slivr/journal.md` holds the handoff, and a new
  session's `resume` reconstructs "Last session … / Blueprint X/Y done / next: … / Git: N uncommitted".

## Why it disrupts
Other agents start every session blind and thrash on a failing step until they exhaust the budget. slivr
hands itself a briefing on open (resume), records a handoff on close (journal), turns a dead-end failure into
a file:line fix, and detects the *non-identical* stuck loop that simple repeat-detectors miss — so it picks
up where it left off and gets unstuck instead of spinning.
