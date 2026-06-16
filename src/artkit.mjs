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
// ---- proov artkit: draw RICH art (shading, texture, outline, harmony), never flat rectangles ----
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

// ARTKIT3D — Three.js helpers so a 3D game builds RECOGNIZABLE figures from GROUPED primitives + lit
// MeshStandard materials + procedural CanvasTextures, instead of a single flat BoxGeometry per entity
// (the "everything is a box" failure). Assumes THREE is in scope. Inline via the artkit {mode:"3d"} tool.
export const ARTKIT3D = `
// proper lighting — without it even spheres look flat. Returns the directional (key) light.
function lights3d(scene){scene.add(new THREE.HemisphereLight(0xffffff,0x445566,0.9));var d=new THREE.DirectionalLight(0xffffff,0.85);d.position.set(6,12,7);d.castShadow=true;scene.add(d);return d;}
function mat3d(color,o){o=o||{};return new THREE.MeshStandardMaterial({color:color,roughness:o.roughness==null?0.7:o.roughness,metalness:o.metalness||0,flatShading:!!o.flat});}
// a face texture (eyes + optional mustache) painted on a canvas → CanvasTexture (detail, not a blank sphere).
function faceTexture(skinHex,mustacheHex){var c=document.createElement('canvas');c.width=c.height=128;var x=c.getContext('2d');x.fillStyle=skinHex||'#f1b47a';x.fillRect(0,0,128,128);[46,82].forEach(function(ex){x.fillStyle='#fff';x.beginPath();x.arc(ex,52,13,0,7);x.fill();x.fillStyle='#23314a';x.beginPath();x.arc(ex,55,6,0,7);x.fill();x.fillStyle='#fff';x.beginPath();x.arc(ex-2,50,3,0,7);x.fill();});if(mustacheHex){x.fillStyle=mustacheHex;x.fillRect(36,74,56,13);x.fillRect(40,84,12,8);x.fillRect(76,84,12,8);}var t=new THREE.CanvasTexture(c);return t;}
// a HUMANOID character (Mario-ish): a THREE.Group of body+legs+head(w/face)+hat+arms — NOT one box.
function character3d(o){o=o||{};var g=new THREE.Group();var skin=o.skin||'#f1b47a',shirt=o.shirt!=null?o.shirt:0xe52521,pants=o.pants!=null?o.pants:0x0b5fa5,hat=o.hat!=null?o.hat:0xe52521;
  var legs=new THREE.Mesh(new THREE.CapsuleGeometry(0.42,0.5,6,12),mat3d(pants));legs.position.y=0.5;g.add(legs);
  var body=new THREE.Mesh(new THREE.CapsuleGeometry(0.46,0.6,6,12),mat3d(shirt));body.position.y=1.1;g.add(body);
  var head=new THREE.Mesh(new THREE.SphereGeometry(0.43,20,16),new THREE.MeshStandardMaterial({map:faceTexture(skin,o.mustache?'#3a2410':null),roughness:0.7}));head.position.y=1.85;g.add(head);
  var brim=new THREE.Mesh(new THREE.CylinderGeometry(0.52,0.52,0.08,18),mat3d(hat));brim.position.set(0,2.12,0.12);g.add(brim);
  var crown=new THREE.Mesh(new THREE.SphereGeometry(0.42,18,12,0,6.3,0,1.25),mat3d(hat));crown.position.y=2.15;g.add(crown);
  [-0.62,0.62].forEach(function(s){var arm=new THREE.Mesh(new THREE.CapsuleGeometry(0.16,0.5,4,8),mat3d(skin.indexOf('#')===0?0xf1b47a:shirt));arm.position.set(s,1.15,0);arm.rotation.z=s*0.2;g.add(arm);});
  g.traverse(function(m){if(m.isMesh){m.castShadow=true;m.receiveShadow=true;}});return g;}
// a low-poly ENEMY (goomba-ish): squat body + eyes + feet, distinct from the player.
function enemy3d(o){o=o||{};var g=new THREE.Group();var body=new THREE.Mesh(new THREE.SphereGeometry(0.5,16,12),mat3d(o.color!=null?o.color:0x8b5a2b,{flat:true}));body.scale.y=0.85;body.position.y=0.5;g.add(body);
  [-0.18,0.18].forEach(function(s){var e=new THREE.Mesh(new THREE.SphereGeometry(0.1,10,8),mat3d(0xffffff));e.position.set(s,0.62,0.42);g.add(e);var p=new THREE.Mesh(new THREE.SphereGeometry(0.045,8,6),mat3d(0x111111));p.position.set(s,0.62,0.5);g.add(p);});
  [-0.25,0.25].forEach(function(s){var f=new THREE.Mesh(new THREE.CapsuleGeometry(0.12,0.06,3,6),mat3d(0x3a2410));f.position.set(s,0.08,0.1);g.add(f);});
  g.traverse(function(m){if(m.isMesh)m.castShadow=true;});return g;}
// a spinning gold COIN (metalness reads as gold, not a flat yellow box).
function coin3d(){var m=new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.4,0.08,22),new THREE.MeshStandardMaterial({color:0xffd23f,metalness:0.45,roughness:0.35,emissive:0xb8860b,emissiveIntensity:0.25}));m.rotation.x=Math.PI/2;m.castShadow=true;return m;}
// a low-poly TREE (trunk + cone foliage) and a green ground PLANE with a grass CanvasTexture.
function tree3d(){var g=new THREE.Group();var tr=new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.28,1.2,8),mat3d(0x6b4423,{roughness:0.9}));tr.position.y=0.6;g.add(tr);var top=new THREE.Mesh(new THREE.ConeGeometry(0.95,1.7,9),mat3d(0x2e8b3d,{flat:true}));top.position.y=1.85;g.add(top);g.traverse(function(m){if(m.isMesh)m.castShadow=true;});return g;}
function ground3d(size){size=size||80;var c=document.createElement('canvas');c.width=c.height=128;var x=c.getContext('2d');x.fillStyle='#5fa84f';x.fillRect(0,0,128,128);for(var i=0;i<500;i++){x.fillStyle='rgba(0,0,0,'+(Math.random()*0.07)+')';x.fillRect(Math.random()*128,Math.random()*128,2,7);}var t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(size/4,size/4);var m=new THREE.Mesh(new THREE.PlaneGeometry(size,size),new THREE.MeshStandardMaterial({map:t,roughness:1}));m.rotation.x=-Math.PI/2;m.receiveShadow=true;return m;}
`;
