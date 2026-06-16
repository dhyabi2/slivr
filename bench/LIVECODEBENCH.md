# LiveCodeBench runner for proov

[LiveCodeBench](https://livecodebench.github.io) is a contamination-free benchmark of competitive-
programming problems (LeetCode / AtCoder / Codeforces), collected over time and tagged by release
window so you can evaluate on problems published *after* a model's training cutoff. `release_v6` is
the newest window.

`bench/livecodebench.mjs` drives **proov** (the agent) over a set of LiveCodeBench problems, extracts
the generated `solution.py`, executes it against the problem's tests with `python3`, and reports
**pass@1** = fraction of problems whose every test passes.

## Quick start

```bash
# 1) Validate the harness offline (no API key, no cost): extraction + execution + scoring.
node bench/livecodebench.mjs --mock          # must print "mock self-test OK"  (3/3)

# 2) Real run against your own problem set:
export OPENROUTER_API_KEY=sk-or-...
node bench/livecodebench.mjs --data lcb.jsonl --limit 20 --model google/gemini-2.5-flash
# or: npm run bench:lcb -- --data lcb.jsonl --limit 20
```

Flags: `--data <file.jsonl>` (one problem per line), `--limit N`, `--model <id>`, `--max-steps N`,
`--repair N`, `--mock`. Results are written to `bench/results-livecodebench.json`.

## Verify-and-repair (`--repair N`)

With `--repair N`, the harness wires each problem's tests into proov's **verify-and-repair loop**:
when the agent calls `done`, its `solution.py` is executed against the tests; on a failing test the
agent is shown the failing case (input / expected / got) and must fix the code and finish again, up
to `N` times. This is the difference between a blind one-shot agent and a self-correcting one — and
it roughly doubled pass@1 in a measured A/B on real problems:

```
7 real release_v6 AtCoder problems · google/gemini-2.5-flash
  --repair 0  (baseline, one-shot):  pass@1 3/7 = 42.9%
  --repair 3  (verify-and-repair):   pass@1 6/7 = 85.7%
```

Both *hard* problems and a *medium* one flipped fail→pass once the agent could run its own code and
read the failure. Use a higher `--max-steps` with `--repair` so there's room to iterate
(`--max-steps 14 --repair 3`). Note: here the verify tests and the graded tests are the same public
set, so this measures self-correction-to-the-given-tests (the real-world value of an iterate-on-tests
agent); grade against hidden tests via the official Python runner for a leaderboard-clean figure.

## Getting the dataset into `--data` shape

Each line of the `--data` JSONL is one problem with LiveCodeBench fields:

```json
{ "question_id": "...", "question_title": "...", "question_content": "...",
  "platform": "atcoder", "difficulty": "easy", "starter_code": "",
  "public_test_cases": "[{\"input\":\"...\",\"output\":\"...\",\"testtype\":\"stdin\"}]",
  "metadata": "{\"func_name\": null}" }
```

`public_test_cases` / `metadata` are JSON **strings** (as in the upstream dataset). `testtype` is
`"stdin"` (pipe input → compare stdout) or `"functional"` (call `metadata.func_name` with the
JSON-decoded args). The official dataset lives at
[`livecodebench/code_generation_lite`](https://huggingface.co/datasets/livecodebench/code_generation_lite)
as large JSONL files (`test.jsonl` … `test6.jsonl`, one per release window).

Two ways to export it:

- **Python (recommended, full fidelity incl. hidden tests):**
  ```python
  from datasets import load_dataset
  import json
  ds = load_dataset("livecodebench/code_generation_lite", split="test",
                    version_tag="release_v6", trust_remote_code=True)
  with open("lcb.jsonl", "w") as f:
      for r in ds:
          f.write(json.dumps({k: r[k] for k in
            ["question_id","question_title","question_content","platform",
             "difficulty","starter_code","public_test_cases","metadata"]}) + "\n")
  ```
- **No-Python, public tests only:** range-fetch the head of a release file and keep complete lines:
  ```bash
  curl -sL -r 0-8000000 \
    https://huggingface.co/datasets/livecodebench/code_generation_lite/resolve/main/test6.jsonl \
    | head -c 8000000 > head.jsonl   # then keep only complete lines and drop private_test_cases
  ```

## Honest caveats (read before quoting a number)

- **Public-test pass@1 is a proxy.** This runner grades against `public_test_cases` (always plain
  JSON). The upstream `private_test_cases` are base64+zlib+**pickle** encoded — pickle can't be
  decoded in Node, so to grade against the hidden tests use the official Python runner. A solution
  can pass public tests and still fail hidden ones, so public-test pass@1 is an **upper bound**.
- **This benchmarks proov end-to-end**, not a raw model. The score reflects the agent loop (prompt,
  tool use, `create_file`, step budget) *and* the model. Raise `--max-steps` for harder problems.
- **Sample size matters.** A handful of problems is indicative, not authoritative — run the full
  release window (hundreds of problems) for a leaderboard-comparable figure, and note the cost.
- **`functional` grading is best-effort** (imports the solution, calls `func_name` with per-line
  JSON args, compares with light list-order normalization). For LeetCode functional fidelity, prefer
  the official runner.

## Example (illustrative, tiny sample — NOT a leaderboard figure)

7 real `release_v6` AtCoder problems (ABC387/388), public tests only, default model
`google/gemini-2.5-flash`, `--max-steps 6`:

```
✓ abc387_b  9x9 Sum                      3/3  [easy]
✗ abc387_f  Count Arrays                 0/3  [hard]
✓ abc387_a  Happy New Year 2025          4/4  [easy]
✗ abc387_c  Snake Numbers                0/3  [medium]
✗ abc388_d  Coming of Age Celebration    0/3  [medium]
✓ abc388_b  Heavy Snake                  2/2  [easy]
✗ abc388_g  Simultaneous Kagamimochi 2   0/2  [hard]

pass@1: 3/7 = 42.9%   (all easy solved; medium/hard mostly missed — expected for a small/fast model)
```
