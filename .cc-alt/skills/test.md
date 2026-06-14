# Run tests and fix failures
<!-- description: find and run the test suite, fix any failures -->
Find this project's test suite, run it, and fix failures.

Steps:
1. Discover how tests run: check package.json "scripts" (test), or a selftest.mjs / test dir, or a Makefile.
2. Run the test command with run_command.
3. If everything passes, report that and call done.
4. If something fails, read the failing code + test, make a TARGETED edit to fix the root cause, and re-run until green (or you hit the step cap).
5. Extra instructions, if any: $ARGS
