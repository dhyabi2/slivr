# Invention Block 3 — Repo Symbol Index (`find_symbol` / `repo_map`)

Third feature from the **brainstorm→rank→build→measure** loop.

## Seed — the gap
Cursor's edge is repo-wide semantic context; proov only had `grep`, which returns **every mention** of
a name — the definition buried among all the call sites — forcing the model to read through the noise.

## Brainstorm + rank (from the 54-idea pool)
The F3 "repo-context" cluster (#13/#15/#17/#49/#52/#53) converged on a zero-dependency, regex-driven
symbol index — no vector DB, no embeddings. Winners:
- **#53 Contextual Path Index (85)** — two-pass regex scan → symbols (name, kind, file, line,
  signature) + import/export edges, line-oriented and token-cheap.
- **#52 two-tier (75)** — a shallow global map + on-demand local detail.

## The winner — a two-tier symbol index
> Scan the repo with language-specific regexes (JS/TS, Python, Go, Rust, Java, Ruby, C) to extract
> definitions. Expose two tools: **`repo_map`** (shallow global overview — files and their top-level
> symbols) and **`find_symbol`** (on-demand: jump straight to a definition's file:line + signature,
> with case-insensitive/substring fallback for slightly-wrong names).

## Implementation
- `src/repomap.mjs`: `buildSymbolIndex` (walk, skipping `node_modules`/`.git`/… ; per-language def
  patterns; top-level-only bindings so local vars aren't indexed), `findSymbol` (+ fuzzy fallback),
  `repoOverview`. Zero dependencies.
- `src/tools.mjs`: `repo_map` + `find_symbol` tools (index built lazily and cached per session).
- `src/agent.mjs`: registered in both tool maps, added to the system prompt with a "prefer
  find_symbol over grep to locate definitions" note, and to the sub-agent findings set.
- `selftest.mjs`: +14 tests (multi-language extraction, keyword/local-var filtering, exact-definition
  resolution on proov's own source, fuzzy fallback, tool wiring).

## Measured result
Indexing proov's own `src/` (655 symbols / 18 files), jump-to-definition accuracy and noise vs grep:

| symbol | `find_symbol` | `grep` lines to read |
|---|---|---|
| `runLoop` | loop.mjs:49 (1 result) | 6 |
| `needsApproval` | safety.mjs:87 (1) | 5 |
| `renderDiff` | diff.mjs:113 (1) | 8 |
| `Session` | agent.mjs:220 (1) | 5 |
| `humanizeApiError` | provider.mjs:163 (1) | 2 |

**100% of probes resolved to the exact single definition**, vs grep returning 2–8 lines of
definition+call-site noise each. Verified end-to-end: given a real task, the model called
`find_symbol humanizeApiError` and reported `src/provider.mjs:163` correctly.
