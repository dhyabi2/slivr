# Invention Block 22 — Sentinel: autonomous agent-to-agent mode (drive slivr with another agent)

Twenty-second feature — the answer to "there's no mode for an autonomous agent to use our coding agent."
Today slivr is human-driven (a REPL). We want another agent ("Hermes") to drive it **non-stop**: hand it a
skill file as the standing directive, let it handle everything with no human prompts, stream a machine-
readable account of what it's doing, and let the controller **interact mid-run** — inject guidance, redirect,
or abort — without restarting. Most coding agents don't offer agent-to-agent control. This adds a mode; it
replaces nothing.

## The challenge, decomposed
1. **Transport** — emit a machine-readable stream of everything the agent does, and receive commands back,
   with zero dependencies (no message broker).
2. **Live steering** — let the controller inject/redirect/abort mid-run without corrupting in-progress work.
3. **Non-stop safety** — auto-approve within guardrails, never block on a human, define clean terminal states.

## Brainstorm → rank (engine at localhost:8787)
- Master "Sentinel Mode" (bidirectional JSON queues, observations out / commands in, drained at interrupt
  points, auto-approve): **85**.
- **Transport — 90** (the highest piece): NDJSON on stdout for typed events + an **append-only control file
  with byte-offset tracking** for inbound commands + an **ack** appended to the same file. Robust, zero-dep
  (`stdout` + `fs.appendFile`/`readFileSync`); the byte offset gives crash-safe, replay-free reads.
- **Live steering — 85**: a **Control Checkpoint after every tool call, before the next reasoning step** —
  `inject` updates context for the next turn (trajectory kept), `redirect` commits done work then replans,
  `abort` shuts down cleanly after persisting. **No tool call is ever interrupted mid-execution.**
- **Non-stop safety — 75**: auto-approve within a policy, emit a question event and proceed on a safe path,
  budget / no-progress stop conditions, terminal states DONE / BLOCKED / AWAITING-INPUT reported back.

## What was built
- **`src/bridge.mjs`** — `makeBridge({out, controlFile})` → `emit(type, payload)` (NDJSON to stdout),
  `poll()` (drain NEW control lines via a byte offset; skip acks + malformed lines), `ack(id, status)`.
  `applyControl(raw)` + `controlToMessage(action)` are PURE (normalize a command → a message to inject).
- **`src/loop.mjs`** — an optional `bridge`. At the **inter-turn Control Checkpoint** it drains and applies
  commands (inject/redirect/answer push a message for the next turn; abort stops; pause blocks while still
  polling), and it emits `turn` / `result` / `done` events. All guarded by `if (bridge)` so every existing
  caller is unchanged.
- **`bin/slivr.mjs`** — `slivr sentinel "<task>" [dir]` (alias `agent`): builds a Session, wires a bridge
  (stdout NDJSON + `.slivr/control.jsonl`), auto-approves within guardrails (destructive shell still hard-
  blocked → a `blocked` event), runs the turn, and emits a terminal `state`. `--skill <name>` uses a skill
  as the directive; `--standing` keeps the agent alive afterwards, awaiting the next directive (a daemon
  Hermes can keep feeding); `--control <file>` overrides the control path.
- **`docs/AGENT-PROTOCOL.md`** — the event/command schema so any controller can drive it.

## Measured
- selftest: **395 passed, 0 failed** (was 386; +9) — applyControl/controlToMessage mapping, NDJSON emit,
  byte-offset poll, ack written-and-skipped, malformed-line resilience, no-replay on a fresh session,
  emit-only mode.
- **Live end-to-end** (gemini-2.5-flash): `slivr sentinel "create a.txt, b.txt, c.txt one at a time"` while a
  simulated Hermes appended `{"cmd":"inject","text":"also create hermes.txt …"}` to the control file after the
  first result. The event stream showed `start → turn/result (×) → control(applied:inject) → … → done →
  state(done)`, the steering **took effect** (the agent created `hermes.txt` — not in the original task — in
  addition to a/b/c), and the command was **acked** back into the control file. Mid-run, no restart, no human.

## Why it disrupts
No other CLI coding agent exposes an agent-to-agent control surface: a structured event stream out plus a
live steering channel in, applied safely between turns. With Sentinel, a higher-level orchestrator can run
slivr as a non-stop worker — hand it a skill, watch the NDJSON, and inject/redirect/abort on the fly — which
is exactly what an autonomous system like Hermes needs, while the human REPL keeps working untouched.
