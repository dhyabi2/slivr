// agent.mjs — cc-alt harness (THE alternative). Compact-edit protocol via SEAL.
//
// Tools: read_file, list_dir, grep, run_command, edit_file (anchor/replacement/op).
// The agent edits with SMALL anchors and gets a COMPACT repair packet on failure — it never
// re-reads or re-sends a whole file to make a change. This is the harness-level cost advantage.

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
