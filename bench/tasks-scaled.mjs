// tasks-scaled.mjs — EXPANDED benchmark task set for the scaled head-to-head.
//
// ~18 realistic multi-edit coding tasks spanning file-size regimes:
//   tiny-single      : a few lines, one edit
//   small-multi      : multiple small files / multiple edits
//   medium-single    : ~60-120 line file, targeted edit
//   large-single     : 200-600 line file, ONE targeted edit (where the compact protocol matters)
//   large-multi      : two large files, edits in each
//
// Each task: { id, kind, task (prompt), seed (files), oracle (exit 0 == success) }.
// `seed` values are either literal file contents, OR { __gen: name, ...params } resolved by
// genSeed() below so we can produce genuinely large fixtures (200-600 lines).
//
// Oracles are BEHAVIORAL: they execute the resulting code and assert observable output, so a pass
// is ground truth (the model could not "cheat" by editing comments). Oracles avoid embedded single
// quotes (they run inside a single-quoted bash string); JSON literals are built from char codes.

// ----- large-fixture generators (parametric so sizes span 200-600 lines) -----

// A large math/util module with N helpers and a buggy computeTotal in the MIDDLE.
function genMathModule(nHelpers) {
  const half = Math.floor(nHelpers / 2);
  let s = "// large utility module — many small pure helpers around one real function.\n";
  for (let i = 0; i < half; i++) s += `export function helper${i}(x) { return x + ${i}; }\n`;
  s +=
`export function computeTotal(items) {
  // BUG: subtracts instead of adds, so the total comes out negative.
  let total = 0;
  for (const it of items) { total = total - it.price * it.qty; }
  return total;
}
`;
  for (let i = half; i < nHelpers; i++) s += `export function helper${i}(x) { return x * ${i}; }\n`;
  return s;
}

// A large "service" file: N route handlers in a table + a dispatch() function. The handler for
// "/status" wrongly returns "down"; task fixes it to "ok" without touching the others.
function genServiceModule(nRoutes) {
  let s = "// large service module — a routing table with many handlers and a dispatcher.\n";
  s += "const routes = {\n";
  for (let i = 0; i < nRoutes; i++) s += `  "/r${i}": () => "resp${i}",\n`;
  s += `  "/status": () => "down",\n`; // <- the bug to fix
  s += "};\n";
  s += `export function dispatch(p) {
  const h = routes[p];
  return h ? h() : "404";
}
`;
  for (let i = 0; i < nRoutes; i++) {
    s += `export function aux${i}(x) { return x + ${i}; } // padding helper to grow the file\n`;
  }
  return s;
}

// A large reducer-style state file with N action handlers in a switch. One handler ("DECREMENT")
// has a bug (it increments). Task: fix DECREMENT to subtract, leave the rest.
function genReducerModule(nActions) {
  let s = "// large reducer module — a big switch over many action types.\n";
  s += "export function reducer(state, action) {\n  switch (action.type) {\n";
  for (let i = 0; i < nActions; i++) {
    s += `    case "SET_${i}": return { ...state, v${i}: action.payload };\n`;
  }
  s += `    case "INCREMENT": return { ...state, count: state.count + 1 };\n`;
  s += `    case "DECREMENT": return { ...state, count: state.count + 1 };\n`; // BUG: should be -1
  s += `    default: return state;\n  }\n}\n`;
  for (let i = 0; i < nActions; i++) {
    s += `export function selector${i}(s) { return s.v${i}; } // padding selector\n`;
  }
  return s;
}

// Two large files that BOTH reference a field "userId"; task renames it to "accountId" in both.
function genBigUserPair(n) {
  let model = "// large model file.\n";
  for (let i = 0; i < n; i++) model += `export function pad${i}(x) { return x + ${i}; }\n`;
  model +=
`export function makeAccount(name) {
  return { userId: name, active: true, balance: 0 };
}
export function ownerId(acc) {
  return acc.userId;
}
`;
  for (let i = n; i < 2 * n; i++) model += `export function pad${i}(x) { return x * ${i}; }\n`;

  let view = "// large view file.\n";
  view += `import { makeAccount, ownerId } from "./model.js";\n`;
  for (let i = 0; i < n; i++) view += `export function v${i}(x) { return x - ${i}; }\n`;
  view +=
`export function label(name) {
  const a = makeAccount(name);
  return "owner:" + a.userId + ":" + ownerId(a);
}
`;
  for (let i = n; i < 2 * n; i++) view += `export function v${i}(x) { return x / (${i} || 1); }\n`;
  return { model, view };
}

