#!/usr/bin/env node
'use strict';

/**
 * scrape-graphql — export the instance's GraphQL schema, partitioned per
 * namespace, as introspection JSON + SDL.
 *
 * ServiceNow serves one merged schema at POST /api/now/graphql (the GraphQL
 * API Explorer in the platform is just a GraphiQL client for it; basic auth
 * works). One standard introspection query returns everything — but
 * "everything" is ~94 MB, because the auto-generated GlideRecord_Query /
 * GlideRecord_Mutation / GlideAggregateRecord_Query namespaces materialize a
 * type per table and a field per column (~14,500 types for ~6,200 tables).
 *
 * So this scraper splits the result:
 *
 *   graphql/<ns>.json + <ns>.graphql   one pair per *scripted* namespace
 *                                      (sys_graphql_schema records, grouped by
 *                                      scope: now, global, snDecisionTable, …)
 *                                      — the types reachable from that
 *                                      namespace's query/mutation roots.
 *   graphql/_gliderecord.json          compact index of the generated
 *                                      namespaces: table -> column names, the
 *                                      uniform query/mutation/aggregate arg
 *                                      patterns, and the shared framework
 *                                      types — everything needed to write a
 *                                      query, without 90 MB of repetition.
 *   graphql/_summary.json              run report (not a schema).
 *
 * Gotcha learned the hard way: graphql-java's "good faith introspection"
 * guard rejects any query where __Type.fields (or similar meta fields) appears
 * more than once — e.g. asking for queryType { fields } and mutationType
 * { fields } side by side fails with BadFaithIntrospection. The standard
 * introspection query passes because its single FullType fragment mentions
 * each meta field exactly once.
 *
 * Usage:
 *   node src/scrape-graphql.js [options]
 *
 *   --out <dir>          output directory (default: graphql)
 *   --namespace <ns>     only this scripted namespace (repeatable)
 *   --dry-run            list what would be written, write nothing
 */

const fs = require('fs');
const path = require('path');
const ServiceNowClient = require('./client');
const { renderSchema } = require('./graphql-sdl');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: 'graphql', namespaces: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--out':       opts.out = argv[++i]; break;
      case '--namespace': opts.namespaces.push(argv[++i]); break;
      case '--dry-run':   opts.dryRun = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

