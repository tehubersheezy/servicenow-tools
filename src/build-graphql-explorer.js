#!/usr/bin/env node
'use strict';

/**
 * build-graphql-explorer — generate sn-graphql-explorer.html from the graphql/
 * corpus (see scrape-graphql.js).
 *
 * Self-contained single file, same idea as build-explorer.js: the scripted
 * namespaces are embedded as a compact type model, the GlideRecord table index
 * rides along as table -> column names, and everything (search, detail
 * rendering, GraphQL codegen, curl builder, SDL rendering) happens client-side.
 *
 *   npm run build:graphql-explorer
 *
 * Usage:
 *   node src/build-graphql-explorer.js [--corpus <dir>] [--out <file>] [--xlink <href>]
 *
 * --xlink is the href of the companion REST explorer (default:
 * sn-api-explorer.html for local use; the Pages workflow passes ./).
 */

const fs = require('fs');
const path = require('path');
const { typeRef } = require('./graphql-sdl');

function parseArgs(argv) {
  const opts = { corpus: 'graphql', out: 'sn-graphql-explorer.html', xlink: 'sn-api-explorer.html' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus') opts.corpus = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--xlink') opts.xlink = argv[++i];
    else throw new Error('Unknown argument: ' + argv[i]);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Corpus -> compact client model
// ---------------------------------------------------------------------------

function namedType(ref) {
  while (ref && !ref.name) ref = ref.ofType;
  return ref ? ref.name : null;
}

const KIND_LETTER = {
  OBJECT: 'O', INPUT_OBJECT: 'I', ENUM: 'E', INTERFACE: 'N', UNION: 'U', SCALAR: 'S',
};

function compactArg(a) {
  const out = { n: a.name, t: typeRef(a.type), b: namedType(a.type) };
  if (a.description) out.d = a.description;
  if (a.defaultValue !== null && a.defaultValue !== undefined) out.dv = a.defaultValue;
  return out;
}

function compactField(f) {
  const out = { n: f.name, t: typeRef(f.type), b: namedType(f.type) };
  if (f.description) out.d = f.description;
  if (f.args && f.args.length) out.a = f.args.map(compactArg);
  return out;
}

function compactType(t) {
  const out = { k: KIND_LETTER[t.kind] || 'S' };
  if (t.description) out.d = t.description;
  if (t.fields && t.fields.length) out.f = t.fields.map(compactField);
  if (t.inputFields && t.inputFields.length) out.f = t.inputFields.map(compactField);
  if (t.enumValues && t.enumValues.length) {
    out.vs = t.enumValues.map((v) => (v.description ? { n: v.name, d: v.description } : { n: v.name }));
  }
  if (t.interfaces && t.interfaces.length) out.i = t.interfaces.map(namedType);
  if (t.possibleTypes && t.possibleTypes.length) out.p = t.possibleTypes.map(namedType);
  return out;
}

function loadCorpus(corpusDir) {
  const files = fs.readdirSync(corpusDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();

  const namespaces = files.map((file) => {
    const doc = JSON.parse(fs.readFileSync(path.join(corpusDir, file), 'utf8'));
    const types = {};
    for (const t of doc.types) types[t.name] = compactType(t);
    return { ns: doc.namespace, roots: doc.roots, types };
  });

  let glide = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(corpusDir, '_gliderecord.json'), 'utf8'));
    const framework = {};
    for (const t of raw.frameworkTypes) framework[t.name] = compactType(t);
    // Ship table names + column counts only. The full typed column lists
    // (~350k entries) live in _gliderecord.json — embedding them here would
    // triple the page for data the detail pane can point at instead.
    const tables = {};
    for (const [name, cols] of Object.entries(raw.tables)) tables[name] = cols.length;
    glide = {
      queryArgs: raw.queryArgs.map(compactArg),
      aggregateArgs: raw.aggregateArgs.map(compactArg),
      tableMetaFields: raw.tableMetaFields,
      referenceFieldMeta: raw.referenceFieldMeta,
      framework,
      tables,
      noMut: raw.tablesWithoutMutations,
    };
  } catch { /* optional */ }

  let summary = {};
  try { summary = JSON.parse(fs.readFileSync(path.join(corpusDir, '_summary.json'), 'utf8')); } catch { /* optional */ }

  return { namespaces, glide, summary };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpusDir = path.resolve(process.cwd(), opts.corpus);
  const outFile = path.resolve(process.cwd(), opts.out);

  const { namespaces, glide, summary } = loadCorpus(corpusDir);

  let schemaCount = 0;
  const typeNames = new Set();
  for (const e of namespaces) {
    for (const root of Object.values(e.roots)) schemaCount += root.fields.length;
    for (const n of Object.keys(e.types)) typeNames.add(n);
  }
  const tableCount = glide ? Object.keys(glide.tables).length : 0;

  const meta = {
    instance: summary.instance || '',
    generatedAt: summary.generatedAt || '',
    builtAt: new Date().toISOString(),
    nsCount: namespaces.length,
    schemaCount,
    typeCount: typeNames.size,
    tableCount,
    xlink: opts.xlink,
  };

  const payload = JSON.stringify({ meta, namespaces, glide }).replace(/</g, '\\u003c');
  const html = TEMPLATE.replace('"__PAYLOAD__"', () => payload);
  fs.writeFileSync(outFile, html);

  const kb = Math.round(fs.statSync(outFile).size / 1024);
  process.stdout.write(
    'Built ' + path.basename(outFile) + ' — ' + meta.nsCount + ' namespaces, ' +
    meta.schemaCount + ' schemas, ' + meta.tableCount + ' tables, ' + kb + ' KB\n'
  );
}

