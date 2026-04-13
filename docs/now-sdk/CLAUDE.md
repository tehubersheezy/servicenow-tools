# ServiceNow now-sdk Project Guide

This project uses the **ServiceNow now-sdk** (Fluent) for application development. You do not have internet access in this session — rely on this document, the local project files, and the ServiceNow Table API for everything you need.

---

## Hard Rules (Read First)

1. **App records are authored in Fluent. Never use the Table API to create, update, or delete records that belong to the app being developed.** The Fluent files in this repo are the source of truth; instance records are derived artifacts.
2. **The Table API is for investigation and instance data only.** Use it to read schemas, inspect existing records, and (when explicitly asked) create/update *instance* data (e.g., test incidents, lookup values that are not part of the app).
3. **If a record type has a dedicated Fluent constructor, use it. Only fall back to the generic `Record` constructor when no specific one exists.**
4. **Always confirm before running `now-sdk install`** — it pushes to the configured instance and is observable to other users of that instance. `--reinstall` is destructive (loses instance-only metadata) and needs explicit re-confirmation.
5. **Convert relative URLs/sys_ids to absolute Table API calls before reading.** Don't guess field values from URL parameters.

---

## now-sdk CLI

Installed via `npm install -g @servicenow/sdk`. Binary is `now-sdk`. **All commands are top-level — there is no `app` prefix.**

For the full CLI surface (every flag, every undocumented command, conflict matrices), read `./reference.md` (in this same directory). Quick reference of the commands you'll use most:

| Command | Purpose |
|---|---|
| `now-sdk auth --add <host> --alias <name>` | Add instance credentials (host is auto-prefixed `https://<host>.service-now.com` if no protocol) |
| `now-sdk auth --use <alias>` | Set default credentials |
| `now-sdk auth --list` | List stored credentials |
| `now-sdk init` | Scaffold a new app (or apply a template if a project already exists) |
| `now-sdk init --from <app_sys_id> --auth <alias>` | Convert a legacy scoped app from instance into Fluent |
| `now-sdk download <directory> --auth <alias>` | Pull existing app metadata from instance |
| `now-sdk build` | Compile Fluent → installable app package |
| `now-sdk install --auth <alias>` | Push built app to instance — **CONFIRM WITH USER FIRST** |
| `now-sdk transform --id <sys_id> --table <table> --auth <alias>` | Convert one ServiceNow record to Fluent (primary path) |
| `now-sdk explain <ApiName>` | Print Fluent API docs for a constructor (offline reference) |

**Always run `now-sdk <command> --help` to confirm flags before composing a non-trivial invocation, and consult `./reference.md` for hidden flags that aren't shown by `--help`.**

### Project structure (typical)
```
<project>/
  src/
    server/          # Server-side scripts: business rules, script includes
    client/          # Client scripts, UI scripts
    records/         # Generic Record() definitions
    tables/          # Table definitions
    forms/           # Form/section/related-list configs
    roles/           # Roles and ACLs
  now.config.json    # App scope, version, dependencies
  package.json
  tsconfig.json
```

### Pulling an existing app — workflow
Use `now-sdk download <directory> --auth <alias>`. For investigating *what's in* an app before pulling, query the Table API:

1. `GET /api/now/table/sys_app?sysparm_query=sys_id=<app_sys_id>` — confirm app + scope
2. `GET /api/now/table/sys_metadata?sysparm_query=sys_scope=<scope_sys_id>&sysparm_fields=sys_class_name,name,sys_id` — list every artifact in the scope
3. Group results by `sys_class_name` to see counts per record type
4. Run `now-sdk download` to materialize them
5. For records that didn't materialize cleanly, see the **Transformation Workflow** section — never hand-translate

---

## ServiceNow Table API

### Base URL pattern
```
https://<instance>.service-now.com/api/now/table/<table_name>[/<sys_id>]
```

Auth: Basic auth with the credentials configured in `now-sdk auth` (or the user will provide).

### The `?UNL` form URL — fallback source for transformation
URL shape:
```
https://<instance>.service-now.com/<table>.do?UNL&sysparm_query=sys_id=<sys_id>
```
e.g. `https://dev12345.service-now.com/incident.do?UNL&sysparm_query=sys_id=c415001e33cc4310cd193ec9bd5c7bbd`

