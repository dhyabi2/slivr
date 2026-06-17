// structure.mjs — PRODUCTION-GAME STRUCTURE MODEL (Block 38).
//
// The agent's quality bar used to be PROSE ("recognizable characters, enemies, HUD, levels") with nothing
// measuring it — so it shipped a ~2% skeleton (one stacked-primitive character, one cube, a sphere "coin",
// flat green plane, black void sky) and called it "verified". This turns that prose into a TYPED, checkable
// scene-graph contract: a genre-keyed list of nodes, each with a STATIC code signal (deterministic, offline)
// and a VISION question (the semantic cross-check, asked by the done-gate's gemini judge). This file owns
// the STATIC channel + the scorer; the vision channel lives in loop.mjs (visionChecklistGame).
//
// Detection per node is deliberately CONSERVATIVE: the gate's job here is to catch the egregious skeleton
// (multiple entire required categories empty), NOT to nitpick a decent game — so a clearly-incomplete game
// is pushed back with a concrete missing-list, while a game that covers the production layers passes.

// genre → which node `applies` tags are in scope. "3d" pulls in lighting/envmap; "2d" drops them.
export function classifyGenre(task) {
  return /\b3d\b|three(?:\.js)?|webgl|first[- ]?person|\bfps\b|voxel|orbit/i.test(String(task || "")) ? "3d" : "2d";
}

// Was the user EXPLICIT about wanting something small? Then the production bar does not apply.
export function wantsMinimal(task) {
  return /\b(simple|minimal|basic|prototype|barebones|quick|rough|tiny|one[- ]?screen|placeholder)\b/i.test(String(task || ""));
}

