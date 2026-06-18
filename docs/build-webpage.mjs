#!/usr/bin/env node
// build-webpage.mjs — assemble docs/workflow-diagrams.html: both BPMN diagrams (old vs new) rendered with
// bpmn-js, plus the enhancement changelog. Run: node docs/build-webpage.mjs
import { readFileSync, writeFileSync } from "node:fs";

const v1 = readFileSync("docs/proov-workflow.bpmn", "utf8");
const v2 = readFileSync("docs/proov-workflow-v2.bpmn", "utf8");

// Enhancements (Blocks 58-75). `nu` = added/changed in the NEW (post-audit) workflow.
const ENH = [
  ["58", "Task-fidelity gate + served-game URL drive + served vision parity", "Use what the prompt named; play_game/autoplay accept a url (no more FILE_NOT_FOUND loop); served games get the vision checklist.", false],
  ["59", "Build first, don't screenshot every edit", "Loop guard: ≥4 visual checks with no task completed → nudge to build.", false],
  ["60", "Verify a served app before offering to run it", "_verifyServedApp() broken/blank/non-2xx check gates the run-offer.", false],
  ["61", "Structure standard maps split-file games", "bundleGameSource analyzes index.html + every local .js (engine.js/game.js).", false],
  ["62", "Judge the served reality", "A start script → run the served gate (full parity incl. vision) over HTTP first.", false],
  ["63", "Next-step suggester", "On clean done, propose the top structure gap (grounded), accept with y.", false],
  ["64", "Per-asset visual-match gate (≥95%)", "compare_regions vs a reference; done blocked until every asset ≥95%.", false],
  ["65", "Design-first image generation", "generate_image (default google/gemini-2.5-flash-image) draws the target.", false],
  ["66", "Beyond the frame", "The reference is a ~1% sample; a single-screen reproduction is rejected.", false],
  ["67", "ENFORCE design-first preflight", "Proov draws reference.png itself before the agent codes (was prompt-only).", false],
  ["68", "Per-task acceptance checks (from DTP)", "task_write tasks carry an executable check; done blocked while any fails.", false],
  ["69", "see_page (visual) VERIFIES", "Vision model reports what's visible + goal match, not a passive screenshot.", false],
  ["70", "Honest verification + verify-on-exit", "Real checks on EVERY exit; verifiedStatus pass/fail/soft/unverified — a skipped gate never reads as success.", true],
  ["71", "Quality-triggered escalation", "Strong model escalates on WEAK/failed results, not only on stuck.", true],
  ["72", "De-game beyond-the-frame", "Requires structural evidence (real level array / advance-call; ≥2 distinct states), not a keyword.", true],
  ["73", "Plan-first gate", "A substantial multi-part task must be decomposed (task_write) before the first edit.", true],
  ["74", "Durable tests as a deliverable", "Prompt directive: write a committed regression test the user keeps, not just ephemeral gates.", true],
  ["75", "Re-audit fixes", "No tests run on abort/error; in-loop gate passes reported as 'soft' (not 'unverified').", true],
];

