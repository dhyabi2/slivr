# cc-alt — a configurable-LLM Claude Code alternative

`cc-alt` is a real, daily-use CLI coding agent: an **interactive REPL** (and one-shot mode) that
explores a repo, makes **compact anchor-based edits** with a **live colored diff**, runs checks,
asks before risky actions, and stops when the task is verifiably done — driven by **any** model you
plug in (Claude / GPT / Gemini) over OpenRouter.

> **The real invention** is the edit engine: a *correctness-first compact-edit protocol* that lets the
> agent change code **without ever re-sending whole files** — so edits to **large files** are
> **65–89% cheaper at equal-or-better correctness** (where full-rewrite tools often *fail* — our
> baseline scored **0/18** on large files, with token runaways) and structurally **safer** (it
> refuses ambiguous anchors instead of silently editing the wrong place), on **any** model.
> Cost-neutral-to-slightly-negative on small files — see the honest per-regime breakdown.
> Full deep-dive — mechanism, measured results, honest scope, and how it was invented: **[INVENTION.md](INVENTION.md)**.

## Install

```bash
# one line — puts `cc-alt` on your PATH (pure Node >= 18, no build, no deps)
curl -fsSL https://raw.githubusercontent.com/dhyabi2/cc-alt/main/install.sh | bash

# …or run without installing
npx github:dhyabi2/cc-alt --help

# …or from a clone
git clone https://github.com/dhyabi2/cc-alt && cd cc-alt && npm link
```

## Quickstart (daily use)

```bash
# 1. set your key (preferred: env var)
export OPENROUTER_API_KEY=sk-or-...

# 3. (optional) configure the model + defaults for this repo
cc-alt --init                    # writes a starter ./.cc-alt.json
cc-alt config                    # show the resolved config and where each value came from

# 4. work
cc-alt                                                  # interactive REPL in the current repo
cc-alt "add input validation to src/calc.js"            # one-shot in the current dir
cc-alt "fix the failing test" ./myrepo --auto           # one-shot, no approval prompts
cc-alt --model anthropic/claude-sonnet-4                # REPL on Claude
```

### The REPL
Running `cc-alt` with no task opens a multi-turn session. **Conversation + tool results persist
across turns** — ask a follow-up and the agent still has the context. As it works it streams each
step (`✓ edit src/foo.js +3 -1`) with a compact colored unified diff of every change. **Ctrl-C**
interrupts the current turn without killing the session; a second Ctrl-C at the prompt exits.

REPL commands: `/help` · `/model <id>` (switch model mid-session) · `/cost` (session tokens + $) ·
`/reset` (clear context, keep cost totals) · `/exit`.

