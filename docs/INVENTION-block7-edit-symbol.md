# Invention Block 7 — `edit_symbol`: replace a definition by name (cost-compounding edits)

Seventh feature from the **brainstorm→rank→build→measure** loop.

## Seed — the gap, and what `measure` revealed
The cost-edit brainstorm's top idea (r85) was "fuzzy anchor recovery." But inspecting proov's vendored
SEAL engine (`src/seal.mjs`) showed it **already** does this: it auto-applies `exact` and canonical
(whitespace + operator-spacing-insensitive) anchor matches with no model round-trip, and deliberately
**refuses** to silently apply riskier fuzzy matches (a correctness-first choice). Reimplementing it
would duplicate work or weaken a deliberate guarantee — so the slot was redirected to a genuinely-new,
non-overlapping cost win.

## The real cost lever
proov's anchor protocol is cheap on INPUT (never re-sends whole files) but to replace a whole function
the model must still emit the **old body verbatim as the anchor** in its OUTPUT. For a large function
that's a lot of output tokens spent reproducing code that's about to be deleted.

## The winner — `edit_symbol`
> Replace a whole function/class/method by NAME: the model sends only the **new** definition; proov
> uses the symbol index (Block 3) to find the unique definition, detects its full span
> (brace-matching for JS/Go/Rust/Java/C, indentation for Python), and splices in the replacement —
> **no old body as an anchor.** CORRECTNESS-FIRST: a non-unique name, an unknown symbol, a
> non-function, or an uncertain span all return an error so the agent falls back to `edit_file`.

## Implementation
- `src/repomap.mjs`: `symbolSpan(text, lang, defLine)` — safe brace/indent span detection (null when
  uncertain); `langOf(file)`.
- `src/tools.mjs`: `edit_symbol` (+ a shared read-only `_resolveSymbolEdit` and `previewSymbolEdit`,
  so the approval gate previews a real before/after diff without writing). Reindents the replacement
  to the definition's indent; invalidates the cached index after a write.
- `src/safety.mjs`: `edit_symbol` added to the approval-gated mutating set.
- `src/agent.mjs`: registered in both tool maps (Session wraps it to capture the streaming diff) +
  system prompt. `src/repl.mjs` / `bin/proov.mjs` / `src/ui.mjs`: approval preview, diff, step label.
- `selftest.mjs`: +12 tests (JS + Python replace, ambiguity/not-found/non-function/uncertain-span
  safety, read-only preview, approval gating).

## Measured result
| case | result |
|---|---|
| JS function (5-line body) | replaced whole; **5 anchor lines the model did NOT have to emit** |
| Python method | replaced + reindented to the method's indent |
| same name in two files | `AMBIGUOUS` until `file` is given (no wrong-file edit) |
| unknown / non-function / braceless-arrow | safe error → fall back to `edit_file` |

The cost win scales with function size: a 40-line function costs ~40 lines of output to anchor with
`edit_file`, and **zero** with `edit_symbol`. Verified end-to-end: given a task, the model called
`edit_symbol greet` and proov applied `+2 -2 (symbol)` cleanly, sandboxed to the working directory.