This is the **ServiceNow unload XML format** — the same format `now-sdk transform` consumes. The full transformation workflow (primary path + when to fall back to UNL) is in the **Transformation Workflow** section below; this entry just documents the URL shape itself.

Auth for `?UNL` requests: pass instance basic-auth credentials (`curl -u user:pass ...`) or use the user's authenticated browser session.

### Common queries
- **One record:** `GET /api/now/table/<table>/<sys_id>`
- **Filtered list:** `GET /api/now/table/<table>?sysparm_query=<encoded_query>&sysparm_limit=100`
- **Field schema for a table:** `GET /api/now/table/sys_dictionary?sysparm_query=name=<table>^element!=NULL`
- **Choices for a field:** `GET /api/now/table/sys_choice?sysparm_query=name=<table>^element=<field>`
- **Table metadata (parent, label, scope):** `GET /api/now/table/sys_db_object?sysparm_query=name=<table>`

### Investigation patterns
- **"What does this record look like?"** → Table API GET on the sys_id, then summarize key fields
- **"What fields exist on this table?"** → query `sys_dictionary`
- **"What records of type X exist in scope Y?"** → query the table with `sys_scope=<scope>`
- **"Pull these 50 incidents"** → `GET /api/now/table/incident?sysparm_query=...&sysparm_limit=50` and present concisely

### When the user asks you to *create* records via Table API
- Allowed only for **instance data** (test data, demo records, configuration outside the app scope).
- Use `POST /api/now/table/<table>` with a JSON body.
- Confirm the payload with the user before sending.
- **If the record belongs to the app being built, refuse and use Fluent instead.**

---

## Fluent API

Fluent is a TypeScript DSL where each ServiceNow record is a TypeScript object that the SDK serializes into the app package at build time.

### Specific (typed) constructors — prefer these when they exist

```typescript
import { Application } from '@servicenow/sdk/core'
import { Table } from '@servicenow/sdk/core'
import { BusinessRule } from '@servicenow/sdk/core'
import { ScriptInclude } from '@servicenow/sdk/core'
import { Role } from '@servicenow/sdk/core'
import { ACL } from '@servicenow/sdk/core'
import { Property } from '@servicenow/sdk/core'
import { Form, FormSection } from '@servicenow/sdk/core'
import { List } from '@servicenow/sdk/core'
```

