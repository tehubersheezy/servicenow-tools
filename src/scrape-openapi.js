#!/usr/bin/env node
'use strict';

/**
 * scrape-openapi — export every REST API on the instance as an OpenAPI 3 spec.
 *
 * This replaces the original browser-driven scrape (Playwright clicking the
 * "Export OpenAPI Specification (JSON)" link in the REST API Explorer, once per
 * API, catching each browser download). The Explorer's own Angular client calls
 * three plain REST endpoints, all of which accept basic auth:
 *
 *   GET /api/now/doc                  full catalogue: namespace -> api -> versions
 *   GET /api/now/doc/namespaces       namespace list only
 *   GET /api/now/doc/services?...     APIs in one namespace
 *   GET /api/now/doc/oas_3?namespace=&name=&version=&format=json|yaml
 *
 * so no browser is involved. Source for that: /scripts/restapi/lib/js_includes_explorer.jsx
 * on any instance — see `specExportService.getSpec` and `docService`.
 *
 * Usage:
 *   node src/scrape-openapi.js [options]
 *
 *   --out <dir>          output directory (default: openapi)
 *   --namespace <ns>     only this namespace (repeatable)
 *   --versions <mode>    latest (default) | all
 *   --format <fmt>       json (default) | yaml
 *   --concurrency <n>    parallel exports (default: 8)
 *   --only-missing       skip APIs whose output file already exists (resume)
 *   --dry-run            list what would be exported, write nothing
 */

const fs = require('fs');
const path = require('path');
const ServiceNowClient = require('./client');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    out: 'openapi',
    namespaces: [],
    versions: 'latest',
    format: 'json',
    concurrency: 8,
    onlyMissing: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--out':          opts.out = argv[++i]; break;
      case '--namespace':    opts.namespaces.push(argv[++i]); break;
      case '--versions':     opts.versions = argv[++i]; break;
      case '--format':       opts.format = argv[++i]; break;
      case '--concurrency':  opts.concurrency = Number(argv[++i]); break;
      case '--only-missing': opts.onlyMissing = true; break;
      case '--dry-run':      opts.dryRun = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['latest', 'all'].includes(opts.versions)) {
    throw new Error(`--versions must be "latest" or "all", got "${opts.versions}"`);
  }
  if (!['json', 'yaml'].includes(opts.format)) {
    throw new Error(`--format must be "json" or "yaml", got "${opts.format}"`);
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Build the output filename for one API, matching the convention already in
 * openapi/: "<namespace>-<API_Name>.<ext>", with every run of characters that
 * aren't word characters collapsed to a single underscore.
 *
 *   ('now', 'Table API')                  -> now-Table_API.json
 *   ('now', 'Reporting API :: Favorites') -> now-Reporting_API_Favorites.json
 *   ('sn_oe_sfs', 'Encode/Decode Base64') -> sn_oe_sfs-Encode_Decode_Base64.json
 *
 * With --versions all, anything other than "latest" gets a version suffix so
 * the default-mode filenames stay byte-identical to the existing corpus.
 */
function specFileName(namespace, apiName, version, { versions, format }) {
  const slug = apiName.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+$/, '');
  const suffix = versions === 'all' && version !== 'latest' ? `_${version}` : '';
  return `${namespace}-${slug}${suffix}.${format}`;
}

// ---------------------------------------------------------------------------
// Instance access
// ---------------------------------------------------------------------------

/**
 * The doc endpoints don't all agree on Content-Type — /api/now/doc returns
 * application/json but /api/now/doc/oas_3 returns application/octet-stream, so
 * the client hands the spec back as a raw string. Normalise both to an object.
 */
function asObject(data) {
  return typeof data === 'string' ? JSON.parse(data) : data;
}

