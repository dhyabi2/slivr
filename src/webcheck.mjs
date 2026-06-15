// webcheck.mjs — catch a BROKEN web page before declaring it done (the "looked fine, rendered blank"
// class of bug). A JS SyntaxError leaves the DOM structurally intact (the <canvas> tag is still there),
// so --dump-dom and a screenshot look fine while nothing actually runs. Two cheap, zero-dep signals:
//   1. STATIC syntax check — `node --check` on every inline <script> and local .js the page loads. This
//      catches "Unexpected token 'else' / '}'" WITHOUT a browser and pinpoints the file:line.
//   2. RUNTIME console capture — inject a window error listener so an uncaught SyntaxError/Error/rejection
//      is written into the DOM and read back via --dump-dom (catches errors static parsing can't).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { renderDom } from "./eye.mjs";

const NODE = process.execPath || "node";

// Parse `node --check` stderr → { line, message }. Stderr looks like:
//   /tmp/x.js:532\n  } else {\n    ^^^^\nSyntaxError: Unexpected token 'else'
function parseNodeError(stderr) {
  const s = String(stderr || "");
  const mLine = s.match(/:(\d+)\n/);
  const mMsg = s.match(/((?:Syntax|Reference|Type)Error:[^\n]*)/);
  return { line: mLine ? Number(mLine[1]) : null, message: (mMsg ? mMsg[1] : s.split("\n").find((l) => /Error:/.test(l)) || "syntax error").trim() };
}

// Syntax-check one JS string. isModule → check as an ES module (allows import/export). { ok } | { ok:false, line, message }.
export function nodeCheckCode(code, isModule = false) {
  if (!code || !code.trim()) return { ok: true };
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "slivr-check-"));
    const f = path.join(dir, isModule ? "c.mjs" : "c.js");
    fs.writeFileSync(f, code);
    try { execFileSync(NODE, ["--check", f], { stdio: ["ignore", "ignore", "pipe"] }); return { ok: true }; }
    catch (e) { return { ok: false, ...parseNodeError(e.stderr || e.message) }; }
  } catch (e) { return { ok: true }; /* never block on the checker itself */ }
  finally { if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}

// Pull <script> blocks from HTML: inline code (no src) and LOCAL src paths (http(s) skipped).
export function extractScripts(html) {
  const inline = [], srcs = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "", body = m[2] || "";
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    const isModule = /\btype\s*=\s*["']module["']/i.test(attrs);
    if (src) { if (!/^https?:|^\/\//i.test(src)) srcs.push({ src, isModule }); }
    else if (body.trim()) inline.push({ code: body, isModule: isModule || /^\s*(import|export)\b/m.test(body) });
  }
  return { inline, srcs };
}

// Static syntax check of every script a page uses. Returns { ok, errors:[{where, line, message}] }.
export function checkPageJs(htmlAbs, resolveLocal) {
  let html = ""; try { html = fs.readFileSync(htmlAbs, "utf8"); } catch { return { ok: true, errors: [] }; }
  const { inline, srcs } = extractScripts(html);
  const errors = [];
  inline.forEach((s, i) => { const r = nodeCheckCode(s.code, s.isModule); if (!r.ok) errors.push({ where: `inline <script> #${i + 1}`, line: r.line, message: r.message }); });
  for (const s of srcs) {
    let abs; try { abs = resolveLocal ? resolveLocal(s.src) : path.join(path.dirname(htmlAbs), s.src); } catch { continue; }
    let code = null; try { code = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const isModule = s.isModule || /^\s*(import|export)\b/m.test(code);
    const r = nodeCheckCode(code, isModule);
    if (!r.ok) errors.push({ where: `${s.src}${r.line ? ":" + r.line : ""}`, line: r.line, message: r.message });
  }
  return { ok: errors.length === 0, errors };
}

// Inject a runtime error capturer and read back any uncaught errors via --dump-dom. Catches runtime
// SyntaxError/Error/unhandledrejection that static parsing can't. Renders a TEMP copy (never edits the
// user's file). Returns { ok, errors:[string] }.
const CAPTURE = `<script>window.__slivrErrs=[];addEventListener('error',function(e){try{__slivrErrs.push((e.message||'error')+(e.filename?(' @'+String(e.filename).split('/').pop()):'')+(e.lineno?(':'+e.lineno):''));}catch(_){}} ,true);addEventListener('unhandledrejection',function(e){try{__slivrErrs.push('unhandledrejection: '+((e.reason&&e.reason.message)||e.reason));}catch(_){}} );</script>`;
const DUMP = `<script>window.addEventListener('load',function(){setTimeout(function(){var el=document.createElement('pre');el.id='__slivr_errs';el.style.display='none';el.textContent=JSON.stringify(window.__slivrErrs||[]);document.body.appendChild(el);},50);});</script>`;

export function pageConsoleErrors(htmlAbs) {
  let html = ""; try { html = fs.readFileSync(htmlAbs, "utf8"); } catch { return { ok: false, errors: [] }; }
  // capturer FIRST (so it catches later scripts), dumper LAST.
  let injected = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + CAPTURE) : (CAPTURE + html);
  injected = /<\/body>/i.test(injected) ? injected.replace(/<\/body>/i, DUMP + "</body>") : injected + DUMP;
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.slivr-webcheck-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, injected);
    const d = renderDom(tmp);
    if (!d.ok) return { ok: false, errors: [] };
    const m = d.dom.match(/<pre id="__slivr_errs"[^>]*>([\s\S]*?)<\/pre>/);
    let errs = [];
    if (m) { try { errs = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { /* */ } }
    return { ok: errs.length === 0, errors: errs };
  } catch { return { ok: false, errors: [] }; }
  finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}
