# Updating catalog variables on tasks via REST

Verified live on dev421992 (Australia family), 2026-08-12, as both admin and a plain `itil` user.

## The endpoint that works: `PUT /api/sn_sc/servicecatalog/variables/{table_name}/{sys_id}`

Undocumented — present in the scraped corpus (`openapi/sn_sc-Service_Catalog_API.json`) but absent
from the official Service Catalog API docs. It is a **scripted** REST resource
(`sys_ws_operation` `cd374a3653220010bcd5ddeeff7b1257`, "Update Variables"), so its exact semantics
are readable on any instance. The operation script is short:

```js
var variables = request.body.nextEntry();          // body IS the flat map — no wrapper
var gr = new GlideRecord(table_name);
if (!gr.get(sys_id) || !gr.canWrite())             // record-level ACL on the TASK, not sc_item_option
    throw NotFoundError(...);
for (var key in variables)
    if (typeof gr.variables[key] !== 'undefined')  // unknown names silently skipped
        gr.variables[key] = variables[key];
gr.update();                                       // 200 + empty body on success
```

### Request shape

```bash
# RITM variables
curl -X PUT "$SN/api/sn_sc/servicecatalog/variables/sc_req_item/$RITM_SYS_ID" \
  -H 'Content-Type: application/json' \
  -d '{"acrobat":"false","Additional_software_requirements":"new text"}'

# Record-producer variables on any task table (stored in question_answer)
curl -X PUT "$SN/api/sn_sc/servicecatalog/variables/incident/$INC_SYS_ID" \
  -d '{"contact_me":"email"}'
```

Body is a **flat `{variable_name: value}` object** — no `"variables"` wrapper. Values are raw
(reference → sys_id, checkbox → `"true"`/`"false"`, dates in internal format). Response is
`200` with an empty/`null` body; `404` "security constraints" when `gr.canWrite()` fails;
`400` on a malformed sys_id.

### Verified behavior

| Test | Result |
|---|---|
| Admin, flat body on `sc_req_item` | ✅ writes |
| **itil user**, same call | ✅ writes (gate is `canWrite()` on the task record) |
| itil user, direct Table API `PATCH /api/now/table/sc_item_option/{sys_id}` | ❌ **403** |
| itil user, PUT on a record they can't write (`item_option_new` def) | 404 security error |
| PUT on record-producer variables (`incident` via `question_answer`) | ✅ writes, itil too |
| PUT on a child `sc_task` of the RITM | ⚠️ **200 but no write** — silently skipped |
| Body with `{"variables": {...}}` wrapper or unknown names | ⚠️ **200 but no write** |

### Gotchas

- **Silent no-ops are the failure mode.** Wrong body shape, wrong variable name (names are
  case-sensitive — `Additional_software_requirements`, not `additional_...`), or a table whose
  GlideRecord doesn't own the variables all return `200` with nothing written. Always read back
  after writing.
- **Target the record that owns the variables.** For catalog orders that's the **RITM**
  (`sc_req_item`), never the child `sc_task` — `gr.variables` on the task doesn't resolve the
  RITM's pool, and the keys are skipped silently. For record producers it's the produced record
  itself (`incident`, `change_request`, …), whose values live in `question_answer`.
- **No validation runs**: mandatory checks, UI policies, catalog client scripts, and variable
  read-only flags are not consulted. The only gate is write access to the parent record.
- Multi-row variable sets (`sc_multi_row_question_answer`) were **not** tested.

## Why not the Table API?

Direct writes to the storage tables (`sc_item_option.value`, joined via `sc_item_option_mtom`)
work for **admin/integration users** and are the fully documented path — but they're gated by
table ACLs that deny plain `itil` users (403 on write, verified), and an instance-hardening pass
can tighten them further. Reads of the join *are* itil-accessible:

```bash
sn table list sc_item_option_mtom --query "request_item=$RITM" \
  --fields "sc_item_option,sc_item_option.item_option_new.name,sc_item_option.value" \
  --display-value false
```

GraphQL `GlideRecord_Mutation` goes through the same table ACLs — same 403 for itil.

**Rule of thumb:** admin integration → either path works; anything running as an end user or
fulfiller → the `sn_sc` PUT is the only option that works out of box, and its security model
(write the variables of any record you can write) is the intended one.
