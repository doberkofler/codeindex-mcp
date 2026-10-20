# CodeIndex Publication Policy Redesign

Date: 2026-10-20

Status: accepted authoritative contract as of 2026-10-20. This file supersedes every
versioned `codeindex-publication-policy-v*.md` specification and history document; no
such document remains in the repository. Items marked **Open** require an owner decision
or measurement; all other rules are normative.

This document preserves the final rationale, evidence, rejected alternatives, and open
work—not the chronological review transcript. Superseded intermediate proposals have no
normative value after acceptance.

Implementation progress is tracked in
[codeindex-publication-policy-redesign-todo.md](./codeindex-publication-policy-redesign-todo.md).

## Purpose

CodeIndex must make high-value declarations easy for a model to find without deleting
the internal structure required for navigation, references, dependencies, and caller
ownership.

The redesign has five outcomes:

1. For equal match quality, published names rank above reachable implementation names
   and internal names; an exact name still outranks a prefix match.
2. Parameters, type parameters, ordinary locals, iterators, and anonymous callbacks do
   not become first-class search results.
3. Named internal declarations, declaration/definition sites, references, shadowing,
   dependencies, and enclosing callers remain navigable.
4. Language adapters own language semantics. The core owns generic fact finalization,
   validation, persistence, publication, bounds, and queries.
5. Oracle production indexing remains structural and source-based. PL/Scope and data
   dictionary views are qualification evidence, not production dependencies.

## Scope

This contract covers:

- the normalized symbol, binding, location, and occurrence model;
- TypeScript and JavaScript publication classification;
- Oracle PL/SQL publication classification;
- schema changes and invariants;
- model-facing query behavior;
- qualification gates;
- the implementation sequence.

Deferred scope:

- Oracle triggers, views, schema object types, and ORDS handler blocks;
- synthetic endpoint symbols and cross-language TS-to-ORDS-to-PL/SQL edges;
- full-text search and embeddings;
- dependency-tool naming, MCP tool naming, context-cost ordering, and
  `structuredContent` changes unrelated to this fact model;
- CommonJS export assignments; K3 keeps them outside the publication model.

## Decisions

| ID | Decision |
|---|---|
| D1 | Persist one canonical symbol with N definition occurrences. There is no `symbol_location` table |
| D2 | `forward_definition` is an independent modifier on a definition occurrence |
| D3 | `implementation` is reserved for future symbol-to-symbol relations, not a location role |
| D4 | Definition occurrences carry declaration extents; occurrence ranges remain identifier/name ranges |
| D5 | `read_symbol` reads the primary definition by default and accepts an opaque definition-site ID |
| D6 | Oracle identity includes owner because the corpus spans multiple schemas |
| D7 | The current CodeIndex Oracle adapter indexes package specs/bodies and standalone procedures/functions |
| D8 | Exposure belongs to a searchable binding in a project context, not directly to a declaration |
| D9 | Binding-context exposure is `published`, `reachable`, or `internal`; derived symbol exposure uses `internal_only` for its third value |
| D10 | Public-only persistence is rejected. Stored internal symbols preserve navigation and references |
| D11 | Dependency declarations are not materialized as symbols |
| D12 | Persist a deliberately scoped TypeScript address projection; mark the remaining consumer-visible declarations `reachable` |
| D13 | Canonical binding identity is separate from human-readable display text |
| D14 | Identity anchor and primary read site are independent |
| D15 | Incompatible schema versions are rebuilt, never migrated in place |

Accepting this contract explicitly accepts D9, D12, and D13: the scoped projection,
three-valued exposure, and canonical binding-key encoding. CommonJS remains deferred by
K3; acceptance does not enable it.

## Current repository constraints

These facts constrain the implementation:

- Builds are full-program and full-generation. Several generations can coexist.
- Extraction, finalization, and persistence remain in the build worker; the MCP
  transport stays responsive. Existing build-lease ownership is unchanged.
- Extraction, persistence, and verification happen before atomic publication. A failed
  candidate leaves the active generation intact.
- The repository does not hold one database transaction across the complete build.
- Readers select the published generation through `metadata.current_generation` and
  never query `building` rows.
- Symbol IDs are location-derived. Stability lasts only while their identity-anchor
  path, offset, name, and kind remain unchanged.
- Existing contexts are `project_context`, `symbol_context`, and
  `occurrence_context`. A location may resolve differently in different contexts.
- The `file` primary key is `(generation_id, path)`.
- The `symbol` primary key is `(generation_id, id)`.
- The `occurrence` primary key is
  `(generation_id, symbol_id, path, start_offset, role)`.
- Persisted paths are workspace-relative POSIX paths.
- Current symbol ranges are declaration extents:
  - TypeScript: `node.getStart(sourceFile)` through `node.end`;
  - Oracle: `declaration.range`.
- TypeScript is pinned to 6.0.3.
- Current `SCHEMA_VERSION` is 9.
- `find_symbol` and `find_references` already accept a context filter.
- `find_references.role` is optionally `definition` or `reference`.
- `read_symbol` currently selects by `symbolId` and accepts 0-20 context lines.
- Foreign keys are enabled on every database connection.
- Tool output is bounded by `CODE_INDEX_MAX_RESULT_BYTES`; source output is also
  bounded by `CODE_INDEX_MAX_READ_LINES`.
- `read_symbol` verifies the current content hash and rejects stale source.
- Tool output never contains stack traces, credentials, or absolute source paths outside
  the configured scope.

Corpus baseline:

| Corpus | Current facts |
|---|---|
| TypeScript | 165 files, 34,058 symbols, 409,071 occurrences |
| Oracle structural parser | approximately 93,000 symbols and 395,000 occurrences |
| Oracle packages | 610 specs, 606 bodies, 606 spec/body pairs |
| Oracle nested routines | 190 across 78 files |

The Oracle Phase 8 parser decision and measurements remain documented in
`benchmark/oracle-phase8/README.md`.

### Implementation map

| Surface | Current responsibility / redesign impact |
|---|---|
| `src/adapters/types.ts` | evolve the single `ExtractorType.build()` return seam |
| `src/core/model.ts` | serializable fact and public tool contracts |
| `src/core/generation/buildGeneration.ts` | build, finalize, validate, persist, publish ordering |
| `src/core/storage/schema.ts` | schema version, DDL, constraints, indexes |
| `src/core/storage/database.ts` | FK-safe complete-generation persistence and atomic publication |
| `src/core/query/queryService.ts` | symbol, outline, position, and reference query orchestration |
| `src/core/query/readSymbolResult.ts` | bounded `read_symbol` response/list modes |
| `src/core/query/readSymbolSource.ts` | source hash verification and extent reads |
| `src/adapters/typescript/extractSymbols.ts` | TypeScript declaration/occurrence extraction and current anchors |
| `src/adapters/typescript/index.ts` | cross-context merge/final TypeScript adapter build |
| `src/adapters/typescript/symbolIdentity.ts` | location-derived TypeScript IDs |
| `src/adapters/oracle/symbolTables.ts` | Oracle spec/body grouping and IDs |
| `src/adapters/oracle/forwardDeclarations.ts` | package-body forward pairing |
| `src/adapters/oracle/syntax.ts` | Oracle declaration forms and source ranges |
| `documentation/architecture.md` | repository-wide adapter/core constraints; this policy must remain consistent with it |

## Architecture

### Data flow

```text
scan
  -> language adapter analysis and classification
  -> serializable extracted fact set
  -> language-neutral core finalization
  -> complete-generation persistence
  -> persisted-fact validation
  -> atomic publication
  -> bounded model-facing queries
```

### Adapter seam

`ExtractorType.build()` remains the sole extraction interface. Do not add language
callbacks to the core.

Conceptually, an adapter emits:

```ts
type ExtractedFactSet = Readonly<{
	files: readonly SourceFile[];
	symbols: readonly ExtractedSymbol[];
	bindings: readonly ExtractedBinding[];
	bindingContexts: readonly ExtractedBindingContext[];
	bindingSites: readonly ExtractedBindingSite[];
	surfaceOrigins: readonly ExtractedSurfaceOrigin[];
	occurrences: readonly ExtractedOccurrence[];
	dependencies: DependencyExtractionResultType;
	adapterStats: readonly BuildStat[];
	diagnostics: readonly Diagnostic[];
	compilerMs: number;
	extractionMs: number;
}>;
```

The exact production names may follow existing repository conventions. The interface
must remain one serializable fact bundle rather than one adapter method per table.

Adapters own:

- canonical language-symbol grouping;
- authored-root and external-declaration classification;
- persistence decisions;
- declaration kinds;
- identity-anchor and primary-site ranks;
- searchable binding segment vectors, display text, and context exposure;
- TypeScript surface projection and reachability;
- language-semantic traversal and its configured per-root step ceiling;
- Oracle spec/body/forward pairing;
- reference resolution and usage classification;
- language-semantic diagnostics.

Compiler and parser objects never cross the adapter seam.

### Core finalization module

One deep, language-neutral module finalizes extracted facts. Its interface is
conceptually:

```ts
type FinalizationPolicy = Readonly<{
	mode: 'enforce' | 'report';
	maxSurfaceBindingsPerRoot: number;
}>;

const finalizeFacts = (
	facts: ExtractedFactSet,
	policy: FinalizationPolicy,
): FinalizedFactSet => {
	// Deterministic derivation and structural validation.
};
```

Both modes require finite positive safety ceilings.

Place the implementation behind one public entry point under `src/core/facts/`.
Language adapters depend only on serializable fact types, not finalizer helpers or
storage row types.

It owns:

- deterministic ordering;
- canonical binding-key and relative-path serialization;
- definition-site and binding-ID derivation;
- primary and identity-anchor selection from adapter ranks;
- symbol exposure derivation from binding contexts;
- denormalized symbol fields;
- generic aggregate statistics derivable from emitted facts;
- generic structural invariants;
- duplicate and collision detection;
- generic per-root emitted-fact ceilings and fail-closed errors.

