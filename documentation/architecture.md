# Architecture

This document describes the implementation that ships in this repository. The
[README](../README.md) owns installation and operation. Open work belongs in
[GitHub issues](https://github.com/doberkofler/codeindex-mcp/issues) and is indexed
in [enhancements](./enhancements.md).

## Scope

CodeIndex MCP builds a local, read-only index of one workspace with one selected
language extractor. It persists language-neutral facts in SQLite and serves
bounded navigation queries through MCP, a CLI, and a loopback console.

```text
MCP server       CLI       loopback console
     \             |             /
      +------------+------------+
                   |
              CodeIndex core
      configuration · freshness · builds
      finalization · storage · bounded queries
                   |
             ExtractorType seam
              /             \
 TypeScript/JavaScript    Oracle 19c source
  compiler API            lexer + structural parser
                   |
        serializable language-neutral facts
```

The core owns project identity, generations and revisions, publication,
freshness, storage, query semantics, bounds, and analytics. An extractor owns
everything requiring a compiler or parser. Compiler objects, parser trees, and
external connections never cross the extractor seam.

## Repository boundaries

| Path | Responsibility |
| --- | --- |
| `src/core/config/` | Validate external configuration and resolve workspace/storage identity |
| `src/core/generation/` | Scan/build orchestration, worker execution, leases, publication, and verification |
| `src/core/freshness/` | Watcher hints, deterministic reconciliation, and freshness state |
| `src/core/facts/` | Language-neutral identity, exposure, finalization, and invariant checks |
| `src/core/storage/` | SQLite schema, transactions, snapshots, and persistence |
| `src/core/query/` | Bounded symbol, occurrence, dependency, source, and position queries |
| `src/core/analytics/` | Privacy-safe local events and reports |
| `src/core/benchmark/` | Model-free benchmark and soak machinery |
| `src/core/qualification/` | TypeScript comparison, Oracle truth contracts, and publication measurements |
| `src/adapters/typescript/` | TypeScript/JavaScript scanning and extraction |
| `src/adapters/oracle/` | Oracle manifest discovery, tokenization, parsing, resolution, and extraction |
| `src/adapters/vcs/` | Optional Git/SVN provenance read at composition time |
| `src/transports/mcp/` | MCP schemas, envelopes, guidance, and tool registration |
| `src/transports/cli/` | CLI composition and operational commands |
| `src/transports/console/` | Loopback HTTP boundary and console service |
| `src/ui/console/` | Browser console |
| `src/entries/` | Executable composition roots and worker dispatch |

The core does not import a language compiler, package manager, database driver,
or browser framework. Version-control discovery is an optional adapter invoked by
the executable composition root. Transports validate and translate; they do not
implement indexing or query semantics.

## Configuration and workspace identity

`src/core/config/config.ts` is the runtime configuration boundary. It validates
the optional JSON file and environment once, then exposes resolved trusted paths
and limits to the rest of the process.

A resolved configuration contains:

- one physical workspace root;
- one selected extractor;
- one or more project contexts for that extractor;
- a logical project name and optional configured project ID;
- database and analytics locations outside the workspace;
- response, source-read, diagnostics, and logging settings.

Configuration-file paths resolve against the file directory. Environment and CLI
overrides resolve against the process working directory. Real paths prove that
project files remain inside the workspace and storage remains outside it.

The default storage key hashes the canonical physical root, extractor ID, and
configured project-file paths. A configured logical project ID changes reporting,
not the physical storage key. Therefore a copied or moved checkout cannot open
the original checkout's database, build lease, or published revision.

Multiple project contexts for one extractor share one database and publication
boundary. Facts retain the contexts that produced them, and applicable queries
can filter by context. The current configuration cannot place different
extractors in one generation.

## Extractor seam

`src/adapters/types.ts` defines `ExtractorType`. Each registered extractor
provides:

- stable extractor identity and version;
- display, discovery, limitation, extension, and ignored-directory metadata;
- a deterministic scan that returns files plus source/configuration hashes;
- a build that returns only serializable facts;
- configuration-file and authored-source classification;
- optional query-name normalization;
- an optional conservative proof that changed files preserve published facts.

The complete fact bundle contains files, symbols, bindings, binding contexts and
sites, surface origins, definition/reference occurrences, dependency edges and
bindings, diagnostics, adapter statistics, and stage timings.

`src/adapters/registry.ts` is the only production registry. It currently registers
`typescript` and `oracle`. Adding a source language means implementing the seam
and registering it; it does not add a language branch to storage, publication,
queries, or transports.

### TypeScript and JavaScript

The TypeScript adapter uses the TypeScript compiler API independently for each
configured `tsconfig.json` or `jsconfig.json` context. It publishes authored
`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs` files reachable
from those programs. JavaScript requires `allowJs`.

Declaration files, dependencies, and generated output may participate in
resolution but are not published as authored symbols. The adapter emits
declarations, definitions and references, lexical ownership, import/export edges,
bindings, exposure, and compiler/extraction diagnostics. Facts from compatible
source locations are merged while retaining their producing contexts.

### Oracle 19c static source

The Oracle adapter requires an explicit manifest for every context. The manifest
defines a default schema, source extensions, and include/exclude globs. Production
tokenization uses the pinned generated ANTLR lexer; a tolerant structural parser
extracts serializable facts without opening an Oracle connection.

It publishes:

- package specifications and bodies;
- standalone procedures and functions;
- package members and nested declarations supported by the parser;
- tables, table columns, and views;
- definition/reference occurrences; and
- authored package dependency edges.

Unquoted identifiers are normalized to Oracle's canonical uppercase spelling;
quoted identifiers preserve authored spelling. Oracle's optional fact-reuse proof
re-parses changed files and compares persisted parser-output digests. It reuses
published facts only when every changed file is proven equivalent.

The generated full ANTLR parser is a qualification-only binding, not the
production parser. Vendored grammar provenance and generation rules live in
[third-party notices](../THIRD_PARTY_NOTICES.md). Qualification and performance
evidence stays with the retained bundle under `benchmark/`.

## Fact model

The persisted model deliberately separates declaration identity, searchable
addresses, source sites, and use sites.

### Files and content

A file is identified by workspace-relative POSIX path within the project. Raw
bytes are SHA-256 hashed before decoding. Immutable content rows hold bytes,
encoding, line starts, byte count, and line count; generation file rows associate
paths with content versions. Equal bytes at two paths do not make one file, and
equal bytes do not imply rename history.

### Symbols, definitions, and bindings

A symbol represents one navigable declaration identity. A symbol may have several
definition occurrences, such as TypeScript overloads/merged declarations or an
Oracle package specification and body. Adapter-supplied ranks let the core select
one deterministic identity anchor and one primary definition for default source
reads.

A binding is a searchable address for a symbol. It is represented as an ordered
vector of typed segments supplied by the adapter. The core validates and
canonically serializes that vector, derives its opaque ID, and derives display
fields such as name, container, and qualified name. Display text is not parsed
back into identity.

Bindings carry exposure per project context:

- `published`: directly writable or followable by a consumer;
- `reachable`: visible through a published TypeScript surface, but not itself a
  public lexical address;
- `internal`: not consumer-visible through that context.

Exposure belongs to a binding, not globally to a symbol. For example, an internal
TypeScript declaration and its exported alias are separate addresses for the same
symbol. Binding sites record whether an address came from a declaration, alias,
default export, re-export, wildcard export, CommonJS site, or projected surface.

### Occurrences and dependencies

Occurrences are either definitions or references. Definitions include their
declaration extent and ranking metadata. References include usage classification
and the innermost stored declaration that owns the use. Only occurrences targeting
stored symbols are persisted.

Dependency edges record source path/range, raw target, resolved authored path or
canonical external target, edge kind, compile-time status, context, and optional
import/export bindings. Direct dependency lookup addresses canonical external
targets. Transitive lookup traverses authored module edges from each direct
consumer; it proves module reachability, not binding use.

### Finalization

`src/core/facts/` is a language-neutral finalizer. It owns deterministic ordering,
canonical binding serialization, derived IDs and display fields, primary-site
selection, aggregate exposure, duplicate/collision checks, structural invariants,
and finite per-root fact ceilings. Adapter semantics remain in the adapter.

Finalization completes before facts can publish. A missing definition, orphaned
binding/context/site, invalid address, identity collision, containment violation,
or ceiling overrun fails the candidate instead of truncating it.

## Build and publication lifecycle

`CodeIndex` is the facade used by every transport.

1. **Start.** The database opens, the last published row is loaded, and normal
   MCP sessions start the watcher and refresh coordinator. The transport can
   answer from an existing publication while startup reconciliation runs.
2. **Acquire or observe.** A process acquires the expiring build lease. A
   non-owner remains a reader and waits for the owner to publish or lose its
   lease.
3. **Scan.** The selected extractor deterministically discovers configured files,
   hashes source and configuration inputs, and records compiler/parser identity.
   Filesystem events only schedule this scan; they are never the source of truth.
4. **Reuse.** If source and configuration hashes match the publication and the
   build is not forced, no extraction occurs. An adapter may also prove that
   changed content produced identical facts and revise only file/content metadata.
5. **Extract and finalize.** Otherwise the adapter emits a complete fact bundle,
   and the core finalizes and validates it.
6. **Commit.** The first build inserts a private `building` generation and
   atomically publishes it after persistence and verification. Later refreshes
   keep the published generation ID, atomically increment its revision, and
   rewrite only path groups whose fact digest changed.
7. **Serve.** Each query pins one SQLite read snapshot and resolves one published
   generation. A reader sees either the old revision or the complete new revision,
   never a partial write.

Production rebuilds run in a worker thread with a separate writer connection, so
the MCP transport remains responsive. The bundled `mcp.mjs` dispatches worker
payloads before normal server startup and therefore serves as both composition
root and worker entry.

A failed first build is marked failed. A failed revision transaction rolls back.
In either case, a prior published revision remains available and is never replaced
by partial facts.

## Freshness

`WorkspaceWatcher` observes configured source extensions and configuration files.
`RefreshCoordinator` debounces bursts, allows one refresh at a time, coalesces
changes arriving during a build into one follow-up, and schedules periodic full
reconciliation. The scanner remains authoritative if an event is missed.

Internal refresh states map to query freshness as follows:

| Refresh state | Query freshness | Meaning |
| --- | --- | --- |
| `current` | `current` | Publication matches the last completed scan |
| `dirty` or `building` | `updating` | Publication is readable but may omit recent edits |
| `failed` | `stale` | Last refresh failed; use repository fallback for current facts |
| startup/unknown/stopping | `unknown` | Currentness is not established |

`read_symbol` has a stronger rule. It rejects a path already marked dirty and
hashes the current file before returning persisted bytes. A mismatch returns
`stale_file`; stale source is never returned as current source.

## Storage

SQLite is a disposable derived store. Its major groups are:

| Group | Contents |
| --- | --- |
| Identity | metadata, physical working copy, optional VCS provenance, indexed project |
| Publication | generation/revision, project contexts, build stages, lease |
| Source | path/version rows, immutable content, per-path fact digests |
| Navigation | symbols, contexts, bindings, binding sites/origins, occurrences, definition sites |
| Dependencies | edges and import/export bindings |
| Diagnostics and measurements | bounded diagnostics and build statistics |
| Reuse | adapter-owned extraction artifacts such as Oracle parse digests |

Build stages partition one attempt: `scanMs`, `compilerMs`, `extractionMs`,
`insertionMs`, `verificationMs`, and `publicationMs` are exclusive, and their sum
never exceeds the reported attempt duration. `index_status.build` describes the
latest published revision rather than the lifetime of the stable generation row.
Status also reports the runtime compiler version beside the version declared by
the project and whether the two majors drift. Drift is emitted once per observed
runtime/declared pair.

Generic `symbols` and `dependencies` artifacts are not written: they were never
read and every row was derivable from published facts. A database open prunes
those dead kinds and vacuums the reclaimed pages; adapter-owned kinds stay.

WAL permits readers to continue while the single build owner writes. This is not
a multi-writer design.

The schema is versioned in source. On incompatibility, the database is moved aside
as one schema-version backup and recreated. There are no in-place schema
migrations because every row is derivable from configured source.

Persisted source paths are workspace-relative POSIX paths. Query output contains
no absolute source paths except configured paths within full `index_status.scope`.
Unexpected failures are sanitized before crossing the MCP boundary.

## Query and MCP contract

The MCP transport registers seven read-only, idempotent tools:

| Tool | Core operation |
| --- | --- |
| `index_status` | Summarize readiness, scope, publication, freshness, counts, and diagnostics |
| `outline` | Page declarations in one path in source order |
| `find_symbol` | Search binding names and qualified names by exact or prefix match |
| `find_references` | Resolve a name or symbol ID, then page occurrences or grouped paths/owners for one symbol partition or an external alias group |
| `find_dependencies` | Page direct external consumers or bounded transitive impact roots |
| `read_symbol` | Select a symbol, verify freshness, and return bounded source or metadata lists |
| `symbol_at` | Resolve a path and position to the innermost covering stored declaration |

Every MCP tool input is validated with Zod. Successful calls use a structured
envelope with freshness and derived guidance. Paged results include a generation
identifier, `truncated`, and `nextCursor`; requested limits are upper bounds because
the byte budget may shorten a page. A cursor is tied to its generation and query
shape.

`find_references` selects one occurrence partition. The default `scope: partition`
contains exactly one symbol. `scope: external_alias_group` expands an indexed
external alias to every stored alias with the same `(externalTarget,
externalName)` pair. Results report `memberSymbols`, `siblingSymbols`, and
`completeness`; they are complete for the selected partition, never for an
unselected one. Alias-group and single-symbol totals are different scopes and are
not complements. Direct external call sites remain outside occurrence results.
Completeness is derived from stored definitions, not from occurrence drop
counters, so an extractor that could not store a member definition reports
`bounded`.

Stable expected error codes are `index_not_ready`, `index_build_failed`,
`file_not_indexed`, `symbol_not_found`, `stale_file`, `invalid_cursor`,
`invalid_argument`, and `response_too_large`. Unexpected failures become
`internal_error` without a stack trace.

Nested result lists have independent totals and truncation markers. The response
builder reduces optional detail and then top-level items to fit the configured
byte budget. If even one minimal item cannot fit, it returns `response_too_large`
rather than malformed partial data.

## Transports

### MCP

`codeindex-mcp` uses stdio. Stdout is exclusively MCP transport data; the version
banner, diagnostics, analytics diagnostics, and `DEBUG=codeindex:*` traces stay on
stderr. MCP starts continuous watching and reconciliation.

### CLI

`codeindex-cli` composes the same configuration, database, extractor, and core.
Operational commands disable continuous watching and perform one explicit action.
Benchmark and qualification commands reuse the same production seams rather than
maintaining a second index implementation.

### Console

`codeindex-console` exposes a small management API and bundled frontend on
`127.0.0.1`. Every run creates a random bearer token delivered in the URL
fragment. Requests enforce host/origin and path rules. It is a local management
surface, not a remote or multi-user service.

## Analytics and privacy

Analytics are local, versioned, bounded by retention policy, and enabled by
default. Events record operation names, durations, byte/item counts, freshness,
truncation, build stages, build outcome, resource measurements, and stable error
codes. Build latency percentiles are reported separately for `complete`,
`reused`, and `failed` attempts. Event-to-publication latency describes successful
refreshes only and is labelled as such; failed attempts never contribute to a
freshness percentile.

A prohibited-field guard prevents source text, prompts, query text, symbol names,
credentials, tokens, and absolute paths from being serialized. Analytics never
replace stderr diagnostics and never affect query results. They can be disabled at
the configuration boundary.

The SQLite database itself contains source bytes and the canonical workspace
identity; it is private local derived data, not a telemetry artifact.

## Verification ownership

- Unit, adapter, core, protocol, and built-process tests use temporary fixture
  workspaces and temporary SQLite files. Tests never index a real checkout.
- MCP protocol tests use the official client and in-memory transport.
- Pull-request, nightly, stable, and release command ownership is documented
  beside the workflows in [`.github/workflows/README.md`](../.github/workflows/README.md).
- The executable Oracle semantic contract is
  [`oracleQualificationContract.ts`](../src/core/qualification/oracle/oracleQualificationContract.ts);
  retained qualification and replay evidence lives in
  [`benchmark/oracle-production-20261027`](../benchmark/oracle-production-20261027/README.md).
- Oracle performance evidence lives in
  [`benchmark/oracle-performance`](../benchmark/oracle-performance/README.md).
- Agent-level comparative evaluation has its own executable harness and evidence
  boundary under [`evaluation/`](../evaluation/README.md).

## Current non-goals and limits

- No source modification.
- No full-text, fuzzy, or embedding search.
- No remote service or multi-user authorization model.
- No simultaneous multi-writer publication.
- No multi-extractor generation, ORDS adapter, or cross-language graph.
- No live Oracle dictionary extraction in the production index.
- No claim of complete static resolution for dynamic dispatch, dynamic SQL,
  generated source, or unsupported parser constructs.

These are current boundaries, not implied commitments. Any implementation work is
defined and prioritized only by the open issues listed in
[enhancements](./enhancements.md).
