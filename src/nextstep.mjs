// nextstep.mjs — the Next-Step Suggester (Block 63).
//
// When a task finishes and passes the gates, proov shouldn't just stop — it should propose the single most
// valuable NEXT thing to build. The intelligence is in being GROUNDED, not generative: every suggestion is a
// REAL gap the existing gates already found by inspecting THIS build (the production-structure standard's
// not-yet-built layers), ranked by the severity the structure model already encodes (required > optional, then
// weight). So it never hallucinates a gap and never offers generic busywork ("add tests"). Deterministic and
// cheap (no model call) — it runs AFTER done is accepted, so it never blocks finishing.
//
// Design validated via the brainstorm-exclusion methodology: the heavy version (a maintained action-template
// library + bespoke per-project value heuristics) scored practical 30; harvesting the gates' own findings and
// reusing their weights scored 85. Today it covers games (the structure standard); other project types return
// null until they grow a comparable gap signal.

import { bundleGameSource, structureGaps } from "./structure.mjs";

// Suggest the single most valuable next thing to build for a GAME, or null when there's nothing worth
// suggesting (every layer already present, or not a game). gameFile = the detected entry HTML (relative).
// fsMod/pathMod injected for testability.
export function suggestNextStep(workdir, task, { fsMod, pathMod, gameFile } = {}) {
  try {
    if (!workdir || !gameFile || !fsMod || !pathMod) return null;
    const entry = fsMod.readFileSync(pathMod.join(workdir, gameFile), "utf8");
    const src = bundleGameSource(entry, workdir, fsMod, pathMod);   // map the WHOLE game (split .js too)
    const gaps = structureGaps(src, task);
    if (!gaps.length) return null;                                  // nothing absent → stay quiet
    const top = gaps[0];
    // Phrase it as a concrete, accept-with-yes offer naming the specific layer in THIS build.
    const why = top.required
      ? "the production-structure standard still marks it absent"
      : "it's the highest-value polish layer you haven't built yet";
    return {
      id: top.id,
      // the new TASK proov would run if the user accepts
      task: `Add ${top.label} to the game, real (use the artkit), then verify and finish.`,
      // the one-line OFFER shown to the user
      offer: `add ${top.label}`,
      reason: why,
      required: top.required,
      remaining: gaps.length,
    };
  } catch { return null; }
}