The core does not decide whether a TypeScript name is exported, whether an Oracle
routine is public, whether a type is anonymous, or how many semantic traversal steps a
language graph consumed. Those are adapter semantics. Model-response byte and list
bounds belong to query modules, not finalization.

The finalizer imports no compiler, parser, package-manager, or version-control client.

Every configuration value that can change emitted facts—including projection ceilings,
reachability-step ceilings, and any future CommonJS switch—participates in
`config_hash`.

### Persistence module

Generation orchestration persists a complete fact set through one deep storage
operation, conceptually:

```ts
database.insertGenerationFacts(generationId, finalizedFacts);
```

The storage implementation owns FK-safe insertion order, table writes, count checks,
and database-level validation. It does not reinterpret language facts. Storage-row
types remain private to storage and do not leak back into adapters.

Report-only qualification is a separate build mode. It never persists or publishes a
generation. A report safety-ceiling overrun marks the report incomplete and aborts that
run; raise the controlled report ceiling and rerun until no overrun occurs. Normal builds
use the accepted production ceilings and fail the candidate on an overrun. Neither mode
silently truncates facts.

### Query modules

Each model-facing tool has one query module that hides joins, pagination, and response
bounds. MCP handlers know tool contracts, not schema layout or adapter semantics.

## Fact model

### Persistence and exposure

Persistence is per symbol:

- `stored`: a navigable symbol with at least one definition occurrence;
- `ephemeral`: a declaration used during resolution/classification but not persisted as
  a symbol or occurrence owner.

Exposure is per binding and project context:

- `published`: the persisted binding is an address a consumer can write or follow;
- `reachable`: the binding's declaration is consumer-visible through a published type
  surface, but this lexical binding is not itself writable;
- `internal`: the binding is not consumer-visible from a published root.

A reachable lexical binding can coexist with a published surface binding for the same
symbol. Exposure is classified per binding; a published alias never upgrades or hides
the symbol's other lexical bindings.

Symbol exposure is derived as the highest exposure across its bindings and contexts:

```text
published > reachable > internal_only
```

Example: one symbol, differently exposed names:

```ts
const x = (): void => {};
export {x as y};
```

- binding `x`: internal;
- binding `y`: published;
- symbol: published.

Example: reachable declaration without a projected deep address:

```ts
class Hidden {
	public m(): void {}
}

export const api: {x: Hidden} = {x: new Hidden()};
```

- `api` and projected address `api.x`: published;
- lexical binding `Hidden.m`: reachable;
- `api.x.m`: deliberately not persisted because projection stops when a named type is
  entered below depth zero.

### Lexical and address hierarchies

`symbol.enclosing_id` is lexical/navigation ownership. It answers where an authored
declaration lives.

A binding key is a searchable address. It answers how a model or consumer reaches a
name.

```ts
function make() {
	const local = {run(): void {}};
	return local;
}

export const api = make();
```

- `run.enclosing_id` is `make`, the nearest stored declaration;
- local variable `local` is ephemeral;
- projected binding `api.run` is published;
- lexical binding for `run` under `make` is reachable;
- `make` is internal and is not a publication root.

The hierarchies are independent. Lexical containment never implies addressability.

### Entities

Every key and foreign key includes `generation_id`.

| Entity | Key | Principal fields |
|---|---|---|
| `project_context` | existing | existing context metadata |
| `symbol_context` | existing | symbol membership in a context |
| `occurrence_context` | existing | context-specific occurrence resolution |
| `symbol` | `(generation_id, id)` | denormalized primary fields, anchor-derived kind, enclosing symbol, derived exposure, optional external target |
| `symbol_name` | `(generation_id, binding_id)` | canonical `binding_key`, symbol, display container/name/qualified name |
| `symbol_name_context` | `(generation_id, binding_id, context_name)` | binding exposure in one context |
| `symbol_name_site` | `(generation_id, binding_id, path, start_offset)` | site range and kind |
| `surface_binding_origin` | `(generation_id, binding_id, context_name)` | published root binding and canonical relative path |
| `occurrence` | existing composite key | definition/reference metadata, declaration kind, usage, extent, ranks, owner |
| `definition_site` | `(generation_id, site_id)` | FK to one definition occurrence |
| `build_stats` | `(generation_id, language, metric, dim1, dim2, dim3)` | aggregate integer value |

### Canonical binding keys

Human-readable display strings are not identity. Every extracted binding has an
adapter-produced, injective vector of typed address segments. The core validates the
generic tuple shape, serializes it canonically as `binding_key`, and derives
`binding_id`. It can concatenate root and relative vectors without interpreting any
language-specific segment kind.

TypeScript uses canonical JSON containing one leading scope segment and typed address
segments:

```ts
type AddressSegment = readonly [
	kind: string,
	value: string | number | null,
];
```

Vectors are non-empty. Segment kinds are non-empty strings; numeric values are
non-negative safe integers; tuples have exactly two elements. Adapters validate which
kinds, values, and ordering are legal for their language.

Examples:

```json
[["module","src/a.ts"],["member","api"],["member","run"]]
[["module","src/a.ts"],["member","f"],["return",null],["member","run"]]
[["module","src/a.ts"],["member","f"],["param",0],["member","x"]]
[["module","src/a.ts"],["member","api"],["member","a.b"]]
[["global",null],["member","GlobalApi"]]
[["external_module","ext"],["member","augmentedMember"]]
```

Oracle uses the same canonical representation with an `owner` segment followed by
`member` segments for package and lexical containment. Overloads can share an address;
their distinct symbol IDs keep their bindings distinct. Unquoted identifiers use their
Oracle canonical spelling, while quoted identifiers preserve authored spelling.

For Oracle, `owner` has the canonical schema owner as its string value and `member` has
the canonical/quoted declaration spelling.

Required segment kinds for the TypeScript adapter:

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

For `external_module`, canonical target means the exact decoded module-specifier string
from the augmentation declaration; no path or separator normalization is applied.

Oracle permits `owner` followed by one or more `member` segments. TypeScript requires
exactly one leading `module`, `global`, or `external_module` segment. An internal module
augmentation uses the resolved internal module's `module` segment; a script global or
`declare global` contribution uses `global`; an authored augmentation of an external
module uses `external_module`.

`sig` values are zero-based positions in the adapter's deterministic public-signature
order. For multiple construct signatures, `sig` follows `construct`. `param` values are
zero-based declaration positions. `element` is null only for a homogeneous array-like
element and is a zero-based integer for a tuple position. The independent qualification
implementation must use the same ordering contract.

`JSON.stringify` with no whitespace is the persisted canonical serialization. Names
remain JSON strings, so dotted, quoted, numeric, and separator-containing names cannot
collide. The leading scope or owner is part of the canonical key; it is never
concatenated as an unescaped identity prefix [16].

`container`, `name`, and `qualified_name` are derived display/search fields. TypeScript
display uses `.name` for IdentifierNames, JSON bracket notation for other member names,
`::kind` notation for non-member segments, and an explicit leading scope whose string
value is JSON-quoted. The initial display is injective within each adapter. Display may
evolve without changing binding identity.

Initial TypeScript display is deterministic:

```text
module["src/a.ts"]::api.run
module["src/a.ts"]::api["a.b"]
module["src/a.ts"]::f::sig[0]::param[0].x
module["src/a.ts"]::f::return::awaited.go
module["src/a.ts"]::C::construct.inst
module["src/a.ts"]::xs::element[0].k
global::GlobalApi
external["ext"]::augmentedMember
```

`container` is the display prefix before the terminal member and `name` is that member's
exact spelling. Oracle display is owner-qualified lexical containment using Oracle's
canonical/quoted spelling, beginning with `owner["SCHEMA"]::`. The core compares either
complete `name` or complete `qualified_name`; it never parses these displays.

Natural binding uniqueness is:

```text
(generation_id, symbol_id, binding_key)
```

`binding_id` hashes `(symbol_id, binding_key)`, excluding `generation_id`.

Changing segment meaning, ordering, or serialization is an incompatible fact-model
change: bump the schema and relevant adapter version and rebuild.

A lexical vector starts with its context-specific scope segment and follows the chain of
stored lexical declarations as `member` segments. Ephemeral declarations do not become
segments. A published alias has its own root vector. A surface vector is exactly that
root vector plus its relative semantic path. Distinct symbols may intentionally share
one address vector—for overloads, unresolved union semantics, or transparent anonymous
syntax—but one symbol cannot duplicate the same vector.

### Binding sites

One binding can have several source sites.

| Site kind | Meaning |
|---|---|
| `declared` | the symbol's authored identifier |
| `alias` | same-module export specifier |
| `default` | `export default` clause |
| `reexport` | named re-export from another internal module |
| `wildcard` | binding introduced through internal `export *` |
| `commonjs` | CommonJS export assignment; reserved while K3 keeps CommonJS publication disabled |
| `surface` | projected address whose source site is its published root |

A declared site equals a definition occurrence's name range. Export sites lie in an
authored export statement. Surface sites equal a site of their root binding.

Every published alias of a root is a separate root binding. Projected members under
that alias receive their own surface binding. If a projected address equals an existing
lexical binding key for the same symbol, the facts coalesce rather than duplicate.

`surface_binding_origin` stores:

- the root binding ID for the context;
- the canonical path segments after the root.

The destination binding's full segment vector must equal the root vector followed by
the relative vector. The core validates this before serializing either key.

### Binding contexts

Bindings and source sites are stored once per generation. `symbol_name_context` states
where each binding exists and whether it is published, reachable, or internal.

A source file can be a script in one TypeScript context and a module in another. The
same location-derived symbol can therefore have different binding keys and exposure by
context [13-15].

### Identity anchor

Every stored symbol has exactly one identity anchor. The symbol ID and `symbol.kind`
come from that definition occurrence. Identity is independent of the primary read site.

The adapter emits `anchor_rank`; the core orders by:

