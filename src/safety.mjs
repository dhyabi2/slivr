// safety.mjs — destructive-command blocklist + approval-mode policy.
//
// Two layers:
//   1. isDestructive(cmd) — a HARD blocklist. These are refused regardless of approval mode
//      (even 'auto'). Pattern-based on the raw command string; conservative (false negatives are
//      possible, but the common foot-guns are covered).
//   2. needsApproval(action, mode) — given the approval mode, decide whether to prompt.
//
// Pure + deterministic. No I/O, no LLM. The actual y/N prompt lives in the REPL (ui).

// Each rule: { name, test(cmd) -> bool, why }. test receives the lowercased, whitespace-collapsed
// command for matching, plus we also check the raw for some patterns.
const RULES = [
  {
    name: "rm -rf root/home",
    why: "recursive force-remove of a root or home path",
    test: (c) => /\brm\b[^|;&]*-[a-z]*r[a-z]*f|\brm\b[^|;&]*-[a-z]*f[a-z]*r/.test(c) &&
                 /\brm\b[^|;&]*\s(\/|~|\$home|\.\s*$|\*\s*$|\/\*)/.test(c),
  },
  {
    name: "fork bomb",
    why: "shell fork bomb",
    test: (c) => /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c.replace(/\s+/g, "")) ||
                 /\(\)\{:\|:&\};:/.test(c.replace(/\s+/g, "")),
  },
  {
    name: "pipe-to-shell from network",
    why: "downloading and piping a remote script straight into a shell",
    test: (c) => /(curl|wget|fetch)\b[^|]*https?:\/\/(?!(localhost|127\.0\.0\.1))[^|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/.test(c),
  },
  {
    name: "git push --force",
    why: "force-push (can destroy remote history)",
    test: (c) => /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/.test(c) ||
                 /\bgit\s+push\b[^|;&]*\+/.test(c),
  },
  {
    name: "git clean -fd (force-remove untracked)",
    why: "force-removes untracked files/dirs irrecoverably",
    // Anchored to `git clean`; require a force flag bundle containing fd/df (e.g. -fd, -fdx).
    // (Earlier this had an unanchored `-[a-z]*d[a-z]*f` branch that wrongly matched any `-df` flag.)
    test: (c) => /\bgit\s+clean\b[^|;&]*-[a-z]*(fd|df)[a-z]*/.test(c),
  },
  {
    name: "disk overwrite",
    why: "writing directly to a block device / wiping a disk",
    test: (c) => /\bdd\b[^|;&]*\bof=\/dev\/(?!null|zero|random|urandom)/.test(c) ||
                 /\bmkfs(\.\w+)?\b/.test(c) ||
                 />\s*\/dev\/(sd|nvme|disk|hd)\w*/.test(c),
  },
  {
    name: "sudo privilege escalation",
    why: "privilege escalation is out of scope for a sandboxed agent",
    test: (c) => /(^|[|;&]\s*)sudo\b/.test(c),
  },
  {
    name: "chmod/chown -R on root",
    why: "recursive permission/ownership change on a root path",
    test: (c) => /\b(chmod|chown)\b[^|;&]*-[a-z]*r[a-z]*\s+[^|;&]*\s(\/|~)(\s|$|\*)/.test(c),
  },
  {
    name: "kill all processes",
    why: "killing all processes / shutting down the machine",
    test: (c) => /\bkill(all)?\b[^|;&]*-9\s+-1\b|\bkill\b[^|;&]*\s-1\b/.test(c) ||
                 // Only when it's the command being INVOKED (start, or after a separator) — so
                 // `grep shutdown log` / `echo "app shutdown"` are NOT blocked.
                 /(^|[|;&]\s*)(shutdown|reboot|halt|poweroff)\b/.test(c),
  },
];

// Returns { blocked: true, rule, why } if the command is hard-refused, else { blocked: false }.
export function isDestructive(command) {
  if (typeof command !== "string" || !command.trim()) return { blocked: false };
  const c = command.toLowerCase().replace(/[ \t]+/g, " ").trim();
  for (const rule of RULES) {
    try { if (rule.test(c)) return { blocked: true, rule: rule.name, why: rule.why }; }
    catch { /* a rule regex threw — ignore that rule */ }
  }
  return { blocked: false };
}

// Approval policy. mode ∈ {'auto','edits','all'}.
//   'auto'  : never prompt (trusted). run_command still hard-blocked if destructive.
//   'edits' : prompt before run_command AND before edits/creates.
//   'all'   : prompt before every mutating/effecting action (run_command, edit, create).
// kind ∈ {'run_command','edit_file','edit_files','create_file','write_file', other}.
export function needsApproval(kind, mode = "edits") {
  const mutating = kind === "edit_file" || kind === "edit_files" || kind === "create_file" || kind === "write_file";
  const effecting = kind === "run_command";
  if (mode === "auto") return false;
  if (mode === "all") return mutating || effecting;
  // 'edits' (default): prompt for edits AND commands (commands can have side effects).
  return mutating || effecting;
}

export const APPROVAL_MODES = ["auto", "edits", "all"];
