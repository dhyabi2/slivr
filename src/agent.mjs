// agent.mjs — cc-alt harness (THE alternative). Compact-edit protocol via SEAL.
//
// Tools: read_file, list_dir, grep, run_command, edit_file (anchor/replacement/op).
// The agent edits with SMALL anchors and gets a COMPACT repair packet on failure — it never
// re-reads or re-sends a whole file to make a change. This is the harness-level cost advantage.

import fs from "node:fs";
import path from "node:path";
import { Provider } from "./provider.mjs";
import { Tools } from "./tools.mjs";
import { runLoop } from "./loop.mjs";

const SYSTEM = `You are cc-alt, a precise coding agent that edits a real repository.

You work ONE tool call at a time. Respond with EXACTLY ONE JSON object, nothing else:
  {"tool":"read_file","args":{"path":"rel/path.js"}}
  {"tool":"list_dir","args":{"path":"."}}
  {"tool":"grep","args":{"pattern":"regex","path":"."}}
  {"tool":"run_command","args":{"command":"node check.js"}}
  {"tool":"edit_file","args":{"path":"f.js","anchor":"<verbatim existing lines>","replacement":"<new lines>","op":"replace"}}
  {"tool":"create_file","args":{"path":"new.js","content":"<full content of a brand-NEW file>"}}
  {"tool":"done","args":{"summary":"what you did"}}

EDIT PROTOCOL (important — this is how you keep edits cheap and correct):
- "anchor" must be a SMALL, UNIQUE, VERBATIM snippet copied character-for-character from the
  file (enough lines to be unique, but no more). "replacement" is the new text for that snippet.
- op is "replace" (default), "insert_after", or "insert_before".
- Do NOT rewrite whole files. Make targeted edits with edit_file.
- To create a NEW file that does not exist yet, use create_file (there is no anchor to match yet).
  Use edit_file (NOT create_file) for any file that already exists.
- If an edit fails you get a compact repair packet with the nearest real spans. Fix your anchor
  from that packet and retry — do NOT re-read the whole file unless the packet says wrong-file.

Workflow: explore (list_dir/read_file/grep) → make targeted edits → if the task has a check
script, run it to verify → call done. Keep going until the task is verifiably complete.`;

export function makeAgent(workdir, opts = {}) {
  const provider = new Provider(opts);
  const tools = new Tools(workdir);
  const toolMap = {
    read_file: (a) => tools.read_file(a),
    list_dir: (a) => tools.list_dir(a),
    grep: (a) => tools.grep(a),
    run_command: (a) => tools.run_command(a),
    edit_file: (a) => tools.edit_file(a),
    create_file: (a) => tools.create_file(a),
  };
  return { provider, tools, toolMap };
}

export async function runAgent(task, workdir, opts = {}) {
  const { provider, tools, toolMap } = makeAgent(workdir, opts);
  return runLoop({
    provider, tools, toolMap, systemPrompt: SYSTEM, task,
    maxSteps: opts.maxSteps ?? 16, onStep: opts.onStep,
  });
}

// A Session bundles a Provider + Tools + persistent message thread so multi-turn REPL use keeps
// context. The toolMap is wrapped so edits capture a before/after diff (for streaming + approval).
export class Session {
  constructor(workdir, opts = {}) {
    this.workdir = path.resolve(workdir);
    this.opts = opts;
    this.provider = new Provider(opts);
    this.tools = new Tools(workdir);
    this.messages = null; // seeded on first run; persists across turns
    this.maxSteps = opts.maxSteps ?? 16;
    // diff capture: edit tools record { path, before, after } on the session for the UI to read.
    this.lastDiff = null;
    this.toolMap = this._buildToolMap();
  }

  _readSafe(rel) {
    try { return this.tools.read_file({ path: rel }); } catch { return { ok: false }; }
  }

  _buildToolMap() {
    const t = this.tools;
    const captureEdit = (kind, fn) => (a) => {
      const rel = a?.path;
      const before = rel && kind !== "create_file" ? (this._readSafe(rel).content ?? "") : "";
      const res = fn(a);
      if (res && res.ok && rel) {
        const after = this._readSafe(rel).content ?? "";
        this.lastDiff = { path: rel, before, after, kind };
      } else {
        this.lastDiff = null;
      }
      return res;
    };
    return {
      read_file: (a) => t.read_file(a),
      list_dir: (a) => t.list_dir(a),
      grep: (a) => t.grep(a),
      run_command: (a) => t.run_command(a),
      edit_file: captureEdit("edit_file", (a) => t.edit_file(a)),
      create_file: captureEdit("create_file", (a) => t.create_file(a)),
    };
  }

  setModel(model) { this.provider.model = model; this.opts.model = model; }

  // Reset the conversation but keep the same provider session totals unless hard=true.
  reset({ hard = false } = {}) {
    this.messages = null;
    if (hard) {
      this.provider.calls = 0; this.provider.promptTokens = 0;
      this.provider.completionTokens = 0; this.provider.cost = 0; this.provider.log = [];
    }
  }

  totals() { return this.provider.totals(); }

  // Run ONE user turn against the persistent thread. opts: { onStep, beforeStep, signal }.
  async runTurn(task, { onStep, beforeTool, signal } = {}) {
    const res = await runLoop({
      provider: this.provider,
      tools: this.tools,
      toolMap: this.toolMap,
      systemPrompt: SYSTEM,
      task,
      maxSteps: this.maxSteps,
      seedMessages: this.messages || undefined,
      onStep,
      beforeTool,
      signal,
    });
    this.messages = res.messages; // persist the thread for the next turn
    return res;
  }
}