// The contract. Each node: id, cat, label, required, weight, applies (genres), and a detector:
//   any:[…]      present if the combined match count across these patterns ≥ (min||1)
//   not:[…]      ANY match hard-zeros the node (anti-pattern: a black "sky", a sphere "coin", …)
//   palette:true negative-evidence node: present when pure-saturated-primary use is NOT dominant
const NODES = [
  // ENVIRONMENT — a world backdrop, not a black void over a flat plane
  { id: "env.sky", cat: "ENVIRONMENT", label: "sky / themed background (not a black void)", required: true, weight: 3, applies: ["2d", "3d"],
    any: ["createLinearGradient", "createRadialGradient\\([^)]*sky", "scene\\.background\\s*=", "CubeTextureLoader", "new THREE\\.Color\\((?!\\s*0x0{6})", "\\bSky\\b", "skybox", "gradient"],
    not: ["background\\s*=\\s*new THREE\\.Color\\(\\s*0x0{6}\\s*\\)", "background\\s*=\\s*['\"]#?0{3,6}['\"]"] },
  { id: "env.lighting", cat: "ENVIRONMENT", label: "a lighting rig (≥2 lights, e.g. key + ambient)", required: true, weight: 2, applies: ["3d"], min: 2,
    any: ["DirectionalLight", "HemisphereLight", "AmbientLight", "PointLight", "SpotLight", "RectAreaLight"] },
  { id: "env.ground", cat: "ENVIRONMENT", label: "a ground / terrain surface", required: true, weight: 1, applies: ["2d", "3d"],
    any: ["PlaneGeometry", "\\bground\\b", "\\bfloor\\b", "\\bterrain\\b", "fillRect\\(\\s*0\\s*,"] },

  // CHARACTER — a rigged, faced character, not a stack of primitives
  { id: "char.multipart", cat: "CHARACTER", label: "a multi-part character (body + head + limbs)", required: true, weight: 3, applies: ["2d", "3d"], min: 3,
    any: ["\\b(arm|leg|torso|hand|foot|limb|hat|shirt|overall)\\b", "\\bhead\\b", "group\\.add\\(", "\\.add\\(\\s*\\w*(arm|leg|head|body|hat)"] },
  { id: "char.face", cat: "CHARACTER", label: "a face (at least eyes)", required: true, weight: 2, applies: ["2d", "3d"],
    any: ["\\beye(s|ball)?\\b", "\\bpupil\\b", "\\bface\\b", "\\bmouth\\b", "\\bnose\\b"] },
  { id: "char.animation", cat: "CHARACTER", label: "character animation (idle/run/jump motion)", required: false, weight: 1, applies: ["2d", "3d"],
    any: ["walkCycle", "animState", "mixer\\.update", "Math\\.sin\\([^)]*(time|t\\b|frame)", "\\.rotation\\.[xyz]\\s*[+\\-]?="] },

  // ENEMIES — a roster that behaves
  { id: "enemy.roster", cat: "ENEMIES", label: "≥2 distinct enemy types", required: true, weight: 3, applies: ["2d", "3d"], min: 2,
    any: ["\\benem(y|ies)\\b", "\\bgoomba\\b", "\\bkoopa\\b", "\\bslime\\b", "\\bmonster\\b", "\\bmob\\b", "\\bfoe\\b"] },
  { id: "enemy.behavior", cat: "ENEMIES", label: "enemy behavior (patrol/chase update)", required: false, weight: 1, applies: ["2d", "3d"],
    any: ["enem(y|ies)[\\s\\S]{0,200}(position|velocity|patrol|chase|update|\\.x\\s*[+\\-]=)", "for\\s*\\([^)]*enem"] },

  // COLLECTIBLES — discs that get picked up, not spheres that sit there
  { id: "collect.coin", cat: "COLLECTIBLES", label: "collectibles / coins (discs, not spheres)", required: true, weight: 2, applies: ["2d", "3d"],
    any: ["\\bcoin\\b", "\\bcollectible\\b", "\\bpickup\\b", "\\bgem\\b", "\\bstar\\b"],
    not: ["coin[\\s\\S]{0,80}SphereGeometry"] },
  { id: "collect.pickup", cat: "COLLECTIBLES", label: "pickup logic (collect → score/count changes)", required: false, weight: 2, applies: ["2d", "3d"],
    any: ["score\\s*\\+=", "coins?\\s*\\+\\+", "coins?\\s*\\+=", "collect[\\s\\S]{0,80}(splice|remove|visible\\s*=\\s*false)"] },

  // STRUCTURE — a level of placed geometry, not one lone block
  { id: "struct.platforms", cat: "STRUCTURE", label: "platforms / level geometry (multiple)", required: true, weight: 2, applies: ["2d", "3d"], min: 2,
    any: ["\\bplatform", "\\bbrick", "\\bpipe", "\\btile", "BoxGeometry"] },

  // HUD — readouts on screen
  { id: "hud.readouts", cat: "HUD", label: "a HUD (score / lives / timer / level)", required: true, weight: 3, applies: ["2d", "3d"],
    any: ["fillText\\([^)]*(score|coin|life|lives|time|level)", "getElementById\\(['\"](score|hud|lives|coins|timer|level)", "innerHTML[\\s\\S]{0,40}(score|lives|coins|time)", "id=['\"]?(hud|score|lives)"] },
  { id: "hud.endgame", cat: "HUD", label: "win / game-over screens", required: false, weight: 1, applies: ["2d", "3d"],
    any: ["game\\s?over", "gameOver", "you\\s?win", "youwin", "\\bvictory\\b", "\\bdefeat\\b"] },

  // LEVELS — data-driven, with win/lose
  { id: "level.data", cat: "LEVELS", label: "data-driven level(s)", required: true, weight: 2, applies: ["2d", "3d"],
    any: ["const\\s+levels?\\s*=\\s*\\[", "\\blevelData\\b", "\\btilemap\\b", "layout\\s*:", "levels?\\s*\\[\\s*\\d", "stage(s)?\\s*=\\s*\\["] },
  { id: "level.winlose", cat: "LEVELS", label: "win + lose conditions", required: false, weight: 1, applies: ["2d", "3d"],
    any: ["\\bgoal\\b", "\\bflag\\b", "\\bfinish\\b", "reachGoal", "isDead", "\\bdeath\\b", "lives\\s*[-]"] },

  // MATERIALS — texture + palette discipline, not flat saturated plastic
  { id: "mat.texture", cat: "MATERIALS", label: "textures (CanvasTexture / patterns, not bare color)", required: true, weight: 3, applies: ["2d", "3d"],
    any: ["CanvasTexture", "TextureLoader", "createPattern", "getImageData", "drawImage", "normalMap", "roughnessMap", "envMap"] },
  { id: "mat.palette", cat: "MATERIALS", label: "a cohesive palette (not all saturated primaries)", required: true, weight: 2, applies: ["2d", "3d"], palette: true },

  // JUICE — feedback (optional, but counts toward polish)
  { id: "juice.feedback", cat: "JUICE", label: "juice (particles / sound / shake / transitions)", required: false, weight: 1, applies: ["2d", "3d"],
    any: ["\\bparticle", "AudioContext", "webkitAudioContext", "new Audio\\(", "oscillator", "screenShake", "\\bshake\\b", "createElement\\(['\"]audio"] },
];

