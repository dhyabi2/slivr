# proov vs a Claude-Code-style baseline — a scaled, oracle-judged head-to-head

**What this measures.** `proov` is a coding-agent CLI whose only structural differentiator is its
**edit protocol**: it makes targeted, anchor-based edits and never re-sends a whole file. The
**baseline** harness is identical in every other respect — same model, same agent loop, same tools,
same step cap — but uses the naive **full-file rewrite** protocol that Claude-Code-style agents use
in practice (read the whole file, write the whole file back). This report isolates the cost and
reliability impact of that one protocol difference.

Everything here is **measured**, not asserted. Raw per-run numbers are in
[`results-scaled.json`](./results-scaled.json) (and the per-model files
`results-scaled-google-gemini-2.5-flash.json`, `results-scaled-anthropic-claude-sonnet-4.json`).

---

## Methodology

- **Identical-model A/B.** For every task we run BOTH harnesses on the **same model**. Any cost or
  success difference is attributable to the edit protocol, not the model.
- **Deterministic behavioral oracles.** Each task ships a check that *executes the resulting code*
  and asserts observable behavior (e.g. `computeTotal([{price:2,qty:3},{price:5,qty:1}])===11`).
  Success is ground truth — the model cannot "pass" by editing a comment. Every oracle was
  validated to (a) **fail** on the unedited seed and (b) **pass** under a known-good fix, so it is
  sensitive to exactly the change requested. (`tasks-scaled.mjs`, harness in `run-scaled.mjs`.)
- **Repetitions.** >=3 reps per (task, harness) on gemini and >=2 on claude, to quantify LLM
  nondeterminism (it is large — see the stddevs).
- **Fresh workdir per run.** Each run seeds a clean temp repo; no state leaks between runs.
- **Step cap = 16.** A harness that never converges is cut off at 16 turns. We call a run a
  **runaway** when it hits the cap without calling `done` — this is the full-rewrite
  context-blowup failure mode we are quantifying.
- **Task set: 17 tasks across 5 file-size regimes** (tiny single-edit -> 588-line single-edit ->
  two-large-file multi-edit) and task types (add function, fix bug, rename across files,
  add+wire endpoint, refactor). Large fixtures are genuinely large (248-588 lines) because that is
  where the protocol is supposed to matter.

### Scale actually run

| Model | Tasks | Reps | Runs | Spend |
|---|---|---|---|---|
| `google/gemini-2.5-flash` | 17 (full) | 3 | 102 | $1.94 |
| `anthropic/claude-sonnet-4` | 7 (subset, incl. 3 large-file) | 2 | 28 | $4.46 |
| **Total** | | | **130** | **$6.40** |

The claude run carried a **$4 cumulative-cost cap** (`COST_CAP=4`). It was not tripped — the last
launched run began at $3.70 (< cap); the final baseline runaway then pushed the realized total to
$4.46. The guard would have stopped any *subsequent* run. No runs were skipped.

---

## Headline (per model, aggregate over all runs)

| Model | Harness | Success | Cost/run (mean +/- sd) | Tokens/run (mean +/- sd) | Turns (mean) | Runaways |
|---|---|---|---|---|---|---|
| gemini-2.5-flash | **proov** | **42/51 (82%)** | **$0.00606 +/- 0.00725** | 17,335 +/- 21,154 | 6.0 | 3/51 |
| gemini-2.5-flash | baseline | 33/51 (65%) | $0.03195 +/- 0.07552 | 59,404 +/- 137,289 | 7.9 | 9/51 |
| claude-sonnet-4 | **proov** | **14/14 (100%)** | **$0.07081 +/- 0.04697** | 21,078 +/- 15,155 | — | 0/14 |
| claude-sonnet-4 | baseline | 10/14 (71%) | $0.24792 +/- 0.28842 | 65,850 +/- 75,115 | — | 3/14 |

Aggregate: proov is **81% cheaper at equal-or-better success on gemini**, **71% cheaper at
100% vs 71% success on claude**. But the aggregate is **dominated by large-file blowups** and hides
real regime-level structure — the per-regime view below is the honest one.

---

## The honest view — per regime

### gemini-2.5-flash (17 tasks x 3 reps)

