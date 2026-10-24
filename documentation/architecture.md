# Architecture

## 1. Scope

CodeIndex MCP builds a local, immutable index of a workspace and serves bounded
navigation results over MCP, a CLI, and a loopback console. The current release
ships TypeScript/JavaScript and Oracle 19c static-source extractors. The target
architecture supports source, compiler, database-metadata, and routing adapters
without adding language branches to the core.

The design separates five concerns:

```text
Adapters                  compiler · parser · dictionary · routing · provenance
        │                 serializable facts only
        ▼
Core ingestion            identity · immutable content · generations · storage
        │
        ▼
Cross-language resolvers  evidence-backed joins inside one candidate generation
        │
        ▼
Core queries              freshness · bounds · pagination · graph traversal
        │
        ▼
Transports                MCP · CLI · console
```

The core must not import a language compiler, parser, database driver, package
manager, or version-control client. Those belong to an adapter or to a small
optional provenance reader. Transports contain no indexing or query semantics.

## 2. Non-goals

- Replacing a compiler, type checker, or build system.
- Full-text, fuzzy, or embedding search.
- Claiming complete resolution of dynamic dispatch or generated code.
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

### 3.1 Repository layout

All authored executable source lives under `src/`:

```text
src/
  core/                 language-neutral indexing machinery
    generation/         worker builds, publication, lifecycle
    facts/              extracted-fact finalization, identity, exposure, validation
    qualification/      truth comparison and report-only publication measurements
    freshness/          watcher, reconciliation, refresh state
    query/              bounded queries and graph traversal
    storage/            SQLite schema and persistence
    analytics/          local events and reports
    benchmark/          model-free local measurements
    config/             validated external configuration
    logging/            stderr diagnostics
    errors/             stable error types
  adapters/             fact producers
    typescript/         shipped TypeScript/JavaScript extractor
    oracle/             shipped static Oracle 19c SQL/PL/SQL extractor
    oracle/database/    planned live dictionary and PL/Scope adapter
    ords/               planned ORDS metadata adapter
    vcs/                optional version-control provenance
  resolvers/
    crossLanguage/      planned evidence-backed joins between adapter facts
  transports/
    mcp/                stdio MCP server and tool contracts
    cli/                operational command surface
    console/            loopback HTTP server and service
  ui/
    console/            browser console application
  entries/              executable composition roots
```

`core` must not import a compiler, parser, database driver, package-manager
API, version-control client, or browser framework. Adapters may use those
libraries internally but publish serializable facts only. Transports call core
operations; they contain no indexing logic. Resolvers consume already extracted
facts and never invoke an adapter's external system directly.

## 4. Generation lifecycle

1. **Scan.** The adapter resolves every configured project, hashes authored source
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
| `indexed_project` | Extractor, primary project file, and compiler identity |
| `generation` | Build state, hashes, counts, stages, error |
| `project_context` | Project name, relative project file, and per-context digest |
| `file` | Generation-relative path, content hash, line count |
| `content` | Immutable content versions keyed by SHA-256 |
| `symbol` | Declarations with stable IDs and source ranges |
| `symbol_context` | Compiler contexts that produced each declaration |
| `symbol_name` | Canonical binding keys and display fields |
| `symbol_name_context` | Binding exposure per project context |
| `symbol_name_site` | Binding source sites |
| `surface_binding_origin` | Published root and projected relative path |
| `occurrence` | Definition/reference occurrences and enclosing symbol |
| `definition_site` | Deterministic definition-site IDs |
| `build_stats` | Closed aggregate fact metrics per generation |
| `occurrence_context` | Compiler contexts that resolved each occurrence |
| `dependency_edge` | Authored imports/exports and external dependency facts |
| `dependency_binding` | Imported/exported/local names per edge |
| `edge` (planned) | Language-neutral relationships between symbols, routes, and database objects |
| `evidence` (planned) | Independent observations supporting an edge, with confidence and provenance |
| `unresolved_site` (planned) | Dynamic, ambiguous, unsupported, or failed resolution sites |
| `diagnostic` | Bounded extractor diagnostics |
| `extraction_artifact` | Per-file reusable facts keyed by content, extractor, and context |
| `build_lease` | Single-writer ownership |

Persisted paths are workspace-relative POSIX paths. Absolute paths appear only in the
full `index_status.scope` payload for the configured root and project files; the default
summary omits the absolute root.

