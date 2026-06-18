# Audit — 20 critical issues in the final verifier (`finalVerify` + binary status + remediation)

Scope: `supervisor.mjs` `finalVerify()` / `finish()` / `remediationContinuation()`, `tools.mjs`
`_verifyProjectChecks()` / `_runTaskCheck()` / `_verifyTaskChecks()`. Why it's "not 100% effective": the
verifier **fails OPEN** in many paths (reports `pass` when it verified nothing or swallowed a failure), and
the new binary `pass`/`fail` collapse hides that. The single theme: **`pass` currently means "nothing we
happened to run failed," not "the build is correct."**

## A. Fails OPEN — reports `pass` without verifying (the core defect)

1. **Verifier crash → `pass`.** `finish()` does `try { fv = await finalVerify(...) } catch { fv = null }`, and
   `null` → not `fail` → **`pass`**. Any exception in the verifier (OOM, an uncaught execSync error) is read
   as success. A verifier MUST fail **closed**.
2. **No checks at all → `pass`.** `finalVerify` returns `status:"none"` when nothing ran; binary collapse maps
   `none` → `pass`. A project with **no test suite** is reported "verified ✓" having verified nothing.
3. **Timeout → skip → `pass`.** `_verifyProjectChecks` treats `ETIMEDOUT` as a graceful **skip**, not a
   failure. A hanging/slow test suite (often a *real* bug — a deadlock, an infinite loop) reads as verified.
4. **Missing toolchain / deps → skip → `pass`.** A repo never `npm install`ed → `npm test` errors with
   "cannot find module" → matched by the skip regex → **skipped → pass**. The most common "it doesn't even
   run" state reports as verified.
5. **The skip regex swallows REAL failures.** The graceful-skip match is broad —
   `command not found|missing script|: not found|no such file|ENOENT|cannot find module`. A genuine test
   failure whose output contains `ENOENT` / "no such file" (e.g. a test asserting a file should exist and it
   doesn't — a true regression) is **misclassified as a skip → pass**.
6. **Non-standard test setups → "no checks" → `pass`.** Only *detected* scripts run (package.json
   typecheck/lint + detectCommands test/build). A repo with real but non-standard tests (a `Makefile check`,
   a `bin/test`, `pytest` not wired to a script) reads as unverified-`pass`.
7. **Game / visual / web domain is EXCLUDED.** `finalVerify` runs only task-checks + project-checks. A game
   (proov's headline use case) has **neither** → `none` → `pass`. The in-loop game/vision gates that *did*
   run aren't counted and aren't re-run. The primary product ships "verified" with zero hard verification.

## B. Loses the detail — undermines the remediation it's supposed to feed

8. **The actual failure output is THROWN AWAY.** `_verifyProjectChecks` captures each failure's `output`
   (the assertion error, file:line — last 1800 chars), but `finalVerify` only pushes `` `${f.check} failed` ``
   — i.e. **"test failed"**, discarding the real message. The remediation that's meant to give "detailed
   steps and feedback" gets only the check's *name*. This directly defeats the feature's purpose.
9. **`res.verified === false` does NOT trigger remediation.** The loop runs `remediationContinuation` only
   when `fv.status === "fail"`. But the report sets `verifiedStatus = "fail"` also when `res.verified ===
   false` (the in-loop verify failed) even if `finalVerify` is `none`/`pass`. So the final label says **fail**
   while the next iteration got the **generic** continuation, not the detailed remediation. Inconsistent.
10. **Remediation only fires on `res.done`.** A run that stalls (maxRounds / dead-end) **without** the agent
    calling `done` never reaches the `if (res.done)` finalVerify → no remediation feedback at all; it just
    stops.
11. **Remediation doesn't bind fixes to the failures.** It asks for "a NEW checklist" but nothing ensures the
    new checks actually cover the *prior* failures — the agent can produce unrelated green checks and "pass."
12. **No proof the previously-failing check now passes.** After a remediation round it only re-checks the
    aggregate; a *different* green ≠ the original failure fixed.

## C. Gameable — the agent verifies its own work

13. **Agent-authored checks can be vacuous.** Task `check`s are written by the agent: `check:"true"`,
    `check:"echo ok"`, `check:"exit 0"` all pass. The verifier runs them faithfully and reports `pass`; it has
    no way to tell a real check from a no-op.
14. **A missing-tool check silently passes.** `_runTaskCheck` skips on exit 127 / "not found" → an agent (or
    a typo) whose check invokes a nonexistent command is **skipped = pass**.
15. **No defense against weakened/deleted checks.** Under remediation pressure the agent can change the
    failing assertion (`toBe(5)`→`toBe(4)`), add `.skip`, or delete the test — and the verifier happily flips
    to `pass`. The prompt says "don't cheat," but nothing **enforces** it.

## D. Coverage & soundness gaps

16. **No coverage of the change.** A test suite that passes but never exercises the new code → `pass`. The
    verifier doesn't check that anything actually tests the diff.
17. **Language/check-type gaps.** typecheck/lint detection is **node-only** (reads package.json scripts);
    non-node projects get only test/build. A Go/Rust/Python build that compiles but is untested, or lacks the
    static checks, is claimed as a full `pass`.
18. **`res.verified === true` skips re-verification.** `finalVerify` trusts the in-loop verify and won't
    re-run project-checks — so state that changed *after* that in-loop verify (a later tool edit, a left-over
    running server, generated artifacts) is never re-checked at exit.

## E. Execution hazards

19. **Checks run multiple times, unsandboxed, with side effects.** `_verifyTaskChecks` is called by the
    oracle (`taskChecksOk`), by `finalVerify`, AND by the in-loop gate — the same commands run 3×+ per round;
    project-checks run per-done-round *and* again at `finish()`. They execute in the workdir on the host (no
    sandbox), so tests that bind ports / write a DB / mutate files corrupt subsequent checks and the repo,
    and flaky checks compound.
20. **Whack-a-mole non-convergence + cost.** Remediation runs the **full** test suite every failed done-round;
    if each round surfaces a *different* failure, the no-progress fingerprint keeps resetting, so it runs to
    `maxRounds` (re-running the whole suite each time) without ever converging — slow and expensive, and it
    still exits `fail` with no resolution.

---

## The few fixes that matter most
- **Fail CLOSED, not open** (#1, #2): a verifier exception or "nothing ran" must NOT be `pass`. Reintroduce a
  third truth — `unverified` — *internally* (you can still SHOW only pass/fail to the user, but never call an
  un-run build "verified"); or require at least one real check to claim `pass`.
- **Don't swallow real failures** (#3, #4, #5): a timeout and a non-zero exit are FAILURES, not skips; only a
  truly-absent toolchain skips, and even then it should be reported as "couldn't verify," not "passed."
- **Keep the failure OUTPUT** (#8): pass `f.output` (assertion text, file:line) into
  `remediationContinuation`, not just the check name — that's the "detailed feedback" the feature promises.
- **Verify the GAME/web domain** (#7): re-render + re-check the game/served gate at exit, or the headline use
  case is never hard-verified.
- **Anti-gaming** (#13–15): detect vacuous checks (a `check` with no assertion / `true`/`exit 0`), and flag a
  remediation round where a previously-failing test was *removed or weakened* rather than fixed.
- **Run checks ONCE per round** (#19), in order, and reuse the result across the oracle / finalVerify / gate.
