# CodeIndex MCP

CodeIndex MCP is a local, read-only code index for AI coding clients. It indexes
one configured workspace into SQLite and exposes bounded navigation through MCP,
a command-line interface, and a loopback management console.

Use it to locate declarations, inspect a file outline, find references, trace
dependency use, resolve the declaration at a source position, and read the
smallest useful source range without loading an entire repository into context.

## Supported source

| Extractor | Input | Current coverage |
| --- | --- | --- |
| `typescript` | `tsconfig.json` or `jsconfig.json` | TypeScript and JavaScript declarations, references, imports, exports, bindings, and diagnostics |
| `oracle` | Explicit Oracle manifest | Oracle 19c packages, standalone procedures/functions, tables, table columns, views, references, and package dependencies |

JavaScript requires `allowJs` in the selected TypeScript project. Declaration
files and generated output may participate in compiler resolution but are not
published as authored source.

The Oracle extractor reads static source only; it does not connect to Oracle at
runtime. Object types, triggers, synonyms, database links, inferred view columns,
SQL object lineage, wrapped source, and conditional-compilation branch evaluation
are not indexed.

One server selects one extractor. TypeScript and Oracle can run as separate MCP
servers, but they do not yet share one atomic generation or cross-language edges.

## Requirements and installation

- Node.js 26 or newer.
- A released Git tag. The package is consumed from GitHub and is not published to
  npm.

Install an immutable release tag in the consuming project:

```bash
pnpm add "github:doberkofler/codeindex-mcp#<release-tag>"
```

Do not depend on `main`. The Git dependency runs `prepare` and builds
`dist/mcp.mjs`, `dist/cli.mjs`, `dist/console.mjs`, and the console frontend.

If pnpm blocks dependency build scripts, approve the resolved CodeIndex Git
dependency and `oracledb` in `pnpm-workspace.yaml`. Use the exact resolved key
reported by pnpm:

```yaml
allowBuilds:
  codeindex-mcp@https://codeload.github.com/doberkofler/codeindex-mcp/tar.gz/<commit-sha>: true
  oracledb: true
```

`oracledb` is used only by opt-in live Oracle qualification; normal Oracle
indexing opens no Oracle connection.

## Quick start

From a TypeScript workspace containing `tsconfig.json`, the defaults are enough:

```bash
codeindex-cli update
codeindex-cli status
```

The default extractor is `typescript`, the default root is the current directory,
and the default project file is `tsconfig.json`.

For explicit or multi-project configuration, create `codeindex.config.json`:

```json
{
	"project": {
		"name": "my-workspace",
		"root": "."
	},
	"extractors": [
		{
			"id": "typescript",
			"required": true,
			"projects": [
				{"name": "browser", "project": "tsconfig.json"},
				{"name": "server", "project": "server/tsconfig.json"}
			]
		}
	],
	"limits": {
		"maxResultBytes": 32768,
		"maxReadLines": 200
	}
}
```

The legacy singular `extractor` object remains valid and normalizes to one required
adapter. With `extractors`, every adapter shares one database, build lease, and
published generation; `required` defaults to `true`, and only an optional adapter
may report declared absence. The two forms are mutually exclusive.

Each entry may name an adapter `module`. A bare package name resolves from the
configuration-file directory; a relative path resolves from the same directory.
Absolute paths and URL schemes are rejected. Without `module`, the official IDs
`typescript` and `oracle` use the built-in compatibility aliases.

```json
{
	"extractors": [
		{
			"id": "custom",
			"module": "@example/codeindex-adapter-custom",
			"required": true,
			"project": "custom-project.json"
		}
	]
}
```

An adapter module exports one named `codeIndexAdapter` with a manifest and
factory; the host validates the protocol version, adapter ID, implementation
version, and factory result before scanning.

Then build or reuse the index:

```bash
codeindex-cli update --config codeindex.config.json
```

All configured adapters and their project contexts share one publication boundary.
Context names are adapter-scoped and appear in results; the same name may exist
under two adapters.

Paths in a configuration file resolve relative to that file. Environment and CLI
path overrides resolve relative to the current working directory. Project files
must stay inside the workspace; database and analytics paths must stay outside it.

## Connect an MCP client

### OpenCode

Install a project-local server entry while preserving unrelated JSONC content:

```bash
codeindex-cli mcp install \
  --root . \
  --codeindex-config codeindex.config.json
```

