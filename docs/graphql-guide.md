# GlideRecord over GraphQL: A Practical Alternative to the Table API

Inside ServiceNow's GraphQL endpoint lives a generated **GlideRecord schema**:
query, insert, update, and delete fields for every table on the instance —
the same records you'd reach through the REST Table API, on the same auth and
ACLs. Most integrators never touch it, because almost all documentation and
tooling points at the Table API. That's a shame, because for read-heavy work
GlideRecord-over-GraphQL does several things the Table API structurally
cannot: fetch many tables in one request, return total counts alongside a
page, dot-walk references server-side, and hand you field metadata — labels,
mandatory flags, live ACL verdicts, even choice lists — inline with the data.

This guide is tool-agnostic: everything below is plain HTTP you can issue from
curl, Postman, or any GraphQL client. Examples were verified live against an
**Australia Patch 2** instance; the generated schema described here has been
stable across recent releases.

## When to use GlideRecord GraphQL vs. the Table API

> **The two headline wins.** One round trip for what would be N Table API
> calls — several tables, several filters, aggregates, even several
> **mutations** in a single request — and **live ACL verdicts** riding inline
> with the data: `canRead`, `canWrite`, `canCreate`, `canDelete` at table and
> field level, evaluated for the calling user, answered before you attempt
> anything.

Use **GlideRecord over GraphQL** when you want:

- **several queries — or several mutations — in one round trip**: what takes
  N sequential Table API calls is one HTTP request here;
- **ACL verdicts and field metadata inline** — labels, mandatory flags,
  choice lists, and per-user `can*` checks, without touching
  `sys_dictionary` or trial-and-erroring a 403;
- a total count with the page (`_rowCount`);
- per-field display-value control;
- structured dot-walking through references;
- comments/work notes for many records in one request.

Stay on **the Table API** for:

- writes you need to confirm from the response;
- attachments, import sets, and every procedural API (CICD, Performance
  Analytics scorecards, Change Management state operations) — none of those
  have a GraphQL surface;
- streaming/eventing (use the Table API + polling, or the AMB record-watcher
  channel the UI uses).

Everything on those lists is unpacked below.

## The endpoint

```
POST https://<instance>.service-now.com/api/now/graphql
Content-Type: application/json
```

Authentication is whatever your instance's REST APIs accept — basic auth and
OAuth bearer tokens both work, with the same users, roles, and ACLs as the
Table API. The request body is standard GraphQL-over-HTTP:

```json
{
  "query": "query ($id: String!) { ... }",
  "variables": { "id": "..." },
  "operationName": "OptionalWhenMultipleOps"
}
```

There is also a GraphiQL client built into the platform: **System Web
Services → GraphQL → GraphQL API Explorer**, which is the easiest place to
experiment interactively.

## Where GlideRecord lives in the schema

The merged schema served by that one endpoint has two kinds of content, and
this guide is about the second:

- **Scripted namespaces** (`now`, `global`, `sn*`): hand-written APIs backing
  specific ServiceNow features — chat, Playbook, Flow Designer tooling.
  Unless you're building against one of those features, skip them.
- **The generated GlideRecord namespaces** — the Table API's records, as
  GraphQL:
  - `GlideRecord_Query.<table>` — a query field for *every* table
    (~6,200 on a stock instance),
  - `GlideRecord_Mutation.insert_<table> / update_<table> / delete_<table>`,
  - `GlideAggregateRecord_Query` — server-side aggregates.

### Introspection is off by default

Introspection is disabled out of the box and gated by two system properties
(**System Web Services → GraphQL → Properties**), both `false` by default:

- `glide.graphql.introspection_enabled` — introspective queries against the
  scripted schemas. Even when enabled, the caller needs the
  `graphql_schema_admin` role.
- `glide.graphql.glide_record_schema.introspection_enabled` — same for the
  generated GlideRecord schema (the ~6,200-table surface).

Flip them on a PDI or sub-production instance while you explore, and leave
them **off in production** — ServiceNow's own docs say plainly: "Do not use
introspective queries in a production environment." An open schema hands any
authenticated caller a complete map of your tables and mutations, and full
introspection is also expensive to compute (see below). Your integration
doesn't need it at runtime: queries and mutations work fine with
introspection disabled.

Two practical warnings when you do introspect: the full introspection
response is enormous (tens of megabytes — every table gets several generated
types) and takes minutes to compute. Introspect once and cache it, or
introspect narrowly with `__type(name: "...")`. Also note the server rejects
introspection documents that mention a meta-field like `__Type.fields` more
than once ("bad faith introspection"), so stick to the standard single-fragment
introspection query.

## Reading records

The basic query shape, for one table:

```graphql
query {
  GlideRecord_Query {
    incident(
      queryConditions: "active=true^ORDERBYDESCsys_updated_on",
      pagination: { limit: 5, offset: 0 }
    ) {
      _rowCount
      _results {
        number { value }
        short_description { value }
        state { value displayValue }
      }
    }
  }
}
```

