# Invention Block 13 — project_info: auto-detect test/run/build (work with any existing repo)

Thirteenth feature — gap #1 from the "existing codebase" assessment, built in parallel with a real
measurement that *proved cold-start comprehension is already solved* and *uncovered a CLI bug*.

## The measurement that framed it
On an unfamiliar repo (code at root + `lib/`, no `src/`), proov cold-started correctly: `repo_map` →
`grep` → `find_symbol`, locating `/api/exclude` across files (`server.js:46` → `lib/methodology.js:68`)
in 5 turns / $0.006, without reading every file. So **understanding** an unseen repo is solved (Blocks
3/6/12). The first attempt *looked* like a failure — but that was a CLI bug (below), not the agent.

## Bug found + fixed: `-p "<task>" <dir>` ignored the directory
With `-p/--prompt`, the positional directory was dropped (dir fell back to cwd), so the agent ran on the
wrong repo. Fixed: with `-p`, the first positional IS the working dir.

## The gap: verify/run need to know the project's commands
verify-repair (`--verify "<cmd>"`) and "run it" required the user to supply the command. For a repo the
agent has never seen, it should **auto-detect** how to test/run/build it.

## Brainstorm (12 ideas, avg 86.3; winner r90)
Consensus: a **confidence-ranked, manifest-driven detector** — inspect manifests, return the best
test/run/build command with a confidence score. Zero LLM, pure file inspection.

## Built
- `src/project.mjs`: `detectCommands(dir)` — inspects `package.json` scripts, `pyproject`/`manage.py`/
  pytest, `go.mod`, `Cargo.toml`, `pom.xml`/gradle, `Gemfile`, `Makefile` targets, compose — returns
  confidence-ranked `{ test, run, build, ecosystem }`.
- `src/tools.mjs`: `project_info` tool so the AGENT learns how to verify/run any repo (no guessing).
- `src/agent.mjs`: registered + a prompt directive ("call project_info to get the test/run command").
- `bin/proov.mjs`: **bare `--verify`** (no value) now auto-detects the test command for verify-repair;
  plus the `-p` dir fix.
- `src/repl.mjs`: "run it" now also runs an **existing project** (via the detected run command), not just
  artifacts proov built this session.
- `selftest.mjs`: +7 (node/go/rust/python/Makefile/empty + tool wiring). Suite 318 → 325, green.

## Measured
- Detector picks the right command across ecosystems (node→`npm test`, go→`go test ./...`,
  rust→`cargo test`, python→`pytest`, Makefile→`make test`); graceful when no manifest.
- **End-to-end:** `proov "<task>" --verify` (no value) on an unfamiliar node project →
  `auto-verify: npm test` → edit → `✓ verification passed`. verify-repair now works on any repo with no
  flag value.