### Config (`cc-alt config`, `--init`)
Resolved with precedence **flags > `./.cc-alt.json` > `~/.cc-alt.json` > env > defaults**. Keys:
`model`, `apiKey` (prefer the `OPENROUTER_API_KEY` env var), `baseUrl` (default OpenRouter),
`approval` (`auto`|`edits`|`all`), `maxSteps`, `maxTokensPerTurn`, and `mcpServers` (see
[MCP](#mcp--connect-external-tool-servers)). **The model is fully configurable** — any OpenRouter id
works: `anthropic/claude-sonnet-4`, `openai/gpt-4o`, `google/gemini-2.5-flash`, etc.

### Safety / approval modes
- `auto` — never prompts (trusted flows / CI). **Destructive commands are still hard-blocked.**
- `edits` (default) — asks `y/N` before every `run_command` and every file edit, showing a diff
  preview for edits.
- `all` — same as `edits` (prompts for every mutating/effecting action).

Regardless of mode, an always-on blocklist **hard-refuses** obviously destructive commands
(`rm -rf /`, fork bombs, `curl … | sh` from the network, `git push --force`, `dd`/`mkfs` to a
disk, `sudo`, machine shutdown, …). `run_command` is also sandboxed to the working directory.

### CLI reference
```
cc-alt                       interactive REPL in the current directory
cc-alt "<task>" [dir]        one-shot
cc-alt config                print resolved config
cc-alt --init                write a starter ./.cc-alt.json
cc-alt mcp list              connect configured MCP servers and list their tools
cc-alt mcp add <name> -- <command...>   add an MCP server to ./.cc-alt.json
flags: --model <id>  --approval <auto|edits|all>  --auto  --plan  --dir <path>  --max-steps <n>
       --baseline (one-shot full-rewrite harness, for the benchmark)  --help  --version
```

(`node bin/agent.mjs "<task>" <dir> [--baseline]` is still supported for the original benchmark.)

### Orchestration, plan-mode & tasks

The agent has four extra capabilities for non-trivial, multi-step work:

**`parallel` — fan-out orchestration.** The model can call `parallel` to run several **independent**
subtasks as their *own* sub-agents *concurrently* (up to **4** at a time, **one level deep** — a
sub-agent cannot fan out further). The main agent decomposes → fans out with `parallel` → integrates.
```jsonc
{"tool":"parallel","args":{"tasks":["research how X works","find every call site of Y"]}}
// returns: [{task, summary, done, turns}, …]
```
⚠️ **Shared-workdir caveat:** all sub-agents share the *same* working directory, so `parallel` is
only safe for **independent** work — research/exploration in parallel, or edits to **disjoint** files.
Never parallelize subtasks that touch the same file or depend on each other's output (you'll get
races / lost writes). For sequential or overlapping work the agent edits one tool-call at a time.

**`--plan` / `/plan` — plan-mode.** When on, the agent must first call `plan` with a numbered list of
concrete steps; **all edits and commands are blocked until a plan exists and is approved.** The harness
prints the plan and asks `proceed? [y]es / [e]dit / [n]o` — `edit` lets you type a revised plan, `no`
aborts. Under `--auto` the plan is **auto-approved** but still shown.
```
cc-alt --plan "refactor the auth module"        # interactive: review the plan, then it executes
cc-alt --plan --auto "add a healthcheck route"  # shows the plan, auto-approves, executes
# REPL: /plan [on|off]   toggle for the session (re-planned each request)
```

**`task_write` — live task checklist.** The agent maintains a to-do list it updates as it works; the
UI renders it live (`☐` pending · `◐` in_progress · `✓` completed), keeping exactly one task
`in_progress`, and prints a final summary at the end.
```jsonc
{"tool":"task_write","args":{"tasks":[
  {"id":"1","subject":"explore the codebase","status":"completed"},
  {"id":"2","subject":"apply the fix","status":"in_progress"},
  {"subject":"run the tests","status":"pending"}
]}}
```

**`--auto` — no prompts.** Skips *all* approval prompts (edits, commands, **and** plan approval) while
the destructive-command **blocklist still fires** (`rm -rf /`, `sudo`, `curl … | sh`, etc. are refused
even in `--auto`).

### MCP — connect external tool servers

cc-alt is an **MCP (Model Context Protocol) client** (stdio transport), the same extensibility
Claude Code has. Point it at any MCP server and that server's tools become callable by the model as
**namespaced tools** `mcp__<server>__<tool>` — they're appended to the system prompt (name + one-line
description + a compact input-schema hint) and dispatched over JSON-RPC 2.0 to the server process.

Configure servers in `./.cc-alt.json` (or `~/.cc-alt.json`) under an `mcpServers` block — the same
shape Claude Desktop uses:
```jsonc
{
  "model": "anthropic/claude-sonnet-4",
  "mcpServers": {
    "everything": {                                  // reference test server (echo/add/…)
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "env": {},                                     // optional extra env for the child
      "disabled": false                              // set true to keep the entry but skip it
    },
    "fs": {                                           // filesystem server scoped to a dir
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    }
  }
}
```
Then:
```
cc-alt mcp list                                       # connect + print discovered tools per server
cc-alt mcp add weather -- npx -y some-weather-mcp     # write a server entry into ./.cc-alt.json
cc-alt "use mcp__everything__echo to echo 'hi'"       # the model calls the namespaced tool
```
When the REPL/one-shot starts it connects every enabled server, surfaces their tools, and **kills the
child processes cleanly on exit**. A broken or missing server is reported and skipped — it never blocks
the rest. If no `mcpServers` are configured, nothing changes and cc-alt behaves exactly as before.

### Multimodal — let the model SEE images and READ PDFs

