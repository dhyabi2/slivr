// tasks.mjs — benchmark task definitions + fixture seeds + deterministic oracles.
//
// Each task: { id, kind, task (prompt), seed (files written into a fresh copy), oracle (a check
// command run inside the workdir; exit 0 == success). Oracles are BEHAVIORAL: they execute the
// resulting code and assert observable behavior, so success is ground truth, not a diff guess.
//
// "kind" tags the file-size regime so we can see WHERE the compact-edit win is biggest.

export const TASKS = [
  // ---- small files (multi-edit) ----
  {
    id: "validate-3-funcs",
    kind: "small-multi",
    task: `In src/calc.js there are three exported functions: add, sub, mul. Add input validation to EACH: if either argument is not a number (typeof !== 'number' or NaN), throw a TypeError with message "invalid input". Keep the existing math behavior for valid numbers.`,
    seed: {
      "src/calc.js":
`export function add(a, b) {
  return a + b;
}
export function sub(a, b) {
  return a - b;
}
export function mul(a, b) {
  return a * b;
}
`,
    },
    oracle:
`node -e '
import("./src/calc.js").then(m => {
  let ok = m.add(2,3)===5 && m.sub(5,2)===3 && m.mul(2,4)===8;
  for (const [fn,] of [["add"],["sub"],["mul"]]) {
    let threw=false; try { m[fn]("x",1); } catch(e){ threw = e instanceof TypeError; }
    ok = ok && threw;
    let threw2=false; try { m[fn](1,NaN); } catch(e){ threw2 = true; }
    ok = ok && threw2;
  }
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ---- rename a field across files ----
  {
    id: "rename-field",
    kind: "small-multi",
    task: `The user object uses a field named "username" across the codebase. Rename it to "handle" EVERYWHERE it is used in src/user.js and src/render.js (object property definitions and accesses). Behavior must be preserved.`,
    seed: {
      "src/user.js":
`export function makeUser(name) {
  return { username: name, active: true };
}
export function greet(u) {
  return "hi " + u.username;
}
`,
      "src/render.js":
`import { makeUser } from "./user.js";
export function card(name) {
  const u = makeUser(name);
  return "<b>" + u.username + "</b>";
}
`,
    },
    oracle:
`node -e '
Promise.all([import("./src/user.js"), import("./src/render.js")]).then(([U,R])=>{
  const u = U.makeUser("bob");
  let ok = u.handle==="bob" && !("username" in u) && U.greet(u)==="hi bob" && R.card("bob")==="<b>bob</b>";
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ---- add a new endpoint + wire it ----
  {
    id: "add-endpoint",
    kind: "small-multi",
    task: `In src/router.js there is a simple route table and a handle(path) function. Add a new route "/health" whose handler returns the string "ok". Wire it into the route table so handle("/health") returns "ok". Do not break the existing "/" route which returns "home".`,
    seed: {
      "src/router.js":
`const routes = {
  "/": () => "home",
};
export function handle(path) {
  const h = routes[path];
  return h ? h() : "404";
}
`,
    },
    oracle:
`node -e '
import("./src/router.js").then(m=>{
  let ok = m.handle("/")==="home" && m.handle("/health")==="ok" && m.handle("/nope")==="404";
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ---- fix a bug in a LARGE file (where compact-edit should win most) ----
  {
    id: "fix-bug-largefile",
    kind: "large-single",
    task: `src/math.js is a large module. The function computeTotal(items) is supposed to SUM each item's price*qty, but it has a sign bug (it subtracts instead of adds), so it returns a negative total. Fix computeTotal so it returns the correct positive sum. Do not change the many helperN functions.`,
    seed: { __generate: "largefile" }, // generated below
    oracle:
`node -e '
import("./src/math.js").then(m=>{
  const items=[{price:2,qty:3},{price:5,qty:1}]; // expect 11
  let ok = m.computeTotal(items)===11 && typeof m.helper0==="function" && m.helper0(0)===0;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ---- add a method to a class ----
  {
    id: "add-method",
    kind: "small-single",
    task: `src/stack.js exports a Stack class with push and pop. Add a "peek" method that returns the top element WITHOUT removing it (undefined if empty), and a "size" getter that returns the number of elements.`,
    seed: {
      "src/stack.js":
`export class Stack {
  constructor() { this.items = []; }
  push(x) { this.items.push(x); }
  pop() { return this.items.pop(); }
}
`,
    },
    oracle:
`node -e '
import("./src/stack.js").then(m=>{
  const s=new m.Stack(); s.push(1); s.push(2);
  let ok = s.peek()===2 && s.size===2 && s.pop()===2 && s.peek()===1 && s.size===1;
  const e=new m.Stack(); ok = ok && e.peek()===undefined && e.size===0;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ---- multi-file: add a constant + use it ----
  {
    id: "config-constant",
    kind: "small-multi",
    task: `Create src/config.js exporting a constant MAX_RETRIES = 5. Then in src/worker.js, import MAX_RETRIES from config and make the run() function use it: run() should return MAX_RETRIES (currently it returns a hardcoded 3).`,
    seed: {
      "src/worker.js":
`export function run() {
  return 3;
}
`,
    },
    oracle:
`node -e '
Promise.all([import("./src/config.js"),import("./src/worker.js")]).then(([C,W])=>{
  let ok = C.MAX_RETRIES===5 && W.run()===5;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ---- fix an off-by-one bug ----
  {
    id: "fix-offbyone",
    kind: "small-single",
    task: `src/range.js exports rangeSum(n) which should return the sum 1+2+...+n. It currently has an off-by-one bug (loop stops too early). Fix it so rangeSum(5)===15 and rangeSum(1)===1.`,
    seed: {
      "src/range.js":
`export function rangeSum(n) {
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += i;
  }
  return total;
}
`,
    },
    oracle:
`node -e '
import("./src/range.js").then(m=>{
  let ok = m.rangeSum(5)===15 && m.rangeSum(1)===1 && m.rangeSum(0)===0;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ---- add validation to a single large-ish file (medium) ----
  {
    id: "guard-parse",
    kind: "medium-single",
    task: `src/parse.js has a function parseConfig(text) that JSON.parses text and returns the object. Make it defensive: if text is not a string, or JSON.parse throws, return null instead of throwing. Valid JSON must still parse correctly.`,
    seed: {
      "src/parse.js":
`// config parser
export function parseConfig(text) {
  const obj = JSON.parse(text);
  return obj;
}
// some surrounding helpers to make the file non-trivial
export function keysOf(o) { return Object.keys(o || {}); }
export function isEmpty(o) { return keysOf(o).length === 0; }
export function merge(a, b) { return Object.assign({}, a, b); }
`,
    },
    // avoid embedded single-quotes (unescapable inside a single-quoted bash string):
    // build the JSON string from char codes.
    oracle:
`node -e '
import("./src/parse.js").then(m=>{
  const j = String.fromCharCode(123,34,97,34,58,49,125); /* {"a":1} */
  let ok = JSON.stringify(m.parseConfig(j))===JSON.stringify({a:1});
  ok = ok && m.parseConfig("not json")===null && m.parseConfig(123)===null && m.parseConfig(null)===null;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },
];
