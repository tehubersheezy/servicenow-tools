#!/usr/bin/env node
/**
 * build-guide.js — render docs/graphql-guide.md into a self-contained HTML
 * page (sn-graphql-guide.html) styled to match the two explorers.
 *
 * Usage:
 *   node src/build-guide.js [--src <file>] [--out <file>]
 *                           [--xlink-rest <href>] [--xlink-graphql <href>]
 *
 * --xlink-rest / --xlink-graphql are the hrefs of the two explorers as seen
 * from the built page (defaults are the repo-root filenames; the Pages
 * workflow passes the deployed paths).
 *
 * Dependency-free (fs/path only) like the other builders — CI runs it
 * without npm install. The markdown support is deliberately the subset the
 * guide actually uses: #/##/### headings, paragraphs, fenced code blocks,
 * one level of nested lists (- / 1.), blockquote callouts, pipe tables with
 * \| escapes, and inline `code` / **bold** / *italic* / [links](href).
 */
const fs = require('fs');
const path = require('path');

const REPO_URL = 'https://github.com/tehubersheezy/servicenow-tools';

function parseArgs(argv) {
  const opts = {
    src: path.join(__dirname, '..', 'docs', 'graphql-guide.md'),
    out: path.join(__dirname, '..', 'sn-graphql-guide.html'),
    xlinkRest: 'sn-api-explorer.html',
    xlinkGraphql: 'sn-graphql-explorer.html',
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--src') opts.src = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--xlink-rest') opts.xlinkRest = argv[++i];
    else if (argv[i] === '--xlink-graphql') opts.xlinkGraphql = argv[++i];
    else { console.error(`Unknown argument: ${argv[i]}`); process.exit(1); }
  }
  return opts;
}

/* ---------------- markdown ---------------- */

const esc = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slug = (s) => s.toLowerCase()
  .replace(/`/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// Inline spans. Code spans are stashed first so ** and * never fire inside
// them (the doc has literal asterisks like `sn*` in code).
function inline(s) {
  const stash = [];
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (m, c) => {
    stash.push(`<code>${c}</code>`);
    return `\x00${stash.length - 1}\x00`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, href) => {
    stash.push(`<a href="${href}">${text}</a>`);
    return `\x00${stash.length - 1}\x00`;
  });
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\x00(\d+)\x00/g, (m, i) => stash[+i]);
  return out;
}

function parseBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = line.match(/^```(\w*)\s*$/);
    if (m) {
      const lang = m[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push({ type: 'code', lang, text: buf.join('\n') });
      continue;
    }

    m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
      i++;
      continue;
    }

    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ type: 'callout', text: buf.join(' ') });
      continue;
    }

    if (/^\|/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\|/.test(lines[i])) buf.push(lines[i++]);
      blocks.push({ type: 'table', rows: buf });
      continue;
    }

    if (/^(-|\d+\.)\s/.test(line)) {
      const buf = [];
      while (i < lines.length && lines[i].trim()) buf.push(lines[i++]);
      blocks.push({ type: 'list', ordered: /^\d+\./.test(line), lines: buf });
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim() &&
           !/^(#{1,4}\s|```|\||- |\d+\.\s)/.test(lines[i])) {
      buf.push(lines[i++].trim());
    }
    blocks.push({ type: 'p', text: buf.join(' ') });
  }
  return blocks;
}

function parseList(listLines) {
  const items = [];
  let cur = null;
  let curChild = null;
  for (const raw of listLines) {
    let m;
    if ((m = raw.match(/^(?:-|\d+\.)\s+(.*)$/))) {
      cur = { text: m[1], children: [] };
      curChild = null;
      items.push(cur);
    } else if ((m = raw.match(/^\s+-\s+(.*)$/))) {
      curChild = { text: m[1] };
      cur.children.push(curChild);
    } else if (curChild) {
      curChild.text += ' ' + raw.trim();
    } else if (cur) {
      cur.text += ' ' + raw.trim();
    }
  }
  return items;
}

function parseTableRow(row) {
  return row.trim()
    .replace(/^\|/, '').replace(/\|$/, '')
    .replace(/\\\|/g, '\x01')
    .split('|')
    .map((c) => c.trim().replace(/\x01/g, '|'));
}

const LANG_LABELS = { graphql: 'GraphQL', json: 'JSON', http: 'HTTP', bash: 'Shell' };

