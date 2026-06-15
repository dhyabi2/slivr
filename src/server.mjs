// server.mjs — run a generated app as a REAL server, not just a static index.html: spawn it, wait for
// its port to listen, hand back an http URL, verify over HTTP, and kill it (process group) on teardown.
// This is what lets slivr build Node apps that "give a URL with a port". Zero deps (node net +
// child_process). Running servers are tracked so they're cleaned up on process exit (no orphaned ports).

import { spawn } from "node:child_process";
import net from "node:net";

const RUNNING = new Map();   // pid -> { child, url, port, cmd }

// Find a free TCP port by binding :0 and reading the assigned port back.
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Poll until something ACCEPTS TCP connections on `port` (the server is ready) or the timeout elapses.
export function waitForPort(port, { host = "127.0.0.1", timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect(port, host);
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, intervalMs);
      });
    };
    tryOnce();
  });
}

// Start `command` in `cwd` with PORT injected (most node servers read process.env.PORT), wait for the
// port to listen, and return { ok, url, pid, port }. On early exit / never-listening, returns the
// captured log so the failure is actionable. The child is unref'd + detached so it neither blocks the
// CLI from exiting nor orphans on exit (we kill the group in stopServer + the exit hook).
export async function startServer({ command, cwd, port, env = {}, readyTimeoutMs = 15000, host = "127.0.0.1" } = {}) {
  if (!command || typeof command !== "string") return { ok: false, error: "NO_COMMAND" };
  let p;
  try { p = port || await freePort(); } catch { return { ok: false, error: "NO_FREE_PORT" }; }
  let child;
  try { child = spawn(command, { cwd, shell: true, detached: true, env: { ...process.env, ...env, PORT: String(p) } }); }
  catch (e) { return { ok: false, error: `could not spawn the server: ${e.message}` }; }
  let log = "";
  const cap = (b) => { log = (log + b.toString()).slice(-4000); };
  child.stdout?.on("data", cap);
  child.stderr?.on("data", cap);
  let exitedCode = null;
  child.on("exit", (code) => { exitedCode = code == null ? 0 : code; RUNNING.delete(child.pid); });
  child.on("error", () => { exitedCode = exitedCode == null ? -1 : exitedCode; });

  const ready = await Promise.race([
    waitForPort(p, { host, timeoutMs: readyTimeoutMs }),
    new Promise((r) => child.once("exit", () => r(false))),
  ]);
  if (!ready || exitedCode != null) {
    stopServer(child.pid);
    const why = exitedCode != null
      ? `the server process exited (code ${exitedCode}) before it started listening`
      : `the server did not start listening on port ${p} within ${Math.round(readyTimeoutMs / 1000)}s`;
    return { ok: false, error: why, port: p, log: log.slice(-1500) };
  }
  child.unref();
  // 127.0.0.1 (not "localhost"): Node's fetch/undici resolves localhost to ::1 first and then EINVALs
  // setting the IPv4 IP_TOS socket option on the v6 socket — force IPv4 so http_request/proxy fetches work.
  const url = `http://127.0.0.1:${p}`;
  RUNNING.set(child.pid, { child, url, port: p, cmd: command });
  return { ok: true, url, pid: child.pid, port: p };
}

// Kill a tracked server (its whole process group, so npm→node children die too). Idempotent.
export function stopServer(pid) {
  const rec = RUNNING.get(pid);
  const realPid = rec?.child?.pid || pid;
  if (realPid) {
    try { process.kill(-realPid, "SIGTERM"); }
    catch { try { process.kill(realPid, "SIGTERM"); } catch { /* already gone */ } }
  }
  RUNNING.delete(pid);
  return { ok: true, stopped: pid };
}

export function stopAllServers() { for (const pid of [...RUNNING.keys()]) stopServer(pid); }
export function listServers() {
  return [...RUNNING.values()].map((r) => ({ pid: r.child.pid, url: r.url, port: r.port, cmd: r.cmd }));
}

// Never leak a started server past the CLI's own lifetime. (Only the 'exit' hook — adding SIGINT/SIGTERM
// listeners would suppress their default behavior and interfere with the REPL's own Ctrl-C handling.)
process.on("exit", stopAllServers);
