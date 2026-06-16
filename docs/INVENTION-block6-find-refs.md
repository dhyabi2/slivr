# Invention Block 6 — `find_refs`: call-site / reference locator (repo-context tier-2)

Sixth feature from the **brainstorm→rank→build→measure** loop — the tier-2 of Block 3's symbol index.

## Seed — the gap
Block 3 gave `find_symbol` (jump to a definition) and `repo_map` (overview). But to change a function
safely you need the other direction: **who calls it?** grep mixes the definition, imports, comments,
and call-sites into one noisy list.

## Brainstorm + rank (fresh, proov-grounded)
The B6 winner (**#4, rating 85**, "Contextual Call-Site Locator") proposed on-demand, regex-driven
reference analysis around the symbol, filtering comments/strings and excluding the definition.

## The winner — `find_refs`
> Given a symbol name, scan source for **word-boundary** identifier matches (so `run` doesn't match
> `runLoop`/`rerun`), strip `//` line comments, **exclude the symbol's own definition lines**, and tag
> each hit as a call (`name(`) vs a mention. Built on Block 3's index (`allFiles`); no new scan cost.

## Implementation
- `src/repomap.mjs`: `findReferences(index, name)` (word-boundary regex, comment stripping, definition
  exclusion, call tagging); `buildSymbolIndex` now also records `allFiles`.
- `src/tools.mjs`: `find_refs` tool (returns count, call count, and up to 100 references).
- `src/agent.mjs`: registered in both tool maps + system prompt ("run find_refs before changing a
  signature so you update every caller") + sub-agent findings set.
- `selftest.mjs`: +6 tests.

## Measured result (proov's own src/)
| query | find_refs | grep noise |
|---|---|---|
| `runLoop` | the **3 real call-sites** (agent.mjs ×2, baseline.mjs), definition excluded | mixes def + imports + calls |
| `needsApproval` | the call-sites in repl.mjs, definition excluded | — |
| `run` | word-boundary only — does **not** match `runLoop`/`runAgent` | substring grep would |

Verified: `find_refs runLoop` returns exactly the callers (`runAgent`, `Session.runTurn`,
`baseline.mjs`) and excludes the definition at `loop.mjs:49` — precisely the list you need before a
refactor, which a substring grep cannot give cleanly.

## Note on the cost-edit direction (Block 7 candidate)
The brainstorm's other r85 direction — "fuzzy anchor recovery" — turned out to be **already shipped**
in proov's vendored SEAL engine (`src/seal.mjs`): it auto-applies `exact` and canonical
(whitespace + operator-spacing-insensitive) anchor matches locally with no model round-trip, and
deliberately refuses to silently apply riskier fuzzy matches (a correctness-first choice). So that
slot was redirected to a genuinely-new cost-compounding feature (`edit_symbol`) instead of duplicating
existing, intentional behavior — the "measure" step doing its job.
