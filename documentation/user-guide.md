# User Guide

CodeIndex MCP is a local, read-only code index. It finds declarations,
references, and dependency consumers and reads small source ranges without
repeated broad searches.

An optional loopback console exposes status, aggregate analytics, and
non-destructive operational jobs.

## Scope

Version 0.1.0 indexes authored source selected by one or more extractor projects:

- TypeScript and JavaScript, using the TypeScript compiler API;
- JavaScript only when the project enables `allowJs`;
- several TypeScript project contexts in one atomic generation, each retaining its
  own compiler options and configuration digest.

It does not index:

- declaration files (`.d.ts`, `.d.mts`, `.d.cts`) as authored source;
- generated output or vendored dependencies;
- files not reachable from any configured project file;
- other languages or cross-language relationships;
- runtime behavior, full-text search, fuzzy search, or embeddings.

Package names are not indexed symbols. Use `find_dependencies` for direct
external dependency usage or downstream dependency impact.

Current constraints:

- one local workspace per configuration; one or more TypeScript project contexts;
- every configured project must build successfully before the generation is
  published;
- full-generation rebuilds rather than incremental compiler state;
- path/range-based symbol identity;
- exact and prefix symbol search only;
- definition/reference roles only;
- no automatic import expansion;
- queries are available through MCP; operational commands through the CLI.

## Install

The package is consumed directly from GitHub. No npm publication is performed.

```bash
pnpm add github:doberkofler/codeindex-mcp#v0.7.0
```

Pin a released tag, never `main`. The Git dependency runs `prepare`, which builds
`dist/mcp.mjs`, `dist/cli.mjs`, `dist/console.mjs`, and `dist/console/`.

pnpm 12 requires both the Git dependency build and the `oracledb` install script to
be allowed:

```yaml
# pnpm-workspace.yaml
allowBuilds:
  codeindex-mcp@https://codeload.github.com/doberkofler/codeindex-mcp/tar.gz/<commit-sha>: true
  oracledb: true
```

Use the commit SHA recorded in `pnpm-lock.yaml`, or the exact key pnpm prints when it
refuses the install. For an annotated tag, pnpm prints the dereferenced commit SHA,
not the tag object SHA. The key is commit-specific; a tag without the key fails
before `prepare` runs. Retained [fresh-consumer installation evidence](./fresh-consumer-installation.md)
covers artifact startup, a second checkout, analytics opt-out, and rollback.

## Configure

Create `codeindex.config.json` next to your launcher or project tooling:

```json
{
	"project": {
		"name": "my-workspace",
		"root": "."
	},
	"extractor": {
		"id": "typescript",
		"projects": [
			{ "name": "browser", "project": "tsconfig.json" },
			{ "name": "contracts", "project": "contracts/tsconfig.json" },
			{ "name": "server", "project": "server/tsconfig.json" }
		]
	},
	"limits": {
		"maxResultBytes": 32768,
		"maxReadLines": 200
	},
	"diagnostics": {
		"semantic": false
	},
	"storage": {
		"analyticsEnabled": true
	}
}
```

Paths inside the file resolve against the file directory. Every
`extractor.projects[].project` must stay inside `project.root`. Use either the
single `extractor.project` form or the `projects` array, not both. Context names
must be unique; omit a name to derive it from the project directory. Storage paths
must stay outside the indexed workspace.

All contexts share one database and one published generation. Results report the
contexts that produced each symbol or reference, and `find_symbol` and
`find_references` accept an optional `context` filter. Facts are not merged across
incompatible compiler programs; only identical source locations are grouped.

Defaults:

- storage root: `~/.local/share/codeindex-mcp/`;
- database: `<storage>/<storageKey>/index.sqlite`;
- analytics: `<storage>/<storageKey>/analytics/events.jsonl`;
- result bound: 32,768 bytes;
- read bound: 200 lines.

The storage key is derived from the real workspace root, extractor, and project
file. It binds one database to one physical checkout and is stable and
non-reversible. The project identifier is the storage key unless it is
configured explicitly with `project.id` or `CODE_INDEX_PROJECT_ID`; the
configured identifier changes only the reported logical identity and never
selects the storage directory. Use `storage.directory` or `storage.database` to
place the database explicitly.

### Moving, copying, and deleting a checkout

A copy or a move resolves a new storage key, so the checkout gets its own
database, its own build lease, and its own published generation. The source
database is never attached or mutated.

- **Move**: the first build at the new path rebuilds the index. It never reuses
  a generation built for the old root. The old database stays behind until it is
  reclaimed with `codeindex-cli clean --all --yes`.
- **Copy**: the copy builds its own database and generation. Copying the
  checkout does not copy the index, and a copied checkout never attaches to the
  source database.
