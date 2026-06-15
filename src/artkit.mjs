// artkit.mjs — a procedural RICH-ART toolkit (Block 30): the fix for "programmer art" (flat coloured
// rectangles, richness ~25). These canvas helpers bake in the techniques that move richness toward 100 —
// harmonized palettes (no raw primaries), gradient SHADING (highlight→core-shadow), rim light, dark
// hue-shifted OUTLINES, specular dots, procedural GRAIN/texture, soft CONTACT SHADOWS, gradient SKIES and
// parallax HILLS. It's a string injected into canvas code (alongside the noise/fbm helpers), so any
// see_asset canvas — or a game that pastes it — can draw real little artworks instead of fillRect blocks.

// The value-noise helpers the artkit (grain/hills) depends on — provided so a GAME that inlines the kit
// has them too (see_asset already injects its own copy). Mirrors asset.mjs's NOISE_LIB.
export const NOISE_FBM_SRC = `
function __hash(x,y){var n=Math.sin(x*127.1+y*311.7)*43758.5453;return n-Math.floor(n);}
function __smooth(t){return t*t*(3-2*t);}
function noise(x,y){var xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;var a=__hash(xi,yi),b=__hash(xi+1,yi),c=__hash(xi,yi+1),d=__hash(xi+1,yi+1),u=__smooth(xf),v=__smooth(yf);return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v;}
function fbm(x,y,oct){oct=oct||5;var s=0,a=0.5,f=1;for(var i=0;i<oct;i++){s+=a*noise(x*f,y*f);f*=2;a*=0.5;}return s;}
`;

export const ARTKIT = `
// ---- slivr artkit: draw RICH art (shading, texture, outline, harmony), never flat rectangles ----
function _hsl(h,s,l){return 'hsl('+(((h%360)+360)%360)+','+Math.round(s)+'%,'+Math.round(l)+'%)';}
// harmonized palette: n swatches around a base hue, desaturated — NEVER pure #f00/#0f0 primaries.
function palette(baseHue,n){n=n||6;var offs=[0,28,-28,150,200,-60,90],o=[];for(var i=0;i<n;i++)o.push(_hsl(baseHue+(offs[i%offs.length]||i*37),52,56));return o;}
function _round(ctx,x,y,w,h,r){r=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
// a SHADED ball/blob — radial highlight→core-shadow, rim light, hue-shifted outline, specular dot.
// great for heads, coins, fruit, creatures, planets. lx/ly bias the light to the top-left (global key).
function shadedBall(ctx,x,y,r,hue){var lx=x-r*0.34,ly=y-r*0.34;
  var g=ctx.createRadialGradient(lx,ly,r*0.1,x,y,r*1.05);
  g.addColorStop(0,_hsl(hue,72,80));g.addColorStop(0.5,_hsl(hue,60,56));g.addColorStop(1,_hsl(hue,58,30));
  ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fill();
  ctx.strokeStyle=_hsl(hue,38,86);ctx.lineWidth=Math.max(1,r*0.07);ctx.beginPath();ctx.arc(x,y,r*0.95,0.5,2.3);ctx.stroke();    // rim light
  ctx.strokeStyle=_hsl(hue,48,18);ctx.lineWidth=Math.max(1,r*0.06);ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.stroke();           // outline
  ctx.fillStyle='rgba(255,255,255,0.75)';ctx.beginPath();ctx.arc(lx,ly,r*0.17,0,7);ctx.fill();}                                // specular
// a SHADED rounded box — vertical gradient body, top highlight, bottom ambient occlusion, outline.
// great for platforms, bricks, buildings, UI panels.
function shadedBox(ctx,x,y,w,h,hue){var g=ctx.createLinearGradient(0,y,0,y+h);g.addColorStop(0,_hsl(hue,48,60));g.addColorStop(1,_hsl(hue,56,32));
  ctx.fillStyle=g;_round(ctx,x,y,w,h,Math.min(8,h*0.22));ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.22)';_round(ctx,x+2,y+2,w-4,Math.max(2,h*0.16),4);ctx.fill();                              // top highlight
  ctx.fillStyle='rgba(0,0,0,0.18)';_round(ctx,x+2,y+h-Math.max(2,h*0.16)-2,w-4,Math.max(2,h*0.16),4);ctx.fill();              // bottom AO
  ctx.strokeStyle=_hsl(hue,46,20);ctx.lineWidth=Math.max(1.5,w*0.01);_round(ctx,x,y,w,h,Math.min(8,h*0.22));ctx.stroke();}    // outline
// two simple EYES with catchlights — the #1 character-appeal driver.
function eyes(ctx,x,y,r){[-1,1].forEach(function(s){var ex=x+s*r*0.5;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(ex,y,r*0.5,0,7);ctx.fill();ctx.fillStyle='#1a2230';ctx.beginPath();ctx.arc(ex+s*r*0.1,y+r*0.06,r*0.26,0,7);ctx.fill();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(ex+s*r*0.02,y-r*0.12,r*0.09,0,7);ctx.fill();});}
// procedural GRAIN overlay over a region (uses fbm) — kills the flat plastic look. amt~0.06–0.12.
function grain(ctx,x,y,w,h,amt){amt=amt||0.08;try{var id=ctx.getImageData(x,y,w,h),d=id.data;for(var j=0;j<h;j++)for(var i=0;i<w;i++){var n=(fbm((x+i)/7,(y+j)/7,4)-0.5)*255*amt,p=(j*w+i)*4;if(d[p+3]<8)continue;d[p]+=n;d[p+1]+=n;d[p+2]+=n;}ctx.putImageData(id,x,y);}catch(e){}}
// soft CONTACT SHADOW ellipse under a grounded object — stops sprites from floating.
function contactShadow(ctx,x,y,w){ctx.save();ctx.globalAlpha=0.25;ctx.fillStyle='#000';ctx.beginPath();ctx.ellipse(x,y,w*0.5,w*0.16,0,0,7);ctx.fill();ctx.restore();}
// gradient SKY (top hue → lighter bottom).
function sky(ctx,W,H,topHue,botHue){var g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,_hsl(topHue,55,70));g.addColorStop(1,_hsl(botHue==null?topHue:botHue,38,88));ctx.fillStyle=g;ctx.fillRect(0,0,W,H);}
// parallax HILL silhouette band (call 2–3× with rising baseY + lightening hue for atmospheric depth).
function hills(ctx,W,H,baseY,hue,seed){ctx.fillStyle=_hsl(hue,42,58);ctx.beginPath();ctx.moveTo(0,H);for(var x=0;x<=W;x+=6){var yy=baseY+Math.sin(x*0.012+(seed||0))*16+fbm(x/45,(seed||0)*3,3)*34;ctx.lineTo(x,yy);}ctx.lineTo(W,H);ctx.closePath();ctx.fill();}
`;
