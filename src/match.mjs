// match.mjs — reference-image fidelity (Block 18): diff a built render against a TARGET picture so the
// agent can recreate a scene/game to LOOK LIKE the reference and VERIFY it, not just approximate it.
// Zero new deps: the diff runs INSIDE the system's headless Chrome (reuses eye.mjs). Both images are
// embedded as data URLs (same-origin → canvas getImageData is not tainted, no special Chrome flags).
//
// It returns (a) a deterministic SIMILARITY score 0–100, (b) the worst-matching REGIONS on a grid (what
// to fix and where), and (c) ONE composite image — target | candidate | diff heatmap — for the agent's
// eye. The model then reads the heatmap, fixes the worst regions, re-renders, and re-diffs until it matches.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderDom, renderShot } from "./eye.mjs";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
function dataUrl(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME[ext] || "image/png";
  return `data:${mime};base64,` + fs.readFileSync(absPath).toString("base64");
}

// Coarse human position word for a grid cell (row r, col c of GxG) — "top-left", "center", etc.
function region(r, c, g) {
  const ry = g <= 1 ? "center" : r < g / 3 ? "top" : r < (2 * g) / 3 ? "middle" : "bottom";
  const rx = g <= 1 ? "" : c < g / 3 ? "left" : c < (2 * g) / 3 ? "center" : "right";
  return rx && rx !== ry ? `${ry}-${rx}` : ry;
}

// Build the in-Chrome compare page: draw both images scaled into a common WxH box, compute per-cell mean
// absolute RGB difference on a GxG grid + the overall score, paint a heatmap, and dump a JSON result.
function compareHtml(targetUrl, candUrl, { box = 256, grid = 8 } = {}) {
  return `<!doctype html><html><body style="margin:0;background:#0b0b0b;font:12px monospace;color:#ddd">
<div id="wrap" style="display:flex;gap:8px;padding:8px;align-items:flex-start"></div>
<pre id="__slivr_diff" style="display:none"></pre>
<img id="t" crossorigin="anonymous" src="${targetUrl}">
<img id="c" crossorigin="anonymous" src="${candUrl}">
<script>
var BOX=${box}, G=${grid};
function out(o){document.getElementById('__slivr_diff').textContent=JSON.stringify(o);}
function fit(img){ // scale to fit a BOX x BOX' box preserving aspect of the TARGET
  var w=img.naturalWidth||BOX, h=img.naturalHeight||BOX, s=BOX/Math.max(w,h);
  return {w:Math.max(1,Math.round(w*s)), h:Math.max(1,Math.round(h*s))};
}
function draw(img,W,H){var cv=document.createElement('canvas');cv.width=W;cv.height=H;var x=cv.getContext('2d');x.fillStyle='#000';x.fillRect(0,0,W,H);x.drawImage(img,0,0,W,H);return x;}
function label(t){var d=document.createElement('div');d.textContent=t;d.style.cssText='text-align:center;margin-top:4px';return d;}
function panel(canvas,txt){var d=document.createElement('div');canvas.style.cssText='border:1px solid #333;background:#000';d.appendChild(canvas);d.appendChild(label(txt));document.getElementById('wrap').appendChild(d);}
function run(){
 try{
  var T=document.getElementById('t'), C=document.getElementById('c');
  if(!T.complete||!T.naturalWidth){out({error:'TARGET_LOAD_FAILED'});document.title='DIFF_ERR';return;}
  if(!C.complete||!C.naturalWidth){out({error:'CANDIDATE_LOAD_FAILED'});document.title='DIFF_ERR';return;}
  var dim=fit(T), W=dim.w, H=dim.h;
  var tc=draw(T,W,H), cc=draw(C,W,H);
  var td=tc.getImageData(0,0,W,H).data, cd=cc.getImageData(0,0,W,H).data;
  // heatmap canvas
  var hm=document.createElement('canvas');hm.width=W;hm.height=H;var hx=hm.getContext('2d');var hd=hx.createImageData(W,H);
  var cellSum=[],cellN=[];for(var i=0;i<G*G;i++){cellSum[i]=0;cellN[i]=0;}
  var total=0,n=0;
  for(var y=0;y<H;y++){for(var x=0;x<W;x++){
    var p=(y*W+x)*4;
    var d=(Math.abs(td[p]-cd[p])+Math.abs(td[p+1]-cd[p+1])+Math.abs(td[p+2]-cd[p+2]))/3;
    total+=d;n++;
    var ci=Math.min(G-1,Math.floor(y/H*G))*G+Math.min(G-1,Math.floor(x/W*G));
    cellSum[ci]+=d;cellN[ci]++;
    var v=Math.min(255,d*1.5);hd.data[p]=v;hd.data[p+1]=Math.max(0,80-v);hd.data[p+2]=Math.max(0,80-v);hd.data[p+3]=255;
  }}
  hx.putImageData(hd,0,0);
  var mae=n?total/n:0, sim=Math.max(0,Math.round((1-mae/255)*100));
  var cells=[];for(var r=0;r<G;r++){for(var c=0;c<G;c++){var idx=r*G+c;var m=cellN[idx]?cellSum[idx]/cellN[idx]:0;cells.push({r:r,c:c,diff:Math.round(m),sim:Math.round((1-m/255)*100)});}}
  cells.sort(function(a,b){return b.diff-a.diff;});
  panel(tc.canvas,'TARGET');panel(cc.canvas,'YOURS');panel(hm,'DIFF (red = mismatch)');
  out({ok:true,similarity:sim,mae:Math.round(mae),grid:G,worst:cells.slice(0,6)});
 }catch(e){out({error:String(e&&e.message||e)});document.title='DIFF_ERR';}
}
window.addEventListener('load',function(){setTimeout(run,60);});
</script></body></html>`;
}

// Compare a candidate image against a target image. Returns { ok, similarity, mae, worst:[{region,sim}],
// dataUrl } | { ok:false, error }. worst regions carry a human position word so the agent knows WHERE.
export function compareImages(targetAbs, candAbs, opts = {}) {
  if (!fs.existsSync(targetAbs)) return { ok: false, error: "TARGET_NOT_FOUND" };
  if (!fs.existsSync(candAbs)) return { ok: false, error: "CANDIDATE_NOT_FOUND" };
  const grid = opts.grid || 8;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slivr-match-"));
  const file = path.join(dir, "compare.html");
  const png = path.join(dir, "compare.png");
  try {
    fs.writeFileSync(file, compareHtml(dataUrl(targetAbs), dataUrl(candAbs), { grid }));
    const dom = renderDom(file);
    if (!dom.ok) return { ok: false, error: dom.error };
    const m = dom.dom.match(/<pre id="__slivr_diff"[^>]*>([\s\S]*?)<\/pre>/);
    let res = null;
    if (m) { try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { /* */ } }
    if (!res) return { ok: false, error: "DIFF_PARSE_FAILED" };
    if (res.error) return { ok: false, error: res.error };
    const worst = (res.worst || []).map((w) => ({ region: region(w.r, w.c, res.grid || grid), sim: w.sim, diff: w.diff }));
    // composite screenshot (target | yours | heatmap) for the agent's eye
    let dataUrlOut = null;
    const shot = renderShot(file, png, { width: 900, height: 360 });
    if (shot.ok) { try { dataUrlOut = "data:image/png;base64," + fs.readFileSync(png).toString("base64"); } catch { /* */ } }
    return { ok: true, similarity: res.similarity, mae: res.mae, worst, dataUrl: dataUrlOut };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}