1. `anchor_rank`;
2. path, bytewise;
3. start offset;
4. remaining occurrence-key fields.

TypeScript:

- all authored declarations initially have equal anchor rank;
- path then offset reproduces today's identity-bearing declaration for merged and
  overloaded symbols;
- no fixed kind precedence is applied; `symbol.kind` remains the identity anchor's
  declaration kind. Phase 2 measured 13 merged symbols in the TypeScript compiler
  corpus, 559 in VS Code, and 0 in Material UI; the illustrative precedence would
  change 5, 438, and 0 kinds respectively. That churn is rejected.

Oracle:

1. paired package/routine/cursor specification site;
2. full body implementation;
3. package-body forward declaration.

This preserves current spec-based IDs for paired packages and routines. Current
package-body private forward groups use the full implementation's ID, so an unpaired
body routine anchors on its full implementation rather than its earlier forward
declaration.

### Primary definition

Every stored symbol has exactly one primary definition occurrence. `read_symbol`
defaults to it. The adapter emits `primary_rank`; the core uses the same deterministic
tie-breakers as the identity anchor.

TypeScript:

1. implementation signature;
2. overload signature;
3. merged declarations of equal rank ordered by path and offset.

Oracle routines and cursors:

1. full body implementation;
2. specification declaration;
3. package-body forward declaration.

Oracle package symbols:

1. package specification;
2. package body.

Spec-only call specs and polymorphic table functions use their only definition.

The denormalized `symbol` path/range comes from the primary definition extent.
`symbol.kind` comes from the identity anchor.

### Primary binding

For each symbol, choose its primary binding by:

1. a `declared` or `default` site matching the primary definition's name range;
2. `declared` before `default`;
3. `binding_key`, bytewise;
4. `binding_id`, bytewise.

`symbol.name` and `symbol.qualified_name` are copied from this binding. A query-context
filter does not change the global primary binding. Tool responses report its overall
exposure and whether it exists in the requested context.

### Definition-site and binding IDs

IDs exposed by tools are deterministic hashes of natural keys without
`generation_id`:

```text
site_id    = hash(symbol_id, path, start_offset, role)
binding_id = hash(symbol_id, binding_key)
```

Use SHA-256, retain 96 bits as 24 lowercase hexadecimal characters, and prefix IDs with
`o_` for definition sites and `b_` for bindings. Serialize each key part as UTF-8,
preceded by its UTF-8 byte length in ASCII decimal and `:`, and followed by `;`. Numeric
parts use finite base-10 integer spelling. Uniqueness is per generation. A collision
fails the candidate build; colliding rows are never merged [21].

Autoincrement IDs are rejected because a stale ID could silently select a different
row after rebuild.

## Definition occurrences

### Roles and kinds

Every definition occurrence has:

- `role = definition`;
- `declaration_kind`;
- `forward_definition`;
- name range;
- declaration extent;
- `anchor_rank`;
- `primary_rank`;
- enclosing stored owner.

References have `role = reference`, no declaration kind or extent, and
`forward_definition = false`.

Definition and ForwardDefinition are independent SCIP roles [11]; their combined use
here is a CodeIndex policy choice.

| Construct | Definition treatment |
|---|---|
| Oracle package spec and body | two definitions; neither forward |
| Oracle spec routine or cursor requiring a body | definition + forward |
| Oracle body full routine or cursor | definition |
| Oracle package-body private forward | definition + forward |
| Oracle call spec | definition, not forward |
| Oracle polymorphic table function declaration | definition, not forward |
| Oracle spec-only constant, variable, type, exception | definition |
| TypeScript overload signature | definition + forward |
| TypeScript implementation signature | definition |
| TypeScript merged declarations | one definition per declaration, each with its own kind |

Per-site `declaration_kind` is required because one TypeScript symbol can merge a
function and namespace. Function cardinality checks consider only sites of the same
declaration kind.

### Extents

Definition extents preserve current adapter behavior:

- TypeScript: `node.getStart(sourceFile)` through `node.end`;
- Oracle: `declaration.range`.

The policy does not widen them to comments or surrounding trivia. Extent changes are a
separate measured decision. Definition extents mirror SCIP enclosing ranges [11].

Every currently supported definition requires an extent. A nullable exception needs a
closed code allow-list and a documented reason; the initial allow-list is empty.

## TypeScript and JavaScript policy

### Persistence

Stored navigable candidates:

- named module- and script-scope declarations;
- members of stored declarations;
- authored member declarations reached by the surface projection;
- synthetic authored alias symbols for supported external export clauses;
- synthetic `default` symbols for anonymous/default expressions.

Never stored:

- parameters and type parameters;
- loop iterators;
- anonymous callbacks;
- ordinary local variables;
- declarations whose only source is outside authored roots.

Authored roots exclude all declaration files, including authored `.d.ts` files,
generated output, `node_modules`, TypeScript library declaration files, and declarations
supplied by other packages. Authored `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`,
`.mjs`, and `.cjs` files remain authored roots when their configured project includes
them; JavaScript requires the project's existing `allowJs` policy.

Named nested functions are stored. The Phase 2 dry run measured 5,988 nested functions
and 127,430 lines in the TypeScript compiler corpus, 1,160 and 15,701 lines in VS Code,
and 47 and 832 lines in Material UI. They are named callers, so preserving navigation
outweighs their storage cost; ordinary local variables remain excluded.

Top-level candidates are stored regardless of exposure. This preserves internal helper
navigation and cross-file reference resolution.

Anonymous object literals, anonymous class expressions, and anonymous callbacks are
transparent for lexical ownership. A named class expression is a declaration. A stored
candidate owns children only when it is stored; otherwise owner selection skips it. A
stored member reached through transparent or ephemeral syntax keeps the nearest stored
lexical declaration as `enclosing_id`; surface projection never rewrites lexical
ownership.

### Default exports

- Anonymous default function/class: one symbol named `default`, a default site on the
  clause, and the declaration extent.
- `export default x` for an internal symbol: a default binding/site on `x`; no second
  symbol.
- Every other default expression: one synthetic variable symbol named `default`, a
  default site, and a surface-projection root.

For every anonymous or synthetic default symbol, the name range is the `default` token
and the definition extent is the complete export-default declaration/assignment. A
synthetic external alias introduced by a named or namespace export uses the authored
export specifier as its definition extent and the exported name token as its name range
and `declared` site.

Examples:

```ts
export default () => ({run(): void {}});
export default {run(): void {}};
```

Projected bindings include `default::return.run` and `default.run` respectively.

### Publication roots

A root is a published binding in one context, not merely a declaration. Roots include:

- exported declarations and aliases;
- internal re-export bindings;
- script globals;
- authored global/module augmentation contributions;
- synthetic default bindings;
- CommonJS exports when enabled; K3 currently keeps CommonJS publication disabled.

An internal helper called by an exported declaration is not a root. Multiple published
aliases of one symbol are distinct roots and produce distinct projected addresses.

### Surface projection

The persisted projection contains exactly:

1. each published root binding itself;
2. members lexically contained by a published class, interface, enum, type, or
   namespace;
3. members of anonymous shapes at any depth below a published root;
4. inherited authored members under each published derived type;
5. depth-zero members of the declared/resolved type of a published value root.

At depth zero, enumerate a root value's members even when its type is named. Below
depth zero, expand only anonymous shapes. Entering a named type terminates address
projection; its authored declarations become reachable instead.

Projection is computed independently for every published root binding in every project
context. It follows compiler-resolved types so inferred shapes are included. Every
distinct canonical path is retained, including equal-depth paths to the same symbol.

Address edges:

- properties, methods, and accessors;
- call signatures, parameters, and return types;
- construct signatures, parameters, and instance types;
- awaited payloads;
- array/tuple element types;
- inherited authored members.

Type arguments of other generic types are reachability edges, not projected address
edges. Private and ECMAScript `#` members are never projected; protected members remain
part of the type surface.

Traversal follows types without materializing parameters or locals. For
`export function f(p: {x: string}): void`, the authored member `x` can receive the
surface binding `f::param[0].x`; parameter `p` remains ephemeral. For a helper-built
object, only the exported value binding is a root: `api.run` is published while the
internal helper and local variable are not promoted.

### Anonymous-shape predicate and cycles

`ts.ObjectFlags.Anonymous` is insufficient: TypeScript 6.0.3 also sets it on named type
aliases. A type is expandable as an anonymous shape only when it has no authored named
class, interface, type-alias, enum, or namespace identity and no `aliasSymbol` denoting
such an identity.

Output-path traversal uses path-local cycle detection, not one global visited set. This
preserves distinct equal-depth paths. A cycle with no named terminal is unsupported and
fails the candidate build rather than truncating silently.

Union and intersection constituent-only declarations are `reachable`, not projected
addresses. A projected address is emitted only when the projection reaches one
unambiguous authored terminal. The Phase 2 prototype observed 7,060 union and 224
intersection nodes in the TypeScript compiler corpus, 28,589 and 659 in VS Code, and 447
and 94 in Material UI. The canonical binding model still permits multiple symbols to
share one address key when a future projection form proves one.

### Reachability closure

A separate visited-set closure marks every consumer-visible authored declaration,
regardless of whether that symbol also has a projected writable address. It follows:

- every surface-projection edge;
- named types;
- base types and heritage clauses;
- union/intersection constituents;
- generic type arguments, including authored types inside external generics;
- enum members and namespace exports;
- `typeof` targets;
- index signatures and constraints.

Marks are idempotent, so a global visited set is correct for this closure. Private and
ECMAScript `#` members remain internal. Protected members remain part of the authored
type surface and are qualified explicitly by G-A/G-A2.

For each context, an importable/containment binding is published when its address is
writable; every surface binding is published when its root is published; a non-writable
lexical binding is reachable when its declaration was marked by the closure; every
remaining binding is internal.

### Projection ceilings

