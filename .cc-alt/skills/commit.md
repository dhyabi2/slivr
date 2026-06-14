# Write a commit message and commit
<!-- description: write a good commit message for the staged changes and commit -->
Write a clear commit message for the currently staged changes and commit them.

Steps:
1. Run git_status and git_diff (staged) to understand what changed.
2. If nothing is staged, stop and say so (do not `git add` indiscriminately).
3. Compose a concise commit message: a <72-char summary line, then a short body explaining WHY if non-trivial. Extra context: $ARGS
4. Commit with the git_commit tool. Do NOT push.
5. Report the message you used.
