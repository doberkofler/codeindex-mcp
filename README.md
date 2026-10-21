# CodeIndex MCP

A local, extensible, language-neutral code index exposed through the Model Context
Protocol (MCP), a command-line interface, and a loopback management console.

CodeIndex MCP builds an immutable index generation from a workspace, stores it in
SQLite, and answers bounded navigation questions without reading the whole
repository into an agent's context. It is read-only: tools never modify source
files.

## What it does

The index stores:

- authored files with content hashes and line counts;
- declarations with stable identifiers, qualified names, kinds, and source ranges;
- definition and reference occurrences, including the enclosing declaration;
- dependency edges and bindings (authored module imports and canonical external or logical targets);
- extractor diagnostics;
- build generations, freshness state, and analytics.

Six read-only MCP tools are exposed:

| Tool | Purpose |
| --- | --- |
| `index_status` | Readiness, scope, counts, freshness, diagnostics, limitations |
| `outline` | Declarations in one file, in source order |
| `find_symbol` | Exact or prefix symbol search |
| `find_references` | Definition and reference occurrences for one symbol |
| `find_dependencies` | Direct target usage or transitive dependency impact |
| `read_symbol` | Bounded source for one symbol, rejecting stale files |

All results are paginated and byte-bounded. Stale source is rejected rather than
returned.

## Language support

Two extractors ship today:

- **TypeScript / JavaScript**, using the TypeScript compiler API.
- **Oracle 19c SQL / PL/SQL**, using a pinned ANTLR lexer and a tolerant structural
  scanner. No Oracle database is needed at runtime.

JavaScript files are indexed when a configured project enables `allowJs`.
Declaration files (`.d.ts`, `.d.mts`, `.d.cts`) and generated output are used for
resolution but are not published as authored source.

The Oracle adapter indexes package specifications, package bodies, and standalone
procedures/functions from an explicit manifest. Triggers, object types, table
lineage, and live catalogue metadata are outside O1 scope. See the
[Oracle adapter](./documentation/oracle-adapter.md).

ORDS and cross-language edges remain planned; later languages use the same adapter
seam.

## Architecture

```text
MCP / CLI / console
        │
        ▼
Language-neutral core
  generations · freshness · storage · publication
  pagination · limits · dependency queries · analytics
        │
        ▼
Extractor interface
  files · declarations · occurrences · dependency edges
  diagnostics · source ranges · identity and version
        │
        ▼
TypeScript / JavaScript adapter     Oracle 19c adapter
  TypeScript compiler API              pinned ANTLR lexer + structural scanner
```

The core does not know about TypeScript, `tsconfig.json`, npm, Oracle, or any
version control system. Compiler objects stay inside the adapter. A new language is added
by implementing the extractor interface and selecting it in configuration;
storage, publication, MCP envelopes, and analytics do not change.

## Installation

The package is consumed directly from GitHub. No npm publication is performed.

```bash
pnpm add github:doberkofler/codeindex-mcp#v0.1.0
```

Pin a released tag. The Git dependency runs its `prepare` script, which builds:

```text
dist/mcp.mjs
dist/cli.mjs
dist/console.mjs
dist/console/
```

Do not depend on the `main` branch. Every upgrade requires a new tag, an explicit
dependency update, a lockfile update, and verification in the consuming project.

## Configuration

Configuration is external to the package. Pass a JSON file with `--config` or
`CODE_INDEX_CONFIG`:

```bash
codeindex-cli status --config ./codeindex.config.json
CODE_INDEX_CONFIG=./codeindex.config.json codeindex-mcp
```

Paths inside the file resolve relative to the file's directory. Environment
overrides resolve relative to the current working directory.

```json
{
	"project": {
		"name": "my-workspace",
		"id": "optional-stable-id",
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
	"storage": {
		"analyticsEnabled": true
	},
	"limits": {
		"maxResultBytes": 32768,
		"maxReadLines": 200
	},
	"diagnostics": {
		"semantic": false
	}
}
```

