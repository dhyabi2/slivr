# LOFT wire protocol & soundness argument

## Objects in the durable store (single namespace per room)

| key | written by | primitive | contents |
|-----|-----------|-----------|----------|
| `state` | folder | **CAS** | `{ state, beat }` — the authoritative state machine + current beat |
| `in:<beat>:<pid>` | player | **PUT** (distinct key) | one input `{ tick, playerId, dx, dz, sig }` |
| `chain:<beat>` | folder | PUT (idempotent) | `{ beat, head, stateHash, inputDigest, folder, sig }` |

Only `state` uses compare-and-swap. Inputs use distinct keys → no inter-player contention.

## Beat lifecycle

1. **Open beat `b`.** `state.beat == b`. Players `PUT in:b:<pid>` with their input (≤ one per
   player per beat; a second PUT to the same key is rejected by the store's version-0 guard).
2. **Close + fold.** Any participant may, after the beat's input window, attempt the fold:
   - `read(state) → (v, st)`; require `st.beat == b`.
   - gather `in:b:*` (batched read / scan), sort by `playerId` → canonical input list `I`.
   - `next = step(st.state, I)` (pure, deterministic).
   - `head_{b+1} = H(head_b ‖ (b+1) ‖ inputDigest(I) ‖ stateHash(next))`.
   - `cas(state, v, {state: next, beat: b+1})`.
     - **ok** → write `chain:b+1` with the ed25519 signature over `head_{b+1}`. Beat advances.
     - **fail** → another folder won; re-read and either accept (beat advanced) or move on.
3. Repeat. Liveness needs **≥1 honest folder online**; multiple folders are safe (CAS makes
   the fold idempotent — exactly one commit per beat).

## Determinism contract (why the hashes are sound)

- All state is fixed-point **integer** (`SCALE = 1000`); no float, no `Date`, no RNG in `step`.
- Inputs are **sorted by `playerId`** before folding, so concurrent / out-of-order arrival
  yields the same fold. (Verified: 200 ticks delivered in reverse order → identical hash.)
- Serialization has a **fixed field order**; `stateHash = sha256(serialize(state))` is therefore
  byte-identical on every machine. The hash-chain binds each state to its entire history.

## Fraud proof (optimistic verification)

The published `chain:*` is a sequence of per-beat state hashes signed by folders. A verifier
replays from genesis (`replayVerify`) and, on the first mismatch, opens a dispute:

- **Bisection** (`bisect`) over `[0, N]`: invariant *agree at `lo`, disagree at `hi`*; binary
  search the least beat `i` where the transcripts first differ. `⌈log2 N⌉` probes
  (8 for N = 256).
- **Single-step adjudication** (`adjudicate`): both sides agree on the pre-state at `i-1`.
  The arbiter computes `stateHash(step(preState, inputs_i))` — **one** tick — and whichever
  claim matches wins; the other is slashed. The arbiter never replays the whole game (`O(1)`).

Soundness: because `step` is a deterministic pure function of `(preState, inputs)`, the honest
post-hash is unique and recomputable by anyone; a folder claiming any other hash is provably
wrong. (Verified: tampered transcript forked at beat 173 → localized to 173 in 8 probes,
defender slashed, zero false positives on honest transcripts.)

## Security assumptions / boundaries

- **Full information.** Adjudication reveals `preState` + `inputs`. Secret-state games need
  commit-reveal / VRF / ZK to avoid leaking — out of scope for this PoC.
- **Input authenticity.** Each input is signed by the player; a folder cannot forge inputs
  (only choose ordering, which is canonicalized away). Equivocation on `state` is caught by
  the fraud proof.
- **Liveness.** Requires ≥1 honest folder and a live CAS store. A censoring folder cannot
  forge state (fraud proof) but could stall; mitigate with an open fold-permission set + a
  challenge timeout (production work).
- **Store primitive.** Needs CAS on one key + a batched/scan read of a key range. Available on
  DynamoDB, Cloudflare KV+DO, Upstash/Redis, etcd, FoundationDB.
