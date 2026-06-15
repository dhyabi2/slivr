// eye.mjs — the agent's "eye" on a rendered web page (Block 11). Chosen via the brainstorm engine as
// the best + CHEAPEST approach: TEXT-FIRST. Render the page with the system's installed Chrome in
// headless mode and read the POST-JS rendered DOM as plain TEXT (`--dump-dom`) — this catches the
// common bugs (literal "\n" shown on screen, blank page, wrong/missing text) with no vision-token cost.
// A screenshot (`--screenshot`) is a second tier, only when true visual layout perception is needed.
// Zero new dependencies (system Chrome/Chromium/Edge); `npx playwright` is a last-resort fallback.

import fs from "node:fs";
import { spawnSync } from "node:child_process";

const CANDIDATES = [
  process.env.CHROME_PATH, process.env.SLIVR_CHROME,
  "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean);

// First usable browser binary (absolute path or PATH name), or null.
export function findBrowser() {
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

const COMMON = ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--virtual-time-budget=2500"];
export const dumpDomArgs = (url) => [...COMMON, "--dump-dom", url];
export const screenshotArgs = (url, outPng, { width = 1000, height = 750 } = {}) =>
  [...COMMON, "--hide-scrollbars", `--screenshot=${outPng}`, `--window-size=${width},${height}`, url];

// TIER 1 (cheap): the post-JS rendered DOM as text. { ok:true, dom } | { ok:false, error }.
export function renderDom(htmlAbs) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: "no headless browser found — install Google Chrome, or set CHROME_PATH" };
  const r = spawnSync(browser, dumpDomArgs("file://" + htmlAbs), { timeout: 30000, encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.error || !r.stdout) return { ok: false, error: `render failed: ${r.error ? r.error.message : "no output"}` };
  return { ok: true, dom: r.stdout };
}

// TIER 2 (visual): a PNG screenshot. { ok:true, browser } | { ok:false, error }.
export function renderShot(htmlAbs, outPng, opts = {}) {
  const ok = () => { try { return fs.existsSync(outPng) && fs.statSync(outPng).size > 0; } catch { return false; } };
  const browser = findBrowser();
  if (browser) {
    const r = spawnSync(browser, screenshotArgs("file://" + htmlAbs, outPng, opts), { timeout: 30000, encoding: "utf8" });
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