The fact tables implement the symbol, binding, exposure, and definition-site model in
§7.3. Schema version 9 is current; §7.4 defines the invariants validated before
publication.

Previous generations are retained as `superseded` for one generation so in-flight
queries holding a generation identifier can complete. Unreferenced content and
artifacts are removed on publication.

### 7.1 Identity invariants

A file is identified by workspace identity plus workspace-relative path. Identical
bytes at two paths remain two files. A content digest is a version/cache identity,
not file identity. Rename history is provenance and must not be inferred from equal
bytes.

Raw bytes are hashed before decoding. The raw digest owns byte and line ranges.
Encoding, byte count, line starts, and decoded text belong to that immutable
content version. A separately versioned semantic digest may support comparison,
but never source identity or ranges.

Derived facts are reusable only under the complete key:

```text
(raw content digest, artifact kind, adapter identity, adapter version, context digest)
```

The context digest includes every input capable of changing extraction: compiler,
parser, or database version; effective project configuration and path mappings;
workspace/package exports; dependency-graph inputs; generated declarations used
for resolution; schema/edition and PL/Scope settings; route rules; and the
dependent symbol/name-universe generation. Partial cache keys are correctness
defects.

### 7.2 Multi-adapter generations

The current release selects one adapter and one or more projects for it. The
target configuration may also select multiple adapters in one workspace. Each
candidate generation records the exact context digest for every participating
project. TypeScript project contexts share one generation, one database, and one
publication boundary; a failed required context leaves the previous generation
published.

Adapters emit typed batches to one ingestion owner. They never publish or open
independent write transactions. After source and metadata extraction, resolvers
join facts inside the private candidate generation. Publication occurs only after
all required adapters and consistency checks succeed. Readers select one published
generation and therefore never combine TypeScript, Oracle, or ORDS facts from
different builds.

An adapter may be configured as optional only when query coverage reports its
absence explicitly. Failure of a required adapter fails the candidate and retains
the previous published generation.

### 7.3 Symbol, binding, and exposure model

The persisted fact model separates symbol identity, searchable address, and
exposure. Adapters classify language semantics and emit serializable facts; the
core derives identity, exposure, denormalized fields, and validation.

**Persistence** is per symbol:

- `stored`: a navigable symbol with at least one definition occurrence;
- `ephemeral`: a declaration used during resolution or classification but not
  persisted as a symbol or occurrence owner.

**Exposure** is per binding and project context:

- `published`: the binding is an address a consumer can write or follow;
- `reachable`: the declaration is consumer-visible through a published type
  surface, but this lexical binding is not itself writable;
- `internal`: the binding is not consumer-visible from a published root.

Exposure is classified per binding; a published alias never upgrades or hides the
symbol's other lexical bindings. Symbol exposure is the maximum across its bindings
and contexts, ordered `published > reachable > internal_only`. Oracle does not use
`reachable`: its lexical address is its consumer address.

```ts
const x = (): void => {};
export {x as y};
```

Binding `x` is internal, binding `y` is published, and the symbol is published.

The lexical hierarchy and the address hierarchy are independent:

- `symbol.enclosing_id` is lexical/navigation ownership;
- a binding key is a searchable address;
- lexical containment never implies addressability.

#### Binding identity

Every extracted binding carries an adapter-produced, injective vector of typed
address segments. The core validates the generic tuple shape, serializes the
vector canonically as `binding_key`, and derives `binding_id`. It never interprets
language-specific segment kinds.

```ts
type AddressSegment = readonly [
	kind: string,
	value: string | number | null,
];
```

Vectors are non-empty. Segment kinds are non-empty strings; numeric values are
non-negative safe integers; tuples have exactly two elements. `JSON.stringify`
with no whitespace is the persisted canonical serialization, so dotted, quoted,
numeric, and separator-containing names cannot collide. Changing segment meaning,
ordering, or serialization is an incompatible fact-model change requiring a schema
and adapter-version bump.

TypeScript uses one leading `module`, `global`, or `external_module` segment
followed by typed segments:

| Kind | Value | Meaning |
|---|---|---|
| `module` | workspace-relative POSIX module path | internal module identity |
| `global` | `null` | script/global namespace |
| `external_module` | canonical external target | authored external-module augmentation |
| `member` | exact authored/exported name | named address segment |
| `sig` | overload index | disambiguated call signature; omitted when only one exists |
| `param` | parameter index | parameter type |
| `return` | `null` | call result |
| `construct` | `null` | constructed instance type |
| `awaited` | `null` | awaited payload |
| `element` | `null` or element index | array element type or zero-based tuple position |

