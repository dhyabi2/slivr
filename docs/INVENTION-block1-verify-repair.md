# Invention Block 1 — Verify-and-Repair Loop

This is the first feature built with the **brainstorm-with-exclusion invention methodology**: start
from a real weakness, research how the best agents win, brainstorm many "better than that" ideas,
rank them, build the winner as one self-contained block, and **measure** it.

## 1. Seed — the real challenge
While building and benchmarking proov, the standout failure was concrete and measured: on
[LiveCodeBench](https://livecodebench.github.io) problems, proov **could not tell its own solution was
wrong**. It generated code, called `done`, and submitted — blind. It also *stalled*, burning its step
budget on easy problems without producing anything (since fixed separately). The #1 gap: **no
self-verification.**

## 2. Research — why the top agents win
Claude Code (88.6% SWE-bench Verified), Devin, and Codex all share one trait proov lacked: they
**run code, read failures, and iterate**. Cursor adds a repo index; Claude adds sub-agents and dynamic
workflows. (See the landscape table in the PR description.)

## 3. Brainstorm — 54 ideas via the methodology API
Using the `brainstorm-exclusion` API (Gemini Flash), we generated **54 candidate mechanisms** across
six feature gaps (self-verify-repair, loop-reliability, repo-context, orchestration, dynamic-planning,
cost-edit), each with typed challenges and a practicality rating.

## 4. Rank — 3 independent evaluators, weighted rubric
`weighted = impact*3 + feasibility*2 + reliability_cost*2 + novelty*1` (max 80), scored against
proov's real constraints (zero-dependency Node, a cheap small model, the benchmark-proven gaps).

| rank | weighted | idea |
|---|---|---|
| 1 | 61 | Runtime micro-trace → cheap-model **minimal fix** (self-verify-repair) |
| 2 | 60 | Constrained cyclic tool loop that **never stalls** (loop-reliability) |
| 3 | 59 | Targeted repair loop / progress-judge (verify-repair + reliability) |

The top F1 cluster and the top F2 anti-stall idea **converge on one mechanism**, and it closes the #1
proven gap. Losers: parallel-orchestration and AST/fine-tuned-model edit engines (11–25) — they target
a non-gap and/or break the zero-dependency + single-cheap-model constraints.

## 5. The winner — Verify-and-Repair with a progress guard
> When the agent calls `done`, automatically run a verification command. On failure, feed the captured
> failure back and let the model make a targeted repair, looped until it passes or a bounded repair
> budget is hit. **Never finish "green" on a failing verification** — surface the real status.

## 6. Implementation (one block)
- `src/loop.mjs`: a `verify` gate on `done` + bounded `maxRepairs` (the progress guard). Returns
  `verified` / `repairs`; an exhausted budget finishes with an explicit "still failing" status, never a
  silent green. Opt-out (no `verify`) leaves behavior byte-for-byte unchanged.
- `src/agent.mjs`: threads `verify`/`maxRepairs` through `runAgent` and `Session.runTurn`.
- `bin/proov.mjs`: `--verify "<cmd>"` (and `--repair N`) — real users get it for free, e.g.
  `proov "make tests pass" --auto --verify "npm test"`.
- `bench/livecodebench.mjs`: `--repair N` wires the problem tests in as the verification.
- `selftest.mjs`: 8 new tests (repairs once and finishes verified; bounded by maxRepairs; no silent
  green; opt-out unchanged).

## 7. Measured result
Same 7 real `release_v6` AtCoder problems, `google/gemini-2.5-flash`:

| | baseline (one-shot) | verify-and-repair (`--repair 3`) |
|---|---|---|
| **pass@1** | 3/7 = **42.9%** | **6/7 = 85.7%** |

Both *hard* problems and a *medium* one flipped fail→pass. The agent ran its own code, read the
failure, and fixed it. **pass@1 roughly doubled** — the methodology produced a real, measured win.

Next blocks (from the same ranking): loop-reliability progress-judge (#2/#10), then a zero-dependency
repo symbol/call-graph index (#53/#52).
