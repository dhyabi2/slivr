# The invention behind proov

proov is a coding-agent CLI in your terminal. The model it runs on is configurable
and swappable — Claude, GPT, Gemini, anything on OpenRouter. So proov itself is **not a model**
and makes **no claim to be smarter** than Claude Code. The invention is in the *harness* — and it
is one specific, measured thing.

## The one-line invention

> **A correctness-first compact-edit protocol that lets a coding agent change code without ever
> re-sending whole files** — making edits dramatically cheaper *and* structurally safer, on any
> model.

Everything else in proov (REPL, config, safety, git tools) is ordinary harness plumbing. The
*invention* is how it edits.

## The problem it solves

Coding agents change code in one of two ways today, and both are bad in a specific way:

1. **Full-file rewrite** (what a naive/"Claude-Code-style" harness does): to change one line, the
   agent reads the whole file into context and writes the whole file back. Cost scales with
   **file size × number of edits**, not with the size of the change. On a large file this is
   catastrophic: in our benchmark a baseline harness fixing one bug in a 246-line file **ran away
   to 521,000 tokens, hit the step cap, cost $0.29, and still failed** — re-emitting a big file
   every turn is not just expensive, it's a *failure mode* (the model loses the thread).

2. **Naive search-and-replace** (what most "apply this edit" tools do): match an anchor string and
   replace it. The hidden danger is **silent wrong edits** — applying the change to the *wrong*
   place and reporting success:
   - first-occurrence replace corrupts the wrong duplicate,
   - an anchor that also appears in a comment edits the comment,
   - a fuzzy/token-similarity match splices onto a span that merely shares tokens.
   A wrong edit that says "ok" is worse than an honest failure, because it's invisible.

proov's edit protocol is designed to beat *both* problems at once.

## The mechanism (the actual invention)

An edit is a compact instruction, not a file: `{ path, anchor, replacement, op }`. The agent sends
only the **small unique snippet** it wants to change and the new text — never the whole file.

The applier (`src/seal.mjs`) is **correctness-first**, applying in strict tiers:

1. **Unique exact match.** Apply only if the anchor occurs **exactly once**. (0 occurrences →
   fall through; **>1 → refuse** and ask for a larger, unique anchor.) This single rule kills the
   first-occurrence and comment-collision corruption bugs: a duplicate or comment-shadowed anchor
   is *ambiguous*, so it is never silently applied.
2. **Unique normalized match.** If there's no exact hit, compare under a **sound, string-safe
   canonical form** that ignores whitespace and operator-spacing (`this.n+1` ≡ `this.n + 1`) but
   **preserves string contents and word boundaries** (so `"a+b"` is never conflated with `"a + b"`,
   and `return x` never becomes `returnx`). Apply only if **unique**.
3. **No fuzzy auto-apply.** A merely-similar span is **never** spliced. Instead the applier returns
   a structured **repair packet**.

The **repair packet** is the other half of the invention. On a miss, instead of dumping the whole
file back, the applier returns a *compact* object: the top-K nearest real spans actually present in
the file (with line numbers + a similarity score), a small diff of "what you wrote vs the nearest
real code," and a "copy verbatim, don't paraphrase" instruction. The model fixes its anchor from a
few lines — **not by re-reading the whole file**. That keeps even the *failure* path cheap.

Finally, **`edit_files`** applies many such edits **atomically** (all-or-nothing) across one or many
files in a single call: every edit is validated to apply uniquely first; if any fails, **nothing is
written** and per-edit repair packets come back. Multi-file changes cost a few turns instead of many.

## Why it's better (measured — scaled, oracle-judged, same model both sides)

From a **130-run** head-to-head (17 tasks × 5 file-size regimes × reps, $6.40 spend, same model
both arms so the difference is the *protocol*, not the model). Full numbers + raw data in
[`bench/REPORT.md`](bench/REPORT.md). Aggregate: proov is **81% cheaper at 82% vs 65% success on
gemini-2.5-flash**, **71% cheaper at 100% vs 71% on claude-sonnet-4** — but the aggregate is *inflated
by large-file blowups*, so the **per-regime view is the honest one:**

| regime | cost saved vs full-rewrite baseline | success (proov vs baseline) |
|---|---|---|
| **large single-edit** | **65–85% cheaper** | **decisive** — baseline **0/12** (gemini), 2/4 (claude) vs proov 9/12, 4/4 |
| **large multi-file** | **82–89% cheaper** | **decisive** — baseline **0/6** (gemini), 0/2 (claude) vs proov 6/6, 2/2 |
| medium | 30–74% cheaper | tie |
| tiny single-edit | model-dependent: 73% cheaper (gemini) … **−8% (claude)** | tie |
| **small multi-file** | **−8% to −12% (proov costlier)** | **proov can LOSE** — 9/15 vs 15/15 on gemini-flash |