Things to know:

- **`queryConditions` is the encoded-query syntax** you already use in
  `sysparm_query`: `^` for AND, `^OR`, `LIKE`, `IN`, dot-walked conditions,
  `ORDERBY`/`ORDERBYDESC`, `javascript:gs.daysAgoStart(7)` — all of it.
- **`sys_id: "..."` instead of `queryConditions`** fetches one record. Either
  way, `_results` is always an array.
- **Every column is an object, not a scalar.** You select `value` (the raw
  stored value), `displayValue` (the human rendering), or both, *per field* —
  unlike REST's all-or-nothing `sysparm_display_value`. Remember that
  `displayValue` for dates is rendered in the calling user's timezone and
  date format, while `value` is UTC.
- **`_rowCount` is the total match count**, independent of your pagination
  limit — the number the Table API can't give you without a second call to
  the Aggregate API. Pass `omitCount: true` to skip computing it on huge
  tables.
- **Unselected fields simply don't appear.** There is no default field set.

### Passing values safely: use variables

Don't splice user input into the document. GraphQL variables exist for this:

```json
{
  "query": "query ($id: String!) { GlideRecord_Query { incident(sys_id: $id) { _results { number { value } } } } }",
  "variables": { "id": "47a91e3c2f8acf107efd1d707fa4e387" }
}
```

Encoded query strings can be variables too (`$qc: String!` →
`queryConditions: $qc`).

### Many tables, one request

