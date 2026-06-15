/* SPDX-License-Identifier: AGPL-3.0-or-later
   LOFT fraud proof — the cheat-resistance LOFT has that Croquet/relay protocols do not.
   A folder who posts a state hash that does NOT equal the honest step() output is
   committing fraud. Because the transition is deterministic and the inputs are public
   (append log), ANY observer can challenge. We adjudicate the dispute the optimistic-
   rollup way: INTERACTIVE BISECTION over the disputed beat range, then ON-CHAIN-style
   single-step re-execution of the ONE pinpointed tick — O(log N) messages, O(1) compute
   to settle, no trusted server.

   The disputed object is a sequence of per-beat state hashes h[0..N] that the defender
   published. The challenger claims a different h'[0..N]. They agree on h[0] (genesis) and
   disagree on h[N]. Bisection finds the least i where they first disagree; at that point
   they AGREE on h[i-1] but DISAGREE on h[i]. The arbiter re-executes exactly one step from
   the agreed pre-state and the public inputs of beat i — whoever's h[i] matches wins; the
   other is slashed. The arbiter never replays the whole game. */

import { step, stateHash } from "./sim.mjs";

/* interactive bisection: returns the first beat index where the two hash transcripts
   diverge. messages counted = number of midpoint probes ~ ceil(log2(N)). */
export function bisect(defenderHashes, challengerHashes) {
  let lo = 0, hi = defenderHashes.length - 1, probes = 0;
  if (defenderHashes[lo] !== challengerHashes[lo]) return { diverge: 0, probes, reason: "disagree-at-genesis" };
  if (defenderHashes[hi] === challengerHashes[hi]) return { diverge: -1, probes, reason: "transcripts-agree" };
  // invariant: agree at lo, disagree at hi -> binary search the first-disagreement
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1; probes++;
    if (defenderHashes[mid] === challengerHashes[mid]) lo = mid; else hi = mid;
  }
  return { diverge: hi, probes };           // first beat of disagreement
}

/* single-step arbiter: given the AGREED pre-state at beat i-1 and the public inputs of
   beat i, recompute the honest post-hash and decide who told the truth. This is the only
   execution the arbiter performs — O(1). Returns the verdict + the honest hash. */
export function adjudicate(agreedPreState, beatInputs, defenderClaimHash, challengerClaimHash) {
  const honest = stateHash(step(agreedPreState, beatInputs));
  return {
    honestHash: honest,
    defenderHonest: defenderClaimHash === honest,
    challengerHonest: challengerClaimHash === honest,
    slashed: defenderClaimHash === honest ? "challenger" : (challengerClaimHash === honest ? "defender" : "both"),
  };
}

/* end-to-end dispute: a cheater publishes a tampered transcript; an honest party challenges.
   Drives bisect -> adjudicate and returns the settled outcome + message/compute cost. */
export function runDispute({ honestStates, honestHashes, tamperedHashes, beatInputsAt }) {
  const b = bisect(honestHashes, tamperedHashes);   // honest = challenger here
  if (b.diverge < 0) return { settled: false, reason: "no-divergence" };
  const i = b.diverge;
  const pre = honestStates[i - 1];                  // the AGREED pre-state (both sides match here)
  const verdict = adjudicate(pre, beatInputsAt(i), tamperedHashes[i], honestHashes[i]);
  return {
    settled: true, divergeBeat: i, bisectionProbes: b.probes,
    arbiterSteps: 1, verdict,
    cheaterCaught: verdict.slashed === "defender", // defender (tampered transcript) slashed
  };
}
