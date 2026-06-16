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
import { renderDom, renderDomGL } from "./eye.mjs";

// Is this a WebGL / Three.js page? Such pages must be checked on the GPU path — on the default
// --disable-gpu render WebGL fails to init, which (a) reports a BOGUS "Error creating WebGL context"
// and (b) never runs the real code, hiding the actual runtime error (e.g. an undefined-var TypeError).
export function isWebGLPage(html) {
  return /getContext\(\s*['"](?:webgl|webgl2|experimental-webgl)|WebGLRenderer|three(?:\.module|\.min)*\.js|\bTHREE\./i.test(String(html || ""));
}

const NODE = process.execPath || "node";

// Parse `node --check` stderr → { line, message }. Stderr looks like:
//   /tmp/x.js:532\n  } else {\n    ^^^^\nSyntaxError: Unexpected token 'else'
function parseNodeError(stderr) {
  const s = String(stderr || "");
  const lines = s.split("\n");
  const mLine = s.match(/:(\d+)\n/);
  const mMsg = s.match(/((?:Syntax|Reference|Type)Error:[^\n]*)/);
  // CODE FRAME: node --check prints the offending source line + a caret under it, between the "file:line"
  // header and the "SyntaxError:" line. That frame is exactly what a model needs to LOCATE + fix the bug,
  // so capture it (trimmed) instead of discarding it.
  let frame = null;
  const hdr = lines.findIndex((l) => /:\d+\s*$/.test(l));
  if (hdr >= 0) {
    const fr = [];
    for (let i = hdr + 1; i < lines.length && !/(?:Syntax|Reference|Type)Error:/.test(lines[i]) && !/^\s*at\s/.test(lines[i]); i++) {
      if (lines[i].length) fr.push(lines[i].replace(/\s+$/, ""));
    }
    if (fr.length) frame = fr.join("\n").slice(0, 240);
  }
  return { line: mLine ? Number(mLine[1]) : null, frame, message: (mMsg ? mMsg[1] : lines.find((l) => /Error:/.test(l)) || "syntax error").trim() };
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
    else if (body.trim()) {
      // file line where the script BODY starts, so a script-relative error line maps back to the HTML file.
      const bodyStart = m.index + (m[0].length - body.length - "</script>".length);
      const startLine = html.slice(0, bodyStart).split("\n").length;
      inline.push({ code: body, isModule: isModule || /^\s*(import|export)\b/m.test(body), startLine });
    }
  }
  return { inline, srcs };
}

// Static syntax check of every script a page uses. Returns { ok, errors:[{where, line, message}] }.
export function checkPageJs(htmlAbs, resolveLocal) {
  let html = ""; try { html = fs.readFileSync(htmlAbs, "utf8"); } catch { return { ok: true, errors: [] }; }
  const { inline, srcs } = extractScripts(html);
  const errors = [];
  inline.forEach((s, i) => {
    const r = nodeCheckCode(s.code, s.isModule);
    if (!r.ok) {
      const fileLine = (r.line != null && s.startLine) ? s.startLine + r.line - 1 : r.line;   // map to the HTML file line
      errors.push({ where: `inline <script> #${i + 1}`, line: fileLine, frame: r.frame, message: r.message });
    }
  });
  for (const s of srcs) {
    let abs; try { abs = resolveLocal ? resolveLocal(s.src) : path.join(path.dirname(htmlAbs), s.src); } catch { continue; }
    let code = null; try { code = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const isModule = s.isModule || /^\s*(import|export)\b/m.test(code);
    const r = nodeCheckCode(code, isModule);
    if (!r.ok) errors.push({ where: `${s.src}${r.line ? ":" + r.line : ""}`, line: r.line, frame: r.frame, message: r.message });
  }
  return { ok: errors.length === 0, errors };
}

// Inject a runtime error capturer and read back any uncaught errors via --dump-dom. Catches runtime
// SyntaxError/Error/unhandledrejection that static parsing can't. Renders a TEMP copy (never edits the
// user's file). Returns { ok, errors:[string] }.
const CAPTURE = `<script>window.__slivrErrs=[];addEventListener('error',function(e){try{__slivrErrs.push((e.message||'error')+(e.filename?(' @'+String(e.filename).split('/').pop()):'')+(e.lineno?(':'+e.lineno):''));}catch(_){}} ,true);addEventListener('unhandledrejection',function(e){try{__slivrErrs.push('unhandledrejection: '+((e.reason&&e.reason.message)||e.reason));}catch(_){}} );</script>`;
// dumper LAST: POLL (async CDN ES-module games create the canvas + throw their loop error well AFTER the
// 'load' event, so a fixed delay races them). Dump as soon as an error is captured, or once the canvas has
// existed long enough to settle — capped at maxWait. Records errors AND whether the canvas is blank (a
// TypeError-in-the-loop / wrong-camera game renders nothing even when no error fires).
const dumpScript = (maxWait, checkBlank) => `<script>(function(){
  function blankOf(){if(!${checkBlank})return null;try{var cv=document.querySelector('canvas');if(!cv)return null;var u=cv.toDataURL('image/png');if(u.length<400)return true;var t=document.createElement('canvas');t.width=16;t.height=16;var x=t.getContext('2d');x.drawImage(cv,0,0,16,16);var d=x.getImageData(0,0,16,16).data,same=true;for(var i=4;i<d.length;i+=4){if(Math.abs(d[i]-d[0])+Math.abs(d[i+1]-d[1])+Math.abs(d[i+2]-d[2])>12){same=false;break;}}return same;}catch(_){return null;}}
  function out(){var el=document.createElement('pre');el.id='__slivr_errs';el.style.display='none';el.textContent=JSON.stringify({errors:window.__slivrErrs||[],blank:blankOf()});document.body.appendChild(el);}
  var waited=0,canvasSeen=0;
  function tick(){
    if((window.__slivrErrs||[]).length){out();return;}            // an error fired → report now
    if(document.querySelector('canvas')){canvasSeen+=200;if(canvasSeen>=900){out();return;}}  // canvas settled
    waited+=200;if(waited>=${maxWait}){out();return;}
    setTimeout(tick,200);
  }
  if(document.readyState==='complete')setTimeout(tick,200);else window.addEventListener('load',function(){setTimeout(tick,200);});
})();</script>`;

// Capture runtime console/runtime errors + a blank-canvas signal. For WebGL/Three.js pages, render on the
// GPU path (so WebGL actually inits and the REAL runtime error surfaces, not a bogus context error).
export function pageConsoleErrors(htmlAbs, { gl = false } = {}) {
  let html = ""; try { html = fs.readFileSync(htmlAbs, "utf8"); } catch { return { ok: false, errors: [], blank: null }; }
  const useGL = gl || isWebGLPage(html);
  // poll long enough for a CDN Three.js scene to load + run; blank-canvas check only on WebGL pages (a
  // blank WebGL canvas almost always means a real bug; an incidental 2D canvas may legitimately be undrawn).
  const DUMP = dumpScript(useGL ? 6000 : 400, useGL);
  let injected = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + CAPTURE) : (CAPTURE + html);
  injected = /<\/body>/i.test(injected) ? injected.replace(/<\/body>/i, DUMP + "</body>") : injected + DUMP;
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.slivr-webcheck-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, injected);
    const d = useGL ? renderDomGL(tmp, 14000) : renderDom(tmp);
    if (!d.ok) return { ok: false, errors: [], blank: null };
    const m = d.dom.match(/<pre id="__slivr_errs"[^>]*>([\s\S]*?)<\/pre>/);
    let res = { errors: [], blank: null };
    if (m) { try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { /* */ } }
    // drop the headless-only bogus "no WebGL context" if it slips through; clean the temp wrapper filename.
    const errors = (res.errors || []).filter((e) => !/Error creating WebGL context/i.test(e))
      .map((e) => e.replace(/@\.slivr-\w+-\d+-\d+\.html/g, "@" + path.basename(htmlAbs)));
    return { ok: errors.length === 0, errors, blank: res.blank };
  } catch { return { ok: false, errors: [], blank: null }; }
  finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}
