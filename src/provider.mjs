// provider.mjs — configurable LLM provider over OpenRouter, with token + cost accounting.
//
// Model is chosen via the MODEL env var (default google/gemini-2.5-flash). Every call returns
// the assistant text AND a usage record (prompt/completion tokens + USD cost from a price table).
// A single Provider instance accumulates session totals so a harness can report cost honestly.

import fs from "node:fs";
import { hasPdfInContext, PDF_PLUGIN } from "./multimodal.mjs";

// Portable key fallback: OPENROUTER_API_KEY env, then a .env / .env.local in the CURRENT dir.
// (config.apiKey — resolved from env / flags / ~/.slivr.json — is the primary path via opts.)
function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  for (const f of [".env.local", ".env"]) {
    try {
      for (const l of fs.readFileSync(f, "utf8").split("\n")) {
        const m = l.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.*)$/);
        if (m) return m[1].trim().replace(/^["']|["']$/g, "");
      }
    } catch { /* try next */ }
  }
  return "";
}

// USD per 1M tokens. Source: OpenRouter public pricing (approx, as of 2026-06).
// If a model is missing we fall back to a conservative default so cost is never silently 0.
const PRICES = {
  "google/gemini-2.5-flash":   { in: 0.30, out: 2.50 },
  "anthropic/claude-sonnet-4": { in: 3.00, out: 15.00 },
  "_default":                  { in: 1.00, out: 3.00 },
};

export function priceFor(model) {
  return PRICES[model] || PRICES._default;
}

export function costUSD(model, promptTokens, completionTokens) {
  const p = priceFor(model);
  return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out;
}