Oracle uses an `owner` segment followed by one or more `member` segments. Overloads
may share an address; distinct symbol IDs keep their bindings distinct. Unquoted
identifiers use Oracle canonical uppercase spelling; quoted identifiers preserve
authored spelling.

`container`, `name`, and `qualified_name` are derived display/search fields.
Display may evolve without changing binding identity. The core compares complete
`name` or complete `qualified_name`; it never parses display text.

Natural binding uniqueness is `(generation_id, symbol_id, binding_key)`.

#### Binding sites and contexts

One binding can have several source sites:

| Site kind | Meaning |
|---|---|
| `declared` | the symbol's authored identifier |
| `alias` | same-module export specifier |
| `default` | `export default` clause |
| `reexport` | named re-export from another internal module |
| `wildcard` | binding introduced through internal `export *` |
| `commonjs` | CommonJS export assignment; reserved while publication is disabled |
| `surface` | projected address whose source site is its published root |

A declared site equals a definition occurrence's name range. Export sites lie in
authored export syntax. Surface sites equal a site of their root binding.

Bindings and sites are stored once per generation. `symbol_name_context` states
where each binding exists and its exposure. The same location-derived symbol may
have different keys and exposure across contexts.

`surface_binding_origin` stores the root binding ID and the canonical segments
after that root; the destination vector must equal root vector plus relative
vector.

#### Definition occurrences

Every definition occurrence has `role = definition`, a `declaration_kind`,
`forward_definition`, a name range, a declaration extent, `anchor_rank`,
`primary_rank`, and an enclosing stored owner. References have no declaration kind
or extent and are never forward definitions.

| Construct | Definition treatment |
|---|---|
| Oracle package spec and body | two definitions; neither forward |
| Oracle spec routine or cursor requiring a body | definition + forward |
| Oracle body full routine or cursor | definition |
| Oracle package-body private forward | definition + forward |
| Oracle call spec or polymorphic table function | definition, not forward |
| Oracle spec-only constant, variable, type, exception | definition |
| TypeScript overload signature | definition + forward |
| TypeScript implementation signature | definition |
| TypeScript merged declarations | one definition per declaration |

Extents are the TypeScript node start through `node.end`, or the Oracle declaration
range. They are not widened to comments or trivia. Per-site kinds are required
because one TypeScript symbol can merge a function and a namespace.

Every stored symbol has exactly one identity anchor, which supplies the symbol ID
and `symbol.kind`, and exactly one primary definition, which `read_symbol` reads by
default. Identity and primary read site are independent. Selection orders by the
adapter rank, then path, start offset, and the remaining occurrence key.

```text
TypeScript identity anchor:  equal rank across authored declarations
TypeScript primary:          implementation, overload, then merged order
Oracle identity anchor:      spec site, body implementation, then body forward
Oracle routine primary:      full body, specification, then body forward
Oracle package primary:      specification, then body
```

The denormalized `symbol` path/range comes from the primary definition; `symbol.kind`
comes from the identity anchor. The primary binding is the `declared` or `default`
site matching the primary definition's name range, preferring `declared`, then
`binding_key` and `binding_id`. `symbol.name` and `symbol.qualified_name` copy that
binding. A context filter never changes the global primary binding.

Occurrences are stored only when their target is a stored symbol. Reference
ownership is the innermost stored definition extent containing the reference name
range; definition ownership excludes the definition's own target. Exposure never
controls occurrence storage.

Usage bits are `call` 1, `read` 2, `write` 4, and `type_ref` 8. Legal values are
`0`, `1`, `2`, `4`, `6`, and `8`; zero means unclassified, and definitions use
zero. Compound assignment, increment/decrement, and Oracle `IN OUT` arguments use
read + write. Ownership plus a call bit is not a call graph.

### 7.4 Fact finalization and validation

One language-neutral finalizer under `src/core/facts/` owns deterministic ordering,
canonical serialization, ID derivation, anchor and primary selection, exposure
derivation, denormalized fields, aggregate statistics, structural invariants, and
duplicate/collision detection. It imports no compiler, parser, package manager, or
version-control client. Adapter semantics such as exportability, Oracle publicity,
and anonymous-shape classification stay in the adapter.

