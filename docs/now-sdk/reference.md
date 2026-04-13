# now-sdk CLI Reference

Complete reference for `@servicenow/sdk` v4.5.0. Documented and undocumented commands and flags, verified by reading the installed CLI source.

> **Read this whenever you're about to run any `now-sdk` command.** Several useful flags are hidden from `--help` and several commands aren't listed in the top-level menu. Always look here first; the official `--help` output is incomplete.
>
> If the user has updated their SDK version, re-verify by reading `<global-npm-prefix>/lib/node_modules/@servicenow/sdk/node_modules/@servicenow/sdk-cli/src/command/`.

---

## Installation

```bash
npm install -g @servicenow/sdk
```

This installs:
- `now-sdk` — the main CLI (this file).
- `now-sdk-debug` — debug helper variant.
- `@servicenow/sdk` — module providing `@servicenow/sdk/core`, `@servicenow/sdk/api`, etc., used inside Fluent project code.

**Engine requirement:** Node.js >= 20.18.0.

---

## Global options

Available on every command:

| Flag | Alias | Default | Purpose |
|---|---|---|---|
| `--debug` | `-d` | `false` | Verbose debug logging — use whenever a command fails for clearer output. |
| `--help` | `-h` | — | Show command help. |
| `--version` | `-v` | — | Show CLI version. |

---

## Commands — Documented

### `now-sdk auth`

Manage instance credentials. Mutually exclusive modes — pick exactly one of `--add`, `--delete`, `--use`, `--list`.

| Flag | Alias | Type | Purpose |
|---|---|---|---|
| `--add <host>` | — | string | Register credentials for an instance. `<host>` can be a full URL or a short name; if short, it's expanded to `https://<host>.service-now.com`. |
| `--type` | — | `basic`\|`oauth` | Auth type for `--add`. Defaults to `basic`. |
| `--alias <name>` | — | string | Alias name for the new credential. If omitted with `--add`, prompts interactively. |
| `--delete <alias>` | — | string | Remove a stored credential. |
| `--use <alias>` | — | string | Set this credential as the default for subsequent commands. |
| `--list` | — | boolean | List all stored credentials. The default one is marked with `*` and green. |

**Behavior notes:**
- Basic auth actually performs a UI session token login (not just stored Basic header) — credentials are validated against the instance at `--add` time.
- Credentials are stored via `@napi-rs/keyring` in the OS keychain.

```bash
now-sdk auth --add mydev --type basic --alias mydev   # adds + prompts for username/password
now-sdk auth --use mydev                              # sets as default
now-sdk auth --list                                   # see all
```

---

### `now-sdk init` (alias: `create`)

Initialize a new app, apply a template to an existing app, or convert a legacy scoped app from the instance.

| Flag | Alias | Type | Purpose |
|---|---|---|---|
| `--from <sys_id_or_path>` | — | string | **Convert mode.** A 32-char hex sys_id pulls a legacy scoped app from instance; a directory path converts a local legacy scoped app. Conflicts with `--scopeName`/`--appName`. |
| `--appName <name>` | — | string | App display name for new project. |
| `--packageName <name>` | — | string | npm package name (must follow npm naming). If `package.json` already exists, its `name` overrides this. |
| `--scopeName <scope>` | — | string | ServiceNow app scope. Must start with vendor prefix if applicable, max 18 chars. |
| `--auth <alias>` | `-a` | string | Credential to use (required for instance-based convert). |
| `--template <id>` | — | string | Project template. Choices vary by SDK version; current set: `partial.javascript.react`, `partial.javascript.basic`, `partial.typescript.react`, `partial.typescript.vue`, `partial.typescript.basic`, `partial.typescript.react-devserver`. |
| `--sdkVersion <semver>` | — | string | **Hidden.** Pin a specific SDK version in scaffolded `package.json`. Useful for matching CI environments. |
| `--noUpdate` | — | boolean | **Hidden.** Skip the npm version-check that runs on init. Use in offline/air-gapped or fast-iteration scenarios. |

