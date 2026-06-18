// visuallint.mjs — DETERMINISTIC visual lint (Block 80). Render-level checks an LLM judge can't fudge: it
// instruments the 2D canvas BEFORE the game draws and records, while the game runs, draws that are OFF-CANVAS,
// ZERO/negative SIZE, or the SAME colour as the background (invisible). Catches the look bugs the vision
// checklist misses (an off-screen / behind-the-scenery / same-colour-as-bg HUD that the code "defines" but
// nobody can see). Browser-executed (skipped with no Chrome); pure helpers are unit-testable.
import fs from "node:fs";
import path from "node:path";
import { renderDomGL } from "./eye.mjs";

// Head-injected instrumentation. Wraps getContext('2d') so every later canvas wraps its draw ops; drives a
// little input so the game actually renders frames; writes a JSON tally to a hidden <pre>.
export function lintInject(budget = 9000, keys = ["ArrowRight", "ArrowUp", "Space"]) {
  return `<script>(function(){
  var O={off:0,zero:0,invis:0,total:0,bg:null};
  function ck(s){return (''+s).replace(/\\s+/g,'').toLowerCase();}
  var orig=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(t){
    var ctx=orig.apply(this,arguments); if(t!=='2d'||!ctx||ctx.__pl)return ctx; ctx.__pl=1; var cv=this;
    function inb(x,y,w,h){return (x+w)>0&&(y+h)>0&&x<cv.width&&y<cv.height;}
    function rec(x,y,w,h,style){O.total++;
      if(w<=0||h<=0){O.zero++;return;}
      if(!inb(x,y,w,h)){O.off++;return;}
      if((w*h)>=0.7*cv.width*cv.height&&style){O.bg=ck(style);}
      else if(O.bg&&style&&ck(style)===O.bg){O.invis++;}
    }
    var fr=ctx.fillRect.bind(ctx); ctx.fillRect=function(x,y,w,h){rec(x,y,w,h,ctx.fillStyle);return fr(x,y,w,h);};
    var sr=ctx.strokeRect.bind(ctx); ctx.strokeRect=function(x,y,w,h){rec(x,y,w,h,ctx.strokeStyle);return sr(x,y,w,h);};
    var di=ctx.drawImage.bind(ctx); ctx.drawImage=function(){var a=arguments; if(a.length>=5){rec(a[1],a[2],a[3],a[4],null);} else if(a.length>=3){var im=a[0];rec(a[1],a[2],(im&&(im.width||im.videoWidth))||0,(im&&(im.height||im.videoHeight))||0,null);} return di.apply(ctx,a);};
    var ftn=ctx.fillText.bind(ctx); ctx.fillText=function(s,x,y){O.total++; if(O.bg&&ck(ctx.fillStyle)===O.bg){O.invis++;} return ftn.apply(ctx,arguments);};
    return ctx;
  };
  function fire(){var keys=${JSON.stringify(keys)};keys.forEach(function(k){var c=(k==='Space')?' ':k,kc=(k==='ArrowRight')?39:(k==='ArrowUp')?38:(k==='ArrowLeft')?37:(k==='ArrowDown')?40:32;[document,window].forEach(function(tg){try{tg.dispatchEvent(new KeyboardEvent('keydown',{key:c,code:k,keyCode:kc,which:kc,bubbles:true}));}catch(e){}});});}
  window.addEventListener('load',function(){var n=0;(function loop(){fire();n+=200;if(n>=${Math.max(2000, budget - 1500)}){var p=document.createElement('pre');p.id='__proov_lint';p.style.display='none';p.textContent=JSON.stringify(O);document.body.appendChild(p);return;}setTimeout(loop,200);})();});
  })();</script>`;
}

// Parse the lint tally out of a rendered DOM string. Returns the tally object or null.
export function parseLint(dom) {
  const m = String(dom || "").match(/<pre id="__proov_lint"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { return null; }
}

// Turn a tally into human issues. Pure + unit-testable.
export function lintIssues(o) {
  if (!o) return [];
  const issues = [];
  const visible = (o.total || 0) - (o.off || 0) - (o.zero || 0) - (o.invis || 0);
  if (o.off > 0) issues.push(`${o.off} draw${o.off === 1 ? " is" : "s are"} OFF-CANVAS (drawn outside the visible area — the player can't see ${o.off === 1 ? "it" : "them"})`);
  if (o.zero > 0) issues.push(`${o.zero} draw${o.zero === 1 ? " has" : "s have"} ZERO / negative size (nothing renders)`);
  if (o.invis > 0) issues.push(`${o.invis} element${o.invis === 1 ? " is" : "s are"} the SAME colour as the background (invisible — e.g. text/HUD you can't read)`);
  if ((o.total || 0) > 0 && visible < 3) issues.push(`almost nothing is actually visible on the canvas (only ${visible} of ${o.total} draw ops land on screen)`);
  return issues;
}

// Run the lint on a static game HTML file. Returns { ran, issues:[...], raw } or { ran:false }.
export function visualLint(htmlAbs, { budget = 9000 } = {}) {
  let html = ""; try { html = fs.readFileSync(htmlAbs, "utf8"); } catch { return { ran: false }; }
  const inj = lintInject(budget);
  // inject at the TOP of <head> so it wraps getContext BEFORE the game's scripts call it.
  const out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inj) : inj + html;
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.proov-lint-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, out);
    const dom = renderDomGL(tmp, budget);
    if (!dom.ok) return { ran: false };
    const o = parseLint(dom.dom);
    if (!o) return { ran: false };
    return { ran: true, issues: lintIssues(o), raw: o };
  } catch { return { ran: false }; }
  finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}