**The core finding — reliability, not just cost:** on large files the full-rewrite baseline
**failed 0/18 runs on gemini** (44% hit the turn cap in a token *runaway* — worst single run
**536,038 tokens**), and degraded badly on claude too. Re-emitting a big file every turn isn't a
cost tax, it's a *failure mode*; the anchor protocol simply doesn't have it.

**Honest losses (reported against us):** on **small/tiny files there's no win** — a full rewrite of a
small file is already cheap, so proov is cost-neutral-to-slightly-*negative* there; and on
gemini-flash proov actually **fails some small-multi (new-file) tasks** the baseline passes (a
model-specific weakness, not structural — it passes them on claude).

**The defensible, publishable claim is therefore narrow and true:** *for edits to **large files**,
anchor-based editing delivers **equal-or-better correctness at a large, reproducible cost reduction
(66–89%)** vs full rewrites — and is cost-neutral-to-slightly-negative on small files.* The win is
**provider-agnostic** (holds on both models) and it's two things at once — cheaper **and** it doesn't
blow up where full-rewrite tools do.

## The honest scope (what it is NOT)

This was established by *measurement*, not hope, across multiple invention-pipeline runs:

- **It is not smarter than Claude Code.** With the *same model*, a coding agent's quality is set by
  the model, not the harness. proov ties Claude-Code-style harnesses on *task success* — it wins on
  *cost and reliability*, not capability. Running it on a weak model gives weak results.
- **The cost win is conditional on file size.** It's huge on large/multi-file work (the common real
  case) and a *wash or slight loss* on tiny single-edit files (full-rewriting a small file is cheap).
- **The mechanism is decidable, not magical.** It guarantees "no silent wrong edit" and "never
  re-send the file"; it does **not** verify your code is behaviorally correct.

So the defensible claim is precise: **a cheaper, more reliable, provider-agnostic coding agent** —
better than Claude Code *where editing cost and large-file robustness matter*, equal elsewhere — not
a smarter one.

## How it was invented (lineage + method)

This came out of a rigorous invention pipeline (diverge → novelty-ground → hostile-referee kill →
converge → build → **measure head-to-head**), then a hole-finding pass:

1. The fresh pipeline converged on **SEAL** (a repair-packet edit loop) and, on a *fair* head-to-head,
   honestly found it was **not** a win on the original (gemini) benchmark — the token savings were
   erased by cheap input pricing, and the applier had **silent-wrong-edit holes** (first-occurrence,
   comment-collision, fuzzy auto-apply) that were proven empirically.
2. Those holes were **fixed** (unique-match requirement, sound string-safe normalization, no fuzzy
   auto-apply) — turning the applier from "fewer failed applies" into "**no wrong applies**."
3. Re-measured at scale on **both** a cheap model (gemini) and a **realistically-priced model
   (Claude Sonnet 4)**, the compact-edit protocol showed a **real, reproducible 65–89% cost cut on
   large-file edits at equal-or-better correctness** — and exposed the full-rewrite baseline's
   large-file *failure* (0/18 on gemini, token runaways). proov is that fixed engine wrapped in a
   usable agent. (The early cheap-model preview had *hidden* this — cheap input pricing erased the
   token savings; pricing a realistic model, and scaling the benchmark, revealed it.)

The meta-lesson, paid for in measurements: *with the same model you cannot out-think Claude Code at
the harness level — you can only make it cheaper and more reliable.* proov is exactly that, honestly.

## Architecture (where each piece lives)

- `src/seal.mjs` — **the invention**: correctness-first compact-edit applier + repair packets.
- `src/tools.mjs` — agent tools over a sandboxed workdir: read / list / grep / run / `edit_file` /
  `edit_files` (atomic) / `create_file` / git_*. The edit tools are the cost/reliability edge.
- `src/provider.mjs` — configurable LLM provider (any OpenRouter model) with per-call token+cost
  accounting (so the cost win is *measured*, not assumed).
- `src/loop.mjs` / `src/agent.mjs` — the tool-use loop + a persistent `Session` for the REPL.
- `src/repl.mjs`, `src/ui.mjs`, `src/diff.mjs`, `src/config.mjs`, `src/safety.mjs` — daily-use shell:
  REPL, streaming colored diffs, config, destructive-command blocklist + approval.
- `bin/proov.mjs` — the CLI. `bench/` — the head-to-head harness + measured results.

See `README.md` for usage and `bench/REPORT.md` for the full measured numbers.
