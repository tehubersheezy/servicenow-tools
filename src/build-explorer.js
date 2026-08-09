#!/usr/bin/env node
'use strict';

/**
 * build-explorer — generate sn-api-explorer.html from the openapi/ spec corpus.
 *
 * The explorer is a self-contained single file: all 342 specs are embedded as
 * JSON and everything (search index, detail rendering, curl builder) happens
 * client-side. Regenerate after any re-scrape:
 *
 *   npm run build:explorer
 *
 * Usage:
 *   node src/build-explorer.js [--specs <dir>] [--out <file>]
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const opts = { specs: 'openapi', out: 'sn-api-explorer.html' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--specs') opts.specs = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else throw new Error('Unknown argument: ' + argv[i]);
  }
  return opts;
}

function loadCorpus(specsDir) {
  const files = fs.readdirSync(specsDir).filter((f) => f.endsWith('.json') && f !== '_summary.json').sort();
  const specs = [];
  for (const file of files) {
    const spec = JSON.parse(fs.readFileSync(path.join(specsDir, file), 'utf8'));
    specs.push({ file, spec });
  }
  let summary = {};
  try { summary = JSON.parse(fs.readFileSync(path.join(specsDir, '_summary.json'), 'utf8')); } catch { /* optional */ }
  return { specs, summary };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const specsDir = path.resolve(process.cwd(), opts.specs);
  const outFile = path.resolve(process.cwd(), opts.out);

  const { specs, summary } = loadCorpus(specsDir);

  // Namespace is encoded in the filename as "<ns>-<Api_Name>.json" (see
  // scrape-openapi.js). The spec itself doesn't carry it anywhere reliable.
  let opCount = 0;
  const nsSet = new Set();
  for (const { file, spec } of specs) {
    nsSet.add(file.slice(0, file.indexOf('-')));
    for (const item of Object.values(spec.paths || {})) {
      for (const op of Object.values(item)) if (op && typeof op === 'object') opCount++;
    }
  }

  const meta = {
    instance: summary.instance || '',
    generatedAt: summary.generatedAt || '',
    builtAt: new Date().toISOString(),
    apiCount: specs.length,
    nsCount: nsSet.size,
    opCount,
  };

  // <-escape so no embedded string can terminate the <script> block.
  const payload = JSON.stringify({ meta, specs }).replace(/</g, '\\u003c');

  // Replacement via function: a literal replacement string would mangle "$&"
  // and friends if they ever appear inside a spec.
  const html = TEMPLATE.replace('"__PAYLOAD__"', () => payload);
  fs.writeFileSync(outFile, html);

  const kb = Math.round(fs.statSync(outFile).size / 1024);
  process.stdout.write(
    'Built ' + path.basename(outFile) + ' — ' + meta.apiCount + ' APIs, ' +
    meta.nsCount + ' namespaces, ' + meta.opCount + ' endpoints, ' + kb + ' KB\n'
  );
}

