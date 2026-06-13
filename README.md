# cc-alt — a configurable-LLM Claude Code alternative

`cc-alt` is a real CLI coding agent: it explores a repo, makes edits, runs checks, and stops when
the task is verifiably done — driven by **any** model you plug in behind a `MODEL` env var
(default `google/gemini-2.5-flash`, also tested with `anthropic/claude-sonnet-4`), over OpenRouter.

It exists to test ONE claim at the **harness level** (not model-vs-model, not model-building):

> Swap *only* the edit/context protocol — keep the same model, tools, and loop — and a
> **compact anchor-based edit protocol** matches task success at **lower session cost** than the
> naive **full-file rewrite** protocol that Claude-Code-style harnesses use. The win grows with
> file size and multi-edit sessions.

```
node bin/agent.mjs "add input validation to add/sub/mul in src/calc.js" ./myrepo
node bin/agent.mjs "...same task..." ./myrepo --baseline     # the Claude-Code-style harness
MODEL=anthropic/claude-sonnet-4 node bin/agent.mjs "..." ./myrepo
```

## The two harnesses (only one thing differs)
| | cc-alt | baseline (Claude-Code-style) |
|---|---|---|
| model | configurable (same) | configurable (same) |
| tools | read_file, list_dir, grep, run_command (same) | same |
| loop | one JSON tool-call/turn (same) | same |
| **edit protocol** | **compact**: `{anchor, replacement, op}` via SEAL; failure → small repair packet | **naive**: re-read whole file → `write_file` ENTIRE new content |

The compact applier (`src/seal.mjs`) is **vendored read-only** from
`better-cc-fresh/src/seal.mjs` (attributed in-file). It only applies on a UNIQUE exact/normalized
match, rejects ambiguous anchors, and on a miss returns a compact **repair packet** (nearest real
spans + a fix instruction) — it never re-sends the file. That compact-edit protocol is the entire
harness-level advantage under test.

## Measured head-to-head (REAL numbers, ground-truth oracles)

Each task is seeded into a fresh repo; both harnesses run on the SAME model; a behavioral oracle
executes the resulting code and asserts observable behavior (exit 0 == success). Raw rows in
`bench/results.json`.

### `google/gemini-2.5-flash` — full suite (8 tasks)

| harness | success | total tokens | total cost | total turns | edit failures |
|---|---|---|---|---|---|
| **cc-alt** | **7/8** | **27,406** | **$0.01126** | 35 | 0 |
| baseline | 7/8 | 580,322 | $0.31099 | 82 | 0 |

**Equal success (7/8 each) at 96.4% lower total cost** on the same model. Cost saved by file-size
regime: large-single **99.3%**, small-single **66.4%**, small-multi **56.5%**, medium-single 5.1%.

Each harness failed exactly one task, for opposite reasons that illustrate the thesis:
- **baseline** failed `fix-bug-largefile`: full-rewriting the 246-line file every turn ran away to
  521k tokens, hit the step cap, and never converged — the runaway-context failure mode.
- **cc-alt** failed `config-constant`: the model emitted **syntactically invalid code**
  (`export import {...}`) — a *model* error, not a harness one (cc-alt made the edits cleanly in 3
  turns with 0 edit failures). An earlier version of cc-alt failed this task with 15 edit failures
  because it lacked a file-creation tool; adding `create_file` fixed that harness gap (the remaining
  failure is purely the model writing bad JS).

Per-task rows are in `bench/results.json`.

### `anthropic/claude-sonnet-4` — small-file subset (3 tasks, budget-limited)

| harness | success | total tokens | total cost | total turns |
|---|---|---|---|---|
| cc-alt | 3/3 | 22,834 | $0.09227 | 22 |
| baseline | 3/3 | 22,589 | $0.09304 | 24 |

Deliberately run on only the **small** tasks (no large-file blowup) to cap spend. Result: a **tie**
— both 3/3, cost within **0.8%**. This is the honest flip side: **on small files the compact-edit
advantage is negligible** regardless of model. The big cost win is a large-file / multi-edit
phenomenon, not a universal one. (Raw: `bench/results-sonnet-small.json`.)

### The headline: large file, single bug fix (`fix-bug-largefile`, 246-line module)
| harness | success | tokens | cost | turns |
|---|---|---|---|---|
| **cc-alt** | **PASS** | 5,912 | **$0.00201** | 3 |
| baseline | FAIL | 521,859 | $0.28859 | 16 (hit cap) |

On a large file the baseline doesn't just cost more — it **derails**: re-reading and re-writing the
whole 246-line file every turn burned **521k tokens**, hit the step cap, cost ~**$0.29**, and still
failed the oracle. cc-alt read once, made one targeted edit, verified, and finished: **99.3%
cheaper AND higher success**. This is the clearest expression of the thesis.

### Where the win is marginal or NEGATIVE (honest)
On a **tiny single-edit file** (`fix-offbyone`, 7 lines) cc-alt was **~73% MORE expensive**
(4,344 vs 2,163 tokens) — both passed. A full rewrite of a 7-line file is trivially cheap, while
the compact protocol pays overhead (verbose anchors, an extra exploration turn). **The advantage
is conditional on file size / edit locality.** It pays off on large files and multi-edit sessions
where the baseline keeps re-sending large file bodies; it is a net cost *loss* on tiny files.

## The precise sense in which it's a better Claude Code alternative
Same model, same capability — **equal-or-better task success at dramatically lower session cost on
large-file and multi-edit work**, because it never re-sends whole files to make a change and recovers
from failed edits via a compact structured packet instead of re-showing the file. On small files the
edge disappears or reverses, so the honest pitch is: *cheaper where it matters (big files, long
sessions), neutral-to-slightly-worse on trivial edits.*

## Honest limits
- **Small n** (8 tasks), and the LLM is nondeterministic — numbers are directional, not p-values.
- The cost win is **conditional**: large/locality-friendly edits win big; tiny single edits lose.
- A failing baseline run that hits the step cap inflates its token/cost numbers — that *is* a real
  harness failure mode of full rewrites (runaway context), but it makes aggregate "X% cheaper"
  sensitive to how many baseline runs blow up. Per-task rows (in `results.json`) are the honest view.
- The applier is correctness-first but JS/code-shaped; it is not a general semantic refactor engine.

## Layout
- `src/provider.mjs` `src/tools.mjs` `src/loop.mjs` `src/agent.mjs` `src/baseline.mjs` `src/seal.mjs` (vendored)
- `bin/agent.mjs` — CLI · `demo.mjs` — live side-by-side on one fixture · `selftest.mjs` — deterministic (no LLM)
- `bench/tasks.mjs` `bench/run.mjs` `bench/results.json` · `SPEC.md`

## Run it
```
node selftest.mjs                                   # deterministic, no API key
MODEL=google/gemini-2.5-flash node demo.mjs         # live side-by-side (needs OPENROUTER_API_KEY)
MODEL=google/gemini-2.5-flash node bench/run.mjs     # full head-to-head
CCALT_TASKS=fix-bug-largefile node bench/run.mjs     # one task
```
Reads `OPENROUTER_API_KEY` from `web/.env.local` if not in the environment.
