// gameharness.mjs — the agent's "hands + clock + X-ray" for web games (Block 15). The keystone that
// unlocks see-it-play / playtest / perf / balance / state checks. Zero new dependencies: it drives the
// game in the system's headless Chrome (reuses eye.mjs) — NO Chrome DevTools Protocol / WebSocket.
//
// Contract ("Simulacrum"): a slivr-built game exposes a deterministic control surface:
//   window.slivrSim = {
//     reset(seed),          // re-init deterministically (seed the RNG)
//     step(dtMs),           // advance ONE update+render by dtMs (no requestAnimationFrame)
//     input(key, isDown),   // set an input as held/released, e.g. input('ArrowRight', true)
//     state(),              // return a small JSON snapshot, e.g. {x, y, score, over}
//   }
// playGame() injects a driver that resets, applies a scripted input timeline, steps N frames, and
// records state snapshots — so the agent can verify the game ACTUALLY plays (moves, scores, ends).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderDom, renderDomGL, renderShot, renderDomUrl, renderDomGLUrl } from "./eye.mjs";
import { startInjectProxy } from "./proxy.mjs";

function read(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function decodeEntities(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Extract a game's LEVEL DATA for solvability certification. A lock-and-key/grid game can OPT IN by
// exposing window.slivrLevels — an array where each level is row-strings (["#S.G#",…]) or {rows:[…]} or
// {grid:[…]} (tiles: # wall, S spawn, G goal, k key, D door). Returns that array, or null when the game
// doesn't expose it (so the certifier never blocks games that don't use keys/doors). Mirrors buildHarness.
const LEVELS_DRIVER = `<script>(function(){function out(o){var el=document.getElementById('__slivr_levels_data');if(!el){el=document.createElement('pre');el.id='__slivr_levels_data';el.style.display='none';document.body.appendChild(el);}el.textContent=JSON.stringify(o);}function run(){try{var L=window.slivrLevels;if(L==null){out({error:'NO_LEVELS'});return;}out({ok:true,levels:L});}catch(e){out({error:String(e&&e.message||e)});}}if(document.readyState==='complete')run();else window.addEventListener('load',run);})();</script>`;
const inject = (html, driver) => (/<\/body>/i.test(html) ? html.replace(/<\/body>/i, driver + "</body>") : html + driver);
const parseLevelsDom = (dom) => {
  if (!dom.ok) return null;
  const m = dom.dom.match(/<pre id="__slivr_levels_data"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  let r = null; try { r = JSON.parse(decodeEntities(m[1])); } catch { return null; }
  return r && r.ok && Array.isArray(r.levels) ? r.levels : null;
};

export function extractLevels(htmlAbs) {
  const gameHtml = read(htmlAbs);
  if (!gameHtml) return null;
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.slivr-levels-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, inject(gameHtml, LEVELS_DRIVER));
    return parseLevelsDom(renderDom(tmp));
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}

// extractLevels over HTTP: same window.slivrLevels contract, but for a SERVED page (Block 42) — inject the
// driver via the proxy and read it back. Returns the levels array or null. async.
export async function extractLevelsUrl(url) {
  const proxy = await startInjectProxy(url, (html) => inject(html, LEVELS_DRIVER));
  try { return parseLevelsDom(await renderDomUrl(proxy.url)); }
  finally { await proxy.close(); }
}

// Build a harness HTML: the game + an injected driver that runs the Simulacrum and writes a JSON
// result into a hidden <pre> that --dump-dom can read back.
export function buildHarness(gameHtml, plan = {}) {
  const seed = plan.seed ?? 1, steps = plan.steps ?? 120, dt = plan.dt ?? 16;
  const inputs = JSON.stringify(plan.inputs || []);
  const driver = `<script>(function(){
  function out(o){var el=document.getElementById('__slivr_out');if(!el){el=document.createElement('pre');el.id='__slivr_out';el.style.display='none';document.body.appendChild(el);}el.textContent=JSON.stringify(o);}
  function run(){try{
    var S=window.slivrSim;
    if(!S||typeof S.step!=='function'){out({error:'NO_SLIVR_SIM',hint:'the game must expose window.slivrSim={reset,step,input,state}'});return;}
    if(typeof S.reset==='function')S.reset(${seed});
    var INPUTS=${inputs},STEPS=${steps},DT=${dt},snaps=[],every=Math.max(1,Math.floor(STEPS/12));
    for(var i=0;i<STEPS;i++){
      for(var j=0;j<INPUTS.length;j++){if(INPUTS[j].at===i&&typeof S.input==='function')S.input(INPUTS[j].key,!!INPUTS[j].down);}
      S.step(DT);
      if(typeof S.state==='function'&&(i%every===0))snaps.push(S.state());
    }
    if(typeof S.state==='function')snaps.push(S.state());
    out({ok:true,steps:STEPS,snapshots:snaps});
  }catch(e){out({error:String(e&&e.message||e)});}}
  if(document.readyState==='complete')run();else window.addEventListener('load',run);
})();</script>`;
  return /<\/body>/i.test(gameHtml) ? gameHtml.replace(/<\/body>/i, driver + "</body>") : gameHtml + driver;
}

// Drive a game and observe it. Returns { ok, result:{snapshots|error}, screenshot } | { ok:false, error }.
// plan: { seed, steps, dt, inputs:[{at,key,down}] }.
export function playGame(htmlAbs, plan = {}) {
  const gameHtml = read(htmlAbs);
  if (!gameHtml) return { ok: false, error: "FILE_NOT_FOUND_OR_EMPTY" };
  const dir = path.dirname(htmlAbs);                 // keep relative assets resolving
  const tmp = path.join(dir, `.slivr-harness-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, buildHarness(gameHtml, plan));
    const dom = renderDom(tmp);
    if (!dom.ok) return { ok: false, error: dom.error };
    const m = dom.dom.match(/<pre id="__slivr_out"[^>]*>([\s\S]*?)<\/pre>/);
    let result = null;
    if (m) { try { result = JSON.parse(decodeEntities(m[1])); } catch { /* leave null */ } }
    // final-frame screenshot (re-runs the deterministic driver, captures the end state)
    let screenshot = null;
    const png = path.join(os.tmpdir(), `slivr-game-${process.pid}-${Date.now()}.png`);
    const shot = renderShot(tmp, png);
    if (shot.ok) { try { screenshot = "data:image/png;base64," + fs.readFileSync(png).toString("base64"); } catch { /* */ } try { fs.unlinkSync(png); } catch { /* */ } }
    return { ok: true, result, screenshot };
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}

// --- Multi-level (Block 23 "Levels"): drive EVERY level and verify each loads, is DISTINCT (not a clone
// of level 1), plays, and — where the state exposes it — is completable. Extends the Simulacrum contract:
//   window.slivrSim.levels      // number of levels (or an array of level data)
//   window.slivrSim.load(i)     // load level i deterministically (or reset(i) if no load)
// plus the existing step/input/state. This is the verification surface for multi-level games.

// Build a harness that iterates levels: load each, snapshot its initial state (structural fingerprint),
// drive scripted inputs (behavioral check), and capture each level's initial frame for a contact sheet.
export function buildLevelsHarness(gameHtml, plan = {}) {
  const steps = plan.steps ?? 60, dt = plan.dt ?? 16, cap = plan.cap ?? 24;
  const inputs = JSON.stringify(plan.inputs || [{ at: 0, key: "ArrowRight", down: true }, { at: 0, key: "ArrowUp", down: true }, { at: 0, key: "Space", down: true }]);
  const driver = `<script>(function(){
  function out(o){var el=document.getElementById('__slivr_levels');if(!el){el=document.createElement('pre');el.id='__slivr_levels';el.style.display='none';document.body.appendChild(el);}el.textContent=JSON.stringify(o);}
  // canonical signature of a state, IGNORING any level-index field so a clone that only changes the index is still caught.
  function sig(s){try{if(s==null)return 'null';var o={};Object.keys(s).sort().forEach(function(k){if(/^(level|levelindex|index|stage|lvl)$/i.test(k))return;var v=s[k];o[k]=(typeof v==='number')?Math.round(v*10)/10:v;});return JSON.stringify(o);}catch(e){return String(s);}}
  function run(){try{
    var S=window.slivrSim;
    if(!S){out({error:'NO_SLIVR_SIM',hint:'expose window.slivrSim'});return;}
    var loadFn=(typeof S.load==='function')?function(i){return S.load(i);}:((typeof S.reset==='function')?function(i){return S.reset(i);}:null);
    if(!loadFn){out({error:'NO_LEVELS_CONTRACT',hint:'expose slivrSim.load(i) (or reset(i)) and slivrSim.levels (count or array)'});return;}
    var N=(typeof S.levels==='number')?S.levels:(Array.isArray(S.levels)?S.levels.length:null);
    var INPUTS=${inputs},STEPS=${steps},DT=${dt},CAP=${cap};
    var cv=document.querySelector('canvas');
    var levels=[],max=(N!=null)?Math.min(N,CAP):CAP;
    for(var i=0;i<max;i++){
      var loaded=true;
      try{var r=loadFn(i);if(N==null&&r===false){break;}}catch(e){if(N==null){break;}loaded=false;}
      var s0=(typeof S.state==='function')?S.state():null;
      for(var k=0;k<STEPS;k++){for(var j=0;j<INPUTS.length;j++){if(INPUTS[j].at===k&&typeof S.input==='function')S.input(INPUTS[j].key,!!INPUTS[j].down);}if(typeof S.step==='function')S.step(DT);}
      var s1=(typeof S.state==='function')?S.state():null;
      var won=false;try{won=!!(s1&&(s1.won||s1.cleared||s1.complete||(s1.over&&s1.win)));}catch(e){}
      levels.push({index:i,loaded:loaded,sig:sig(s0),changed:sig(s0)!==sig(s1),won:won,frame:(cv?cv.toDataURL('image/png'):null)});
    }
    out({ok:true,count:levels.length,declared:N,levels:levels});
  }catch(e){out({error:String(e&&e.message||e)});}}
  if(document.readyState==='complete')setTimeout(run,150);else window.addEventListener('load',function(){setTimeout(run,150);});
})();</script>`;
  return /<\/body>/i.test(gameHtml) ? gameHtml.replace(/<\/body>/i, driver + "</body>") : gameHtml + driver;
}

// Contact sheet of each level's initial frame (so the agent SEES the levels are visually distinct).
function levelsSheetHtml(frames) {
  const cells = frames.map((f, i) => `<div style="text-align:center">${f ? `<img src="${f}" style="width:180px;height:auto;border:1px solid #333;background:#000">` : `<div style="width:180px;height:120px;background:#222;color:#888;display:flex;align-items:center;justify-content:center">no frame</div>`}<div style="color:#bbb;font:11px monospace;margin-top:3px">level ${i + 1}</div></div>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#0b0b0b;padding:8px;display:flex;flex-wrap:wrap;gap:8px">${cells}</body></html>`;
}

// Drive every level and report per-level loads/distinct/plays/won + an overall distinctness verdict.
export function playLevels(htmlAbs, plan = {}) {
  const gameHtml = read(htmlAbs);
  if (!gameHtml) return { ok: false, error: "FILE_NOT_FOUND_OR_EMPTY" };
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.slivr-levels-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, buildLevelsHarness(gameHtml, plan));
    const dom = renderDom(tmp);
    if (!dom.ok) return { ok: false, error: dom.error };
    const m = dom.dom.match(/<pre id="__slivr_levels"[^>]*>([\s\S]*?)<\/pre>/);
    let res = null;
    if (m) { try { res = JSON.parse(decodeEntities(m[1])); } catch { /* */ } }
    if (!res) return { ok: false, error: "LEVELS_PARSE_FAILED" };
    if (res.error) return { ok: false, error: res.error, hint: res.hint };
    // distinctness: group by signature — duplicate signatures across levels are clones.
    const counts = {};
    for (const l of res.levels) counts[l.sig] = (counts[l.sig] || 0) + 1;
    const clones = res.levels.filter((l) => counts[l.sig] > 1).map((l) => l.index + 1);
    const uniqueSigs = Object.keys(counts).length;
    const levels = res.levels.map((l) => ({ level: l.index + 1, loads: l.loaded, plays: l.changed, distinct: counts[l.sig] === 1, completable: l.won }));
    // contact sheet of initial frames
    let dataUrl = null;
    const png = path.join(os.tmpdir(), `slivr-levels-${process.pid}-${Date.now()}.png`);
    const sheet = path.join(os.tmpdir(), `slivr-levels-${process.pid}-${Date.now()}.html`);
    try {
      fs.writeFileSync(sheet, levelsSheetHtml(res.levels.slice(0, 12).map((l) => l.frame)));
      const shot = renderShot(sheet, png, { width: 1100, height: 700 });
      if (shot.ok) dataUrl = "data:image/png;base64," + fs.readFileSync(png).toString("base64");
    } catch { /* */ } finally { try { fs.unlinkSync(png); } catch { /* */ } try { fs.unlinkSync(sheet); } catch { /* */ } }
    return { ok: true, count: res.count, declared: res.declared, uniqueLevels: uniqueSigs, clones, levels, dataUrl };
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}

// --- Autoplay (Block 28): PLAY THE REAL GAME — dispatch real KeyboardEvent/MouseEvent into the running
// page and watch whether the SCREEN actually changes. Unlike the Simulacrum contract (which the agent can
// stub: input:()=>console.log(...)), this drives the game's OWN keydown/click handlers, so a frozen/dead
// game is caught even when the contract lies. Captures frames over virtual time and frame-diffs them.

const KEYCODES = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Space: 32, Enter: 13, KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyZ: 90, KeyX: 88, " ": 32 };

// Build the autoplay driver: a scripted timeline of REAL input events with frame captures between them.
function buildAutoplayDriver(plan = {}) {
  const keys = plan.keys && plan.keys.length ? plan.keys : ["ArrowRight", "Space", "ArrowUp", "ArrowLeft"];
  const clicks = plan.clicks || [];
  const holdMs = plan.holdMs ?? 500, settleMs = plan.settleMs ?? 80;
  return `<script>(function(){
  var KC=${JSON.stringify(KEYCODES)};
  function out(o){var el=document.getElementById('__slivr_play');if(!el){el=document.createElement('pre');el.id='__slivr_play';el.style.display='none';document.body.appendChild(el);}el.textContent=JSON.stringify(o);}
  var cv=document.querySelector('canvas');
  function frame(){try{return cv?cv.toDataURL('image/png'):null;}catch(e){return null;}}
  function small(){try{if(!cv)return null;var t=document.createElement('canvas');t.width=48;t.height=48;var x=t.getContext('2d');x.drawImage(cv,0,0,48,48);return x.getImageData(0,0,48,48).data;}catch(e){return null;}}
  // grid-MAX diff: a small sprite barely moves the whole-frame average, but it changes ONE cell a lot.
  // Split 48x48 into an 8x8 grid and return the MAX per-cell mean diff (0–100) — sensitive to motion.
  function meanDiff(a,b){if(!a||!b)return 0;var G=8,cell=6,sums=[],cnts=[],i;for(i=0;i<G*G;i++){sums[i]=0;cnts[i]=0;}
    for(var y=0;y<48;y++)for(var x=0;x<48;x++){var p=(y*48+x)*4;var d=(Math.abs(a[p]-b[p])+Math.abs(a[p+1]-b[p+1])+Math.abs(a[p+2]-b[p+2]))/3;var ci=Math.floor(y/cell)*G+Math.floor(x/cell);sums[ci]+=d;cnts[ci]++;}
    var mx=0;for(i=0;i<G*G;i++){var m=cnts[i]?sums[i]/cnts[i]:0;if(m>mx)mx=m;}return mx;}
  function fireKey(type,k){var code=KC[k]||0;var ev;try{ev=new KeyboardEvent(type,{key:k,code:k,keyCode:code,which:code,bubbles:true,cancelable:true});}catch(e){ev=document.createEvent('Event');ev.initEvent(type,true,true);ev.key=k;ev.keyCode=code;ev.which=code;}
    window.dispatchEvent(ev);document.dispatchEvent(ev);if(document.body)document.body.dispatchEvent(ev);}
  function fireClick(x,y){['mousedown','mouseup','click'].forEach(function(tp){var ev;try{ev=new MouseEvent(tp,{clientX:x,clientY:y,bubbles:true,cancelable:true});}catch(e){ev=document.createEvent('Event');ev.initEvent(tp,true,true);}(cv||document).dispatchEvent(ev);});}
  var KEYS=${JSON.stringify(keys)},CLICKS=${JSON.stringify(clicks)},HOLD=${holdMs},SETTLE=${settleMs};
  var frames=[],smalls=[],labels=[],errs=[];
  window.addEventListener('error',function(e){try{errs.push((e.message||'error')+(e.lineno?(':'+e.lineno):''));}catch(_){}}, true);
  function snap(label){frames.push(frame());smalls.push(small());labels.push(label);}
  function run(){try{
    snap('start');
    var steps=[];
    KEYS.forEach(function(k){steps.push({a:'down',k:k});steps.push({a:'wait'});steps.push({a:'snap',l:'hold '+k});steps.push({a:'up',k:k});});
    CLICKS.forEach(function(c){steps.push({a:'click',x:c.x,y:c.y});steps.push({a:'wait'});steps.push({a:'snap',l:'click'});});
    var i=0;
    function next(){
      if(i>=steps.length){finish();return;}
      var s=steps[i++];
      if(s.a==='down')fireKey('keydown',s.k);
      else if(s.a==='up')fireKey('keyup',s.k);
      else if(s.a==='click')fireClick(s.x,s.y);
      else if(s.a==='snap')snap(s.l);
      setTimeout(next, s.a==='wait'?HOLD:SETTLE);
    }
    next();
  }catch(e){out({error:String(e&&e.message||e)});}}
  function finish(){
    // movement = max frame-diff vs the start frame (did the screen respond to ANY input?)
    var base=smalls[0],maxd=0,perStep=[];
    for(var i=1;i<smalls.length;i++){var d=Math.round(meanDiff(base,smalls[i])/255*100);maxd=Math.max(maxd,d);perStep.push({label:labels[i],change:d});}
    out({ok:true,responds:maxd>=2,maxChange:maxd,perStep:perStep,frames:frames,errors:errs});
  }
  if(document.readyState==='complete')setTimeout(run,300);else window.addEventListener('load',function(){setTimeout(run,300);});
})();</script>`;
}

// Drive a game with REAL input events and report whether it responds. Returns { ok, responds, maxChange,
// perStep, errors, dataUrl(contact sheet) } | { ok:false, error }.
// Inject the RAF shim + the autoplay driver into a game's HTML (shared by the file + url paths).
// requestAnimationFrame does NOT tick under headless --dump-dom (no compositor), so a game's RAF loop would
// never advance and every frame would look identical (false "frozen"). Shim RAF→setTimeout FIRST (before
// the game script) so the loop advances deterministically under --virtual-time-budget.
function injectAutoplay(gameHtml, plan) {
  const driver = buildAutoplayDriver(plan);
  const RAF_SHIM = `<script>window.requestAnimationFrame=function(cb){return setTimeout(function(){cb(Date.now());},16);};window.cancelAnimationFrame=function(id){clearTimeout(id);};</script>`;
  const withShim = /<head[^>]*>/i.test(gameHtml) ? gameHtml.replace(/<head[^>]*>/i, (h) => h + RAF_SHIM) : RAF_SHIM + gameHtml;
  return /<\/body>/i.test(withShim) ? withShim.replace(/<\/body>/i, driver + "</body>") : withShim + driver;
}

// Turn the rendered autoplay DOM into the result (responds/maxChange + a contact sheet the agent SEES).
function finishAutoplay(dom) {
  if (!dom.ok) return { ok: false, error: dom.error };
  const m = dom.dom.match(/<pre id="__slivr_play"[^>]*>([\s\S]*?)<\/pre>/);
  let res = null;
  if (m) { try { res = JSON.parse(decodeEntities(m[1])); } catch { /* */ } }
  if (!res) return { ok: false, error: "AUTOPLAY_PARSE_FAILED" };
  if (res.error) return { ok: false, error: res.error };
  let dataUrl = null;
  const png = path.join(os.tmpdir(), `slivr-autoplay-${process.pid}-${Date.now()}.png`);
  const sheet = path.join(os.tmpdir(), `slivr-autoplay-${process.pid}-${Date.now()}.html`);
  try {
    const cells = (res.frames || []).slice(0, 8).map((f, i) => `<div style="text-align:center">${f ? `<img src="${f}" style="width:200px;border:1px solid #333;background:#000">` : "no frame"}<div style="color:#bbb;font:11px monospace">${i === 0 ? "start" : "step " + i}</div></div>`).join("");
    fs.writeFileSync(sheet, `<!doctype html><body style="margin:0;background:#0b0b0b;display:flex;flex-wrap:wrap;gap:8px;padding:8px">${cells}</body>`);
    const shot = renderShot(sheet, png, { width: 1100, height: 600 });
    if (shot.ok) dataUrl = "data:image/png;base64," + fs.readFileSync(png).toString("base64");
  } catch { /* */ } finally { try { fs.unlinkSync(png); } catch { /* */ } try { fs.unlinkSync(sheet); } catch { /* */ } }
  return { ok: true, responds: res.responds, maxChange: res.maxChange, perStep: res.perStep, errors: res.errors || [], dataUrl };
}

export function autoPlay(htmlAbs, plan = {}) {
  const gameHtml = read(htmlAbs);
  if (!gameHtml) return { ok: false, error: "FILE_NOT_FOUND_OR_EMPTY" };
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.slivr-autoplay-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, injectAutoplay(gameHtml, plan));
    return finishAutoplay(renderDomGL(tmp, plan.budget || 9000));
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}

// autoPlay over HTTP: drive a SERVED game with real input via the injecting proxy (Block 42). async.
export async function autoPlayUrl(url, plan = {}) {
  const proxy = await startInjectProxy(url, (html) => injectAutoplay(html, plan));
  try { return finishAutoplay(await renderDomGLUrl(proxy.url, plan.budget || 9000)); }
  finally { await proxy.close(); }
}