**Behavior notes:**
- If a `now.config.json` already exists in cwd, `init` switches into "apply a template to existing project" mode instead of scaffolding fresh.
- After init, run `npm install` before anything else (it's a normal Node project).
- Global-scope projects get a hint to use `now-sdk move` for customization.

---

### `now-sdk download <directory>`

Download an existing scoped app's metadata from the instance into the given directory. Different from `init --from`: `download` materializes the existing app (metadata-as-files), `init --from` creates a Fluent project from a legacy app.

| Flag | Alias | Type | Default | Purpose |
|---|---|---|---|---|
| `<directory>` | — | string (positional) | required | Target directory to expand into. |
| `--source` | — | string | cwd | Path to project containing `package.json`. |
| `--incremental` | — | boolean | `false` | Download only changes (faster on subsequent pulls). |

---

### `now-sdk build [source]`

Compile Fluent → app package.

| Flag | Alias | Type | Default | Purpose |
|---|---|---|---|---|
| `[source]` | — | string (positional) | cwd | Project directory. |
| `--frozenKeys` | — | boolean | `false` | Validate that all `Now.ID` keys/sys_ids are pinned (CI safety). Build fails if anything would change. |
| `--ids <sys_id...>` | — | string array | — | **Hidden.** Build only records matching these sys_ids. Useful for fast iteration when working on a single record. |
| `--profile` | — | boolean | `false` | **Hidden.** Emit a `.cpuprofile` for the build process. Use when diagnosing slow builds. |

---

### `now-sdk install` (alias: `deploy`)

Push the built app to the active instance. **Confirm with the user before running** — modifies the live instance.

| Flag | Alias | Type | Default | Purpose |
|---|---|---|---|---|
| `--source` | — | string | cwd | Project directory. |
| `--reinstall` | `-r` | boolean | `false` | Uninstall first, then install. **Destructive: instance-only metadata is lost.** |
| `--auth` | `-a` | string | active default | Credential alias. |
| `--open-browser` | `-b` | boolean | `false` | Open `sys_app` page in default browser on success. |
| `--info` | `-i` | boolean | `false` | Print URL for this app's most recent install in the Upgrade History table. Doesn't actually install. |
| `--demoData` | — | boolean | `true` | Install demo data along with the app. |
| `--skip-flow-activation` | — | boolean | `false` | Skip activating (publishing) flows after install. Useful when you'll activate them by hand. |
| `--store` | `-s` | boolean | `false` | **Hidden.** Install as `sys_store_app` instead of `sys_app` (custom application). Use when targeting Store-style packaging. |
| `--async` | — | boolean | `false` | **Hidden.** Don't block waiting for install to complete. |
| `--maven` | — | boolean | `false` | **Hidden.** Install a Maven assembly's `*-app.zip` output (Java build pipeline interop). |
| `--targetUpdateSet <sys_id>` | — | string | — | **Hidden.** For `configuration`-type apps, write changes into this specific update set sys_id instead of letting the SDK pick. |

**Notes:**
- `configuration`-type projects use a different install path: changes go to an update set rather than installing as an app.
- Install URL on success points to `<host>/sys_app.do?sys_id=<scope>` (or `sys_store_app.do` if `--store`).

---

### `now-sdk dependencies [sysIds..]`

Pull dependency apps and TypeScript type definitions for the records you depend on.

| Flag | Alias | Type | Default | Purpose |
|---|---|---|---|---|
| `[sysIds..]` | — | string array (positional) | `[]` | sys_ids to add when used with `--add`. |
| `--directory` | — | string | cwd | Project directory. |
| `--auth` | `-a` | string | — | Credential alias. |
| `--type-defs-only` | — | boolean | — | Download only `glide.*.d.ts` type definitions, skip everything else. |
| `--fluent-only` | — | boolean | — | Download only Fluent types from `now.config.json` dependencies. |
| `--add <table>` | — | string | — | Add a new dependency entry (e.g., `actions`, `triggers`, `sys_security_acl`). Requires `--scope`. |
| `--scope <scope>` | — | string | — | Scope to add the dependency under (e.g., `global`, `x_my_app`). Required with `--add`. |

---

### `now-sdk transform`

Convert ServiceNow XML records into Fluent source. **This is the only correct way to produce Fluent from ServiceNow records — never hand-translate.**

| Flag | Alias | Type | Default | Purpose |
|---|---|---|---|---|
| `--from <path>` | — | string | — | Path to local XML file or directory. Use when you have UNL XML on disk. Conflicts with `--mode`/`--auth`. |
| `--directory` | — | string | cwd | Project directory. |
| `--auth` | `-a` | string | — | Credential alias for instance-based pull. |
| `--format` | `-f` | boolean | `true` | Auto-format generated source. |
| `--mode` | `-m` | `complete`\|`incremental` | — | **Hidden.** Application fetch mode. `complete` = full app re-download. `incremental` = only changed records (sys_update_xml-driven). Conflicts with `--from`/`--id`. |
| `--id <sys_id>` | — | string | — | **Hidden — and important.** sys_id of a single record to transform with relationships. Must be paired with `--table`. Conflicts with `--from`/`--mode`. |
| `--table <table>` | — | string | — | **Hidden.** Table name for the record(s) referenced by `--id`. |
| `--ids <sys_id...>` | — | string array | — | **Hidden.** Multiple sys_ids to transform. Conflicts with `--id`/`--table`. |
| `--updateSet <sys_id>` | — | string | — | **Hidden.** sys_id of an update set to transform from. Pulls every record in the update set. |
| `--maxUpdateCount <n>` | — | number | — | **Hidden.** Cap on records when using `--updateSet`. |
| `--profile` | — | boolean | `false` | **Hidden.** Emit a `.cpuprofile` for the transform. |

**Conflict matrix:**
- `--from` ⊥ `--mode`, `--auth`
- `--ids` ⊥ `--id`, `--table`
- `--id` ⊥ `--from`, `--mode`
- `--id` requires `--table` (and vice versa)

**Transformation has two paths — try them in order:**

**Primary:** Let the CLI fetch and transform in one step.
```bash
now-sdk transform --id <sys_id> --table <table> --auth <alias>
```

**Fallback (used when the primary path fails — which is often):** Fetch the UNL XML directly from the instance, save it locally, and feed it via `--from`.
```bash
# 1. Fetch UNL XML (curl with stored basic-auth creds, or via browser session)
curl -u "$USER:$PASS" \
  "https://<instance>.service-now.com/<table>.do?UNL&sysparm_query=sys_id=<sys_id>" \
  -o /tmp/record.xml

# 2. Hand the local XML to the transformer
now-sdk transform --from /tmp/record.xml
```

Many records (custom tables, records with unusual ACLs, certain platform record types) make the `--id`/`--table` path error out. When that happens, **switch to UNL fallback — do not hand-translate.**

Other transform modes:
- `--ids <sys_id...> --auth <alias>` — batch of records by sys_id (also subject to the same failure modes; UNL fallback works per-record).
- `--updateSet <sys_id> --auth <alias>` — pull every record in an update set in one shot.
- `--from <path>` — point at a directory of XML files for bulk local transformation.

---

### `now-sdk clean [source]`

Delete the build output directory.

| Flag | Type | Default | Purpose |
|---|---|---|---|
| `[source]` | string (positional) | cwd | Project directory. |

No other flags beyond globals.

---

### `now-sdk pack [source]`

Zip the built app into a single installable artifact.

| Flag | Type | Default | Purpose |
|---|---|---|---|
| `[source]` | string (positional) | cwd | Project directory. |

No other flags beyond globals.

---

### `now-sdk explain <api> [source]`

Print Fluent API documentation for a constructor (e.g., `BusinessRule`, `Acl`). **Use this whenever you're unsure of a constructor's signature** — it's the offline replacement for the docs website.

| Flag | Type | Default | Purpose |
|---|---|---|---|
| `<api>` | string (positional, required) | — | API/constructor name. |
| `[source]` | string (positional) | cwd | Project directory (so it can find the installed SDK version). |

```bash
now-sdk explain BusinessRule
now-sdk explain Table
now-sdk explain Acl
```

---

## Commands — Undocumented (hidden from `now-sdk --help`)

### `now-sdk run <script>`

Run a script defined in the project's configuration. Hidden via yargs `false` description in command registration.

| Flag | Alias | Type | Default | Purpose |
|---|---|---|---|---|
| `<script>` | — | string (positional, required) | — | Name of the script to run. |
| `[cwd]` | — | string (positional) | process cwd | Working directory. |
| `--auth` | `-a` | string | — | Credential alias. |

Listens for SIGINT and emits telemetry on exit, suggesting it's intended for long-running scripts.

---

### `now-sdk move`

Claim records from a *different* application on the instance into the current app's scope. Hidden via yargs `false` description.

| Flag | Alias | Type | Default | Purpose |
|---|---|---|---|---|
| `--ids <sys_id...>` | — | string array | required | sys_ids of records to move into this app. |
| `--source` | — | string | cwd | Project directory. |
| `--auth` | `-a` | string | — | Credential alias. |

Useful when developing in `global` scope (the `init` command actually hints at this for global-scope projects).

```bash
now-sdk move --ids abc123 def456 --auth mydev
```

---

## Removed/Dead Commands

### `now-sdk upgrade` — DOES NOT EXIST

The directory `src/command/upgrade/` exists but the entire `index.ts` is commented out. The command is not registered with yargs. Don't tell the user this command exists.

To upgrade the SDK, the user runs:
```bash
npm install -g @servicenow/sdk@latest
```

---

## Workflow Cheat Sheet

| User intent | Command |
|---|---|
| New blank app | `now-sdk init --appName <name> --scopeName <scope> --packageName <pkg>` |
| Convert legacy scoped app from instance | `now-sdk init --from <app_sys_id> --auth <alias>` |
| Pull existing app metadata | `now-sdk download <dir> --auth <alias>` (add `--incremental` on subsequent pulls) |
| Transform ONE record by sys_id (preferred) | `now-sdk transform --id <sys_id> --table <table> --auth <alias>` |
| Transform ONE record (UNL fallback when above fails) | `curl -u "$U:$P" "https://<inst>/<table>.do?UNL&sysparm_query=sys_id=<sys_id>" -o /tmp/r.xml && now-sdk transform --from /tmp/r.xml` |
| Transform MANY records | `now-sdk transform --ids <id1> <id2> ... --auth <alias>` |
| Transform an update set | `now-sdk transform --updateSet <sys_id> --auth <alias>` |
| Transform local XML files | `now-sdk transform --from <path>` |
| Build everything | `now-sdk build` |
| Build only specific records (fast iteration) | `now-sdk build --ids <sys_id...>` |
| Build for CI with key validation | `now-sdk build --frozenKeys` |
| Install to default instance | `now-sdk install` (CONFIRM WITH USER) |
| Install with full reset | `now-sdk install --reinstall` (DESTRUCTIVE — confirm with user) |
| Install as Store app | `now-sdk install --store` |
| Get last-install URL without installing | `now-sdk install --info` |
| Add a dependency | `now-sdk dependencies --add <table> --scope <scope>` |
| Just refresh type defs | `now-sdk dependencies --type-defs-only` |
| Look up Fluent API | `now-sdk explain <ConstructorName>` |
| Move a record from another app into this one | `now-sdk move --ids <sys_id...> --auth <alias>` |
| Run project script | `now-sdk run <script-name>` |
| Clean build output | `now-sdk clean` |
| Zip built app | `now-sdk pack` |

---

## How to Verify This Reference is Current

If something here doesn't match the user's installed CLI:

```bash
# Find install location
which now-sdk

# Inspect the registered commands
ls $(npm root -g)/@servicenow/sdk/node_modules/@servicenow/sdk-cli/src/command/

# Find hidden flags in any command
grep -rn 'hidden\s*:\s*true' $(npm root -g)/@servicenow/sdk/node_modules/@servicenow/sdk-cli/src/command/

# Find commands hidden from top-level menu (registered with `false` as description)
grep -rn ".command(" $(npm root -g)/@servicenow/sdk/node_modules/@servicenow/sdk-cli/src/index.ts
```
