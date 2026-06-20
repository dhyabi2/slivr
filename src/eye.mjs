// eye.mjs — the agent's "eye" on a rendered web page (Block 11). Chosen via the brainstorm engine as
// the best + CHEAPEST approach: TEXT-FIRST. Render the page with the system's installed Chrome in
// headless mode and read the POST-JS rendered DOM as plain TEXT (`--dump-dom`) — this catches the
// common bugs (literal "\n" shown on screen, blank page, wrong/missing text) with no vision-token cost.
// A screenshot (`--screenshot`) is a second tier, only when true visual layout perception is needed.
// Zero new dependencies (system Chrome/Chromium/Edge); `npx playwright` is a last-resort fallback.

import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

const CANDIDATES = [
  process.env.CHROME_PATH, process.env.PROOV_CHROME,
  "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean);

// First usable browser binary (absolute path or PATH name), or null.
// PROOV_NO_BROWSER forces "no browser" — used by `npm run selftest:fast` to skip the (slow) headless-Chrome
// tests, and as an escape hatch on machines/CI without Chrome.
export function findBrowser() {
  if (process.env.PROOV_NO_BROWSER) return null;
  for (const c of CANDIDATES) {
    if (c.includes("/") || c.includes("\\")) {
      try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
    } else {
      // `command -v` is a shell builtin → run it via `sh -c` (program=sh, no shell:true-with-args,
      // which is deprecated). `c` is from this fixed CANDIDATES list, so there is no injection surface.
      const probe = process.platform === "win32"
        ? spawnSync("where", [c], { encoding: "utf8" })
        : spawnSync("sh", ["-c", `command -v "${c}"`], { encoding: "utf8" });
      if (probe.status === 0 && (probe.stdout || "").trim()) return c;
    }
  }
  return null;
}

// A render target is either a local file path OR a URL (http/https/file). A served Node app is loaded
// over http://localhost:PORT; a static file over file://. Chrome takes a URL either way.
export const toTarget = (t) => (/^(https?|file):\/\//i.test(String(t)) ? String(t) : "file://" + t);

const COMMON = ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--virtual-time-budget=2500"];
export const dumpDomArgs = (url) => [...COMMON, "--dump-dom", url];
export const screenshotArgs = (url, outPng, { width = 1000, height = 750 } = {}) =>
  [...COMMON, "--hide-scrollbars", `--screenshot=${outPng}`, `--window-size=${width},${height}`, url];

// WebGL capture variant: WebGL output is BLANK in headless screenshots with --disable-gpu, but renders
// correctly with the SwiftShader ANGLE backend (GPU NOT disabled) when the page captures the canvas itself
// via canvas.toDataURL() (preserveDrawingBuffer:true) and we read that dataURL back through --dump-dom.
// Bigger maxBuffer because a 3D scene may dump several captured frames as data URLs.
const GL_COMMON = ["--headless=new", "--use-angle=swiftshader", "--no-sandbox", "--no-first-run"];
export const dumpDomGLArgs = (url, budget = 9000) => [...GL_COMMON, `--virtual-time-budget=${budget}`, "--dump-dom", url];

// ASYNC Chrome render (non-blocking). Required when loading a URL served by an IN-PROCESS proxy: spawnSync
// would block the event loop so the proxy could never answer Chrome's request (deadlock). spawn() keeps the
// loop free. Returns { ok, dom } | { ok, error }.
function renderArgsAsync(args, timeoutMs, maxBuffer) {
  const browser = findBrowser();
  if (!browser) return Promise.resolve({ ok: false, error: "no headless browser found — install Google Chrome, or set CHROME_PATH" });
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { ch.kill("SIGKILL"); } catch { /* */ } resolve(r); };
    const ch = spawn(browser, args, { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => finish({ ok: false, error: "render timed out" }), timeoutMs);
    ch.stdout.on("data", (d) => { out += d; if (out.length > maxBuffer) finish({ ok: out.length ? true : false, dom: out }); });
    ch.on("error", (e) => finish({ ok: false, error: `render failed: ${e.message}` }));
    ch.on("close", () => finish(out ? { ok: true, dom: out } : { ok: false, error: "render failed: no output" }));
  });
}
export function renderDomUrl(url) { return renderArgsAsync(dumpDomArgs(toTarget(url)), 30000, 16 << 20); }
export function renderDomGLUrl(url, budget = 9000) { return renderArgsAsync(dumpDomGLArgs(toTarget(url), budget), budget + 30000, 64 << 20); }