Validation runs after persistence while the candidate is `building`, and before
atomic publication.

| ID | Owner | Invariant |
|---|---|---|
| S1 | Core | Symbol keys are unique |
| S2 | Core | `enclosing_id` is null or references a stored symbol in the generation |
| S3 | Measured | Child definitions lie within a same-path definition extent of their enclosing symbol; chains are acyclic |
| S4 | Adapter | `enclosing_id` is the nearest enclosing stored declaration |
| S5 | Core | Every symbol has definitions, one identity anchor, and one primary definition |
| S6 | Core | Denormalized location/name fields equal the selected primary site/binding; kind equals the anchor kind |
| S7 | Core | Symbol exposure equals the maximum of its binding-context exposure |
| N1 | Core | Every symbol has a declared/default binding at a definition site |
| N2 | Core | Every binding has a canonical key, display fields, a site, and a context row |
| N3 | Core | Every `declared` site equals a definition occurrence name range for the same symbol |
| N4 | Adapter | Export, default, re-export, and CommonJS sites lie in recognized authored export syntax |
| N5 | Core | Every surface binding/context has one origin; its root is published and non-surface |
| N6 | Core | Every binding-context row has a matching symbol-context row |
| N7 | Adapter | A binding is published only when its address is writable or followable |
| N8 | Core | Binding and definition-site IDs equal their derivations; collisions fail |
| O1 | Core | Every occurrence targets a stored symbol |
| O2 | Measured | Owner is the unique innermost containing stored definition; definitions exclude their own target |
| O3 | Core | Definitions have kind, ranks, an enclosing extent, zero usage, and one definition-site row |
| O4 | Core | References have no extent, kind, or ranks and are never forward definitions |
| L1 | Measured | Definition extents in one path are disjoint or nested; no two symbols share an identical extent |
| F1 | Measured | Per declaration kind, at most one forward and one full definition |
| B1 | Adapter | Stored definition sites belong to authored roots; external declarations are not materialized |

Measured invariants become enforced only after the dry run resolves every valid
violation class. Production builds run S3, O2, L1, and F1 in `enforce` mode;
qualification-only parser overrides remain report-only.

Per-root emitted-fact ceilings are finite and fail the candidate on overrun. The
accepted production values are compiled from qualification evidence. Changing one is
an extractor change: bump the adapter version, which participates in the project
configuration identity, and rebuild. Qualification runs may override them. Neither
mode truncates facts: a report overrun marks the report incomplete and aborts that
run.

### 7.5 Deterministic identifiers

Tool-visible IDs are hashes of natural keys without `generation_id`:

```text
site_id    = hash(symbol_id, path, start_offset, role)
binding_id = hash(symbol_id, binding_key)
```

Use SHA-256, retain 96 bits as 24 lowercase hexadecimal characters, and prefix with
`o_` for definition sites and `b_` for bindings. Each key part is UTF-8 preceded by
its UTF-8 byte length in ASCII decimal and `:` and followed by `;`; numeric parts
use finite base-10 spelling. Uniqueness is per generation; a collision fails the
candidate build. Autoincrement IDs are rejected because a stale ID could select a
different row after rebuild.

### 7.6 Rejected publication alternatives

| Alternative | Reason rejected |
|---|---|
| Persist published symbols only | destroys internal callers, reference ownership, dependency chains, and implementation navigation |
| Put visibility on `symbol` | one symbol can have internal and published aliases |
| Three exclusive symbol tiers | conflates persistence with name exposure |
| Persist parameters and locals | search-noise cost exceeds navigation value |
| Separate `symbol_location` table | definition occurrences already carry typed locations |
| One symbol per spec/body or merged declaration | fragments references and loses canonical identity |
| Materialize dependency declarations | violates authored-root scope and increases noise/storage |
| Persist every possible deep consumer path | disproportionate storage; reachable lexical bindings preserve discovery |
| Use display text as binding identity | separator and formatting changes can collide or churn IDs |
| Autoincrement external IDs | stale IDs can silently select different rows |
| One database transaction for the whole build | generation states already provide isolation without a long writer transaction |
| In-place schema migration | derived indexes are rebuilt on schema-version change |
| PL/Scope-backed production indexing | unavailable for wrapped/offline source and violates source-based adapter design |

## 8. Adapter contract