// The standard introspection query. Kept in its canonical single-fragment form
// on purpose — see the BadFaithIntrospection note in the header.
const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives { name description locations args { ...InputValue } }
  }
}
fragment FullType on __Type {
  kind name description
  fields(includeDeprecated: true) {
    name description
    args { ...InputValue }
    type { ...TypeRef }
    isDeprecated deprecationReason
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue {
  name description type { ...TypeRef } defaultValue
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType {
    kind name ofType { kind name ofType { kind name ofType { kind name } } }
  } } } }
}`;

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
      const waitMs = attempt * 2000;
      process.stderr.write(`  retry ${attempt}/${attempts - 1} in ${waitMs}ms — ${label}: ${err.message}\n`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

async function fetchSchema(client) {
  const res = await withRetry(
    () => client.post('/api/now/graphql', { body: { query: INTROSPECTION_QUERY } }),
    { label: 'introspection' }
  );
  const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (body.errors && body.errors.length) {
    throw new Error('GraphQL introspection errors: ' + JSON.stringify(body.errors).slice(0, 500));
  }
  if (!body.data || !body.data.__schema) {
    throw new Error('Unexpected /api/now/graphql response: missing data.__schema');
  }
  return body.data.__schema;
}

// ---------------------------------------------------------------------------
// Schema partitioning
// ---------------------------------------------------------------------------

/** Unwrap a TypeRef to its named type. */
function namedType(ref) {
  while (ref && !ref.name) ref = ref.ofType;
  return ref ? ref.name : null;
}

/** All type names reachable from `rootName` by fields/args/inputs/interfaces. */
function reachableFrom(rootName, byName) {
  const seen = new Set();
  const stack = [rootName];
  while (stack.length) {
    const name = stack.pop();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const t = byName.get(name);
    if (!t) continue;
    for (const f of t.fields || []) {
      stack.push(namedType(f.type));
      for (const a of f.args || []) stack.push(namedType(a.type));
    }
    for (const f of t.inputFields || []) stack.push(namedType(f.type));
    for (const i of t.interfaces || []) stack.push(namedType(i));
    for (const p of t.possibleTypes || []) stack.push(namedType(p));
  }
  return seen;
}

const GENERATED_ROOT = /^(GlideRecord|GlideAggregateRecord)_/;

/**
 * Group the merged schema's top-level fields into scripted namespaces.
 * Returns { ns: { query: {field, type}, mutation: {...}, subscription: {...} } }.
 */
function scriptedNamespaces(schema, byName) {
  const rootTypes = {
    query: schema.queryType && schema.queryType.name,
    mutation: schema.mutationType && schema.mutationType.name,
    subscription: schema.subscriptionType && schema.subscriptionType.name,
  };
  const out = {};
  for (const [kind, rootTypeName] of Object.entries(rootTypes)) {
    const root = rootTypeName && byName.get(rootTypeName);
    if (!root) continue;
    for (const f of root.fields || []) {
      if (GENERATED_ROOT.test(f.name)) continue;
      out[f.name] = out[f.name] || {};
      out[f.name][kind] = { field: f.name, type: namedType(f.type) };
    }
  }
  return out;
}

/**
 * Build the compact index of the generated GlideRecord / GlideAggregateRecord
 * namespaces. Per-table types are collapsed to column-name lists; the shared
 * "framework" types (pagination input, field wrappers, aggregate result
 * types, …) are kept in full so a consumer can still see the value/displayValue
 * shape without the 90 MB of per-table repetition.
 */
function buildGlideRecordIndex(schema, byName) {
  const queryRoot = byName.get('GlideRecord_QueryType');
  if (!queryRoot) return null;

  const mutationRoot = byName.get('GlideRecord_MutationType');
  const mutationNames = new Set((mutationRoot ? mutationRoot.fields : []).map((f) => f.name));

  const tables = {};
  const tablesWithoutMutations = [];
  let sampleQueryField = null;
  let tableMetaFields = null;

  for (const f of queryRoot.fields) {
    sampleQueryField = sampleQueryField || f;
    const tableType = byName.get(namedType(f.type));
    let columns = [];
    if (tableType) {
      if (!tableMetaFields) {
        tableMetaFields = tableType.fields.filter((x) => x.name !== '_results').map((x) => x.name);
      }
      const results = tableType.fields.find((x) => x.name === '_results');
      const resultsType = results && byName.get(namedType(results.type));
      if (resultsType) {
        columns = resultsType.fields
          .filter((x) => !x.name.startsWith('_'))
          .map((x) => x.name);
      }
    }
    tables[f.name] = columns;
    if (!mutationNames.has('insert_' + f.name)) tablesWithoutMutations.push(f.name);
  }

  // Framework types: the shared machinery reachable from the generated roots —
  // field wrappers, metadata, aggregates, pagination. Three families are
  // per-table (TableType, TableResultsType, ReferenceFieldType — one each per
  // table/reference target) and get collapsed into `tables` +
  // `referenceFieldMeta` instead of being stored thousands of times.
  const generatedFamily = /^GlideRecord_(TableType|TableResultsType|ReferenceFieldType)_/;
  const glideName = /^(Glide_|GlideRecord_|GlideAggregateRecord_)/;
  const roots = ['GlideRecord_QueryType', 'GlideRecord_MutationType', 'GlideAggregateRecord_QueryType'];
  const frameworkNames = new Set();
  for (const rootName of roots) {
    for (const name of reachableFrom(rootName, byName)) {
      if (glideName.test(name) && !generatedFamily.test(name) && !roots.includes(name)) {
        frameworkNames.add(name);
      }
    }
  }
  const frameworkTypes = [...frameworkNames]
    .map((n) => byName.get(n))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  const queryType = byName.get(schema.queryType && schema.queryType.name);
  const aggField = queryType && queryType.fields.find((f) => f.name === 'GlideAggregateRecord_Query');

  // The reference-field wrapper is the plain field wrapper plus `_reference`,
  // which dot-walks into the target table's results type. Uniform across all
  // 1,400+ reference targets, so store the field list once.
  const refExample = schema.types.find((t) => /^GlideRecord_ReferenceFieldType_/.test(t.name));
  const referenceFieldMeta = refExample ? refExample.fields.map((f) => f.name) : [];

  const sortedTables = {};
  for (const name of Object.keys(tables).sort()) sortedTables[name] = tables[name];

  return {
    description: 'Compact index of the auto-generated GlideRecord namespaces. '
      + 'Every table gets: a query field GlideRecord_Query.<table>(sys_id, queryConditions, omitCount, pagination), '
      + 'and mutations insert_<table> / update_<table> / delete_<table> on GlideRecord_Mutation '
      + '(one String argument per column; update/delete take sys_id). '
      + 'Aggregates go through GlideAggregateRecord_Query(tableName, queryConditions, groupBy, having, orderBy, …). '
      + 'Column values are objects — select { value displayValue } on each; reference columns additionally '
      + 'offer _reference to dot-walk into the target table.',
    queryArgs: sampleQueryField ? sampleQueryField.args : [],
    aggregateArgs: aggField ? aggField.args : [],
    tableMetaFields: tableMetaFields || [],
    referenceFieldMeta,
    frameworkTypes,
    tableCount: Object.keys(sortedTables).length,
    tablesWithoutMutations: tablesWithoutMutations.sort(),
    tables: sortedTables,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
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
  process.stdout.write(`Output:      ${outDir}\n\n`);
  process.stdout.write('Running introspection (one query, ~2 minutes — the generated table types are big)…\n');

  const t0 = Date.now();
  const schema = await fetchSchema(client);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const byName = new Map(schema.types.map((t) => [t.name, t]));
  process.stdout.write(`Introspection done in ${elapsed}s — ${schema.types.length} types\n\n`);

  const namespaces = scriptedNamespaces(schema, byName);
  const wanted = new Set(opts.namespaces);
  const nsNames = Object.keys(namespaces)
    .filter((ns) => !wanted.size || wanted.has(ns))
    .sort();

  const files = [];
  for (const ns of nsNames) {
    const kinds = namespaces[ns];
    const typeNames = new Set();
    for (const kind of Object.keys(kinds)) {
      for (const name of reachableFrom(kinds[kind].type, byName)) typeNames.add(name);
    }
    const types = [...typeNames].map((n) => byName.get(n)).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    const roots = {};
    for (const kind of ['query', 'mutation', 'subscription']) {
      if (!kinds[kind]) continue;
      const rootType = byName.get(kinds[kind].type);
      roots[kind] = {
        type: kinds[kind].type,
        fields: rootType ? (rootType.fields || []).map((f) => f.name) : [],
      };
    }
    files.push({ ns, roots, types });
  }

  const glideRecord = wanted.size ? null : buildGlideRecordIndex(schema, byName);

  if (opts.dryRun) {
    for (const f of files) {
      const ops = Object.entries(f.roots)
        .map(([k, r]) => `${k}: ${r.fields.length}`).join(', ');
      process.stdout.write(`  ${f.ns}.json + ${f.ns}.graphql  (${f.types.length} types; ${ops})\n`);
    }
    if (glideRecord) {
      process.stdout.write(`  _gliderecord.json  (${glideRecord.tableCount} tables, ${glideRecord.frameworkTypes.length} framework types)\n`);
    }
    process.stdout.write(`\nDry run: ${files.length} namespace(s) would be written to ${outDir}\n`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  for (const f of files) {
    writeJson(path.join(outDir, `${f.ns}.json`), {
      namespace: f.ns,
      endpoint: '/api/now/graphql',
      roots: f.roots,
      typeCount: f.types.length,
      types: f.types,
    });
    const rootNames = Object.values(f.roots).map((r) => r.type);
    fs.writeFileSync(path.join(outDir, `${f.ns}.graphql`), renderSchema(f.types, rootNames));
    process.stdout.write(`  ${f.ns} — ${f.types.length} types\n`);
  }

  if (glideRecord) {
    // Compact on purpose: pretty-printing puts each of ~350k column names on
    // its own line and quintuples the file. This one is a machine index — the
    // human-readable corpus is the per-namespace .graphql files.
    fs.writeFileSync(path.join(outDir, '_gliderecord.json'), JSON.stringify(glideRecord) + '\n');
    process.stdout.write(`  _gliderecord — ${glideRecord.tableCount} tables\n`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    instance: client.instanceUrl,
    endpoint: '/api/now/graphql',
    introspectionSeconds: elapsed,
    totalTypes: schema.types.length,
    scriptedNamespaces: files.map((f) => f.ns),
    tableCount: glideRecord ? glideRecord.tableCount : null,
  };
  writeJson(path.join(outDir, '_summary.json'), summary);

  process.stdout.write(`\nWrote ${files.length} namespace(s)${glideRecord ? ` + _gliderecord.json (${glideRecord.tableCount} tables)` : ''} to ${outDir}\n`);
  process.stdout.write(`Summary written to ${path.join(outDir, '_summary.json')}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\nscrape-graphql failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, scriptedNamespaces, buildGlideRecordIndex, reachableFrom };
