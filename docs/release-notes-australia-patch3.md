# API surface changes: Australia Patch 2 → Patch 3

Derived on 2026-08-17 by re-scraping dev421992 and diffing the result against the committed
corpus. Not a vendor changelog — this is what the instance's own API catalogue reports, so it
covers undocumented and scoped-app endpoints that official release notes omit.

## Provenance

The instance recorded the upgrade in `sys_upgrade_history`:

```
2026-08-13 15:54:25   glide-australia-02-11-2026__patch2-04-17-2026
                   →  glide-australia-02-11-2026__patch3-05-25-2026
```

49 upgrade rows landed that day. The committed baseline predates it on both sides
(`openapi/_summary.json` generated 2026-08-09, `graphql/_summary.json` 2026-08-11), so the diff is
a clean patch 2 → patch 3 capture with no straddling.

Reproduce with:

```bash
npm run scrape:openapi && git diff --stat openapi/
```

| Corpus | Before | After |
|---|---|---|
| OpenAPI specs | 342 | 345 |
| OpenAPI namespaces | 90 | 91 |
| Scripted GraphQL namespaces | 26 | 27 |

**No REST endpoint was removed.** Every change in the OpenAPI diff is an addition; the only deleted
lines on that side are the three metadata fields in `_summary.json`.

**GraphQL is a different story — one schema was removed outright.** See
[Removed: `global.metrics`](#removed-globalmetrics) below. If you only read one section, read that
one.

## New APIs

### `now` — platform

These ship with the WAR rather than an app-store package, so they are the substantive additions.

#### OAuth APIs — `/api/now/oauth`

| Method | Path |
|---|---|
| GET | `/api/now/oauth/jwks` |
| GET | `/api/now/oauth/trusted_issuers` |

`sys_ws_definition` "OAuth APIs", Global scope. `trusted_issuers` is described as *"Returns the
trust registry entry for a protected resource: resource metadata + e…"* (the platform truncates
`short_description` at 80 characters, so the sentence is cut off at the source, not by the scrape).

This is the pair worth attention. A JWKS endpoint publishes the instance's public signing keys, and
a trusted-issuers registry declares which external issuers the instance will accept tokens from.
Together they are the shape of standards-based JWT trust: a third party can verify a
ServiceNow-issued token without a shared secret, and the instance can validate inbound tokens
against a registry rather than per-integration config.

Caveat on dating: the `sys_ws_definition` record carries `sys_created_on` of **2025-10-02**, and the
`trusted_issuers` operation **2026-05-07**. Shipped records keep the timestamp from where
ServiceNow authored them, so those dates say when the feature was built, not when it reached this
instance. What the diff establishes is that the endpoints were **not exposed in this instance's API
catalogue before the upgrade and are now** — activation, not authorship.

#### Evaluation Token Provider — `/api/now/evaluation_auth_token_provider`

| Method | Path | Body |
|---|---|---|
| POST | `/api/now/evaluation_auth_token_provider` | `application/json`, `application/xml`, `text/xml` |

Global scope, no description published. Name and shape suggest token minting for evaluation/trial
entitlement checks; treat the purpose as unconfirmed until the operation script is read.

### `sn_ip_survey` — In-Product Survey (v29.0.2)

| Method | Path |
|---|---|
| GET | `/api/sn_ip_survey/ips_state` |
| POST | `/api/sn_ip_survey/ips_suppression` |

Both `sys_ws_definition` records were created **2026-08-13 08:58**, in the same maintenance window
as the platform patch. Read current survey state for a user; suppress surveys for one. Relevant if
in-product survey prompts are unwanted in a demo or recorded environment — suppression now has a
documented-enough API instead of a property hunt.

## Endpoints added to existing APIs

| Scope | Added |
|---|---|
| `sn_build_agent` — Build Agent (Trial) v2.3.3 | `GET /{scopeId}/getIsGeneratedByBA`, `POST /{scopeId}/sysAppInfo` |
| `sn_udc` — Unified Developer Core v29.2.8 | `POST /file/collections`, `PATCH /file/collections` |
| `sn_experiment_core` — Experimentation Framework Core v1.1.10 | `PUT /experiments/toggle-opt-out` |

`sn_build_agent` is the clearest pattern: the API already had `getIsGeneratedByAI` and a scope-less
`POST /sysAppInfo`. Patch 3 adds `{scopeId}`-parameterised variants plus a separate
*generated-by-Build-Agent* flag distinct from the existing *generated-by-AI* flag — the platform is
now tracking which app was produced by which generator, not just that a generator was involved.

## Removed: `global.metrics`

The only breaking change in this patch. The `metrics` scripted schema under the `global` namespace
is gone — both root fields and every associated type:

```graphql
# Patch 2 — worked
global { metrics { interactions(paging: {limit: 10}) { pageName pageLoadTime } } }
mutation { global { metrics { interaction(interaction: {...}) } } }
```

```graphql
# Patch 3 — HTTP 200 with an in-band error
{"errors":[{"message":"Validation error (FieldUndefined@[global/metrics]) :
  Field 'metrics' in type 'global_query' is undefined",
  "validationErrorType":"FieldUndefined"}]}
```

Verified live on 2026-08-17, not merely inferred from the scrape diff. There is no longer a
`sys_graphql_schema` record matching `metrics` on the instance, so this is a removal rather than the
scope-protection case that makes some schemas introspect as empty object types.

`global_query` now exposes only `DataResource`, `snFlowDesigner`, and `snTriggerDesigner`.

What was lost was the client-telemetry surface: a `interactions(paging)` query and an
`interaction(...)` mutation over a large `ClientInteraction` input — page load time, time to
interaction, UXF data-broker counts and timings, client-script timings, UI-policy time, cache
hit/miss/stale counters. Anything ingesting or reading UX telemetry through GraphQL breaks on
upgrade and needs a different route.

Note the failure mode: this returns **HTTP 200** with `errors[]`, consistent with the in-band error
behaviour documented in the GraphQL guide. Code that checks only the status code will read this
removal as a success with null data.

## GraphQL additions

One new scripted namespace, `snSpokeBuilder`, exposing a capability-probe query surface:

```graphql
snSpokeBuilder { spokeGenerator {
  getSysPropertyValue(propertyName: String!, defaultValue: String): String
  hasRole(roleName: String!): Boolean
  isPluginInstalled(pluginName: String!): Boolean
  isPluginEntitled(pluginName: String!): Boolean
  isSkillEnabled(skillId: String!): Boolean
} }
```

Useful beyond spoke generation: `isPluginInstalled` / `isPluginEntitled` / `hasRole` are a cheap
single-round-trip entitlement check that would otherwise mean querying `v_plugin`, `sys_user_role`,
and `sys_properties` separately.

The `now` namespace gained one field — `configuration: now_wrapUpSegment_Configuration` on the
wrap-up segment type (Contact Center / interaction wrap-up).

## Reading the specs

Two artefacts of the Australia generator, both pre-existing and unrelated to this patch:

- Every new operation reports `"responses": {}`. Australia-family instances do not populate
  response schemas; paths, methods, parameters, and request-body content types are accurate.
- `description` is truncated to 80 characters, and the truncation is stored in `sys_ws_operation`
  itself — re-reading from the table does not recover the full sentence.