The address count and reachability-step count are bounded per root. Exceeding either
ceiling fails the candidate generation; it never publishes incomplete facts.

Ceilings are external configuration included in `config_hash`. Values come from dry-run
maxima plus documented headroom. Do not hard-code values derived from one consumer
corpus as package defaults.

A **surface address** is a published root binding or one projected relative address. A
**reachability step** is one enqueued type or declaration expansion in the per-root
closure; repeated visits to an already-marked declaration still count as steps but are
not re-expanded.

Phase 2 measured the three frozen TypeScript corpora with the independent P-3
compiler-type probe (2026-10-20):

| Corpus | Maximum surface addresses per root | Maximum reachability steps per root |
|---|---:|---:|
| TypeScript compiler | 492 | 6,815 |
| VS Code | 674 | 13,286 |
| Material UI | 122 | 2,147 |
| **Observed maximum** | **674** | **13,286** |

The accepted per-root ceilings are **2,000 surface addresses** and **50,000 reachability
steps**. Each is the smallest `1/2/5 x 10^n` value at or above twice the observed
maximum; the resulting headroom is 2.97x and 3.76x. Both values are qualification
evidence for external configuration, not package defaults. The probe cap is 10,000
addresses and 50,000 steps per root; a probe-budget overrun makes the measurement
partial rather than silently truncating it. Projection uses path-local cycle detection
and a 64-level depth guard; a depth-limited root also makes the measurement partial.

### External declarations and exports

| Rule | Behavior |
|---|---|
| External declarations | never materialized as symbols, bindings, or occurrences |
| Named external re-export | one authored alias symbol at the clause with a `declared` site, published |
| `export {importedExternal}` | one authored alias symbol with a `declared` site, published |
| `export * as ns from 'ext'` | one authored namespace alias symbol, published; external members omitted |
| `export default importedExternal` | one authored default alias symbol with a `default` site, published |
| Bare `export * from 'ext'` | no symbol expansion; dependency fact and status counter only |
| Internal `export *` | compiler export table transitively expands one `wildcard` binding per resolved exported name; compiler conflict resolution wins |
| Authored augmentation of external symbol | store each authored declaration and member as its own symbol/binding facts; external declarations remain absent |
| External terminal member by any route | omit from symbols, bindings, reachability, and qualification truth |

For external aliases, `external_target` stores the module specifier and `external_name`
stores the imported name (`*` for a namespace and `default` for a default import). For
authored augmentations, they store the augmented module or `global` and merged name.
References from authored importers to an alias target the authored alias symbol and are
stored. References whose terminal target is external are dropped and counted.

External-terminal filtering is based on the terminal declaration's source file, not on
the type of an authored property. An authored property whose value type is external is
still an authored, searchable declaration; members declared by that external type are
not.

ESM JavaScript follows the TypeScript path. K3 is resolved as deferred: CommonJS
export assignments remain outside the publication model. P-2 found no `export =`
module in the three public corpora, `getExportsOfModule` exposes no consumer-facing
name for `export =`, and the identifier and expression forms do not share one
defensible binding name. CommonJS files remain indexed under the existing
non-publication semantics.

## Oracle policy

### Persistence and exposure

| Classification | Oracle declarations |
|---|---|
| Stored and published | packages, spec declarations, standalone procedures/functions |
| Stored and internal | body-only declarations, nested routines |
| Ephemeral | parameters, ordinary locals, routine-local types/cursors/exceptions, loop iterators |

Oracle does not use `reachable`; its lexical address is its consumer address.
Body-only package declarations are internal to the package body [2].
Exposure is therefore not file-local: classify package members only after whole-
generation spec/body pairing.

Several schemas exist, so owner participates in canonical identity and binding keys.
Unquoted names use Oracle canonical case; quoted names preserve authored case.

M8 is resolved. Production indexing keeps the authored source and structural parser as
its only name source; it does not dereference synonyms. Qualification truth uses
`ALL_PROCEDURES`, `ALL_ARGUMENTS`, and PL/Scope restricted to the frozen
`(OWNER, OBJECT_NAME)` inventory. `CURRENT_SCHEMA` resolves unqualified names when
Oracle compiles a unit, so the adapter records the manifest/default schema as the owner
segment for unqualified declarations and preserves explicit schema qualifiers. A
synonym target is never expanded into a different owner or name.

Matching is exact on the persisted canonical spelling. An unquoted query is canonicalized
to uppercase before exact/prefix comparison; a quoted query preserves its spelling. The
local probe recorded `NLS_COMP = BINARY`, `NLS_SORT = BINARY`, and no owned synonyms;
with binary comparison, unquoted names are compared without linguistic case folding.

### Declaration forms

The structural parser records each routine/cursor form:

- specification declaration;
- full definition;
- package-body forward declaration;
- call spec;
- polymorphic table function declaration.

### Spec/body pairing

Pair packages by owner and canonical package name.

Routine candidate lookup may use the current reduced signature and fallback. Pairing is
accepted only when the full normalized headings match apart from whitespace. If no
candidate matches, or several candidates tie, declarations remain separate symbols and
the adapter emits a diagnostic. Ambiguous matches never silently choose a target
[17,18].

Cursor declarations/definitions pair by owner, package, name, and normalized heading.

Call specs and polymorphic table functions do not require a body definition. Every
other spec routine/cursor in a paired package requires exactly one full body definition
[1,17-19].

Package-body private forward declarations pair with the corresponding full body
implementation under the same full-heading and ambiguity rules. The full implementation
owns identity when no spec site exists.

### Production and qualification

Production indexing uses authored source and the structural parser. PL/Scope is never a
runtime dependency. It supplies qualification evidence for declarations, definitions,
references, calls, assignments, and signatures [3-6].

Wrapped units provide no PL/Scope data and are reported as a limitation [4].

## Occurrences

An occurrence is stored only when its target is a stored symbol. Targets that are
ephemeral or external are dropped and counted.

Reference ownership is the innermost stored definition extent containing the reference
name range. Definition ownership is the innermost containing stored symbol other than
the definition's own target; it must equal that symbol's `enclosing_id`. Top-level
occurrences have a null owner exactly when no stored containing extent qualifies.

Exposure never controls occurrence storage. Internal/reachable chains remain intact as
long as their declarations are stored.

Occurrence ownership plus the `call` bit is not a call graph. It records a resolved
source occurrence and its lexical owner; it does not claim dynamic dispatch targets,
runtime reachability, or completeness for unsupported constructs.

### Usage bits

| Bit | Value | Meaning |
|---|---|---|
| `call` | 1 | callee of invocation or construction |
| `read` | 2 | value read |
| `write` | 4 | assignment target or Oracle OUT argument |
| `type_ref` | 8 | identifier in a type position |

Legal values are `0`, `1`, `2`, `4`, `6`, and `8`. Zero means unclassified. Definition
occurrences always use zero.

Compound assignment, increment/decrement, and Oracle IN OUT arguments use read + write.
Usage filtering reports the number of unclassified references in the same scope.

TypeScript usage comes from the syntactic role of the compiler-resolved identifier.
Oracle qualification maps PL/Scope `CALL` to call, `ASSIGNMENT` to write, and
`REFERENCE` to read unless the target is a type/subtype, where it is `type_ref`.
Annotations, heritage clauses, declared types, and Oracle `%TYPE` targets are
`type_ref`.

### Dependency completeness

| Edge source | Symbol occurrence | Package dependency |
|---|---|---|
| Ambiguous Oracle overload | omitted with diagnostic | retained when independently resolvable |
| Deferred Oracle construct | omitted | omitted |
| Wrapped Oracle unit | omitted | omitted |
| External target | omitted by policy | represented only by existing dependency facts where applicable |

Every omission category is persisted as an aggregate build statistic or explicit
limitation; none is silently reclassified as complete.

`cross_file_refs_observed = false` means only that no indexed cross-file occurrence was
observed. It does not prove file locality.

## Invariants

Validation runs after persistence while the candidate generation remains `building`,
and before atomic publication.

Ownership classes:

- **Core**: language-neutral structural check;
- **Adapter**: language-semantic check performed before facts cross the seam;
- **Measured**: report-only until corpus evidence resolves every violation class.

| ID | Owner | Invariant |
|---|---|---|
| S1 | Core | Symbol keys are unique |
| S2 | Core | `symbol.enclosing_id` is null or references a stored symbol in the generation |
| S3 | Measured | Every child definition lies within a same-path definition extent of its enclosing symbol; chains are acyclic |
| S4 | Adapter | `enclosing_id` is the nearest enclosing stored declaration |
| S5 | Core | Every symbol has definitions, exactly one identity anchor, and exactly one primary definition |
| S6 | Core | Denormalized symbol location/name fields equal the selected primary site/binding; kind equals the anchor kind |
| S7 | Core | Symbol exposure equals the maximum of its binding-context exposure |
| N1 | Core | Every symbol has a declared/default binding at a definition site |
| N2 | Core | Every binding has a canonical key, display fields, a site, and a context row |
| N3 | Core | Every `declared` site equals a definition occurrence's name range for the same symbol |
| N4 | Adapter | Export/default/re-export/commonjs sites lie in recognized authored export syntax |
| N5 | Core | Every surface binding/context has exactly one origin; its root is published and non-surface in that context, and the surface site equals a root site |
| N6 | Core | Every binding-context row has a matching symbol-context row |
| N7 | Adapter | A binding is published only when its address is writable/followable under the language policy |
| N8 | Core | Binding and definition-site IDs equal their deterministic derivations; collisions fail |
| O1 | Core | Every occurrence targets a stored symbol |
| O2 | Measured | Reference owner is the unique innermost containing stored definition; definition owner excludes its own target and equals `symbol.enclosing_id`; owner is null exactly when no stored extent qualifies |
| O3 | Core | Definitions have kind, ranks, an extent enclosing the name range, zero usage, and exactly one definition-site row |
| O4 | Core | References have no extent, declaration kind, or ranks; have legal usage; and are never forward definitions |
| L1 | Measured | Definition extents in one path are disjoint or nested; different symbols never have identical extents |
| F1 | Measured | Per declaration kind, an Oracle routine/cursor has at most one forward and one full definition; a TypeScript function has at most one non-forward implementation |
| B1 | Adapter | Stored definition sites belong to authored roots; merged external symbols retain authored declarations only |

