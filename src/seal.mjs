// VENDORED (read-only reuse) from /Users/mac/methadology_invent/better-cc-fresh/src/seal.mjs
// Original author's correctness-first edit applier + structured Repair Packet. Copied verbatim
// per task instructions; this is the cornerstone of the compact-edit protocol used by proov.
//
// SEAL — Structured Edit-Application Loop (deterministic core, NO LLM)
// Applies an intent-based edit; on failure returns a structured Repair Packet.

function normWs(s) { return s.replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim(); }

// mask string/char/template literals to content-encoding placeholders so we can normalize
// operator spacing OUTSIDE strings without ever conflating two DIFFERENT string literals.
function maskStrings(s) {
  let o = '', i = 0; const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; let j = i + 1, buf = '';
      while (j < n && s[j] !== q) { if (s[j] === '\\') { buf += s[j] + (s[j + 1] || ''); j += 2; continue; } buf += s[j]; j++; }
      o += '\x00' + buf.replace(/\s/g, '\x01') + '\x00'; i = j + 1; continue;   // \x01 keeps in-string spaces distinct
    }
    o += c; i++;
  }
  return o;
}
// SOUND canonical form for comparison: collapse whitespace AND drop spacing around operators/
// punctuation (genuinely insensitive in code), while preserving string content + word boundaries.
function canon(s) {
  return maskStrings(s)
    .replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\s*([{}()\[\];,.:+\-*/%=<>!&|?~^@])\s*/g, '$1')
    .trim();
}

// token-bag similarity (Jaccard over normalized tokens) — cheap, deterministic
function tokens(s) {
  return new Set(normWs(s).toLowerCase().match(/[a-z0-9_]+|[^\sa-z0-9_]/g) || []);
}
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Slide a window of ~anchor-line-count over the file; return best-matching span.
function bestSpan(fileLines, anchor) {
  const anchorLines = anchor.split('\n');
  const win = Math.max(1, anchorLines.length);
  let best = { score: -1, start: 0, end: win };
  for (let i = 0; i + win <= fileLines.length; i++) {
    const cand = fileLines.slice(i, i + win).join('\n');
    const score = jaccard(cand, anchor);
    if (score > best.score) best = { score, start: i, end: i + win, text: cand };
  }
  // also try +/-1 window sizes for robustness
  for (const dw of [-1, 1]) {
    const w = win + dw;
    if (w < 1) continue;
    for (let i = 0; i + w <= fileLines.length; i++) {
      const cand = fileLines.slice(i, i + w).join('\n');
      const score = jaccard(cand, anchor);
      if (score > best.score) best = { score, start: i, end: i + w, text: cand };
    }
  }
  return best;
}

function reindent(replacement, targetIndent) {
  const lines = replacement.split('\n');
  // strip common leading indent then apply target indent to first line baseline
  const nonEmpty = lines.filter(l => l.trim());
  const minIndent = nonEmpty.length
    ? Math.min(...nonEmpty.map(l => (l.match(/^[ \t]*/)[0].length)))
    : 0;
  return lines.map(l => l.trim() ? targetIndent + l.slice(minIndent) : l).join('\n');
}

const FUZZY_THRESHOLD = 0.75;

// count EXACT (substring) occurrences of the anchor — used to enforce uniqueness.
function countExact(content, anchor) { if (!anchor) return 0; let c = 0, i = 0; while ((i = content.indexOf(anchor, i)) !== -1) { c++; i += anchor.length; } return c; }
// all whitespace-normalized spans (at the anchor's own line count) that match — for uniqueness.
function normalizedMatches(fileLines, anchor) {
  const cAnchor = canon(anchor); const aw = anchor.split('\n').length; const out = [];
  // try the anchor's own line count first, then +/-1, but only ACCEPT if globally unique at the
  // first window size that yields any match (keeps the uniqueness guarantee honest).
  for (const w of [aw, aw + 1, aw - 1]) {
    if (w < 1) continue;
    const hits = [];
    for (let i = 0; i + w <= fileLines.length; i++) { const cand = fileLines.slice(i, i + w).join('\n'); if (canon(cand) === cAnchor) hits.push({ start: i, end: i + w }); }
    if (hits.length) return hits;     // return matches at the tightest window that matched
  }
  return out;
}
function ambiguousPacket(content, fileLines, edit, best, n, kind) {
  const p = buildRepairPacket(content, fileLines, edit, best);
  p.error = 'EDIT_AMBIGUOUS';
  p.reason = `Your anchor matches ${n} ${kind} locations — it is NOT unique, so applying it could edit the WRONG one.`;
  p.occurrences = n;
  p.instruction = `Re-emit your edit with a LARGER anchor (include surrounding lines above/below) to match EXACTLY ONE location, copied verbatim — OR keep this anchor and add "occurrence": <1..${n}> to pick which one (see nearestRealSpans for each location's startLine).`;
  return p;
}