The shipped source-language contract is `ExtractorType`. Metadata and routing
adapters will implement narrower contracts that share the same ingestion boundary.
An adapter owns everything that needs an external authority and emits only plain,
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

- loads every configured `tsconfig.json` or `jsconfig.json` context;
- publishes authored `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and
  `.cjs` files reachable from the project;
- excludes declaration files and generated output from published facts;
- emits declarations, occurrences, import/export edges, and bindings;
- resolves module specifiers to authored paths before classifying external
  dependency names;
- reports compiler and extraction diagnostics.

JavaScript is indexed only when the project enables `allowJs`.

See [TypeScript and JavaScript adapter](./typescript-adapter.md) for its complete
fact semantics, production-pilot status, validation gates, and enhancement
decisions.

Adding another language means implementing this interface and registering the
adapter. Storage, publication, pagination, MCP envelopes, and analytics do not
change.

Adapters fall into four categories:

- **compiler-backed:** declarations and references resolved by a language service;
- **parser-backed:** source units and conservative relationships from undeployed files;
- **metadata-backed:** authoritative facts from a live system such as an Oracle
  data dictionary;
- **routing/configuration:** routes, handlers, authorization, and deployment facts.

An adapter emits serializable facts only. Compiler objects, database connections,
parser trees, credentials, and client-specific configuration remain inside the
adapter boundary.

Symbol persistence, binding exposure, and definition-site selection follow §7.3;
adapters own language classification, while the core owns generic finalization,
validation, persistence, and bounds. TypeScript publication rules are in
[TypeScript adapter §4](./typescript-adapter.md#4-files-symbols-and-occurrences) and
Oracle rules in [Oracle adapter §3](./oracle-adapter.md#3-symbols).

## 9. Query contract

Every paged response includes a generation identifier, freshness, items, a next
cursor, and a truncation flag.

| Tool | Input | Notes |
| --- | --- | --- |
| `index_status` | detail | Bounded readiness, scope, counts, freshness, and last error; full adds hashes, build statistics, stages, lease, and limitations |
| `outline` | path, kinds, detail, limit, cursor | Source order; compact by default |
| `find_symbol` | query, optional context, detail, limit, cursor | Exact qualified, exact name, prefix qualified, prefix name |
| `find_references` | symbol id or query, group, role, filters, limit, cursor | Occurrences, file groups, owner groups, ambiguity, or text-search fallback |
| `find_dependencies` | target, optional context, direction, transitive, root, detail, limit, cursor | Direct target usage or dependency impact |
| `read_symbol` | symbol id or definition site; context lines; `sites`, `names`, `binding_sites`, `binding_contexts` list modes | Verifies current content hash |

Symbol exposure (`published`, `reachable`, `internal`) and its ranking effect follow
§7.3; `find_symbol` defaults to the `visible` filter (published or reachable).

`outline` and `find_symbol` default to `detail: compact`, which returns the
symbol identifier, name, kind, path, and line range. `detail: full` adds
qualified names, bindings, names, and definition sites. Compact is the default
because full items are roughly an order of magnitude larger per declaration and
routinely exhaust the response budget for a single file.

Result rules:

- Every successful query result carries `guidance` with `action`,
  `fallbackRequired`, and `message`. `action: stop` with
  `fallbackRequired: false` marks an authoritative, current, non-empty,
  untruncated result, so no fallback search is required.
- `action: follow_cursor` means the page is truncated; follow `nextCursor`
  before answering. `action: text_search` is the only case that requires a
  repository fallback, and `action: refine` asks for one candidate to be chosen.
- `index_status` defaults to a bounded summary of readiness, scope, counts,
  freshness, and the last error. `detail: full` adds hashes, build statistics,
  build stages, the lease, and exclusions.
- A requested limit is an upper bound. Pages shorten to fit the response byte
  budget.
- Follow `nextCursor` when `truncated` is true. Cursors are bound to a
  generation.
- Responses never include stack traces, credentials, or absolute source paths.
- Nested lists carry totals and truncation flags. Nested caps are three contexts and
  three sites on a matched binding, five other binding summaries, and five
  definition sites. Byte reduction drops `otherNames`, then reduces contexts and
  binding sites to one each, then definition sites to the primary site, then drops
  trailing top-level items and returns a cursor. Totals survive reduction; a single
  minimal item that cannot fit returns `response_too_large` rather than a partial
  object.
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
external dependency; authored-file importers are not a direct target, so use
`find_symbol` and `find_references` for those. With `transitive: true` it
traverses authored module edges,
keeps the direct consumer that starts each shortest path, and groups results by
that root. Traversal is cycle-safe and bounded by depth and page size.

These results prove authored-module reachability, not binding use.

## 11. Cross-language graph and evidence

Cross-language support is planned. It extends the fact model; it does not replace
language-native symbol navigation.

An edge is the proposition `(from, to, kind)`. Evidence records why the edge is
believed. One edge may have compiler, parser, dictionary, configuration, and
runtime observations. Replacing one observation must not delete unrelated
evidence.

Confidence is attached to evidence, not silently inferred from edge existence:

| Class | Meaning |
| --- | --- |
| `exact` | Compiler/dictionary resolution or a complete validated configuration chain |
| `high` | Deterministic narrowing leaves one target but depends on adapter rules |
| `observed` | Runtime evidence proves occurrence in one sampled execution |
| `heuristic` | Pattern or partial-name evidence requiring inspection |
| `ambiguous` | Evidence supports multiple targets |

Runtime evidence proves occurrence, never completeness. Heuristic evidence is
excluded from normal impact results unless requested. Ambiguous targets remain
branches. Unsupported or dynamic sites are persisted as unresolved facts instead
of guessed edges.

Graph traversal is generation-bound, cycle-safe, depth-limited, result-limited,
and filterable by edge kind and minimum confidence. Every returned path identifies
its supporting evidence.

## 12. Configuration boundary

Project configuration is external. The package contains no consumer-specific
workspace paths. Configuration selects:

- workspace root and project identity;
- extractor and extractor project files;
- storage directory, database, and analytics path;
- result and read limits;
- diagnostics mode and log level.

Environment overrides exist for runtime injection. Relative configuration-file
paths resolve against the file directory. Storage paths must stay outside the
indexed workspace. See the [user guide](./user-guide.md).

## 13. Version-control provenance

Provenance is optional and adapter-based:

- Git: repository URL (or top level), revision, relative root.
- SVN: repository root URL, revision, relative URL.
- No VCS: explicit `none`.

An unversioned workspace indexes normally. Provenance is metadata; it never
controls freshness, which is hash-based.

## 14. Analytics

Analytics are local, versioned, bounded, and enabled by default.

- JSONL files are capped by size, count, and age.
- Events contain tool names, durations, byte counts, item counts, freshness
  state, build stages, and error codes.
- A prohibited-field guard rejects source text, prompts, queries, symbol names,
  absolute paths, credentials, and tokens before serialization.
- `CODE_INDEX_ANALYTICS=false` disables writes.

Analytics never replace diagnostics on stderr and never influence query results.

## 15. Operational invariants

- A failed build never replaces the published generation.
- Queries never read `building` rows.
- The scanner is authoritative; watchers are hints.
- Exactly one build owner at a time.
- Stdout is reserved for MCP framing.
- Source reads verify freshness.
- JSON responses are bounded.
- The console binds only to loopback and requires a per-run bearer token.
- Schema changes bump the schema version and rebuild the derived database.
- An edge never exists without evidence.
- Adapters report incomplete coverage and unresolved sites explicitly.

## 16. Planned adapter family

The next delivery family is:

1. static SQL and PL/SQL source extraction;
2. Oracle dictionary extraction;
3. a gated PL/Scope adapter;
4. source/database drift;
5. ORDS route and handler extraction;
6. evidence-backed TypeScript/JavaScript → HTTP → ORDS → PL/SQL edges.

See [Oracle adapter](./oracle-adapter.md),
[ORDS and cross-language resolution](./ords-cross-language.md), and
[Roadmap](./roadmap.md). A later language remains a new adapter, not a core branch.

## 17. Limitations

- TypeScript/JavaScript and Oracle 19c static source adapters ship today.
- JavaScript requires `allowJs`.
- TypeScript files must be reachable from the configured project files; Oracle
  files come from an explicit manifest.
- Oracle O1 excludes triggers, object types, table/column lineage, synonyms,
  database links, wrapped source, and live catalogue metadata.
- Cross-language edges and ORDS are designed but not shipped.
- No lexical search or embeddings.
- Generation-granular reuse; no incremental compiler state.
- The core stores dependency facts but does not interpret language-specific
  semantics; the adapter supplies bounded kinds and canonical target identifiers.
