#!/usr/bin/env python3
# repl_e2e.py — END-TO-END tests for slivr's INTERACTIVE REPL, driven through a real PTY.
# These behaviors (Shift-Tab mode cycling, Ctrl-C, the prompt label, slash-commands) are gated on
# stdin being a TTY, so a normal pipe cannot exercise them — we allocate a pseudo-terminal.
# No LLM is needed: we test pre-model REPL/terminal behavior only. Run:  python3 test/repl_e2e.py
import os, pty, re, select, shutil, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin", "slivr.mjs")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
P, F = 0, 0
def ok(b, m):
    global P, F
    print(("  PASS  " if b else "  FAIL  ") + m);
    if b: P += 1
    else: F += 1

# isolated workdir with the shipped skills (so /skills has something to list), no .slivr.json (no MCP)
wd = tempfile.mkdtemp(prefix="slivr-repl-")
os.makedirs(os.path.join(wd, ".slivr", "skills"), exist_ok=True)
for s in ("review.md", "test.md", "commit.md"):
    src = os.path.join(ROOT, ".slivr", "skills", s)
    if os.path.exists(src): shutil.copy(src, os.path.join(wd, ".slivr", "skills", s))

master, slave = pty.openpty()
env = dict(os.environ); env.pop("OPENROUTER_API_KEY", None); env["NO_COLOR"] = "1"  # no key (no LLM), no color
proc = subprocess.Popen(["node", BIN], stdin=slave, stdout=slave, stderr=slave,
                        cwd=wd, env=env, start_new_session=True, close_fds=True)
os.close(slave)
buf = ""
def pump(t=0.4):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([master], [], [], max(0, end - time.time()))
        if master in r:
            try: data = os.read(master, 4096)
            except OSError: break
            if not data: break
            buf += ANSI.sub("", data.decode("utf-8", "replace"))
def expect(sub, timeout=6.0):
    end = time.time() + timeout
    while time.time() < end:
        if sub in buf: return True
        pump(0.2)
    return sub in buf
def send(s): os.write(master, s if isinstance(s, bytes) else s.encode())

try:
    # 1. prompt shows the default mode label
    ok(expect("slivr [edits]"), "prompt shows mode label: slivr [edits]")

    # 2. Shift-Tab (ESC [ Z) cycles edits -> auto -> plan -> edits
    pos = len(buf); send(b"\x1b[Z"); pump(0.6)
    ok("slivr [auto]" in buf[pos:], "Shift-Tab: edits -> [auto]")
    pos = len(buf); send(b"\x1b[Z"); pump(0.6)
    ok("slivr [plan]" in buf[pos:], "Shift-Tab: auto -> [plan]")
    pos = len(buf); send(b"\x1b[Z"); pump(0.6)
    ok("slivr [edits]" in buf[pos:], "Shift-Tab: plan -> [edits] (full cycle)")

    # 3. /help lists the key hint + commands
    send("/help\r"); pump(0.6)
    ok(expect("Shift-Tab"), "/help shows the Shift-Tab key hint")
    ok("/skills" in buf, "/help lists /skills")

    # 4. /skills lists the shipped skills
    send("/skills\r"); pump(0.8)
    ok(expect("review"), "/skills lists the 'review' skill")

    # 5. Ctrl-C at the prompt: first warns, second exits
    send(b"\x03"); pump(0.6)
    ok(expect("again to exit"), "Ctrl-C at prompt warns '(^C again to exit)'")
    send(b"\x03"); pump(0.4)
    try: proc.wait(timeout=4); exited = True
    except subprocess.TimeoutExpired: exited = False
    ok(exited, "second Ctrl-C exits the REPL cleanly")
finally:
    if proc.poll() is None:
        send("/exit\r"); pump(0.3)
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired: proc.kill()
    os.close(master)
    shutil.rmtree(wd, ignore_errors=True)

print(f"\nREPL E2E: {P} passed, {F} failed")
sys.exit(0 if F == 0 else 1)
