# ServiceNow Tools

A general-purpose workspace for ServiceNow development resources — API tooling, SDK guides, prompts, and reference material. Anything useful for ServiceNow work lives here.

## Layout

- **`docs/now-sdk/`** — Project guide and complete CLI reference for the `now-sdk` (Fluent) toolchain, including undocumented commands and hidden flags. Symlink or copy `docs/now-sdk/CLAUDE.md` into any `now-sdk` project as its `CLAUDE.md` to load it on every Claude session there. The reference is in `docs/now-sdk/reference.md`.
- **`openapi/`** — 305+ OpenAPI specs scraped from the instance, used as reference material for hand-rolling Table API / scoped REST calls.
- **`sn-api-explorer.html`** — Self-contained HTML explorer for the scraped API specs.
- **`src/`** — Node.js scripts for programmatic instance access (CommonJS, uses `@servicenow/sdk`).

## Environment

Configured via `.env` (gitignored):

| Variable | Purpose |
|---|---|
| `SN_INSTANCE_URL` | Instance base URL |
| `SN_USERNAME` | Admin username |
| `SN_PASSWORD` | Admin password |
| `PORT` | Server port (default 3000) |

Auth is basic with username/password; the SDK also supports OAuth.

## Common APIs (for the API toolkit)

- **Table API** (`/api/now/table/{tableName}`) — CRUD on any table.
- **Aggregate API** (`/api/now/stats/{tableName}`) — count, avg, min, max, sum, group_by.

## Conventions

- `.env`, `.DS_Store`, `node_modules/`, `.playwright-cli/` are gitignored.
- OpenAPI specs are reference-only (scraped from the instance, not authored here).
- Documents under `docs/<topic>/CLAUDE.md` are designed to be loaded as project-level `CLAUDE.md` files in *other* projects (via symlink or copy), not just consumed in-tree.