// ---------------------------------------------------------------------------
// Page template. The page script is written without backticks or ${} so this
// outer template literal stays inert. All data rendering goes through the DOM
// API (createElement/textContent), never innerHTML, so spec content can't
// inject markup.
// ---------------------------------------------------------------------------

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ServiceNow API Explorer</title>
<style>
  :root {
    --bg: oklch(1 0 0);
    --panel: oklch(0.974 0.005 113);
    --panel-2: oklch(0.955 0.008 113);
    --line: oklch(0.906 0.008 113);
    --line-soft: oklch(0.936 0.006 113);
    --ink: oklch(0.24 0.012 113);
    --ink-2: oklch(0.42 0.016 113);
    --ink-3: oklch(0.52 0.02 113);
    --accent: oklch(0.5 0.112 113);
    --accent-deep: oklch(0.4 0.096 113);
    --accent-wash: oklch(0.962 0.038 113);
    --accent-wash-2: oklch(0.93 0.06 113);
    --mark: oklch(0.93 0.088 108);
    --m-get: oklch(0.46 0.1 250);
    --m-post: oklch(0.47 0.104 150);
    --m-put: oklch(0.46 0.1 300);
    --m-patch: oklch(0.49 0.096 68);
    --m-delete: oklch(0.47 0.13 25);
    --shadow-md: 0 1px 2px oklch(0.24 0.012 113 / 0.06), 0 4px 16px oklch(0.24 0.012 113 / 0.07);
    --z-detail-overlay: 30;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: var(--sans); color: var(--ink); background: var(--bg);
    font-size: 0.875rem; line-height: 1.5; font-kerning: normal;
  }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
  :focus { outline: none; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

  /* ---------- Shell ---------- */
  .shell { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  .app {
    display: grid; grid-template-columns: 232px minmax(360px, 1fr) minmax(420px, 1.12fr);
    min-height: 0;
  }

  /* ---------- Header ---------- */
  header {
    display: flex; align-items: center; gap: 1.25rem; padding: 0.65rem 1.25rem;
    border-bottom: 1px solid var(--line); background: var(--bg);
  }
  .brand { display: flex; align-items: baseline; gap: 0.6rem; white-space: nowrap; }
  .brand strong { font-size: 0.9375rem; font-weight: 700; letter-spacing: -0.01em; }
  .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); align-self: center; }
  .brand-meta { color: var(--ink-3); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
  .searchwrap { flex: 1; display: flex; align-items: center; position: relative; max-width: 44rem; }
  #q {
    width: 100%; font: inherit; font-size: 0.9375rem; color: var(--ink);
    padding: 0.5rem 4.25rem 0.5rem 2.35rem; border: 1px solid var(--line);
    border-radius: 8px; background: var(--panel);
  }
  #q::placeholder { color: oklch(0.5 0.018 113); }
  #q:focus { border-color: var(--accent); background: var(--bg); outline: 2px solid var(--accent); outline-offset: -1px; }
  .searchwrap svg { position: absolute; left: 0.75rem; width: 15px; height: 15px; stroke: var(--ink-3); pointer-events: none; }
  .hint {
    position: absolute; right: 0.6rem; color: var(--ink-3); font-size: 0.6875rem;
    border: 1px solid var(--line); border-radius: 5px; padding: 0.05rem 0.4rem; background: var(--bg);
    pointer-events: none;
  }
  .chips { display: flex; gap: 0.25rem; }
  .chip {
    font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.06em; padding: 0.32rem 0.55rem;
    border-radius: 6px; border: 1px solid transparent; color: var(--ink-3);
    transition: background 150ms ease-out, color 150ms ease-out;
  }
  .chip:hover { background: var(--panel); color: var(--ink-2); }
  .chip[aria-pressed="true"] { background: var(--accent-wash); border-color: var(--accent-wash-2); }
  .chip[aria-pressed="true"].m-GET { color: var(--m-get); }
  .chip[aria-pressed="true"].m-POST { color: var(--m-post); }
  .chip[aria-pressed="true"].m-PUT { color: var(--m-put); }
  .chip[aria-pressed="true"].m-PATCH { color: var(--m-patch); }
  .chip[aria-pressed="true"].m-DELETE { color: var(--m-delete); }

  /* ---------- Namespace rail ---------- */
  .rail { border-right: 1px solid var(--line); background: var(--panel); overflow-y: auto; padding: 0.75rem 0.5rem 1.5rem; }
  .rail-head {
    font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink-3); padding: 0.25rem 0.75rem 0.5rem;
  }
  #ns-q {
    width: 100%; font: inherit; font-size: 0.8125rem; color: var(--ink);
    padding: 0.32rem 0.75rem; margin: 0 0 0.5rem; border: 1px solid var(--line);
    border-radius: 6px; background: var(--bg);
  }
  #ns-q::placeholder { color: oklch(0.5 0.018 113); }
  #ns-q:focus { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: -1px; }
  .ns-none { color: var(--ink-3); font-size: 0.75rem; padding: 0.3rem 0.75rem; }
  .rail ul { list-style: none; margin: 0; padding: 0; }
  .ns-btn {
    display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
    width: 100%; text-align: left; padding: 0.28rem 0.75rem; border-radius: 6px;
    color: var(--ink-2); transition: background 150ms ease-out;
  }
  .ns-btn:hover { background: var(--panel-2); }
  .ns-btn[aria-pressed="true"] { background: var(--accent-wash); color: var(--accent-deep); font-weight: 600; }
  .ns-btn .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ns-btn .c { color: var(--ink-3); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
  .ns-btn[aria-pressed="true"] .c { color: var(--accent-deep); }

  /* ---------- Results ---------- */
  .results-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--line); }
  .results-meta {
    padding: 0.55rem 1.25rem; color: var(--ink-3); font-size: 0.75rem;
    border-bottom: 1px solid var(--line-soft); font-variant-numeric: tabular-nums;
    display: flex; justify-content: space-between; gap: 1rem;
  }
  .results-meta button { color: var(--accent); font-size: 0.75rem; font-weight: 600; }
  .results-meta button:hover { color: var(--accent-deep); text-decoration: underline; }
  #results { overflow-y: auto; flex: 1; padding-bottom: 2rem; }
  .group-head {
    position: sticky; top: 0; display: flex; align-items: baseline; gap: 0.5rem;
    width: 100%; text-align: left; padding: 0.6rem 1.25rem 0.45rem; background: var(--bg);
    border-bottom: 1px solid var(--line-soft); transition: background 120ms ease-out;
  }
  .group-head:hover { background: var(--panel); }
  .group-head .chev {
    align-self: center; width: 0.9rem; color: var(--ink-3); font-size: 0.625rem;
    transition: transform 150ms ease-out; transform: rotate(-90deg);
  }
  .group-head[aria-expanded="true"] .chev { transform: none; }
  .group-head .api { font-weight: 700; font-size: 0.8125rem; letter-spacing: -0.005em; }
  .group-head .ns { color: var(--ink-3); font-size: 0.75rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-head .gc { color: var(--ink-3); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
  .row {
    display: grid; grid-template-columns: 3.4rem 1fr; gap: 0.65rem; align-items: baseline;
    width: 100%; text-align: left; padding: 0.42rem 1.25rem;
    transition: background 120ms ease-out;
  }
  .row:hover { background: var(--panel); }
  .row[aria-selected="true"] { background: var(--accent-wash); box-shadow: inset 2px 0 0 var(--accent); }
  .row .method { font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.05em; text-align: right; }
  .m-GET { color: var(--m-get); } .m-POST { color: var(--m-post); } .m-PUT { color: var(--m-put); }
  .m-PATCH { color: var(--m-patch); } .m-DELETE { color: var(--m-delete); }
  .row .path { font-weight: 550; overflow-wrap: anywhere; }
  .row .path .ph { color: var(--accent-deep); font-weight: 450; }
  .row .opdesc { grid-column: 2; color: var(--ink-3); font-size: 0.75rem; margin-top: -0.1rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  mark { background: var(--mark); color: inherit; border-radius: 2px; padding: 0 0.05em; }
  .tail-note { padding: 1rem 1.25rem; color: var(--ink-3); font-size: 0.75rem; }
  .no-results { padding: 3rem 1.5rem; text-align: center; color: var(--ink-2); }
  .no-results strong { display: block; font-size: 1rem; margin-bottom: 0.35rem; }

  /* ---------- Detail pane ---------- */
  .detail { overflow-y: auto; min-width: 0; background: var(--bg); }
  .detail-inner { padding: 1.5rem 1.75rem 3rem; max-width: 46rem; }
  .fade-in { animation: rise 160ms ease-out; }
  @keyframes rise { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  .crumb { color: var(--ink-3); font-size: 0.75rem; margin-bottom: 0.9rem; display: flex; gap: 0.45rem; align-items: baseline; flex-wrap: wrap; }
  .crumb .sep { color: var(--line); }
  .crumb .ver { border: 1px solid var(--line); border-radius: 999px; padding: 0 0.5rem; font-size: 0.6875rem; }
  .op-title { display: flex; align-items: baseline; gap: 0.7rem; margin: 0 0 0.25rem; }
  .op-title .method { font-size: 0.8125rem; font-weight: 700; letter-spacing: 0.05em; }
  h1.path { font-size: 1.25rem; line-height: 1.3; font-weight: 700; letter-spacing: -0.015em;
    margin: 0; overflow-wrap: anywhere; text-wrap: balance; }
  h1.path .ph { color: var(--accent-deep); font-weight: 500; }
  .op-desc { color: var(--ink-2); margin: 0.5rem 0 0; max-width: 65ch; }
  .actions { display: flex; gap: 0.5rem; margin: 1.1rem 0 0; }
  .btn {
    font-size: 0.8125rem; font-weight: 600; padding: 0.42rem 0.8rem; border-radius: 7px;
    border: 1px solid var(--line); color: var(--ink-2); background: var(--bg);
    transition: background 150ms ease-out, border-color 150ms ease-out;
  }
  .btn:hover { background: var(--panel); border-color: var(--line); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: oklch(0.99 0.01 113); }
  .btn.primary:hover { background: var(--accent-deep); border-color: var(--accent-deep); }
  .btn.copied, .btn.primary.copied { background: var(--accent-wash); border-color: var(--accent-wash-2); color: var(--accent-deep); }
  section.block { margin-top: 2rem; }
  .block h2 {
    font-size: 0.8125rem; font-weight: 700; margin: 0 0 0.6rem; letter-spacing: -0.005em;
    display: flex; align-items: baseline; gap: 0.5rem;
  }
  .block h2 .sub { color: var(--ink-3); font-weight: 400; font-size: 0.75rem; }
  table.params { width: 100%; border-collapse: collapse; }
  .params th {
    text-align: left; font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--ink-3); padding: 0.3rem 0.75rem 0.3rem 0; border-bottom: 1px solid var(--line);
  }
  .params td { padding: 0.45rem 0.75rem 0.45rem 0; border-bottom: 1px solid var(--line-soft); vertical-align: baseline; }
  .params td.pname { font-weight: 600; white-space: nowrap; }
  .params td.pin { color: var(--ink-3); font-size: 0.75rem; white-space: nowrap; }
  .params td.preq { font-size: 0.75rem; color: var(--accent-deep); font-weight: 600; white-space: nowrap; }
  .params td.pdesc { color: var(--ink-2); font-size: 0.8125rem; max-width: 34ch; }
  .ct-list { color: var(--ink-2); font-size: 0.8125rem; }
  .curl {
    background: var(--panel); border: 1px solid var(--line-soft); border-radius: 10px;
    padding: 0.9rem 1.1rem; white-space: pre-wrap; overflow-wrap: anywhere;
    font-size: 0.8125rem; line-height: 1.65; color: var(--ink-2); position: relative;
  }
  .curl .u { color: var(--ink); font-weight: 600; }
  .copy-mini {
    position: absolute; top: 0.55rem; right: 0.55rem; font-size: 0.6875rem; font-weight: 600;
    color: var(--ink-3); padding: 0.22rem 0.5rem; border-radius: 5px; border: 1px solid var(--line);
    background: var(--bg); transition: color 150ms ease-out;
  }
  .copy-mini:hover { color: var(--accent-deep); }
  .copy-mini.copied { color: var(--accent-deep); background: var(--accent-wash); border-color: var(--accent-wash-2); }
  .api-about { border-top: 1px solid var(--line); margin-top: 2.25rem; padding-top: 1.5rem; }
  .api-about .desc { color: var(--ink-2); max-width: 65ch; margin: 0.3rem 0 0.9rem; }
  .meta-line { color: var(--ink-3); font-size: 0.75rem; margin-bottom: 1rem; }
  .meta-line a { color: var(--accent-deep); }
  .sibling {
    display: grid; grid-template-columns: 3.4rem 1fr; gap: 0.65rem; align-items: baseline;
    width: 100%; text-align: left; padding: 0.3rem 0.5rem; border-radius: 6px; margin-left: -0.5rem;
    transition: background 120ms ease-out;
  }
  .sibling:hover { background: var(--panel); }
  .sibling .method { font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.05em; text-align: right; }
  .sibling .path { overflow-wrap: anywhere; font-weight: 500; }
  .sibling[data-current="1"] { background: var(--accent-wash); }
  details.raw { margin-top: 2rem; border-top: 1px solid var(--line); padding-top: 1.25rem; }
  details.raw summary { cursor: pointer; font-weight: 600; font-size: 0.8125rem; color: var(--ink-2); }
  details.raw summary:hover { color: var(--accent-deep); }
  .raw-body { position: relative; margin-top: 0.8rem; }
  .raw-json {
    background: var(--panel); border: 1px solid var(--line-soft); border-radius: 10px;
    padding: 1rem 1.1rem; white-space: pre-wrap; overflow-wrap: anywhere;
    font-size: 0.75rem; line-height: 1.6; color: var(--ink-2); max-height: 30rem; overflow-y: auto;
  }

  /* ---------- Welcome / empty detail ---------- */
  .welcome h1 { font-size: 1.375rem; font-weight: 700; letter-spacing: -0.02em; margin: 0.5rem 0 0.75rem; text-wrap: balance; }
  .welcome .lede { color: var(--ink-2); max-width: 58ch; margin: 0 0 1.75rem; }
  .welcome .lede strong { font-variant-numeric: tabular-nums; }
  .try { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 2.25rem; }
  .try button {
    border: 1px solid var(--line); border-radius: 999px; padding: 0.3rem 0.85rem;
    font-size: 0.8125rem; color: var(--ink-2); transition: all 150ms ease-out;
  }
  .try button:hover { border-color: var(--accent); color: var(--accent-deep); background: var(--accent-wash); }
  .keys { border-top: 1px solid var(--line-soft); padding-top: 1.4rem; }
  .keys h2 { font-size: 0.8125rem; margin: 0 0 0.7rem; }
  .keys dl { display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 1rem; margin: 0; font-size: 0.8125rem; }
  .keys dt span {
    display: inline-block; min-width: 1.6rem; text-align: center; border: 1px solid var(--line);
    border-bottom-width: 2px; border-radius: 5px; padding: 0.02rem 0.4rem; font-size: 0.75rem;
    color: var(--ink-2); background: var(--panel);
  }
  .keys dd { margin: 0; color: var(--ink-2); align-self: center; }

  /* ---------- Responsive ---------- */
  .detail-back { display: none; }
  @media (max-width: 1080px) {
    .app { grid-template-columns: minmax(340px, 1fr) minmax(400px, 1.1fr); }
    .rail { display: none; }
    .results-meta .ns-inline { display: inline; }
  }
  @media (max-width: 840px) {
    .app { grid-template-columns: 1fr; }
    .detail {
      position: fixed; inset: 0; top: auto; height: calc(100vh - 3.4rem); z-index: var(--z-detail-overlay);
      transform: translateY(100%); transition: transform 220ms ease-out;
      box-shadow: var(--shadow-md); border-top: 1px solid var(--line);
    }
    .detail.open { transform: none; }
    .detail-back {
      display: inline-flex; align-items: center; gap: 0.4rem; color: var(--accent-deep);
      font-weight: 600; font-size: 0.8125rem; margin-bottom: 1rem;
    }
    header { flex-wrap: wrap; gap: 0.6rem; }
    .searchwrap { order: 3; min-width: 100%; }
    .row { padding-top: 0.6rem; padding-bottom: 0.6rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="brand"><span class="dot" aria-hidden="true"></span><strong>SN API Explorer</strong><span class="brand-meta" id="brand-meta"></span></div>
    <div class="searchwrap">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="text" role="combobox" aria-expanded="true" aria-controls="results"
             aria-autocomplete="list" aria-label="Search endpoints" autocomplete="off" spellcheck="false" autofocus>
      <span class="hint" id="hint" aria-hidden="true">/</span>
    </div>
    <div class="chips" role="group" aria-label="Filter by method" id="chips"></div>
  </header>
  <div class="app">
    <nav class="rail" aria-label="Namespaces">
      <div class="rail-head">Namespaces <span id="ns-count"></span></div>
      <input id="ns-q" type="text" aria-label="Filter namespaces" placeholder="Filter namespaces" autocomplete="off" spellcheck="false">
      <ul id="ns-list"></ul>
    </nav>
    <main class="results-col">
      <div class="results-meta"><span id="count" aria-live="polite"></span><button id="clear-filters" hidden>Clear filters</button></div>
      <div id="results" role="listbox" aria-label="Endpoints" tabindex="-1"></div>
    </main>
    <aside class="detail" id="detail" aria-label="Endpoint detail"><div class="detail-inner" id="detail-inner"></div></aside>
  </div>
</div>
<script>
var DATA = "__PAYLOAD__";
</script>
<script>
(function () {
  'use strict';

  var META = DATA.meta;
  var METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

  // ---------- Model ----------
  // Flatten specs into apis[] and ops[]. Namespace comes from the filename
  // prefix (see scrape-openapi.js naming convention).
  var apis = [];
  var ops = [];
  DATA.specs.forEach(function (entry, apiIdx) {
    var spec = entry.spec || {};
    var info = spec.info || {};
    var ns = entry.file.slice(0, entry.file.indexOf('-'));
    var api = {
      idx: apiIdx,
      file: entry.file,
      ns: ns,
      name: info.title || entry.file,
      desc: info.description || '',
      version: info.version || '',
      docs: (spec.externalDocs && spec.externalDocs.url) || '',
      spec: spec,
      ops: []
    };
    apis.push(api);
    var paths = spec.paths || {};
    Object.keys(paths).forEach(function (p) {
      var item = paths[p] || {};
      Object.keys(item).forEach(function (m) {
        var op = item[m];
        if (!op || typeof op !== 'object') return;
        var params = (op.parameters || []).map(function (pr) {
          return { name: pr.name || '', loc: pr.in || '', req: !!pr.required, desc: pr.description || '' };
        });
        var contentTypes = op.requestBody && op.requestBody.content ? Object.keys(op.requestBody.content) : [];
        var record = {
          id: ops.length,
          api: api,
          method: m.toUpperCase(),
          path: p,
          desc: op.description || op.summary || '',
          params: params,
          contentTypes: contentTypes,
          hay: null
        };
        record.hay = (record.method + ' ' + p + ' ' + api.name + ' ' + ns + ' ' +
          params.map(function (x) { return x.name; }).join(' ') + ' ' +
          record.desc + ' ' + api.desc).toLowerCase();
        api.ops.push(record);
        ops.push(record);
      });
    });
  });

  var nsIndex = {};
  ops.forEach(function (o) { nsIndex[o.api.ns] = (nsIndex[o.api.ns] || 0) + 1; });
  var nsNames = Object.keys(nsIndex).sort(function (a, b) { return nsIndex[b] - nsIndex[a] || a.localeCompare(b); });

  // Browse order = the catalogue's shape: biggest namespace first (matching the
  // rail), then API name within it. Precompute once; search mode re-sorts.
  var nsRank = {};
  nsNames.forEach(function (ns, i) { nsRank[ns] = i; });
  ops.sort(function (a, b) {
    return nsRank[a.api.ns] - nsRank[b.api.ns] ||
      a.api.name.localeCompare(b.api.name) ||
      a.path.localeCompare(b.path);
  });

  // ---------- State ----------
  // expanded: manual group toggles in browse mode (default collapsed).
  // qCollapsed: manual collapses while a query is live (default expanded);
  // reset whenever the query changes.
  var state = { q: '', ns: null, methods: {}, sel: null, visible: [], expanded: {}, qCollapsed: {} };
  var RENDER_CAP = 600;

  function isExpanded(api) {
    return tokenize(state.q).length ? !state.qCollapsed[api.idx] : !!state.expanded[api.idx];
  }
  function toggleGroup(api) {
    if (tokenize(state.q).length) {
      if (state.qCollapsed[api.idx]) delete state.qCollapsed[api.idx];
      else state.qCollapsed[api.idx] = true;
    } else {
      if (state.expanded[api.idx]) delete state.expanded[api.idx];
      else state.expanded[api.idx] = true;
    }
    renderResults();
  }
  function ensureExpanded(api) {
    var changed = false;
    if (tokenize(state.q).length) {
      if (state.qCollapsed[api.idx]) { delete state.qCollapsed[api.idx]; changed = true; }
    } else if (!state.expanded[api.idx]) { state.expanded[api.idx] = true; changed = true; }
    return changed;
  }

  // ---------- DOM helpers ----------
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function frag() { return document.createDocumentFragment(); }

  // Render a path with {placeholders} tinted and query tokens marked.
  function pathNodes(container, text, tokens, phClass) {
    var lower = text.toLowerCase();
    var marks = [];
    (tokens || []).forEach(function (t) {
      var from = 0, at;
      while (t && (at = lower.indexOf(t, from)) !== -1) { marks.push([at, at + t.length]); from = at + t.length; }
    });
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    marks.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) { last[1] = Math.max(last[1], r[1]); } else { merged.push(r.slice()); }
    });
    var i = 0;
    function emit(from, to, marked) {
      var chunk = text.slice(from, to);
      var re = /\\{[^}]*\\}/g, pos = 0, m;
      var host = marked ? el('mark') : container;
      while ((m = re.exec(chunk)) !== null) {
        if (m.index > pos) host.appendChild(document.createTextNode(chunk.slice(pos, m.index)));
        host.appendChild(el('span', phClass || 'ph', m[0]));
        pos = m.index + m[0].length;
      }
      if (pos < chunk.length) host.appendChild(document.createTextNode(chunk.slice(pos)));
      if (marked) container.appendChild(host);
    }
    merged.forEach(function (r) {
      if (r[0] > i) emit(i, r[0], false);
      emit(r[0], r[1], true);
      i = r[1];
    });
    if (i < text.length) emit(i, text.length, false);
  }

  function markNodes(container, text, tokens) {
    var lower = text.toLowerCase();
    var marks = [];
    (tokens || []).forEach(function (t) {
      var from = 0, at;
      while (t && (at = lower.indexOf(t, from)) !== -1) { marks.push([at, at + t.length]); from = at + t.length; }
    });
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    marks.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) { last[1] = Math.max(last[1], r[1]); } else { merged.push(r.slice()); }
    });
    var i = 0;
    merged.forEach(function (r) {
      if (r[0] > i) container.appendChild(document.createTextNode(text.slice(i, r[0])));
      container.appendChild(el('mark', null, text.slice(r[0], r[1])));
      i = r[1];
    });
    if (i < text.length) container.appendChild(document.createTextNode(text.slice(i)));
  }

  // ---------- Search ----------
  function tokenize(q) {
    return q.toLowerCase().split(/\\s+/).filter(Boolean);
  }

  function score(op, tokens) {
    var total = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (op.hay.indexOf(t) === -1) return -1;
      var s = 0;
      var pl = op.path.toLowerCase();
      var at = pl.indexOf(t);
      if (at !== -1) s = (at === 0 || pl[at - 1] === '/' || pl[at - 1] === '_' || pl[at - 1] === '{') ? 6 : 4;
      else if (op.api.name.toLowerCase().indexOf(t) !== -1) s = 4;
      else if (op.api.ns.toLowerCase().indexOf(t) !== -1) s = 3;
      else {
        for (var j = 0; j < op.params.length; j++) {
          if (op.params[j].name.toLowerCase().indexOf(t) !== -1) { s = 2; break; }
        }
        if (!s) s = 1;
      }
      total += s;
    }
    return total;
  }

  function currentMatches() {
    var tokens = tokenize(state.q);
    var anyMethod = METHODS.some(function (m) { return state.methods[m]; });
    var list = [];
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (state.ns && o.api.ns !== state.ns) continue;
      if (anyMethod && !state.methods[o.method]) continue;
      if (tokens.length) {
        var s = score(o, tokens);
        if (s < 0) continue;
        list.push({ op: o, s: s });
      } else {
        list.push({ op: o, s: 0 });
      }
    }
    if (tokens.length) {
      // Rank APIs by their best-scoring op, then keep each API's ops together —
      // otherwise interleaved scores split one API into several group headers.
      var best = {};
      list.forEach(function (x) {
        var k = x.op.api.idx;
        if (!(k in best) || x.s > best[k]) best[k] = x.s;
      });
      list.sort(function (a, b) {
        return best[b.op.api.idx] - best[a.op.api.idx] ||
          a.op.api.idx - b.op.api.idx ||
          b.s - a.s ||
          a.op.path.localeCompare(b.op.path);
      });
    }
    return list.map(function (x) { return x.op; });
  }

  // ---------- Results list ----------
  var resultsEl = document.getElementById('results');
  var countEl = document.getElementById('count');
  var clearBtn = document.getElementById('clear-filters');

  function fmt(n) { return n.toLocaleString('en-US'); }

  function renderResults() {
    var matches = currentMatches();
    var tokens = tokenize(state.q);
    var f = frag();

    // Group matches by API, preserving match order.
    var groups = [];
    var lastApi = null;
    matches.forEach(function (op) {
      if (op.api !== lastApi) { lastApi = op.api; groups.push({ api: op.api, ops: [] }); }
      groups[groups.length - 1].ops.push(op);
    });

    state.visible = [];
    var renderedRows = 0, cutRows = 0;

    groups.forEach(function (g) {
      var open = isExpanded(g.api);
      var gh = el('button', 'group-head');
      gh.setAttribute('aria-expanded', open ? 'true' : 'false');
      gh.appendChild(el('span', 'chev', '\\u25BC'));
      var nameSpan = el('span', 'api');
      markNodes(nameSpan, g.api.name, tokens);
      gh.appendChild(nameSpan);
      gh.appendChild(el('span', 'ns', g.api.ns + (g.api.version ? ' · ' + g.api.version : '')));
      gh.appendChild(el('span', 'gc', fmt(g.ops.length)));
      gh.addEventListener('click', function () { toggleGroup(g.api); });
      f.appendChild(gh);

      if (!open) return;
      g.ops.forEach(function (op) {
        if (renderedRows >= RENDER_CAP) { cutRows++; return; }
        renderedRows++;
        state.visible.push(op);
        var row = el('button', 'row');
        row.setAttribute('role', 'option');
        row.id = 'op-' + op.id;
        row.setAttribute('aria-selected', state.sel === op ? 'true' : 'false');
        row.appendChild(el('span', 'method m-' + op.method, op.method));
        var pathSpan = el('span', 'path');
        pathNodes(pathSpan, op.path, tokens);
        row.appendChild(pathSpan);
        if (op.desc) {
          var d = el('span', 'opdesc');
          markNodes(d, op.desc, tokens);
          row.appendChild(d);
        }
        row.addEventListener('click', function () { select(op, true); });
        f.appendChild(row);
      });
    });

    if (!matches.length) {
      var empty = el('div', 'no-results');
      empty.appendChild(el('strong', null, 'No endpoints match'));
      empty.appendChild(el('span', null, 'Fewer words usually work better — try one path segment or an API name.'));
      f.appendChild(empty);
    } else if (cutRows) {
      f.appendChild(el('div', 'tail-note', 'Showing the top ' + fmt(renderedRows) + ' of ' + fmt(renderedRows + cutRows) + ' expanded endpoints — refine to narrow.'));
    }

    resultsEl.textContent = '';
    resultsEl.appendChild(f);

    var scope = [];
    if (state.ns) scope.push(state.ns);
    var mOn = METHODS.filter(function (m) { return state.methods[m]; });
    if (mOn.length) scope.push(mOn.join(', '));
    countEl.textContent = fmt(matches.length) + ' endpoint' + (matches.length === 1 ? '' : 's') +
      (scope.length ? ' in ' + scope.join(' · ') : '');
    clearBtn.hidden = !(state.q || state.ns || mOn.length);

    if (state.sel && state.visible.indexOf(state.sel) === -1) {
      // keep detail; selection row just isn't visible in this filter
      input.removeAttribute('aria-activedescendant');
    }
  }

  // ---------- Selection & detail ----------
  var detailEl = document.getElementById('detail');
  var detailInner = document.getElementById('detail-inner');
  var input = document.getElementById('q');

  function select(op, fromClick) {
    state.sel = op;
    if (ensureExpanded(op.api)) renderResults();
    var prev = resultsEl.querySelector('[aria-selected="true"]');
    if (prev) prev.setAttribute('aria-selected', 'false');
    var row = document.getElementById('op-' + op.id);
    if (row) {
      row.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    }
    renderDetail(op);
    if (fromClick && window.matchMedia('(max-width: 840px)').matches) {
      detailEl.classList.add('open');
    }
    writeHash();
  }

  function copyButton(label, getText, cls) {
    var b = el('button', cls || 'btn', label);
    b.addEventListener('click', function () {
      var text = getText();
      function done() {
        var was = b.textContent;
        b.textContent = 'Copied';
        b.classList.add('copied');
        setTimeout(function () { b.textContent = was; b.classList.remove('copied'); }, 1300);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else { fallbackCopy(text); done(); }
    });
    return b;
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* best effort */ }
    document.body.removeChild(ta);
  }

  function buildCurl(op) {
    var base = META.instance || 'https://INSTANCE.service-now.com';
    var url = base + op.path;
    var reqQuery = op.params.filter(function (p) { return p.loc === 'query' && p.req; });
    if (reqQuery.length) {
      url += '?' + reqQuery.map(function (p) { return p.name + '='; }).join('&');
    }
    var lines = ['curl -u "$SN_USERNAME:$SN_PASSWORD" \\\\'];
    if (op.method !== 'GET') lines.push('  -X ' + op.method + ' \\\\');
    lines.push('  -H "Accept: application/json" \\\\');
    if (op.method !== 'GET' && op.method !== 'DELETE') {
      if (op.contentTypes.indexOf('multipart/form-data') !== -1) {
        lines.push('  -F "file=@./file.bin" \\\\');
      } else if (op.contentTypes.indexOf('application/json') !== -1) {
        lines.push('  -H "Content-Type: application/json" \\\\');
        lines.push('  -d \\'{}\\' \\\\');
      }
    }
    lines.push('  "' + url + '"');
    return lines.join('\\n');
  }

  function renderDetail(op) {
    var f = frag();
    var inner = el('div', 'fade-in');

    var back = el('button', 'detail-back', '← Back to results');
    back.addEventListener('click', function () { detailEl.classList.remove('open'); });
    inner.appendChild(back);

    var crumb = el('div', 'crumb');
    crumb.appendChild(el('span', null, op.api.ns));
    crumb.appendChild(el('span', 'sep', '/'));
    crumb.appendChild(el('span', null, op.api.name));
    if (op.api.version) crumb.appendChild(el('span', 'ver', op.api.version));
    inner.appendChild(crumb);

    var title = el('div', 'op-title');
    title.appendChild(el('span', 'method m-' + op.method, op.method));
    inner.appendChild(title);
    var h1 = el('h1', 'path');
    pathNodes(h1, op.path, []);
    inner.appendChild(title);
    title.appendChild(h1);

    if (op.desc) inner.appendChild(el('p', 'op-desc', op.desc));

    var actions = el('div', 'actions');
    actions.appendChild(copyButton('Copy curl', function () { return buildCurl(op); }, 'btn primary'));
    actions.appendChild(copyButton('Copy path', function () { return op.path; }));
    inner.appendChild(actions);

    if (op.params.length) {
      var sec = el('section', 'block');
      var h2 = el('h2', null, 'Parameters ');
      h2.appendChild(el('span', 'sub', op.params.length + (op.params.length === 1 ? ' parameter' : ' parameters')));
      sec.appendChild(h2);
      var table = el('table', 'params');
      var thead = el('thead');
      var hr = el('tr');
      ['Name', 'In', '', 'Description'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = el('tbody');
      var sorted = op.params.slice().sort(function (a, b) {
        var order = { path: 0, query: 1, header: 2 };
        return (order[a.loc] || 3) - (order[b.loc] || 3) || (b.req - a.req);
      });
      sorted.forEach(function (p) {
        var tr = el('tr');
        tr.appendChild(el('td', 'pname', p.name));
        tr.appendChild(el('td', 'pin', p.loc));
        tr.appendChild(el('td', 'preq', p.req ? 'required' : ''));
        tr.appendChild(el('td', 'pdesc', p.desc));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      sec.appendChild(table);
      inner.appendChild(sec);
    }

    if (op.contentTypes.length) {
      var bodySec = el('section', 'block');
      bodySec.appendChild(el('h2', null, 'Request body'));
      bodySec.appendChild(el('p', 'ct-list', 'Accepts ' + op.contentTypes.join(', ') +
        '. The instance publishes no schema for this operation — check the product docs or an existing record for field names.'));
      inner.appendChild(bodySec);
    }

    var curlSec = el('section', 'block');
    curlSec.appendChild(el('h2', null, 'Request'));
    var curl = el('div', 'curl');
    var curlText = buildCurl(op);
    // render with the URL emphasized
    var parts = curlText.split('\\n');
    parts.forEach(function (line, i) {
      if (i === parts.length - 1) {
        var span = el('span', 'u', line);
        curl.appendChild(span);
      } else {
        curl.appendChild(document.createTextNode(line + '\\n'));
      }
    });
    curl.appendChild(copyButton('Copy', function () { return buildCurl(op); }, 'copy-mini'));
    curlSec.appendChild(curl);
    inner.appendChild(curlSec);

    var about = el('section', 'api-about');
    var ah = el('h2', null, op.api.name + ' ');
    ah.appendChild(el('span', 'sub', fmt(op.api.ops.length) + (op.api.ops.length === 1 ? ' endpoint' : ' endpoints')));
    ah.style.fontSize = '0.9375rem'; ah.style.margin = '0';
    about.appendChild(ah);
    if (op.api.desc) about.appendChild(el('p', 'desc', op.api.desc));
    var metaLine = el('p', 'meta-line');
    metaLine.appendChild(document.createTextNode('Source ' + op.api.file));
    if (op.api.docs) {
      metaLine.appendChild(document.createTextNode(' · '));
      var a = el('a', null, 'product docs');
      a.href = op.api.docs; a.target = '_blank'; a.rel = 'noopener';
      metaLine.appendChild(a);
    }
    about.appendChild(metaLine);
    op.api.ops.forEach(function (sib) {
      var b = el('button', 'sibling');
      if (sib === op) b.setAttribute('data-current', '1');
      b.appendChild(el('span', 'method m-' + sib.method, sib.method));
      var ps = el('span', 'path');
      pathNodes(ps, sib.path, []);
      b.appendChild(ps);
      b.addEventListener('click', function () { select(sib, false); });
      about.appendChild(b);
    });
    inner.appendChild(about);

    var raw = el('details', 'raw');
    var summary = el('summary', null, 'Full OpenAPI spec');
    raw.appendChild(summary);
    var rawBody = el('div', 'raw-body');
    raw.appendChild(rawBody);
    raw.addEventListener('toggle', function () {
      if (raw.open && !rawBody.firstChild) {
        var pre = el('div', 'raw-json', JSON.stringify(op.api.spec, null, 2));
        rawBody.appendChild(copyButton('Copy', function () { return JSON.stringify(op.api.spec, null, 2); }, 'copy-mini'));
        rawBody.appendChild(pre);
      }
    });
    inner.appendChild(raw);

    detailInner.textContent = '';
    detailInner.appendChild(inner);
    detailEl.scrollTop = 0;
  }

  function renderWelcome() {
    var inner = el('div', 'welcome fade-in');
    inner.appendChild(el('h1', null, 'Every REST endpoint on the instance, one search away'));
    var lede = el('p', 'lede');
    lede.appendChild(document.createTextNode('This file indexes '));
    lede.appendChild(el('strong', null, fmt(META.opCount) + ' endpoints'));
    lede.appendChild(document.createTextNode(' across ' + fmt(META.apiCount) + ' APIs and ' + fmt(META.nsCount) +
      ' namespaces, exported from ' + (META.instance ? META.instance.replace('https://', '') : 'the instance') +
      (META.generatedAt ? ' on ' + META.generatedAt.slice(0, 10) : '') +
      '. Start typing to search, or wander the namespaces on the left — the scoped and internal APIs are where the treasure is.'));
    inner.appendChild(lede);

    var tries = el('div', 'try');
    ['attachment', 'cmdb instance', 'internal', 'email', 'table api', 'ai search'].forEach(function (t) {
      var b = el('button', null, t);
      b.addEventListener('click', function () {
        input.value = t; state.q = t; renderResults(); autoSelectFirst(); input.focus(); writeHash();
      });
      tries.appendChild(b);
    });
    inner.appendChild(tries);

    var keys = el('div', 'keys');
    keys.appendChild(el('h2', null, 'Keyboard'));
    var dl = el('dl');
    [['/', 'Focus search'], ['↑ ↓', 'Move through results'], ['Enter', 'Jump to detail pane'], ['Esc', 'Clear search']].forEach(function (pair) {
      var dt = el('dt');
      dt.appendChild(el('span', null, pair[0]));
      dl.appendChild(dt);
      dl.appendChild(el('dd', null, pair[1]));
    });
    keys.appendChild(dl);
    inner.appendChild(keys);

    detailInner.textContent = '';
    detailInner.appendChild(inner);
  }

  // ---------- Rail & chips ----------
  var nsQuery = '';
  function renderRail() {
    var list = document.getElementById('ns-list');
    var f = frag();
    var shown = nsNames.filter(function (ns) { return ns.indexOf(nsQuery) !== -1; });
    if (!shown.length) f.appendChild(el('li', 'ns-none', 'No namespaces match'));
    shown.forEach(function (ns) {
      var li = el('li');
      var b = el('button', 'ns-btn');
      b.setAttribute('aria-pressed', state.ns === ns ? 'true' : 'false');
      b.appendChild(el('span', 'n', ns));
      b.appendChild(el('span', 'c', fmt(nsIndex[ns])));
      b.addEventListener('click', function () {
        state.ns = state.ns === ns ? null : ns;
        renderRail(); renderResults(); writeHash();
      });
      li.appendChild(b);
      f.appendChild(li);
    });
    list.textContent = '';
    list.appendChild(f);
    document.getElementById('ns-count').textContent =
      nsQuery ? shown.length + ' / ' + nsNames.length : nsNames.length;
  }

  var nsInput = document.getElementById('ns-q');
  nsInput.addEventListener('input', function () {
    nsQuery = nsInput.value.trim().toLowerCase();
    renderRail();
  });
  nsInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (nsInput.value) { nsInput.value = ''; nsQuery = ''; renderRail(); }
      else nsInput.blur();
      e.stopPropagation();
    }
  });

  function renderChips() {
    var chips = document.getElementById('chips');
    var f = frag();
    METHODS.forEach(function (m) {
      var b = el('button', 'chip m-' + m, m);
      b.setAttribute('aria-pressed', state.methods[m] ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.methods[m] = !state.methods[m];
        renderChips(); renderResults(); writeHash();
      });
      f.appendChild(b);
    });
    chips.textContent = '';
    chips.appendChild(f);
  }

  // ---------- Keyboard ----------
  function autoSelectFirst() {
    if (state.visible.length && state.visible.indexOf(state.sel) === -1) {
      select(state.visible[0], false);
    } else if (!state.visible.length) {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function move(delta) {
    if (!state.visible.length) return;
    var i = state.visible.indexOf(state.sel);
    var next = i === -1 ? (delta > 0 ? 0 : state.visible.length - 1) : i + delta;
    if (next < 0) next = 0;
    if (next >= state.visible.length) next = state.visible.length - 1;
    select(state.visible[next], false);
  }

  input.addEventListener('input', function () {
    state.q = input.value.trim();
    state.qCollapsed = {};
    renderResults();
    if (state.q) autoSelectFirst(); else { renderWelcome(); state.sel = null; }
    writeHash();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && state.sel) { e.preventDefault(); detailEl.setAttribute('tabindex', '-1'); detailEl.focus(); }
    else if (e.key === 'Escape') {
      if (input.value) { input.value = ''; state.q = ''; renderResults(); renderWelcome(); state.sel = null; writeHash(); }
      else input.blur();
    }
  });

  document.addEventListener('keydown', function (e) {
    var typing = document.activeElement === input ||
      (document.activeElement && /^(input|textarea|select)$/i.test(document.activeElement.tagName));
    if ((e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) && !typing) {
      e.preventDefault(); input.focus(); input.select();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); input.focus(); input.select();
    } else if (e.key === 'ArrowDown' && !typing) { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp' && !typing) { e.preventDefault(); move(-1); }
    else if (e.key === 'Escape' && detailEl.classList.contains('open')) { detailEl.classList.remove('open'); }
  });

  clearBtn.addEventListener('click', function () {
    state.q = ''; state.ns = null; state.methods = {}; state.qCollapsed = {};
    input.value = '';
    renderChips(); renderRail(); renderResults(); renderWelcome(); state.sel = null;
    input.focus(); writeHash();
  });

  // ---------- URL hash state ----------
  var hashLock = false;
  function writeHash() {
    var parts = [];
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.ns) parts.push('ns=' + encodeURIComponent(state.ns));
    var mOn = METHODS.filter(function (m) { return state.methods[m]; });
    if (mOn.length) parts.push('m=' + mOn.join('.'));
    if (state.sel) parts.push('op=' + encodeURIComponent(state.sel.api.file) + ':' + state.sel.api.ops.indexOf(state.sel));
    hashLock = true;
    var h = parts.length ? '#' + parts.join('&') : '#';
    if ('replaceState' in history) history.replaceState(null, '', h); else location.hash = h;
    setTimeout(function () { hashLock = false; }, 0);
  }

  function readHash() {
    if (!location.hash || location.hash === '#') return false;
    var any = false;
    location.hash.slice(1).split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i === -1) return;
      var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
      if (k === 'q') { state.q = v; input.value = v; any = true; }
      else if (k === 'ns') { state.ns = v; any = true; }
      else if (k === 'm') { v.split('.').forEach(function (m) { state.methods[m] = true; }); any = true; }
      else if (k === 'op') {
        var c = v.lastIndexOf(':');
        var file = v.slice(0, c), idx = parseInt(v.slice(c + 1), 10);
        for (var a = 0; a < apis.length; a++) {
          if (apis[a].file === file && apis[a].ops[idx]) { state.sel = apis[a].ops[idx]; any = true; break; }
        }
      }
    });
    return any;
  }

  window.addEventListener('hashchange', function () {
    if (hashLock) return;
    state.q = ''; state.ns = null; state.methods = {}; state.sel = null; state.qCollapsed = {};
    input.value = '';
    readHash();
    renderChips(); renderRail(); renderResults();
    if (state.sel) select(state.sel, false);
    else if (state.q && state.visible.length) autoSelectFirst();
    else renderWelcome();
  });

  // ---------- Boot ----------
  document.getElementById('brand-meta').textContent =
    (META.instance ? META.instance.replace('https://', '').split('.')[0] + ' · ' : '') +
    fmt(META.apiCount) + ' APIs · ' + fmt(META.opCount) + ' endpoints';

  var restored = readHash();
  renderChips();
  renderRail();
  renderResults();
  if (state.sel) { select(state.sel, false); }
  else if (restored && state.q && state.visible.length) { autoSelectFirst(); }
  else { renderWelcome(); }
})();
</script>
</body>
</html>
`;

if (require.main === module) {
  try { main(); } catch (err) {
    process.stderr.write('build-explorer failed: ' + err.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, loadCorpus };
