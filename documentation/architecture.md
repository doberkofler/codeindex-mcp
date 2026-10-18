# Architecture

## 1. Scope

CodeIndex MCP builds a local, immutable index of a workspace and serves bounded
navigation results over MCP, a CLI, and a loopback console.

The design separates three concerns:

```text
Transport adapters        MCP · CLI · console
        │
        ▼
Language-neutral core     generations · freshness · storage · publication
                          pagination · limits · dependency queries · analytics
        │
        ▼
Extractor adapter         project loading · declarations · occurrences
                          dependency facts · diagnostics
```

The core must not import a language compiler, a package manager, or a
version-control client. Those belong to an adapter or to a small optional
provenance reader.

## 2. Non-goals

- Replacing a compiler, type checker, or build system.
- Full-text, fuzzy, or embedding search.
- Cross-language edges.
- Multi-writer database access.
- Remote or multi-user service operation.
- Source modification. Every index operation is read-only.

## 3. Components

| Component | Responsibility |
| --- | --- |
| `codeindex-mcp` | Stdio MCP server; validates transport input, calls one core method, translates the result |
| `codeindex-cli` | Operational commands against the same core |
| `codeindex-console` | Loopback HTTP adapter over console operations and analytics |
| Core | Scanning orchestration, freshness, generations, storage, publication, queries, analytics |
| Extractor | Language-specific project loading and fact extraction |
| SQLite | Disposable derived store |

Stdout belongs exclusively to the MCP transport. Diagnostics, the version
banner, and debug traces use stderr.

## 4. Generation lifecycle

1. **Scan.** The adapter resolves the selected project, hashes authored source
   bytes, and computes a source hash and a configuration hash. Scanning never
   executes or type-checks source.
2. **Reuse check.** If a published generation has the same source and
   configuration hashes and a rebuild is not forced, it is reused.
3. **Build.** A private `building` generation is created. The adapter loads the
   project and emits declarations, occurrences, dependency facts, and
   diagnostics. The core inserts contents and facts.
4. **Verify.** SQLite integrity, foreign keys, and inserted row counts are
   checked.
5. **Publish.** One transaction marks the generation `published`, counts rows,
   records stages, supersedes the previous generation, and updates the published
   token.
6. **Query.** Readers resolve the published token once per call and never see
   `building` rows.

A failed build marks the generation `failed` and leaves the previous published
generation serving queries.

## 5. Freshness

The scanner is authoritative. Filesystem events are hints that schedule a
deterministic scan; a missed event cannot make the index silently wrong.

Refresh states:

| State | Meaning |
| --- | --- |
| `current` | The published generation matches the last scan |
| `dirty` | Changes are known but a refresh has not started |
| `building` | A replacement generation is being built |
| `failed` | The last refresh failed; the previous generation may still serve |
| `unknown` | No usable freshness information |
| `stopping` | The process is shutting down |

Query freshness maps these to:

| Query state | Caller action |
| --- | --- |
| `current` | Use the result |
| `updating` | Readable, but may omit the latest edits |
| `stale` | Prefer repository tools |
| `unknown` | Prefer repository tools |

`read_symbol` additionally verifies the file's current SHA-256 against the
published content hash and rejects dirty or changed paths with `stale_file`.

## 6. Concurrency and ownership

- Exactly one process owns the build lease at a time. The lease has a TTL and is
  renewed while a build runs.
- Non-owners remain readers and observe the externally published generation.
- Rebuilds run in a worker thread so the MCP transport stays responsive.
- The bundled MCP artifact dispatches `workerData` before server startup, so one
  file is both the server and the build worker.
- Readers use one connection; the build owner uses a separate writer connection.
- WAL supports concurrent readers. It is not a multi-writer design.

## 7. Storage model

The database is derived data. An incompatible schema is moved aside as one
`.schema-<version>.bak` file and rebuilt; there is no in-place migration.

Core tables:

| Table | Contents |
| --- | --- |
| `metadata` | Schema version and published generation token |
| `working_copy` | Workspace identity and optional VCS provenance |
| `indexed_project` | Extractor, project file, and compiler identity |
| `generation` | Build state, hashes, counts, stages, error |
| `file` | Generation-relative path, content hash, line count |
| `content` | Immutable content versions keyed by SHA-256 |
| `symbol` | Declarations with stable IDs and source ranges |
| `occurrence` | Definition/reference occurrences and enclosing symbol |
| `dependency_edge` | Authored imports/exports and external dependency facts |
| `dependency_binding` | Imported/exported/local names per edge |
| `diagnostic` | Bounded extractor diagnostics |
| `extraction_artifact` | Per-file reusable facts keyed by content, extractor, and context |
| `build_lease` | Single-writer ownership |

Persisted paths are workspace-relative POSIX paths. Absolute paths appear only in
`index_status.scope` for the configured root and project file.

Previous generations are retained as `superseded` for one generation so in-flight
queries holding a generation identifier can complete. Unreferenced content and
artifacts are removed on publication.