A measured invariant becomes core/adapter enforced only after the dry run resolves all
valid violation classes. S3, O2, L1, and F1 are measured during finalization whenever
the production extractor identity is available, and `enforce` mode fails the candidate
on any violation. Qualification-only parser overrides remain report-only.

## Schema redesign

Increment `SCHEMA_VERSION` for every incompatible change (version 9 is current); rebuild
incompatible databases. Preserve the current single `.schema-<version>.bak` move-aside
behavior; do not add an in-place migration.

### `symbol`

Retain existing columns. Add:

- `external_target TEXT NULL`;
- `external_name TEXT NULL`;
- `exposure TEXT NOT NULL CHECK (exposure IN ('published', 'reachable', 'internal_only'))`;
- enforced self-FK for `enclosing_id`.

Existing path/range fields become denormalized primary definition extents. Existing
name/qualified-name fields become denormalized primary binding display. `kind` comes
from the identity anchor.

### `symbol_name`

Required fields:

- `generation_id`;
- deterministic `binding_id`;
- `symbol_id`;
- canonical `binding_key`;
- display `container`, `name`, `qualified_name`.

Constraints:

```text
PRIMARY KEY (generation_id, binding_id)
UNIQUE (generation_id, symbol_id, binding_key)
FOREIGN KEY (generation_id, symbol_id) REFERENCES symbol
```

There is no second surrogate name ID. Child tables reference the deterministic binding
ID directly. `binding_key`, `name`, and `qualified_name` are non-empty; the finalizer
validates canonical JSON and the `b_` ID format before persistence.

### Context and site tables

`symbol_name_context`:

```text
PRIMARY KEY (generation_id, binding_id, context_name)
exposure IN ('published', 'reachable', 'internal')
```

`symbol_name_site`:

```text
PRIMARY KEY (generation_id, binding_id, path, start_offset)
FOREIGN KEY (generation_id, path) REFERENCES file
kind IN ('declared', 'alias', 'default', 'reexport', 'wildcard', 'commonjs', 'surface')
end_offset > start_offset
```

`surface_binding_origin` references both the surface binding context and root binding
context. Its primary key is `(generation_id, binding_id, context_name)`. It stores
`root_binding_id` plus a non-empty canonical relative-path JSON vector. The destination
binding's full key must equal the root key followed by that relative path.

Concrete foreign keys:

| Child columns | Parent |
|---|---|
| `symbol(generation_id, enclosing_id)` | `symbol(generation_id, id)` |
| `occurrence(generation_id, enclosing_id)` | `symbol(generation_id, id)` |
| `symbol_name(generation_id, symbol_id)` | `symbol(generation_id, id)` |
| `symbol_name_context(generation_id, binding_id)` | `symbol_name(generation_id, binding_id)` |
| `symbol_name_context(generation_id, context_name)` | `project_context(generation_id, name)` |
| `symbol_name_site(generation_id, binding_id)` | `symbol_name(generation_id, binding_id)` |
| `symbol_name_site(generation_id, path)` | `file(generation_id, path)` |
| `surface_binding_origin(generation_id, binding_id, context_name)` | destination `symbol_name_context` row |
| `surface_binding_origin(generation_id, root_binding_id, context_name)` | published root `symbol_name_context` row |
| `definition_site(generation_id, symbol_id, path, start_offset, role)` | matching `occurrence` row |

### `occurrence` and `definition_site`

Add to `occurrence`:

- nullable `declaration_kind`;
- `forward_definition INTEGER NOT NULL`;
- `usage INTEGER NOT NULL DEFAULT 0`;
- nullable `extent_start`, `extent_end`;
- nullable `anchor_rank`, `primary_rank`;
- enforced nullable owner FK.

`forward_definition` is constrained to 0 or 1. The validator enforces the role-dependent
nullability rules in O3/O4.

`definition_site` has primary key `(generation_id, site_id)` and maps the deterministic
site ID to the complete existing occurrence key. Its occurrence FK can reference only a
row with `role = definition`; every definition has exactly one row. The finalizer
validates the `o_` ID format before persistence.

### `build_stats`

```text
PRIMARY KEY (generation_id, language, metric, dim1, dim2, dim3)
language, metric, dim1, dim2, dim3 TEXT NOT NULL
value INTEGER NOT NULL CHECK (value >= 0)
```

Dimensions are closed adapter/core categories, never source names, paths, queries, or
credentials.

Required metric dimensions are closed:

| Metric | `dim1` | `dim2` | `dim3` |
|---|---|---|---|
| `symbols_stored` | symbol exposure | symbol kind | empty |
| `ephemeral_declarations` | declaration kind | empty | empty |
| `occurrences_stored` | role | usage integer | empty |
| `occurrences_dropped` | `ephemeral_target`, `external_target`, or `ambiguous_overload` | empty | empty |
| `files_excluded` | `tests`, `console_ui`, `declaration_file`, or `other` | empty | empty |
| `bindings` | binding exposure | empty | empty |
| `surface_bindings` | `anonymous`, `inherited`, or `depth1` | empty | empty |
| `projection_budget_observed` | `addresses` or `reachability_steps` | `maximum` | empty |
| `sites` | site kind | empty | empty |
| `merged_declarations` | sorted declaration kinds joined by `+` | empty | empty |
| `external_reexports` | `star` | empty | empty |
| `external_aliases` | empty | empty | empty |
| `wrapped_units` | empty | empty | empty |
| `oracle_declaration_forms` | closed routine/cursor form | empty | empty |
| `oracle_pairing_diagnostics` | `heading_mismatch`, `ambiguous_candidate`, or `missing_body` | empty | empty |
| `unsupported_construct` | closed construct category | empty | empty |

Unused dimensions are the empty string, never null. Generic counts are derived by the
core from finalized facts; adapter-only facts such as ephemeral declarations, excluded
files, wrapped units, and unsupported constructs are emitted by the adapter. A ceiling
failure is a build error, not a `build_stats` row. Candidate stats are written and
validated with their generation before publication, so `index_status` never mixes
generations.

### Required indexes

| Columns | Purpose |
|---|---|
| `symbol_name(generation_id, binding_id)` | binding lookup; primary key |
| `symbol_name(generation_id, symbol_id, binding_key)` | natural binding uniqueness |
| `symbol_name(generation_id, name)` | simple-name matching |
| `symbol_name(generation_id, qualified_name)` | qualified-name matching |
| `symbol_name(generation_id, container, name)` | member listing and container filter |
| `symbol_name_context(generation_id, context_name, exposure, binding_id)` | context/exposure filtering |
| `symbol_name_site(generation_id, path, start_offset)` | path-local aliases and re-exports |
| `occurrence(generation_id, path, role, start_offset)` | definitions/references by path |
| `occurrence(generation_id, path, role, extent_start)` | interval lookup for `symbol_at` |
| `symbol(generation_id, enclosing_id)` | lexical children |
| `occurrence(generation_id, enclosing_id)` | owner filtering |
| `surface_binding_origin(generation_id, root_binding_id, context_name)` | projected bindings under a root |

Every child FK column set receives an index. Use deferred constraints only where one
batch transaction inserts mutually dependent rows; generation visibility, not a
whole-build transaction, provides publication isolation [10].

## Tool contracts

### Shared result records

Tool responses use these semantic records; production names may follow repository
conventions:

```ts
type BindingExposure = 'published' | 'reachable' | 'internal';

type ContextExposure = Readonly<{
	contextName: string;
	exposure: BindingExposure;
}>;

type BindingSiteSummary = Readonly<{
	kind:
		| 'declared'
		| 'alias'
		| 'default'
		| 'reexport'
		| 'wildcard'
		| 'commonjs'
		| 'surface';
	path: string;
	start: number;
	end: number;
}>;

type DefinitionSiteSummary = Readonly<{
	siteId: string;
	path: string;
	nameStart: number;
	nameEnd: number;
	extentStart: number;
	extentEnd: number;
	declarationKind: string;
	forwardDefinition: boolean;
	primary: boolean;
	identityAnchor: boolean;
}>;

type BindingSummary = Readonly<{
	bindingId: string;
	name: string;
	container: string;
	qualifiedName: string;
	exposure: BindingExposure;
	/** null when no context filter was requested. */
	inRequestedContext: boolean | null;
}>;

type BindingDetail = BindingSummary & Readonly<{
	contexts: readonly ContextExposure[];
	contextsTotal: number;
	contextsTruncated: boolean;
	sites: readonly BindingSiteSummary[];
	sitesTotal: number;
	sitesTruncated: boolean;
}>;

type FindSymbolItem = Readonly<{
	symbolId: string;
	kind: string;
	symbolExposure: 'published' | 'reachable' | 'internal_only';
	matched: BindingDetail;
	primary: BindingSummary;
	otherNames: readonly BindingSummary[];
	namesTotal: number;
	namesTruncated: boolean;
	sites: readonly DefinitionSiteSummary[];
	sitesTotal: number;
	sitesTruncated: boolean;
}>;
```

`qualifiedName` is display text, not an identity key. A context-filtered matched binding
uses that context's exposure. The global primary binding keeps its highest exposure over
all contexts and reports `inRequestedContext` explicitly.

Every paged response retains the existing generation ID, freshness, items, next cursor,
and truncation metadata envelope.

### `find_symbol`

Parameters:

- `query`;
- `match = name | qualified`;
- optional kind, container, declaration path, context;
- `exposure = published | reachable | visible | internal | any`;
- limit and keyset cursor.

`visible` means published or reachable.
`match` defaults to `name`.

Matching compares the requested field exactly or by whole-field prefix. The core never
splits qualified names.

