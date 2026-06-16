// scene3d.mjs — the 3D eye (Block 21 "Orbit"): most agents ship a flat, single-view "3D" game because they
// never SEE it from more than one angle. proov can: it drives a WebGL/Three.js scene's CAMERA to many
// angles in headless Chrome, captures each view (WebGL is capturable via the SwiftShader backend + the
// page's own canvas.toDataURL), assembles a CONTACT SHEET, and checks the views actually CHANGE as the
// camera orbits — so a flat billboard that ignores the camera is caught, not shipped. Zero new deps.
//
// Contract ("View"): a proov 3D scene exposes a deterministic camera surface:
//   window.proovView = {
//     setCamera({yaw, pitch, dist, target}),  // yaw/pitch in DEGREES, dist = distance to target, target=[x,y,z]
//     render(),                                // render ONE frame at the current camera (your RAF loop calls this)
//   }
// The renderer MUST be created with preserveDrawingBuffer:true so toDataURL captures the drawn frame.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderDomGL, renderShot } from "./eye.mjs";

function read(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function decodeEntities(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Inject a driver that orbits the camera through `angles` (each {yaw,pitch,dist}), captures each frame as a
// data URL, and measures how much consecutive views differ (so a camera-ignoring billboard reads ~0).
export function buildOrbitDriver(plan = {}) {
  const angles = plan.angles && plan.angles.length ? plan.angles : [0, 60, 120, 180, 240, 300].map((yaw) => ({ yaw }));
  const pitch = plan.pitch ?? 22, dist = plan.dist ?? 6, target = plan.target ?? [0, 0, 0];
  // Stop polling for the contract well BEFORE Chrome dumps the DOM (the virtual-time-budget), so a scene
  // that never sets the contract still reports NO_VIEW_CONTRACT instead of producing no output at all.
  const pollMs = Math.max(1000, (plan.budget || 9000) - 1500);
  return `<script>(function(){
  function out(o){var el=document.getElementById('__proov_view');if(!el){el=document.createElement('pre');el.id='__proov_view';el.style.display='none';document.body.appendChild(el);}el.textContent=JSON.stringify(o);}
  function smallData(cv){try{var t=document.createElement('canvas');t.width=48;t.height=48;var x=t.getContext('2d');x.drawImage(cv,0,0,48,48);return x.getImageData(0,0,48,48).data;}catch(e){return null;}}
  function meanDiff(a,b){if(!a||!b)return 0;var t=0,n=0;for(var i=0;i<a.length;i+=4){t+=(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]))/3;n++;}return n?t/n:0;}
  function ready(){var V=window.proovView;return V&&typeof V.setCamera==='function'&&typeof V.render==='function'&&document.querySelector('canvas');}
  function run(){try{
    var V=window.proovView;
    if(!V||typeof V.setCamera!=='function'||typeof V.render!=='function'){out({error:'NO_VIEW_CONTRACT',hint:'expose window.proovView={setCamera({yaw,pitch,dist,target}),render()} and create the renderer with preserveDrawingBuffer:true. (If you load Three.js as an ES module from a CDN, set window.proovView from INSIDE the module after it loads.)'});return;}
    var cv=document.querySelector('canvas');
    if(!cv){out({error:'NO_CANVAS'});return;}
    var ANGLES=${JSON.stringify(angles)},PITCH=${pitch},DIST=${dist},TARGET=${JSON.stringify(target)};
    var frames=[],small=[],labels=[];
    for(var i=0;i<ANGLES.length;i++){
      var a=ANGLES[i];
      V.setCamera({yaw:a.yaw||0,pitch:(a.pitch==null?PITCH:a.pitch),dist:(a.dist==null?DIST:a.dist),target:TARGET});
      V.render();
      frames.push(cv.toDataURL('image/png'));
      small.push(smallData(cv));
      labels.push('yaw '+(a.yaw||0)+'°');
    }
    var adj=[];for(var j=1;j<small.length;j++){adj.push(Math.round(meanDiff(small[j-1],small[j])/255*100));}
    out({ok:true,frames:frames,labels:labels,adjDiff:adj});
  }catch(e){out({error:String(e&&e.message||e)});}}
  // POLL for the contract for up to ~7s — Three.js loaded as an async ES module from a CDN won't have set
  // window.proovView by the time 'load' fires, so a fixed delay would spuriously report NO_VIEW_CONTRACT.
  var waited=0,POLL=${pollMs};function wait(){if(ready()){setTimeout(run,150);return;}waited+=150;if(waited>POLL){run();return;}setTimeout(wait,150);}
  if(document.readyState==='complete')wait();else window.addEventListener('load',wait);
})();</script>`;
}

// Lay the captured frames out as a labelled contact sheet (2D DOM → normal screenshot captures it).
function contactSheetHtml(frames, labels) {
  const cells = frames.map((f, i) => `<div style="text-align:center"><img src="${f}" style="width:200px;height:auto;border:1px solid #333;background:#000"><div style="color:#bbb;font:11px monospace;margin-top:3px">${labels[i] || ("view " + (i + 1))}</div></div>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#0b0b0b;padding:8px;display:flex;flex-wrap:wrap;gap:8px">${cells}</body></html>`;
}

// Orbit a 3D scene and observe it. Returns { ok, views, adjDiff, responds, dataUrl } | { ok:false, error }.
// `responds` = the camera actually changes the view (true 3D camera) vs a flat billboard that ignores it.
export function orbitScene(htmlAbs, plan = {}) {
  const sceneHtml = read(htmlAbs);
  if (!sceneHtml) return { ok: false, error: "FILE_NOT_FOUND_OR_EMPTY" };
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.proov-orbit-${process.pid}-${Date.now()}.html`);
  try {
    const driver = buildOrbitDriver(plan);
    const merged = /<\/body>/i.test(sceneHtml) ? sceneHtml.replace(/<\/body>/i, driver + "</body>") : sceneHtml + driver;
    fs.writeFileSync(tmp, merged);
    const dom = renderDomGL(tmp, plan.budget || 9000);
    if (!dom.ok) return { ok: false, error: dom.error };
    const m = dom.dom.match(/<pre id="__proov_view"[^>]*>([\s\S]*?)<\/pre>/);
    let res = null;
    if (m) { try { res = JSON.parse(decodeEntities(m[1])); } catch { /* */ } }
    if (!res) return { ok: false, error: "ORBIT_PARSE_FAILED" };
    if (res.error) return { ok: false, error: res.error, hint: res.hint };
    // build the contact sheet image
    let dataUrl = null;
    const sheet = path.join(os.tmpdir(), `proov-orbit-${process.pid}-${Date.now()}.png`);
    const sheetHtml = path.join(os.tmpdir(), `proov-orbit-${process.pid}-${Date.now()}.html`);
    try {
      fs.writeFileSync(sheetHtml, contactSheetHtml(res.frames, res.labels));
      const shot = renderShot(sheetHtml, sheet, { width: 1100, height: 700 });
      if (shot.ok) dataUrl = "data:image/png;base64," + fs.readFileSync(sheet).toString("base64");
    } catch { /* */ } finally { try { fs.unlinkSync(sheet); } catch { /* */ } try { fs.unlinkSync(sheetHtml); } catch { /* */ } }
    const adj = res.adjDiff || [];
    const maxAdj = adj.length ? Math.max(...adj) : 0;
    const responds = maxAdj >= 3; // views meaningfully change as the camera orbits
    return { ok: true, views: res.frames.length, adjDiff: adj, maxAdjDiff: maxAdj, responds, dataUrl };
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}