- **Delete**: remove the checkout directory, then run
  `codeindex-cli clean --all --yes` from any workspace. A database whose owning
  process has exited stays cleanable without manual lease surgery; owner markers
  written by dead processes are ignored. The default `clean` cannot resolve the
  deleted workspace, so `--all` is the recovery command. It only covers the
  default storage root; with a custom `storage.directory`, remove that
  workspace's database directory directly.

An explicit `storage.database` or `CODE_INDEX_DATABASE` path is bound to the
checkout that created it. Pointing a second checkout at one database file fails
with a `different working copy` error and leaves that file untouched. Give each
checkout its own database path, then rebuild.

The retained verification record is [Checkout move, copy, and delete
semantics](./checkout-lifecycle.md).

## Use from OpenCode

Install the server with the CLI:

```bash
codeindex-cli mcp install --root . --codeindex-config ./codeindex.config.json
codeindex-cli mcp uninstall --root .
```

`--config` selects the OpenCode configuration file to edit. `--codeindex-config`
is passed to the server as `--config`, so it selects the CodeIndex project
configuration.

With pnpm, pass `--mcp-path` so the registration uses a stable `node_modules`
path instead of the versioned pnpm store path:

```bash
codeindex-cli mcp install --root . \
	--mcp-path node_modules/codeindex-mcp/dist/mcp.mjs \
	--codeindex-config ./codeindex.config.json
```

To register manually, add:

```jsonc
{
	"mcp": {
		"servers": {
			"codeindex": {
				"type": "local",
				"command": ["codeindex-mcp", "--config", "./codeindex.config.json"]
			}
		}
	}
}
```

Open `/mcps` in OpenCode and confirm that `codeindex` is connected. OpenCode
starts the server locally over stdio; no separate daemon is required.

OpenCode V2 exposes MCP tools through Code Mode by default. The seven CodeIndex
tools therefore appear in the `execute` tool catalog rather than as top-level
entries in the model request's `tools` array. This is expected and does not mean
the tools are unavailable. Set `codemode` to `false` on the server configuration
only when direct exposure is specifically required.

The pinned evaluation compared both exposures on the EVAL-037 artifact: Code Mode
cost `1.307` direct with a one-sided upper bound of `1.473`, so native direct MCP
remains the measured recommendation for that configuration. See
[Exposure evidence](../evaluation/audits/exposure-eval-050.md). The result is
scoped to the pinned model, client, artifact, and task set.

Ask navigation questions normally. Examples:

- `Find the UserCard declaration and show its implementation.`
- `Where is createQueryClient referenced?`
- `Which modules use @scope/package directly, and which are affected downstream?`
- `Which packages depend on APP.HR_API?`
- `Outline src/framework/backend/index.ts.`

For a dependency question, ask for direct usage first. Request dependency impact
only when downstream effect matters, and optionally name one direct consumer as
the root. The `target` argument is a canonical directly queryable identifier:
an npm package name for TypeScript, or `SCHEMA.PACKAGE` for Oracle.

The server exposes seven read-only tools:

| Tool | Use |
| --- | --- |
| `index_status` | Bounded readiness, indexed scope, freshness, counts, and last error; full detail adds build data, diagnostics, and limitations |
| `outline` | Declarations in one workspace-relative file, plus a bounded re-export list; compact detail by default |
| `find_symbol` | Exact or prefix name/qualified lookup with exposure, kind, container, path, and context filters; compact detail by default |
| `find_references` | Occurrences for one symbol ID, or one-call name resolution with file/owner grouping |
| `find_dependencies` | Direct dependency usage or grouped dependency impact; optional project-context filter |
| `read_symbol` | Bounded source, definition sites, bindings, binding sites, or binding contexts |
| `symbol_at` | Innermost stored declaration covering a source line or position |

`find_references` accepts exactly one selector: an opaque `symbolId`, or a `query` with the
same match, kind, container, path, exposure, and context filters as `find_symbol`. A
`symbolId` keeps flat occurrence mode by default; a `query` resolves one symbol in the same
call and defaults to `group: "file"` with references only. Use `group: "owner"` for
`(path, owner)` groups or `group: "occurrence"` for flat occurrences. An ambiguous query
returns at most five compact candidates, and a no-match query returns a text-search
fallback rather than a source-absence claim. A current, untruncated file result is the
complete path set.

`find_symbol` defaults to the `visible` exposure filter, which includes published and
reachable declarations and excludes internal-only ones. Pass `exposure: "internal"` or
`exposure: "any"` only when internal navigation is specifically required.

Each query reports its generation and freshness:

- `current`: use the result.
- `updating`: the previous generation remains readable but may omit the latest
  edits.
- `stale` or `unknown`: use repository search or direct file reads instead.