// ---------------------------------------------------------------------------
// Page template. Same construction rules as build-explorer.js: the page script
// avoids backticks and ${}, all data rendering goes through the DOM API
// (createElement/textContent), never innerHTML.
// ---------------------------------------------------------------------------

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ServiceNow GraphQL Explorer</title>
<style>
  :root {
    --bg: oklch(1 0 0);
    --panel: oklch(0.974 0.005 335);
    --panel-2: oklch(0.955 0.008 335);
    --line: oklch(0.906 0.008 335);
    --line-soft: oklch(0.936 0.006 335);
    --ink: oklch(0.24 0.012 335);
    --ink-2: oklch(0.42 0.016 335);
    --ink-3: oklch(0.52 0.02 335);
    --accent: oklch(0.5 0.132 335);
    --accent-deep: oklch(0.4 0.114 335);
    --accent-wash: oklch(0.962 0.03 335);
    --accent-wash-2: oklch(0.93 0.055 335);
    --mark: oklch(0.93 0.088 108);
    --m-query: oklch(0.46 0.1 250);
    --m-mutation: oklch(0.47 0.13 25);
    --m-subscription: oklch(0.46 0.1 300);
    --m-table: oklch(0.47 0.104 150);
    --shadow-md: 0 1px 2px oklch(0.24 0.012 335 / 0.06), 0 4px 16px oklch(0.24 0.012 335 / 0.07);
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
  .xlink { color: var(--accent-deep); font-size: 0.75rem; font-weight: 600; text-decoration: none; white-space: nowrap; }
  .xlink:hover { text-decoration: underline; }
  .searchwrap { flex: 1; display: flex; align-items: center; position: relative; max-width: 44rem; }
  #q {
    width: 100%; font: inherit; font-size: 0.9375rem; color: var(--ink);
    padding: 0.5rem 4.25rem 0.5rem 2.35rem; border: 1px solid var(--line);
    border-radius: 8px; background: var(--panel);
  }
  #q::placeholder { color: oklch(0.5 0.018 335); }
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
  .chip[aria-pressed="true"].m-QUERY { color: var(--m-query); }
  .chip[aria-pressed="true"].m-MUTATION { color: var(--m-mutation); }
  .chip[aria-pressed="true"].m-SUBSCRIPTION { color: var(--m-subscription); }
  .chip[aria-pressed="true"].m-TABLE { color: var(--m-table); }

  /* ---------- Namespace rail ---------- */
  .rail { border-right: 1px solid var(--line); background: var(--panel); overflow-y: auto; padding: 0.75rem 0.5rem 1.5rem; }
  .rail-head {
    display: flex; align-items: baseline; gap: 0.35rem;
    font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink-3); padding: 0.25rem 0.75rem 0.5rem;
  }
  .rail-legend { margin-left: auto; font-weight: 400; letter-spacing: 0.02em; text-transform: none; white-space: nowrap; }
  #ns-q {
    width: 100%; font: inherit; font-size: 0.8125rem; color: var(--ink);
    padding: 0.32rem 0.75rem; margin: 0 0 0.5rem; border: 1px solid var(--line);
    border-radius: 6px; background: var(--bg);
  }
  #ns-q::placeholder { color: oklch(0.5 0.018 335); }
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
    display: grid; grid-template-columns: 5.2rem 1fr; gap: 0.65rem; align-items: baseline;
    width: 100%; text-align: left; padding: 0.42rem 1.25rem;
    transition: background 120ms ease-out;
  }
  .row:hover { background: var(--panel); }
  .row[aria-selected="true"] { background: var(--accent-wash); box-shadow: inset 2px 0 0 var(--accent); }
  .row .method { font-size: 0.625rem; font-weight: 700; letter-spacing: 0.05em; text-align: right; }
  .m-QUERY { color: var(--m-query); } .m-MUTATION { color: var(--m-mutation); }
  .m-SUBSCRIPTION { color: var(--m-subscription); } .m-TABLE { color: var(--m-table); }
  .row .path { font-weight: 550; overflow-wrap: anywhere; }
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
  .op-title { display: flex; align-items: baseline; gap: 0.7rem; margin: 0 0 0.25rem; }
  .op-title .method { font-size: 0.8125rem; font-weight: 700; letter-spacing: 0.05em; }
  h1.path { font-size: 1.25rem; line-height: 1.3; font-weight: 700; letter-spacing: -0.015em;
    margin: 0; overflow-wrap: anywhere; text-wrap: balance; }
  h1.path .ph { color: var(--accent-deep); font-weight: 500; }
  .op-desc { color: var(--ink-2); margin: 0.5rem 0 0; max-width: 65ch; }
  .actions { display: flex; gap: 0.5rem; margin: 1.1rem 0 0; flex-wrap: wrap; }
  .btn {
    font-size: 0.8125rem; font-weight: 600; padding: 0.42rem 0.8rem; border-radius: 7px;
    border: 1px solid var(--line); color: var(--ink-2); background: var(--bg);
    transition: background 150ms ease-out, border-color 150ms ease-out;
  }
  .btn:hover { background: var(--panel); border-color: var(--line); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: oklch(0.99 0.01 335); }
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
  .params td.pname { font-weight: 600; overflow-wrap: anywhere; }
  .params td.pin { color: var(--ink-3); font-size: 0.75rem; white-space: nowrap; }
  .params td.preq { font-size: 0.75rem; color: var(--accent-deep); font-weight: 600; white-space: nowrap; }
  .params td.pdesc { color: var(--ink-2); font-size: 0.8125rem; max-width: 34ch; }
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
  .cols-wrap { color: var(--ink-2); font-size: 0.8125rem; line-height: 1.7; overflow-wrap: anywhere; }
  .cols-wrap .colname { display: inline-block; background: var(--panel); border: 1px solid var(--line-soft);
    border-radius: 5px; padding: 0 0.4rem; margin: 0.1rem 0.15rem 0.1rem 0; }
  .type-sec { margin-top: 1.4rem; }
  .type-sec h3 { font-size: 0.8125rem; font-weight: 700; margin: 0 0 0.4rem; display: flex; gap: 0.5rem; align-items: baseline; overflow-wrap: anywhere; }
  .type-kind { font-size: 0.625rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
    color: var(--ink-3); border: 1px solid var(--line); border-radius: 4px; padding: 0.02rem 0.35rem; }
  .api-about { border-top: 1px solid var(--line); margin-top: 2.25rem; padding-top: 1.5rem; }
  .api-about .desc { color: var(--ink-2); max-width: 65ch; margin: 0.3rem 0 0.9rem; }
  .meta-line { color: var(--ink-3); font-size: 0.75rem; margin-bottom: 1rem; }
  .meta-line a { color: var(--accent-deep); }
  .sibling {
    display: grid; grid-template-columns: 5.2rem 1fr; gap: 0.65rem; align-items: baseline;
    width: 100%; text-align: left; padding: 0.3rem 0.5rem; border-radius: 6px; margin-left: -0.5rem;
    transition: background 120ms ease-out;
  }
  .sibling:hover { background: var(--panel); }
  .sibling .method { font-size: 0.625rem; font-weight: 700; letter-spacing: 0.05em; text-align: right; }
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
    /* Let the title + meta + cross/repo links wrap instead of overflowing the
       right edge on narrow screens (otherwise the links run off-screen). */
    .brand { flex-wrap: wrap; white-space: normal; row-gap: 0.15rem; }
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
    <div class="brand"><span class="dot" aria-hidden="true"></span><strong>SN GraphQL Explorer</strong><span class="brand-meta" id="brand-meta"></span><a class="xlink" id="xlink">REST explorer →</a><a class="xlink repo" href="https://github.com/tehubersheezy/servicenow-tools" target="_blank" rel="noopener">GitHub ↗</a></div>
    <div class="searchwrap">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="text" role="combobox" aria-expanded="true" aria-controls="results"
             aria-autocomplete="list" aria-label="Search schemas and tables" autocomplete="off" spellcheck="false" autofocus>
      <span class="hint" id="hint" aria-hidden="true">/</span>
    </div>
    <div class="chips" role="group" aria-label="Filter by kind" id="chips"></div>
  </header>
  <div class="app">
    <nav class="rail" aria-label="Namespaces">
      <div class="rail-head">Namespaces <span id="ns-count"></span><span class="rail-legend">operations</span></div>
      <input id="ns-q" type="text" aria-label="Filter namespaces" placeholder="Filter namespaces" autocomplete="off" spellcheck="false">
      <ul id="ns-list"></ul>
    </nav>
    <main class="results-col">
      <div class="results-meta"><span id="count" aria-live="polite"></span><button id="clear-filters" hidden>Clear filters</button></div>
      <div id="results" role="listbox" aria-label="Operations" tabindex="-1"></div>
    </main>
    <aside class="detail" id="detail" aria-label="Operation detail"><div class="detail-inner" id="detail-inner"></div></aside>
  </div>
