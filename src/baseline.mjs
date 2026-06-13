// baseline.mjs — faithful Claude-Code-STYLE baseline harness.
//
// Same model, same tools, same loop as cc-alt — the ONLY difference is the EDIT/CONTEXT protocol:
// to change a file the agent uses write_file with the ENTIRE new file content (full rewrite), and
// it is instructed to re-read the whole file first. There is no compact repair packet; a failed
// edit just means re-reading and re-writing the full file. This is the naive protocol in wide use.

import { Provider } from "./provider.mjs";
import { Tools } from "./tools.mjs";
import { runLoop } from "./loop.mjs";

const SYSTEM = `You are a coding agent that edits a real repository.

You work ONE tool call at a time. Respond with EXACTLY ONE JSON object, nothing else:
  {"tool":"read_file","args":{"path":"rel/path.js"}}
  {"tool":"list_dir","args":{"path":"."}}
  {"tool":"grep","args":{"pattern":"regex","path":"."}}
  {"tool":"run_command","args":{"command":"node check.js"}}
  {"tool":"write_file","args":{"path":"f.js","content":"<ENTIRE new file content>"}}
  {"tool":"done","args":{"summary":"what you did"}}

EDIT PROTOCOL:
- To change a file you MUST first read_file it to get its full current content, then call
  write_file with the COMPLETE new content of the whole file (every line, including the parts
  you did not change). write_file overwrites the whole file.
- Always re-read a file before writing it so you have its exact current content.

Workflow: explore (list_dir/read_file/grep) → read the whole file → write the whole file back
with your changes → if the task has a check script, run it to verify → call done. Keep going
until the task is verifiably complete.`;

export function makeBaseline(workdir, opts = {}) {
  const provider = new Provider(opts);
  const tools = new Tools(workdir);
  const toolMap = {
    read_file: (a) => tools.read_file(a),
    list_dir: (a) => tools.list_dir(a),
    grep: (a) => tools.grep(a),
    run_command: (a) => tools.run_command(a),
    write_file: (a) => tools.write_file(a),
  };
  return { provider, tools, toolMap };
}

export async function runBaseline(task, workdir, opts = {}) {
  const { provider, tools, toolMap } = makeBaseline(workdir, opts);
  return runLoop({
    provider, tools, toolMap, systemPrompt: SYSTEM, task,
    maxSteps: opts.maxSteps ?? 16, onStep: opts.onStep,
  });
}