Each successful query result also reports `guidance`. A `stop` action with
`fallbackRequired: false` marks an authoritative result: report it and stop without a
fallback search. Follow `nextCursor` when the action is `follow_cursor`. A
`text_search` action is the fallback case; `refine` asks for one candidate to be chosen.

`index_status` defaults to a bounded summary of readiness, project contexts, counts,
freshness, and the last error. Pass `detail: "full"` only when hashes, build statistics,
build stages, the build lease, or exclusions are required.

Results are bounded. Follow `nextCursor` when `truncated` is true. A requested
limit is an upper bound; pages shorten automatically to fit the byte budget.

## CLI

```bash
codeindex-cli update      # build only when source or configuration changed
codeindex-cli rebuild     # force a new generation
codeindex-cli status      # generation, counts, freshness, scope
codeindex-cli verify      # SQLite integrity and persisted counts
codeindex-cli analytics   # offline analytics report
codeindex-cli benchmark   # cold/warm build, edit-to-fresh, resources, deep cursors
codeindex-cli clean       # remove project index databases (dry run by default)
```

Common options:

| Option | Meaning |
| --- | --- |
| `--config <path>` | Load a JSON configuration file |
| `--root <path>` | Override the indexed workspace root |
| `--extractor <id>` | Override the selected extractor |
| `--project-file <path>` | Override the extractor project file |
| `--database <path>` | Override the index database path |
| `--json` | Emit one machine-readable JSON document |
| `--debug` | Emit a `codeindex:*` trace on stderr |
| `-h`, `--help` | Show command usage |

`update` reuses the published generation when hashes match. `rebuild` always
publishes a fresh generation. `verify` checks SQLite integrity, foreign keys, and
persisted row counts.

Human output begins with a version and command header. The MCP server writes its
version and diagnostics to stderr because stdout is reserved for MCP framing.
Commands return `0` on success, `1` on a build or verification failure, and `2`
for invalid arguments.

### Semantic qualification

```bash
codeindex-cli oracle-preflight --bundle benchmark/oracle-production-20261026/corpus.json

codeindex-cli qualify --extractor typescript --config ./codeindex.config.json

codeindex-cli qualify --extractor oracle \
  --root /path/to/workspace \
  --project-file /path/to/workspace/oracle-index.json \
  --identifiers /path/to/user-identifiers.csv \
  --dependencies /path/to/user-dependencies.csv
```

`qualify` dispatches to the selected adapter and exits non-zero when that
adapter's gate fails.

For TypeScript, it compares a stratified sample of indexed references against
the language service. When several project contexts are configured, it verifies
the first context. The command exits successfully only when the configured
project supplies at least 200 sampled symbols covering every required construct
with at least 99.5% recall, 100% precision, and no skipped or mismatched symbols.
The checked-in qualification corpus is `test/fixtures/reference-corpus/`.

For Oracle, it compares the published index with exported `USER_IDENTIFIERS` and
`USER_DEPENDENCIES` CSV files. It does not connect to Oracle; database
preparation and export remain separate, approved operations. Pass
`--units <plan.json>` to reuse the explicit snapshot object mapping from an
approved live plan when source filenames differ from PL/Scope object names.
The default is contract [`oracle-o1@3`](./oracle-qualification-contract.md) with
truth policy `v5`, which filters unsupported truth types, omits ephemeral
parameters and routine-local declarations, maps scalar `DEFINITION` rows to
reference uses, applies the exact ambiguity rule at the callee token, and
reports classified extras, strata, contract identity, truth hashes, and
per-reason exclusion counts. Pass `--truth-policy v1`, `--truth-policy v2`,
`--truth-policy v3`, or `--truth-policy v4` only to reproduce retained historical
evidence.

`oracle-preflight` verifies a retained evidence bundle — descriptor, snapshot
checksums, truth exports, plan approval, and contract identity — without opening
a database session. It exits non-zero while the bundle is absent or
inconsistent, so a replay cannot start from incomplete evidence. Bundle
contents and retention rules are documented in
[`oracle-evidence-bundle.md`](./oracle-evidence-bundle.md).

### Cache cleanup

```bash
codeindex-cli clean             # preview the current project database
codeindex-cli clean --yes       # delete the current project database
codeindex-cli clean --all       # preview every managed project database
codeindex-cli clean --all --yes # delete every managed project database
```

Without `--all`, cleanup resolves the current workspace configuration and
targets only that project's database directory under the code index root. A
database path overridden with `CODE_INDEX_DATABASE` or `storage.database` is
cleaned as individual SQLite files, never as its whole directory.

`--all` targets every managed database under the default code index root,
`~/.local/share/codeindex-mcp`, regardless of the current configuration. It also
reclaims databases left behind by a moved or deleted checkout, including
directories named by an explicitly configured project id in older releases. A
custom `storage.directory` is outside that scope.