This is GraphQL's headline feature and it works exactly as you'd hope —
aliases let you hit the same table twice under different conditions, and
aggregates can ride along (see below). Mutations batch the same way (see
[Mutations](#mutations-and-why-you-should-be-careful)):

```graphql
query {
  GlideRecord_Query {
    p1: incident(queryConditions: "active=true^priority=1") {
      _rowCount
      _results { number { value } }
    }
    p2: incident(queryConditions: "active=true^priority=2") { _rowCount }
    sys_user(queryConditions: "active=true", pagination: { limit: 3 }) {
      _results { user_name { value } }
    }
  }
}
```

### Dot-walking through references

Reference columns carry a `_reference` field that opens the target table's
full type — pick any fields there, including further references:

```graphql
query {
  GlideRecord_Query {
    incident(queryConditions: "active=true", pagination: { limit: 5 }) {
      _results {
        number { value }
        assigned_to {
          displayValue
          _reference {
            email { value }
            manager { displayValue }
          }
        }
      }
    }
  }
}
```

REST can dot-walk in `sysparm_fields`, but you get flat strings; here you get
structured nesting with per-field control at every level.

## Schema discovery built into the data

The generated types carry the data dictionary with them, evaluated **for the
calling user** — often more useful than querying `sys_dictionary`/`sys_choice`
yourself.

**Table level** — available on every table query:

```graphql
query {
  GlideRecord_Query {
    incident(pagination: { limit: 1 }) {
      _table_metadata { label plural canRead canWrite canCreate canDelete auditWanted }
    }
  }
}
```

Those `can*` fields are live ACL verdicts: "can I create incidents?" answered
before you try.

**Field level** — every column object also exposes `label`, `internalType`,
`isMandatory`, `canRead`/`canWrite`/`canCreate`, and (on choice fields) the
choice list:

```graphql
query {
  GlideRecord_Query {
    incident(pagination: { limit: 1 }) {
      _results {
        state {
          label internalType isMandatory canWrite
          _choices { value displayValue }
        }
        assigned_to { label referenceTableName }
      }
    }
  }
}
```

Returns `State` / `integer` / the six state choices with their labels, and
`assigned_to → sys_user`. Choice lists are evaluated in record context, so
dependent choices resolve the way the form would show them — and the empty
"None" option is included, which the raw `sys_choice` table omits.

**The one caveat:** field-level metadata hangs off `_results` rows, so you
need at least one row you're allowed to read (hence the `limit: 1` carrier
row). An empty or fully ACL-filtered table gives you nothing at the field
level — fall back to `sys_dictionary` for that case.

## Aggregates

`GlideAggregateRecord_Query` is a root field of its own — note the arguments
are on the field itself:

```graphql
query {
  GlideAggregateRecord_Query(
    tableName: "incident",
    queryConditions: "active=true",
    groupBy: ["state"]
  ) {
    totalCount
    totalGroupsCount
    aggregates {
      groupBy { field value displayValue }
      count
    }
  }
}
```

Each group row offers `count`, `avg`, `min`, `max`, `sum`, and
`countDistinct`; the root also takes `having`, `orderBy`, and
`groupPagination`. Because it's just another root field, an aggregate can
share a request with record reads.

## Comments and work notes (journal fields)

Worth its own section, because the access model surprises everyone.

Journal entries (comments, work notes) are stored one-per-row in
`sys_journal_field` — the record itself stores nothing. That table is
**ACL-locked for non-admin roles**: query it as an `itil` user and you get the
row *count* with an empty result set (the count leaks through row ACLs; the
rows don't), and the aggregate route is denied outright.

What every role that can read the record *can* read is the record's rendered
journal columns:

```graphql
query ($id: String!) {
  GlideRecord_Query {
    incident(sys_id: $id) {
      _results {
        comments { displayValue }
        work_notes { displayValue }
        comments_and_work_notes { displayValue }
      }
    }
  }
}
```

`displayValue` is the full entry stream — every entry, newest first, formatted
as:

```
2026-08-11 10:40:20 - Abey Ahmad (Work notes)
the note text

2026-08-10 07:40:58 - Abey Ahmad (Comments)
an earlier comment
```

It's parseable (header line = timestamp, ` - `, author, parenthesized field
label; entries separated by a blank line), with two caveats: timestamps are in
the calling user's timezone and date format, and it's a rendering, not rows.
If your integration user has admin-level read on `sys_journal_field`, query it
directly instead for exact rows:

```graphql
query ($qc: String!) {
  GlideRecord_Query {
    sys_journal_field(queryConditions: $qc, pagination: { limit: 100 }) {
      _results {
        element { value }          # "comments" | "work_notes"
        value { value }            # the note text
        sys_created_on { value }   # UTC
        sys_created_by { value }   # username
      }
    }
  }
}
```

with `$qc = "element_id=<record_sys_id>^ORDERBYDESCsys_created_on"`.

## Mutations — and why you should be careful

Every table gets `insert_`, `update_`, and `delete_` mutations, one String
argument per column; `update_`/`delete_` take `sys_id`. Journal fields accept
input like any other column, so this adds a work note:

```graphql
mutation ($id: String!) {
  GlideRecord_Mutation {
    update_incident(sys_id: $id, work_notes: "checked the router") {
      _rowCount
      _results { number { value } }
    }
  }
}
```

### Mutations batch too

Aliases work in mutations exactly as in queries, so several writes — across
several tables — go out as one request:

```graphql
mutation ($p1: String!, $dup: String!) {
  GlideRecord_Mutation {
    noteRouter: update_incident(sys_id: $p1, work_notes: "checked the router") {
      _results { number { value } }
    }
    closeDup: update_incident(sys_id: $dup, state: "7", close_code: "Duplicate",
                              close_notes: "dupe of INC0010001") {
      _results { number { value } }
    }
    logIt: insert_u_integration_log(u_source: "netops-bot", u_message: "swept P1 queue") {
      _rowCount
    }
  }
}
```

What would be three Table API calls — two PATCHes and a POST — is one round
trip. Each aliased field reports its own in-band error if it fails, so check
the `errors` array (see below) *and* verify the writes; the null-result
caveat next applies to every one of them.

Two hard-won cautions:

1. **A successful mutation can return `_rowCount: null, _results: null`.**
   You cannot reliably confirm a write from the mutation response — re-query
   the record (or the journal table) to verify. If your stack already speaks
   the REST Table API, a defensible policy is: *reads via GraphQL where it
   wins, writes via REST*, because REST reliably echoes the written record.
2. **Update semantics are partial** (PATCH-like). There is no
   replace/PUT-style mutation — which, given how dangerous blanking omitted
   fields would be, is a feature.

## Error handling: the trap that catches everyone

GraphQL reports failure **in-band**. A query with a typo'd field, a validation
problem, or an ACL denial still returns **HTTP 200** — the failure is in an
`errors` array in the body, sometimes alongside partial `data`:

```json
{
  "data": null,
  "errors": [
    {
      "message": "Validation error (FieldUndefined@[x]) : Field 'x' in type 'QueryType' is undefined",
      "errorType": "ValidationError"
    }
  ]
}
```

If your HTTP client only checks status codes, every failed query looks like a
success. Always check for a non-empty `errors` array before trusting `data`.
(HTTP-level failures still happen for transport and auth problems — a bad
credential is a real 401.)

Related: an ACL-filtered read *also* looks like success. `_rowCount` above
zero with an empty `_results` is the signature of row-level ACLs removing
everything — the GraphQL equivalent of the UI's "rows removed due to security
constraints" — not an empty table.

## Quick reference

| Concept | Where |
|---|---|
| Endpoint | `POST /api/now/graphql` |
| Read | `GlideRecord_Query.<table>(sys_id \| queryConditions, pagination, omitCount)` |
| Results | `_rowCount`, `_results[] { <col> { value displayValue } }` |
| References | `<col> { _reference { ... } }` |
| Choices | `<col> { _choices { value displayValue } }` |
| Table meta | `_table_metadata { label plural canRead canWrite canCreate canDelete }` |
| Aggregates | `GlideAggregateRecord_Query(tableName, queryConditions, groupBy, having, orderBy)` |
| Write | `GlideRecord_Mutation.insert_/update_/delete_<table>` — verify by re-query |
| Errors | in-band: HTTP 200 + `errors[]`; check it every time |