cc-alt can attach images and PDFs to the conversation so a vision model actually looks at them. Two
tools (both sandboxed to the workdir):

- `view_image({path})` — png/jpg/jpeg/gif/webp/bmp. The loop pushes a user message whose `content`
  is a block array `[{type:'text'},{type:'image_url',image_url:{url:'data:image/<ext>;base64,…'}}]`.
- `view_pdf({path})` — the loop pushes `[{type:'text'},{type:'file',file:{filename,file_data:'data:application/pdf;base64,…'}}]`
  and the provider auto-attaches OpenRouter's `file-parser` plugin (`{id:'file-parser',pdf:{engine:'pdf-text'}}`)
  whenever a PDF is in context, so the PDF text is extracted for the model.

Use a **multimodal model** (e.g. `google/gemini-2.5-flash`). Just ask in plain language:
```
cc-alt "view_image screenshot.png and describe the error dialog" --auto
cc-alt "view_pdf spec.pdf and summarize section 3" --auto
```
Verified live: the agent read the word in a generated PNG and the colors, and extracted text from a
PDF via the file-parser plugin. **Rough edge:** PDF support depends on OpenRouter's plugin and the
chosen model; `pdf-text` handles text PDFs (not scanned-image PDFs — those need an OCR engine). If a
model can't ingest the file block it will say so rather than hallucinate; fall back to extracting
text yourself (`pdftotext`) and pasting it.

### Skills — reusable prompt templates (`/skills`, slash-commands)

A skill is a Markdown file = a saved prompt you can run by name. Discovery order: **`./.cc-alt/skills/*.md`
(project)** then **`~/.cc-alt/skills/*.md` (user)**; a project skill shadows a user skill of the same
name. Each file: an optional `# Title`, an optional `<!-- description: … -->` (or `---`/frontmatter),
and a body where `$ARGS` / `{{args}}` is replaced by the user's args and `$1 $2 …` by positional words.

```
cc-alt skills                       # list discovered skills (name + description)
cc-alt skill review                 # run a skill one-shot
cc-alt skill commit "context here"  # args fill $ARGS / $1 …
```
In the REPL:
```
/skills              list skills
/run review          run a skill as a turn
/review              same — /<name> runs a skill if it isn't a built-in command
```
Ships with three examples under [`.cc-alt/skills/`](.cc-alt/skills/): `review.md` (review the staged
diff), `test.md` (find + run the suite, fix failures), `commit.md` (write a message + commit). Drop
your own `.md` files in `./.cc-alt/skills/` to add more — no code changes.

Example skill (`.cc-alt/skills/review.md`):
```markdown
# Review staged diff
<!-- description: review the staged git diff for bugs and issues -->
Review the staged git changes for bugs and edge cases. Extra focus: $ARGS
Report concrete findings; do NOT edit anything.
```

### Background & scheduled tasks

Run a task in a **detached** process (it keeps running after the command returns), or schedule one
for later. State lives under `~/.cc-alt/` (`jobs/<id>.json` + `jobs/<id>.log`, and `schedule.json`).

```
cc-alt bg "fix the failing test and commit" ./repo   # detached; runs cc-alt one-shot --auto
cc-alt jobs                                           # list jobs: id, status (queued/running/done/failed), task
cc-alt jobs --watch                                   # repaint every 2s
cc-alt logs <id>                                      # print that job's captured log

cc-alt schedule "run the nightly check" --in 2h       # also: --at <ISO>  or  --cron "*/5 * * * *"
cc-alt schedule list                                  # list scheduled jobs + next run time
cc-alt scheduler                                      # foreground poller that fires due jobs
```
**Honest about the design:** `cc-alt bg` spawns a real detached child (`spawn(..., {detached:true,
stdio:'ignore'})`) on **macOS/Linux** — it has not been hardened for Windows. `cc-alt scheduler` is a
**simple foreground sleep-loop poller** (default every 30s; `--every <sec>` to change), **not a system
daemon**: scheduled jobs only fire while the poller is running, so keep it running (or background it
with your shell / a launchd/systemd unit). When the poller hits a due job it spawns it in the
background exactly like `cc-alt bg`; once-jobs are marked `done`, cron-jobs are rescheduled to their
next time. The built-in cron parser supports the common 5-field forms (`*`, `*/n`, `a,b`, `a-b`).

