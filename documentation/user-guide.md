# User Guide

CodeIndex MCP is a local, read-only code index. It finds declarations,
references, and dependency consumers and reads small source ranges without
repeated broad searches.

An optional loopback console exposes status, aggregate analytics, and
non-destructive operational jobs.

## Scope

Version 0.1.0 indexes authored source selected by one extractor project:

- TypeScript and JavaScript, using the TypeScript compiler API;
- JavaScript only when the project enables `allowJs`.

It does not index:

- declaration files (`.d.ts`, `.d.mts`, `.d.cts`) as authored source;
- generated output or vendored dependencies;
- files not reachable from the selected project file;
- other languages or cross-language relationships;
- runtime behavior, full-text search, fuzzy search, or embeddings.

Package names are not indexed symbols. Use `find_dependencies` for direct
external dependency usage or downstream module impact.

Current constraints:

- one extractor project and one local workspace per configuration;
- full-generation rebuilds rather than incremental compiler state;
- path/range-based symbol identity;
- exact and prefix symbol search only;
- definition/reference roles only;
- no automatic import expansion;
- queries are available through MCP; operational commands through the CLI.

## Install

The package is consumed directly from GitHub. No npm publication is performed.

```bash
pnpm add github:doberkofler/codeindex-mcp#v0.1.0
```

Pin a released tag, never `main`. The Git dependency runs `prepare`, which builds
`dist/mcp.mjs`, `dist/cli.mjs`, `dist/console.mjs`, and `dist/console/`.

pnpm 12 requires the Git dependency to be allowed to run its build:

```yaml
# pnpm-workspace.yaml
allowBuilds:
  codeindex-mcp@https://codeload.github.com/doberkofler/codeindex-mcp/tar.gz/<commit-sha>: true
```

Use the commit SHA recorded in `pnpm-lock.yaml`.

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
		"project": "tsconfig.json"
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

Paths inside the file resolve against the file directory. `extractor.project`
must stay inside `project.root`. Storage paths must stay outside the indexed
workspace.

Defaults:

- storage root: `~/.local/share/codeindex-mcp/`;
- database: `<storage>/<projectId>/index.sqlite`;
- analytics: `<storage>/<projectId>/analytics/events.jsonl`;
- result bound: 32,768 bytes;
- read bound: 200 lines.

The project identifier is derived from the real workspace root, extractor, and
project file unless configured explicitly. It is stable and non-reversible.

## Use from OpenCode

Register the server in project OpenCode configuration:

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

If the client requires a launcher, create a small script that supplies
`CODE_INDEX_CONFIG` and imports `codeindex-mcp/mcp`. The launcher must not write
to stdout.

Open `/mcps` in OpenCode and confirm that `codeindex` is connected. OpenCode
starts the server locally over stdio; no separate daemon is required.

Ask navigation questions normally. Examples:

- `Find the UserCard declaration and show its implementation.`
- `Where is createQueryClient referenced?`
- `Which modules use @scope/package directly, and which are affected downstream?`
- `Outline src/framework/backend/index.ts.`

For a dependency question, ask for direct usage first. Request module impact only
when downstream effect matters, and optionally name one direct consumer as the
root.

The server exposes six read-only tools:

| Tool | Use |
| --- | --- |
| `index_status` | Readiness, indexed scope, freshness, counts, diagnostics, limitations |
| `outline` | Declarations in one workspace-relative file, in source order |
| `find_symbol` | Exact or prefix symbol lookup |
| `find_references` | Definitions and references for one symbol |
| `find_dependencies` | Direct dependency usage or grouped module impact |
| `read_symbol` | Bounded source for one symbol, rejecting stale files |

Each query reports its generation and freshness:

- `current`: use the result.
- `updating`: the previous generation remains readable but may omit the latest
  edits.
- `stale` or `unknown`: use repository search or direct file reads instead.

Results are bounded. Follow `nextCursor` when `truncated` is true. A requested
limit is an upper bound; pages shorten automatically to fit the byte budget.

## CLI

```bash
codeindex-cli update      # build only when source or configuration changed
codeindex-cli rebuild     # force a new generation
codeindex-cli status      # generation, counts, freshness, scope
codeindex-cli verify      # SQLite integrity and persisted counts
codeindex-cli analytics   # offline analytics report
codeindex-cli benchmark   # local build and query latency
codeindex-cli clean       # remove local caches (dry run by default)
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

### TypeScript reference verification

```bash
codeindex-cli verify-references --config ./codeindex.config.json
```

This compares a stratified sample of indexed references against the TypeScript
language service. It is available only for the TypeScript extractor.

### Cache cleanup

```bash
codeindex-cli clean             # preview
codeindex-cli clean --yes       # delete
codeindex-cli clean --keep-index
```

Cleanup targets code-index cache entries under the OpenCode temporary root and
project index databases. It refuses to run while a server or console process is
active. It never touches repository files or `dist`.

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
queries, symbol names, credentials, or absolute source paths.

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
| `CODE_INDEX_PROJECT_FILE` | `tsconfig.json` | Extractor project file |
| `CODE_INDEX_DATABASE` | derived | Index database; must be outside the workspace |
| `CODE_INDEX_ANALYTICS` | `true` | Whether to persist analytics |
| `CODE_INDEX_ANALYTICS_PATH` | derived | Analytics JSONL path; must be outside the workspace |
| `CODE_INDEX_LOG` | derived | Alias for the analytics path |
| `CODE_INDEX_MAX_RESULT_BYTES` | `32768` | Maximum serialized MCP result size |
| `CODE_INDEX_MAX_READ_LINES` | `200` | Maximum `read_symbol` source lines |
| `CODE_INDEX_SEMANTIC_DIAGNOSTICS` | `false` | Collect full semantic diagnostics |
| `CODE_INDEX_PROJECT_ID` | derived | Stable project identifier |
| `CODE_INDEX_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Invalid roots, configuration paths, and storage locations make startup fail with
a bounded diagnostic. The server is local stdio without authentication.

## Troubleshooting

- **`codeindex` is absent from `/mcps`:** confirm the dependency is installed and
  the launcher resolves. Run `codeindex-cli status --config ...`.
- **The server does not reflect an upgrade:** disconnect and reconnect it through
  `/mcps`.
- **The first query reports `index_not_ready`:** wait for the initial background
  build, then check `index_status` or `codeindex-cli status`.
- **A query reports stale or unknown freshness:** fall back to repository tools
  and inspect status.
- **A symbol is absent:** confirm it is authored source in the selected project.
  The index does not perform arbitrary text, filename, package, or
  cross-language searches.
- **Need diagnostics:** run `codeindex-cli status --debug` or set
  `DEBUG=codeindex:*` on the MCP process.