This writes exactly one `mcp.servers.codeindex` entry to the existing project
OpenCode configuration, or creates `.opencode/opencode.jsonc`. The key does not
change with the configured adapters. Reconnect the MCP server after installation
or an upgrade.

Older releases registered one key per adapter, such as `codeindex-oracle`.
`mcp install` refuses to write while such legacy keys remain. When the registered
command proves CodeIndex created the entry for this configuration, migrate it:

```bash
codeindex-cli mcp install \
  --root . \
  --codeindex-config codeindex.config.json \
  --migrate-legacy
```

Migration never removes an entry whose command and arguments differ from what
this invocation would write; remove or rename those entries manually.

Remove only the canonical server entry with:

```bash
codeindex-cli mcp uninstall \
  --root . \
  --codeindex-config codeindex.config.json
```

Add `--legacy` to remove legacy entries whose command proves CodeIndex created
them for this configuration.

`--config` on the `mcp` subcommand selects the OpenCode configuration to edit;
`--codeindex-config` selects the configuration passed to CodeIndex.

### Other MCP clients

Configure a local stdio server whose working directory is the indexed workspace:

```jsonc
{
	"mcp": {
		"servers": {
			"codeindex": {
				"type": "local",
				"command": [
					"codeindex-mcp",
					"--config",
					"codeindex.config.json"
				]
			}
		}
	}
}
```

`codeindex-mcp` reserves stdout for MCP framing. Its version banner,
diagnostics, and debug traces go to stderr.

## MCP tools

The server exposes seven read-only tools:

| Tool | Use |
| --- | --- |
| `index_status` | Readiness, configured adapters and scope, coverage, counts, freshness, limitations, and last error |
| `outline` | Declarations in one indexed file, in source order |
| `find_symbol` | Exact or prefix declaration lookup |
| `find_references` | References or definitions for a symbol ID, or one-call name resolution grouped by file or owner |
| `find_dependencies` | Direct external dependency consumers or transitive authored-module impact |
| `read_symbol` | Bounded source or binding/definition-site metadata for one symbol |
| `symbol_at` | Innermost stored declaration covering a source line or position |

Responses include freshness and explicit guidance. When
`guidance.action` is `stop` and `fallbackRequired` is `false`, the current,
untruncated result is authoritative. Follow `nextCursor` whenever `truncated` is
true. Use ordinary repository tools when guidance requests fallback or the fact is
outside indexed scope.

Every read tool accepts an optional `adapter` filter. Omitting it searches every
configured adapter; results name the owning adapter on each item. Project contexts
are adapter-scoped: a bare context name that exists under more than one adapter
fails with `ambiguous_context` and requires both `adapter` and `context`. `outline`
and `symbol_at` infer the adapter from the path, and an explicit filter must match
or the call fails with `adapter_path_mismatch`.

`outline` and `find_symbol` return compact results by default. Request full detail
only for bindings, qualified names, or definition sites. Every response is bounded
by `maxResultBytes`; source is also bounded by `maxReadLines`.

`read_symbol` checks the current file hash before returning persisted source. A
dirty or changed path returns `stale_file` instead of stale text.

## Oracle configuration

Select the Oracle extractor and name an explicit manifest:

```json
{
	"project": {
		"name": "database-source",
		"root": "."
	},
	"extractor": {
		"id": "oracle",
		"project": "oracle-index.json"
	}
}
```

Example `oracle-index.json`:

```json
{
	"schemaVersion": 1,
	"dialect": "19c",
	"defaultSchema": "APP",
	"extensions": [".pks", ".pkg", ".pkb", ".prc", ".fnc", ".sql"],
	"include": ["database/**/*"],
	"exclude": ["**/generated/**"]
}
```

Patterns are workspace-relative POSIX globs. `extensions` is optional; when
omitted it defaults to `.pks`, `.pkg`, `.pkb`, `.prc`, and `.fnc`. Add `.sql` or
`.pls` when those files should be published.

Unquoted Oracle names use canonical uppercase spelling; quoted names preserve
authored spelling. Natural qualified queries such as `PACKAGE_NAME.ROUTINE_NAME`
are accepted.

## CLI

Common operational commands:

```bash
codeindex-cli update     # build only when source or configuration changed
codeindex-cli refresh    # alias for update
codeindex-cli rebuild    # force extraction and publication
codeindex-cli status     # generation, scope, counts, and freshness
codeindex-cli verify     # SQLite integrity, foreign keys, and stored counts
codeindex-cli analytics  # report local privacy-safe analytics
codeindex-cli clean      # list the current database; add --yes to remove it
```

