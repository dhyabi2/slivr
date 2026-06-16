#!/usr/bin/env node
// upgrade_e2e.mjs — hermetic end-to-end test of `proov upgrade`.
// Builds throwaway git repos (a bare "remote" + an "install" checkout of a minimal proov) so we can
// drive the REAL upgrade code through every path without touching the dev tree or the network:
//   1) already up to date            2) a real version-bumping fast-forward
//   3) refuses a dirty install        4) refuses an install that's ahead/diverged
//   5) reports "not a git checkout" when .git is absent
// Run:  node test/upgrade_e2e.mjs
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (b, m) => { console.log(`  ${b ? "PASS" : "FAIL"}  ${m}`); b ? pass++ : fail++; };
const tmp = (s) => fs.mkdtempSync(path.join(os.tmpdir(), "proov-upg-" + s + "-"));
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ver = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
const setVer = (dir, v) => { const f = path.join(dir, "package.json"); const j = JSON.parse(fs.readFileSync(f, "utf8")); j.version = v; fs.writeFileSync(f, JSON.stringify(j, null, 2)); };
// run the install's OWN bin (so runUpgrade's ROOT resolves to that install, not the dev tree)
const upgrade = (install, ...args) => spawnSync("node", [path.join(install, "bin", "proov.mjs"), "upgrade", ...args], { encoding: "utf8" });

// minimal but RUNNABLE proov: bin + src + package.json (bin imports ../package.json and ../src/*)
function seedInstall(dir) {
  fs.cpSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  fs.cpSync(path.join(ROOT, "bin"), path.join(dir, "bin"), { recursive: true });
  fs.cpSync(path.join(ROOT, "src"), path.join(dir, "src"), { recursive: true });
}
function commitAll(dir, msg) { git(dir, "add", "-A"); git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg); }

const remote = tmp("remote") + "/remote.git";
const install = tmp("install");
const maker = tmp("maker");
let shallow, shallowInstall;
try {
  // bare remote + an install checkout at v0.0.1 pushed to it
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  seedInstall(install);
  setVer(install, "0.0.1");
  git(install, "init", "-q", "-b", "main");
  commitAll(install, "v0.0.1");
  git(install, "remote", "add", "origin", remote);
  git(install, "push", "-q", "-u", "origin", "main");

  // 1) up to date
  let r = upgrade(install);
  ok(r.status === 0 && /up to date/.test(r.stdout + r.stderr), "reports up-to-date when install == remote");

  // publish v0.0.2 to the remote from a separate clone
  git(maker, "clone", "-q", remote, maker + "/c"); const clone = maker + "/c";
  setVer(clone, "0.0.2");
  commitAll(clone, "v0.0.2");
  git(clone, "push", "-q", "origin", "main");

  // 2) real fast-forward: install (behind) -> v0.0.2, version bumped on disk, "upgraded" reported
  ok(ver(install) === "0.0.1", "install still at 0.0.1 before upgrade");
  r = upgrade(install);
  const out2 = r.stdout + r.stderr;
  ok(r.status === 0 && /upgraded/.test(out2), "upgrade fast-forwards and reports success");
  ok(ver(install) === "0.0.2", "install package.json bumped 0.0.1 -> 0.0.2 on disk");
  ok(/0\.0\.1 .*0\.0\.2|0\.0\.1.→.0\.0\.2/.test(out2.replace(/\s+/g, " ")), "upgrade prints the old -> new version");

  // 3) dirty install refuses (publish v0.0.3 first so an update IS available, then dirty the tree)
  setVer(clone, "0.0.3"); commitAll(clone, "v0.0.3"); git(clone, "push", "-q", "origin", "main");
  fs.appendFileSync(path.join(install, "src", "scratch.txt"), "local edit\n");
  r = upgrade(install);
  ok(r.status === 1 && /local changes/.test(r.stdout + r.stderr), "refuses to upgrade a dirty install");
  ok(ver(install) === "0.0.2", "dirty refusal left version untouched");
  fs.rmSync(path.join(install, "src", "scratch.txt"));

  // 4) ahead/diverged install refuses (make a local commit so install is ahead of origin's history)
  setVer(install, "9.9.9"); commitAll(install, "local-only");
  r = upgrade(install);
  ok(r.status === 1 && /ahead|diverged/.test(r.stdout + r.stderr), "refuses when install is ahead/diverged from origin");
  ok(ver(install) === "9.9.9", "ahead refusal left the local commit intact");

  // 5) not a git checkout
  const nogit = tmp("nogit");
  seedInstall(nogit);
  r = upgrade(nogit);
  ok(r.status === 1 && /not a git checkout/.test(r.stdout + r.stderr), "reports 'not a git checkout' with no .git");

  // 6) the REAL production path: a `--depth 1` shallow install still fast-forwards (guard skipped)
  shallow = tmp("shallow");
  // file:// forces a real (non-hardlink) clone so --depth actually produces a shallow repo
  git(shallow, "clone", "-q", "--depth", "1", "-b", "main", "file://" + remote, shallow + "/i"); shallowInstall = shallow + "/i";
  ok(git(shallowInstall, "rev-parse", "--is-shallow-repository") === "true", "shallow install is actually shallow");
  setVer(clone, "1.0.0"); commitAll(clone, "v1.0.0"); git(clone, "push", "-q", "origin", "main");
  r = upgrade(shallowInstall);
  ok(r.status === 0 && /upgraded/.test(r.stdout + r.stderr) && ver(shallowInstall) === "1.0.0", "shallow (--depth 1) install fast-forwards to 1.0.0");
} finally {
  for (const d of [path.dirname(remote), install, maker, shallow].filter(Boolean)) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\nupgrade E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