Common record types with dedicated constructors include (not exhaustive — verify against the project's installed SDK version):
- `Application`, `Table`, `Column` / field definitions
- `BusinessRule`, `ScriptInclude`, `ClientScript`, `UIAction`, `UIPolicy`, `UIScript`
- `Form`, `FormSection`, `FormLayout`, `List`, `RelatedList`
- `Role`, `ACL`, `Group`, `User` (rarely — usually instance data)
- `Property` (sys_properties), `Module` (sys_app_module), `ApplicationMenu`
- `RestMessage`, `RestMessageFunction`, `ScheduledJob`, `EmailNotification`

### Generic `Record` — fallback for everything else

```typescript
import { Record } from '@servicenow/sdk/core'

new Record({
  $id: Now.ID['my_record_unique_key'],   // stable identifier across builds
  table: 'sys_choice',
  data: {
    name: 'incident',
    element: 'priority',
    label: 'Critical',
    value: '1',
    sequence: 100,
  },
})
```

Use the generic `Record` when:
- The record type has no specific Fluent constructor in the installed SDK
- You're creating sys_choice entries, lookup data, or unusual configuration records
- The user asks for a record type you don't recognize — default to generic `Record` rather than guessing a constructor name

### `$id` / `Now.ID` — stable identifiers
Every Fluent record needs a stable `$id` so the SDK can generate consistent sys_ids across builds and environments. Use `Now.ID['<descriptive_unique_string>']` — pick names that describe the record's purpose, not just its label.

---

## Transformation Workflow: ServiceNow Record → Fluent

When the user gives you a record (URL, sys_id, or asks you to "convert this to Fluent"):

1. **Identify the record.** Parse the table and sys_id from the URL or arguments.

2. **Try the primary path first** — let now-sdk fetch and transform in one step:
   ```bash
   now-sdk transform --id <sys_id> --table <table> --auth <alias>
   ```
   Note: `--id` and `--table` are hidden flags (not in `--help`) but fully supported. See `./reference.md` for confirmation.

3. **If the primary path fails** (it often does — custom tables, restrictive ACLs, certain platform record types), fall back to the UNL XML route:
   ```bash
   curl -u "$USERNAME:$PASSWORD" \
     "https://<instance>.service-now.com/<table>.do?UNL&sysparm_query=sys_id=<sys_id>" \
     -o /tmp/<descriptive>.xml

   now-sdk transform --from /tmp/<descriptive>.xml
   ```
   Both paths feed the same official transformer — only the source of the XML differs.

4. **Review the generated Fluent.** The transformer can miss or mis-handle: reference fields pointing to records *inside* the app (should use `Now.ID[...]` not raw sys_id), choice list values, and recently-added field types. Patch these by hand. Use `now-sdk explain <ConstructorName>` to confirm the constructor's signature.

5. **Place the file** in the appropriate `src/` subdirectory if the transformer's default location doesn't match the project's convention.

6. **Show the user the diff** before accepting it — don't silently scaffold large multi-file changes.

### Hard rule: never hand-transform UNL XML

If both the `--id`/`--table` path AND the UNL `--from` path fail, **stop and report the failure to the user.** Do not translate UNL XML to Fluent by hand under any circumstance. Manual transcription:
- Drops record-class metadata
- Mis-resolves polymorphic references
- Reorders choice lists incorrectly
- Produces output that passes `now-sdk build` cleanly but causes silent runtime drift on the instance weeks later

Hand-translation is *worse* than failure, because failure is loud and drift is silent.

### Bulk transformation
- Multiple records by sys_id: `now-sdk transform --ids <id1> <id2> ... --auth <alias>` (subject to same failure modes; UNL fallback works per-record).
- Entire update set: `now-sdk transform --updateSet <update_set_sys_id> --auth <alias>`.
- Local directory of XML files: `now-sdk transform --from <directory>`.

---

## Build & Install Workflow

```bash
now-sdk build                    # Compiles Fluent → app package
now-sdk install --auth <alias>   # Pushes to instance — CONFIRM WITH USER FIRST
```

- Run `now-sdk build` after Fluent changes; surface any compile errors verbatim.
- For fast iteration on a single record, build only that record: `now-sdk build --ids <sys_id>` (hidden flag — see reference).
- For CI safety: `now-sdk build --frozenKeys` validates all `Now.ID` keys and sys_ids are pinned.
- Don't run `install` without explicit user approval — it modifies the live instance.
- `now-sdk install --reinstall` (or `-r`) is **destructive** — it uninstalls first, losing any instance-only metadata. Require explicit confirmation.
- `now-sdk install --info` (or `-i`) prints the install-history URL without actually installing — useful for "did the last install succeed?" checks.
- If `build` fails, read the error, locate the offending Fluent file, and offer a fix. Don't comment out the failing record to make the build pass.

---

## Reference Material

You have **no internet access**. Do not attempt to fetch URLs.

For Fluent API patterns, CLI flags, record-type → constructor mapping, and Table API query recipes, read the companion reference file in this same directory:

```
./reference.md
```

If the user has the official sources downloaded locally, also check:
- `llms-full.txt` (the full SDK docs dump from `servicenow.github.io/sdk/llms-full.txt`) — ask the user for the path; it is the most authoritative single file.
- A local clone of `github.com/ServiceNow/sdk-examples` — browse it for working Fluent patterns.

If you need a fact you can't find in any of the above, ask the user. Do not invent API signatures.

---

## When You're Uncertain

Better to ask than to fabricate:
- Unknown CLI flag → ask the user or check `now-sdk <command> --help` via Bash
- Unknown Fluent constructor → use generic `Record` and note the assumption
- Unknown field on a table → query `sys_dictionary` first
- Unknown record's place in the project → ask where the user wants the file
