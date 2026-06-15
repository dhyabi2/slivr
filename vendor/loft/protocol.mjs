/* SPDX-License-Identifier: AGPL-3.0-or-later
   LOFT protocol layer. Two write paths, one read model:

   (A) INPUT PATH — a player appends {tick, playerId, dx, dz, sig} to the per-beat input
       slot key `in:<beat>`. APPEND, not CAS: distinct players never contend. This is the
       architectural crux the benchmark proves — input throughput is NOT bounded by the
       state row's single-writer lease.

   (B) FOLD PATH — ANY participant (no dedicated server) may, once a beat closes, fold its
       queued inputs into the authoritative state via a SINGLE CAS on the state row
       `state`. Only one folder wins per beat (CAS); losers no-op and move on => liveness
       without a leader. The folder also extends the signed HASH-CHAIN.

   HASH-CHAIN: head_n = sha256( head_{n-1} || beat || inputDigest || stateHash_n ), signed
   by the folder. Any client recomputes step() and the hashes locally; a divergence is a
   provable fraud (see fraud.mjs). The chain is the public, verifiable transcript. */

import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { step, stateHash, genesis, serialize } from "./sim.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
export const inputDigest = (inputs) =>
  sha([...inputs].sort((a, b) => a.playerId - b.playerId || a.tick - b.tick)
    .map((i) => `${i.tick}:${i.playerId}:${i.dx}:${i.dz}`).join("|"));

export function newIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}
const signHead = (priv, head) => edSign(null, Buffer.from(head, "hex"), priv).toString("hex");
export const verifyHead = (pub, head, sig) =>
  edVerify(null, Buffer.from(head, "hex"), pub, Buffer.from(sig, "hex"));

/* chain link from previous head + this beat's fold */
export function linkHead(prevHead, beat, inputs, newStateHash) {
  return sha(`${prevHead}|${beat}|${inputDigest(inputs)}|${newStateHash}`);
}

/* initialise the room: write genesis state + genesis chain head (beat 0) */
export function initRoom(kv, numPlayers, seed = 1) {
  const g = genesis(numPlayers, seed);
  const h0 = sha(`GENESIS|${stateHash(g)}`);
  kv.cas("state", 0, { state: g, beat: 0 });
  kv.cas("chain:0", 0, { beat: 0, head: h0, stateHash: stateHash(g), inputDigest: inputDigest([]), folder: null, sig: null });
  return { genesis: g, head: h0 };
}

/* (A) a player posts an input for the current beat — APPEND, no contention */
export function postInput(kv, beat, input) { return kv.append(`in:${beat}`, input); }

/* (B) a participant attempts to fold beat `beat` -> beat+1 with a single state-row CAS.
   Returns {won, retries, head, ...}. Pure-functional fold => any honest folder agrees. */
export function tryFold(kv, beat, identity) {
  let retries = 0;
  for (;;) {
    const cur = kv.read("state");
    const v = cur.version, st = cur.value;
    if (!st || st.beat !== beat) return { won: false, reason: "beat-advanced", retries, version: v, currentBeat: st ? st.beat : null };
    const slot = kv.read(`in:${beat}`);
    const inputs = (slot.value || []);
    const next = step(st.state, inputs);
    const nsh = stateHash(next);
    const prevChain = kv.read(`chain:${beat}`).value;
    const head = linkHead(prevChain.head, beat + 1, inputs, nsh);
    const r = kv.cas("state", v, { state: next, beat: beat + 1 });
    if (r.ok) {
      const sig = identity ? signHead(identity.privateKey, head) : null;
      kv.cas(`chain:${beat + 1}`, 0, { beat: beat + 1, head, stateHash: nsh, inputDigest: inputDigest(inputs), folder: identity ? identity.publicKey.export({ type: "spki", format: "der" }).toString("hex") : null, sig });
      return { won: true, retries, beat: beat + 1, head, stateHash: nsh, state: next, inputs };
    }
    retries++;                  // someone else folded this beat first; re-read & re-evaluate
    if (retries > 64) return { won: false, reason: "cas-exhausted", retries };
  }
}

/* a verifier independently replays the whole chain from genesis and checks every head.
   Returns the first beat where the published chain diverges from honest re-execution. */
export function replayVerify(kv, numPlayers, seed, uptoBeat) {
  let st = genesis(numPlayers, seed);
  let head = sha(`GENESIS|${stateHash(st)}`);
  for (let b = 1; b <= uptoBeat; b++) {
    const slot = kv.read(`in:${b - 1}`).value || [];
    st = step(st, slot);
    const nsh = stateHash(st);
    head = linkHead(head, b, slot, nsh);
    const published = kv.read(`chain:${b}`).value;
    if (!published) return { ok: false, divergeBeat: b, reason: "missing-chain-link" };
    if (published.head !== head || published.stateHash !== nsh)
      return { ok: false, divergeBeat: b, expected: head, published: published.head };
  }
  return { ok: true, head, finalState: st };
}
