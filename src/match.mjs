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

// A bbox may be normalized (all of x,y,w,h ≤ 1 → fractions of the image) or absolute pixels. The in-page
// code resolves it against naturalWidth/Height. Shared by crop + region-diff so both interpret boxes alike.
const BBOX_JS = `function px(v,dim){return (v<=1&&v>=0)?Math.round(v*dim):Math.round(v);}
function box(b,W,H){var x=px(b.x||0,W),y=px(b.y||0,H),w=px(b.w||0,W),h=px(b.h||0,H);
 x=Math.max(0,Math.min(W-1,x));y=Math.max(0,Math.min(H-1,y));w=Math.max(1,Math.min(W-x,w));h=Math.max(1,Math.min(H-y,h));return{x:x,y:y,w:w,h:h};}`;

// --- crop one asset out of an image (the rating-90 mechanic: drawImage the bbox onto a new canvas) -----
function cropHtml(srcUrl, bbox) {
  return `<!doctype html><html><body style="margin:0"><img id="s" src="${srcUrl}"><pre id="__slivr_crop" style="display:none"></pre>
<script>${BBOX_JS}
function out(o){document.getElementById('__slivr_crop').textContent=JSON.stringify(o);}
window.addEventListener('load',function(){setTimeout(function(){try{
 var s=document.getElementById('s');if(!s.naturalWidth){out({error:'SRC_LOAD_FAILED'});return;}
 var b=box(${JSON.stringify(bbox)},s.naturalWidth,s.naturalHeight);
 var cv=document.createElement('canvas');cv.width=b.w;cv.height=b.h;var x=cv.getContext('2d');
 x.drawImage(s,b.x,b.y,b.w,b.h,0,0,b.w,b.h);
 out({ok:true,w:b.w,h:b.h,dataUrl:cv.toDataURL('image/png')});
}catch(e){out({error:String(e&&e.message||e)});}},60);});
</script></body></html>`;
}

