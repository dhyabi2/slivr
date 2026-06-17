# Audit — 100 critical issues that keep Proov from being the best coding agent

An honest architectural critique grounded in [`proov-workflow.md`](./proov-workflow.md). Issues are real gaps,
not padding. They cluster around **six systemic root causes**:

1. **Gates are gameable proxies.** The agent optimizes to *pass proov's gates*, not to satisfy the user. Every
   gate is one-shot or bounded (≤3) and several "degrade gracefully" to *skipped* — so a lazy/weak model can
   exhaust the bound or trip the skip and ship unverified work. (Goodhart's law, mechanized.)
2. **Verification is end-heavy and conditional.** Gates only run when the model calls `done`; a run that ends
   via budget/dead-end runs *none* of them. Building is blind until then.
3. **Game/web over-fitting.** The whole standard is player/enemies/HUD/levels — proov is a game-builder more
   than a general coding agent.
4. **Weak default brain, wrong escalation trigger.** Cheap model by default; the strong model fires on *stuck*,
   never on *low quality*.
5. **No real planning/understanding phase.** One undifferentiated turn loop with gates bolted on the end.
6. **Sequential, stateless, single-context.** No parallelism, no persistent memory, no phase state machine;
   O(n²) token cost.

---

## A. Planning, decomposition & understanding
1. No enforced planning gate — `task_write` is freeform; nothing rejects a shallow 1–3 step plan.
2. No mandatory repo/architecture comprehension phase before editing an existing codebase.
3. No spec/ambiguity clarification step — it guesses instead of asking the user up front.
4. The plan is never verified to actually COVER the request (no plan↔goal coverage check).
5. No dependency ordering among tasks — flat list; can't express "B needs A."
6. No design phase for non-visual work (design-first only draws *images*, only for *visual* builds).
7. Replanning fires only on failure, never on new information discovered mid-build.
8. No "beat the best-in-class" ideation — it copies the obvious approach (the DTP planning idea was skipped).

## B. Context & memory
9. Context compression is lossy/heuristic (truncates logs) — can drop critical detail; no semantic summary.
10. No persistent cross-session project memory — re-learns the repo every run.
11. No semantic retrieval (embeddings/RAG) over the codebase — grep/repo_map miss related code.
12. Whole thread is resent each turn — token cost scales with conversation length (O(n²) over a long task).
13. No structured working memory / file-change ledger surfaced to the model → re-reads, redundant edits.
14. Single linear thread — no branch/checkpoint to try an alternative and roll back.
15. No dedup of repeated tool results across turns beyond compression.

## C. Verification soundness (the gates can be beaten)
16. Most gates are ONE-SHOT or bounded ≤3 — exhaust the bound and the gate waves the work through.
17. Gates "degrade gracefully" (no Chrome / no key → skip) → silent non-verification the user can't see.
18. The done-gate runs only when the model calls `done` — budget/dead-end exits run NO gates.
19. End-heavy verification — blind building, errors compound; no per-edit verification except opt-in checks.
20. The vision checklist is itself an LLM judge — non-deterministic, can hallucinate present/absent.
21. `check_behavior` / task `check` are AGENT-authored — the party that's wrong about the code writes its test.
22. No mutation/adversarial testing — passing tests don't prove the tests constrain anything.
23. Project-checks only run DETECTED scripts — non-standard test setups read as "no checks" → unverified.
24. No regression guarantee — a later edit silently breaks an earlier "completed" task.
25. No functional verification for CLI/library/API beyond exit-0 of detected scripts.
26. `verified === null` (gate skipped) counts as SUCCESS in the oracle — ships unverified as "done."
27. No independent oracle / reference implementation to check outputs against.
28. No property-based or fuzz testing for logic-heavy code.

## D. Visual / design-first pipeline
29. Design-first FORCES image generation on every visual task — cost + latency even on trivial ones.
30. The generated reference is AI-slop; the agent is then forced to match a possibly-bad mockup ≥95%.
31. ≥95% per-asset match is brittle — penalizes legitimate creative deviation; better-but-different fails.
32. The agent defines the compare regions — it can draw lenient/empty regions to pass (gaming the gate).
33. `compare_regions` needs Chrome; no-browser → the entire visual-match gate silently skips.
34. Beyond-the-frame detection is keyword-based — trivially gamed by adding `levels`/`gameover` strings.
35. Vision verification adds a model call to EVERY `see_page {visual}` → cost/latency on a hot path.
36. Visual gates assume a canvas game — DOM/CSS UIs, SVG, charts, data-viz are poorly covered.
37. No accessibility / responsive / cross-viewport / dark-mode verification of UIs.

## E. Game-specific over-fitting
38. The verification battery is overwhelmingly game-centric (player/enemies/HUD/levels).
39. The structure genre model (2d/3d) doesn't generalize to web apps, APIs, data, mobile, CLIs.
40. klokwork/vgsds/esg-coreach are hard-wired house standards — opinionated lock-in irrelevant to most tasks.
41. Non-game web apps get only a broken/blank check — no behavioral/E2E verification.
42. No verification of typical app correctness (CRUD, auth, data integrity, state transitions).
43. The "advanced game by default" bias over-builds when the user wanted something simple.

## F. Model & cost routing
44. Default model (flash-lite) is too weak for comprehension — the eval proved it ignored the actual task.
45. Escalation trigger is liveness (stuck), not quality — a confidently-wrong cheap result never escalates.
46. No self-consistency / multi-sample voting for critical decisions.
47. No cost/latency budget surfaced to the agent so it can trade off depth vs spend.
48. Single provider; provider error → just stop (no fallback routing on outage).
49. verifyModel / imageModel are single points with no fallback.
50. No per-task model selection (cheap for boilerplate, strong for the hard core) beyond the binary escalation.

## G. Concurrency & performance
51. Strictly SEQUENTIAL one-tool-per-turn — no parallel reads, concurrent checks, or fan-out.
52. No speculative/parallel exploration of competing approaches.
53. Gates run sequentially at done (each spawns Chrome/servers) — slow, unparallelized.
54. Full-context resend each round — O(n²) tokens over a long build.
55. No incremental build/result caching — re-runs full checks every `done` attempt.
56. Browser spin-up per visual check is expensive and repeated, not pooled.
57. No streaming of partial work to the user while long checks run.

## H. Editing engine
58. Anchor-based SEAL edits fail on duplicate/ambiguous anchors → NO_ANCHOR stall loops.
59. No AST-aware editing — string edits can yield syntactically broken code caught only later.
60. No transactional multi-file refactor (cross-file rename with rollback).
61. No handling of files changing underneath (external/concurrent edits).
62. Large-file edits encode/resend inefficiently.
63. No semantic patch validation (does this edit even type-check) before moving on.

## I. Tool coverage gaps
64. No debugger / breakpoints / runtime state inspection.
65. No LSP integration — go-to-def/type-info/diagnostics rely on a custom, weaker repo_map.
66. No real dependency management (version resolution, lockfile/vuln awareness) beyond install_deps.
67. No database/migration tooling for data apps.
68. No real browser interaction (forms, navigation, auth flows) — autoplay is keypress-only.
69. No runtime log/observability inspection of the running app beyond console errors.
70. No in-loop git workflow (branch/commit/PR) — left manual/external.
71. No environment/secrets management.
72. No terminal/REPL interaction with long-running processes mid-task.

## J. Supervisor / control loop
73. Brakes are crude (round/cost caps + fingerprint) — no measure of "am I actually closer?"
74. Continuations are templated nudges, not genuine re-planning from the specific failure.
75. No cross-round learning — repeats a failed approach unless the exact fingerprint matches.
76. strongModel escalation is one round then reverts — no sustained hard mode for a hard task.
77. Overlapping/duplicated stop logic across supervisor and inner loop (the costCap:0 bug was symptomatic).
78. No resume guarantee mid-build beyond the journal — a crash loses in-flight progress.
79. The phase the agent is "in" isn't modeled — loops all return to model-call; it can thrash.

## K. Safety & security
80. `auto` approval is the DEFAULT — runs commands without prompting; the blocklist is regex denylist (bypassable via obfuscation/base64/encoding).
81. Task `check` (and run_command) execute arbitrary agent-authored shell on the host, default-auto — a prompt-injected repo can get code execution.
82. generate_image / web_fetch / model calls ship task content (possibly proprietary code) to external services — no data-egress controls.
83. No sandboxing/containerization of execution — runs with the user's privileges in their FS.
84. No prompt-injection defense — a malicious README/web page can redirect the agent.
85. No secret-scanning of what's sent to the model or written/committed.
86. Denylist (not allowlist) safety — unknown-dangerous commands pass by default.
87. No audit log of external network/file actions for the user to review.

## L. Generalization / breadth
88. Heavy JS/Node + HTML-game bias; weak for Python/Go/Rust/Java/C++/mobile/systems.
89. No monorepo/workspace awareness.
90. Single workdir sandbox — cross-repo / multi-service tasks unsupported.
91. No first-class infra/config/IaC deliverables or their verification.
92. No long-running service lifecycle management beyond start_server.

## M. Testing, CI & durable quality
93. Doesn't write durable TESTS as a default deliverable — verification is proov's ephemeral gates, not artifacts the user keeps.
94. No awareness of / integration with the project's real CI config.
95. No coverage measurement of its own changes; no "did I test the new code" check.
96. No flaky-test detection or quarantine.

## N. Observability & trust
97. The user can't see which gates ran vs were skipped — "verified" is opaque (null vs true vs false).
98. No confidence/uncertainty surfaced — `done` reads the same whether sure or guessing.
99. No human-readable per-run verification report (DTP's EXECUTION_REPORT idea wasn't adopted) or diff-and-why summary.

## O. The deepest one
100. **Every gate is gameable, and the gates are the only thing between "looks done" and "is done."** The agent
    is trained-by-construction to satisfy the *checker*, not the *user*: add the keyword to beat beyond-frame,
    draw empty regions to beat compare, let a check be skipped, exhaust a bound. Until verification is
    *independent, adversarial, and non-bypassable* — and tied to the user's real acceptance criteria rather
    than proxies — proov's ceiling is "passes its own gates," which is strictly below "is correct."

---

### The highest-leverage fixes (if you act on a few)
- **Make `verified===null` NOT count as success** (issue 26) — never report done on a skipped gate; say "unverified."
- **Run the done-gate even on non-`done` exits** (18) — verify whatever was built before stopping.
- **Quality-triggered escalation** (45) — a cheap critic escalates weak results to the strong model, not just stuck ones.
- **A real understand→plan phase with a coverage gate** (1–4) — decompose and confirm scope before building.
- **Independent verification + durable tests** (21, 93) — a separate oracle/test suite the agent can't author to pass.
- **Sandbox execution + injection defense** (80–84) — before `auto` approval is safe as a default.
- **De-game the gates** (16, 32, 34) — unbounded-until-pass with anti-gaming (random region audits, semantic not keyword checks).
