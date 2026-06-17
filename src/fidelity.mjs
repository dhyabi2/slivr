// fidelity.mjs — Task-Fidelity Gate (Tier 1, deterministic).
//
// The other done-gates prove the artifact is a WORKING program (compiles, renders, plays). They do NOT
// prove it did what was ASKED. A weak model can fetch a named repo, build a generic program that never
// references it, mark every task done, and pass every gate — because the program works. (Observed for
// real: asked to "make a puzzle using https://github.com/.../esg-coreach", gemini-flash-lite fetched the
// repo then shipped a generic score-game with ZERO references to the certifier, and every gate passed.)
//
// This closes that hole CHEAPLY and with near-zero false-rejection risk for its core case: if the prompt
// explicitly NAMES something to use (a github repo, a quoted library/identifier) and that name appears
// NOWHERE in the produced code, the central requirement almost certainly wasn't met.
//
// Design (validated via the brainstorm-exclusion methodology, practical 70): mechanical only — extract
// named entities from the ORIGINAL prompt by regex, grep the produced workspace for each name + its
// stems. No AST, no sandbox, no maintained per-language knowledge base, no LLM in the verification step.
// A MISS is ADVISORY: the gate pushes back ONCE, then lets the agent stop on the next done — so a wrong
// extraction costs at most one nudge, never a deadlock or a false hard-rejection of completed work.

const STOPWORDS = new Set([
  "this", "that", "game", "puzzle", "using", "with", "from", "main", "src", "index", "test", "tests",
  "node", "http", "https", "www", "com", "github", "gitlab", "app", "the", "and", "for", "build",
  "make", "create", "analyze", "advanced", "library", "module", "package", "code", "file", "files",
  "project", "system", "data", "user", "users", "page", "html", "json", "default", "based",
]);

// Split a name into searchable stems: the full name, the de-punctuated form, and each ≥4-char part.
//   "esg-coreach"  -> ["esg-coreach", "esgcoreach", "coreach"]   ("esg" dropped: <4 chars)
//   "loft-poc"     -> ["loft-poc", "loftpoc", "loft"]
function stemsOf(name) {
  const n = String(name).replace(/\.git$/i, "");
  const stems = [n, n.replace(/[-_.]/g, "")];
  for (const part of n.split(/[-_./]/)) if (part.length >= 4) stems.push(part);
  return stems;
}

// Pull the names the prompt explicitly asks to USE. Returns [{entity, stems}] (all lowercased). High
// PRECISION over recall: we only act on names the prompt names explicitly (a repo URL, a quoted/hyphenated
// identifier, or "use the X library/module/..."), because a miss nags the agent — noise is worse than a gap.
export function extractNamedRequirements(task) {
  if (typeof task !== "string" || !task) return [];
  const out = new Map(); // entity(lowercased) -> Set(stems)
  const add = (entity, stems) => {
    const key = String(entity).toLowerCase();
    if (!key || STOPWORDS.has(key)) return;
    const set = out.get(key) || new Set();
    for (const s of stems) { const t = String(s).toLowerCase(); if (t.length >= 4 && !STOPWORDS.has(t)) set.add(t); }
    if (set.size) out.set(key, set);
  };
  // 1) GitHub/GitLab repos: host/owner/repo -> the repo slug (owner is usually a personal handle, skip it).
  for (const m of task.matchAll(/(?:github|gitlab)\.com\/[\w.-]+\/([\w.-]+)/gi)) add(m[1], stemsOf(m[1]));
  // 2) Explicitly quoted / backticked identifiers that LOOK like a lib/module (have a separator or a capital).
  for (const m of task.matchAll(/[`"']([A-Za-z][\w./-]{3,40})[`"']/g)) {
    const id = m[1];
    if (/[-_./]/.test(id) || /[A-Z]/.test(id)) add(id.split("/").pop().replace(/^@/, ""), stemsOf(id.split("/").pop()));
  }
  // 3) "use/uses/using/with/import/integrate (the) X library|module|package|sdk|api|certifier|engine|..."
  //    — only when followed by an explicit kind-noun, so "use this" / "with a grid" don't trigger.
  const KIND = "library|module|package|sdk|api|certifier|engine|framework|tool|repo|repository|crate|gem|dependency";
  for (const m of task.matchAll(new RegExp(`\\b(?:use|uses|using|with|import|integrate)\\s+(?:the\\s+)?([A-Za-z][\\w.-]{3,40})\\s+(?:${KIND})\\b`, "gi"))) {
    add(m[1], stemsOf(m[1]));
  }
  return [...out.entries()].map(([entity, set]) => ({ entity, stems: [...set] }));
}

// Code/markup extensions worth grepping. (Docs are excluded by collectWorkspaceCode — see below.)
const CODE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".htm", ".css", ".json",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".php", ".c", ".cpp", ".cs", ".vue", ".svelte", ".astro",
]);
// Directories never counted. .proov/.slivr hold the agent's OWN blueprint/task metadata, which quotes the
// prompt verbatim — counting them would let the prompt's own words "satisfy" its own requirement.
const SKIP_DIR = new Set(["node_modules", ".git", ".proov", ".slivr", "dist", "build", ".next", "out", "coverage", ".cache", "vendor-cache"]);

// Concatenate the produced code (lowercased) so a stem can be membership-tested cheaply. Bounded so a huge
// workspace stays cheap. Excludes deps, agent metadata, and docs (README/*.md are weak evidence and often
// quote the prompt). NOTE: real vendored libs live under vendor/ and ARE counted (that's a legit "use").
export function collectWorkspaceCode(workdir, fsMod, pathMod, { maxBytes = 3_000_000, maxFileBytes = 400_000 } = {}) {
  let text = "";
  const files = [];
  let total = 0;
  const walk = (dir) => {
    if (total >= maxBytes) return;
    let ents;
    try { ents = fsMod.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (total >= maxBytes) return;
      const full = pathMod.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(full); continue; }
      const ext = pathMod.extname(e.name).toLowerCase();
      if (!CODE_EXT.has(ext)) continue;
      if (/^readme/i.test(e.name) || /\.md$/i.test(e.name)) continue; // docs: weak evidence; may quote the prompt
      let buf;
      try { buf = fsMod.readFileSync(full, "utf8"); } catch { continue; }
      if (buf.length > maxFileBytes) buf = buf.slice(0, maxFileBytes);
      text += "\n" + buf;
      total += buf.length;
      files.push(pathMod.relative(workdir, full));
    }
  };
  walk(workdir);
  return { text: text.toLowerCase(), files };
}

// Compare prompt-named requirements against produced code. A requirement MISSES when none of its stems
// appear anywhere in the code. Returns { misses:[{entity,stems}], checked:[entity], files:n }.
export function taskFidelityMisses(task, code) {
  const named = extractNamedRequirements(task);
  const checked = named.map((n) => n.entity);
  if (!named.length || !code || !code.files.length) return { misses: [], checked, files: code ? code.files.length : 0 };
  const misses = [];
  for (const n of named) {
    if (!n.stems.some((s) => code.text.includes(s))) misses.push(n);
  }
  return { misses, checked, files: code.files.length };
}
