/* SPDX-License-Identifier: AGPL-3.0-or-later
   A faithful in-process model of a serverless durable KV with COMPARE-AND-SWAP — the
   only primitive LOFT needs from infra (Cloudflare KV+DO, DynamoDB conditional write,
   Upstash Redis WATCH/SET, etcd, FoundationDB ... all provide it). We model the two
   properties that decide whether LOFT is real:
     1. NETWORK LATENCY  — every op pays a round-trip (configurable, jittered).
     2. CAS CONTENTION   — a write succeeds only if the row's version is unchanged since
        you read it; otherwise it FAILS and you must retry (read-modify-write loop).
   The store records metrics so the benchmark reports ground-truth contention, not a guess.
   `now` is an injected logical clock (ms) so runs are deterministic & reproducible. */

export class DurableKV {
  constructor({ latencyMs = 8, jitterMs = 4 } = {}) {
    this.rows = new Map();                 // key -> { version, value }
    this.latencyMs = latencyMs; this.jitterMs = jitterMs;
    this.metrics = { reads: 0, casOk: 0, casFail: 0, appends: 0, opMs: 0 };
    this._seed = 0x2545f491;               // for deterministic jitter
  }
  _jit() { this._seed = (this._seed * 1103515245 + 12345) & 0x7fffffff; return (this._seed % (this.jitterMs + 1)); }
  _cost() { const c = this.latencyMs + this._jit(); this.metrics.opMs += c; return c; }

  read(key) {
    this.metrics.reads++; const cost = this._cost();
    const r = this.rows.get(key);
    return { value: r ? r.value : null, version: r ? r.version : 0, cost };
  }
  // CAS advance of a single row: succeeds iff expectedVersion matches current.
  cas(key, expectedVersion, newValue) {
    const cost = this._cost();
    const r = this.rows.get(key) || { version: 0, value: null };
    if (r.version !== expectedVersion) { this.metrics.casFail++; return { ok: false, version: r.version, cost }; }
    this.rows.set(key, { version: r.version + 1, value: newValue });
    this.metrics.casOk++; return { ok: true, version: r.version + 1, cost };
  }
  // APPEND to a distinct key is contention-free (no shared version) — this is the path
  // LOFT routes player inputs through, so inputs never fight the state row's CAS.
  append(key, item) {
    this.metrics.appends++; const cost = this._cost();
    const r = this.rows.get(key) || { version: 0, value: [] };
    r.value = [...r.value, item]; r.version++;
    this.rows.set(key, r); return { ok: true, cost };
  }
  size() { let n = 0; for (const r of this.rows.values()) n += (Array.isArray(r.value) ? r.value.length : 1); return n; }
}
