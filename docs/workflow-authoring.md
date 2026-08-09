# Authoring workflow artifacts programmatically

How to **create and update** the two workflow-builder artifact families on an
instance — Playbooks (Process Automation Designer) and Flows/Subflows/Actions
(Flow Designer) — without the UI. Both builders are single-page apps driven by
undocumented server APIs that accept basic auth, so everything here works from
`src/client.js` or plain curl.

Findings were verified live against dev421992 (Zurich family). Both surfaces are
the builders' own internal APIs: **unversioned, undocumented, and free to change
between release families** — read an existing artifact back on your target
instance before trusting any payload shape.

> Triggering/reading a running playbook is a different, stable API — the
> `snPlaybookExp` GraphQL namespace (`getPlaybooksForParentRecord`,
> `triggerPlaybook`, `launchPlaybook`). That's execution-side; this doc is
> authoring-side.

---

## Playbooks / Process Automation Designer → GraphQL `now { pad }`

PAD authoring lives entirely in **GraphQL**, not REST. The REST corpus has only
a usage-monitoring API (`sn_pa_designer-Activity_Picker_Usage_Monitoring`); the
designer canvas itself talks to `POST /api/now/graphql`, which is why this only
shows up in the GraphQL scrape. Explorer:
[graphql.html#op=now:MUTATION:pad](https://tehubersheezy.github.io/servicenow-tools/graphql.html#op=now%3AMUTATION%3Apad).

### Mutations — `now_pad_Mutation`

| Mutation | Purpose |
|---|---|
| `createProcess(process, lanes, activities, triggers, config, additionalContextInfo)` | Create a playbook/process definition |
| `updateProcessData(process, lanes, activities, swimlanes, activityAppObjects, variants, overrides, config, triggers)` | Edit an existing definition |
| `generateProcess(prompt, process, attachmentId, kbId, additionalContextInfo)` | **Now Assist** — generate a playbook from a text prompt, an attachment, or a KB article |
| `deleteProcess(sysId, scope)` | Delete |
| `stopGenerationContext(sysId)` | Cancel an in-flight Now Assist generation |

The `now_pad_ProcessInput` object mirrors the designer's property panel:
`label`, `description`, `sysScope`, `processType`, `runStrategy`, `restartable`,
`allowAsNested`, `inputs`, `outputs`, `permission`, `publicAccess`,
`executionType`, the `launcher*` fields (title, description, record form view,
template fields, inputs), and `nowAssistPrompt` / `nowAssistAttachmentId` /
`nowAssistKb` for AI generation.

The `now_pad_ActivityInput` object is one activity card: `activityDefinition`,
`processDefinition`, `dataDefinition`, `label`, `coordinates`, `swimLane` /
`lane`, `inputs`, `typeVals`, `order`, `conditionToRun`, `startRule`,
`startDelay`, `restartRule`, `variant`, and `aiAgentFields` (agentic playbooks).

Mutations return **unions** — a success type or a typed error — so select with
inline fragments and get enumerated failures instead of parsing strings:

```graphql
mutation {
  now {
    pad {
      # read an existing process first with getProcess, edit the payload, send it back
      updateProcessData(process: { sysId: "…", description: "…" }, activities: [ … ], lanes: [ … ]) {
        __typename
        ... on now_pad_ProcessData { process { label { value } } }
        ... on now_pad_Error { errorType message }
      }
    }
  }
}
```

### Queries — `now_pad_Query` (the authoring toolkit)

- `getProcess(processDefinitionId, config)` — **read a full definition back.**
  This is the reliable way to learn the exact input shape: read an existing
  playbook, mutate the returned object, send it into `updateProcessData`.
- `getActivityDefinitions()` — the palette of activity types you can drop in.
- `getActivityInputsOutputs(sysId)`, `getActivityAppObjects(processDefinitionId)`.
- `getParentPlaybooks`, `getParentTables(table)`, `getFormViewsForTableData`.
- Access gates: `checkPlaybookSkillsAccess`, `hasPlaybookGenerationAccess`,
  `hasPlaybookRecommendationsAccess`.
- `now { paDesigner }` — a legacy sibling for small edits:
  `updateActivityPositions`, `deleteActivity`, `updateProcessProperties`,
  `mutateTimerAttributes`, plus lookups `getActivityTypes` / `getTriggerTypes` /
  `getActivityStartRules`.

### Gotcha: `DisplayableString`

Most PAD "scalar" fields (`label`, `sysId`, …) are **objects of type
`now_pad_DisplayableString`**, not plain strings — a bare selection fails with
`SubselectionRequired`. Always subselect `{ value }`:

```graphql
getProcess(processDefinitionId: "…") {
  ... on now_pad_ProcessData {
    process { label { value } }
    activities { label { value } }
    lanes { label { value } }
  }
}
```

### Raw fallback

The GlideRecord GraphQL namespace (and the Table API) expose all ~40 `sys_pd_*`
tables — `sys_pd_process_definition`, `sys_pd_activity`, `sys_pd_lane`,
`sys_pd_trigger_instance`, `sys_pd_process_input/output`, `sys_pd_snapshot`, …
Treat these as **read-only for exploration.** The `pad` mutations keep the
definition internally consistent (snapshots, activity ordering, designer state);
raw table writes will not.

---

## Flows / Subflows / Actions → REST `/api/now/processflow/*`

Flow authoring is REST-first: the canvas reads and saves the flow model through
a scripted REST API under `/api/now/processflow/`, and uses GraphQL only for its
own UI chrome and edit-locking (`global { snFlowDesigner }`, below). Two GraphQL
namespaces touch flows and neither authors content: `snWorkflowStudio` is
feature-flag / access checks (`hasFlowGenerationAccess`, `isPluginInstalled`,
`getBuilderVersion`), and `snFlowDesigner` is panel layouts + the edit lock. The
`processflow` endpoints are not in `/api/now/doc`, so they're absent from the
OpenAPI corpus too; everything here was captured from the live designer and
re-verified standalone.

The public REST corpus has only adjacent helpers, not authoring:
`wfa_fluent/activate_flows` (bulk-activate by sys_id) and
`sn_table_builder/flows/list`.

### Confirmed endpoints

| Verb | Path | Purpose |
|---|---|---|
| `POST` | `/api/now/processflow/flow` | **Create** a flow/subflow. Requires at least `{ name, scope, type }` (`type`: `flow` \| `subflow`). Returns the full flow model incl. its new `id`. |
| `PUT` | `/api/now/processflow/flow` | **Save** — write the whole edited model back to the *collection* URL (the `id` is a field in the body). This is the designer's save call. |
| `GET` | `/api/now/processflow/flow/{sysid}` | **Read** the complete flow model (see keys below). |
| `POST` | `/api/now/processflow/versioning/create_version` | Record a version. Body `{ item_sys_id, type: "Save", annotation, favorite }`. Fired alongside each save. |
| `GET` | `/api/now/processflow/versioning/{sysid}` | Version history for a flow. |
| `GET` | `/api/now/processflow/field_types` | All pill/field data types (`address_simple`, `approval_rules`, `Array.Boolean`, …). |
| `GET` | `/api/now/processflow/flow_logic/types` | Available flow-logic blocks (If / For-each / etc.). |
| `POST` | `/api/now/processflow/action/action_types` | Action-type catalogue for the step picker. |
| `GET` | `/api/now/processflow/action/field_meta` | Field metadata for building an action. |
| `GET` | `/api/now/processflow/complexobjecttemplate` | Complex-object (data-structure) templates. |
| `GET` | `/api/now/processflow/domain/current`, `/userpreference`, `/user-activity`, `/usersecurityservice/scope/{sysid}` | Session/context helpers. |

**GraphQL side — `global { snFlowDesigner }`.** The canvas also uses GraphQL for
its own UI chrome and edit-locking (this is a *different* namespace from the
feature-flag-only `snWorkflowStudio`):

- `uiSection(name: "…")` — panel layouts the designer renders (`flowEditorHeader`,
  `flowErrorHandler`, `transformFeatures`, `advancedTriggerOptions`, …) as nested
  `name/order/elements/sections` trees.
- `safeEdit(safeEditInput: { read: "<flowId>" })` — **query** the concurrent-edit
  lock; returns `status { canUserEdit currentEditor }`.
- `safeEdit(safeEditInput: { upsert: { flowId, lastUpdated } })` — **mutation** to
  claim the lock; fired when you click *Edit flow*.

AI authoring is a separate scope, `/api/sn_text2flow/v1/build_with_ai/*`
(`create_flow`, `flow_exists`, `populate_inputs`, `populate_subflow_inputs/outputs`,
`hashtag_search`) — the "build a flow with natural language" path.

### What the designer sends, in order

Captured live from the canvas (open flow → edit → add trigger → save):

```
GET   /processflow/flow/{sysid}                         load the model
POST  /graphql   global{snFlowDesigner{uiSection(…)}}   ×3  panel layouts
GET   /processflow/versioning/{sysid}                   version history
GET   /processflow/flow_logic/types                     logic-block catalogue
POST  /graphql   snFlowDesigner{safeEdit(read:…)}       check the edit lock
POST  /graphql   snFlowDesigner{safeEdit(upsert:…)}     claim it (on "Edit flow")
POST  /processflow/versioning/create_version            snapshot on first change
PUT   /processflow/flow                                 SAVE the whole model
POST  /processflow/versioning/create_version            {type:"Save"}
```

The important find: **node edits (adding a trigger/action, setting fields) are
buffered client-side and never hit the server individually.** Persistence is one
`PUT /processflow/flow` carrying the entire model — the same read-modify-write
shape as PAD's `updateProcessData`, not the per-node stream I assumed before.

### The flow model

`GET .../flow/{sysid}` returns `result.data` with the whole definition. Notable
keys:

```
id, masterSnapshotId, name, internalName, description, type, active, status,
scope / scopeName / scopeDisplayName, runAs, runWithRoles, access,
serviceCatalogCallable, clientCallable,
triggerInstances[], actionInstances[], flowLogicInstances[], subFlowInstances[],
inputs[], outputs[], stages[], flowVariables[], annotation, natlang, category,
snapshot / masterSnapshot / latestSnapshot / jsonSnapshot, version, protection,
security, connection_configurations
```

Create → read-back → cleanup, verified end to end:

```bash
# CREATE  (scope is mandatory; a bare {name} 400s with "Flow scope is required")
curl -u "$SN_USERNAME:$SN_PASSWORD" -X POST \
  -H "Content-Type: application/json" \
  -d '{"name":"My API Flow","scope":"global","type":"flow"}' \
  "$SN_INSTANCE_URL/api/now/processflow/flow"
# -> result.data.id = <sysid>, status "draft", empty snapshot

# READ
curl -u "$SN_USERNAME:$SN_PASSWORD" \
  "$SN_INSTANCE_URL/api/now/processflow/flow/<sysid>"

# SAVE  (whole model back to the COLLECTION url — id lives in the body)
curl -u "$SN_USERNAME:$SN_PASSWORD" -X PUT \
  -H "Content-Type: application/json" \
  -d @flow-model.json \
  "$SN_INSTANCE_URL/api/now/processflow/flow"
```

### Save is read-modify-write — verified in the UI

Confirmed by driving the designer directly: create a scratch flow, add a *Record
Created* trigger in the canvas, hit *Force save*, and watch the network — the
save is a single **`PUT /api/now/processflow/flow`** carrying the whole model.
Reproduced it standalone too: `GET` the model, edit `description`, `PUT` it to the
collection URL → 200, change persisted.

Two corrections to earlier assumptions, both from this live capture:

- **The save verb is `PUT` on the collection URL `/api/now/processflow/flow`, not
  the item URL.** `PUT`/`POST`/`DELETE` on `/flow/{sysid}` all 405 — that item
  URL is read-only, which is what misled the first pass. The `id` travels as a
  field inside the PUT body.
- **The designer gzips the PUT body** (`Content-Encoding: gzip` — the payload
  starts with the `1f 8b` magic bytes), but that's only an optimization; the
  endpoint accepts **plain uncompressed JSON** just as happily (the standalone
  `PUT` above sent plain JSON and returned 200).

So flow authoring over the API is *not* the per-node grind assumed earlier — it's
the same whole-model shape as PAD. To **delete**, still use the Table API —
`DELETE /api/now/table/sys_hub_flow/{sysid}` returns 204; the processflow API has
no delete verb.

### Raw fallback

Everything persists to the `sys_hub_*` tables (`sys_hub_flow`,
`sys_hub_action_instance`, `sys_hub_trigger_instance`, `sys_hub_flow_logic`,
`sys_hub_flow_snapshot`, `sys_hub_step_instance`, …), readable/writable via the
Table API and the GlideRecord GraphQL namespace. As with PAD, the snapshot and
compiler state make raw writes fragile — fine for reading, risky for authoring.

---

## Bottom line

| | Playbooks (PAD) | Flows (Flow Designer) |
|---|---|---|
| Authoring transport | GraphQL `now { pad }` | REST `/api/now/processflow/*` (+ GraphQL `snFlowDesigner` for UI/lock) |
| Create | `createProcess` (one shot) | `POST /flow` (empty shell) |
| Update | `updateProcessData` (whole model) | `PUT /flow` (whole model, collection URL) |
| AI generate | `generateProcess` | `/api/sn_text2flow/v1/build_with_ai/*` |
| Delete | `deleteProcess` | Table API `DELETE sys_hub_flow/{id}` |
| Read-back | `getProcess` | `GET /flow/{sysid}` |
| Edit lock | — | GraphQL `snFlowDesigner { safeEdit }` |
| Stability | unversioned, DisplayableString gotcha | unversioned, undocumented, `PUT` on collection URL only |

Both are read-modify-write against a whole definition — PAD via one typed
GraphQL mutation, flows via `PUT /processflow/flow`. Neither needs per-node
calls. Constructing a valid model from scratch is still non-trivial (activity/
action definitions, snapshots, pill bindings), so for green-field authoring the
Fluent SDK (`@servicenow/sdk`, the `now-Workflow_Automation_Fluent_APIs`
surface) is usually cleaner than hand-building the JSON; these APIs shine for
*programmatic edits* to existing artifacts.
