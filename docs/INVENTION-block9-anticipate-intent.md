# Invention Block 9 — Anticipate intent (Intent Brief + guaranteed run-hint)

Ninth feature — seeded directly by user feedback: *"I told it to make a simple game, it made it but
never showed it to me. Understand what I actually want."*

## Seed — the psychology of intent
A request is underspecified. "make a simple game" doesn't mean "write files" — it means *I want to
play it*. The agent did the literal task and missed the implied goal. Reproduced exactly:

```
BASELINE: 'make a simple number guessing game I can play'
  ✓ create number_guessing_game.py
  ✗ run `python number_guessing_game.py`  exit 1      ← it failed…
  summary: "…The game is ready to be played interactively."   ← …but it claimed success,
                                                                and never said HOW to play it.
```

## Brainstorm + rank (fresh round on this seed)
Top idea (r85): a **Reflective Intent Expansion** with an archetype awareness of common
underspecified requests (build→runnable, fix→verify, optimize→measure). The others converge on:
infer the true goal + unstated success criteria up front, deliver against them, self-check at the end.

## The winner — two parts (prompt asks, mechanism guarantees)
1. **Intent Brief (`src/agent.mjs` prompt):** before working, infer the user's real end-goal and
   UNSTATED success criteria and deliver against *that*. Archetypes: build/make → it must RUN; actually
   run it, fix what breaks, and tell the user the exact launch command; fix → reproduce + verify;
   optimize → measure before/after; add feature → wire it in + a way to exercise it. Before `done`,
   self-check, and **never claim success on a command that failed**.
2. **Guaranteed run-hint (`src/run_hint.mjs`):** a prompt can ASK; this GUARANTEES. After any turn that
   CREATED a runnable artifact, slivr deterministically prints `▶ run it with: <cmd>` — detected from
   what was created (Node start script, `.html` → open, Python `__main__`, Go/Rust/Make/shell). Based
   only on files created this turn, so unrelated edits never produce a misleading hint.

Also in this release: **Tab now cycles the mode mid-turn** (flip to `[auto]` while the agent is working
to stop being asked) — announced clearly, and ignored only while an approval prompt owns stdin.

## Implementation + tests
- `src/agent.mjs`: the UNDERSTAND-INTENT system-prompt section. `src/run_hint.mjs`: `detectRunHint` /
  `runHintLine`. `src/repl.mjs` + `bin/slivr.mjs`: track created files per turn → print the hint; Tab
  mid-turn fix. `selftest.mjs`: +5 run-hint tests (python/node/html/none/format). Suite 288 → 293.
- `bench/livecodebench.mjs`: failure classification + a total-cost readout (added while wiring the
  Opus run).

## Measured result (the user's exact scenario)
| | baseline | with Block 9 |
|---|---|---|
| told how to run/play it | ✗ (no command) | ✓ summary explains it **+** guaranteed `▶ run it with: python3 …` |
| claimed success on a failed run | ✗ yes (exit 1 ignored) | ✗ no — it builds + tests until it works |
| effort | 3 turns, blind | 7 turns, intent-stated + verified |

The deterministic `▶ run it with:` line is the key: the user is **always** told how to see/use what was
built, regardless of whether the model remembers to say so.