`path` means a declaration path: the symbol has a definition occurrence there.
`container` means the adapter-produced module, Oracle owner/container, or surface root.
An empty prefix plus `container` lists members. An empty result names the relevant
indexing limitation and recommends text search rather than claiming source absence.
An empty query without `container` is an input error.

Candidate bindings are filtered before symbol deduplication. Choose the matched binding
by:

1. exact before prefix;
2. published, then reachable, then internal;
3. declared site before other sites;
4. container;
5. name;
6. binding ID;
7. symbol ID.

Return one item per symbol, deduplicated before ordering and pagination. Return the
matched binding, global primary binding, remaining binding summaries, and definition
sites. Every binding includes `bindingId`; every definition includes `siteId`. The
response echoes the effective exposure filter. Order deduplicated results by the same
tuple above, using symbol ID as the final tie-breaker.

When a context filter is present:

- matched and other candidate bindings must exist in that context;
- their exposure is context-specific;
- the global primary binding retains overall exposure;
- the response states whether the primary exists in the requested context.

The default exposure filter is `visible`: published or reachable bindings, never
internal-only ones. M5 was resolved on Phase 6 corpus evidence; see
`benchmark/publication-phase6/`.

### `outline`

Return the lexical tree of symbols having a definition occurrence in the path. Display
the path-local definition site and extent. Re-exported names appear in a separate,
bounded `reexports` list. Synthetic external-alias symbols with a definition in the path
remain in the lexical tree. Bindings of symbols defined elsewhere appear only under
`reexports`. Independently, `reexports` includes every binding with an `alias`,
`default`, `reexport`, or `wildcard` site in the path, even when its target is also
defined there. Collapse one wildcard clause to one entry with a name count. `outline`
has no line parameter.

### `symbol_at`

With a column, return the innermost definition extent containing the position. Without
a column, return the innermost extent covering the whole line; if sibling extents make
the line ambiguous, return ordered candidates and `ambiguous: true`. Return null with
reason `no_stored_owner` when nothing qualifies. A successful result includes the
symbol's lexical ancestor chain.

Lock the final interval query after L1 qualification.

### `find_references`

Retain `role = definition | reference`. Add optional path, enclosing-owner, usage, and
context filters. Usage with `role=definition` is an input error.

`find_references` returns a flat, deduplicated occurrence list; it does not group by symbol
or enclosing owner. Each occurrence includes its stored owner summary or null.
Context-filtered results use `occurrence_context`. Ordering is path, start offset, role,
symbol ID, then the remaining occurrence-key fields. Pagination uses a generation-bound
keyset cursor over that tuple plus a filter digest. Return the unclassified-reference
count and `cross_file_refs_observed`. Grouping is not part of the contract until a future
decision defines grouping-specific pagination.

### `read_symbol`

Selectors:

- existing `symbolId`;
- optional definition `siteId` belonging to the symbol.

Text mode reads the selected definition extent plus the existing 0-20 `contextLines`
around it. The response identifies the exact extent inside the returned source window.
Content-hash verification and stale-file rejection remain mandatory. Apply line bounds
before byte bounds and report which bound truncated output.

List modes use generation-bound keyset cursors:

- `sites`: all definition sites, primary first;
- `names`: all bindings, optionally filtered by context;
- `binding_sites`: every source site for one required binding ID;
- `binding_contexts`: every context/exposure row for one required binding ID.

Definition site summaries include declaration kind, forward status, primary status,
identity-anchor status, path, and name range.

List ordering is deterministic:

- `sites`: primary rank, then path, start offset, and remaining occurrence-key fields;
- `names`: exposure rank, container, name, binding ID;
- `binding_sites`: fixed site-kind rank (`declared`, `default`, `alias`, `reexport`,
  `wildcard`, `commonjs`, `surface`), then path and start offset;
- `binding_contexts`: context name, bytewise.

Text mode and every list mode form a discriminated result union with kinds `text`,
`sites`, `names`, `binding_sites`, and `binding_contexts`. An unknown or stale site ID,
a non-definition site ID, a binding ID belonging to another symbol, or a cursor for a
different generation/scope is an error.

### `index_status`

Report persisted aggregate policy facts for the published generation:

- stored/ephemeral counts;
- exposure and kind counts;
- dropped occurrence reasons;
- usage coverage;
- excluded/unindexed constructs;
- external alias/star behavior;
- merged-declaration kind sets;
- Oracle declaration-form, pairing-diagnostic, wrapped, and ambiguous-overload counts;
- configured projection ceilings;
- static-analysis limitations.

### Pagination and bounds

Every cursor binds:

- generation ID;
- tool/list mode;
- selector and filters;
- ordering tuple.

Using a cursor under another scope or generation is an error.

Nested lists in normal search results are capped with totals and truncation flags.
Complete nested data remains reachable through `read_symbol` list modes. Reduce whole
items, never partial objects, when enforcing `CODE_INDEX_MAX_RESULT_BYTES`.

Initial nested caps are normative:

- 3 contexts and 3 sites on the matched binding;
- 5 other binding summaries;
- 5 definition sites, primary first.

If serialized UTF-8 output still exceeds the byte bound, reduce in this order:

1. remove `otherNames`;
2. reduce matched binding contexts and binding sites to one each;
3. reduce definition sites to the primary site;
4. remove trailing top-level result items and return a cursor.

Always preserve totals and set truncation flags. Nested-list truncation is not paged by
the top-level cursor; callers use the corresponding `read_symbol` list mode. Apply the
same whole-item reduction discipline to `outline.reexports`. If one minimal whole item
cannot fit, return the existing bounded-result error rather than emitting a partial
object or invalid UTF-8.

## Qualification

Qualification runs against frozen corpora and temporary databases. Production source
indexing remains independent of qualification systems. TypeScript exposure gates run
independently for every configured project context.

### TypeScript published-address truth: G-A

K3 is resolved as deferred, so G-A covers TypeScript and ESM JavaScript publication
only; CommonJS files remain indexed under existing non-publication semantics and are
measured separately.

1. Emit declarations with TypeScript 6.0.3 into a fresh temporary output [12].
2. Load the emitted declarations into an independent program.
3. Normalize each emitted module identity back to its original workspace-relative POSIX
   source path; temporary output paths never enter truth keys.
4. Expand internal `export *` through that program's checker export table.
5. Independently compute this document's scoped address projection.
6. Remove paths whose terminal declaration is external, including external inherited
   members and names behind bare external stars. Keep the authored alias itself for
   named, namespace, and default external alias clauses.
7. Ignore private compatibility placeholders.
8. Compare a multiset of canonical binding keys, not display strings or a set.

The multiset requirement catches distinct declarations sharing one conceptual address,
such as static and instance members with the same name.

Pass conditions:

- zero truth addresses lack a published binding;
- zero published bindings lack a truth address;
- multiplicities agree.

G-A becomes normative only after the corpus prototype passes.

The production classifier must walk compiler types directly; it must not invoke
declaration emit, because qualification must remain an independent implementation.

### TypeScript reachability truth: G-A2

Build source-associated truth from two inputs:

1. Map named, non-exported supporting declarations retained in emitted `.d.ts` files
   back through declaration maps.
2. When inferred anonymous members have no individual declaration-map position, resolve
   each G-A canonical truth address against an independent fresh program over the
   original source and record its terminal authored declaration.

P-1 must prove that the second association is unique; an ambiguous or missing mapping
blocks G-A2 rather than silently weakening it. Production facts cannot be used to build
the truth association. Private and ECMAScript `#` members and emitter compatibility
placeholders are excluded; protected members remain in truth.

Validate binding-level exposure:

- every source-associated authored declaration/member has a corresponding lexical
  binding classified reachable or published;
- every reachable lexical binding occurs in source-associated truth;
- a symbol published through another surface binding does not exempt its lexical
  binding from this check.

The premises that declaration emit retains the required named supporting declarations
and that every inferred truth address can be associated uniquely are empirical. Both
must pass the corpus prototype before G-A2 becomes normative.

### Cross-file exposure: G-B

For every indexed cross-file reference in each occurrence context, the target symbol
must be published or reachable in that context. An internal-only target is a gap.

Allowed exceptions are genuinely dynamic constructs that static resolution cannot
identify. Statically resolvable literal element access is not an exception. Every
exception category has a fixed name and aggregate count.

Initial exception categories are computed/dynamic property access, `eval`-style access,
and dynamic `require` with a non-literal argument. Spread, `Object.assign`, helper-built
values, and multi-hop inferred values are not exceptions when compiler-resolved types
make them statically recoverable. A gap in a supported export or projection form is a
bug, never an allow-list entry.

### Usage: G-C

- TypeScript: compiler-resolved fixtures for call/read/write/type positions.
- Oracle: zero CALL and ASSIGNMENT mismatches against PL/Scope; report other usage
  differences.

### References: G-D

Precision remains 100%: every stored reference is confirmed by the language truth
source.

Recall covers all visible symbols—published or reachable—not only published symbols:

- TypeScript: differential comparison with `LanguageService.findReferences`, including
  references through barrels and projected/reachable members;
- Oracle: PL/Scope occurrences joined by signature and restricted to the frozen corpus.

TypeScript truth uses the repository-pinned compiler. Oracle declaration inventory uses
`ALL_PROCEDURES`; overload grouping cross-checks use `ALL_ARGUMENTS`; reference and
usage truth uses PL/Scope. Every data-dictionary query is restricted to the frozen
corpus inventory [5,7-9].

### Oracle pairing: G-E

- 610 package specs, 606 bodies, and 606 package pairs remain the package baseline.
- The four spec-only packages are not errors unless they declare a cursor or a routine
  that is neither a call spec nor a polymorphic table function.
- Each non-exempt spec routine/cursor in a paired package has exactly one full body
  definition.
- Full normalized headings match for every accepted pair.
- PL/Scope signature equality across packaged spec/body routines is verified on the
  live database before becoming a gate.