// Models very commonly paste anchors that still carry LINE-NUMBER PREFIXES (e.g. "42  code" or
// "42:\tcode" or "  42 | code") from a numbered file view — which then never match the real source.
// If EVERY non-empty anchor line is so prefixed, return the de-numbered anchor; else null. Conservative
// so it never strips legitimate leading numbers in real code (every line must match the pattern).
function stripLineNumberPrefixes(anchor) {
  const lines = String(anchor).split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length === 0) return null;
  const re = /^\s*\d+\s*(?:[:|.│]\s?|\t| {1,4})(.*)$/;   // "42 ", "42:", "42|", "42.", "42\t"
  if (!nonEmpty.every((l) => re.test(l))) return null;
  const stripped = lines.map((l) => { if (!l.trim()) return l; const m = l.match(re); return m ? m[1] : l; }).join('\n');
  return stripped === anchor ? null : stripped;
}

// Apply one edit — CORRECTNESS-FIRST: only apply on a UNIQUE exact or unique normalized match.
// Never silently apply a fuzzy match or a non-unique anchor (those cause wrong-location edits that
// report success); instead return a packet (with fuzzy spans as SUGGESTIONS) for the model to retry.
// An optional 1-based `occurrence` disambiguates a repeated anchor (common in big game/HTML files).
export function applyEdit(content, edit) {
  const { anchor, replacement, op = 'replace', occurrence } = edit;
  const fileLines = content.split('\n');

  // --- Tier 1: EXACT + UNIQUE (or a chosen occurrence) ---
  const nExact = countExact(content, anchor);
  if (nExact === 1) {
    if (op === 'replace') return { ok: true, tier: 'exact', content: content.replace(anchor, replacement) };
    const repl = op === 'insert_after' ? anchor + '\n' + replacement : replacement + '\n' + anchor;
    return { ok: true, tier: 'exact', content: content.replace(anchor, repl) };
  }
  if (nExact > 1) {
    // The model can pick WHICH one with occurrence:N instead of having to craft a unique anchor.
    if (Number.isInteger(occurrence) && occurrence >= 1 && occurrence <= nExact) {
      let idx = -1; for (let k = 0; k < occurrence; k++) idx = content.indexOf(anchor, idx + 1);
      const repl = op === 'replace' ? replacement : op === 'insert_after' ? anchor + '\n' + replacement : replacement + '\n' + anchor;
      return { ok: true, tier: 'exact#' + occurrence, content: content.slice(0, idx) + repl + content.slice(idx + anchor.length) };
    }
    return { ok: false, repair: ambiguousPacket(content, fileLines, edit, bestSpan(fileLines, anchor), nExact, 'exact') };
  }

  // --- Tier 2: WHITESPACE-NORMALIZED + UNIQUE ---
  const norm = normalizedMatches(fileLines, anchor);
  if (norm.length === 1) {
    const span = norm[0];
    const targetIndent = (fileLines[span.start].match(/^[ \t]*/) || [''])[0];
    const reIndented = reindent(replacement, targetIndent);
    return { ok: true, tier: 'whitespace', content: spliceLines(fileLines, span, reIndented, op) };
  }
  if (norm.length > 1) return { ok: false, repair: ambiguousPacket(content, fileLines, edit, bestSpan(fileLines, anchor), norm.length, 'normalized') };

  // --- Tier 2.5: the anchor may carry LINE-NUMBER PREFIXES — strip them and retry ONCE (still must be
  // unique to apply, so correctness is preserved). This recovers a huge class of "anchor not found".
  if (!edit._delined) {
    const stripped = stripLineNumberPrefixes(anchor);
    if (stripped) {
      const retry = applyEdit(content, { ...edit, anchor: stripped, _delined: true });
      if (retry.ok) return { ...retry, tier: retry.tier + '+delined' };
    }
  }

  // --- Tier 3: NO fuzzy auto-apply -> packet with fuzzy spans as SUGGESTIONS ---
  return { ok: false, repair: buildRepairPacket(content, fileLines, edit, bestSpan(fileLines, anchor)) };
}