// ASSET-SOURCE RULE (Block 43): for a 3D game, every asset MUST come from the vgsds MCP as a verified,
// textured GLB — never hand-rolled three.js primitive geometry. Returns a push-back reason or null.
// A ground PlaneGeometry / pure helper is allowed; ≥2 object primitives with NO GLB load → violation.
const ASSET_PRIMITIVES = /\bnew\s+THREE\.(Box|Sphere|Cylinder|Cone|Torus(Knot)?|Capsule|Icosahedron|Dodecahedron|Octahedron|Tetrahedron|Circle|Ring|Extrude|Lathe)Geometry\b/gi;
export function assetSourceViolation(html, task = "") {
  const s = String(html || "");
  if (wantsMinimal(task)) return null;
  const is3d = /WebGLRenderer|three(?:\.module|\.min)?\.js|\bTHREE\.|klokwork/i.test(s);
  if (!is3d) return null;
  // assets sourced correctly (a GLB loaded, or vgsds referenced) → fine.
  if (/GLTFLoader|GLTFExporter|\.glb\b|\.gltf\b|vgsds|loadAsset/i.test(s)) return null;
  const prims = (s.match(ASSET_PRIMITIVES) || []).length;
  if (prims >= 2) {
    return `3D ASSETS must come from the vgsds MCP (verified, textured GLB) — this game hand-builds ${prims} primitive geometr${prims === 1 ? "y" : "ies"} and loads NO .glb asset. Generate every character/enemy/prop/collectible with mcp__vgsds__vgsds_generate {prompt, textured:true}, load the returned .glb with GLTFLoader (a ground plane may stay a primitive). Do not hand-roll geometry or use any other asset tool.`;
  }
  return null;
}