const rows = ENH.map(([b, t, d, nu]) => `      <tr class="${nu ? "nu" : ""}"><td class="b">${b}${nu ? ' <span class="tag">NEW</span>' : ""}</td><td class="t">${t}</td><td class="d">${d}</td></tr>`).join("\n");

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proov coding-agent workflow — before vs after the 100-issue audit</title>
<script src="https://unpkg.com/bpmn-js@17.11.1/dist/bpmn-navigated-viewer.production.min.js"></script>
<style>
  :root{--bg:#0e1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#2f81f7;--nu:#3fb950;--warn:#d29922}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  header{padding:28px 32px 14px;border-bottom:1px solid var(--line)} h1{margin:0 0 6px;font-size:24px} .sub{color:var(--mut);max-width:900px}
  .wrap{padding:20px 32px 60px;max-width:1400px;margin:0 auto}
  .tabs{display:flex;gap:8px;margin:18px 0 10px} .tab{padding:8px 16px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);cursor:pointer;font-weight:600}
  .tab.on{border-color:var(--acc);color:#fff;background:#132441} .tab .pill{font-size:11px;color:var(--mut);margin-left:6px}
  .stage{position:relative;height:680px;border:1px solid var(--line);border-radius:12px;background:#fbfdff;overflow:hidden}
  .stage .canvas{position:absolute;inset:0} .stage.hide{display:none}
  .hint{color:var(--mut);font-size:13px;margin:8px 2px 0} .hint b{color:var(--fg)}
  .legend{display:flex;gap:18px;flex-wrap:wrap;margin:10px 2px;color:var(--mut);font-size:13px}
  h2{margin:34px 0 6px;font-size:18px} h2 .c{color:var(--mut);font-weight:400;font-size:14px}
  table{width:100%;border-collapse:collapse;margin-top:10px;font-size:14px} th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  td.b{white-space:nowrap;color:var(--mut);font-variant-numeric:tabular-nums} td.t{font-weight:600;width:32%} td.d{color:var(--mut)}
  tr.nu td{background:rgba(63,185,80,.07)} tr.nu td.t{color:#fff}
  .tag{display:inline-block;background:var(--nu);color:#04130a;font-size:10px;font-weight:800;padding:1px 6px;border-radius:6px;vertical-align:middle}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px} .card h3{margin:0 0 6px;font-size:15px} .card p{margin:0;color:var(--mut);font-size:13px}
  .card.fix{border-color:#1f6f3f} .card.fix h3{color:var(--nu)}
  a{color:var(--acc)} code{background:#1f2630;padding:1px 5px;border-radius:5px;font-size:12px}
  .foot{color:var(--mut);font-size:12px;margin-top:30px;border-top:1px solid var(--line);padding-top:14px}
</style></head>
<body>
<header>
  <h1>Proov coding-agent workflow — before &amp; after the 100-issue audit</h1>
  <div class="sub">Two BPMN renderings of the same agent. <b>Before</b> is the pre-audit pipeline (Blocks 58–69). <b>After</b> adds the audit fixes (Blocks 70–75) that close the "ships unverified" hole, add a plan-first gate, and de-game the checks. Pan/zoom the diagrams; the changelog below marks what's new.</div>
</header>
<div class="wrap">

  <div class="tabs">
    <button class="tab on" data-v="2">After — post-audit <span class="pill">v2 · 34 nodes</span></button>
    <button class="tab" data-v="1">Before — pre-audit <span class="pill">v1 · 27 nodes</span></button>
  </div>
  <div id="stage2" class="stage"><div id="c2" class="canvas"></div></div>
  <div id="stage1" class="stage hide"><div id="c1" class="canvas"></div></div>
  <div class="hint">Scroll to zoom, drag to pan. Nodes labelled <b>NEW</b> are the post-audit additions: the <b>plan-first</b> gate, the <b>FINAL VERIFY on exit</b> step, the <b>verifiedStatus</b> gateway (pass / soft / unverified / fail), and <b>quality-triggered escalation</b>.</div>
  <div class="legend"><span>● circle = event</span><span>▭ rectangle = task/action</span><span>◇ diamond = decision gateway</span></div>

  <h2>What the audit changed <span class="c">— the six fixes that move the ceiling</span></h2>
  <div class="grid">
    <div class="card fix"><h3>70 · Honest verification</h3><p>Real checks run on <em>every</em> exit; a skipped/absent gate never reads as success. Status is <code>pass</code> / <code>fail</code> / <code>soft</code> / <code>unverified</code>.</p></div>
    <div class="card fix"><h3>71 · Quality escalation</h3><p>The strong model now escalates on <em>weak/failed</em> results, not only when the agent is stuck.</p></div>
    <div class="card fix"><h3>72 · De-gamed gates</h3><p>Beyond-the-frame needs real structure (a level array / advance-call, ≥2 states) — a lone keyword no longer passes.</p></div>
    <div class="card fix"><h3>73 · Plan-first</h3><p>A substantial multi-part task must be decomposed with <code>task_write</code> before the first edit.</p></div>
    <div class="card fix"><h3>74 · Durable tests</h3><p>Write a committed regression test the user keeps — not just proov's ephemeral run-time gates.</p></div>
    <div class="card fix"><h3>75 · Re-audit fixes</h3><p>No project tests run after an abort/error; a game that passed its gates reports <code>soft</code>, not <code>unverified</code>.</p></div>
  </div>

  <h2>Full enhancement changelog <span class="c">— Blocks 58–75</span></h2>
  <table><thead><tr><th>Block</th><th>Enhancement</th><th>What it does</th></tr></thead>
  <tbody>
${rows}
  </tbody></table>

  <div class="foot">Generated from <code>docs/proov-workflow.bpmn</code> (before) + <code>docs/proov-workflow-v2.bpmn</code> (after) by <code>docs/build-webpage.mjs</code>. The full audit of 100 issues is in <code>docs/audit-100-critical-issues.md</code>; the detailed Mermaid workflow in <code>docs/proov-workflow.md</code>.</div>
</div>

<script type="application/xml" id="bpmn-v1">
${v1}
</script>
<script type="application/xml" id="bpmn-v2">
${v2}
</script>
<script>
  const viewers = {};
  function show(v){
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on', t.dataset.v===v));
    document.getElementById('stage1').classList.toggle('hide', v!=='1');
    document.getElementById('stage2').classList.toggle('hide', v!=='2');
    render(v);
  }
  function render(v){
    if(viewers[v]){ try{ viewers[v].get('canvas').zoom('fit-viewport'); }catch(e){} return; }
    const xml = document.getElementById('bpmn-v'+v).textContent;
    const viewer = new BpmnJS({ container: '#c'+v });
    viewers[v] = viewer;
    viewer.importXML(xml).then(()=>{ viewer.get('canvas').zoom('fit-viewport'); })
      .catch(err=>{ document.getElementById('c'+v).innerHTML = '<p style="color:#b00;padding:20px">Could not render BPMN: '+err.message+'</p>'; });
  }
  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>show(t.dataset.v)));
  render('2');
</script>
</body></html>
`;

writeFileSync("docs/workflow-diagrams.html", html);
process.stderr.write(`wrote docs/workflow-diagrams.html (${(html.length / 1024).toFixed(0)} KB)\n`);
