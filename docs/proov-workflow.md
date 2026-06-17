# Proov — Coding-Agent Workflow (detailed)

A deep map of how proov turns a task into a verified deliverable: every phase, action, gate, check and loop.
Rendered as BPMN-style **Mermaid** diagrams (events = circles, tasks = rectangles, gateways = diamonds).
A formal **BPMN 2.0** file (openable in [bpmn.io](https://bpmn.io)) is at [`proov-workflow.bpmn`](./proov-workflow.bpmn).

Legend: `(( ))` start/end event · `[ ]` task/action · `{ }` exclusive gateway (decision) · `[[ ]]` sub-process.

---

## 1. Top-level lifecycle (Session → Supervisor → REPL)

```mermaid
flowchart TD
  start((Task submitted<br/>REPL / driver)) --> sess[Create Session<br/>Provider + Tools + toolMap + system prompt]
  sess --> pf{DESIGN-FIRST preflight 67<br/>fresh VISUAL build · no reference ·<br/>imageModel + key?}
  pf -- yes --> gen[generate_image → reference.png<br/>draw the target BEFORE coding]
  pf -- no/skip --> sup
  gen --> sup[[Supervisor — runUntilDone]]

  subgraph SUP[Supervisor loop — drive to completion]
    sup --> round[Run ONE round → inner turn loop §2]
    round --> oracle{Completion oracle<br/>done AND verified≠false<br/>AND no open tasks?}
    oracle -- yes --> succ((SUCCESS))
    oracle -- no --> brake{Brakes / stop reason}
    brake -- rounds reach max OR cost reaches cap --> stopB((BUDGET))
    brake -- no forward progress xN, same stop-fingerprint --> stopD((DEAD_END))
    brake -- aborted / provider error --> stopE((ABORTED / ERROR))
    brake -- stuck this round --> esc[Escalate NEXT round<br/>→ strongModel ~1%]
    brake -- progress, work remains --> contn[Targeted continuation message<br/>re-read+rewrite / finish tasks / fix stop]
    esc --> contn
    contn --> round
  end

  succ --> repl[[REPL post-run §4]]
  stopB --> repl
  stopD --> repl
  stopE --> done((End — report + footer))
  repl --> done
```

---

## 2. Inner turn loop (`runLoop` — one tool call per turn)

```mermaid
flowchart TD
  t0((Round start)) --> step{steps left AND not aborted?}
  step -- no --> ret((Return result<br/>done/stopped/aborted/error))
  step -- yes --> nudgeF[Final-step / replan / control nudges as needed]
  nudgeF --> call[provider.chat → assistant text]
  call -- provider error --> perr[Record PROVIDER_ERROR] --> ret
  call --> parse[extractJSON + normalizeCall<br/>coerce ANY tool-call shape → tool,args 57]
  parse --> valid{Valid tool call?}
  valid -- no --> bad[Nudge: 'one JSON tool call'<br/>noProgress++ → cap → stop] --> step
  valid -- yes --> isDone{tool == done?}

  isDone -- yes --> gate[[DONE-GATE battery §3]]
  gate -- any gate pushes back --> step
  gate -- all pass --> fin[done=true · verified · emit] --> ret

  isDone -- no --> appr[Approval / safety gate beforeTool<br/>destructive blocklist + approval mode]
  appr -- deny --> dn[Denial nudge · denial-storm → stop] --> step
  appr -- allow --> exec[Execute tool toolMap §5]
  exec --> rec[trace + onStep + bridge events]
  rec --> mm{Result has image/pdf?}
  mm -- yes --> push[Push multimodal blocks → model SEES bytes]
  mm -- no --> guards
  push --> guards[Post-tool guards]

  subgraph G[Per-turn guards]
    guards --> thrash{Screenshot-thrash 59<br/>≥4 visual checks, no task done?}
    thrash -- yes --> tnudge[Nudge: BUILD the next task first] --> step
    thrash -- no --> efail{edit failed AND plan exists?}
    efail -- yes --> rnudge[Replan nudge once/streak] --> step
    efail -- no --> spin{Repeated identical FAILING call?<br/>anti-stuck sentinel}
    spin -- yes --> shint[Recovery hint → failStop] --> ret
    spin -- no --> step
  end
```

---

## 3. The DONE-GATE battery (verification — runs when `done` is called)

Gates run **in order**; the first that finds a problem pushes a corrective message and the turn loop continues (the agent fixes and re-calls `done`). Bounded gates cap their push-backs so a weak model can't deadlock.

```mermaid
flowchart TD
  d((done called)) --> g1{Open checklist tasks?<br/>one-shot}
  g1 -- yes --> n1[Nudge: finish AND verify each task] -.-> back((↺ back to turn loop))
  g1 -- no --> g2

  g2{PER-TASK ACCEPTANCE CHECKS 68<br/>any task.check fails? bounded≤3}
  g2 -- yes --> n2[Run each task's check cmd exit0=pass<br/>report failing ones] -.-> back
  g2 -- no/none --> g3

  g3{TASK-FIDELITY 58<br/>prompt-named repo/lib referenced<br/>NOWHERE in code? one-shot}
  g3 -- yes --> n3[Nudge: actually USE it] -.-> back
  g3 -- no --> g4

  g4{VISUAL-MATCH 64<br/>reference image present? bounded≤3}
  g4 -- no reference --> g5
  g4 -- per-asset under 95% --> n4a[List assets below 95 percent] -.-> back
  g4 -- no per-asset compare yet --> n4b[Require compare_regions ≥95% per asset] -.-> back
  g4 -- match passes --> bf{BEYOND-THE-FRAME 66<br/>single-screen reproduction?<br/>no levels/states}
  bf -- yes --> n4c[Nudge: image is a ~1% sample —<br/>build the full game] -.-> back
  bf -- no --> g5

  g5{Is it a GAME?<br/>autoplay tool + game/served}
  g5 -- served Node app 62 --> sv[[SERVED gate §3a]]
  g5 -- static game file --> stt[[STATIC gate §3b]]
  g5 -- not a game --> g6
  sv -- problem --> nS[Push back: fix + re-verify over URL] -.-> back
  sv -- ok --> g6
  stt -- problem --> nT[Push back: fix to the bar] -.-> back
  stt -- ok --> g6

  g6{PROJECT-CHECKS verify-and-repair<br/>typecheck/lint/build/test detected?}
  g6 -- fail --> n6[Feed failure back → repair<br/>bounded maxRepairs] -.-> back
  g6 -- pass / none --> ok((✓ accept done — verified))
```

### 3a. SERVED-game gate (`_verifyServedGame`, judged over HTTP — Blocks 60/62)

```mermaid
flowchart TD
  s0((start)) --> s1[start_server or reuse running → URL]
  s1 --> s2[http_request entry → is it a game? canvas+RAF]
  s2 -- not a game --> sok((ran:false — fall back to static))
  s2 --> s3{see_page url BROKEN?}
  s3 -- yes --> sx[problem: broken] --> sret((return problem))
  s3 -- no --> s4{autoPlayUrl FROZEN?<br/>no response to real input}
  s4 -- yes --> sx
  s4 -- no --> s5{served canvas art richness under 18?<br/>flat boxes}
  s5 -- yes --> sx
  s5 -- no --> s6{STRUCTURE below bar?<br/>bundleGameSource HTML+JS 61}
  s6 -- yes --> sx
  s6 -- no --> s7{asset-source / animation violation?<br/>3D: vgsds GLB + rigged}
  s7 -- yes --> sx
  s7 -- no --> s8{level solvability cert?<br/>extractLevelsUrl + certify}
  s8 -- soft-lock/unsolvable --> sx
  s8 -- ok --> s9{VISION CHECKLIST<br/>_servedCanvasDataURL + verifyModel<br/>every required thing visible?}
  s9 -- missing items --> sx
  s9 -- all present --> sokk((ran:true, problem:null))
```

### 3b. STATIC-game gate (file-based — Blocks 37–48, 61)

```mermaid
flowchart TD
  c0((start)) --> c1{see_page broken? JS syntax + console}
  c1 -- yes --> cx[problem] --> cret((push back))
  c1 -- no --> c2{autoplay FROZEN? real input}
  c2 -- yes --> cx
  c2 -- no --> c3{art richness under 18? programmer-art boxes}
  c3 -- yes --> cx
  c3 -- no --> c4{STRUCTURE below bar?<br/>analyzeStructure on bundled HTML+JS 61}
  c4 -- yes --> cx
  c4 -- no --> c5{asset-source 43 / animation 48 violation?}
  c5 -- yes --> cx
  c5 -- no --> c6{level solvability 39<br/>window.proovLevels → certify}
  c6 -- strandable --> cx
  c6 -- ok --> c7{VISION CHECKLIST 37<br/>_gameCanvasDataURL + verifyModel}
  c7 -- missing --> cx
  c7 -- all present --> cok((pass))
```

---

## 4. REPL post-run (interactive: verify → demonstrate → suggest next)

```mermaid
flowchart TD
  r0((Turn finished)) --> r1[Print summary + tasks + footer]
  r1 --> r2{Built a runnable artifact this turn?}
  r2 -- no --> r6
  r2 -- yes --> r3{Clean done AND no open tasks?}
  r3 -- no --> warn[Show command only — don't offer to open<br/>incomplete/broken] --> r6
  r3 -- yes --> r4{Kind?}
  r4 -- static .html --> rH[see_page broken-check before offering]
  r4 -- served app --> rS[_verifyServedApp 60<br/>start→fetch→broken/blank/non-2xx→stop]
  rH -- broken --> warn
  rS -- not working --> warn
  rH -- ok --> offer[Offer: run it now? → demonstrate]
  rS -- ok --> offer
  offer --> r6{NEXT-STEP SUGGESTER 63<br/>clean done · no open tasks · a game?}
  r6 -- gap found --> sug[◇ next idea: top structure gap<br/>do it now? y/N → queue task]
  r6 -- none --> rend((Prompt / end))
  sug --> rend
```

---

## 5. Tool catalog (the `toolMap` the agent acts through)

```mermaid
flowchart LR
  subgraph EDIT[Edit / write]
    e1[edit_file · edit_files · edit_symbol<br/>anchor-based SEAL]
    e2[create_file · write_file]
  end
  subgraph READ[Navigate / read]
    n1[read_file · grep · list_dir]
    n2[repo_map · find_symbol · find_refs · project_info]
  end
  subgraph RUN[Run / serve]
    x1[run_command · install_deps]
    x2[start_server · stop_server · http_request]
  end
  subgraph SEE[See / verify visually]
    v1[see_page visual+goal → VERIFIES 69<br/>what's visible + MATCH]
    v2[play_game · play_levels · autoplay<br/>file OR url 58]
    v3[generate_image 65 · see_asset · artkit]
    v4[compare_image · compare_regions ≥95% 64 · art_review · crop_image · style_profile/check]
    v5[orbit_scene · world_map · view_image · view_pdf]
  end
  subgraph PLAN[Plan / verify logic]
    p1[task_write +check 68 · plan · blueprint_*]
    p2[certify_level solvability · check_behavior asserts]
  end
  subgraph EXT[External]
    w1[web_fetch · web_search · mcp__* tools]
  end
  fin[done → DONE-GATE §3]
```

---

## 6. Every gate / check at a glance

| # | Gate / check | When | Mechanism | Block |
|---|---|---|---|---|
| — | Design-first preflight | turn-loop start (visual, no ref) | proov `generate_image` → `reference.png` | 67 |
| — | Approval / safety | before every mutating tool | destructive blocklist + approval mode (`auto` default) | — |
| — | Tool-call normalize | every turn | `normalizeCall` coerces any shape | 57 |
| — | Screenshot-thrash guard | post-tool | ≥4 visual checks, no task completed → nudge | 59 |
| — | Anti-stuck / spin | post-tool | repeated identical failing call → hint → stop | 25 |
| 1 | Open-tasks nudge | done | incomplete checklist → finish | — |
| 2 | Per-task acceptance checks | done | run each `task.check` (exit 0) | 68 |
| 3 | Task-fidelity | done | prompt-named lib/repo referenced nowhere | 58 |
| 4 | Visual-match (per-asset ≥95%) | done | `compare_regions` vs reference image | 64 |
| 5 | Beyond-the-frame | done (after match) | single-screen reproduction rejected | 66 |
| 6 | Served-game gate | done (start script) | broken/frozen/art/structure/asset/anim/level/**vision** over HTTP | 41/42/60/62 |
| 7 | Static-game gate | done (game file) | see_page/autoplay/art/structure/asset/anim/level/**vision** | 37/38/39/43/48/61 |
| 8 | Project-checks verify-repair | done | typecheck/lint/build/test, bounded repair | — |
| — | Served-app run gate | REPL offer | `_verifyServedApp` before "run it?" | 60 |
| — | Next-step suggester | REPL clean done | top structure gap → offer | 63 |
| — | Supervisor oracle / brakes | each round | done+verified+no-open / budget / dead-end / escalate | 46 |

Sources: `src/loop.mjs` (turn loop + done-gate), `src/supervisor.mjs` (rounds/oracle/brakes), `src/tools.mjs`
(tool implementations + served/visual/task-check helpers), `src/structure.mjs` (structure/beyond-frame/bundle),
`src/agent.mjs` (system prompt + toolMap), `src/repl.mjs` (post-run), `src/provider.mjs` (chat + image gen).
