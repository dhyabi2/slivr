# slivr Sentinel — agent-to-agent protocol

`slivr sentinel` runs the coding agent **non-stop, with no human prompts**, so another agent ("Hermes")
can drive it. It does not replace the interactive REPL — it adds a mode. Zero dependencies: the transport
is stdout (events) + an append-only control file (commands).

## Start it

```
slivr sentinel "<task>" [dir]          # task as the standing directive
slivr sentinel --skill <name> [dir]    # a skill file as the standing directive
slivr sentinel ... --standing          # stay alive after the task, awaiting more directives
slivr sentinel ... --control <file>    # control file path (default: <dir>/.slivr/control.jsonl)
```

Actions auto-approve within guardrails (destructive shell commands are still hard-blocked and reported
as a `blocked` event).

## OUT — event stream (NDJSON on stdout)

One JSON object per line. Every event has `seq` (monotonic), `ts` (ms), and `t` (type):

| `t`        | fields                                   | meaning                                  |
|------------|------------------------------------------|------------------------------------------|
| `start`    | `task, dir, model, control`              | run began                                |
| `turn`     | `n, tool, args`                          | about to run a tool call                 |
| `result`   | `tool, ok, note`                         | tool finished                            |
| `control`  | `applied` (`inject`/`redirect`/`answer`/`abort`/`pause`/`resume`/`noop`) | a control command was applied |
| `blocked`  | `tool, reason, command`                  | a destructive action was refused         |
| `done`     | `summary, verified?`                     | the agent called done                    |
| `state`    | `state` (`done`/`blocked`/`error`/`aborted`/`stopped`), `summary, stopped, error, turns, tokens, cost` | terminal state of a turn |
| `warn` / `error` | `message`                          | a warning / fatal error                  |
| `standing` / `accept` | `note` / `task`                 | (`--standing`) idle / picked up new work |

## IN — control commands (append to the control file)

Append one JSON object per line. slivr drains them **between turns** (never mid tool-call) and appends an
`{"t":"ack","ref":<id>,"status":...}` line for each. Give each command a unique `id` to track its ack.

| command                                   | effect                                                     |
|-------------------------------------------|------------------------------------------------------------|
| `{"id":"..","cmd":"inject","text":"..."}` | add guidance for the next turn (trajectory kept)           |
| `{"id":"..","cmd":"redirect","text":"..."}` | stop the current direction, re-prioritize toward a new goal |
| `{"id":"..","cmd":"answer","text":"..."}` | answer a question the agent surfaced                       |
| `{"id":"..","cmd":"pause"}` / `{"cmd":"resume"}` | hold between turns / continue                        |
| `{"id":"..","cmd":"abort"}`               | finish the current tool call, persist, then stop cleanly   |

(`disrupt`→redirect, `stop`/`cancel`→abort, `guide`→inject are accepted aliases.)

## A minimal Hermes loop (pseudocode)

```js
const proc = spawn("slivr", ["sentinel", task, dir]);
proc.stdout.on("line", (l) => {
  const e = JSON.parse(l);
  if (e.t === "result" && looksOffTrack(e)) append(control, { id: id(), cmd: "redirect", text: "..." });
  if (e.t === "state") done(e.state, e.summary);
});
// steer anytime:
fs.appendFileSync(control, JSON.stringify({ id: "g1", cmd: "inject", text: "prefer TypeScript" }) + "\n");
```

## Guarantees & limits
- Steering applies only in the inter-turn window, so a half-done edit is never corrupted.
- The control file is append-only; slivr tracks a byte offset and never replays old lines (a fresh
  session starts at the file's current end). Malformed lines are skipped, never halting.
- Single controller assumed (one writer of commands). Rotate/truncate the control file between sessions.
