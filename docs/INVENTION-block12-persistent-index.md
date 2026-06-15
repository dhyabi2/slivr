# Invention Block 12 — Persistent + incremental codebase memory (scale to unlimited files)

Twelfth feature — from the challenge: comprehend an arbitrarily-large codebase with the LOWEST LLM
calls; "memorize" the whole repo even if very big; scale to unlimited files.

## Why most agents fail (research-grounded)
Embeddings-RAG is the wrong tool for code: fixed-size chunks cut functions in half (useless
embeddings), boilerplate types all look alike (wrong retrieval), indexes go stale (Cursor re-indexes
every ~10 min → context pollution), monorepos cap (Copilot ~2,500 files), and no context window holds
millions of lines → agents hallucinate architecture they can't see. Plus embeddings cost a model call
per chunk + a vector DB.

## Brainstorm result (11 ideas, avg 84.5; winner r90)
Strong convergence: extend slivr's **existing zero-LLM regex symbol index** (Blocks 3/6) into a
**persistent, incremental, hierarchical Graph-of-Symbols** — NOT embeddings.

## The winner (built here)
> Persist a per-file symbol cache to disk, keyed by repo path. On each build, compare each file's
> mtime/size to the cache; re-parse ONLY changed/new files, drop deleted ones, reuse the rest. The
> index is the codebase's **memory** — queried for free (find_symbol / find_refs / repo_map), no LLM
> calls, no embeddings, no vector DB, no file cap.

## Implementation (`src/repomap.mjs`)
- `buildSymbolIndex` now: loads a disk cache (`~/.slivr/index/<repo-hash>.json`), walks the repo,
  reuses cached symbols for unchanged files (mtime+size match), re-parses only changed ones, drops
  deleted ones, persists the updated cache, and returns `stats {total, parsed, reused, removed}`.
  Opts: `persist` (default true), `cacheDir`, `maxFiles` (raised to 50k). Built-in `crypto` for the
  cache key — still zero npm dependencies.
- `src/tools.mjs`: `repo_map` surfaces the memory size + incremental savings.
- `selftest.mjs`: +9 (cold parses all; warm reuses all; touch → re-parse only that file; delete →
  removed; persist:false always parses; symbol found after an incremental update). Suite 310 → 318.

## Measured (300-file synthetic repo)
| | parsed | reused | time |
|---|---|---|---|
| **cold** build | 300 | 0 | 19 ms |
| **warm** re-index | **0** | 300 | 6 ms |
| after touching 1 file | **1** | 299 | — |
| after deleting 1 file | — | — | removed 1 |

Incremental re-index is **near-free** — re-parsing only what changed. On a real million-line monorepo
the cold pass is I/O-bound (seconds, once) and every subsequent run is ~constant per change. The agent
then answers "where is X / who calls Y / what's the structure" with **≈0 model tokens**, and only the
relevant code ever enters the context window — the opposite of stale, costly, chunk-broken RAG.
