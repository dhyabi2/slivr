// compress.mjs — rolling context compression (Block 34): on top of prompt caching (which re-bills the
// stable prefix cheaply), this actually SHRINKS the conversation sent to the model. The dominant bloat in a
// coding session is accumulated TOOL RESULTS — full file contents, directory listings, search hits, and
// viewed images — re-carried every turn. Most are RECONSTRUCTABLE: the agent still has read_file/grep/
// list_dir/etc., so an OLD result can be replaced with a one-line stub and the model just re-calls the tool
// if it needs it again. Lossless (the content is on disk), works for ANY prompt, no summarizer model.
//
// Policy: keep the last K reconstructable results + the last few images VERBATIM (the working set); replace
// OLDER ones in place with a stub. Idempotent (already-elided messages are skipped) and STABLE (a stub never
// changes), so prompt-cache hits are preserved after the one-time elision.

// Tools whose result is deterministically reconstructable by re-calling the same tool — safe to elide.
const RECONSTRUCTABLE = new Set([
  "read_file", "list_dir", "grep", "glob", "repo_map", "find_symbol", "find_refs",
  "git_status", "git_diff", "git_log", "project_info", "house_style", "blueprint_status",
]);
// Tools whose result is NOT reconstructable for free (re-running a build / web fetch isn't deterministic or
// cheap) but whose OLD output is rarely needed verbatim — so truncate the body to a head + stub instead of
// carrying the whole thing forever. (Build/test logs are often the single biggest non-image blocks.)
const TRUNCATABLE = new Set([
  "run_command", "web_fetch", "web_search", "see_page", "http_request", "play_game", "play_levels", "autoplay",
]);
const RESULT_RE = /^RESULT \(([a-z_]+)\):/;
const ELIDED = "elided to save tokens"; // marker so we never re-elide / re-count an already-stubbed result
const TRUNC_HEAD = 400;                  // chars of an old truncatable result kept (header + start, often the key part)

// Compress `messages` IN PLACE. Returns { elided, savedChars } for telemetry.
//  keepResults — most-recent reconstructable results kept full (the working set)
//  keepImages  — most-recent viewed images kept full
//  minElide    — don't bother eliding a result smaller than this (the stub costs ~tokens too)
export function compressContext(messages, { keepResults = 3, keepImages = 1, minElide = 400 } = {}) {
  if (!Array.isArray(messages)) return { elided: 0, savedChars: 0 };
  const resultIdx = [], imageIdx = [], truncIdx = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") {
      if (m.content.includes(ELIDED)) continue;                 // already a stub / already truncated
      const mm = m.content.match(RESULT_RE);
      if (mm && RECONSTRUCTABLE.has(mm[1]) && m.content.length >= minElide) resultIdx.push({ i, tool: mm[1], len: m.content.length });
      else if (mm && TRUNCATABLE.has(mm[1]) && m.content.length >= TRUNC_HEAD * 2.5) truncIdx.push({ i, tool: mm[1], len: m.content.length, content: m.content });
    } else if (Array.isArray(m.content) && m.content.some((b) => b && (b.type === "image_url" || b.type === "file"))) {
      imageIdx.push(i);
    }
  }
  let elided = 0, savedChars = 0;
  // elide everything EXCEPT the last keepResults reconstructable results
  for (const { i, tool, len } of resultIdx.slice(0, Math.max(0, resultIdx.length - keepResults))) {
    messages[i] = { role: "user", content: `RESULT (${tool}): [${len} chars ${ELIDED} — reconstructable; re-call ${tool} if you need it again]` };
    elided++; savedChars += len - 80;
  }
  // TRUNCATE old non-reconstructable results (build/test/web logs) to a head + stub — keep the latest few full
  for (const { i, tool, len, content } of truncIdx.slice(0, Math.max(0, truncIdx.length - keepResults))) {
    messages[i] = { role: "user", content: `${content.slice(0, TRUNC_HEAD)}\n…[older ${tool} output ${ELIDED}; ${len - TRUNC_HEAD} more chars dropped — re-run if you need it]` };
    elided++; savedChars += len - TRUNC_HEAD - 80;
  }
  // elide all but the last keepImages viewed images (a big saving — an image is ~1k+ tokens)
  for (const i of imageIdx.slice(0, Math.max(0, imageIdx.length - keepImages))) {
    let approx = 0; try { for (const b of messages[i].content) { if (b.image_url?.url) approx += b.image_url.url.length; if (b.file?.file_data) approx += b.file.file_data.length; } } catch { /* */ }
    messages[i] = { role: "user", content: `[an attachment you already viewed was ${ELIDED}]` };
    elided++; savedChars += Math.max(0, approx - 60);
  }
  return { elided, savedChars };
}

export const ELIDED_MARKER = ELIDED;
