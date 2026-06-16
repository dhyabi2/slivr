// supervisor.mjs — runUntilDone (Block 46): an OUTER loop that drives a Session to GENUINE completion
// instead of stopping at the first sentinel and waiting for a human to retype "continue".
//
// Why this exists: the inner loop (runLoop) does exactly ONE turn, and its done-gate latches are one-shot
// (doneTaskNudged, gameGateDone) — so after they're spent a third `done` ships broken work with unfinished
// tasks. There is no auto-continue and no budget. The supervisor inverts ownership of "stop": after each
// turn it asks the COMPLETION ORACLE (every checklist task completed AND the turn wasn't pushed back / didn't
// fail verification); if not done it re-enters the SAME thread with a TARGETED continuation — until success,
// a budget ceiling, or a no-forward-progress dead-end. Budgets + the no-progress detector are what keep
// "keep going" from becoming the opposite failure (spinning forever).

// A turn that got stuck repeating a failing/identical action — the inner sentinels recorded it in the trace.
export function stuckMarker(res) {
  for (const x of (res && res.trace) || []) {
    if (x.failStop) return { kind: "fail", detail: x.failStop };
    if (x.spinStop) return { kind: "spin", detail: x.spinStop };
  }
  return null;
}

// A stable fingerprint of HOW a turn ended — so "the same stop, round after round" is detectable.
export function stopFingerprint(res) {
  const m = stuckMarker(res);
  if (m) return `${m.kind}:${typeof m.detail === "string" ? m.detail : JSON.stringify(m.detail)}`;
  if (res && res.stopped) return `stopped:${String(res.stopped).slice(0, 60)}`;
  if (res && res.error) return `error:${String(res.error).slice(0, 60)}`;
  if (res && res.done && res.verified === false) return "done:unverified";
  return res && res.done ? "done" : "ongoing";
}

// Build the continuation prompt for the NEXT round — never a bare "continue". Targeted by the stop reason.
export function continuationFor(res, open, forceful) {
  const openList = open.length ? `\nOPEN TASKS (${open.length}): ${open.slice(0, 8).map((t) => "• " + t.subject).join("\n")}` : "";
  const tail = `\nFinish the remaining work and VERIFY it (a game: see_page / autoplay / play_levels), mark each task completed, then call done — only when it actually works.`;
  const m = stuckMarker(res);
  if (m) {
    // the canonical escalation (both brainstorms' #1 tactic): stop retrying the failing edit — re-read, rewrite.
    return `You got STUCK repeating a failing action (${m.kind}: ${typeof m.detail === "string" ? m.detail : JSON.stringify(m.detail)}). Retrying it will NOT work. Do this instead: (1) read the target file IN FULL with read_file, (2) make a DIFFERENT, correct change — if a small patch won't apply, REWRITE the whole file to achieve the goal. Do NOT repeat the edit that kept failing.${openList}${tail}`;
  }
  if (res.done && open.length) {
    return `You called done, but ${open.length} checklist task${open.length === 1 ? " is" : "s are"} NOT complete — do not declare done with unfinished work.${openList}\nDo the next task for real, verify it, mark it completed, then keep going until ALL are done.${tail}`;
  }
  const why = res.stopped ? `You stopped early: ${res.stopped}. ` : (res.verified === false ? "Verification did not pass. " : "");
  const push = forceful ? "You have made NO forward progress for several rounds — change your APPROACH now (re-read files, decompose the task, or rewrite the broken file). " : "";
  return `${why}${push}Keep going and finish the task.${openList}${tail}`;
}

function report(outcome, rounds, res, open, totals, detail) {
  return {
    outcome,                                   // 'success' | 'budget' | 'dead_end' | 'aborted' | 'error'
    rounds,
    done: !!(res && res.done),
    verified: res ? res.verified : null,
    stopped: (res && res.stopped) || null,
    error: (res && res.error) || null,
    openTasks: open.map((t) => t.subject),
    cost: totals.cost || 0,
    totals,
    detail: detail || null,
    last: res,
  };
}

// Drive `session` to complete `task`. session must expose: runTurn(task, opts) -> result, tools.tasks
// (the checklist), and totals() -> { cost, ... }. Returns a structured final report (never throws on a
// normal stop). opts: { maxRounds, costCap, noProgressStop, turnOpts, onRound }.
export async function runUntilDone(session, task, opts = {}) {
  const maxRounds = opts.maxRounds ?? 12;
  const costCap = opts.costCap ?? Infinity;
  const noProgressStop = opts.noProgressStop ?? 3;
  const turnOpts = opts.turnOpts || {};
  const onRound = typeof opts.onRound === "function" ? opts.onRound : () => {};

  const openOf = () => (session.tools && Array.isArray(session.tools.tasks)) ? session.tools.tasks.filter((t) => t.status !== "completed") : [];
  const doneCountOf = () => (session.tools && Array.isArray(session.tools.tasks)) ? session.tools.tasks.filter((t) => t.status === "completed").length : 0;
  const totalsOf = () => (typeof session.totals === "function" ? session.totals() : { cost: 0 });
  const finished = (r) => !!(r && r.done) && r.verified !== false && openOf().length === 0;

  let res = await session.runTurn(task, turnOpts);
  let rounds = 1, noProgress = 0, bestDone = doneCountOf(), lastFp = stopFingerprint(res);

  while (true) {
    const open = openOf();
    const totals = totalsOf();
    onRound({ round: rounds, res, open: open.length, cost: totals.cost, noProgress });

    if (res.aborted) return report("aborted", rounds, res, open, totals);
    if (res.error) return report("error", rounds, res, open, totals, res.error);
    if (finished(res)) return report("success", rounds, res, open, totals);
    if (rounds >= maxRounds) return report("budget", rounds, res, open, totals, `reached the ${maxRounds}-round cap with work remaining`);
    if (totals.cost >= costCap) return report("budget", rounds, res, open, totals, `reached the $${costCap} cost cap with work remaining`);

    // NO-FORWARD-PROGRESS: the checklist didn't advance AND the turn ended the same way as last round.
    const fp = stopFingerprint(res), advanced = doneCountOf() > bestDone;
    if (!advanced && fp === lastFp) noProgress++; else noProgress = 0;
    if (noProgress >= noProgressStop) return report("dead_end", rounds, res, open, totals, `no forward progress for ${noProgress} rounds (stuck: ${fp})`);
    bestDone = Math.max(bestDone, doneCountOf());
    lastFp = fp;

    res = await session.runTurn(continuationFor(res, open, noProgress > 0), turnOpts);
    rounds++;
  }
}
