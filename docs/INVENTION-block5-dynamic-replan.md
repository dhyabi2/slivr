# Invention Block 5 — Dynamic re-planning on failure (`replan`)

Fifth feature from the **brainstorm→rank→build→measure** loop.

## Seed — the gap
slivr's `plan` was a static list, approved once. When a step failed, the agent had no first-class way
to **adapt** — it either forced the now-wrong plan or abandoned it. Top agents (Claude Dynamic
Workflows) treat the plan as a living artifact that re-plans when reality diverges.

## Brainstorm + rank (fresh, slivr-grounded)
Re-brainstormed against slivr's *existing* `plan` tool (not a rebuild). Winner:
- **#8 (rating 85)** — upgrade the plan to a living artifact with per-step status; on failure, trigger
  a **localized** re-plan of the remaining steps instead of re-prompting for a whole new plan.

## The winner — a `replan` tool + a failure-triggered nudge
> The plan becomes a living artifact (`steps`, `revisions`, `history`). A new **`replan`** tool revises
> the REMAINING steps with a reason, keeping a revision history. The agent loop watches for failures:
> when a tool fails **and a plan exists**, it nudges the agent (once per failure streak) to `replan`
> rather than blindly executing a plan that no longer fits.

## Implementation
- `src/tools.mjs`: `replan_tool({reason, steps})` — revises the plan, increments `revisions`, records
  `history` (reason + replaced steps); errors with `NO_PLAN` if there's nothing to revise.
- `src/loop.mjs`: on a failed tool result **with a plan present**, inject a one-time-per-streak
  re-plan nudge (reset on the next success, so each new failure streak gets exactly one). Does NOT
  fire when the agent never planned — no false triggers.
- `src/agent.mjs`: `replan` registered in both tool maps + system prompt.
- `selftest.mjs`: +7 deterministic tests.

## Measured result (deterministic)
| behavior | result |
|---|---|
| `replan` with no plan | rejected (`NO_PLAN`) |
| `replan` revises remaining steps | ✓ steps replaced, `revisions`+1, reason + old steps in `history` |
| failure **with** a plan | loop injects exactly one "call replan" nudge → agent revises → finishes |
| failure **without** a plan | **no** nudge (no false trigger) |

Composes with the earlier blocks: a step failure now both triggers Block 1's verify-repair (for
verification failures) and Block 5's plan adaptation (for plan-level divergence), while Block 2's
sentinel still caps any spinning that results.
