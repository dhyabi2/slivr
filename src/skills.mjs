// skills.mjs — file-based reusable prompts ("slash-commands"). A skill is a .md file:
//
//   # Optional Title
//   <!-- description: one-line description -->
//   The prompt body. $ARGS (or {{args}}) is replaced with the user's args; $1 $2 ... with
//   positional words. Lines like  ---\nkey: value\n---  (frontmatter) are also parsed for
//   title/description and stripped from the body.
//
// Discovery: ./.cc-alt/skills/*.md (project) THEN ~/.cc-alt/skills/*.md (user). A project skill
// shadows a user skill of the same name. Pure parsing/substitution lives here so it is unit-tested
// with no LLM; the runners (REPL /run, CLI skill) live in repl.mjs / bin.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function skillDirs(cwd = process.cwd()) {
  return [path.join(cwd, ".cc-alt", "skills"), path.join(os.homedir(), ".cc-alt", "skills")];
}

// Parse a skill file's raw text into { title, description, body }.
export function parseSkill(raw) {
  let text = String(raw == null ? "" : raw).replace(/\r\n/g, "\n");
  let title = "", description = "";

  // optional frontmatter: leading --- ... --- block of key: value lines
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^\s*(\w[\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const k = m[1].toLowerCase(), v = m[2].trim().replace(/^["']|["']$/g, "");
      if (k === "title" || k === "name") title = v;
      else if (k === "description" || k === "desc") description = v;
    }
    text = text.slice(fm[0].length);
  }

  // <!-- description: ... --> comment anywhere (takes priority if frontmatter didn't set one)
  const cm = text.match(/<!--\s*description:\s*([\s\S]*?)\s*-->/i);
  if (cm) {
    if (!description) description = cm[1].trim();
    text = text.replace(cm[0], "");
  }

  // leading "# Title" line -> title (and stripped from the body)
  const tm = text.match(/^\s*#\s+(.+?)\s*\n/);
  if (tm) {
    if (!title) title = tm[1].trim();
    text = text.slice(tm[0].length);
  }

  return { title, description: description || title || "", body: text.trim() };
}

// Substitute $ARGS / {{args}} (whole arg string) and $1 $2 ... (positional words) in a body.
// args can be a raw string ("foo bar") or an array of tokens. Unfilled $N become empty string.
export function substituteArgs(body, args) {
  const argStr = Array.isArray(args) ? args.join(" ") : String(args == null ? "" : args);
  const tokens = Array.isArray(args) ? args.slice() : argStr.split(/\s+/).filter(Boolean);
  let out = String(body == null ? "" : body);
  out = out.replace(/\{\{\s*args\s*\}\}/gi, argStr).replace(/\$ARGS\b/g, argStr);
  // $1..$9 positional (replace highest-first so $10 isn't clobbered by $1 — we only do 1..9 then multi)
  out = out.replace(/\$(\d+)/g, (_m, d) => {
    const i = parseInt(d, 10);
    return i >= 1 && i <= tokens.length ? tokens[i - 1] : "";
  });
  return out;
}

// Load a single skill file fully (parse + record name/path). name = filename without .md.
export function loadSkillFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = parseSkill(raw);
  return { name: path.basename(file, ".md"), path: file, ...parsed };
}

// Discover all skills across the dirs. Returns a Map name->skill (project shadows user). Missing
// dirs are skipped silently. Each skill: { name, path, title, description, body }.
export function discoverSkills(cwd = process.cwd()) {
  const map = new Map();
  for (const dir of skillDirs(cwd)) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort(); } catch { continue; }
    for (const f of names) {
      const name = path.basename(f, ".md");
      if (map.has(name)) continue; // earlier dir (project) wins
      try { map.set(name, loadSkillFile(path.join(dir, f))); } catch { /* unreadable -> skip */ }
    }
  }
  return map;
}

// Resolve a skill by name + render its prompt with args. Returns { ok, skill, prompt } or
// { ok:false, error, available }.
export function renderSkill(name, args, cwd = process.cwd()) {
  const skills = discoverSkills(cwd);
  const skill = skills.get(name);
  if (!skill) return { ok: false, error: "SKILL_NOT_FOUND", name, available: [...skills.keys()] };
  return { ok: true, skill, prompt: substituteArgs(skill.body, args) };
}

export function listSkills(cwd = process.cwd()) {
  return [...discoverSkills(cwd).values()].sort((a, b) => a.name.localeCompare(b.name));
}