function findNormalizedSpan(fileLines, anchor) {
  const nAnchor = normWs(anchor);
  const aLines = anchor.split('\n').length;
  for (const w of [aLines, aLines - 1, aLines + 1]) {
    if (w < 1) continue;
    for (let i = 0; i + w <= fileLines.length; i++) {
      const cand = fileLines.slice(i, i + w).join('\n');
      if (normWs(cand) === nAnchor) return { start: i, end: i + w };
    }
  }
  return null;
}

function spliceLines(fileLines, span, replacement, op) {
  const out = fileLines.slice();
  if (op === 'replace') {
    out.splice(span.start, span.end - span.start, ...replacement.split('\n'));
  } else if (op === 'insert_after') {
    out.splice(span.end, 0, ...replacement.split('\n'));
  } else { // insert_before
    out.splice(span.start, 0, ...replacement.split('\n'));
  }
  return out.join('\n');
}

function miniDiff(wrote, actual) {
  return `--- you wrote ---\n${wrote}\n--- nearest real code in file ---\n${actual}`;
}

// The core differentiator: deterministic, actionable repair guidance.
export function buildRepairPacket(content, fileLines, edit, best, allFiles = null) {
  const { anchor } = edit;
  // top-K closest spans actually present
  const win = Math.max(1, anchor.split('\n').length);
  const scored = [];
  for (let i = 0; i + win <= fileLines.length; i++) {
    const cand = fileLines.slice(i, i + win).join('\n');
    scored.push({ score: jaccard(cand, anchor), start: i, text: cand });
  }
  scored.sort((a, b) => b.score - a.score);
  const topK = scored.slice(0, 3).map((s, idx) => ({
    rank: idx + 1,
    startLine: s.start + 1,
    similarity: +s.score.toFixed(2),
    verbatim: s.text,
  }));

  const packet = {
    error: 'EDIT_NOT_APPLIED',
    reason: 'Your anchor text was not found exactly, normalized, or fuzzily in the file.',
    yourAnchor: anchor,
    nearestRealSpans: topK,
    diffVsNearest: topK[0] ? miniDiff(anchor, topK[0].verbatim) : null,
    instruction:
      'Re-emit your edit. Copy the "anchor" VERBATIM (character-for-character) from one of ' +
      'nearestRealSpans above — pick the rank whose code matches your intent. Do NOT paraphrase. ' +
      'Keep your "replacement" the same unless the real code differs from what you assumed.',
  };

  // wrong-file detection (if a corpus of other files supplied)
  if (allFiles) {
    const elsewhere = [];
    for (const [fname, ftext] of Object.entries(allFiles)) {
      if (ftext === content) continue;
      const fl = ftext.split('\n');
      const b = bestSpan(fl, anchor);
      if (b.score >= 0.6) elsewhere.push({ file: fname, similarity: +b.score.toFixed(2) });
    }
    if (elsewhere.length) {
      packet.maybeWrongFile = elsewhere.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
      packet.instruction += ' NOTE: a similar span exists in another file (see maybeWrongFile) — ' +
        'you may have targeted the wrong file.';
    }
  }
  return packet;
}

export { jaccard, bestSpan, FUZZY_THRESHOLD };