Index-backed operational commands accept `--config`, `--root`, `--extractor`,
`--project-file`, `--database`, `--json`, and `--debug` where applicable.
`clean` resolves its target from the environment; set `CODE_INDEX_CONFIG` when
cleaning a non-default project.

Benchmark, soak, TypeScript differential, publication measurement, Oracle
qualification, evidence preflight, and replay commands are maintainer surfaces.
Run `codeindex-cli --help` and `codeindex-cli <command> --help` for their current
options. Retained Oracle commands and evidence are documented in
[`benchmark/oracle-production-20261027`](./benchmark/oracle-production-20261027/README.md)
and [`benchmark/oracle-performance`](./benchmark/oracle-performance/README.md).

## Console

Start the loopback-only management console:

```bash
codeindex-console --config codeindex.config.json --open
```

It binds to `127.0.0.1`, uses a random per-run bearer token, and can show status,
freshness, and analytics or run operational jobs. `--port 0` selects an available
port.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `CODE_INDEX_CONFIG` | Configuration file path |
| `CODE_INDEX_ROOT` | Workspace root |
| `CODE_INDEX_EXTRACTOR` | Extractor ID |
| `CODE_INDEX_PROJECT_FILE` | Single extractor project-file override |
| `CODE_INDEX_DATABASE` | SQLite database path |
| `CODE_INDEX_ANALYTICS` | `0` or `false` disables analytics writes |
| `CODE_INDEX_ANALYTICS_PATH` | Analytics JSONL path |
| `CODE_INDEX_LOG` | Legacy alias for the analytics path |
| `CODE_INDEX_MAX_RESULT_BYTES` | Maximum MCP response size |
| `CODE_INDEX_MAX_READ_LINES` | Maximum source lines returned by `read_symbol` |
| `CODE_INDEX_SEMANTIC_DIAGNOSTICS` | `1` or `true` enables TypeScript semantic diagnostics |
| `CODE_INDEX_PROJECT_ID` | Reported stable logical project ID |
| `CODE_INDEX_LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |

## Storage and privacy

By default, each physical checkout gets a separate directory under
`~/.local/share/codeindex-mcp/`. Moving or copying a checkout produces a different
storage key, so it cannot silently reuse another checkout's database or lease.

The SQLite database is disposable derived data and contains indexed source bytes
for freshness-safe reads. Schema incompatibility moves the old database aside and
rebuilds; there are no in-place migrations.

Analytics are local, bounded, versioned, and enabled by default. They contain
operation names, timings, counts, byte sizes, freshness, and stable error codes;
they exclude source text, prompts, queries, symbol names, credentials, and
absolute paths. Set `CODE_INDEX_ANALYTICS=false` to disable writes.

Git and SVN provenance is recorded when available. An unversioned workspace is
fully supported; freshness is hash-based, not VCS-based.

## Troubleshooting

- **`index_not_ready`:** the initial background build has not published. Run
  `codeindex-cli update --config <path>` and inspect `status --json`.
- **`index_build_failed`:** inspect MCP stderr or CLI output. The previous
  published revision remains available when one exists.
- **`file_not_indexed`:** confirm that the file is reachable from a configured
  TypeScript project or included by the Oracle manifest.
- **`stale_file`:** wait for watcher reconciliation or run `codeindex-cli update`;
  never treat previously returned source as current.
- **Oracle configuration failure:** Oracle requires `extractor.project` or
  `extractor.projects`; it never guesses a manifest.
- **No MCP output:** stdout is protocol-only. Read stderr, or enable
  `DEBUG=codeindex:*` for namespaced traces.
- **Changed server code or dependency version:** rebuild when developing locally,
  then restart or reconnect the MCP process. A running process keeps the bundle it
  started with.

## Project documentation

- [Architecture](./documentation/architecture.md) — how the current implementation works.
- [Enhancements](./documentation/enhancements.md) — index of open work; GitHub issues hold requirements and acceptance criteria.
- [Contributing](./CONTRIBUTING.md) — development setup, checks, and contribution rules.
- [Evaluation](./evaluation/README.md) — controlled evaluation contracts and retained reports.
- [Verification workflows](./.github/workflows/README.md) — CI, nightly, stable, and release operations.
- [Third-party notices](./THIRD_PARTY_NOTICES.md) — vendored Oracle grammar provenance and licenses.

## License

MIT. See [LICENSE](./LICENSE).