- Call-spec, polymorphic-table-function, cursor, overload, body-forward, and ambiguity
  counts are measured rather than assumed.

Filter all `ALL_*`/`USER_*` evidence to the frozen `(OWNER, OBJECT_NAME)` inventory.
Compile PL/Scope evidence with `IDENTIFIERS:ALL`; `PUBLIC` is insufficient because it
omits required definitions. Wrapped units are excluded and counted.

### Structural validation: G-F

Every enforced invariant passes after persistence and before publication. S3, O2, L1,
and F1 are measured by the finalizer for production builds and become enforcement
failures in `enforce` mode. Qualification-only parser overrides remain report-only.

### Real-task evaluation

Compare:

- grep/glob/read only;
- grep/glob/read plus CodeIndex.

Measure task success, tool calls, tokens, and false-absence claims. Keep transcripts
with the evaluator; persist aggregate counts only. Exclude cross-language tasks until
cross-language parsing exists.

Q2 acceptance thresholds, recorded on 2026-10-20:

- at least 12 independently runnable cases across locate, impact, and implementation
  classes, with 5 paired repetitions per arm and identical prompt, model, revision,
  permissions, and external fixtures;
- indexed correctness is non-inferior: no case loses correctness against baseline, and
  overall indexed success is at least 90%;
- indexed false-absence claims are at most 2% of truthful runs and never exceed the
  baseline rate; a run where the index returned an authoritative non-empty result must
  not claim absence;
- median retrieval output bytes per successful case are at least 10% lower than
  baseline;
- median total tool calls per successful case are not higher than baseline;
- median total tokens per successful case are at most 1.05x baseline;
- p95 wall time is at most 1.2x baseline.

A run with unavailable exact token usage, mismatched artifacts, or fewer than five
repetitions is invalid rather than a pass. The A/B itself remains blocked until the
private evaluation harness and model transcripts are available; no aggregate task
metrics are claimed.

The evaluation has no LSP arm unless the target client exposes a documented LSP tool
[20].

### Query telemetry

Measure exact-name `find_symbol` outcomes using eight fixed integer counters: no match,
or one counter for each non-empty presence bitmask over published, reachable, and
internal matches (`P`, `R`, `I`, `PR`, `PI`, `RI`, `PRI`).

Phase 6 implements this as the `find_symbol_outcome` analytics event. Cursor
continuations are not counted twice.

Do not retain query text, symbol names, paths, prompts, or credentials. Runtime query
telemetry belongs to the existing bounded local analytics mechanism, not `build_stats`,
which describes facts fixed at generation build time. `CODE_INDEX_ANALYTICS=false`
disables these writes with the rest of analytics.

## Empirical evidence retained by this redesign

TypeScript 6.0.3 declaration-emission probes established:

| Source construct | Emitted behavior | Policy consequence |
|---|---|---|
| Exported value inferred as non-exported class | supporting `declare class` emitted | named support declaration is reachable; depth-zero value members are projected |
| Exported anonymous object/factory return | shape inlined | structural surface projection required |
| Internal name exported under alias | local declaration plus export clause | exposure belongs to bindings |
| Anonymous default function | direct default declaration | synthetic/default site support |
| Default arrow expression | generated `_default` declaration plus export | stored `default` root and return projection |
| Anonymous class expression | constructor shape plus static members | `construct` segment required |
| Async anonymous return | `Promise<anonymous shape>` | `awaited` segment required |
| Array of anonymous shape | anonymous element type | `element` segment required |
| Internal base of exported class | supporting base declaration emitted | inherited projected address plus reachable lexical base |
| `export *` | remains unexpanded in emitted text | fresh checker export-table expansion required |
| External namespace/default alias | alias remains in emitted surface | authored alias symbols required |
| CommonJS whole-module assignment | emitted as `export =` | compiler export table must determine binding name |

Declaration-map probes established:

- named/annotated members generally map to source;
- inferred anonymous members generally have no individual source mapping;
- private and `#private` placeholders are compatibility artifacts, not published names.

A TypeScript 6.0.3 compiler probe established that a named recursive type alias can
have `ObjectFlags.Anonymous` while retaining `aliasSymbol`; compiler flags alone cannot
define anonymous-shape expansion.

Oracle Phase 8 evidence rejected ANTLR as the production parser because it failed the
required precision and dependency-recall gates. The structural parser remains the
production basis.

### Evidence reproduction

The declaration-emission probes used this base command against temporary fixtures and a
local stub dependency:

```text
tsc --declaration --emitDeclarationOnly --target ES2022 --module ES2022 \
  --moduleResolution bundler --skipLibCheck --outDir <temporary-output> <fixtures>
```

The declaration-map probe added `--declarationMap` and decoded maps with
`source-map@0.7.4`. The JavaScript/CommonJS probe added `--allowJs`. The original four
emit fixtures produced identical output under TypeScript 6.0.3 and 7.0.2; the later
projection-premise and recursive-alias probes used the repository compiler, 6.0.3.

The recursive-alias probe resolved a named recursive alias whose object type had
`ObjectFlags.Anonymous = true` and `aliasSymbol` equal to the alias. This is the direct
evidence for the alias-aware anonymous-shape predicate. Exact Oracle parser commands,
corpora, results, and rejected-runtime evidence remain in
`benchmark/oracle-phase8/README.md`.

## Verification status

The following claims remain provisional until their named gate or prototype passes:

- G-A/G-A2 truth construction on the complete TypeScript corpus;
- emitted support-declaration retention as a complete reachability oracle;
- unique source association for emitted inferred-anonymous truth addresses;
- union/intersection projection semantics;
- compiler export-table names for CommonJS `export =` forms;
- `LanguageService.findReferences` behavior through every supported barrel form;
- private, protected, and `#` member treatment across all supported TypeScript forms;
- Oracle call-spec and RETURN-only cursor behavior on the current database release;
- PL/Scope signature equality between packaged spec declarations and body definitions;
- `ALL_PROCEDURES` treatment of package-body-only routines;
- combined Definition + ForwardDefinition interoperability with SCIP consumers.

SQLite FK behavior, deterministic hash encoding, canonical JSON serialization, and
cursor scoping are implementation claims. Verify them with focused automated tests
rather than leaving them as documentary assumptions.

## Implementation sequence

### Phase 0: accept the contract

Complete on 2026-10-20:

- this document is approved as the sole publication-policy source;
- the scoped projection and three-valued exposure are accepted;
- canonical binding-key encoding is accepted;
- remaining Open items are assigned in "Open decisions and measurements";
- versioned policy documents are removed.

### Phase 1: introduce the fact seam

- Create the serializable extracted fact bundle.
- Add the deep core finalization module.
- Keep existing persistence and tool responses unchanged.
- Run new classification in report-only mode inside the build worker.

Complete when both adapters can produce bounded in-memory facts without compiler/parser
objects crossing the seam.

### Phase 2: dry run and prototypes

Remain on schema version 8 throughout this phase; do not persist redesigned facts.

- Run G-A/G-A2 prototype P-1.
- Run compiler export-table prototype P-2 for external aliases and CommonJS.
- Measure nested functions, merged kinds, union/intersection cases, sites/bindings per
  symbol, projection paths, reachability steps, runtime, and memory.
- Run measured invariants and classify every violation.
- Establish externally configured ceilings with headroom.

Complete when every measured violation and schema-shaping case has an explicit rule.

The report-only run must emit this complete measurement set before DDL work:

| ID | Required measurement |
|---|---|
| M1 | Named nested TypeScript functions: count, total lines, and p95 extent lines |
| M2 | JavaScript and CommonJS files in indexed roots |
| M4 | Definition-site count and bindings-per-symbol distribution |
| M6 | Surface addresses per root, reachability-closure steps per root, runtime, and peak memory |
| M7 | Oracle cursor pairs, call specs, polymorphic table functions, routine pairs, ambiguity rate, overload groups, body forwards, and body-less spec classification |
| M11 | Maximum reachability steps per root and proposed ceiling/headroom |
| M12 | Surface bindings per root and symbol, maximums, proposed ceiling/headroom, and share by `anonymous`, `inherited`, and `depth1` |
| M13 | Union/intersection projection cases and selected semantics |
| M14 | Merged TypeScript symbols by declaration-kind set and effect of fixed kind precedence |
| R1 | Persistence × exposure × kind counts, occurrence role/usage/owner counts, and source lines represented |
| R2 | S3, O2, L1, and F1 violation instances grouped into complete, named classes |

The report also records P-1/P-2 outcomes and the fixed query-telemetry counters. It
contains aggregate values only: no source text, query text, symbol names, credentials,
or absolute paths.

Phase 2 evidence was collected on 2026-10-20 with `publication-report`; aggregate
reports are committed under `benchmark/publication-phase2/`.

| Corpus | Files | Symbols | Occurrences | Published | M1 nested functions | M4 definition sites | M13 union / intersection |
|---|---:|---:|---:|---:|---:|---:|---:|
| TypeScript compiler | 77 | 33,134 | 260,291 | 8,630 | 5,988 | 33,620 | 7,060 / 224 |
| VS Code | 4,935 | 293,866 | 1,864,302 | 110,128 | 1,160 | 295,962 | 28,589 / 659 |
| Material UI | 1,063 | 17,463 | 68,543 | 3,130 | 47 | 17,467 | 447 / 94 |

P-1 emitted declaration files and maps for every authored file without emit errors. The
current independent comparison passes G-A on the TypeScript compiler and VS Code corpora
(6,010 and 19,254 roots) and remains partial on Material UI (28 missing and 74 extra
roots). G-A2 passes on the TypeScript compiler corpus (9,191 truth and 9,191 visible
declarations), with 443/16 mismatches on VS Code and 2,176/374 on Material UI. G-A2 is
therefore not yet normative for every corpus. P-2 found 1,329 named, 1 namespace, and
146 default external aliases, 150 external stars, and 1,136 missing alias bindings in
Material UI; the other two corpora emitted no external alias forms. CommonJS `export =`
resolution passed on the repository fixture; K3 is resolved as deferred, so no CommonJS
publication root is emitted. Aggregate G-A/G-A2 evidence is committed under
`benchmark/publication-phase6/`.