/** Retry transient failures (network errors, 429, 5xx) with linear backoff. */
async function withRetry(fn, { attempts = 3, label = '' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      if (!retryable || attempt === attempts) break;
      const waitMs = attempt * 1000;
      process.stderr.write(`  retry ${attempt}/${attempts - 1} in ${waitMs}ms — ${label}: ${err.message}\n`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

/** Fetch the full namespace -> api -> versions catalogue. */
async function fetchCatalogue(client) {
  const res = await withRetry(() => client.get('/api/now/doc'), { label: '/api/now/doc' });
  const result = asObject(res.data).result;
  if (!result || typeof result !== 'object') {
    throw new Error('Unexpected /api/now/doc response: missing "result" object');
  }
  return result;
}

/** Export one spec. Returns the response body as a string, pretty-printed for JSON. */
async function fetchSpec(client, { namespace, name, version, format }) {
  const res = await withRetry(
    () => client.get('/api/now/doc/oas_3', {
      params: { namespace, name, version, format },
      // This endpoint 406s on `Accept: application/json` and answers with
      // application/octet-stream regardless of ?format=, so ask for anything.
      headers: { Accept: '*/*' },
    }),
    { label: `${namespace}/${name}@${version}` }
  );

  // The Explorer's client does JSON.parse -> JSON.stringify(spec, null, 2) before
  // handing the blob to the browser. Reproducing that exactly (2-space indent, no
  // trailing newline) is what keeps a rerun byte-identical to the existing
  // openapi/ corpus, so unchanged APIs produce no diff. YAML passes through.
  if (format === 'json') return JSON.stringify(asObject(res.data), null, 2);
  return typeof res.data === 'string' ? res.data : String(res.data);
}

// ---------------------------------------------------------------------------
// Work planning
// ---------------------------------------------------------------------------

/** Flatten the catalogue into one work item per (namespace, api, version). */
function planWork(catalogue, opts) {
  const wanted = new Set(opts.namespaces);
  const items = [];

  for (const [namespace, apis] of Object.entries(catalogue)) {
    if (wanted.size && !wanted.has(namespace)) continue;

    for (const [name, api] of Object.entries(apis)) {
      const available = Object.keys(api.versions || {});
      // An API with no advertised version still exports under "latest" — that's
      // the Explorer's default when its version dropdown comes back empty.
      const versions = opts.versions === 'all' && available.length ? available
        : available.includes('latest') || !available.length ? ['latest']
        : [available[0]];

      for (const version of versions) {
        items.push({
          namespace,
          name,
          version,
          file: specFileName(namespace, name, version, opts),
        });
      }
    }
  }

  items.sort((a, b) => a.file.localeCompare(b.file));
  return items;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Run `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n')
      .filter((l) => l.startsWith(' *') || l.startsWith('/**'))
      .map((l) => l.replace(/^\/?\*+ ?/, ''))
      .join('\n') + '\n');
    return;
  }

  const client = new ServiceNowClient();
  const outDir = path.resolve(process.cwd(), opts.out);

  process.stdout.write(`Instance:    ${client.instanceUrl}\n`);
  process.stdout.write(`Output:      ${outDir}\n`);
  process.stdout.write(`Versions:    ${opts.versions}    Format: ${opts.format}    Concurrency: ${opts.concurrency}\n\n`);

  process.stdout.write('Fetching API catalogue…\n');
  const catalogue = await fetchCatalogue(client);
  let items = planWork(catalogue, opts);

  process.stdout.write(`Catalogue:   ${Object.keys(catalogue).length} namespaces, ${items.length} API versions to export\n`);

  const skipped = [];
  if (opts.onlyMissing) {
    const before = items.length;
    items = items.filter((item) => {
      if (fs.existsSync(path.join(outDir, item.file))) {
        skipped.push(item.file);
        return false;
      }
      return true;
    });
    process.stdout.write(`Resume:      skipping ${before - items.length} existing file(s)\n`);
  }

  if (opts.dryRun) {
    for (const item of items) {
      process.stdout.write(`  ${item.file}  <-  ${item.namespace} / ${item.name} @ ${item.version}\n`);
    }
    process.stdout.write(`\nDry run: ${items.length} spec(s) would be written to ${outDir}\n`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  const errors = [];
  let exported = 0;
  let done = 0;

  await pool(items, opts.concurrency, async (item) => {
    try {
      const body = await fetchSpec(client, {
        namespace: item.namespace,
        name: item.name,
        version: item.version,
        format: opts.format,
      });
      fs.writeFileSync(path.join(outDir, item.file), body);
      exported++;
    } catch (err) {
      errors.push({
        ns: item.namespace,
        api: item.name,
        version: item.version,
        file: item.file,
        error: err.message,
        status: err.status,
      });
    } finally {
      done++;
      if (done % 25 === 0 || done === items.length) {
        process.stdout.write(`  ${done}/${items.length} (${exported} ok, ${errors.length} failed)\n`);
      }
    }
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    instance: client.instanceUrl,
    format: opts.format,
    versions: opts.versions,
    namespaceCount: Object.keys(catalogue).length,
    totalExported: exported,
    totalSkipped: skipped.length,
    errorCount: errors.length,
    errors,
  };
  fs.writeFileSync(path.join(outDir, '_summary.json'), JSON.stringify(summary, null, 2) + '\n');

  process.stdout.write(`\nExported ${exported} spec(s) to ${outDir}\n`);
  if (skipped.length) process.stdout.write(`Skipped ${skipped.length} existing file(s)\n`);
  if (errors.length) {
    process.stdout.write(`\n${errors.length} failure(s):\n`);
    for (const e of errors) process.stdout.write(`  ${e.ns} / ${e.api} @ ${e.version}: ${e.error}\n`);
    process.stdout.write('\nRerun with --only-missing to retry just the failures.\n');
  }
  process.stdout.write(`Summary written to ${path.join(outDir, '_summary.json')}\n`);

  if (errors.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\nscrape-openapi failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { specFileName, planWork, parseArgs };
