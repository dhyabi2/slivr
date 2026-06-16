# Invention Block 4 — `pipeline`: dependency-aware orchestration

Fourth feature from the **brainstorm→rank→build→measure** loop.

## Seed — the gap
proov already had `parallel` (fan out independent sub-agents), but it is **flat**: no dependencies,
sub-agents share the workdir (race risk), and no result is passed between them. Real multi-part work
has order — "design the schema" must finish before "write the model" and "write the migration".

## Brainstorm + rank (fresh, proov-grounded)
A focused re-brainstorm (grounded in proov's *existing* `parallel`, no AST/no extra models) scored far
higher than the original F4 pool (11–25 → up to **90**). Winner:
- **#4 (rating 90)** — a `Pipeline` orchestrator over a declarative manifest of subtasks with explicit
  dependencies: build a DAG, run dependency-met tasks concurrently, pass results forward.

## The winner — `pipeline`
> Subtasks declare `{ id, task, deps:[ids] }`. The orchestrator validates the DAG (rejecting cycles),
> then runs tasks in dependency order — independent ones **concurrently within a wave** — feeding each
> upstream task's **result as context** to its dependents. A **failed dependency cascade-skips** its
> dependents instead of running them on broken inputs.

## Implementation (`src/agent.mjs`)
- `pipelineSubAgents`: Kahn topological cycle check; wave scheduler (run all dependency-met pending
  tasks, up to the concurrency cap); per-task context = its dependencies' summaries/findings; failed
  deps → dependents skipped. Reuses the existing sub-agent runner + `_depth` guard (one level deep).
- Registered as the `pipeline` tool in both tool maps and the system prompt (with guidance on when to
  prefer it over `parallel`).
- `selftest.mjs`: +12 deterministic tests (injectable runner).

## Measured result (deterministic A→{B,C}→D diamond)
| property | result |
|---|---|
| dependency ordering | **3 waves** (A, then B‖C, then D) |
| concurrency within a wave | B and C **overlap** (maxConcurrent ≥ 2) |
| result hand-off | D's prompt contained **both** B's and C's results (flat `parallel` can't do this) |
| cycle / unknown-dep | rejected up front |
| failed-dep cascade | A fails → B, C, D **skipped**; skipped tasks **never executed** |

The win over flat `parallel`: correct ordering, real result hand-off between dependent subtasks, and
no wasted work running dependents on a failed dependency's broken output.
