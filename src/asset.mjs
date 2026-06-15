// asset.mjs — the Asset Studio (Block 16): render ONE generated asset in isolation so the agent can
// SEE it with its multimodal eye and run a generate→see→critique→refine loop — the artist's feedback
// loop that turns "programmer art" into something intentional. Zero new dependencies (system Chrome,
// reuses eye.mjs). Supports the techniques the headless eye can actually capture:
//   • SVG     — smooth ORGANIC 2D shapes via Bézier curves (DOM-rendered, crisp + scalable)
//   • Canvas  — procedural TEXTURES (noise/gradients), shading/LIGHTING, sprites (2D canvas)
// (WebGL/shader output is NOT captured by headless screenshots, so it isn't offered here.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderShot } from "./eye.mjs";

// A tiny value-noise helper the agent can call inside canvas code (seamless-ish, zero-dep), so it
// doesn't have to reinvent noise for natural textures. Exposed in the wrapper as `noise(x,y)`.
const NOISE_LIB = `
function __hash(x,y){var n=Math.sin(x*127.1+y*311.7)*43758.5453;return n-Math.floor(n);}
function __smooth(t){return t*t*(3-2*t);}
function noise(x,y){var xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
 var a=__hash(xi,yi),b=__hash(xi+1,yi),c=__hash(xi,yi+1),d=__hash(xi+1,yi+1);
 var u=__smooth(xf),v=__smooth(yf);return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v;}
function fbm(x,y,oct){oct=oct||5;var s=0,a=0.5,f=1;for(var i=0;i<oct;i++){s+=a*noise(x*f,y*f);f*=2;a*=0.5;}return s;}`;

function htmlFor({ svg, canvas, html, width = 256, height = 256, bg = "#ffffff" }) {
  const fill = bg === "transparent" ? "background:transparent" : `background:${bg}`;
  if (svg) {
    return `<!doctype html><html><body style="margin:0;${fill}"><div style="display:flex;align-items:center;justify-content:center;width:${width}px;height:${height}px">${svg}</div></body></html>`;
  }
  if (canvas) {
    const pre = bg === "transparent" ? "" : `ctx.fillStyle=${JSON.stringify(bg)};ctx.fillRect(0,0,W,H);`;
    return `<!doctype html><html><body style="margin:0"><canvas id="c" width="${width}" height="${height}"></canvas><script>${NOISE_LIB}
var c=document.getElementById('c'),ctx=c.getContext('2d'),W=${width},H=${height};${pre}
try{(function(ctx,W,H){ ${canvas} })(ctx,W,H);}catch(e){document.title='ASSET_ERR:'+e.message;}
</script></body></html>`;
  }
  return `<!doctype html><html><body style="margin:0;${fill}">${html || ""}</body></html>`;
}

// Render an asset to a PNG and return { ok, dataUrl, width, height } | { ok:false, error }.
export function renderAsset(spec = {}) {
  if (!spec.svg && !spec.canvas && !spec.html) return { ok: false, error: "NO_ASSET", hint: "pass one of: svg, canvas (draw code), or html" };
  const width = spec.width || 256, height = spec.height || 256;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slivr-asset-"));
  const file = path.join(dir, "asset.html");
  const png = path.join(dir, "asset.png");
  try {
    fs.writeFileSync(file, htmlFor({ ...spec, width, height }));
    const shot = renderShot(file, png, { width, height });
    if (!shot.ok) return { ok: false, error: shot.error };
    const dataUrl = "data:image/png;base64," + fs.readFileSync(png).toString("base64");
    return { ok: true, dataUrl, width, height };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}
