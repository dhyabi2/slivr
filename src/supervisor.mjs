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

// FINAL VERIFICATION (Block 70): run the DETERMINISTIC, re-runnable checks (per-task acceptance checks +
// project typecheck/lint/build/test) on whatever exists at exit — so EVERY outcome (success or stop) carries
// an honest verdict, not a silent stop, and "done" never reads as "verified" unless a real check passed.
// Returns { status:'pass'|'fail'|'none', ran:[], failures:[], skipped:[] }.
async function finalVerify(session, res) {
  const t = session && session.tools;
  if (!t) return { status: "none", ran: [], failures: [], skipped: [] };
  const ran = [], failures = [], skipped = [];
  try {
    if (typeof t._verifyTaskChecks === "function") {
      const tc = t._verifyTaskChecks();
      if (tc) { ran.push("task-checks"); for (const f of tc.failures || []) failures.push(`task "${f.subject}": ${f.reason}`); }
    }
    if (res && res.verified === true) {
      ran.push("project-checks");   // the in-loop verify already ran them CLEAN this round → don't re-run (one check/round)
    } else if (typeof t._hasProjectChecks === "function" && t._hasProjectChecks() && typeof t._verifyProjectChecks === "function") {
      const pc = await t._verifyProjectChecks({});
      if (pc && pc.ran) {
        ran.push("project-checks");
        // KEEP THE REAL OUTPUT (Block 78): the assertion / error text is the "detailed feedback" remediation
        // needs — not just the check name. (Skips are the toolchain genuinely being absent.)
        for (const f of pc.failures || []) failures.push(`${f.check} FAILED:\n${(f.output || "").split("\n").filter(Boolean).slice(-6).join("\n")}`.slice(0, 600));
        for (const s of pc.skipped || []) skipped.push(`${s.check} (${s.why})`);
      }
    }
  } catch (e) {
    // FAIL CLOSED (Block 78): an error INSIDE the verifier is a verification FAILURE, never a silent pass.
    return { status: "fail", ran: ["verifier"], failures: [`the verifier itself errored: ${String(e && e.message || e).slice(0, 200)}`], skipped: [] };
  }
  const status = !ran.length ? "none" : (failures.length ? "fail" : "pass");
  return { status, ran, failures, skipped };
}

// REMEDIATION continuation (Block 77): on a verification FAILURE, don't escalate the model — give the SAME
// model the detailed failures and have it GENERATE A FRESH CHECKLIST of fixes (each with a runnable check) for
// the next iteration. This is the "new workflow + improvements" the failed final-verify should produce.
export function remediationContinuation(fv, open = []) {
  const fails = (fv.failures || []).slice(0, 10).map((f, i) => `  ${i + 1}. ${f}`).join("\n") || "  (the project's checks did not pass)";
  const openList = open.length ? `\nStill-open tasks: ${open.slice(0, 6).map((t) => t.subject).join("; ")}` : "";
  return `VERIFICATION FAILED — the build does NOT pass its checks yet:\n${fails}${openList}\n\nFor the NEXT iteration, GENERATE A NEW PLAN to fix exactly these (no shortcuts, no skipping checks): call task_write with a FRESH checklist where each item fixes ONE failure above and carries a 'check' (a command that exits 0 only when that fix is verified). Then implement each fix and re-run the checks. Do NOT call done until EVERY check passes.`;
}

