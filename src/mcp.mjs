// mcp.mjs — Model Context Protocol (MCP) CLIENT, stdio transport.
//
// Lets proov connect to external MCP servers (Claude-Desktop-compatible config) and surface
// their tools to the model as namespaced, callable tools (mcp__<server>__<tool>). One process per
// server; we speak JSON-RPC 2.0 over the child's stdin/stdout as NEWLINE-DELIMITED JSON (one JSON
// object per line) — NOT the LSP Content-Length framing. Requests are correlated by `id`.
//
// Lifecycle:
//   connectAll(config) -> { clients, catalog, errors }   // catalog = merged [{server,name,description,inputSchema}]
//   client.callTool(name, args) -> { ok, content:[{type,text}...], text, isError? }
//   closeAll(clients)                                      // kill children cleanly
//
// Everything here is OPTIONAL: with no `mcpServers` configured, connectAll returns empty and the
// rest of proov is untouched.

import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "proov", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 20000;

// Sanitize a server or tool name into the [A-Za-z0-9_] charset used for the namespaced tool id.
export function sanitize(s) {
  return String(s || "").replace(/[^A-Za-z0-9_]/g, "_");
}

// Namespaced tool id the model calls: mcp__<server>__<tool>.
export function nsName(server, tool) {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`;
}

// One connected MCP server (a child process speaking JSON-RPC over stdio).
export class MCPClient {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.child = null;
    this.tools = [];            // [{name, description, inputSchema}]
    this.connected = false;
    this._buf = "";
    this._nextId = 1;
    this._pending = new Map();  // id -> {resolve, reject, timer}
    this._stderr = "";
    this._closed = false;
  }

  // Spawn the child and run the MCP handshake: initialize -> notifications/initialized -> tools/list.
  async connect({ timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const { command, args = [], env = {} } = this.spec;
    if (!command) throw new Error(`mcp server "${this.name}": no command`);
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this._stderr = (this._stderr + chunk).slice(-4000); });

    this.child.on("error", (err) => this._fail(new Error(`spawn failed: ${err.message}`)));
    this.child.on("exit", (code, signal) => {
      this._closed = true;
      this._fail(new Error(`server exited (code=${code} signal=${signal})${this._stderr ? `: ${this._stderr.trim().slice(-300)}` : ""}`));
    });

    // 1) initialize
    const initRes = await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, timeout);
    this.serverInfo = initRes?.serverInfo || null;

    // 2) initialized notification (no response expected)
    this._notify("notifications/initialized", {});

    // 3) tools/list
    const listRes = await this._request("tools/list", {}, timeout);
    this.tools = Array.isArray(listRes?.tools) ? listRes.tools : [];
    this.connected = true;
    return this.tools;
  }

  // Call a tool by its *bare* name (without the mcp__server__ prefix). Returns a compact result.
  async callTool(name, args = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.connected) return { ok: false, error: "NOT_CONNECTED", server: this.name };
    let res;
    try {
      res = await this._request("tools/call", { name, arguments: args || {} }, timeout);
    } catch (e) {
      return { ok: false, error: String(e.message || e), server: this.name, tool: name };
    }
    const content = Array.isArray(res?.content) ? res.content : [];
    // Flatten text-ish content for the model; keep the raw content array too.
    const text = content
      .map((c) => (c?.type === "text" ? c.text : c?.text ?? (c ? JSON.stringify(c) : "")))
      .filter(Boolean)
      .join("\n");
    const out = { ok: !res?.isError, content, text };
    if (res?.isError) out.isError = true;
    if (res?.structuredContent !== undefined) out.structuredContent = res.structuredContent;
    return out;
  }

  close() {
    this._closed = true;
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error("client closed")); }
    this._pending.clear();
    try { this.child?.stdin?.end(); } catch {}
    try { this.child?.kill("SIGTERM"); } catch {}
  }

  // ---- internals ----
  _onStdout(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // ignore non-JSON noise
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Responses carry an id we issued. Notifications/requests from the server are ignored (we don't
    // advertise capabilities), except we silently drop them so they don't break the loop.
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  _send(obj) {
    if (this._closed || !this.child?.stdin?.writable) throw new Error("server stdin not writable");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  _request(method, params, timeout = DEFAULT_TIMEOUT_MS) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`timeout after ${timeout}ms waiting for ${method}`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      try { this._send({ jsonrpc: "2.0", id, method, params }); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }

  _notify(method, params) {
    try { this._send({ jsonrpc: "2.0", method, params }); } catch { /* best-effort */ }
  }

  _fail(err) {
    // Reject anything still in flight; mark down. Pre-connect this surfaces as a connect() rejection.
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
    this._pending.clear();
  }
}

// Read mcpServers out of a loaded config object. Returns [{name, spec}] for enabled servers only.
export function enabledServers(mcpServers) {
  if (!mcpServers || typeof mcpServers !== "object") return [];
  const out = [];
  for (const [name, spec] of Object.entries(mcpServers)) {
    if (!spec || typeof spec !== "object" || spec.disabled === true) continue;
    if (!spec.command) continue;
    out.push({ name, spec });
  }
  return out;
}

// Connect every enabled server and build a merged tool catalog. Failures are collected (not thrown)
// so one broken server never blocks the rest. Returns { clients, catalog, errors }.
//   catalog: [{ id, server, name, description, inputSchema, client }]
export async function connectAll(mcpServers, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const servers = enabledServers(mcpServers);
  const clients = [];
  const catalog = [];
  const errors = [];
  await Promise.all(servers.map(async ({ name, spec }) => {
    const client = new MCPClient(name, spec);
    try {
      await client.connect({ timeout });
      clients.push(client);
      for (const t of client.tools) {
        catalog.push({
          id: nsName(name, t.name),
          server: name,
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || { type: "object" },
          client,
        });
      }
    } catch (e) {
      errors.push({ server: name, error: String(e.message || e) });
      try { client.close(); } catch {}
    }
  }));
  return { clients, catalog, errors };
}

export function closeAll(clients = []) {
  for (const c of clients) { try { c.close(); } catch {} }
}

// Build the SYSTEM-prompt section that tells the model about the discovered MCP tools. Compact:
// one line per tool with its namespaced id + description, plus a compact JSON input schema.
export function mcpPromptSection(catalog = []) {
  if (!catalog.length) return "";
  const lines = catalog.map((t) => {
    const schema = compactSchema(t.inputSchema);
    const desc = (t.description || "").replace(/\s+/g, " ").trim().slice(0, 200);
    return `  {"tool":"${t.id}","args":${schema}}  — ${desc || "(no description)"}`;
  });
  return `

MCP TOOLS (external tools discovered from connected MCP servers — call them EXACTLY like any other
tool, by emitting one JSON object {"tool":"mcp__<server>__<tool>","args":{...}}). The "args" object
must match the tool's input schema shown below:
${lines.join("\n")}`;
}

// Render a JSON Schema down to a compact {field:type,...} hint (best-effort, never throws).
function compactSchema(schema) {
  try {
    if (!schema || typeof schema !== "object") return "{}";
    const props = schema.properties;
    if (!props || typeof props !== "object") return "{}";
    const req = new Set(Array.isArray(schema.required) ? schema.required : []);
    const parts = Object.entries(props).map(([k, v]) => {
      const type = v?.type || (v?.enum ? "enum" : "any");
      return `"${k}":"${type}${req.has(k) ? "*" : ""}"`;
    });
    return `{${parts.join(",")}}`;
  } catch { return "{}"; }
}