## 8. Extractor contract

An adapter owns everything that needs a language compiler and emits only plain,
serializable facts:

```ts
type ExtractorType = {
	id: string;
	version: string;
	displayName: string;
	sourceExtensions: readonly string[];
	ignoredSegments: readonly string[];
	limitations: readonly string[];
	scan: (config, knownPaths) => ScanResultType;
	build: (config, scan) => ExtractorBuildType;
	configFiles: (config) => readonly string[];
	isSourceFile: (absolutePath, rootDir) => boolean;
};
```

The TypeScript/JavaScript adapter uses the TypeScript compiler API. It:

- loads the selected `tsconfig.json` or `jsconfig.json`;
- publishes authored `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and
  `.cjs` files reachable from the project;
- excludes declaration files and generated output from published facts;
- emits declarations, occurrences, import/export edges, and bindings;
- resolves module specifiers to authored paths before classifying external
  dependency names;
- reports compiler and extraction diagnostics.

JavaScript is indexed only when the project enables `allowJs`.

Adding another language means implementing this interface and registering the
adapter. Storage, publication, pagination, MCP envelopes, and analytics do not
change.

## 9. Query contract

Every paged response includes a generation identifier, freshness, items, a next
cursor, and a truncation flag.

| Tool | Input | Notes |
| --- | --- | --- |
| `index_status` | none | Readiness, scope, counts, freshness, diagnostics, limitations |
| `outline` | path, kinds, limit, cursor | Source order |
| `find_symbol` | query, limit, cursor | Exact qualified, exact name, prefix qualified, prefix name |
| `find_references` | symbol id, role, limit, cursor | Definition/reference occurrences |
| `find_dependencies` | package, direction, transitive, root, detail, limit, cursor | Direct usage or module impact |
| `read_symbol` | symbol id, context lines | Verifies current content hash |

Result rules:

- A requested limit is an upper bound. Pages shorten to fit the response byte
  budget.
- Follow `nextCursor` when `truncated` is true. Cursors are bound to a
  generation.
- Responses never include stack traces, credentials, or absolute source paths.
- Unexpected failures are reduced to `internal_error`.

Stable error codes: `index_not_ready`, `index_build_failed`,
`file_not_indexed`, `symbol_not_found`, `stale_file`, `invalid_cursor`,
`invalid_argument`, `response_too_large`, `internal_error`.

## 10. Dependency semantics

A dependency edge records:

- the source file and source range;
- the raw specifier;
- the resolved authored target path, when internal;
- the normalized external name, when external;
- the edge kind and whether it is type-only;
- optional binding facts (default, named, namespace, all, import-equals).

`find_dependencies` with `transitive: false` returns direct consumers of an
external dependency. With `transitive: true` it traverses authored module edges,
keeps the direct consumer that starts each shortest path, and groups results by
that root. Traversal is cycle-safe and bounded by depth and page size.

These results prove authored-module reachability, not binding use.

## 11. Configuration boundary

Project configuration is external. The package contains no consumer-specific
workspace paths. Configuration selects:

- workspace root and project identity;
- extractor and extractor project file;
- storage directory, database, and analytics path;
- result and read limits;
- diagnostics mode and log level.

Environment overrides exist for runtime injection. Relative configuration-file
paths resolve against the file directory. Storage paths must stay outside the
indexed workspace. See the [user guide](./user-guide.md).

## 12. Version-control provenance

Provenance is optional and adapter-based:

- Git: repository URL (or top level), revision, relative root.
- SVN: repository root URL, revision, relative URL.
- No VCS: explicit `none`.

An unversioned workspace indexes normally. Provenance is metadata; it never
controls freshness, which is hash-based.

## 13. Analytics

Analytics are local, versioned, bounded, and enabled by default.

- JSONL files are capped by size, count, and age.
- Events contain tool names, durations, byte counts, item counts, freshness
  state, build stages, and error codes.
- A prohibited-field guard rejects source text, prompts, queries, symbol names,
  absolute paths, credentials, and tokens before serialization.
- `CODE_INDEX_ANALYTICS=false` disables writes.

Analytics never replace diagnostics on stderr and never influence query results.

## 14. Operational invariants

- A failed build never replaces the published generation.
- Queries never read `building` rows.
- The scanner is authoritative; watchers are hints.
- Exactly one build owner at a time.
- Stdout is reserved for MCP framing.
- Source reads verify freshness.
- JSON responses are bounded.
- The console binds only to loopback and requires a per-run bearer token.
- Schema changes bump the schema version and rebuild the derived database.

## 15. Limitations

- One extractor in 0.1.0: TypeScript/JavaScript.
- JavaScript requires `allowJs`.
- Only files reachable from the selected project file are indexed.
- No cross-language edges, lexical search, or embeddings.
- Generation-granular reuse; no incremental compiler state.
- The core stores dependency facts but does not interpret language-specific
  package semantics; the adapter supplies normalized names.