// When the agent built code but NOTHING verifies it (Block 78): don't accept done — make it ADD verification.
export function noVerificationContinuation() {
  return `You built code, but NOTHING verifies it — there is no passing test or check that proves it works. Do NOT call done yet. Add REAL verification: write a test in the project's test suite (or add a task_write item with a runnable 'check' — a command that exits 0 only when the behavior is correct), run it, and make it pass. Only call done once a check actually CONFIRMS the result.`;
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
  // 0 (or any non-positive) means NO cap — matches the REPL's untilDoneCostCap semantics. A bare
  // `?? Infinity` is wrong here because `0 ?? Infinity === 0`, which would stop after the first round
  // (any cost >= $0). Only a positive number is treated as a real ceiling.
  const costCap = opts.costCap > 0 ? opts.costCap : Infinity;
  const noProgressStop = opts.noProgressStop ?? 3;
  const turnOpts = opts.turnOpts || {};
  const onRound = typeof opts.onRound === "function" ? opts.onRound : () => {};
  // (model escalation removed — Block 77: a failed verification REMEDIATES on the same model, never a bigger one)
  const emit = typeof opts.emit === "function" ? opts.emit : () => {};   // workflow events for a monitor (Block 76)
  emit({ type: "run_start", task: String(task).slice(0, 160) });

  const openOf = () => (session.tools && Array.isArray(session.tools.tasks)) ? session.tools.tasks.filter((t) => t.status !== "completed") : [];
  const doneCountOf = () => (session.tools && Array.isArray(session.tools.tasks)) ? session.tools.tasks.filter((t) => t.status === "completed").length : 0;
  const totalsOf = () => (typeof session.totals === "function" ? session.totals() : { cost: 0 });
  // What got BUILT this run — any successful mutating tool. A run that built nothing (a question / a read)
  // needs no verification; a run that built code MUST be verified before it can SUCCEED (Block 78).
  const MUTATING = new Set(["edit_file", "edit_files", "edit_symbol", "create_file", "write_file"]);
  const mutatedIn = (r) => Array.isArray(r && r.trace) && r.trace.some((x) => MUTATING.has(x.tool) && x.ok !== false);
  // Run the deterministic verifier ONCE per done-round, fail-CLOSED (an internal error is a failure, not a pass).
  const safeVerify = async (r) => { try { return await finalVerify(session, r); } catch (e) { return { status: "fail", ran: ["verifier"], failures: [`the verifier errored: ${String(e && e.message || e).slice(0, 160)}`], skipped: [] }; } };
  // Is the build VERIFIED? A hard check passed, OR a soft in-loop gate (game/visual) passed, OR there was
  // nothing to verify (no build). A hard FAIL — or a build with NO passing verification — is NOT verified.
  const verifiedOk = (r, lv, built) => {
    if (r && r.verified === false) return false;
    if (lv && lv.status === "fail") return false;
    if (lv && lv.status === "pass") return true;
    if (Array.isArray(r && r.verifiedBy) && r.verifiedBy.length) return true;
    return !built;   // nothing built → nothing to verify; built-but-unverified → keep iterating
  };
  const finished = (r, lv, built) => !!(r && r.done) && openOf().length === 0 && verifiedOk(r, lv, built);

  // Final report. Uses the PER-ROUND verification result (no redundant re-check at exit — Block 78). Status is
  // binary: a run only SUCCEEDS when verified, so 'pass' iff outcome==='success'; any other exit is 'fail'.
  const finish = (outcome, rounds, res, open, totals, detail, lastVerify) => {
    const rep = report(outcome, rounds, res, open, totals, detail);
    rep.verification = (outcome === "aborted" || outcome === "error") ? null : (lastVerify || null);
    rep.verifiedStatus = outcome === "success" ? "pass" : "fail";
    if (rep.verifiedStatus === "fail") rep.verified = false;
    emit({ type: outcome === "success" ? "done" : "stop", outcome, status: rep.verifiedStatus, rounds, detail: detail || null });
    return rep;
  };

  let res = await session.runTurn(task, turnOpts);
  let rounds = 1, noProgress = 0, bestDone = doneCountOf(), lastFp = stopFingerprint(res);
  let everBuilt = mutatedIn(res);
  let lastVerify = (res.done && !res.aborted && !res.error) ? await safeVerify(res) : null;

  while (true) {
    const open = openOf();
    const totals = totalsOf();
    onRound({ round: rounds, res, open: open.length, cost: totals.cost, noProgress });
    emit({ type: "round", n: rounds, open: open.length, cost: totals.cost });
    emit({ type: "tasks", tasks: (session.tools && Array.isArray(session.tools.tasks) ? session.tools.tasks : []).map((t) => ({ subject: t.subject, status: t.status })) });

    if (res.aborted) return finish("aborted", rounds, res, open, totals, null, lastVerify);
    if (res.error) return finish("error", rounds, res, open, totals, res.error, lastVerify);
    if (finished(res, lastVerify, everBuilt)) return finish("success", rounds, res, open, totals, null, lastVerify);
    if (rounds >= maxRounds) return finish("budget", rounds, res, open, totals, `reached the ${maxRounds}-round cap, still not verified`, lastVerify);
    if (totals.cost >= costCap) return finish("budget", rounds, res, open, totals, `reached the $${costCap} cost cap, still not verified`, lastVerify);

    // NO-FORWARD-PROGRESS: the checklist didn't advance AND the turn ended the same way as last round.
    const fp = stopFingerprint(res), advanced = doneCountOf() > bestDone;
    if (!advanced && fp === lastFp) noProgress++; else noProgress = 0;
    if (noProgress >= noProgressStop) return finish("dead_end", rounds, res, open, totals, `no forward progress for ${noProgress} rounds (stuck: ${fp})`, lastVerify);
    bestDone = Math.max(bestDone, doneCountOf());
    lastFp = fp;

    // ITERATE UNTIL VERIFIED (Block 78) — always, on the SAME model. Choose the continuation from WHY it isn't
    // verified: a hard check FAILED → feed the detailed failures and ask for a new checklist of fixes; built
    // but NOTHING verifies it → ask for a real test/check; otherwise the normal targeted continuation. The
    // per-round verification (lastVerify) is reused — we do NOT check again here.
    let cont;
    if (res.done && lastVerify && lastVerify.status === "fail") {
      emit({ type: "gate", gate: "project", ok: false, detail: (lastVerify.failures || []).slice(0, 2).join(" | ").slice(0, 160) });
      cont = remediationContinuation(lastVerify, open);
    } else if (res.done && open.length === 0 && everBuilt && !verifiedOk(res, lastVerify, everBuilt)) {
      cont = noVerificationContinuation();
    } else {
      cont = continuationFor(res, open, noProgress > 0);
    }
    res = await session.runTurn(cont, turnOpts);
    everBuilt = everBuilt || mutatedIn(res);
    lastVerify = (res.done && !res.aborted && !res.error) ? await safeVerify(res) : null;
    rounds++;
  }
}