</div>
<script>
var DATA = "__PAYLOAD__";
</script>
<script>
(function () {
  'use strict';

  var META = DATA.meta;
  var GLIDE = DATA.glide;
  var KIND_LABEL = { query: 'QUERY', mutation: 'MUTATION', subscription: 'SUBSCRIPTION' };

  // ---------- Model ----------
  // Scripted rows: one per schema (root field) per kind. Table rows: one per
  // GlideRecord table.
  var ops = [];
  var nsEntries = [];

  DATA.namespaces.forEach(function (entry) {
    entry.ops = [];
    nsEntries.push(entry);
    Object.keys(entry.roots).forEach(function (kind) {
      var root = entry.roots[kind];
      var container = entry.types[root.type];
      root.fields.forEach(function (fieldName) {
        var field = null;
        if (container && container.f) {
          for (var i = 0; i < container.f.length; i++) {
            if (container.f[i].n === fieldName) { field = container.f[i]; break; }
          }
        }
        var op = {
          id: ops.length,
          ns: entry.ns,
          entry: entry,
          kind: KIND_LABEL[kind] || kind.toUpperCase(),
          gqlKind: kind,
          name: fieldName,
          field: field,
          rootType: field ? field.b : null,
          desc: (field && field.d) || '',
          hay: null
        };
        entry.ops.push(op);
        ops.push(op);
      });
    });
  });

  // Haystack per scripted op: every type/field/arg name reachable from its
  // root type, so a search for a deeply nested field still surfaces the schema.
  function buildHay(op) {
    var parts = [op.kind, op.name, op.ns, op.desc];
    if (!op.rootType) return parts.join(' ').toLowerCase();
    var seen = {};
    var stack = [op.rootType];
    while (stack.length) {
      var name = stack.pop();
      if (!name || seen[name]) continue;
      seen[name] = 1;
      var t = op.entry.types[name];
      if (!t) continue;
      parts.push(name);
      if (t.d) parts.push(t.d);
      (t.f || []).forEach(function (f) {
        parts.push(f.n);
        if (f.d) parts.push(f.d);
        (f.a || []).forEach(function (a) { parts.push(a.n); });
        stack.push(f.b);
      });
      (t.vs || []).forEach(function (v) { parts.push(v.n); });
      (t.p || []).forEach(function (p) { stack.push(p); });
      (t.i || []).forEach(function (i) { stack.push(i); });
    }
    return parts.join(' ').toLowerCase();
  }
  ops.forEach(function (op) { op.hay = buildHay(op); });

  // Tables ship as name -> column count. The typed column lists (choice /
  // journal / reference-target codes) live in graphql/_gliderecord.json —
  // deliberately not embedded, so search matches table names, not columns.
  var tables = [];
  if (GLIDE) {
    Object.keys(GLIDE.tables).forEach(function (name) {
      var op = {
        id: ops.length + tables.length,
        ns: 'GlideRecord',
        kind: 'TABLE',
        name: name,
        colCount: GLIDE.tables[name],
        desc: GLIDE.tables[name] + ' columns',
        hay: ('table ' + name).toLowerCase()
      };
      tables.push(op);
    });
  }

  var KINDS = [];
  ['QUERY', 'MUTATION', 'SUBSCRIPTION'].forEach(function (k) {
    if (ops.some(function (o) { return o.kind === k; })) KINDS.push(k);
  });
  if (tables.length) KINDS.push('TABLE');

  // Rail: GlideRecord (if present) plus scripted namespaces, biggest first.
  var railEntries = [];
  nsEntries.forEach(function (e) { railEntries.push({ ns: e.ns, count: e.ops.length }); });
  railEntries.sort(function (a, b) { return b.count - a.count || a.ns.localeCompare(b.ns); });
  if (tables.length) railEntries.unshift({ ns: 'GlideRecord', count: tables.length });

  var nsRank = {};
  railEntries.forEach(function (e, i) { nsRank[e.ns] = i; });

  var allRows = ops.concat(tables);
  allRows.sort(function (a, b) {
    return nsRank[a.ns] - nsRank[b.ns] || a.name.localeCompare(b.name);
  });

  // ---------- State ----------
  var state = { q: '', ns: null, kinds: {}, sel: null, visible: [], expanded: {}, qCollapsed: {} };
  var RENDER_CAP = 600;

  function isExpanded(ns) {
    return tokenize(state.q).length ? !state.qCollapsed[ns] : !!state.expanded[ns];
  }
  function toggleGroup(ns) {
    if (tokenize(state.q).length) {
      if (state.qCollapsed[ns]) delete state.qCollapsed[ns];
      else state.qCollapsed[ns] = true;
    } else {
      if (state.expanded[ns]) delete state.expanded[ns];
      else state.expanded[ns] = true;
    }
    renderResults();
  }
  function ensureExpanded(ns) {
    var changed = false;
    if (tokenize(state.q).length) {
      if (state.qCollapsed[ns]) { delete state.qCollapsed[ns]; changed = true; }
    } else if (!state.expanded[ns]) { state.expanded[ns] = true; changed = true; }
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

  function score(row, tokens) {
    var total = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (row.hay.indexOf(t) === -1) return -1;
      var s = 0;
      var nl = row.name.toLowerCase();
      var at = nl.indexOf(t);
      if (nl === t) s = 9;
      else if (at !== -1) s = (at === 0 || nl[at - 1] === '_') ? 6 : 4;
      else if (row.ns.toLowerCase().indexOf(t) !== -1) s = 3;
      else s = 1;
      total += s;
    }
    return total;
  }

  function currentMatches() {
    var tokens = tokenize(state.q);
    var anyKind = KINDS.some(function (k) { return state.kinds[k]; });
    var list = [];
    for (var i = 0; i < allRows.length; i++) {
      var o = allRows[i];
      if (state.ns && o.ns !== state.ns) continue;
      if (anyKind && !state.kinds[o.kind]) continue;
      if (tokens.length) {
        var s = score(o, tokens);
        if (s < 0) continue;
        list.push({ op: o, s: s });
      } else {
        list.push({ op: o, s: 0 });
      }
    }
    if (tokens.length) {
      var best = {};
      list.forEach(function (x) {
        var k = x.op.ns;
        if (!(k in best) || x.s > best[k]) best[k] = x.s;
      });
      list.sort(function (a, b) {
        return best[b.op.ns] - best[a.op.ns] ||
          nsRank[a.op.ns] - nsRank[b.op.ns] ||
          b.s - a.s ||
          a.op.name.localeCompare(b.op.name);
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

    var groups = [];
    var lastNs = null;
    matches.forEach(function (op) {
      if (op.ns !== lastNs) { lastNs = op.ns; groups.push({ ns: op.ns, ops: [] }); }
      groups[groups.length - 1].ops.push(op);
    });

    state.visible = [];
    var renderedRows = 0, cutRows = 0;

    groups.forEach(function (g) {
      var open = isExpanded(g.ns);
      var gh = el('button', 'group-head');
      gh.setAttribute('aria-expanded', open ? 'true' : 'false');
      gh.appendChild(el('span', 'chev', '\\u25BC'));
      var nameSpan = el('span', 'api');
      markNodes(nameSpan, g.ns, tokens);
      gh.appendChild(nameSpan);
      gh.appendChild(el('span', 'ns', g.ns === 'GlideRecord' ? 'one query field + CRUD mutations per table' : 'scripted schemas'));
      gh.appendChild(el('span', 'gc', fmt(g.ops.length)));
      gh.addEventListener('click', function () { toggleGroup(g.ns); });
      f.appendChild(gh);

      if (!open) return;
      g.ops.forEach(function (op) {
        if (renderedRows >= RENDER_CAP) { cutRows++; return; }
        renderedRows++;
        state.visible.push(op);
        var row = el('button', 'row');
        row.setAttribute('role', 'option');
        row.id = 'op-' + op.kind + '-' + op.ns + '-' + op.name;
        row.setAttribute('aria-selected', state.sel === op ? 'true' : 'false');
        row.appendChild(el('span', 'method m-' + op.kind, op.kind));
        var pathSpan = el('span', 'path');
        markNodes(pathSpan, op.name, tokens);
        row.appendChild(pathSpan);
        var sub = op.desc;
        if (sub) {
          var d = el('span', 'opdesc');
          markNodes(d, sub, tokens);
          row.appendChild(d);
        }
        row.addEventListener('click', function () { select(op, true); });
        f.appendChild(row);
      });
    });

    if (!matches.length) {
      var empty = el('div', 'no-results');
      empty.appendChild(el('strong', null, 'Nothing matches'));
      empty.appendChild(el('span', null, 'Fewer words usually work better — try a table name, a field, or a namespace.'));
      f.appendChild(empty);
    } else if (cutRows) {
      f.appendChild(el('div', 'tail-note', 'Showing the top ' + fmt(renderedRows) + ' of ' + fmt(renderedRows + cutRows) + ' expanded rows — refine to narrow.'));
    }

    resultsEl.textContent = '';
    resultsEl.appendChild(f);

    var scope = [];
    if (state.ns) scope.push(state.ns);
    var kOn = KINDS.filter(function (k) { return state.kinds[k]; });
    if (kOn.length) scope.push(kOn.join(', '));
    countEl.textContent = fmt(matches.length) + (matches.length === 1 ? ' result' : ' results') +
      (scope.length ? ' in ' + scope.join(' · ') : '');
    clearBtn.hidden = !(state.q || state.ns || kOn.length);

    if (state.sel && state.visible.indexOf(state.sel) === -1) {
      input.removeAttribute('aria-activedescendant');
    }
  }

  // ---------- GraphQL codegen ----------
  var SCALAR_PLACEHOLDER = {
    Int: '0', Long: '0', Float: '0.0', Boolean: 'false', ID: '"..."', String: '"..."'
  };

  function placeholder(base, types, depth) {
    var t = types[base];
    if (!t) return SCALAR_PLACEHOLDER[base] || '"..."';
    if (t.k === 'E') return (t.vs && t.vs.length) ? t.vs[0].n : '"..."';
    if (t.k === 'I') {
      if (depth > 1) return '{}';
      var req = (t.f || []).filter(function (f) { return /!$/.test(f.t); }).slice(0, 3);
      if (!req.length) return '{}';
      return '{ ' + req.map(function (f) {
        return f.n + ': ' + placeholder(f.b, types, depth + 1);
      }).join(', ') + ' }';
    }
    if (t.k === 'S') return SCALAR_PLACEHOLDER[base] || '"..."';
    return '"..."';
  }

  function argText(args, types, requiredOnly) {
    var use = (args || []).filter(function (a) { return !requiredOnly || /!$/.test(a.t); });
    if (!use.length) return '';
    return '(' + use.map(function (a) {
      return a.n + ': ' + placeholder(a.b, types, 0);
    }).join(', ') + ')';
  }

  // Build a selection set for a type: scalars first (cap 8), then a few nested
  // objects (cap 3, depth 4), cycle-guarded. Returns array of lines.
  function selectionLines(typeName, types, indent, path) {
    var t = types[typeName];
    var pad = new Array(indent + 1).join('  ');
    if (!t || (t.k !== 'O' && t.k !== 'N' && t.k !== 'U')) return [];
    if (t.k === 'U') {
      var first = (t.p || [])[0];
      if (!first) return [pad + '__typename'];
      var inner = selectionLines(first, types, indent + 1, path.concat([first]));
      return [pad + '__typename', pad + '... on ' + first + ' {'].concat(inner, [pad + '}']);
    }
    var scalars = [], objects = [];
    (t.f || []).forEach(function (f) {
      var ft = types[f.b];
      if (!ft || ft.k === 'S' || ft.k === 'E') scalars.push(f);
      else if ((ft.k === 'O' || ft.k === 'N' || ft.k === 'U') && path.indexOf(f.b) === -1) objects.push(f);
    });
    var lines = [];
    scalars.slice(0, 8).forEach(function (f) {
      lines.push(pad + f.n + argText(f.a, types, true));
    });
    if (path.length < 4) {
      objects.slice(0, 3).forEach(function (f) {
        var inner = selectionLines(f.b, types, indent + 1, path.concat([f.b]));
        if (!inner.length) inner = [pad + '  __typename'];
        lines.push(pad + f.n + argText(f.a, types, true) + ' {');
        lines = lines.concat(inner);
        lines.push(pad + '}');
      });
    }
    if (!lines.length) lines.push(pad + '__typename');
    return lines;
  }

  function buildOpQuery(op) {
    var types = op.entry.types;
    var kw = op.gqlKind === 'mutation' ? 'mutation' : op.gqlKind === 'subscription' ? 'subscription' : 'query';
    var lines = [kw + ' {', '  ' + op.ns + ' {'];
    var inner = selectionLines(op.rootType, types, 3, [op.rootType]);
    if (!inner.length) inner = ['      __typename'];
    lines.push('    ' + op.name + (op.field ? argText(op.field.a, types, true) : '') + ' {');
    lines = lines.concat(inner);
    lines.push('    }', '  }', '}');
    return lines.join('\\n');
  }

  // ---- Table (GlideRecord) codegen ----
  // Column lists are not embedded (see the tables comment above), so samples
  // use field_name as the stand-in selection.
  function tableQuery(tb) {
    return ['query {', '  GlideRecord_Query {',
      '    ' + tb.name + '(queryConditions: "ORDERBYDESCsys_updated_on", pagination: { limit: 5 }) {',
      '      _rowCount', '      _results {', '        sys_id { value }',
      '        field_name { value displayValue }   # one block per column you want',
      '      }', '    }', '  }', '}'].join('\\n');
  }

  function tableGetQuery(tb) {
    return ['query {', '  GlideRecord_Query {',
      '    ' + tb.name + '(sys_id: "...") {', '      _results {', '        sys_id { value }',
      '        field_name { value displayValue }',
      '      }', '    }', '  }', '}'].join('\\n');
  }

  function tableSchemaQuery(tb) {
    return ['query {', '  GlideRecord_Query {',
      '    ' + tb.name + '(pagination: { limit: 1 }) {',
      '      _table_metadata { label plural canRead canWrite canCreate canDelete auditWanted }',
      '      _results {',
      '        field_name {',
      '          label', '          internalType', '          isMandatory', '          canWrite',
      '          _choices { value displayValue }   # choice columns only',
      '        }',
      '      }', '    }', '  }', '}'].join('\\n');
  }

  function tableAggregate(tb) {
    var groupCol = 'field_name';
    return ['query {',
      '  GlideAggregateRecord_Query(tableName: "' + tb.name + '", groupBy: ["' + groupCol + '"]) {',
      '    totalCount', '    totalGroupsCount', '    aggregates {', '      count',
      '      groupBy { field value displayValue }',
      '    }', '  }', '}'].join('\\n');
  }

  function tableMutation(tb, verb) {
    var lines = ['mutation {', '  GlideRecord_Mutation {'];
    if (verb === 'delete') {
      lines.push('    delete_' + tb.name + '(sys_id: "...") {');
      var del = selectionLines('GlideRecord_DeleteMutationOutputType', GLIDE.framework, 3, ['GlideRecord_DeleteMutationOutputType']);
      lines = lines.concat(del.length ? del : ['      __typename']);
    } else {
      var args = verb === 'update' ? '(sys_id: "...", field_name: "...")' : '(field_name: "...")';
      lines.push('    ' + verb + '_' + tb.name + args + ' {');
      lines.push('      sys_id { value }');
    }
    lines.push('    }', '  }', '}');
    return lines.join('\\n');
  }

  function buildCurl(queryText) {
    var base = META.instance || 'https://INSTANCE.service-now.com';
    var body = JSON.stringify({ query: queryText.replace(/\\s+/g, ' ').trim() });
    return ['curl -u "$SN_USERNAME:$SN_PASSWORD" \\\\',
      '  -X POST \\\\',
      '  -H "Content-Type: application/json" \\\\',
      '  -H "Accept: application/json" \\\\',
      '  -d \\'' + body.replace(/'/g, "'\\\\''") + '\\' \\\\',
      '  "' + base + '/api/now/graphql"'].join('\\n');
  }

  // ---------- Client-side SDL ----------
  var KIND_KEYWORD = { O: 'type', I: 'input', E: 'enum', N: 'interface', U: 'union', S: 'scalar' };
  var BUILTIN = { String: 1, Int: 1, Float: 1, Boolean: 1, ID: 1 };

  function sdlForNamespace(entry) {
    var rootNames = Object.keys(entry.roots).map(function (k) { return entry.roots[k].type; });
    var names = Object.keys(entry.types).sort(function (a, b) {
      var ra = rootNames.indexOf(a), rb = rootNames.indexOf(b);
      ra = ra === -1 ? 999 : ra; rb = rb === -1 ? 999 : rb;
      return ra - rb || a.localeCompare(b);
    });
    var out = [];
    names.forEach(function (name) {
      var t = entry.types[name];
      if (BUILTIN[name] && t.k === 'S') return;
      var kw = KIND_KEYWORD[t.k];
      if (!kw) return;
      if (t.k === 'S') { out.push('scalar ' + name + '\\n'); return; }
      if (t.k === 'U') { out.push('union ' + name + ' = ' + (t.p || []).join(' | ') + '\\n'); return; }
      var head = kw + ' ' + name;
      if (t.i && t.i.length) head += ' implements ' + t.i.join(' & ');
      var lines = [head + ' {'];
      if (t.k === 'E') {
        (t.vs || []).forEach(function (v) { lines.push('  ' + v.n); });
      } else {
        (t.f || []).forEach(function (f) {
          var args = '';
          if (f.a && f.a.length) {
            args = '(' + f.a.map(function (a) {
              return a.n + ': ' + a.t + (a.dv !== undefined ? ' = ' + a.dv : '');
            }).join(', ') + ')';
          }
          lines.push('  ' + f.n + args + ': ' + f.t);
        });
      }
      lines.push('}\\n');
      out.push(lines.join('\\n'));
    });
    return out.join('\\n');
  }

  // ---------- Selection & detail ----------
  var detailEl = document.getElementById('detail');
  var detailInner = document.getElementById('detail-inner');
  var input = document.getElementById('q');

  function select(op, fromClick) {
    state.sel = op;
    if (ensureExpanded(op.ns)) renderResults();
    var prev = resultsEl.querySelector('[aria-selected="true"]');
    if (prev) prev.setAttribute('aria-selected', 'false');
    var row = document.getElementById('op-' + op.kind + '-' + op.ns + '-' + op.name);
    if (row) {
      row.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    }
    if (op.kind === 'TABLE') renderTableDetail(op); else renderOpDetail(op);
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

  function snippetBlock(title, sub, text) {
    var sec = el('section', 'block');
    var h2 = el('h2', null, title + ' ');
    if (sub) h2.appendChild(el('span', 'sub', sub));
    sec.appendChild(h2);
    var box = el('div', 'curl');
    box.appendChild(document.createTextNode(text));
    box.appendChild(copyButton('Copy', function () { return text; }, 'copy-mini'));
    sec.appendChild(box);
    return sec;
  }

  function argsTable(args) {
    var table = el('table', 'params');
    var thead = el('thead');
    var hr = el('tr');
    ['Name', 'Type', '', 'Description'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    args.forEach(function (a) {
      var tr = el('tr');
      tr.appendChild(el('td', 'pname', a.n));
      tr.appendChild(el('td', 'pin', a.t));
      tr.appendChild(el('td', 'preq', /!$/.test(a.t) ? 'required' : ''));
      tr.appendChild(el('td', 'pdesc', a.d || ''));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function backButton() {
    var back = el('button', 'detail-back', '← Back to results');
    back.addEventListener('click', function () { detailEl.classList.remove('open'); });
    return back;
  }

  function sourceLine(parts) {
    var metaLine = el('p', 'meta-line');
    metaLine.appendChild(document.createTextNode('Source '));
    parts.forEach(function (p, i) {
      if (i) metaLine.appendChild(document.createTextNode(' · '));
      var a = el('a', null, p);
      a.href = 'graphql/' + p;
      a.target = '_blank'; a.rel = 'noopener';
      metaLine.appendChild(a);
    });
    metaLine.appendChild(document.createTextNode(' · endpoint POST /api/now/graphql'));
    return metaLine;
  }

  // Reachable named types from a root, BFS order, for the type browser.
  function reachableTypes(rootName, types) {
    var seen = {};
    var order = [];
    var queue = [rootName];
    while (queue.length) {
      var name = queue.shift();
      if (!name || seen[name]) continue;
      seen[name] = 1;
      var t = types[name];
      if (!t) continue;
      if (!BUILTIN[name] || t.k !== 'S') order.push(name);
      (t.f || []).forEach(function (f) {
        queue.push(f.b);
        (f.a || []).forEach(function (a) { queue.push(a.b); });
      });
      (t.p || []).forEach(function (p) { queue.push(p); });
      (t.i || []).forEach(function (i) { queue.push(i); });
    }
    return order;
  }

  var KIND_NAME = { O: 'type', I: 'input', E: 'enum', N: 'interface', U: 'union', S: 'scalar' };

  function typeSection(name, t) {
    var sec = el('div', 'type-sec');
    var h3 = el('h3');
    h3.appendChild(el('span', null, name));
    h3.appendChild(el('span', 'type-kind', KIND_NAME[t.k] || t.k));
    sec.appendChild(h3);
    if (t.d) sec.appendChild(el('p', 'op-desc', t.d));
    if (t.k === 'E') {
      sec.appendChild(el('p', 'cols-wrap', (t.vs || []).map(function (v) { return v.n; }).join(' · ')));
      return sec;
    }
    if (t.k === 'U') {
      sec.appendChild(el('p', 'cols-wrap', (t.p || []).join(' · ')));
      return sec;
    }
    if (!t.f || !t.f.length) return sec;
    var table = el('table', 'params');
    var tbody = el('tbody');
    t.f.forEach(function (f) {
      var tr = el('tr');
      var sig = f.n;
      if (f.a && f.a.length) {
        sig += '(' + f.a.map(function (a) { return a.n + ': ' + a.t; }).join(', ') + ')';
      }
      tr.appendChild(el('td', 'pname', sig));
      tr.appendChild(el('td', 'pin', f.t));
      tr.appendChild(el('td', 'pdesc', f.d || ''));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    sec.appendChild(table);
    return sec;
  }

  function renderOpDetail(op) {
    var inner = el('div', 'fade-in');
    inner.appendChild(backButton());

    var crumb = el('div', 'crumb');
    crumb.appendChild(el('span', null, op.ns));
    crumb.appendChild(el('span', 'sep', '/'));
    crumb.appendChild(el('span', null, op.gqlKind));
    inner.appendChild(crumb);

    var title = el('div', 'op-title');
    title.appendChild(el('span', 'method m-' + op.kind, op.kind));
    var h1 = el('h1', 'path');
    h1.appendChild(document.createTextNode(op.ns + ' { '));
    h1.appendChild(el('span', 'ph', op.name));
    h1.appendChild(document.createTextNode(' }'));
    title.appendChild(h1);
    inner.appendChild(title);

    if (op.desc) inner.appendChild(el('p', 'op-desc', op.desc));

    var rootT = op.entry.types[op.rootType];
    if (!rootT || !rootT.f || !rootT.f.length) {
      inner.appendChild(el('p', 'op-desc',
        'This schema introspects as an empty type on this instance — the platform publishes no fields for it ' +
        '(typically a scope-protected scripted schema). The sample below is still a valid request.'));
    }

    var query = buildOpQuery(op);
    var actions = el('div', 'actions');
    actions.appendChild(copyButton('Copy query', function () { return query; }, 'btn primary'));
    actions.appendChild(copyButton('Copy curl', function () { return buildCurl(query); }));
    inner.appendChild(actions);

    if (op.field && op.field.a && op.field.a.length) {
      var argSec = el('section', 'block');
      var ah = el('h2', null, 'Arguments ');
      ah.appendChild(el('span', 'sub', String(op.field.a.length)));
      argSec.appendChild(ah);
      argSec.appendChild(argsTable(op.field.a));
      inner.appendChild(argSec);
    }

    inner.appendChild(snippetBlock('Sample query', 'a starting selection — the type browser below has the full shape', query));
    inner.appendChild(snippetBlock('Request', null, buildCurl(query)));

    var reach = reachableTypes(op.rootType, op.entry.types);
    var typeSec = el('section', 'block');
    var th = el('h2', null, 'Types ');
    th.appendChild(el('span', 'sub', fmt(reach.length) + ' reachable from this schema'));
    typeSec.appendChild(th);
    var CAP = 30;
    reach.slice(0, CAP).forEach(function (name) {
      typeSec.appendChild(typeSection(name, op.entry.types[name]));
    });
    if (reach.length > CAP) {
      typeSec.appendChild(el('p', 'meta-line', (reach.length - CAP) + ' more — see the namespace SDL below.'));
    }
    inner.appendChild(typeSec);

    var about = el('section', 'api-about');
    var ah2 = el('h2', null, op.ns + ' ');
    ah2.appendChild(el('span', 'sub', fmt(op.entry.ops.length) + (op.entry.ops.length === 1 ? ' operation' : ' operations')));
    ah2.style.fontSize = '0.9375rem'; ah2.style.margin = '0 0 0.6rem';
    about.appendChild(ah2);
    about.appendChild(sourceLine([op.ns + '.json', op.ns + '.graphql']));
    op.entry.ops.forEach(function (sib) {
      var b = el('button', 'sibling');
      if (sib === op) b.setAttribute('data-current', '1');
      b.appendChild(el('span', 'method m-' + sib.kind, sib.kind));
      b.appendChild(el('span', 'path', sib.name));
      b.addEventListener('click', function () { select(sib, false); });
      about.appendChild(b);
    });
    inner.appendChild(about);

    var raw = el('details', 'raw');
    raw.appendChild(el('summary', null, 'Namespace SDL'));
    var rawBody = el('div', 'raw-body');
    raw.appendChild(rawBody);
    raw.addEventListener('toggle', function () {
      if (raw.open && !rawBody.firstChild) {
        var sdl = sdlForNamespace(op.entry);
        rawBody.appendChild(copyButton('Copy', function () { return sdl; }, 'copy-mini'));
        rawBody.appendChild(el('div', 'raw-json', sdl));
      }
    });
    inner.appendChild(raw);

    detailInner.textContent = '';
    detailInner.appendChild(inner);
    detailEl.scrollTop = 0;
  }

  function renderTableDetail(tb) {
    var inner = el('div', 'fade-in');
    inner.appendChild(backButton());

    var crumb = el('div', 'crumb');
    crumb.appendChild(el('span', null, 'GlideRecord'));
    crumb.appendChild(el('span', 'sep', '/'));
    crumb.appendChild(el('span', null, 'table'));
    inner.appendChild(crumb);

    var title = el('div', 'op-title');
    title.appendChild(el('span', 'method m-TABLE', 'TABLE'));
    title.appendChild(el('h1', 'path', tb.name));
    inner.appendChild(title);

    var hasMut = GLIDE.noMut.indexOf(tb.name) === -1;
    inner.appendChild(el('p', 'op-desc', tb.colCount + ' columns · query via GlideRecord_Query.' + tb.name +
      (hasMut ? ' · mutations insert_/update_/delete_' + tb.name : ' · no mutations exposed') +
      '. Every column is a typed wrapper — select { value displayValue } plus dictionary metadata ' +
      '(label, internalType, isMandatory, canRead/canWrite). Choice columns add _choices, reference columns ' +
      'add _reference to dot-walk, and _table_metadata answers table-level ACLs for the calling user.'));

    var query = tableQuery(tb);
    var actions = el('div', 'actions');
    actions.appendChild(copyButton('Copy query', function () { return query; }, 'btn primary'));
    actions.appendChild(copyButton('Copy curl', function () { return buildCurl(query); }));
    inner.appendChild(actions);

    var qa = el('section', 'block');
    var qh = el('h2', null, 'Query arguments');
    qa.appendChild(qh);
    qa.appendChild(argsTable(GLIDE.queryArgs));
    inner.appendChild(qa);

    inner.appendChild(snippetBlock('Query records', 'encoded query + pagination', query));
    inner.appendChild(snippetBlock('Get by sys_id', null, tableGetQuery(tb)));
    inner.appendChild(snippetBlock('Schema discovery', 'labels, ACL verdicts, choice lists — needs \\u2265 1 readable row', tableSchemaQuery(tb)));
    inner.appendChild(snippetBlock('Aggregate', 'count by group — also avg/min/max/sum(field: "...")', tableAggregate(tb)));
    if (hasMut) {
      inner.appendChild(snippetBlock('Insert', 'one String argument per column', tableMutation(tb, 'insert')));
      inner.appendChild(snippetBlock('Update', null, tableMutation(tb, 'update')));
      inner.appendChild(snippetBlock('Delete', null, tableMutation(tb, 'delete')));
    }
    inner.appendChild(snippetBlock('Request', null, buildCurl(query)));

    var colSec = el('section', 'block');
    var ch = el('h2', null, 'Columns ');
    ch.appendChild(el('span', 'sub', String(tb.colCount)));
    colSec.appendChild(ch);
    colSec.appendChild(el('p', 'cols-wrap', 'Column lists aren\\u2019t embedded in this page (6,000+ tables would triple it). ' +
      'The typed list — which columns are choices, journals, or references and their targets — is in ' +
      'graphql/_gliderecord.json (see its columnEncoding legend), or ask the instance directly with the Schema discovery query above.'));
    inner.appendChild(colSec);

    var fw = el('section', 'block');
    fw.appendChild(el('h2', null, 'Field wrappers'));
    fw.appendChild(el('p', 'cols-wrap', 'Every column is an object carrying its value and dictionary metadata. On all columns: ' +
      (GLIDE.framework.GlideRecord_FieldType_String ? GLIDE.framework.GlideRecord_FieldType_String.f.map(function (f) { return f.n; }).join(' · ') : 'value · displayValue') + '.'));
    if (GLIDE.framework.GlideRecord_ChoiceListFieldType) {
      fw.appendChild(el('p', 'cols-wrap', 'Choice columns additionally: ' +
        GLIDE.framework.GlideRecord_ChoiceListFieldType.f
          .filter(function (f) { return !GLIDE.framework.GlideRecord_FieldType_String || !GLIDE.framework.GlideRecord_FieldType_String.f.some(function (g) { return g.n === f.n; }); })
          .map(function (f) { return f.n; }).join(' · ') +
        ' — _choices { value displayValue } is the live choice list, evaluated in record context.'));
    }
    fw.appendChild(el('p', 'cols-wrap', 'Reference columns add: _reference (the target table\\u2019s record — server-side dot-walk). ' +
      'Journal columns (comments, work_notes) render the full formatted entry stream in displayValue — readable wherever the record is, ' +
      'even when sys_journal_field itself is ACL-blocked. Field metadata hangs off _results rows: an empty result set yields no field-level metadata.'));
    inner.appendChild(fw);

    var about = el('section', 'api-about');
    about.appendChild(sourceLine(['_gliderecord.json']));
    inner.appendChild(about);

    detailInner.textContent = '';
    detailInner.appendChild(inner);
    detailEl.scrollTop = 0;
  }

  function renderWelcome() {
    var inner = el('div', 'welcome fade-in');
    inner.appendChild(el('h1', null, 'The whole GraphQL surface of the instance, one search away'));
    var lede = el('p', 'lede');
    lede.appendChild(document.createTextNode('One endpoint — POST /api/now/graphql — serves '));
    lede.appendChild(el('strong', null, fmt(META.schemaCount) + ' scripted schemas'));
    lede.appendChild(document.createTextNode(' across ' + fmt(META.nsCount) + ' namespaces, plus auto-generated query and CRUD coverage of '));
    lede.appendChild(el('strong', null, fmt(META.tableCount) + ' tables'));
    lede.appendChild(document.createTextNode(', introspected from ' +
      (META.instance ? META.instance.replace('https://', '') : 'the instance') +
      (META.generatedAt ? ' on ' + META.generatedAt.slice(0, 10) : '') +
      '. Search a table, a field, or a schema; every detail pane hands you a runnable query.'));
    inner.appendChild(lede);

    var tries = el('div', 'try');
    ['incident', 'decision', 'sessionUser', 'sys_user', 'catalog', 'aggregate'].forEach(function (t) {
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
    var shown = railEntries.filter(function (e) { return e.ns.toLowerCase().indexOf(nsQuery) !== -1; });
    if (!shown.length) f.appendChild(el('li', 'ns-none', 'No namespaces match'));
    shown.forEach(function (e) {
      var li = el('li');
      var b = el('button', 'ns-btn');
      b.setAttribute('aria-pressed', state.ns === e.ns ? 'true' : 'false');
      b.appendChild(el('span', 'n', e.ns));
      b.appendChild(el('span', 'c', fmt(e.count)));
      b.title = e.ns + ' — ' + fmt(e.count) + (e.count === 1 ? ' operation' : ' operations');
      b.addEventListener('click', function () {
        state.ns = state.ns === e.ns ? null : e.ns;
        renderRail(); renderResults(); writeHash();
      });
      li.appendChild(b);
      f.appendChild(li);
    });
    list.textContent = '';
    list.appendChild(f);
    document.getElementById('ns-count').textContent =
      nsQuery ? shown.length + ' / ' + railEntries.length : railEntries.length;
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
    KINDS.forEach(function (k) {
      var b = el('button', 'chip m-' + k, k);
      b.setAttribute('aria-pressed', state.kinds[k] ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.kinds[k] = !state.kinds[k];
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
    state.q = ''; state.ns = null; state.kinds = {}; state.qCollapsed = {};
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
    var kOn = KINDS.filter(function (k) { return state.kinds[k]; });
    if (kOn.length) parts.push('k=' + kOn.join('.'));
    if (state.sel) {
      parts.push('op=' + encodeURIComponent(state.sel.ns) + ':' + state.sel.kind + ':' + encodeURIComponent(state.sel.name));
    }
    hashLock = true;
    var h = parts.length ? '#' + parts.join('&') : '#';
    if ('replaceState' in history) history.replaceState(null, '', h); else location.hash = h;
    setTimeout(function () { hashLock = false; }, 0);
  }

  function findRow(ns, kind, name) {
    for (var i = 0; i < allRows.length; i++) {
      var r = allRows[i];
      if (r.ns === ns && r.kind === kind && r.name === name) return r;
    }
    return null;
  }

  function readHash() {
    if (!location.hash || location.hash === '#') return false;
    var any = false;
    location.hash.slice(1).split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i === -1) return;
      var k = kv.slice(0, i), v = kv.slice(i + 1);
      if (k === 'q') { state.q = decodeURIComponent(v); input.value = state.q; any = true; }
      else if (k === 'ns') { state.ns = decodeURIComponent(v); any = true; }
      else if (k === 'k') { v.split('.').forEach(function (m) { state.kinds[m] = true; }); any = true; }
      else if (k === 'op') {
        var bits = v.split(':');
        if (bits.length === 3) {
          var row = findRow(decodeURIComponent(bits[0]), bits[1], decodeURIComponent(bits[2]));
          if (row) { state.sel = row; any = true; }
        }
      }
    });
    return any;
  }

  window.addEventListener('hashchange', function () {
    if (hashLock) return;
    state.q = ''; state.ns = null; state.kinds = {}; state.sel = null; state.qCollapsed = {};
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
    fmt(META.schemaCount) + ' schemas · ' + fmt(META.tableCount) + ' tables';
  var xa = document.getElementById('xlink');
  xa.href = META.xlink || 'sn-api-explorer.html';

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
    process.stderr.write('build-graphql-explorer failed: ' + err.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, loadCorpus };
