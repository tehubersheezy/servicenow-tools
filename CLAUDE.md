# ServiceNow Tools

A general-purpose workspace for ServiceNow development resources — API tooling, SDK guides, prompts, and reference material. Anything useful for ServiceNow work lives here.

## Layout

- **`docs/now-sdk/`** — Project guide and complete CLI reference for the `now-sdk` (Fluent) toolchain, including undocumented commands and hidden flags. Symlink or copy `docs/now-sdk/CLAUDE.md` into any `now-sdk` project as its `CLAUDE.md` to load it on every Claude session there. The reference is in `docs/now-sdk/reference.md`.
- **`openapi/`** — OpenAPI specs exported from the instance, used as reference material for hand-rolling Table API / scoped REST calls. Regenerate with `npm run scrape:openapi` (see below); `_summary.json` is the run report, not a spec.
- **`sn-api-explorer.html`** — Self-contained HTML explorer for the scraped API specs. A build artifact: never hand-edit; regenerate with `npm run build:explorer` (source: `src/build-explorer.js`) after any re-scrape.
- **`src/`** — Node.js scripts for programmatic instance access (CommonJS, uses `@servicenow/sdk`).

## Environment

Configured via `.env` (gitignored):

| Variable | Purpose |
|---|---|
| `SN_INSTANCE_URL` | Instance base URL. A bare name (`dev421992`) or host is normalized to `https://<name>.service-now.com` |
| `SN_USERNAME` | Admin username |
| `SN_PASSWORD` | Admin password |
| `PORT` | Server port (default 3000) |

Auth is basic with username/password; the SDK also supports OAuth.

## Common APIs (for the API toolkit)

- **Table API** (`/api/now/table/{tableName}`) — CRUD on any table.
- **Aggregate API** (`/api/now/stats/{tableName}`) — count, avg, min, max, sum, group_by.

### REST API Explorer doc endpoints (undocumented)

The REST API Explorer's own Angular client calls these, and they all accept basic auth — so
enumerating and exporting every API on an instance needs no browser. Source of truth:
`/scripts/restapi/lib/js_includes_explorer.jsx` on any instance (see `docService` and
`specExportService.getSpec`).

| Endpoint | Returns |
|---|---|
| `GET /api/now/doc` | Full catalogue: `namespace → api → versions → resources` |
| `GET /api/now/doc/namespaces` | Namespace list |
| `GET /api/now/doc/services?namespace=<ns>` | APIs in one namespace |
| `GET /api/now/doc/{httpMethod}/{route}` | Per-resource detail |
| `GET /api/now/doc/oas_3?namespace=&name=&version=&format=json\|yaml` | OpenAPI 3 spec for one API |

Gotchas, both learned the hard way:

- **`oas_3` returns 406 for `Accept: application/json`.** It serves `application/octet-stream`
  regardless of `?format=`, so send `Accept: */*`. `ServiceNowClient.request` defaults Accept to
  JSON, hence the per-request `headers` override in `src/scrape-openapi.js`.
- **The Explorer's "Export OpenAPI Specification" link is not an href.** It XHRs the endpoint, then
  builds a `Blob` and clicks a synthesized object URL. There is no URL to scrape off the page and
  no server-side download route — which is why this looks like it requires browser automation when
  it doesn't. The client's only transform is `JSON.stringify(spec, null, 2)`; reproducing that
  (2-space indent, no trailing newline) makes script output byte-identical to a UI download.

## Regenerating the OpenAPI corpus

```bash
npm run scrape:openapi                              # all namespaces -> openapi/
npm run scrape:openapi -- --dry-run                 # list what would be written
npm run scrape:openapi -- --namespace now           # one namespace
npm run scrape:openapi -- --versions all            # every version, not just latest
npm run scrape:openapi -- --only-missing            # resume / retry just the failures
npm run scrape:openapi -- --format yaml --out spec-yaml
```

Roughly 30s for ~340 specs at the default concurrency of 8. Transient failures (429/5xx/network)
are retried 3× with linear backoff; anything still failing is listed in `_summary.json` and the
process exits 1, so `--only-missing` is the natural follow-up.

Note that spec richness varies by release — an Australia instance returns `"responses": {}` for
every operation, where older families populated response schemas. That's the platform's generator,
not the scraper; a UI export from the same instance is byte-identical.

## Conventions

- `.env`, `.DS_Store`, `node_modules/`, `.playwright-cli/` are gitignored.
- OpenAPI specs are reference-only (scraped from the instance, not authored here).
- Documents under `docs/<topic>/CLAUDE.md` are designed to be loaded as project-level `CLAUDE.md` files in *other* projects (via symlink or copy), not just consumed in-tree.
