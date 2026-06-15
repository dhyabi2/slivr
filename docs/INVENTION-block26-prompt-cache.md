# Invention Block 26 — Prompt Cache: cut token cost with ZERO text change

Twenty-sixth feature — token efficiency by a purely TECHNICAL method (like compression), changing **no prompt
text** and **deleting nothing**. A coding-agent loop re-sends a large, stable prefix (the system prompt with
all tool docs + directives, plus the growing history) on every turn — and pays full input price for it each
time. Prompt caching marks that stable prefix so the provider bills it at the cached rate (~10% of input)
instead. The model reads byte-identical text; this only adds a cache hint.

## Brainstorm → rank (engine at localhost:8787)
- **Prompt caching via `cache_control` — 85** (the winner): structure messages with a cache breakpoint after
  the stable prefix so it isn't re-billed at full price. No text change, no information loss, provider-native.
- Handle/reference substitution & diff-only re-sends — **75 each**: replace repeated file content with a short
  handle the model must interpret. Rejected here — it *changes the text the model reads* (against the "no
  text change" constraint) and relies on the model reliably "retrieving" content from a hash (unreliable).

## What was built — `applyPromptCache` (`src/provider.mjs`, pure + testable)
Before each request, `applyPromptCache(messages, model)`:
- For **Anthropic/Claude** models: adds `cache_control: {type:"ephemeral"}` to (1) the **system prompt** (the
  largest stable block — tool docs + all directives) and (2) the **last message** (so the running history
  prefix is cached for the next turn). String content becomes a single `{type:"text", text, cache_control}`
  block — the `text` is byte-identical; multimodal array content gets the marker on its last TEXT block only
  (image/file blocks untouched). The original `messages` array is not mutated.
- For **Gemini / GPT / others**: returned UNCHANGED — those providers cache automatically server-side, so no
  client action is needed (and we avoid sending them an unsupported field).

Cached-token accounting: `cachedTokensOf(usage)` reads the cached-prompt-token count across provider shapes
(`prompt_tokens_details.cached_tokens`, `cache_read_input_tokens`); the provider tracks `cachedTokens` in its
totals, and the footer shows e.g. `… 43,801 cached …` so the savings are visible.

Nothing else changed: no prompt wording was edited or deleted (the user's hard constraint), and the model
receives exactly the same text — only a cache boundary is added.

## Measured
- selftest: **438 passed, 0 failed** (was 430; +8) — system-prompt + history-tail breakpoints, **byte-identical
  text**, purity (no mutation), multimodal (last text block only), Gemini/GPT untouched, cached-token reading.
- **Live (anthropic/claude-sonnet-4.6):** a 7-turn task billed **51,802 prompt tokens, of which 43,801 were
  served from cache (~85%)** — the stable system prompt + growing history reused across turns. At the ~10%
  cached rate that is a large real saving on input cost, for **no change to any prompt text**.
- Gemini (the default model) is left untouched and continues to cache automatically server-side.

## Why it disrupts
Most agents pay full price to re-send the same big system prompt every single turn. slivr marks the stable
prefix so it's billed at a fraction — a compression-like win that's lossless and invisible to the model
(byte-identical text), surfaced honestly in the footer (`N cached`). It composes with everything; it's purely
a transport optimization in the provider layer.