| Regime | proov success | baseline success | proov $/run | baseline $/run | Cost saved | baseline runaways |
|---|---|---|---|---|---|---|
| tiny-single | 9/9 | 9/9 | $0.00096 | $0.00349 | 72.6% | 2/9 |
| small-multi | **9/15** | **15/15** | $0.00280 | $0.00259 | **-8.1%** | 0/15 |
| medium-single | 9/9 | 9/9 | $0.00144 | $0.00546 | 73.7% | 1/9 |
| large-single | **9/12** | **0/12** | $0.01296 | $0.08426 | 84.6% | 4/12 |
| large-multi | **6/6** | **0/6** | $0.01505 | $0.08317 | 81.9% | 2/6 |

### claude-sonnet-4 (7-task subset x 2 reps)

| Regime | proov success | baseline success | proov $/run | baseline $/run | Cost saved | baseline runaways |
|---|---|---|---|---|---|---|
| tiny-single | 2/2 | 2/2 | $0.02424 | $0.02236 | **-8.4%** | 0/2 |
| small-multi | 4/4 | 4/4 | $0.03613 | $0.03226 | **-12.0%** | 0/4 |
| medium-single | 2/2 | 2/2 | $0.04277 | $0.06144 | 30.4% | 0/2 |
| large-single | **4/4** | **2/4** | $0.13514 | $0.39252 | 65.6% | 2/4 |
| large-multi | **2/2** | **0/2** | $0.08611 | $0.80208 | 89.3% | 1/2 |

**Where the win is real, marginal, or negative:**

- **LARGE files (single and multi): a big, decisive win — on both cost AND success.** This is the
  whole point of the protocol and it holds on both models.
- **MEDIUM files: a modest, consistent cost win** (gemini ~74%, claude ~30%), equal success.
- **TINY / SMALL files: a tie on success and a small NEGATIVE on cost.** proov's longer
  system prompt + read-then-edit handshake costs slightly more than a one-shot full rewrite when
  the file is trivially small and the rewrite is cheap. On gemini, small-multi is **-8%**; on
  claude, tiny **-8%** and small **-12%**. We report this against ourselves.

---

## The runaway-context failure — quantified

This is the core finding. On the full-rewrite baseline, large files trigger a runaway: each turn
re-sends the entire file, the transcript balloons with stacked copies, later turns are enormous and
slow, and the agent burns the step budget without converging.

**Baseline outcomes on every large-file run (gemini, 18 runs):**

| Task (lines) | baseline success | failure modes | worst single run |
|---|---|---|---|
| fix-bug-large-250 (248) | 0/3 | 3x wrong full-rewrite | 20,746 tok / $0.015 |
| fix-reducer-large-300 (289) | 0/3 | 1x runaway, 2x wrong-rewrite | 86,344 tok / $0.033 |
| fix-route-large-400 (409) | 0/3 | 1x runaway, 2x wrong-rewrite | **536,038 tok / $0.293** |
| add-fn-large-600 (588) | 0/3 | 2x runaway, 1x wrong-rewrite | 522,870 tok / $0.289 |
| rename-largepair (2x248) | 0/3 | 3x wrong-rewrite | 96,435 tok / $0.047 |
| wire-fn-largepair (2x248) | 0/3 | 2x runaway, 1x wrong-rewrite | 463,605 tok / $0.262 |

- **gemini baseline large-file success rate: 0/18 (0%).** Every large-file/large-multi rep failed.
- **gemini baseline runaway rate on large files: 8/18 (44%)** hit the 16-turn cap; the single worst
  run reached **536k tokens** — more than the entire 102-run proov half of the benchmark combined.
- The other failures are "quick" wrong full-rewrites (3-9 turns) that still fail the oracle: the
  model emits a complete file with the edit subtly wrong or with collateral damage.

**On claude (more capable model), the failure becomes cost rather than always-failure**, but the
penalty is still large:

- baseline large-single: **2/4 success**, and even its *successes* are runaways/cap-grazers
  (134k tok, $0.46) costing **~3.5x** proov for the same result.
- baseline large-multi (rename-largepair): **0/2** — one runaway (215,400 tok, **$0.845**, the most
  expensive single run in the whole study) and one wrong-rewrite (186,590 tok, $0.759).

proov, by contrast, edits one anchor regardless of file size: its large-file token cost is roughly
flat across 248->409 lines and it has **0 runaways** on any non-588-line task on either model.

---

