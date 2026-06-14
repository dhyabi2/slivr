# Review staged diff
<!-- description: review the staged git diff for bugs and issues -->
Review the staged git changes for correctness bugs, edge cases, and risky patterns.

Steps:
1. Run `git diff --staged` to see what is staged (use the git_diff tool with staged:true, or run_command).
2. If nothing is staged, say so and stop.
3. Read the changed files for context where needed.
4. Report concrete findings as a short numbered list: for each, the file, the problem, and a suggested fix. Focus on real bugs over style. If extra focus was requested, prioritize it: $ARGS
5. Do NOT edit anything — this is review only. Call done with your findings.