// TIER 1 (cheap): the post-JS rendered DOM as text. { ok:true, dom } | { ok:false, error }.
export function renderDom(htmlAbs) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: "no headless browser found — install Google Chrome, or set CHROME_PATH" };
  const r = spawnSync(browser, dumpDomArgs(toTarget(htmlAbs)), { timeout: 30000, encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.error || !r.stdout) return { ok: false, error: `render failed: ${r.error ? r.error.message : "no output"}` };
  return { ok: true, dom: r.stdout };
}

// Like renderDom but with the WebGL-capable backend — use for pages that draw with WebGL/Three.js and
// capture their own canvas via toDataURL. { ok:true, dom } | { ok:false, error }.
export function renderDomGL(htmlAbs, budget = 9000) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: "no headless browser found — install Google Chrome, or set CHROME_PATH" };
  const r = spawnSync(browser, dumpDomGLArgs(toTarget(htmlAbs), budget), { timeout: budget + 30000, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error || !r.stdout) return { ok: false, error: `render failed: ${r.error ? r.error.message : "no output"}` };
  return { ok: true, dom: r.stdout };
}

// WebGL screenshot: --screenshot renders WebGL BLANK (--disable-gpu). Instead capture the page's own
// canvas via toDataURL on the GPU path (renderDomGL). Writes the PNG to outPng. { ok } | { ok:false, error }.
// Capture the canvas, DOWNSCALED to MAXDIM (long edge) before toDataURL — a big game canvas (800-1200px)
// shrinks to ~768px so the base64 sent to the vision model is far smaller (≈ pixel-count ratio), with no
// fidelity loss that matters for richness/vision. PNG kept (no MIME change for any caller). 0 = no downscale.
// Capture the canvas, downscaled to MAXDIM (long edge). RUNNING mode (Block 80): when `keys` is given, dispatch
// real keyboard input each poll so the game actually PLAYS, and capture a LATE frame (after motion) instead of
// the cold start frame — so the vision judge sees the game running, not its empty first frame. Higher maxDim
// (e.g. 1024) keeps on-screen TEXT legible for the judge. 0 = no downscale.
export const glCaptureInject = (budget, maxDim = 768, keys = null) => {
  const fire = keys
    ? `try{${JSON.stringify(keys)}.forEach(function(k){var c=(k==='Space')?' ':k,kc=(k==='ArrowRight')?39:(k==='ArrowUp')?38:(k==='ArrowLeft')?37:(k==='ArrowDown')?40:32;[document,window].forEach(function(tg){try{tg.dispatchEvent(new KeyboardEvent('keydown',{key:c,code:k,keyCode:kc,which:kc,bubbles:true}));}catch(e){}});});}catch(e){}`
    : "";
  // running mode: keep firing input + only capture near the end of the budget (a late, in-motion frame).
  const settle = keys ? `n>=${Math.max(2000, budget - 1500)}` : `(u.length>800)||(n>=${budget - 1500})`;
  return `<script>window.addEventListener('load',function(){var n=0;function grab(){var cv=document.querySelector('canvas');if(!cv)return '';try{var w=cv.width||cv.clientWidth||0,h=cv.height||cv.clientHeight||0,MX=${maxDim};var s=(MX>0&&Math.max(w,h)>MX)?MX/Math.max(w,h):1;if(s<1){var t=document.createElement('canvas');t.width=Math.max(1,Math.round(w*s));t.height=Math.max(1,Math.round(h*s));t.getContext('2d').drawImage(cv,0,0,t.width,t.height);return t.toDataURL('image/png');}return cv.toDataURL('image/png');}catch(e){return '';}}(function poll(){${fire}var u=grab();n+=200;if(${settle}){var p=document.createElement('pre');p.id='__proov_shot';p.style.display='none';p.textContent=u;document.body.appendChild(p);return;}setTimeout(poll,200);})();});</script>`;
};
const glCapInject = (html, budget, maxDim = 768, keys = null) => (/<\/body>/i.test(html) ? html.replace(/<\/body>/i, glCaptureInject(budget, maxDim, keys) + "</body>") : html + glCaptureInject(budget, maxDim, keys));
function writeGlShot(dom, outPng) {
  if (!dom.ok) return { ok: false, error: dom.error };
  const m = dom.dom.match(/<pre id="__proov_shot"[^>]*>([\s\S]*?)<\/pre>/);
  const u = m ? m[1].trim() : "";
  if (!u || u.length < 200) return { ok: false, error: "blank or no canvas" };
  try { fs.writeFileSync(outPng, Buffer.from(u.split(",")[1], "base64")); return { ok: true, browser: "chrome-gl" }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

export function screenshotWebGL(htmlAbs, outPng, { budget = 11000, maxDim = 768, keys = null } = {}) {
  let html = ""; try { html = fs.readFileSync(htmlAbs, "utf8"); } catch { return { ok: false, error: "read failed" }; }
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.proov-glshot-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, glCapInject(html, budget, maxDim, keys));
    return writeGlShot(renderDomGL(tmp, budget), outPng);
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}

// Capture a SERVED game's canvas over HTTP (Block 42): inject the toDataURL capture via the proxy, render
// on the GL backend, write the PNG. Lets the served done-gate measure canvas richness like a static file. async.
export async function screenshotWebGLUrl(url, outPng, { budget = 11000, maxDim = 768, keys = null } = {}) {
  const { startInjectProxy } = await import("./proxy.mjs");
  const proxy = await startInjectProxy(url, (html) => glCapInject(html, budget, maxDim, keys));
  try { return writeGlShot(await renderDomGLUrl(proxy.url, budget), outPng); }
  finally { await proxy.close(); }
}

// TIER 2 (visual): a PNG screenshot. { ok:true, browser } | { ok:false, error }.
export function renderShot(htmlAbs, outPng, opts = {}) {
  const ok = () => { try { return fs.existsSync(outPng) && fs.statSync(outPng).size > 0; } catch { return false; } };
  const browser = findBrowser();
  if (browser) {
    const r = spawnSync(browser, screenshotArgs(toTarget(htmlAbs), outPng, opts), { timeout: 30000, encoding: "utf8" });
    if (!r.error && ok()) return { ok: true, browser: "chrome" };
  }
  try { fs.rmSync(outPng, { force: true }); } catch { /* ignore */ }
  const pw = spawnSync("npx", ["-y", "playwright", "screenshot", `--viewport-size=${opts.width || 1000},${opts.height || 750}`, "file://" + htmlAbs, outPng], { timeout: 120000, encoding: "utf8" });
  if (!pw.error && ok()) return { ok: true, browser: "playwright" };
  return { ok: false, error: browser ? "screenshot failed" : "no headless browser found — install Google Chrome, or set CHROME_PATH" };
}

// Reduce a rendered DOM string to the visible TEXT the user would see (strip <script>/<style>/tags),
// so the model reads what's ON SCREEN — cheaply. Whitespace-collapsed but NEWLINES PRESERVED so a
// literal "\n" rendered into the page is visible to the model (the exact bug class this catches).
export function visibleText(dom) {
  return String(dom || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