function render(blocks) {
  const toc = [];
  let title = 'ServiceNow GraphQL Guide';
  let lede = '';
  const out = [];
  let seenH1 = false;
  let firstParaAfterH1 = false;

  for (const b of blocks) {
    if (b.type === 'heading') {
      if (b.level === 1) {
        title = b.text;
        seenH1 = true;
        firstParaAfterH1 = true;
        out.push(`<h1>${inline(b.text)}</h1>`);
        continue;
      }
      const id = slug(b.text);
      if (b.level === 2) toc.push({ id, text: b.text });
      out.push(`<h${b.level} id="${id}">${inline(b.text)}</h${b.level}>`);
    } else if (b.type === 'p') {
      if (seenH1 && firstParaAfterH1) {
        lede = b.text;
        firstParaAfterH1 = false;
        out.push(`<p class="lede">${inline(b.text)}</p>`);
      } else {
        out.push(`<p>${inline(b.text)}</p>`);
      }
    } else if (b.type === 'callout') {
      out.push(`<aside class="callout">${inline(b.text)}</aside>`);
    } else if (b.type === 'code') {
      const label = LANG_LABELS[b.lang] || '';
      out.push(
        `<figure class="codeblock">` +
        `<figcaption class="codebar">` +
        (label ? `<span class="lang">${label}</span>` : `<span class="lang lang-plain">Text</span>`) +
        `<button class="copy" type="button">Copy</button>` +
        `</figcaption>` +
        `<pre>${esc(b.text)}</pre>` +
        `</figure>`
      );
    } else if (b.type === 'list') {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = parseList(b.lines).map((it) => {
        let li = `<li>${inline(it.text)}`;
        if (it.children.length) {
          li += `<ul>${it.children.map((c) => `<li>${inline(c.text)}</li>`).join('')}</ul>`;
        }
        return li + '</li>';
      });
      out.push(`<${tag}>${items.join('')}</${tag}>`);
    } else if (b.type === 'table') {
      const header = parseTableRow(b.rows[0]);
      const body = b.rows.slice(2).map(parseTableRow);
      out.push(
        `<div class="tablewrap"><table>` +
        `<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>` +
        `</table></div>`
      );
    }
  }
  return { html: out.join('\n'), toc, title, lede };
}

/* ---------------- page shell ---------------- */