---

## Why it exists (the harness-level claim)

It exists to test ONE claim at the **harness level** (not model-vs-model, not model-building):

> Swap *only* the edit/context protocol — keep the same model, tools, and loop — and a
> **compact anchor-based edit protocol** matches task success at **lower session cost** than the
> naive **full-file rewrite** protocol that Claude-Code-style harnesses use. The win grows with
> file size and multi-edit sessions.

## The two harnesses (only one thing differs)
| | cc-alt | baseline (Claude-Code-style) |
|---|---|---|
| model | configurable (same) | configurable (same) |
| tools | read_file, list_dir, grep, run_command (same) | same |
| loop | one JSON tool-call/turn (same) | same |
| **edit protocol** | **compact**: `{anchor, replacement, op}` via SEAL; failure → small repair packet | **naive**: re-read whole file → `write_file` ENTIRE new content |

The compact applier (`src/seal.mjs`) is **vendored read-only** from
`better-cc-fresh/src/seal.mjs` (attributed in-file). It only applies on a UNIQUE exact/normalized
match, rejects ambiguous anchors, and on a miss returns a compact **repair packet** (nearest real
spans + a fix instruction) — it never re-sends the file. That compact-edit protocol is the entire
harness-level advantage under test.

## Measured head-to-head (REAL numbers, ground-truth oracles)

Each task is seeded into a fresh repo; both harnesses run on the SAME model; a behavioral oracle
executes the resulting code and asserts observable behavior (exit 0 == success). Raw rows in
`bench/results.json`.

### `google/gemini-2.5-flash` — full suite (8 tasks)

| harness | success | total tokens | total cost | total turns | edit failures |
|---|---|---|---|---|---|
| **cc-alt** | **7/8** | **27,406** | **$0.01126** | 35 | 0 |
| baseline | 7/8 | 580,322 | $0.31099 | 82 | 0 |

**Equal success (7/8 each) at 96.4% lower total cost** on the same model. Cost saved by file-size
regime: large-single **99.3%**, small-single **66.4%**, small-multi **56.5%**, medium-single 5.1%.

Each harness failed exactly one task, for opposite reasons that illustrate the thesis:
- **baseline** failed `fix-bug-largefile`: full-rewriting the 246-line file every turn ran away to
  521k tokens, hit the step cap, and never converged — the runaway-context failure mode.
- **cc-alt** failed `config-constant`: the model emitted **syntactically invalid code**
  (`export import {...}`) — a *model* error, not a harness one (cc-alt made the edits cleanly in 3
  turns with 0 edit failures). An earlier version of cc-alt failed this task with 15 edit failures
  because it lacked a file-creation tool; adding `create_file` fixed that harness gap (the remaining
  failure is purely the model writing bad JS).

Per-task rows are in `bench/results.json`.

### `anthropic/claude-sonnet-4` — small-file subset (3 tasks, budget-limited)

| harness | success | total tokens | total cost | total turns |
|---|---|---|---|---|
| cc-alt | 3/3 | 22,834 | $0.09227 | 22 |
| baseline | 3/3 | 22,589 | $0.09304 | 24 |

Deliberately run on only the **small** tasks (no large-file blowup) to cap spend. Result: a **tie**
— both 3/3, cost within **0.8%**. This is the honest flip side: **on small files the compact-edit
advantage is negligible** regardless of model. The big cost win is a large-file / multi-edit
phenomenon, not a universal one. (Raw: `bench/results-sonnet-small.json`.)

### The headline: large file, single bug fix (`fix-bug-largefile`, 246-line module)
| harness | success | tokens | cost | turns |
|---|---|---|---|---|
| **cc-alt** | **PASS** | 5,912 | **$0.00201** | 3 |
| baseline | FAIL | 521,859 | $0.28859 | 16 (hit cap) |

On a large file the baseline doesn't just cost more — it **derails**: re-reading and re-writing the
whole 246-line file every turn burned **521k tokens**, hit the step cap, cost ~**$0.29**, and still
failed the oracle. cc-alt read once, made one targeted edit, verified, and finished: **99.3%
cheaper AND higher success**. This is the clearest expression of the thesis.