// resolve a seed spec (literal map OR generator descriptor) into a { relpath: content } map.
export function genSeed(seed) {
  if (!seed || !seed.__gen) return seed;
  switch (seed.__gen) {
    case "math":     return { "src/math.js": genMathModule(seed.n) };
    case "service":  return { "src/service.js": genServiceModule(seed.n) };
    case "reducer":  return { "src/reducer.js": genReducerModule(seed.n) };
    case "userpair": {
      const { model, view } = genBigUserPair(seed.n);
      return { "src/model.js": model, "src/view.js": view };
    }
    default: throw new Error("unknown generator " + seed.__gen);
  }
}

// approximate line count of a seed (for the report's regime sizing)
export function seedLines(seed) {
  const files = genSeed(seed);
  let max = 0, total = 0;
  for (const c of Object.values(files)) {
    const n = c.split("\n").length;
    total += n; if (n > max) max = n;
  }
  return { maxFileLines: max, totalLines: total, files: Object.keys(files).length };
}

export const TASKS = [
  // ============================ TINY (single small edit) ============================
  {
    id: "fix-offbyone",
    kind: "tiny-single",
    task: `src/range.js exports rangeSum(n) which should return 1+2+...+n. It has an off-by-one bug (loop stops too early). Fix it so rangeSum(5)===15 and rangeSum(1)===1.`,
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
  {
    id: "add-method",
    kind: "tiny-single",
    task: `src/stack.js exports a Stack class with push and pop. Add a "peek" method returning the top element WITHOUT removing it (undefined if empty), and a "size" getter returning the element count.`,
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
  {
    id: "negate-flag",
    kind: "tiny-single",
    task: `src/flag.js exports isEnabled(cfg) that returns cfg.enabled. The desired behavior is inverted: it should return TRUE when cfg.disabled is falsy and FALSE when cfg.disabled is truthy. Rewrite isEnabled to read cfg.disabled and return !cfg.disabled.`,
    seed: {
      "src/flag.js":
`export function isEnabled(cfg) {
  return cfg.enabled;
}
`,
    },
    oracle:
`node -e '
import("./src/flag.js").then(m=>{
  let ok = m.isEnabled({disabled:false})===true && m.isEnabled({disabled:true})===false && m.isEnabled({})===true;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ============================ SMALL-MULTI (multiple small files/edits) ============================
  {
    id: "validate-3-funcs",
    kind: "small-multi",
    task: `In src/calc.js there are three exported functions: add, sub, mul. Add input validation to EACH: if either argument is not a number (typeof !== 'number' or NaN), throw a TypeError with message "invalid input". Keep existing math behavior for valid numbers.`,
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
  for (const fn of ["add","sub","mul"]) {
    let threw=false; try { m[fn]("x",1); } catch(e){ threw = e instanceof TypeError; }
    ok = ok && threw;
    let threw2=false; try { m[fn](1,NaN); } catch(e){ threw2 = true; }
    ok = ok && threw2;
  }
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },
  {
    id: "rename-field",
    kind: "small-multi",
    task: `The user object uses a field named "username" across the codebase. Rename it to "handle" EVERYWHERE it is used in src/user.js and src/render.js (object property definitions AND accesses). Behavior must be preserved.`,
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
  {
    id: "add-endpoint",
    kind: "small-multi",
    task: `In src/router.js there is a route table and a handle(path) function. Add a new route "/health" whose handler returns the string "ok". Wire it into the table so handle("/health") returns "ok". Do not break the existing "/" route which returns "home".`,
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
  {
    id: "config-constant",
    kind: "small-multi",
    task: `Create a NEW file src/config.js exporting a constant MAX_RETRIES = 5. Then in src/worker.js, import MAX_RETRIES from ./config.js and make run() return MAX_RETRIES (it currently returns a hardcoded 3). Use a normal import statement at the top of worker.js.`,
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
  {
    id: "wire-logger",
    kind: "small-multi",
    task: `Create a NEW file src/logger.js exporting a function format(level, msg) that returns the string level.toUpperCase() + ": " + msg (e.g. format("info","hi") -> "INFO: hi"). Then in src/app.js, import format from ./logger.js and make banner() return format("info", "started").`,
    seed: {
      "src/app.js":
`export function banner() {
  return "started";
}
`,
    },
    oracle:
`node -e '
Promise.all([import("./src/logger.js"),import("./src/app.js")]).then(([L,A])=>{
  let ok = L.format("info","hi")==="INFO: hi" && A.banner()==="INFO: started";
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ============================ MEDIUM-SINGLE (~60-130 line file) ============================
  {
    id: "guard-parse",
    kind: "medium-single",
    task: `src/parse.js has parseConfig(text) that JSON.parses text and returns the object. Make it defensive: if text is not a string, or JSON.parse throws, return null instead of throwing. Valid JSON must still parse correctly. Do not change the other helpers.`,
    seed: {
      "src/parse.js":
`// config parser with many surrounding helpers to make it a real medium-sized file.
export function parseConfig(text) {
  const obj = JSON.parse(text);
  return obj;
}
export function keysOf(o) { return Object.keys(o || {}); }
export function isEmpty(o) { return keysOf(o).length === 0; }
export function merge(a, b) { return Object.assign({}, a, b); }
export function pick(o, ks) { const r = {}; for (const k of ks) if (k in o) r[k] = o[k]; return r; }
export function omit(o, ks) { const r = { ...o }; for (const k of ks) delete r[k]; return r; }
export function deepGet(o, p) { return p.split(".").reduce((a, k) => (a == null ? a : a[k]), o); }
export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
export function range(n) { return Array.from({ length: n }, (_, i) => i); }
export function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
export function avg(arr) { return arr.length ? sum(arr) / arr.length : 0; }
export function uniq(arr) { return [...new Set(arr)]; }
export function flatten(arr) { return arr.reduce((a, b) => a.concat(b), []); }
export function groupBy(arr, fn) {
  const r = {};
  for (const x of arr) { const k = fn(x); (r[k] = r[k] || []).push(x); }
  return r;
}
export function mapValues(o, fn) {
  const r = {};
  for (const k of Object.keys(o)) r[k] = fn(o[k]);
  return r;
}
export function entries(o) { return Object.keys(o).map((k) => [k, o[k]]); }
export function fromEntries(es) { const r = {}; for (const [k, v] of es) r[k] = v; return r; }
export function invert(o) { const r = {}; for (const k of Object.keys(o)) r[o[k]] = k; return r; }
export function defaults(o, d) { return Object.assign({}, d, o); }
export function compact(arr) { return arr.filter(Boolean); }
export function chunk(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}
export function zip(a, b) { return a.map((x, i) => [x, b[i]]); }
export function last(arr) { return arr[arr.length - 1]; }
export function first(arr) { return arr[0]; }
`,
    },
    oracle:
`node -e '
import("./src/parse.js").then(m=>{
  const j = String.fromCharCode(123,34,97,34,58,49,125); /* {"a":1} */
  let ok = JSON.stringify(m.parseConfig(j))===JSON.stringify({a:1});
  ok = ok && m.parseConfig("not json")===null && m.parseConfig(123)===null && m.parseConfig(null)===null;
  ok = ok && m.clamp(99,0,10)===10 && m.isEmpty({})===true;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },
  {
    id: "medium-add-validate",
    kind: "medium-single",
    task: `src/account.js defines a withdraw(state, amount) function among many helpers. It currently subtracts amount from state.balance unconditionally. Make it safe: if amount is negative OR greater than state.balance, return state UNCHANGED (do not mutate). Otherwise return a NEW state with balance reduced by amount. Do not change the other functions.`,
    seed: {
      "src/account.js":
`// account module — many helpers around the real function (medium-sized file).
export function fee(n) { return n * 0.01; }
export function gross(n) { return n + fee(n); }
export function net(n) { return n - fee(n); }
export function withdraw(state, amount) {
  return { ...state, balance: state.balance - amount };
}
export function deposit(state, amount) { return { ...state, balance: state.balance + amount }; }
export function rename(state, name) { return { ...state, name }; }
export function freeze(state) { return { ...state, frozen: true }; }
export function unfreeze(state) { return { ...state, frozen: false }; }
export function summary(state) { return state.name + ":" + state.balance; }
export function isRich(state) { return state.balance > 1000; }
export function tax(n) { return n * 0.2; }
export function applyInterest(state, rate) { return { ...state, balance: state.balance * (1 + rate) }; }
export function transfer(a, b, amt) { return [withdraw(a, amt), deposit(b, amt)]; }
export function history(state) { return state.log || []; }
export function record(state, entry) { return { ...state, log: [...history(state), entry] }; }
export function clear(state) { return { ...state, log: [] }; }
export function balanceOf(state) { return state.balance; }
export function isFrozen(state) { return !!state.frozen; }
export function open(name) { return { name, balance: 0, frozen: false, log: [] }; }
export function close(state) { return { ...state, closed: true }; }
export function isOpen(state) { return !state.closed; }
export function topUp(state, amt) { return amt > 0 ? deposit(state, amt) : state; }
export function penalty(state, amt) { return { ...state, balance: state.balance - amt }; }
export function reward(state, amt) { return { ...state, balance: state.balance + amt }; }
export function label(state) { return state.frozen ? "FROZEN" : "ACTIVE"; }
export function describe(state) { return summary(state) + " (" + label(state) + ")"; }
`,
    },
    oracle:
`node -e '
import("./src/account.js").then(m=>{
  const s={name:"a",balance:100};
  let ok = m.withdraw(s,40).balance===60;
  ok = ok && m.withdraw(s,200)===s;       // too much -> unchanged (same ref)
  ok = ok && m.withdraw(s,-5)===s;        // negative -> unchanged
  ok = ok && s.balance===100;             // never mutated
  ok = ok && m.deposit(s,10).balance===110 && m.isRich({balance:2000})===true;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ============================ LARGE-SINGLE (200-600 lines, ONE targeted edit) ============================
  {
    id: "fix-bug-large-250",
    kind: "large-single",
    task: `src/math.js is a large module. computeTotal(items) should SUM each item's price*qty but has a sign bug (subtracts instead of adds), returning a negative total. Fix computeTotal to return the correct positive sum. Do NOT change the many helperN functions.`,
    seed: { __gen: "math", n: 240 }, // ~250 lines
    oracle:
`node -e '
import("./src/math.js").then(m=>{
  const items=[{price:2,qty:3},{price:5,qty:1}]; // expect 11
  let ok = m.computeTotal(items)===11 && typeof m.helper0==="function" && m.helper0(0)===0 && m.helper200(2)===400;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },
  {
    id: "fix-route-large-400",
    kind: "large-single",
    task: `src/service.js is a large routing module. The route "/status" currently returns "down" but it should return "ok". Change ONLY that handler so dispatch("/status") returns "ok". Leave every other route ("/r0".."/rN") and the aux helpers unchanged.`,
    seed: { __gen: "service", n: 200 }, // ~400 lines
    oracle:
`node -e '
import("./src/service.js").then(m=>{
  let ok = m.dispatch("/status")==="ok" && m.dispatch("/r0")==="resp0" && m.dispatch("/r150")==="resp150" && m.dispatch("/nope")==="404" && m.aux0(0)===0;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },
  {
    id: "fix-reducer-large-300",
    kind: "large-single",
    task: `src/reducer.js is a large Redux-style reducer with a big switch. The "DECREMENT" case wrongly INCREMENTS count (count + 1); it should DECREMENT (count - 1). Fix ONLY the DECREMENT case. Leave INCREMENT and all SET_* cases unchanged.`,
    seed: { __gen: "reducer", n: 140 }, // ~290 lines
    oracle:
`node -e '
import("./src/reducer.js").then(m=>{
  let ok = m.reducer({count:5},{type:"DECREMENT"}).count===4;
  ok = ok && m.reducer({count:5},{type:"INCREMENT"}).count===6;
  ok = ok && m.reducer({count:5},{type:"SET_3",payload:9}).v3===9;
  ok = ok && m.selector3({v3:7})===7;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },
  {
    id: "add-fn-large-600",
    kind: "large-single",
    task: `src/math.js is a very large module. ADD a new exported function sumPrices(items) that returns the SUM of item.price for every item (e.g. [{price:2},{price:3}] -> 5). Do not modify any existing function, including computeTotal.`,
    seed: { __gen: "math", n: 580 }, // ~590 lines
    oracle:
`node -e '
import("./src/math.js").then(m=>{
  let ok = m.sumPrices([{price:2},{price:3},{price:5}])===10 && m.sumPrices([])===0;
  ok = ok && typeof m.helper0==="function" && m.helper500(1)===500;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  {
    id: "refactor-extract-const",
    kind: "medium-single",
    task: `src/pricing.js has several functions that each multiply by the literal 0.2 for tax. Add an exported constant TAX_RATE = 0.2 near the top, then update taxOf(n) and withTax(n) to use TAX_RATE instead of the literal 0.2. Behavior must be identical. Do not change the other functions.`,
    seed: {
      "src/pricing.js":
`// pricing module
export function discount(n) { return n * 0.9; }
export function taxOf(n) { return n * 0.2; }
export function withTax(n) { return n + n * 0.2; }
export function shipping(n) { return n > 100 ? 0 : 5; }
export function bulk(n, q) { return q > 10 ? n * 0.8 : n; }
export function round2(n) { return Math.round(n * 100) / 100; }
export function fmt(n) { return "$" + round2(n).toFixed(2); }
export function total(n, q) { return withTax(bulk(n, q) * q) + shipping(n * q); }
export function margin(cost, price) { return (price - cost) / price; }
export function markup(cost, pct) { return cost * (1 + pct); }
`,
    },
    oracle:
`node -e '
import("./src/pricing.js").then(m=>{
  let ok = m.TAX_RATE===0.2 && m.taxOf(100)===20 && m.withTax(100)===120 && m.discount(100)===90;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },

  // ============================ LARGE-MULTI (two large files, edit in each) ============================
  {
    id: "rename-largepair",
    kind: "large-multi",
    task: `Two large files src/model.js and src/view.js both use a field named "userId" on the account object. Rename it to "accountId" EVERYWHERE it appears in BOTH files (the property in makeAccount, and every read of acc.userId / a.userId). Behavior must be preserved. Do not touch the many pad/v padding functions.`,
    seed: { __gen: "userpair", n: 120 }, // each file ~250 lines
    oracle:
`node -e '
Promise.all([import("./src/model.js"),import("./src/view.js")]).then(([M,V])=>{
  const a = M.makeAccount("zed");
  let ok = a.accountId==="zed" && !("userId" in a) && M.ownerId(a)==="zed";
  ok = ok && V.label("zed")==="owner:zed:zed" && typeof M.pad0==="function" && V.v0(0)===0;
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },
  {
    id: "wire-fn-largepair",
    kind: "large-multi",
    task: `Two large files: src/model.js exports makeAccount(name) returning an object with accountId-or-userId, active, balance. In src/model.js ADD a new exported function isActive(acc) that returns acc.active. Then in src/view.js ADD a new exported function status(name) that uses makeAccount and isActive from ./model.js to return "active" if the account is active, else "inactive". Do not modify the padding functions.`,
    seed: { __gen: "userpair", n: 120 },
    oracle:
`node -e '
Promise.all([import("./src/model.js"),import("./src/view.js")]).then(([M,V])=>{
  let ok = M.isActive({active:true})===true && M.isActive({active:false})===false;
  ok = ok && V.status("zed")==="active";
  ok = ok && typeof M.makeAccount==="function" && typeof V.label==="function";
  process.exit(ok?0:1);
}).catch(()=>process.exit(1));
'`,
  },
];
