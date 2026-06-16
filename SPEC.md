# proov — SPEC

## What this is
A **configurable-LLM coding-agent harness** (a real CLI agent that edits real repos) plus a
**faithful Claude-Code-style baseline harness**, built to test ONE claim at the **harness level**:

> On the **same swappable model**, a harness using a **compact anchor-based edit protocol** can
> reach **equal task success at lower session cost** than a harness using the naive **full-file
> rewrite** protocol — with the biggest win on **large files / multi-edit sessions**.

This is **harness-vs-harness**, NOT model-vs-model and NOT model-building. The LLM is a provider
plugged in behind a `MODEL` env var.

## Components
- `src/provider.mjs` — OpenRouter provider. Model from `MODEL` (default `google/gemini-2.5-flash`;
  also supports `anthropic/claude-sonnet-4`). Captures `prompt_tokens`/`completion_tokens` from the
  API and computes USD cost from a per-model price table. ~30s timeout, bounded retries. Accumulates
  session totals (calls/tokens/cost).
- `src/tools.mjs` — tools on a real workdir: `read_file`, `list_dir`, `grep`, `run_command`
  (sandboxed: cwd = workdir, escapes rejected), and the two edit protocols:
  - `edit_file` (COMPACT): `{anchor, replacement, op}` applied by the vendored SEAL applier. On
    failure returns a small structured **repair packet** (nearest real spans + instruction) — it
    NEVER re-sends the whole file. The model retries from the compact packet.
  - `write_file` (NAIVE): full-file overwrite (the baseline's protocol).
- `src/seal.mjs` — **vendored read-only** from `better-cc-fresh/src/seal.mjs` (attributed in-file).
  Correctness-first applier: applies only on a UNIQUE exact or whitespace-normalized match; rejects
  ambiguous anchors; returns a repair packet on a miss. No silent wrong-location edits.
- `src/loop.mjs` — shared tool-use loop. Model emits ONE JSON tool call per turn; harness executes,
  feeds a (truncated) result back; repeats until `done` or the step cap. Tracks turns + edit failures.
- `src/agent.mjs` — **proov** harness: system prompt teaching the compact-edit protocol + `edit_file`.
- `src/baseline.mjs` — **baseline** harness: same loop/tools, system prompt teaching read-whole →
  write-whole + `write_file`. The ONLY difference from proov is the edit/context protocol.

## Benchmark
- `bench/tasks.mjs` — 8 real multi-edit tasks across file-size regimes (small-single, small-multi,
  medium-single, large-single). Each has a **behavioral oracle**: a node check that executes the
  resulting code and asserts observable behavior; exit 0 == success. Ground truth, not a diff guess.
- `bench/run.mjs` — seeds a FRESH workdir per (task, harness), runs both harnesses on the SAME model,
  runs the oracle, records success/tokens/$/turns/editFailures, writes `results.json`, prints the
  head-to-head table + per-kind cost-saved breakdown.

## Tool-call contract (model-facing)
One JSON object per turn:
```
{"tool":"read_file","args":{"path":"src/x.js"}}
{"tool":"edit_file","args":{"path":"src/x.js","anchor":"<verbatim>","replacement":"<new>","op":"replace"}}
{"tool":"write_file","args":{"path":"src/x.js","content":"<entire file>"}}   // baseline only
{"tool":"run_command","args":{"command":"node check.js"}}
{"tool":"done","args":{"summary":"..."}}
```

## Cost model
`cost = prompt_tokens/1e6 * price_in + completion_tokens/1e6 * price_out`, per the configured model.
Prices (USD/1M tok, approx OpenRouter 2026-06): gemini-2.5-flash 0.30/2.50; claude-sonnet-4 3.00/15.00.

## Honest limits
- Small n (8 tasks). LLM nondeterminism means single runs are noisy; treat numbers as directional.
- The win is **conditional on file size / edit locality**. On tiny single-edit files the compact
  protocol's overhead (verbose anchors + extra exploration turns) can make it *more* expensive — a
  full rewrite of a 6-line file is cheap. The advantage grows with file size and with multi-edit
  sessions where the baseline re-sends large files repeatedly.
- Timeboxed: failing sub-tests are stubbed/noted, not chased.