Measured invariant results were zero S3/O2/L1/F1 violations on all three TypeScript
corpora and on the repository corpus. The Oracle fixture initially exposed two
`parameter_type_reference_owner` O2 cases. Phase 5 removed parameter declarations from
stored ownership, and the Oracle publication fixture now reports zero O2 cases. S3, O2,
L1, and F1 are enforced for production builds.

Surface projection and reachability closure were measured with the independent P-3
compiler-type probe. All 6,010 TypeScript compiler roots, 19,254 VS Code roots, and 4,091
Material UI roots completed within the probe budget, with no depth-limited roots. The
observed maxima and accepted 2,000/50,000 ceilings are recorded under "Projection
ceilings". DDL approval is the only remaining evidence-checkpoint item. Aggregate P-3
reports are committed under `benchmark/publication-phase2/`; the M8 read-only probe is
recorded in `benchmark/publication-phase2/oracle-live-evidence.json`.

To resolve invariant classes, a separate local diagnostic artifact may contain
workspace-relative paths, offsets, opaque symbol/binding IDs, and category names. It
must contain no source text, query text, credentials, or absolute paths; it is neither
persisted in the index nor sent to analytics. Commit only scrubbed aggregate evidence.

### Phase 3: schema and persistence

- Bump `SCHEMA_VERSION`.
- Bump each adapter version when its emitted facts change.
- Add normalized tables, columns, FKs, and indexes.
- Persist complete fact sets through one storage operation.
- Validate while the generation is `building`.
- Preserve existing atomic publication and failure behavior.

Complete when temporary-database tests prove FK integrity, deterministic IDs,
collision failure, failed-candidate isolation, and same-generation status counts.

### Phase 4: TypeScript vertical slice

- Implement bindings, aliases, external projections, default roots, surface projection,
  reachability, declaration kinds, ownership, and usage.
- Implement every query/list mode against the new schema.
- Pass G-A, G-A2, G-B, G-C, G-D, and G-F.

Complete when ESM TypeScript and ESM JavaScript pass qualification with bounded tool
responses.

### Phase 5: Oracle vertical slice

- Record declaration forms.
- Implement exact heading-gated routine/cursor pairing.
- Handle private body forwards with full-definition identity and primary selection.
- Emit bindings, sites, kinds, usage, and owners.
- Pass G-B through G-F and the Oracle corpus gates.

Complete when package/spec/body and standalone navigation preserve current precision
while exposing publication classification.

### Phase 6: defaults and evaluation

Implemented on 2026-10-20, except the model-facing A/B run:

- `find_symbol` defaults to `visible`.
- Exact-name presence telemetry is recorded in local analytics.
- CommonJS publication is deferred by K3.
- S3, O2, L1, and F1 are enforced for production builds.
- Q2 thresholds are accepted; the real-task A/B awaits the private harness.

Complete when model-facing task metrics meet the accepted success and false-absence
thresholds. Those metrics remain blocked, so Phase 6 is not complete.

### Required automated tests

- Pure finalizer tests: canonical JSON, UTF-8 ID framing, deterministic ordering,
  primary/anchor selection, exposure derivation, duplicate rejection, and synthetic
  collision failure.
- Adapter fixture tests: aliases/defaults/stars, recursive aliases, equal-depth paths,
  named-type terminals, inherited/external members, overloads/merges, Oracle
  spec/body/forward forms, and occurrence usage/ownership.
- Temporary-SQLite tests: every FK, index-backed lookup, complete insertion order,
  persisted validation, schema-version rebuild, and failed-candidate isolation. Never
  point tests at a real checkout database.
- Query tests: context-sensitive ranking, deduplication before pagination, generation-
  bound cursors, interval ambiguity, every list mode, stale-source rejection, and both
  line/byte truncation paths.
- MCP protocol tests: schemas and structured envelopes through `InMemoryTransport`,
  with no expected diagnostic noise on stdout or stderr.
- Corpus qualification: P-1/P-2 and G-A through G-F remain separate from fast unit and
  integration tests.

## Open decisions and measurements

| ID | Item | Disposition |
|---|---|---|
| K3 | CommonJS `export =` binding name and support acceptance after P-2 | Resolved: deferred; no CommonJS publication roots |
| M1 | Store named nested TypeScript functions after measuring count and size | Resolved: store them; Phase 2 evidence recorded |
| M5 | Default `find_symbol` exposure: `published` or `visible` | Resolved: `visible`; Phase 6 exact-name evidence recorded |
| M8 | Oracle synonym/current-schema source and unquoted-name case folding | Resolved: source-only names, no synonym expansion, canonical uppercase for unquoted names |
| M9 | `find_references` grouping and pagination semantics | Resolved: flat occurrences with keyset pagination |
| M10 | Deferred Oracle/ORDS scope and cross-language edges | Deferred scope |
| M11/M12 | Final per-root reachability-step and surface-address ceilings | Resolved: 50,000 steps and 2,000 addresses per root |
| M13 | Union/intersection constituent behavior in address projection | Resolved: constituent-only declarations are reachable, not projected |
| M14 | Fixed declaration-kind precedence for merged TypeScript symbol identity | Resolved: no fixed precedence; keep the identity anchor kind |
| Q1 | PL/Scope signature equality for packaged spec/body routines | Oracle qualification |
| Q2 | Real-task success, false-absence, token, and tool-call acceptance thresholds | Resolved: thresholds accepted; A/B blocked on private harness |

No DDL work begins until every item marked "Resolve before DDL" has a recorded
measurement or decision.

## Rejected alternatives

| Alternative | Reason rejected |
|---|---|
| Persist published symbols only | destroys internal callers, reference ownership, dependency chains, and implementation navigation |
| Put visibility on `symbol` | one symbol can have internal and published aliases |
| Three exclusive symbol tiers | conflates persistence with name exposure |
| Persist parameters and locals | search-noise cost exceeds navigation value; ownership uses nearest stored declaration |
| Separate `symbol_location` table | definition occurrences already carry the required typed locations |
| One symbol per spec/body or merged declaration | fragments references and loses canonical identity |
| Semantic `identity_key` migration | unnecessary while deterministic location identity remains accepted |
| Materialize dependency declarations | violates authored-root scope and greatly increases noise/storage |
| Persist every possible deep consumer path | recursive/named type graphs create disproportionate storage; reachable lexical bindings preserve discovery |
| Use display text as binding identity | separator and formatting changes can collide or churn IDs |
| Autoincrement external IDs | stale IDs can silently select different rows after rebuild |
| Fail on aliases/default/star exports | regresses supported language semantics |
| Synthetic symbol for external `export *` | dependency evidence and an explicit limitation are simpler and more accurate |
| One database transaction for the whole build | existing generation states already provide isolation without a long writer transaction |
| In-place schema migration | repository policy rebuilds derived indexes on schema-version change |
| PL/Scope-backed production indexing | unavailable for wrapped/offline source and violates source-based adapter design |
| ANTLR Oracle production parser | Phase 8 precision and dependency-recall gates failed |

## Versioned document removal

Completed on 2026-10-20:

1. All Open items required for the first implementation phase are assigned.
2. No documentation references to `codeindex-publication-policy-v` remain outside this
   contract's supersession note.
3. Every `codeindex-publication-policy-v*.md` file, including history companions, is
   deleted.
4. Architecture documentation points to this file.
5. Repository verification passes.

## Sources

1. [Oracle PL/SQL package declaration (10g)](https://docs.oracle.com/cd/B19306_01/appdev.102/b14261/package_declaration.htm)
2. [Oracle Using PL/SQL Packages (11g)](https://docs.oracle.com/cd/B28359_01/appdev.111/b28370/packages.htm)
3. [Oracle PLSCOPE_SETTINGS (12.2)](https://docs.oracle.com/database/122/REFRN/PLSCOPE_SETTINGS.htm)
4. [Oracle Using PL/Scope (11.2)](https://docs.oracle.com/cd/E24693_01/appdev.11203/e17125/adfns_plscope.htm)
5. [Oracle Using PL/Scope (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/adfns/plscope.html)
6. [Oracle Magazine: Zoom In on Your Code](https://asktom.oracle.com/Misc/oramag/zoom-in-on-your-code.html)
7. [ALL_ARGUMENTS (26)](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_ARGUMENTS.html)
8. [ALL_ARGUMENTS (12.2)](https://docs.oracle.com/database/122/REFRN/ALL_ARGUMENTS.htm)
9. [ALL_PROCEDURES (12.2)](https://docs.oracle.com/database/122/REFRN/ALL_PROCEDURES.htm)
10. [SQLite Foreign Key Support](https://www.sqlite.org/foreignkeys.html)
11. [SCIP protocol](https://github.com/scip-code/scip/blob/main/scip.proto)
12. [TypeScript `declaration`](https://www.typescriptlang.org/tsconfig/declaration.html)
13. [TypeScript `moduleDetection`](https://www.typescriptlang.org/tsconfig/moduleDetection.html)
14. [TypeScript Handbook: Modules](https://www.typescriptlang.org/docs/handbook/2/modules.html)
15. [TypeScript Handbook: Declaration Merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html)
16. [ECMA-262 Scripts and Modules](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html)
17. [Oracle CREATE PACKAGE statement (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/CREATE-PACKAGE-statement.html)
18. [Oracle CREATE PACKAGE BODY statement (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/CREATE-PACKAGE-BODY-statement.html)
19. [Oracle Explicit Cursor Declaration and Definition (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/explicit-cursor-declaration-and-definition.html)
20. [OpenCode tools](https://opencode.ai/docs/tools/)
21. [Node.js crypto `createHash`](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options)
