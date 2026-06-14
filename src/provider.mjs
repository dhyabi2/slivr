// provider.mjs — configurable LLM provider over OpenRouter, with token + cost accounting.
//
// Model is chosen via the MODEL env var (default google/gemini-2.5-flash). Every call returns
// the assistant text AND a usage record (prompt/completion tokens + USD cost from a price table).
// A single Provider instance accumulates session totals so a harness can report cost honestly.

import fs from "node:fs";
import { hasPdfInContext, PDF_PLUGIN } from "./multimodal.mjs";

// Portable key fallback: OPENROUTER_API_KEY env, then a .env / .env.local in the CURRENT dir.
// (config.apiKey — resolved from env / flags / ~/.cc-alt.json — is the primary path via opts.)
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
    // session accounting
    this.calls = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
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
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      // chain the caller's abort signal (e.g. Ctrl-C in the REPL) into this request
      const onAbort = () => ctrl.abort();
      if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
      try {
        const r = await fetch(this.baseUrl + "/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + this.key, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model, temperature, max_tokens: this.maxTokens, messages,
            ...(pluginList.length ? { plugins: pluginList } : {}),
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.("abort", onAbort);
        const d = await r.json();
        if (!r.ok) {
          lastErr = new Error(`API ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
          // 4xx (except 429) won't get better on retry
          if (r.status >= 400 && r.status < 500 && r.status !== 429) throw lastErr;
          await sleep(500 * (attempt + 1));
          continue;
        }
        const text = d.choices?.[0]?.message?.content ?? "";
        const u = d.usage || {};
        const pt = u.prompt_tokens ?? 0;
        const ct = u.completion_tokens ?? 0;
        const c = costUSD(this.model, pt, ct);
        // accumulate session totals
        this.calls++;
        this.promptTokens += pt;
        this.completionTokens += ct;
        this.cost += c;
        const usage = { promptTokens: pt, completionTokens: ct, cost: c };
        this.log.push(usage);
        return { text, usage, raw: d };
      } catch (e) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.("abort", onAbort);
        // a caller abort (Ctrl-C) must propagate immediately, not retry
        if (signal?.aborted || e.name === "AbortError") { const a = new Error("aborted"); a.name = "AbortError"; throw a; }
        lastErr = e;
        if (e.message === "NO_OPENROUTER_KEY" || /API 4/.test(e.message)) throw e;
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastErr || new Error("chat failed");
  }

  totals() {
    return {
      model: this.model,
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      cost: +this.cost.toFixed(6),
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
