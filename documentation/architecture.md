# Architecture

This document describes the implementation that ships in this repository. The
[README](../README.md) owns installation and operation. Open work belongs in
[GitHub issues](https://github.com/doberkofler/codeindex-mcp/issues) and is indexed
in [enhancements](./enhancements.md).

## Scope

CodeIndex MCP builds a local, read-only index of one workspace from one or more
configured language adapters. It persists language-neutral facts in one SQLite
database and serves bounded navigation queries through MCP, a CLI, and a loopback
console.

```text
MCP server       CLI       loopback console
     \             |             /
      +------------+------------+
                   |
              CodeIndex core
      configuration · freshness · builds
      finalization · storage · bounded queries
                   |
          adapter protocol seam (adapter SDK)
              /                       \
 TypeScript/JavaScript             Oracle 19c source
  compiler API                     lexer + structural parser
  (adapter package)                (adapter package)
                   |
        serializable language-neutral facts
```

The core owns project identity, generations and revisions, publication,
freshness, storage, query semantics, bounds, and analytics. An adapter owns
everything requiring a compiler, parser, or driver. Compiler objects, parser
trees, and external connections never cross the adapter seam.

## Repository boundaries

| Path | Responsibility |
| --- | --- |
| `src/core/config/` | Validate external configuration and resolve workspace/storage identity |
| `src/core/generation/` | Scan/build orchestration, worker execution, leases, publication, and verification |
| `src/core/freshness/` | Watcher hints, deterministic reconciliation, and freshness state |
| `src/core/facts/` | Language-neutral identity, exposure, finalization, and invariant checks |
| `src/core/storage/` | SQLite schema, transactions, snapshots, and persistence |
| `src/core/storageAudit*.ts` | Read-only inventory of managed storage, generated artifacts, Git worktrees, and normalized totals |
| `src/core/query/` | Bounded symbol, occurrence, dependency, source, and position queries |
| `src/core/analytics/` | Privacy-safe local events and reports |
| `src/core/benchmark/` | Model-free benchmark and soak machinery |
| `src/core/qualification/` | Maintainer-only TypeScript comparison and publication measurements |
| `packages/adapter-sdk/` | Language-neutral adapter protocol, manifest schemas, `defineAdapter`, and conformance checks |
| `packages/adapter-typescript/` | TypeScript/JavaScript scanning and extraction |
| `packages/adapter-oracle/` | Oracle manifest discovery, tokenization, parsing, resolution, and extraction |
| `packages/adapter-oracle-tools/` | Private maintainer Oracle qualification, live driver, and evidence replay |
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
- one or more configured adapters, each with its own project contexts;
- a logical project name and optional configured project ID;
- database and analytics locations outside the workspace;
- response, source-read, diagnostics, and logging settings.

Configuration-file paths resolve against the file directory. Environment and CLI
overrides resolve against the process working directory. Real paths prove that
project files remain inside the workspace and storage remains outside it.

The canonical form is a non-empty `extractors` array. The legacy singular
`extractor` form normalizes to one required adapter. Adapter IDs are unique;
`required` defaults to `true`, and only an optional adapter may report declared
absence. `CODE_INDEX_EXTRACTOR` and `CODE_INDEX_PROJECT_FILE` are rejected with
the plural form because they cannot name an adapter unambiguously.

The default storage key hashes the canonical physical root and the real
configuration-file path. Adding or removing an adapter in the same file therefore
revises the same database, while moving the checkout or the configuration file
creates a new scope. Without a configuration file the key hashes the root and the
implicit singular adapter identity. A configured logical project ID changes
reporting, not the physical storage key.

Every adapter in one configuration shares one database, build lease, and published
generation. Contexts are adapter-scoped: the same name may exist under two
adapters, and facts retain both the context and the owning adapter. A workspace
path has exactly one adapter owner; two adapters claiming the same resolved real
path fail the candidate before publication.

## Package topology

The repository is a workspace with one package per independently installable
unit:

- `codeindex-mcp` — host CLI, MCP server, console, core, and loader;
- `packages/adapter-sdk` — language-neutral protocol, runtime schemas, fact
  contract, source-file helpers, `defineAdapter`, and conformance checks;
- `packages/adapter-typescript` — TypeScript / JavaScript adapter and compiler;
- `packages/adapter-oracle` — static Oracle adapter, generated grammar, and
  `antlr4ng`;
- `packages/adapter-oracle-tools` — private maintainer qualification tooling,
  live Oracle driver, and evidence replay.

Each package builds independently with `tsc` and publishes prebuilt ESM plus
declarations. `publishConfig` points exports at `dist`. The host Vite build
externalizes both official adapter packages, so host output contains no adapter
code or compiler/parser dependency. `pnpm run build:packages` builds the SDK
before the adapters; the release workflow builds, packs, and installs the exact
tarballs into clean consumers before publishing the SDK, then the adapters, then
the host.

The host package still declares `@codeindex/adapter-sdk` because loader and core
import protocol schemas. Adapter packages declare only the SDK and their own
compiler/parser dependency. `oracledb` is a maintainer-only dependency used by
live Oracle qualification, not by the host runtime or the static adapter.

## Storage and provenance

`SCHEMA_VERSION` is `17`. The `generation` table holds aggregate publication
metadata only: state, revision, hashes, counts, stages, timestamps, and bounded
failure state. It has no extractor, compiler, or drift projection.

`generation_adapter` is the sole per-generation provenance source. Each row
carries protocol version, implementation version, bounded package name/version,
compiler/parser identity, coverage, absence reason, hashes, counts, and timings.
Reuse compares the stored protocol and implementation versions, so an adapter
upgrade cannot reuse facts produced by another implementation.

Adapter-emitted symbol, binding, site, and dependency identifiers are adapter-local.
Before persistence the core rewrites each one to
`a_<sha256(adapter_id NUL local_id)>`, so two adapters may emit the same local
identity without collision. Persisted query results expose only the core-owned
identity.

Adapter caches (`extraction_artifact`) remain keyed by content hash, artifact
kind, adapter ID, adapter implementation version, and context hash. They are
bounded, independently disposable, and never required to read a published
generation.

## Major-release migration

Package separation changes installation, not configuration. Existing
`id: "typescript"` and `id: "oracle"` entries without `module` normalize to the
official package aliases. A TypeScript-only installation must install
`codeindex-mcp` and `@codeindex/adapter-typescript`; an Oracle workspace adds
`@codeindex/adapter-oracle`. A missing adapter package fails before transport
startup with `adapter_module_not_found` and an install instruction.

Rollback pins the previous host release and its adapters together. Adapter
implementation upgrades invalidate only that adapter's reuse identity; a host
schema change recreates the derived database under the existing one-backup
policy.

## Adapter SDK and loader

`@codeindex/adapter-sdk` owns the language-neutral adapter protocol. An adapter
module exports exactly one named `codeIndexAdapter` value with a manifest and a
factory:

```ts
export const codeIndexAdapter = defineAdapter({
	manifest: {protocolVersion: 1, id: 'custom', implementationVersion: '1.0.0', displayName: 'Custom'},
	create: () => adapter,
});
```

`src/adapters/loader.ts` is the only production implementation loader. For each
configured `extractors[]` entry it normalizes a compatibility alias or resolves
the explicit `module` field, imports the module once per canonical identity,
validates the manifest and factory result at runtime, and returns fresh adapter
instances plus a process-internal descriptor. Bare package specifiers resolve
from the configuration-file directory; relative paths resolve from the same
directory (or the workspace root without a configuration file). Absolute paths
and URL schemes are rejected during configuration validation. Stable load
failures are `adapter_module_not_found`, `adapter_module_invalid`,
`adapter_protocol_unsupported`, `adapter_id_mismatch`,
`adapter_version_mismatch`, and `adapter_module_duplicate`.

Composition roots await the loader before creating `CodeIndex`. A worker receives
only the descriptors and reloads the same canonical modules, revalidating the
protocol, adapter ID, and implementation version. The resolved module URL stays
process-internal and never enters SQLite, tool responses, CLI JSON, analytics, or
bounded failure envelopes. The official `typescript` and `oracle` IDs resolve to
`@codeindex/adapter-typescript` and `@codeindex/adapter-oracle`, which must be
installed beside the host; the same loader, `module` field, and worker descriptor
path serve third-party packages.

Each adapter provides:

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

Adding a source language means publishing an SDK-conforming module and naming it
in configuration; it does not add a language branch to storage, publication,
queries, or transports.

### TypeScript and JavaScript

The TypeScript adapter uses the TypeScript 7 synchronous compiler API
independently for each configured `tsconfig.json` or `jsconfig.json` context. The
compiler runs in its own process; the adapter owns that process per input
snapshot and disposes it, its programs, and its module resolvers explicitly. It
publishes authored `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and
`.cjs` files reachable from those programs. JavaScript requires `allowJs`.

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
3. **Scan.** Every configured adapter deterministically discovers its configured
   files, hashes source and configuration inputs, and records compiler/parser
   identity. Filesystem events only schedule this scan; they are never the source
   of truth.
4. **Reuse.** Each adapter has its own source, configuration, and input hashes. An
   adapter whose complete reuse key matches the publication is not re-extracted,
   even when another adapter changed. An adapter may also prove that changed
   content produced identical facts and revise only its file/content metadata.
   Whole-generation reuse requires every adapter to match.
5. **Extract and finalize.** Otherwise each adapter emits its own serializable
   fact bundle, and the core finalizes and validates it under that adapter's
   identity.
6. **Commit.** The first build inserts a private `building` generation and
   atomically publishes every adapter after persistence and verification. Later
   refreshes keep the published generation ID, atomically increment its revision,
   and rewrite only path groups whose fact digest changed. Removed and absent
   adapters lose their facts in the same transaction.
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

`WorkspaceWatcher` observes the union of configured adapter source extensions and
watch inputs. Ignored directory segments are the intersection across adapters, so
one adapter's ignore rule cannot hide another adapter's source. Watching is
recursive from the covering directories that hold indexed files, so files created
in new subdirectories and removed directory trees are reported without waiting for
a rescan. Directory events request a project-wide scan because a new or removed
directory can change the indexed file set without naming a source file.

`RefreshCoordinator` debounces bursts, allows one refresh at a time, coalesces
changes arriving during a build into one follow-up, and retries a failed refresh
with capped exponential backoff. The debounce is a trailing edge: every event
restarts the quiet window, which is `freshness.debounceMs` (default 1000 ms,
range 100–10000). It is one workspace-level value because one coordinator serves
every adapter. It performs **no periodic rescan of an idle workspace**: a healthy
watcher is the change detector, and a timer that rescans unchanged content burns
CPU without discovering anything. A full reconciliation still runs at startup,
after a watcher error, after a failure retry, and on `codeindex-cli update`. The
scanner remains authoritative.

`reconcileIntervalMs` exists only as an opt-in safety interval for filesystems
whose events are known to be unreliable. It is disabled by default, and when set
it is measured from the end of the previous refresh so a slow scan cannot delay
the next one.

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

### Storage audit

`codeindex-cli audit` is a read-only inventory. It discovers the XDG data and
cache roots, historical home-relative defaults, the repository configuration
storage directory, and configured evidence/evaluation roots. It classifies
only known artifact categories: index databases, analytics, schema backups,
repository-generated outputs, benchmark caches, evidence bundles, and evaluation
state. Entries are disjoint, so category totals sum without nested
double-counting.

Owner markers are re-read immediately before eligibility is reported; an index
with a live owner is never described as cleanable. Git worktrees and `.git` size
are reported separately and excluded from artifact totals; dirty worktrees are
never marked removable automatically. OpenCode session storage is never
inspected. Retained paths are normalized to `$HOME` and `$REPO`. Byte totals use
macOS allocated blocks on Darwin and logical size elsewhere; the report records
which semantics apply.

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
the byte budget may shorten a page. A cursor is tied to its generation, query
shape, and resolved adapter/context pair.

`index_status` reports one entry per configured adapter with its own coverage,
absence reason, compiler identity, contexts, and limitations. An adapter that has
no `generation_adapter` row in the published generation is reported absent with an
explicit reason; coverage is never inferred from zero facts or assumed present. A
singular `scope.extractor` projection appears only when exactly one adapter is
configured, and it projects the first present adapter in configuration order.

Query addressing is adapter-scoped. An omitted `adapter` searches every configured
adapter. A filtered query uses only that adapter's query-name normalization; an
unfiltered query applies each adapter's normalization, unions results, and
deduplicates by symbol ID. A bare `context` resolves only when it exists under one
adapter. Unknown adapters and contexts, ambiguous bare contexts, and mismatched
path, context, or symbol selectors fail with stable errors instead of an empty
success.

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
`invalid_argument`, `unknown_adapter`, `unknown_context`, `ambiguous_context`,
`adapter_context_mismatch`, `adapter_path_mismatch`, `adapter_symbol_mismatch`,
and `response_too_large`. Unexpected failures become `internal_error` without a
stack trace.

Build failures carry a closed envelope with the failing stage, cause, errno,
workspace-relative project identity, and the adapter that failed. An adapter is
annotated where it fails, so a multi-adapter failure never degrades to an
unattributed error. Adapter-local identifiers are namespaced before persistence,
so cross-adapter identity reuse cannot occur; a path claimed by two adapters
fails as an adapter ownership conflict and is neither merged nor resolved
last-writer-wins.

Nested result lists have independent totals and truncation markers. The response
builder reduces optional detail and then top-level items to fit the configured
byte budget. If even one minimal item cannot fit, it returns `response_too_large`
rather than malformed partial data.

## Transports

### MCP

`codeindex-mcp` uses stdio. Stdout is exclusively MCP transport data; the version
banner, diagnostics, analytics diagnostics, and `DEBUG=codeindex:*` traces stay on
stderr. MCP starts continuous watching; reconciliation happens at startup, on
watcher failure, on a failed-refresh retry, and on explicit `update`.

### CLI

`codeindex-cli` composes the same configuration, database, adapters, and core.
Operational commands disable continuous watching and perform one explicit action.
Benchmark commands reuse the same production seams rather than maintaining a
second index implementation. Oracle qualification and evidence commands are
maintainer-only and live in `src/entries/qualify.ts`, not in the production CLI.

`mcp install` and `mcp uninstall` manage one project-local OpenCode entry named
`codeindex`, independent of the configured adapter set. The entry preserves
unrelated JSONC content. It records the absolute project root as `cwd`, because
OpenCode discovers a project configuration from ancestor directories but starts
the server in the session workspace; without the absolute `cwd`, a session below
the repository root would resolve the relative bundle and configuration paths
against the nested directory. Releases before multi-adapter support registered one key
per adapter (`codeindex-<extractor.id>`); install refuses to write while those
legacy keys exist. Migration removes a legacy entry only when its registered
command and arguments equal the command this invocation would write, so an entry
CodeIndex cannot prove it created must be resolved manually. Uninstall removes
only the canonical key unless `--legacy` explicitly requests provable legacy
cleanup.

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
  [`oracleQualificationContract.ts`](../packages/adapter-oracle-tools/src/oracleQualificationContract.ts)
  in the private maintainer package; retained qualification and replay evidence
  lives in
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
- No ORDS adapter or cross-language graph; adapters share a generation but never
  cross-resolve each other's symbols.
- No live Oracle dictionary extraction in the production index.
- No claim of complete static resolution for dynamic dispatch, dynamic SQL,
  generated source, or unsupported parser constructs.

These are current boundaries, not implied commitments. Any implementation work is
defined and prioritized only by the open issues listed in
[enhancements](./enhancements.md).