// ANIMATION-DRIVER RULE (Block 48): a 3D game with a CHARACTER must DRIVE its motion every frame — a walk
// cycle / idle bob / jump pose via rig-part rotation or an AnimationMixer clip — not add the character as a
// static mesh that only TRANSLATES. The static-Mario bug: he slides around but his legs/arms/head never
// move. autoplay's "responds" is fooled by translation, so this is a separate deterministic check.
// Returns a push-back reason or null. Gated: 3D + a character present + not minimal.
const ANIM_DRIVERS = [
  // three.js / klokwork skeletal-clip playback
  /\bAnimationMixer\b/, /mixer\s*\.\s*update\s*\(/, /\bclipAction\s*\(/, /\bAnimationClip\b/, /\bAnimController\b/i,
  // an explicit walk-cycle / animation phase advanced over time
  /\b(walkCycle|walkPhase|gaitPhase|animPhase|animState|idleBob|strideLength|gait)\b/i,
  // per-PART rig motion: a named body part whose rotation/position is set from a phase/sin
  /\b(leftLeg|rightLeg|leftArm|rightArm|legL|legR|armL|armR|upperLeg|lowerLeg|thigh|shin|spine|head|torso|hips?|joint\d)\b[\s\S]{0,90}\.(rotation|quaternion|position)\b/i,
  /getObjectByName\s*\(\s*['"](leg|arm|head|spine|hip|hand|foot|thigh|shin|torso|joint)/i,
  /\.rotation\.[xyz]\s*=\s*[^;]*Math\.sin\s*\([^)]*(time|elapsed|clock|phase|frame|dist)/i,
  /\.position\.y\s*=\s*[^;]*Math\.sin\s*\([^)]*(time|elapsed|clock|phase|frame)/i,
];
const HAS_CHARACTER = /\b(player|character|hero|mario|avatar|protagonist|enemy|goomba|koopa)\b/i;
export function animationDriverViolation(html, task = "") {
  const s = String(html || "");
  if (wantsMinimal(task)) return null;
  if (classifyGenre(task) !== "3d") return null;            // 2D sprite animation is a different check
  const is3d = /WebGLRenderer|three(?:\.module|\.min)?\.js|\bTHREE\.|klokwork/i.test(s);
  if (!is3d || !HAS_CHARACTER.test(s)) return null;          // no character → nothing to animate → don't block
  if (ANIM_DRIVERS.some((re) => re.test(s))) return null;    // there is an animation driver → fine
  return `the 3D CHARACTER appears STATIC — the code builds/loads a character but never DRIVES per-part or rigged motion (no AnimationMixer.update, no clipAction, no walk-cycle phase, no per-frame node.rotation on rig parts like legs/arms/head). A character that only TRANSLATES is the "static Mario" bug. Animate it: request the vgsds asset RIGGED (vgsds_generate {prompt, textured:true, rigged:true}) and EITHER play its clip via THREE.AnimationMixer (clipAction(...).play() + mixer.update(dt) each frame) OR getObjectByName the rig's leg/arm/head nodes and set their .rotation from a walk phase you advance from velocity (legR=A*sin(phase), legL=A*sin(phase+PI), arms counter-swing) — a walk cycle when moving, an idle bob when still. Animate enemies too.`;
}

function countMatches(html, pattern) {
  try { return (html.match(new RegExp(pattern, "gi")) || []).length; } catch { return 0; }
}

// pure-saturated-primary hex usage (the #ff0000 / #00ff00 / #0000ff plastic look)
function primaryCount(html) {
  return countMatches(html, "0x(?:ff0000|00ff00|0000ff|ffff00|ff00ff|00ffff)") +
         countMatches(html, "#(?:f00|0f0|00f|ff0000|00ff00|0000ff)\\b");
}

function detectNode(node, html) {
  if (node.palette) {
    const prim = primaryCount(html);
    return { present: prim <= 3, count: prim, anti: false };
  }
  if (node.not && node.not.some((p) => countMatches(html, p) > 0)) return { present: false, count: 0, anti: true };
  let count = 0;
  for (const p of node.any || []) count += countMatches(html, p);
  return { present: count >= (node.min || 1), count, anti: false };
}

// Bundle the FULL client source for structure/asset/animation analysis: the entry HTML PLUS every local
// client-side .js/.mjs in the project. Modern games (and the served Node-app default) split logic into
// engine.js / game.js / levels.js — analyzing only index.html misses all of it, so a basic split-file game
// FALSELY PASSES the standard. Reading the project's JS alongside the HTML maps the real game. Reads from
// disk (the served files ARE the workdir files); bounded; skips deps, the Node server, and vendored libs.
// fsMod/pathMod injected for testability. Returns a single concatenated source string.
export function bundleGameSource(entryHtml, workdir, fsMod, pathMod, { maxBytes = 1_500_000 } = {}) {
  let src = String(entryHtml || "");
  if (!workdir || !fsMod || !pathMod) return src;
  const JS = new Set([".js", ".mjs", ".cjs"]);
  const SKIP = new Set(["node_modules", ".git", ".proov", ".slivr", "dist", "build", "out", "vendor", "coverage"]);
  let total = src.length;
  const walk = (dir) => {
    if (total >= maxBytes) return;
    let ents;
    try { ents = fsMod.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (total >= maxBytes) return;
      const full = pathMod.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(full); continue; }
      if (!JS.has(pathMod.extname(e.name).toLowerCase())) continue;
      if (/^server\.[mc]?js$/i.test(e.name)) continue;   // the Node http server is not client game code
      let buf;
      try { buf = fsMod.readFileSync(full, "utf8"); } catch { continue; }
      src += "\n" + buf; total += buf.length;
    }
  };
  walk(workdir);
  return src;
}

// Score a built game's HTML/JS against the structure contract for its genre. STATIC channel only —
// deterministic, no network, no browser. Returns the scorecard + the actionable missing-list.
// Pass the BUNDLED source (bundleGameSource) when the game splits logic into external .js files.
export function analyzeStructure(html, task = "") {
  const src = String(html || "");
  const genre = classifyGenre(task);
  const nodes = NODES.filter((n) => n.applies.includes(genre));
  const results = nodes.map((n) => ({ node: n, ...detectNode(n, src) }));

  const req = results.filter((r) => r.node.required);
  const opt = results.filter((r) => !r.node.required);
  const sum = (arr, pick) => arr.reduce((a, r) => a + pick(r), 0);
  const reqMax = sum(req, (r) => r.node.weight) || 1;
  const optMax = sum(opt, (r) => r.node.weight) || 1;
  const requiredScore = Math.round((sum(req, (r) => (r.present ? r.node.weight : 0)) / reqMax) * 100);
  const optionalScore = Math.round((sum(opt, (r) => (r.present ? r.node.weight : 0)) / optMax) * 100);
  const score = Math.round(0.75 * requiredScore + 0.25 * optionalScore);

  // a required CATEGORY is "empty" when none of its required nodes are present — the skeleton signature.
  const reqCats = [...new Set(req.map((r) => r.node.cat))];
  const zeroCategories = reqCats.filter((c) => req.filter((r) => r.node.cat === c).every((r) => !r.present));
  const missing = req.filter((r) => !r.present).map((r) => ({ id: r.node.id, label: r.node.label, anti: r.anti }));
  const antiHits = results.filter((r) => r.anti).map((r) => r.node.id);

  // PASS = the production layers are mostly there. FAIL = an egregious skeleton: 2+ entire required
  // categories empty, OR required coverage below half. Tuned so game6 (≈5 empty cats) fails and a game
  // that builds the real layers passes; deliberately lenient to avoid false-blocking a decent game.
  const pass = zeroCategories.length <= 1 && requiredScore >= 55;
  return { genre, score, requiredScore, optionalScore, pass, zeroCategories, missing, antiHits, nodes: results.map((r) => ({ id: r.node.id, present: r.present, count: r.count, anti: r.anti })) };
}

// Ranked "what's not built YET" for the genre — required-missing first, then absent OPTIONAL layers, each by
// weight. Feeds the Next-Step Suggester (Block 63): every item is a REAL gap the structure model found by
// inspecting the build, so a suggestion can never hallucinate. Returns [{id,label,cat,required,weight}].
export function structureGaps(html, task = "") {
  const src = String(html || "");
  const genre = classifyGenre(task);
  return NODES
    .filter((n) => n.applies.includes(genre) && !n.palette)   // palette is a quality check, not a buildable layer
    .map((n) => ({ n, present: detectNode(n, src).present }))
    .filter((x) => !x.present)
    .map((x) => ({ id: x.n.id, label: x.n.label, cat: x.n.cat, required: !!x.n.required, weight: x.n.weight }))
    .sort((a, b) => (Number(b.required) - Number(a.required)) || (b.weight - a.weight));
}