// Crop a bbox region out of an image into a PNG file. bbox {x,y,w,h} normalized (≤1) or pixels.
// Returns { ok, path, width, height } | { ok:false, error }.
export function cropImage(srcAbs, bbox, outAbs) {
  if (!fs.existsSync(srcAbs)) return { ok: false, error: "SRC_NOT_FOUND" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slivr-crop-"));
  const file = path.join(dir, "crop.html");
  try {
    fs.writeFileSync(file, cropHtml(dataUrl(srcAbs), bbox));
    const dom = renderDom(file);
    if (!dom.ok) return { ok: false, error: dom.error };
    const m = dom.dom.match(/<pre id="__slivr_crop"[^>]*>([\s\S]*?)<\/pre>/);
    let res = null;
    if (m) { try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { /* */ } }
    if (!res || res.error) return { ok: false, error: (res && res.error) || "CROP_PARSE_FAILED" };
    const b64 = res.dataUrl.split(",")[1];
    fs.writeFileSync(outAbs, Buffer.from(b64, "base64"));
    return { ok: true, path: outAbs, width: res.w, height: res.h };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}

// --- per-asset scorecard + whole-scene oversight (the disruptive granular compare) --------------------
// regions: [{label?, x, y, w, h}] (normalized or px). Diffs EACH region of target vs candidate at high
// sensitivity AND the whole image, and draws an annotated composite (boxes tinted by per-asset score).
function regionsHtml(targetUrl, candUrl, regions, { box = 480 } = {}) {
  return `<!doctype html><html><body style="margin:0;background:#0b0b0b;font:11px monospace;color:#ddd">
<div id="wrap" style="display:flex;gap:10px;padding:8px;align-items:flex-start"></div>
<pre id="__slivr_regions" style="display:none"></pre>
<img id="t" src="${targetUrl}"><img id="c" src="${candUrl}">
<script>${BBOX_JS}
var BOX=${box}, REGIONS=${JSON.stringify(regions)};
function out(o){document.getElementById('__slivr_regions').textContent=JSON.stringify(o);}
function fit(img){var w=img.naturalWidth||BOX,h=img.naturalHeight||BOX,s=BOX/Math.max(w,h);return{w:Math.max(1,Math.round(w*s)),h:Math.max(1,Math.round(h*s))};}
function ctxOf(img,W,H){var cv=document.createElement('canvas');cv.width=W;cv.height=H;var x=cv.getContext('2d');x.fillStyle='#000';x.fillRect(0,0,W,H);x.drawImage(img,0,0,W,H);return x;}
function maeRegion(ad,bd,W,b){var t=0,n=0;for(var y=b.y;y<b.y+b.h;y++){for(var x=b.x;x<b.x+b.w;x++){var p=(y*W+x)*4;t+=(Math.abs(ad[p]-bd[p])+Math.abs(ad[p+1]-bd[p+1])+Math.abs(ad[p+2]-bd[p+2]))/3;n++;}}return n?t/n:0;}
function run(){try{
 var T=document.getElementById('t'),C=document.getElementById('c');
 if(!T.naturalWidth){out({error:'TARGET_LOAD_FAILED'});return;}
 if(!C.naturalWidth){out({error:'CANDIDATE_LOAD_FAILED'});return;}
 var d=fit(T),W=d.w,H=d.h;
 var tx=ctxOf(T,W,H),cx=ctxOf(C,W,H);
 var td=tx.getImageData(0,0,W,H).data,cd=cx.getImageData(0,0,W,H).data;
 // whole
 var wt=0,wn=0;for(var i=0;i<td.length;i+=4){wt+=(Math.abs(td[i]-cd[i])+Math.abs(td[i+1]-cd[i+1])+Math.abs(td[i+2]-cd[i+2]))/3;wn++;}
 var whole=Math.max(0,Math.round((1-(wn?wt/wn:0)/255)*100));
 var rows=[];
 for(var r=0;r<REGIONS.length;r++){var b=box(REGIONS[r],W,H);var m=maeRegion(td,cd,W,b);var sim=Math.max(0,Math.round((1-m/255)*100));rows.push({label:REGIONS[r].label||('asset'+(r+1)),similarity:sim,mae:Math.round(m),x:REGIONS[r].x,y:REGIONS[r].y,w:REGIONS[r].w,h:REGIONS[r].h});}
 rows.sort(function(a,b){return a.similarity-b.similarity;});
 // annotated composite: target + candidate with boxes tinted by score
 function panel(srcCtx,title){var cv=document.createElement('canvas');cv.width=W;cv.height=H;var x=cv.getContext('2d');x.drawImage(srcCtx.canvas,0,0);
   for(var r=0;r<REGIONS.length;r++){var b=box(REGIONS[r],W,H);var row=null;for(var k=0;k<rows.length;k++){if(rows[k].label===(REGIONS[r].label||('asset'+(r+1)))){row=rows[k];break;}}
     var sim=row?row.similarity:0;x.lineWidth=2;x.strokeStyle=sim>=90?'#2ecc71':sim>=75?'#f1c40f':'#e74c3c';x.strokeRect(b.x+1,b.y+1,b.w-2,b.h-2);}
   var d=document.createElement('div');cv.style.cssText='border:1px solid #333;background:#000';var lab=document.createElement('div');lab.textContent=title;lab.style.cssText='text-align:center;margin-top:4px';d.appendChild(cv);d.appendChild(lab);document.getElementById('wrap').appendChild(d);}
 panel(tx,'TARGET (boxes)');panel(cx,'YOURS (green=match, red=off)');
 out({ok:true,whole:whole,regions:rows});
}catch(e){out({error:String(e&&e.message||e)});}}
window.addEventListener('load',function(){setTimeout(run,80);});
</script></body></html>`;
}

// Compare MANY asset regions at once + the whole scene. Returns { ok, whole, regions:[{label,similarity,
// mae,...}] sorted worst-first, dataUrl } | { ok:false, error }.
export function compareRegions(targetAbs, candAbs, regions, opts = {}) {
  if (!fs.existsSync(targetAbs)) return { ok: false, error: "TARGET_NOT_FOUND" };
  if (!fs.existsSync(candAbs)) return { ok: false, error: "CANDIDATE_NOT_FOUND" };
  if (!Array.isArray(regions) || !regions.length) return { ok: false, error: "NO_REGIONS" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slivr-regions-"));
  const file = path.join(dir, "regions.html");
  const png = path.join(dir, "regions.png");
  try {
    fs.writeFileSync(file, regionsHtml(dataUrl(targetAbs), dataUrl(candAbs), regions, opts));
    const dom = renderDom(file);
    if (!dom.ok) return { ok: false, error: dom.error };
    const m = dom.dom.match(/<pre id="__slivr_regions"[^>]*>([\s\S]*?)<\/pre>/);
    let res = null;
    if (m) { try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { /* */ } }
    if (!res) return { ok: false, error: "REGIONS_PARSE_FAILED" };
    if (res.error) return { ok: false, error: res.error };
    let dataUrlOut = null;
    const shot = renderShot(file, png, { width: 1100, height: 560 });
    if (shot.ok) { try { dataUrlOut = "data:image/png;base64," + fs.readFileSync(png).toString("base64"); } catch { /* */ } }
    return { ok: true, whole: res.whole, regions: res.regions, dataUrl: dataUrlOut };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}

// --- Block 20 (Beyond the Frame): derive a STYLE BASELINE from the picture, then score how well a NEW,
// invented asset (not in the picture, so it can't be pixel-diffed) ADHERES to that style. -------------

// Deterministic in-Chrome style extractor: a dominant colour palette (3D RGB histogram, fixed bins → no
// nondeterministic clustering) + average brightness/saturation (HSL) + contrast (stddev of lightness).
function profileHtml(srcUrl) {
  return `<!doctype html><html><body style="margin:0"><img id="s" src="${srcUrl}"><pre id="__slivr_prof" style="display:none"></pre>
<script>
function out(o){document.getElementById('__slivr_prof').textContent=JSON.stringify(o);}
function rgb2hsl(r,g,b){r/=255;g/=255;b/=255;var mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2,s=0,h=0,d=mx-mn;
 if(d){s=l>0.5?d/(2-mx-mn):d/(mx+mn);}return {h:h,s:s,l:l};}
window.addEventListener('load',function(){setTimeout(function(){try{
 var s=document.getElementById('s');if(!s.naturalWidth){out({error:'SRC_LOAD_FAILED'});return;}
 var W=Math.min(160,s.naturalWidth),H=Math.round(W*(s.naturalHeight/s.naturalWidth))||W;
 var cv=document.createElement('canvas');cv.width=W;cv.height=H;var x=cv.getContext('2d');x.drawImage(s,0,0,W,H);
 var d=x.getImageData(0,0,W,H).data;
 var bins={},sumL=0,sumS=0,Ls=[],n=0;
 for(var i=0;i<d.length;i+=4){var r=d[i],g=d[i+1],b=d[i+2],a=d[i+3];if(a<8)continue;
   var key=((r>>5)<<6)|((g>>5)<<3)|(b>>5);if(!bins[key])bins[key]={r:0,g:0,b:0,c:0};
   var bn=bins[key];bn.r+=r;bn.g+=g;bn.b+=b;bn.c++;
   var hsl=rgb2hsl(r,g,b);sumL+=hsl.l;sumS+=hsl.s;Ls.push(hsl.l);n++;}
 var arr=Object.keys(bins).map(function(k){var bn=bins[k];return {r:Math.round(bn.r/bn.c),g:Math.round(bn.g/bn.c),b:Math.round(bn.b/bn.c),c:bn.c};});
 arr.sort(function(a,b){return b.c-a.c || (a.r+a.g+a.b)-(b.r+b.g+b.b);});
 var top=arr.slice(0,6).map(function(o){return {rgb:[o.r,o.g,o.b],freq:Math.round(o.c/n*100)/100};});
 var meanL=n?sumL/n:0,varL=0;for(var j=0;j<Ls.length;j++)varL+=(Ls[j]-meanL)*(Ls[j]-meanL);
 out({ok:true,palette:top,brightness:Math.round(meanL*100)/100,saturation:Math.round((n?sumS/n:0)*100)/100,contrast:Math.round(Math.sqrt(Ls.length?varL/Ls.length:0)*100)/100});
}catch(e){out({error:String(e&&e.message||e)});}},60);});
</script></body></html>`;
}

// Extract a style profile { palette:[{rgb,freq}], brightness, saturation, contrast } from an image.
export function styleProfile(imgAbs) {
  if (!fs.existsSync(imgAbs)) return { ok: false, error: "IMG_NOT_FOUND" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slivr-prof-"));
  const file = path.join(dir, "profile.html");
  try {
    fs.writeFileSync(file, profileHtml(dataUrl(imgAbs)));
    const dom = renderDom(file);
    if (!dom.ok) return { ok: false, error: dom.error };
    const m = dom.dom.match(/<pre id="__slivr_prof"[^>]*>([\s\S]*?)<\/pre>/);
    let res = null;
    if (m) { try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { /* */ } }
    if (!res || res.error) return { ok: false, error: (res && res.error) || "PROFILE_PARSE_FAILED" };
    return { ok: true, profile: res };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}

function hex(rgb) { return "#" + rgb.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join(""); }

// Score how well an asset's profile adheres to an anchor profile. palette: each asset colour's nearest
// anchor colour (weighted by the asset colour's frequency) → 0–100; plus brightness/sat/contrast deltas.
function adherenceScore(anchor, asset) {
  const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) / 441.673;
  let wsum = 0, dsum = 0;
  for (const ac of asset.palette) {
    const nearest = Math.min(...anchor.palette.map((rc) => dist(ac.rgb, rc.rgb)));
    const w = ac.freq || (1 / asset.palette.length);
    wsum += w; dsum += w * nearest;
  }
  const palette = Math.max(0, Math.round((1 - (wsum ? dsum / wsum : 1)) * 100));
  const bDelta = Math.abs((anchor.brightness || 0) - (asset.brightness || 0));
  const sDelta = Math.abs((anchor.saturation || 0) - (asset.saturation || 0));
  const cDelta = Math.abs((anchor.contrast || 0) - (asset.contrast || 0));
  const tone = Math.max(0, Math.round((1 - (bDelta + sDelta + cDelta) / 3) * 100));
  const adherence = Math.round(palette * 0.7 + tone * 0.3);
  return { adherence, palette, tone, brightnessDelta: Math.round(bDelta * 100) / 100, saturationDelta: Math.round(sDelta * 100) / 100, contrastDelta: Math.round(cDelta * 100) / 100 };
}

// A composite the agent SEES: the invented asset beside the anchor palette + the asset's own palette, so
// the multimodal eye can judge "do these look like the same game/world?" (the qualitative half).
function swatchHtml(assetUrl, anchorPal, assetPal) {
  const row = (title, pal) => `<div style="margin:6px 0"><div style="color:#bbb;font:11px monospace">${title}</div><div style="display:flex">${pal.map((p) => `<div style="width:34px;height:34px;background:${hex(p.rgb)};border:1px solid #222" title="${hex(p.rgb)}"></div>`).join("")}</div></div>`;
  return `<!doctype html><html><body style="margin:0;background:#141414;padding:10px;font:12px monospace;color:#ddd;display:flex;gap:14px;align-items:flex-start">
<div><div style="color:#bbb">INVENTED ASSET</div><img src="${assetUrl}" style="max-width:240px;max-height:240px;border:1px solid #333;background:#000"></div>
<div>${row("ANCHOR PALETTE (the picture's world)", anchorPal)}${row("THIS ASSET'S PALETTE", assetPal)}<div style="color:#888;margin-top:8px">Same world? colours should live in the same family.</div></div>
</body></html>`;
}

// Verify an invented asset against a style anchor: deterministic adherence score + a composite for the eye.
export function styleAdherence(anchorProfile, assetAbs) {
  const ap = styleProfile(assetAbs);
  if (!ap.ok) return { ok: false, error: ap.error };
  const score = adherenceScore(anchorProfile, ap.profile);
  let dataUrlOut = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slivr-swatch-"));
  const file = path.join(dir, "swatch.html");
  const png = path.join(dir, "swatch.png");
  try {
    fs.writeFileSync(file, swatchHtml(dataUrl(assetAbs), anchorProfile.palette, ap.profile.palette));
    const shot = renderShot(file, png, { width: 560, height: 320 });
    if (shot.ok) { try { dataUrlOut = "data:image/png;base64," + fs.readFileSync(png).toString("base64"); } catch { /* */ } }
  } catch { /* */ } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  return { ok: true, ...score, assetProfile: ap.profile, dataUrl: dataUrlOut };
}

export { hex as hexColor };