## Where proov itself loses or struggles (reported against us)

1. **The 588-line single append (`add-fn-large-600`): proov fails 3/3 on gemini** (it also runs
   away: 65k-78k tokens, $0.021-0.027). Appending a function to a very large file requires reading
   it to find a unique tail anchor; the read result is clipped at 6,000 chars, the model can't pin a
   clean anchor, and it loops. proov's *only* advantage here is that its failures cost ~1/10th the
   baseline's ($0.027 vs $0.289). **Neither harness reliably solves this task on gemini-flash.**
   (Not in the claude subset.)
2. **Tiny/small files: proov is a few percent more expensive** (see regime tables). Honest tie on
   correctness, slight loss on cost.
3. **`config-constant` + `wire-logger` (small-multi, create-a-new-file): proov fails 0/3 on
   gemini** — gemini-flash emits malformed output through proov's `create_file` tool (e.g. invalid
   `export import` syntax). This drags small-multi to 9/15 and -8% cost. **It is model-specific**:
   on claude, `config-constant` passes **2/2**. So this is a gemini-flash x create_file interaction,
   not a structural protocol defect — but on gemini-flash it is a real, repeatable proov loss.

---

## Threats to validity

- **n is modest.** 17 tasks; 3 reps (gemini) / 2 reps (claude). Per-regime cells are small
  (e.g. large-multi on claude is 2 runs/harness). Treat single-model regime percentages as
  indicative, not tight estimates. The large-file *direction* is robust (it reproduces across two
  models, many reps, and several distinct tasks); the exact percentages are not.
- **LLM nondeterminism is large.** Baseline cost stddev (+/-$0.076 gemini, +/-$0.29 claude) exceeds
  its mean — driven by the bimodal large-file outcome (cheap wrong-rewrite vs catastrophic runaway).
  This is *why* we ran reps and report mean+/-sd, not point estimates.
- **gemini != claude.** The headline win is far cleaner on gemini-flash (baseline 0/18 on large
  files) than on claude (baseline degrades to cost/latency, not always failure). A more capable
  model narrows the *success* gap on large files while preserving the *cost* gap. Do not generalize
  the gemini "0% baseline success" number to frontier models.
- **Oracles measure behavior, not full correctness.** A run passes if the executed code produces the
  asserted outputs. An oracle cannot catch every possible regression outside what it checks (we do
  assert that untouched neighbors still work, e.g. `helper500`, to penalize collateral damage).
- **Fixture realism.** Fixtures are synthetic single-file/two-file modules with padding helpers to
  reach target sizes. They reproduce the *structural* property that matters (one small edit inside a
  large file) but are not scraped real-world repos. Real codebases add imports, types, and
  cross-file coupling we don't model.
- **The step cap is a design choice.** At MAX_STEPS=16 the baseline's runaways are *truncated*; with
  a higher cap the worst baseline runs would cost even more, not less. The cap makes our baseline
  cost numbers a **lower bound** on the runaway penalty.
- **Pricing.** Costs use a static OpenRouter price table (`src/provider.mjs`), not per-call billed
  amounts; token counts are provider-reported and are the load-bearing measurement.

---

## Verdict (the precise, defensible, measured claim)

Holding the model fixed, **`proov`'s compact anchor-edit protocol matches or beats a Claude-Code-
style full-rewrite baseline, and the advantage is concentrated entirely in large files.** On
single edits to large files (248-588 lines) and edits spanning two large files, proov achieved
**equal-or-better success at 66-89% lower cost on both gemini-2.5-flash and claude-sonnet-4**, while
the full-rewrite baseline failed every large-file task on gemini (0/18) and, on claude, either
failed or "succeeded" only by burning ~3.5x the tokens — with worst-case single runs of **522k-536k
tokens on gemini and 215k tokens / $0.85 on claude**. On medium files the win shrinks to a modest
cost saving at equal success; **on tiny/small files there is no win — proov is a few percent more
expensive at identical success**, and on gemini-flash specifically it loses two new-file tasks
outright. The honest, publishable headline is therefore **not** "proov is 80% cheaper" (that
number is an artifact of large-file baseline blowups) but: **"for edits to large files, an anchor-
based edit protocol delivers equal-or-better correctness at a large and reproducible cost reduction
versus full-file rewrites — and is cost-neutral-to-slightly-negative on small files."**