function page({ html, toc, title, lede }, opts) {
  const tocHtml = toc.map((t) => `<li><a href="#${t.id}">${inline(t.text)}</a></li>`).join('\n        ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(lede).slice(0, 300)}">
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
    --shadow-md: 0 1px 2px oklch(0.24 0.012 335 / 0.06), 0 4px 16px oklch(0.24 0.012 335 / 0.07);
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: var(--sans); color: var(--ink); background: var(--bg);
    font-size: 0.9375rem; line-height: 1.7; font-kerning: normal;
    -webkit-text-size-adjust: 100%;
  }
  pre, code { font-family: var(--sans); }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
  :focus { outline: none; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

  /* ---------- Header ---------- */
  header {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem 1.25rem;
    padding: 0.65rem 1.25rem;
    border-bottom: 1px solid var(--line); background: var(--bg);
  }
  .brand { display: flex; align-items: baseline; gap: 0.6rem; white-space: nowrap; }
  .brand strong { font-size: 0.9375rem; font-weight: 700; letter-spacing: -0.01em; }
  .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); align-self: center; }
  .brand-meta { color: var(--ink-3); font-size: 0.75rem; }
  .head-links { margin-left: auto; display: flex; flex-wrap: wrap; gap: 0.25rem 1.1rem; }
  .xlink { color: var(--accent-deep); font-size: 0.75rem; font-weight: 600; text-decoration: none; white-space: nowrap; }
  .xlink:hover { text-decoration: underline; }

  /* ---------- Layout ---------- */
  .page {
    display: grid; grid-template-columns: minmax(0, 44rem) 14rem;
    gap: 4.5rem; justify-content: center;
    padding: 3rem 1.5rem 6rem; margin: 0 auto;
  }
  @media (max-width: 68rem) {
    .page { grid-template-columns: minmax(0, 44rem); }
    .toc { display: none; }
  }

  /* ---------- TOC ---------- */
  .toc { font-size: 0.8125rem; }
  .toc-inner { position: sticky; top: 4.5rem; max-height: calc(100vh - 6rem); overflow-y: auto; }
  .toc-head {
    font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink-3); margin: 0.35rem 0 0.65rem;
  }
  .toc ul { list-style: none; margin: 0; padding: 0; }
  .toc li { margin: 0; }
  .toc a {
    display: block; color: var(--ink-3); text-decoration: none;
    padding: 0.28rem 0.75rem; border-left: 2px solid var(--line-soft);
    transition: color 150ms ease-out, border-color 150ms ease-out;
  }
  .toc a:hover { color: var(--ink); }
  .toc a.active { color: var(--accent-deep); border-left-color: var(--accent); font-weight: 600; }

  /* ---------- Article ---------- */
  article { min-width: 0; }
  h1 {
    font-size: 2rem; line-height: 1.2; font-weight: 750; letter-spacing: -0.02em;
    margin: 0 0 1.1rem;
  }
  .lede { font-size: 1.0625rem; line-height: 1.75; color: var(--ink-2); margin: 0 0 1rem; }
  h2 {
    font-size: 1.375rem; line-height: 1.3; font-weight: 700; letter-spacing: -0.015em;
    margin: 3rem 0 0.85rem; padding-top: 2.25rem; border-top: 1px solid var(--line-soft);
  }
  h3 { font-size: 1.0625rem; font-weight: 700; letter-spacing: -0.01em; margin: 2rem 0 0.6rem; }
  h2 code, h3 code { font-size: 0.92em; }
  p { margin: 0 0 1rem; }
  ul, ol { margin: 0 0 1rem; padding-left: 1.35rem; }
  li { margin: 0.35rem 0; }
  li ul { margin: 0.35rem 0 0.1rem; }
  strong { font-weight: 650; }

  .callout {
    margin: 0 0 1.25rem; padding: 0.9rem 1.1rem;
    background: var(--accent-wash); border: 1px solid var(--accent-wash-2);
    border-left: 3px solid var(--accent); border-radius: 10px;
    color: var(--ink); line-height: 1.7;
  }
  .callout strong { color: var(--accent-deep); }
  .callout code { background: var(--bg); border-color: var(--accent-wash-2); }

  a { color: var(--accent-deep); text-decoration: underline; text-underline-offset: 2px; }
  a:hover { color: var(--accent); }

  code {
    background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: 5px;
    padding: 0.06em 0.32em; font-size: 0.9em; font-weight: 500; color: var(--ink);
    overflow-wrap: break-word;
  }

  /* ---------- Code blocks ---------- */
  .codeblock {
    margin: 0 0 1.25rem; border: 1px solid var(--line); border-radius: 10px;
    background: var(--panel); overflow: hidden; box-shadow: var(--shadow-md);
  }
  .codebar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.42rem 1rem; background: var(--panel-2); border-bottom: 1px solid var(--line-soft);
  }
  .codebar .lang {
    font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--accent-deep);
  }
  .codebar .lang-plain { color: var(--ink-3); }
  .codebar .copy {
    font-size: 0.6875rem; font-weight: 600; color: var(--ink-3);
    padding: 0.1rem 0.5rem; border: 1px solid var(--line); border-radius: 5px; background: var(--bg);
    transition: color 150ms ease-out, border-color 150ms ease-out;
  }
  .codebar .copy:hover { color: var(--accent-deep); border-color: var(--accent-wash-2); }
  .codebar .copy.done { color: var(--accent-deep); border-color: var(--accent-wash-2); background: var(--accent-wash); }
  .codeblock pre {
    margin: 0; padding: 0.9rem 1rem; overflow-x: auto;
    font-size: 0.85rem; line-height: 1.6; color: var(--ink);
  }
  .codeblock pre code { background: none; border: 0; padding: 0; font-size: inherit; font-weight: 400; }

  /* ---------- Tables ---------- */
  .tablewrap { overflow-x: auto; margin: 0 0 1.25rem; border: 1px solid var(--line); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
  th {
    text-align: left; font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--ink-3); background: var(--panel);
    padding: 0.55rem 0.9rem; border-bottom: 1px solid var(--line);
  }
  td { padding: 0.5rem 0.9rem; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }

  /* ---------- Footer ---------- */
  footer {
    border-top: 1px solid var(--line); padding: 1.25rem;
    text-align: center; color: var(--ink-3); font-size: 0.75rem;
  }
  footer a { color: var(--accent-deep); font-weight: 600; text-decoration: none; }
  footer a:hover { text-decoration: underline; }

  @media print {
    header, .toc, footer, .codebar .copy { display: none; }
    .page { grid-template-columns: 1fr; padding: 0; }
    .codeblock { box-shadow: none; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <span class="dot"></span>
    <strong>ServiceNow GraphQL</strong>
    <span class="brand-meta">GlideRecord vs. the Table API</span>
  </div>
  <nav class="head-links">
    <a class="xlink" href="${esc(opts.xlinkGraphql)}">GraphQL Explorer</a>
    <a class="xlink" href="${esc(opts.xlinkRest)}">REST API Explorer</a>
    <a class="xlink" href="${REPO_URL}">GitHub</a>
  </nav>
</header>
<div class="page">
  <article>
${html}
  </article>
  <nav class="toc" aria-label="Table of contents">
    <div class="toc-inner">
      <div class="toc-head">On this page</div>
      <ul>
        ${tocHtml}
      </ul>
    </div>
  </nav>
</div>
<footer>
  Part of <a href="${REPO_URL}">servicenow-tools</a> —
  companion to the <a href="${esc(opts.xlinkGraphql)}">GraphQL Explorer</a> and
  <a href="${esc(opts.xlinkRest)}">REST API Explorer</a>.
</footer>
<script>
  document.querySelectorAll('.codeblock .copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.closest('.codeblock').querySelector('pre').textContent;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1400);
      });
    });
  });

  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  var byId = {};
  tocLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  var current = null;
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        if (current) current.classList.remove('active');
        current = byId[e.target.id];
        if (current) current.classList.add('active');
      }
    });
  }, { rootMargin: '-15% 0px -70% 0px' });
  document.querySelectorAll('article h2[id]').forEach(function (h) { observer.observe(h); });
</script>
</body>
</html>
`;
}

/* ---------------- main ---------------- */

const opts = parseArgs(process.argv);
const md = fs.readFileSync(opts.src, 'utf8');
const rendered = render(parseBlocks(md));
const out = page(rendered, opts);
fs.writeFileSync(opts.out, out);
console.log(`Wrote ${opts.out} (${(out.length / 1024).toFixed(1)} KB, ${rendered.toc.length} sections)`);