### Where the win is marginal or NEGATIVE (honest)
On a **tiny single-edit file** (`fix-offbyone`, 7 lines) cc-alt was **~73% MORE expensive**
(4,344 vs 2,163 tokens) — both passed. A full rewrite of a 7-line file is trivially cheap, while
the compact protocol pays overhead (verbose anchors, an extra exploration turn). **The advantage
is conditional on file size / edit locality.** It pays off on large files and multi-edit sessions
where the baseline keeps re-sending large file bodies; it is a net cost *loss* on tiny files.

## The precise sense in which it's a better Claude Code alternative
Same model, same capability — **equal-or-better task success at dramatically lower session cost on
large-file and multi-edit work**, because it never re-sends whole files to make a change and recovers
from failed edits via a compact structured packet instead of re-showing the file. On small files the
edge disappears or reverses, so the honest pitch is: *cheaper where it matters (big files, long
sessions), neutral-to-slightly-worse on trivial edits.*

## Honest limits
- **Small n** (8 tasks), and the LLM is nondeterministic — numbers are directional, not p-values.
- The cost win is **conditional**: large/locality-friendly edits win big; tiny single edits lose.
- A failing baseline run that hits the step cap inflates its token/cost numbers — that *is* a real
  harness failure mode of full rewrites (runaway context), but it makes aggregate "X% cheaper"
  sensitive to how many baseline runs blow up. Per-task rows (in `results.json`) are the honest view.
- The applier is correctness-first but JS/code-shaped; it is not a general semantic refactor engine.

## Layout
- core: `src/provider.mjs` `src/tools.mjs` `src/loop.mjs` `src/agent.mjs` (`Session`) `src/baseline.mjs` `src/seal.mjs` (vendored)
- daily-use layer: `src/config.mjs` (layered config) · `src/repl.mjs` (interactive session) ·
  `src/diff.mjs` (unified-diff renderer) · `src/safety.mjs` (blocklist + approval) · `src/ui.mjs` (colors/footer)
- MCP client: `src/mcp.mjs` (stdio JSON-RPC client + tool catalog) · `test/stub-mcp.mjs` (local test server)
- multimodal: `src/multimodal.mjs` (image/pdf block builders + pdf-plugin) · tools `view_image`/`view_pdf` in `src/tools.mjs`
- skills: `src/skills.mjs` (discovery + arg substitution) · `.cc-alt/skills/*.md` (example prompts)
- background/scheduled: `src/jobs.mjs` (store + duration/cron parsing) · `src/scheduler.mjs` (detached spawn + poller)
- `bin/cc-alt.mjs` — main CLI · `bin/agent.mjs` — original benchmark CLI · `demo.mjs` — live side-by-side · `selftest.mjs` — deterministic (no LLM)
- `bench/tasks.mjs` `bench/run.mjs` `bench/results.json` · `SPEC.md`

## Run it
```
node selftest.mjs                                   # 145 deterministic tests, no API key
cc-alt                                              # REPL (after `npm link`)
node bin/cc-alt.mjs "<task>" ./repo --auto          # one-shot without install
MODEL=google/gemini-2.5-flash node demo.mjs         # live side-by-side (needs OPENROUTER_API_KEY)
MODEL=google/gemini-2.5-flash node bench/run.mjs     # full head-to-head benchmark
```
Reads `OPENROUTER_API_KEY` from the environment, or falls back to `web/.env.local`.

### Tests
`selftest.mjs` is fully deterministic (no LLM) and covers: the SEAL edit protocol, the tool
sandbox, the stubbed agent loop, **config resolution/merge precedence**, the **destructive-command
blocklist**, the **diff renderer**, **REPL command parsing**, UI formatting, the **approval
gate**, the **MCP stdio client** (against a local stub server — connect, `tools/list`,
`tools/call`, namespacing, and `Session` tool-registration/dispatch), the **multimodal block
builders** (image/pdf content arrays from fixture files + pdf-plugin detection), **skill discovery +
arg substitution**, and the **jobs/schedule store** (duration + cron parsing, `tickScheduler` firing
due jobs against a temp HOME). 145 checks, all green.
