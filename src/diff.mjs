// diff.mjs — a compact unified-diff renderer for edit previews.
//
// Pure + deterministic (no LLM, no I/O). Given old/new text it produces a small unified diff
// with a few lines of context and +/- markers. renderDiff() adds ANSI color unless disabled.
// Used by the streaming UI (show what an edit changed) and the approval prompt (preview).

// Minimal LCS-based line diff. Returns an array of { type: ' '|'-'|'+', text } ops.
export function diffLines(oldStr, newStr) {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  const n = a.length, m = b.length;
  // LCS table (capped to keep it cheap; for huge inputs we fall back to a coarse diff).
  if (n * m > 4_000_000) {
    // Coarse fallback: everything removed then added. Still correct, just not minimal.
    return [...a.map(t => ({ type: "-", text: t })), ...b.map(t => ({ type: "+", text: t }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: " ", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: "-", text: a[i] }); i++; }
    else { ops.push({ type: "+", text: b[j] }); j++; }
  }
  while (i < n) { ops.push({ type: "-", text: a[i] }); i++; }
  while (j < m) { ops.push({ type: "+", text: b[j] }); j++; }
  return ops;
}

// Group ops into hunks, keeping `context` unchanged lines around each change and collapsing
// long unchanged runs. Returns the rendered string (no color). Each hunk gets an @@ header.
export function unifiedDiff(oldStr, newStr, { context = 2, path = "" } = {}) {
  const ops = diffLines(oldStr, newStr);
  // Find indices of changed ops.
  const changed = ops.map((o, idx) => (o.type !== " " ? idx : -1)).filter(idx => idx >= 0);
  if (changed.length === 0) return ""; // identical

  // Build ranges of ops to include (changed ± context), merged when they overlap.
  const ranges = [];
  for (const idx of changed) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
    else ranges.push({ lo, hi });
  }

  const lines = [];
  if (path) lines.push(`--- ${path}`, `+++ ${path}`);
  // Track running line numbers in old/new for @@ headers.
  let oldLine = 1, newLine = 1, opIdx = 0;
  for (const { lo, hi } of ranges) {
    // advance counters up to lo
    while (opIdx < lo) {
      const t = ops[opIdx].type;
      if (t !== "+") oldLine++;
      if (t !== "-") newLine++;
      opIdx++;
    }
    let oldCount = 0, newCount = 0;
    const hunkBody = [];
    for (let k = lo; k <= hi; k++) {
      const o = ops[k];
      if (o.type !== "+") oldCount++;
      if (o.type !== "-") newCount++;
      hunkBody.push(o.type + o.text);
    }
    lines.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    lines.push(...hunkBody);
    // advance counters across the emitted hunk
    for (let k = lo; k <= hi; k++) {
      const t = ops[k].type;
      if (t !== "+") oldLine++;
      if (t !== "-") newLine++;
    }
    opIdx = hi + 1;
  }
  return lines.join("\n");
}

const C = {
  red: "\x1b[31m", green: "\x1b[32m", cyan: "\x1b[36m", dim: "\x1b[2m", reset: "\x1b[0m",
};

// Colorize a unified-diff string. `color=false` returns it unchanged.
export function renderDiff(oldStr, newStr, { context = 2, path = "", color = true } = {}) {
  const raw = unifiedDiff(oldStr, newStr, { context, path });
  if (!raw) return "";
  if (!color) return raw;
  return raw.split("\n").map(line => {
    if (line.startsWith("@@")) return C.cyan + line + C.reset;
    if (line.startsWith("+++") || line.startsWith("---")) return C.dim + line + C.reset;
    if (line.startsWith("+")) return C.green + line + C.reset;
    if (line.startsWith("-")) return C.red + line + C.reset;
    return C.dim + line + C.reset;
  }).join("\n");
}

// Compact one-line summary of an edit's magnitude, e.g. "+3 -1".
export function diffStat(oldStr, newStr) {
  const ops = diffLines(oldStr, newStr);
  let add = 0, del = 0;
  for (const o of ops) { if (o.type === "+") add++; else if (o.type === "-") del++; }
  return { add, del };
}