Every `extractor.projects[].project` must stay inside `project.root`. The single
`extractor.project` form remains supported. The Oracle extractor requires an
explicit manifest path; it never guesses a project filename. Storage paths must
stay outside the indexed workspace.

### Oracle manifest

```json
{
	"schemaVersion": 1,
	"dialect": "19c",
	"defaultSchema": "APP",
	"extensions": [".pks", ".pkg", ".pkb", ".prc", ".fnc"],
	"include": ["database/**/*.pks", "database/**/*.pkb"],
	"exclude": ["**/generated/**"]
}
```

`extensions` is optional and replaces the default `.pks`, `.pkg`, `.pkb`, `.prc`,
`.fnc` set. Add `.sql` or `.pls` only when those files should be published.

All project contexts build into one atomic generation. Each declaration and
occurrence records the contexts that produced it; `find_symbol` and
`find_references` accept an optional `context` filter.

### Environment overrides

| Variable | Effect |
| --- | --- |
| `CODE_INDEX_CONFIG` | Configuration file path |
| `CODE_INDEX_ROOT` | Indexed workspace root |
| `CODE_INDEX_EXTRACTOR` | Extractor identifier |
| `CODE_INDEX_PROJECT_FILE` | Single extractor project file override |
| `CODE_INDEX_DATABASE` | SQLite index path |
| `CODE_INDEX_ANALYTICS` | `0` or `false` disables analytics writes |
| `CODE_INDEX_ANALYTICS_PATH` | Analytics JSONL path |
| `CODE_INDEX_MAX_RESULT_BYTES` | MCP response byte bound |
| `CODE_INDEX_MAX_READ_LINES` | `read_symbol` line bound |
| `CODE_INDEX_SEMANTIC_DIAGNOSTICS` | `1` or `true` enables semantic diagnostics |
| `CODE_INDEX_PROJECT_ID` | Stable project identifier |
| `CODE_INDEX_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

`CODE_INDEX_LOG` remains an alias for the analytics path.

## Executables

### `codeindex-mcp`

Stdio MCP server. Stdout belongs exclusively to the MCP transport; diagnostics and
the version banner use stderr.

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

Some clients require a launcher script to inject configuration. In that case
point the command at the launcher, keep stdout clean, and let the launcher import
the installed `codeindex-mcp/mcp` entry.

### `codeindex-cli`

```bash
codeindex-cli update     # build only when source or configuration changed
codeindex-cli rebuild    # force a new generation
codeindex-cli status     # generation, counts, freshness, scope
codeindex-cli verify     # SQLite integrity and stored counts
codeindex-cli analytics  # offline analytics report (text, json, html)
codeindex-cli benchmark  # cold/warm build, edit-to-fresh, resources, deep cursors
codeindex-cli benchmark-suite    # run a declarative benchmark suite
codeindex-cli benchmark-prepare  # clone and install pinned public projects
codeindex-cli qualify --extractor typescript  # language-service reference cross-check
codeindex-cli qualify --extractor oracle --identifiers ... --dependencies ...
codeindex-cli publication-report --output report.json  # report-only Phase 2 measurements
codeindex-cli clean      # remove local caches (dry run by default)
```

Index-backed commands accept `--config`, `--root`, `--extractor`, `--project-file`, and
`--database`. `publication-report` is report-only: it accepts the first four and never
opens or writes an index database. The benchmark command also accepts a generated corpus profile or a
disposable database path. With `--baseline`, it writes an evaluation sidecar and
fails only for `failure` gates; warnings remain successful. `--summary` writes
Markdown. `--reference` accepts a previous benchmark report or a stored reference.
See the
[maintainer guide](./documentation/maintainer-guide.md#7-performance-verification).

Repeated benchmark runs are orchestrated by a suite manifest. Each generated
run starts from a pristine corpus, every step executes in a fresh process, and
the evidence directory records identity, reports, gates, checksums, and a
Markdown summary:

```bash
pnpm benchmark:typescript:generated -- --output ~/codeindex-evidence/typescript-generated
pnpm benchmark:typescript:public:prepare
pnpm benchmark:typescript:public -- --output ~/codeindex-evidence/typescript-public
pnpm benchmark:oracle:corpus -- --output ~/codeindex-evidence/oracle
```

Semantic qualification is separate from performance benchmarking:

```bash
pnpm qualify:typescript
CODE_INDEX_ROOT=/path/to/oracle/workspace \
CODE_INDEX_PROJECT_FILE=/path/to/oracle/workspace/oracle-index.json \
CODE_INDEX_ORACLE_IDENTIFIERS=/path/to/user-identifiers.csv \
CODE_INDEX_ORACLE_DEPENDENCIES=/path/to/user-dependencies.csv \
pnpm qualify:oracle
```

### `codeindex-console`

Loopback-only management console.

```bash
codeindex-console --config ./codeindex.config.json --open
```

It binds to `127.0.0.1`, requires a per-run bearer token, and serves a bundled
frontend. It reports status, freshness, analytics, and runs update, rebuild,
verify, benchmark, and qualification operations.

## Freshness and indexing semantics

- Queries read exactly one published generation. `building` rows are never
  exposed.
- A generation is published only after extraction, insertion, and integrity
  verification succeed. A failed build leaves the previous generation serving.
- The scanner is authoritative. Filesystem events are hints; the coordinator
  always performs a deterministic scan.
- Exactly one process owns the build lease. Other processes remain readers and
  observe the externally published generation.
- Rebuilds run in a worker thread so the MCP transport stays responsive.
- `read_symbol` verifies the file hash and rejects dirty paths with
  `stale_file`.
- Persisted paths are workspace-relative POSIX paths.

## Data storage and privacy

- Default storage: `~/.local/share/codeindex-mcp/<projectId>/`.
- The database contains source content so `read_symbol` never trusts a changed
  file. It stays local.
- Analytics are local, versioned, bounded, and disabled with
  `CODE_INDEX_ANALYTICS=false`. They contain tool names, durations, counts, and
  freshness state — never source text, prompts, queries, symbol names,
  credentials, or absolute paths.
- Version-control provenance is optional. Git and SVN are detected when present;
  an unversioned workspace indexes normally.

## Documentation

- [Architecture](./documentation/architecture.md)
- [TypeScript/JavaScript adapter](./documentation/typescript-adapter.md)
- [Oracle adapter](./documentation/oracle-adapter.md)
- [Oracle ANTLR usage](./documentation/oracle-antlr.md)
- [Oracle ANTLR implementation plan](./documentation/oracle-antlr-plan.md)
- [ORDS and cross-language design](./documentation/ords-cross-language.md)
- [Roadmap](./documentation/roadmap.md)
- [Maintainer guide](./documentation/maintainer-guide.md)
- [User guide](./documentation/user-guide.md)
- [MCP evaluation strategy](./documentation/mcp-evaluation-strategy.md)
- [Codebase testing strategy](./documentation/codebase-testing-strategy.md)
- [Evaluation harness methodology](./documentation/evaluation-harness.md)

## Development

```bash
pnpm install
pnpm verify              # typecheck, Oxlint, Knip, Oxfmt, Vitest
pnpm test:oracle         # Oracle adapter tests
pnpm qualify:typescript  # TypeScript reference cross-check against the configured project
# Qualification corpus:
CODE_INDEX_ROOT=test/fixtures/reference-corpus \
CODE_INDEX_PROJECT_FILE=test/fixtures/reference-corpus/tsconfig.json \
pnpm qualify:typescript
pnpm build
```

Requires Node.js 26 or newer. Formatting is owned by Oxfmt; semantic analysis by
Oxlint. Do not weaken a check to make it pass.

## Current limitations

- TypeScript files must be reachable from a configured project file; JavaScript
  requires `allowJs`.
- Oracle O1 indexes static source only: no live database, triggers, object types,
  table/column lineage, synonyms, database links, wrapped source, or conditional
  compilation branch evaluation.
- ORDS and cross-language edges are planned but not shipped.
- No embeddings, fuzzy search, or full-text search.
- No incremental delta storage; reuse is generation-granular.
- Console and MCP trust the local loopback boundary.

## License

MIT. See [LICENSE](./LICENSE).
