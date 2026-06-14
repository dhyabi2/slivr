# Invention Block 2 — Progress Sentinel (anti-stall guard)

Second feature from the **brainstorm→rank→build→measure** loop.

## Seed — the real challenge
In the first LiveCodeBench run, slivr *stalled*: it burned its whole step budget making valid tool
calls that went nowhere and produced no result. PR #1 added a guard for non-JSON / unknown-tool calls,
but not for the harder case: **valid tool calls that just repeat** (re-reading the same file, retrying
the same failing edit) — the agent spinning in place.

## Brainstorm + rank (from the 54-idea pool)
The F2 "loop-reliability" cluster scored 56–60. The winning ideas converge:
- **#10 Progress Judge (70)** — a non-LLM arbiter watching for stagnation (repeated identical calls,
  no file change) and forcing recovery.
- **#43 Progress Sentinel (75)** / **#45 Adaptive State-Hinter Guard (75)** — a hash-based history of
  recent (tool, args, outcome); on a detected loop, inject a structured hint, then stop.
- **#11 constrained Tool-Action-Feedback loop (85)** — every step must advance, fall back, or finish.

## The winner — a non-LLM Progress Sentinel
> Track the fingerprint of each tool call (tool + args). If the same call repeats with no new result,
> escalate: a one-time **recovery hint** ("you appear stuck — try a different approach or call done"),
> then a clean **stop** with an explicit reason. Plus a **final-step nudge** so the last step produces
> a usable result instead of silently hitting the cap.

## Implementation (`src/loop.mjs`)
- Fingerprint = `tool|hash(args)`; consecutive repeats counted. Hint at 3×, stop at 5× (`SPIN_HINT`/
  `SPIN_STOP`). Surfaces `stopped: "repeated the same X call N× with no progress"` — never a silent burn.
- Final-step nudge injected on the last allowed step.
- Complements PR #1's non-JSON/unknown-tool guard; varied tool calls are never flagged.
- `selftest.mjs`: +6 tests (stops a spinner, no false positives, hint-before-stop, final nudge).

## Measured result (controlled A/B)
A model that spins on the same call forever:

| | without guard | with progress sentinel |
|---|---|---|
| **steps consumed** | 50 (full budget) | **5** |

**≥80% of steps/tokens saved** on a stuck agent, and it stops with a clear reason instead of an empty
result. In the wild this also caps repair-loop spinning introduced by Block 1 (a weak model repeating
the same wrong fix), so the two blocks reinforce each other.
