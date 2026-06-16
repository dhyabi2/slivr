# Invention Block 8 — Resilient tool-call parser + draft-first (think AND act in one turn)

Eighth feature — the first block seeded by a **fresh failure found by running the upgraded agent at
scale**, exactly as the brainstorm→rank→build→measure loop intends.

## Seed — a NEW challenge, found by measurement
Running the full release_v6 set (85 real LiveCodeBench problems) with everything through Block 7:

```
pass@1: 68/85 = 80.0%   (verify-repair on; was 43% at the start of this work)
failures: 15 no_solution + 2 wrong_answer  ·  13 hard, 4 medium
→ 15 of 17 failures were "no_solution": the agent produced NO runnable solution at all.
```

Tracing one (`abc396_c`, medium) revealed the mechanism — not algorithmic difficulty, but the
**protocol fighting the model**:

```
plan → task_write → BADCALL → task_write → BADCALL → BADCALL → … → create_file → done
first BADCALL = "The problem asks us to select a subset… Constraints: N,M ≤ 2×10^5…"
```

proov demanded "respond with EXACTLY ONE JSON object, nothing else." On hard problems the cheap model
(gemini-2.5-flash) keeps emitting **pure reasoning prose with no JSON tool call** — each a wasted
`BADCALL` turn — burning its step budget before it ever commits a `solution.py`. The old parser made
it worse: it only tried the **first** `{…}` in the message, so reasoning containing stray braces
(`the set {1,2,3}, so {"tool":…}`) parsed the wrong block and dropped the real tool call.

## Brainstorm + rank (fresh round on this seed)
Top ideas (r85): a **Resilient Tool-Call Parser** (#2/#6) that extracts the call even when wrapped in
prose, and a `thought` scratchpad (#3). Synthesis: let the model **think AND act in one turn**.

## The winner
> 1. **Resilient parser** (`src/loop.mjs`): scan EVERY balanced `{…}` and return the first that parses
>    AND has a `tool` key (falling back to the first valid object). Reasoning prose + stray braces no
>    longer waste the turn.
> 2. **Prompt** (`src/agent.mjs`): explicitly allow a short reasoning prefix before the single JSON
>    tool call, and a **DRAFT-FIRST** directive — commit a simple, complete, runnable solution early
>    (even brute-force), then improve; never spend all your steps planning.

## Implementation + tests
- `src/loop.mjs`: `balancedEnd()` + a rewritten `extractJSON()` (resilient, backward-compatible with
  the existing malformed-output robustness tests).
- `src/agent.mjs`: prompt changes (reasoning-allowed + draft-first).
- `bench/livecodebench.mjs`: failure **classification** (no_solution / runtime_error / wrong_answer /
  timeout) + a failure-pattern summary — the instrument that surfaced this seed.
- `selftest.mjs`: +4 tests (extracts a tool call past leading prose + stray braces; pure prose still
  flagged; recovers next turn). Suite 284 → 288, all green (e2e 9/9).

## Measured result
Re-running the **15 problems that produced no solution** in the full run, now with Block 8:

| outcome | count |
|---|---|
| **recovered to a full PASS** (were no_solution) | **4 / 15** — all HARD (abc388_g, abc391_g, abc398_d, abc399_f) |
| now produce **runnable code** (no_solution → runtime_error) | 2 more |
| → went from "nothing" to "a runnable solution" | **6 / 15 (40%)** |

On the hardest tier — where the agent previously gave up entirely — it now commits runnable code, and
over a quarter of those dead problems are now fully correct. (Caveat: a cheap model is stochastic, so
treat single-run deltas as directional; the mechanism is also proven deterministically in the parser
unit tests.) Directionally this lifts the full-set pass@1 from 80% toward ~85%.