export class Provider {
  constructor(opts = {}) {
    this.model = opts.model || process.env.MODEL || "google/gemini-2.5-flash";
    this.key = opts.key || opts.apiKey || loadKey();
    this.baseUrl = (opts.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.maxTokens = opts.maxTokens ?? opts.maxTokensPerTurn ?? 4000;
    // optional UI hook: called with a short string on transient events (retry/timeout) so the
    // user isn't staring at a silent hang. No-op by default.
    this.notify = typeof opts.notify === "function" ? opts.notify : () => {};
    // session accounting
    this.calls = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.cachedTokens = 0;
    this.cost = 0;
    this.log = [];
  }

  hasKey() { return !!this.key; }

  // messages: [{role, content}] where content is a STRING or an ARRAY of blocks (multimodal —
  // text + image_url / file). Array content is passed through to OpenRouter UNCHANGED. When a PDF
  // file block is in-context (or plugins are passed explicitly) the file-parser plugin is merged so
  // OpenRouter extracts the PDF text for the model. Returns { text, usage, raw }.
  async chat(messages, { temperature = 0.2, signal, plugins } = {}) {
    if (!this.key) throw new Error("NO_OPENROUTER_KEY");
    if (signal?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    // auto-attach the PDF parser plugin when a pdf is present (callers may also pass plugins).
    let pluginList = Array.isArray(plugins) ? [...plugins] : [];
    if (hasPdfInContext(messages) && !pluginList.some(p => p && p.id === "file-parser")) pluginList.push(PDF_PLUGIN);
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ctrl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.timeoutMs);
      // chain the caller's abort signal (e.g. Ctrl-C in the REPL) into this request
      const onAbort = () => ctrl.abort();
      if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
      try {
        const r = await fetch(this.baseUrl + "/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + this.key, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model, temperature, max_tokens: this.maxTokens,
            messages: applyPromptCache(messages, this.model),   // cache the stable prefix — no text change
            ...(pluginList.length ? { plugins: pluginList } : {}),
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.("abort", onAbort);
        const d = await r.json();
        if (!r.ok) {
          lastErr = new Error(humanizeApiError(r.status, d));
          // 4xx (except 429) won't get better on retry
          if (r.status >= 400 && r.status < 500 && r.status !== 429) { lastErr.noRetry = true; throw lastErr; }
          if (attempt < this.maxRetries) this.notify(`model returned ${r.status}; retrying (${attempt + 2}/${this.maxRetries + 1})…`);
          await sleep(500 * (attempt + 1));
          continue;
        }
        const text = d.choices?.[0]?.message?.content ?? "";
        const u = d.usage || {};
        const pt = u.prompt_tokens ?? 0;
        const ct = u.completion_tokens ?? 0;
        const cached = cachedTokensOf(u);   // prompt tokens served from cache (billed ~10%, not full)
        const c = costUSD(this.model, pt, ct);
        // accumulate session totals
        this.calls++;
        this.promptTokens += pt;
        this.completionTokens += ct;
        this.cachedTokens += cached;
        this.cost += c;
        const usage = { promptTokens: pt, completionTokens: ct, cachedTokens: cached, cost: c };
        this.log.push(usage);
        return { text, usage, raw: d };
      } catch (e) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.("abort", onAbort);
        // a caller abort (Ctrl-C) must propagate immediately, not retry
        if (signal?.aborted) { const a = new Error("aborted"); a.name = "AbortError"; throw a; }
        // OUR timeout fired (not a user abort): a distinct, clearly-worded, retryable failure so it
        // is never confused with the user pressing Ctrl-C.
        if (timedOut) {
          lastErr = new Error(`request timed out after ${Math.round(this.timeoutMs / 1000)}s`);
          if (attempt < this.maxRetries) { this.notify(`request timed out; retrying (${attempt + 2}/${this.maxRetries + 1})…`); await sleep(500 * (attempt + 1)); continue; }
          throw lastErr;
        }
        if (e.name === "AbortError") { const a = new Error("aborted"); a.name = "AbortError"; throw a; }
        lastErr = e;
        if (e.message === "NO_OPENROUTER_KEY" || e.noRetry) throw e;
        if (attempt < this.maxRetries) this.notify(`network error (${e.message}); retrying (${attempt + 2}/${this.maxRetries + 1})…`);
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastErr || new Error("chat failed");
  }

  // Fold in token usage from a SEPARATE OpenRouter call made outside chat() (e.g. the web_search
  // tool's own request) so session totals + cost stay honest. usage = { promptTokens, completionTokens, cost }.
  recordExternalUsage(usage = {}) {
    const pt = usage.promptTokens || 0, ct = usage.completionTokens || 0;
    this.promptTokens += pt;
    this.completionTokens += ct;
    this.cost += (typeof usage.cost === "number" ? usage.cost : costUSD(this.model, pt, ct));
    this.log.push({ promptTokens: pt, completionTokens: ct, cost: usage.cost, external: true });
  }

  totals() {
    return {
      model: this.model,
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cachedTokens: this.cachedTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      cost: +this.cost.toFixed(6),
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// PROMPT CACHING (token efficiency, ZERO text change): mark the stable prefix with cache_control so the
// provider bills it at the cached rate (~10% of input) instead of re-billing the full prompt every turn.
// The model reads the SAME text — this only adds a cache hint; nothing is deleted or reworded. Anthropic/
// Claude use explicit cache_control breakpoints (we set them); other providers (Gemini, DeepSeek) cache
// automatically server-side, so we leave their messages untouched. Pure + testable.
const CACHE_MODELS = /claude|anthropic/i;
export function applyPromptCache(messages, model) {
  if (!CACHE_MODELS.test(String(model || "")) || !Array.isArray(messages) || !messages.length) return messages;
  const mark = (msg) => {
    if (!msg) return msg;
    if (typeof msg.content === "string") return { ...msg, content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }] };
    if (Array.isArray(msg.content) && msg.content.length) {
      const blocks = msg.content.map((b) => ({ ...b }));
      for (let i = blocks.length - 1; i >= 0; i--) { if (blocks[i].type === "text") { blocks[i] = { ...blocks[i], cache_control: { type: "ephemeral" } }; break; } }
      return { ...msg, content: blocks };
    }
    return msg;
  };
  const out = messages.slice();
  const sysIdx = out.findIndex((m) => m.role === "system");      // the largest stable block (tool docs + rules)
  if (sysIdx >= 0) out[sysIdx] = mark(out[sysIdx]);
  const lastIdx = out.length - 1;                                // cache the running history prefix for the NEXT turn
  if (lastIdx >= 0 && lastIdx !== sysIdx) out[lastIdx] = mark(out[lastIdx]);
  return out;
}

// Pull cached-prompt-token count out of a usage record across provider shapes (OpenAI-style
// prompt_tokens_details.cached_tokens, Anthropic cache_read_input_tokens).
export function cachedTokensOf(u = {}) {
  return u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? u.cached_tokens ?? 0;
}

// Turn an OpenRouter error response into a short, human-readable message instead of dumping raw
// JSON at the user. Falls back to the provider's own message, then a generic status line.
export function humanizeApiError(status, body) {
  const detail = body?.error?.message || body?.message || "";
  const hint = {
    401: "authentication failed — check your OPENROUTER_API_KEY",
    402: "payment required — your OpenRouter account is out of credits",
    403: "forbidden — your key may not have access to this model",
    404: "not found — check the model id",
    429: "rate limited — too many requests, slow down or try later",
  }[status];
  const base = hint || (status >= 500 ? "the model provider had a server error" : `request failed (HTTP ${status})`);
  return `API ${status}: ${base}${detail ? ` — ${detail.slice(0, 160)}` : ""}`;
}
