# ServiceNow Tools

A workspace for ServiceNow development resources — API tooling, SDK guides, and reference material scraped straight from a live instance. The headline pieces are two self-contained, searchable explorers for an instance's entire REST and GraphQL surface.

## Live explorers

Both are single self-contained HTML files — no server, no login, no build step to view. Deployed to GitHub Pages:

- **[REST API Explorer](https://tehubersheezy.github.io/servicenow-tools/)** — every REST API on the instance, searchable in seconds. Type a word, arrow-key through results, copy a ready-to-run `curl`. On the reference instance: **342 APIs · 90 namespaces · 1,635 endpoints.**
- **[GraphQL Explorer](https://tehubersheezy.github.io/servicenow-tools/graphql.html)** — the instance's GraphQL surface, which is otherwise almost undocumented: **112 scripted schemas across 26 namespaces**, plus auto-generated query and full CRUD coverage of **6,189 tables**. Every result generates a runnable query and matching `curl`.
- **[GlideRecord over GraphQL: A Practical Alternative to the Table API](https://tehubersheezy.github.io/servicenow-tools/graphql-guide.html)** — a tool-agnostic article on the generated GlideRecord schema in `/api/now/graphql` and when to prefer it over the REST Table API: encoded queries, dot-walking, inline schema/ACL metadata, aggregates, journal fields, mutation caveats, and the in-band error trap. Companion prose to the GraphQL Explorer.

The pages cross-link to each other. All are **build artifacts** — the explorers regenerated from the scraped corpora, the guide from `docs/graphql-guide.md`, never hand-edited — so they never drift from their sources.

## Quick start

```bash
git clone https://github.com/tehubersheezy/servicenow-tools
cd servicenow-tools
npm install
cp .env.example .env      # then fill in your instance + credentials (see below)

npm run scrape:openapi        # export every REST API   -> openapi/
npm run scrape:graphql        # introspect GraphQL       -> graphql/
npm run build:explorer        # -> sn-api-explorer.html
npm run build:graphql-explorer  # -> sn-graphql-explorer.html
```

Open either `.html` file in a browser. That's it — everything is embedded.

### Environment

Configured via `.env` (gitignored):

| Variable | Purpose |
|---|---|
| `SN_INSTANCE_URL` | Instance base URL. A bare name (`dev12345`) or host is normalized to `https://<name>.service-now.com` |
| `SN_USERNAME` | Admin username |
| `SN_PASSWORD` | Admin password |
| `PORT` | Server port (default 3000) |

Auth is basic username/password; the SDK also supports OAuth.

## Layout

- **`sn-api-explorer.html`** — the REST explorer. Build artifact of `npm run build:explorer` (source: `src/build-explorer.js`).
- **`sn-graphql-explorer.html`** — the GraphQL explorer. Build artifact of `npm run build:graphql-explorer` (source: `src/build-graphql-explorer.js`). The two explorers cross-link via each builder's `--xlink` flag.
- **`sn-graphql-guide.html`** — the GraphQL guide page. Build artifact of `npm run build:guide` (source: `src/build-guide.js`, content: `docs/graphql-guide.md`). Edit the markdown, then rebuild.
- **`openapi/`** — OpenAPI 3 specs, one per REST API, exported from the instance. Reference material for hand-rolling Table API / scoped REST calls. `_summary.json` is the run report, not a spec.
- **`graphql/`** — the GraphQL schema per namespace as introspection JSON + SDL (`<ns>.json` / `<ns>.graphql`), plus `_gliderecord.json` (a compact table→columns index of the auto-generated GlideRecord namespaces) and `_summary.json`.
- **`src/`** — Node.js scripts (CommonJS) for programmatic instance access and the scrapers/builders.
- **`docs/now-sdk/`** — project guide and complete CLI reference for the `now-sdk` (Fluent) toolchain, including undocumented commands and hidden flags. `docs/now-sdk/CLAUDE.md` is designed to be symlinked or copied into a `now-sdk` project so an AI assistant loads it every session; the reference is `docs/now-sdk/reference.md`.
- **`docs/graphql-guide.md`** — the source markdown of the GraphQL guide above. Single source of truth for the page; verified against a live PDI.
- **`docs/workflow-authoring.md`** — how to create/update Playbooks (Process Automation Designer, via GraphQL `now { pad }`) and Flows (Flow Designer, via the undocumented `/api/now/processflow/*` REST API). Verified live; covers payload shapes, gotchas, and the raw `sys_pd_*` / `sys_hub_*` table fallbacks.
- **`docs/catalog-variables.md`** — updating catalog variables on tasks/RITMs via the undocumented `PUT /api/sn_sc/servicecatalog/variables/{table_name}/{sys_id}` (works for itil users where Table API writes 403). Verified live; covers the flat body shape, silent-no-op failure modes, and record-producer (`question_answer`) variables.

## The REST corpus

### How it's scraped (no browser required)

The REST API Explorer's own Angular client calls a handful of plain REST endpoints that all accept basic auth — so enumerating and exporting every API on an instance needs no browser automation. Source of truth: `/scripts/restapi/lib/js_includes_explorer.jsx` on any instance (`docService`, `specExportService.getSpec`).

| Endpoint | Returns |
|---|---|
| `GET /api/now/doc` | Full catalogue: `namespace → api → versions → resources` |
| `GET /api/now/doc/namespaces` | Namespace list |
| `GET /api/now/doc/services?namespace=<ns>` | APIs in one namespace |
| `GET /api/now/doc/{httpMethod}/{route}` | Per-resource detail |
| `GET /api/now/doc/oas_3?namespace=&name=&version=&format=json\|yaml` | OpenAPI 3 spec for one API |

Two gotchas, both learned the hard way:

- **`oas_3` returns 406 for `Accept: application/json`.** It serves `application/octet-stream` regardless of `?format=`, so send `Accept: */*`.
- **The Explorer's "Export OpenAPI Specification" link is not an href.** It XHRs the endpoint, builds a `Blob`, and clicks a synthesized object URL — there is no URL to scrape off the page and no server-side download route, which is exactly why this *looks* like it needs browser automation when it doesn't. The client's only transform is `JSON.stringify(spec, null, 2)`; reproducing that (2-space indent, no trailing newline) makes the scraper's output byte-identical to a UI download.

### Regenerating

```bash
npm run scrape:openapi                       # all namespaces -> openapi/
npm run scrape:openapi -- --dry-run          # list what would be written
npm run scrape:openapi -- --namespace now    # one namespace
npm run scrape:openapi -- --versions all     # every version, not just latest
npm run scrape:openapi -- --only-missing     # resume / retry just the failures
npm run scrape:openapi -- --format yaml --out spec-yaml
```

Roughly 30s for ~340 specs at the default concurrency of 8. Transient failures (429/5xx/network) are retried 3× with linear backoff; anything still failing is listed in `_summary.json` and the process exits 1, so `--only-missing` is the natural follow-up.

Spec richness varies by release — an Australia-family instance returns `"responses": {}` for every operation where older families populated response schemas. That's the platform's generator, not the scraper; a UI export from the same instance is byte-identical.

## The GraphQL corpus

One merged schema at `POST /api/now/graphql` (basic auth works; the platform's GraphQL API Explorer is just a GraphiQL client for it). Top-level fields partition it:

- **Scripted namespaces** (`now`, `global`, `snDecisionTable`, …) — one per scope with `sys_graphql_schema` records; each root field is one scripted schema.
- **Generated namespaces** — `GlideRecord_Query` / `GlideRecord_Mutation` / `GlideAggregateRecord_Query`: a query field per table (`<table>(sys_id, queryConditions, omitCount, pagination)`), CRUD mutations (`insert_/update_/delete_<table>`, one String arg per column), and aggregates (`GlideAggregateRecord_Query(tableName, groupBy, having, …)`). Columns are objects — select `{ value displayValue }`; reference columns add `_reference` to dot-walk.

Gotchas, learned the hard way:

- **graphql-java's "good faith introspection" guard** rejects any query where an introspection meta-field like `__Type.fields` appears more than once (error `BadFaithIntrospection`) — e.g. asking for `queryType { fields }` and `mutationType { fields }` side by side fails. The standard single-fragment introspection query passes.
- **Full introspection is ~94 MB / ~2 minutes** on a PDI, because the generated namespaces materialize a type per table (~14,500 types). That's why `scrape-graphql` collapses them into `_gliderecord.json` (table → column names + the shared framework types) instead of storing them verbatim, and why the scripted namespaces (~1.5 MB total) are the only part kept in full.
- A handful of scripted schemas introspect as **empty object types** (fields hidden by scope protection). That's the platform, not the scraper.

### Regenerating

```bash
npm run scrape:graphql                       # one introspection -> graphql/
npm run scrape:graphql -- --dry-run          # list what would be written
npm run scrape:graphql -- --namespace now    # one scripted namespace (skips _gliderecord)
npm run build:graphql-explorer               # rebuild sn-graphql-explorer.html
```

## Common APIs

- **Table API** (`/api/now/table/{tableName}`) — CRUD on any table.
- **Aggregate API** (`/api/now/stats/{tableName}`) — count, avg, min, max, sum, group_by.

## Notes

- The `openapi/` and `graphql/` corpora are **reference-only** — scraped from a live instance, not authored here, and specific to that instance's release family.
- The explorer `.html` files are **build artifacts**. Don't hand-edit them; change the generator in `src/` and rebuild.
- `.env`, `.DS_Store`, `node_modules/`, and `.playwright-cli/` are gitignored.

## Deployment

`.github/workflows/pages.yml` rebuilds both explorers and publishes them to GitHub Pages on every push to `main`, copying the `openapi/` and `graphql/` corpora alongside so each detail pane's "source" links resolve on the public site.