Cleanup refuses to run while a server or console process owns a targeted
database. It never touches repository files, `dist`, or shared temporary
directories, so it cannot delete cache entries that belong to another workspace
on the same machine.

## Console

```bash
codeindex-console --config ./codeindex.config.json
codeindex-console --config ./codeindex.config.json --open
codeindex-console --config ./codeindex.config.json --port 0
```

The command prints a URL containing a per-run bearer token. Open it on the same
machine. The token is kept in the tab's session storage and removed from the
address bar.

The console provides:

- **Overview:** generation, freshness, counts, build stages, lease, recent jobs.
- **Analytics:** aggregate latency, errors, payload size, truncation, freshness,
  build health, watcher activity, and window comparisons.
- **Operations:** update, force rebuild, integrity verification, benchmark,
  reference verification, and MCP registration repair.
- **Configuration:** resolved paths, schema, versions, and security boundaries.

Security properties:

- binds to `127.0.0.1` only;
- validates `Host` and mutation `Origin`;
- requires a bearer token for every API request;
- sends no CORS headers;
- applies a restrictive content-security policy;
- exposes aggregates only, never raw analytics events;
- accepts only a fixed operation allow-list.

## Keep the index current

The MCP process watches the workspace. Relevant changes schedule a background
refresh; no manual rebuild is normally required. Queries continue using the last
published generation while a replacement is built.

Use `update`, `rebuild`, and `status` when manual inspection or recovery is
needed.

## Restart after upgrading

A running MCP process does not pick up a replaced `dist/mcp.mjs`. After
`pnpm install` resolves a new tag:

1. open `/mcps` in OpenCode;
2. disconnect `codeindex`;
3. connect `codeindex` again;
4. start a new session if tool names, schemas, or instructions changed.

## Analytics

Local analytics are enabled by default and contain no source text, prompts,
queries, symbol names, credentials, or absolute source paths. Exact-name
`find_symbol` calls add one presence mask (`none`, `P`, `R`, `I`, `PR`, `PI`, `RI`, or
`PRI`) so exposure defaults can be evaluated without retaining query text.

```bash
codeindex-cli analytics
codeindex-cli analytics --since 24h
codeindex-cli analytics --format json
codeindex-cli analytics --format html --output report.html
```

Set `CODE_INDEX_ANALYTICS=false` to disable writes.

## Runtime environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODE_INDEX_CONFIG` | none | Configuration file |
| `CODE_INDEX_ROOT` | `.` | Workspace root |
| `CODE_INDEX_EXTRACTOR` | `typescript` | Extractor identifier |
| `CODE_INDEX_PROJECT_FILE` | `tsconfig.json` | Single extractor project file override; replaces the configured `projects` array |
| `CODE_INDEX_DATABASE` | derived | Index database; must be outside the workspace |
| `CODE_INDEX_ANALYTICS` | `true` | Whether to persist analytics |
| `CODE_INDEX_ANALYTICS_PATH` | derived | Analytics JSONL path; must be outside the workspace |
| `CODE_INDEX_LOG` | derived | Alias for the analytics path |
| `CODE_INDEX_MAX_RESULT_BYTES` | `32768` | Maximum serialized MCP result size |
| `CODE_INDEX_MAX_READ_LINES` | `200` | Maximum `read_symbol` source lines |
| `CODE_INDEX_SEMANTIC_DIAGNOSTICS` | `false` | Collect full semantic diagnostics |
| `CODE_INDEX_PROJECT_ID` | derived | Stable logical project identifier; storage stays bound to the checkout |
| `CODE_INDEX_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Invalid roots, configuration paths, and storage locations make startup fail with
a bounded diagnostic. The server is local stdio without authentication.

## Troubleshooting

- **`codeindex` is absent from `/mcps`:** confirm the dependency is installed and
  the launcher resolves. Run `codeindex-cli status --config ...`.
- **The first request cannot see CodeIndex although the server starts:** wait
  until `/mcps` reports `codeindex` as connected, then retry in a new session.
  On macOS, opening the same project through equivalent `/var` and
  `/private/var` paths can create two OpenCode project instances and trigger the
  startup race tracked by
  [anomalyco/opencode#51812](https://github.com/anomalyco/opencode/issues/51812).
  Use one canonical project path until that issue is resolved.
- **The server does not reflect an upgrade:** disconnect and reconnect it through
  `/mcps`.
- **The first query reports `index_not_ready`:** wait for the initial background
  build, then check `index_status` or `codeindex-cli status`.
- **A query reports stale or unknown freshness:** fall back to repository tools
  and inspect status.
- **A symbol is absent:** confirm it is authored source in a configured project context.
  The index does not perform arbitrary text, filename, package, or
  cross-language searches.
- **Need diagnostics:** run `codeindex-cli status --debug` or set
  `DEBUG=codeindex:*` on the MCP process.
