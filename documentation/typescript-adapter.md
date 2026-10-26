# TypeScript and JavaScript Adapter

**Status:** shipped; production hardening remains open

## 1. Purpose and scope

The TypeScript/JavaScript adapter is the first implementation of the generic
extractor contract. It owns the TypeScript compiler API and emits only
serializable, language-neutral files, symbols, occurrences, dependency facts, and
diagnostics to the core.

The current registry contains only this adapter. One configuration may select one
or more `tsconfig.json` or `jsconfig.json` project contexts in the same workspace.
Each context keeps its own compiler options and configuration digest. The adapter
publishes authored:

- `.ts`, `.tsx`, `.mts`, and `.cts` files;
- `.js`, `.jsx`, `.mjs`, and `.cjs` files when `allowJs` is enabled.

Declaration files and generated output may participate in compiler resolution but
are not published as authored source. Files must be reachable from a configured
project or retained as known imported files from the published generation.

## 2. Adapter boundary

Implementation entry: [`src/adapters/typescript/index.ts`](../src/adapters/typescript/index.ts).

The adapter implements `ExtractorType` with:

- stable adapter identity and version;
- source extensions and ignored directory segments;
- deterministic scanning and configuration discovery;
- compiler-backed extraction;
- current limitations for `index_status`;
- source-file eligibility for watching and publication.

The core owns generations, storage, leases, freshness, publication, pagination,
response bounds, and MCP transport. TypeScript `Program`, `TypeChecker`, AST,
language service, and module-resolution cache objects never leave the adapter.

## 3. Project scanning and context

The scanner uses TypeScript APIs to read and expand every configured project
file. It collects each effective `extends` chain for watching and includes:

- adapter identity/version;
- extractor TypeScript version;
- nearest declared compiler version, including package aliases;
- project-file bytes;
- effective compiler options;
- source file digests;
- adapter exclusion rules.

These inputs form one configuration fingerprint per context plus a combined
source fingerprint over the union of authored files. A matching published
generation may be reused. A major-version difference between the declared compiler
and extractor compiler is reported as drift; it is not silently ignored.

Scanning reads and hashes source but does not execute or type-check application
code. Fatal project-configuration diagnostics in any required context stop the
candidate build. Semantic diagnostics are optional because collecting all of them
can materially increase build cost.

The build loads one TypeScript program per context. Declarations use
context-independent source identity (workspace, path, range, kind, name); each
declaration records the contexts that produced it. Occurrences retain the context
that resolved them. Facts are never merged across incompatible programs merely
because paths match. A shared file therefore appears once as source with
context-specific compiler facts.

## 4. Files, symbols, and occurrences

The compiler-backed extractor emits:

- authored files with raw content digests and line counts;
- declarations with kind, simple/qualified name, exact range, and stable project
  identity;
- definition and reference occurrences;
- the enclosing authored declaration for each occurrence where available;
- bounded compiler/extraction diagnostics.

Canonical declarations, aliases, declaration merging, barrels, re-exports, JSX,
inheritance, and type/value positions are covered by the reference gate. An
authored re-export remains navigable when its canonical declaration is external and
therefore not publishable.

Current symbol identity is project/path/range based. Moving or structurally
rewriting a declaration can change its identifier. Cross-generation semantic
symbol identity is deferred.

### 4.1 Persistence and exposure

Stored navigable candidates are named module- and script-scope declarations,
members of stored declarations, authored members reached by surface projection,
synthetic authored alias symbols for supported external exports, and synthetic
`default` symbols. Parameters, type parameters, loop iterators, anonymous
callbacks, ordinary local variables, and declarations sourced only outside
authored roots are never stored. Named nested functions are stored because they are
named callers; top-level candidates are stored regardless of exposure.

Authored roots exclude declaration files, generated output, `node_modules`,
TypeScript library declarations, and declarations from other packages. ESM
JavaScript follows the TypeScript path when `allowJs` is enabled.

Anonymous object literals, anonymous class expressions, and anonymous callbacks
are transparent for lexical ownership. A stored member reached through transparent
or ephemeral syntax keeps the nearest stored lexical declaration as
`enclosing_id`; projection never rewrites lexical ownership.

Default exports are classified as follows:

- anonymous default function/class: one symbol named `default`, a default site on
  the clause, and the declaration extent;
- `export default x` for an internal symbol: a default binding and site on `x`; no
  second symbol;
- every other default expression: one synthetic variable symbol named `default`
  with a default site and a projection root.

For anonymous or synthetic defaults the name range is the `default` token and the
extent is the complete export-default declaration or assignment. A synthetic
external alias uses the authored export specifier as its extent and the exported
name token as its name range and declared site.

### 4.2 Surface projection and reachability

A publication root is a published binding in one context, not merely a declaration.
Roots include exported declarations and aliases, internal re-export bindings,
script globals, authored global/module augmentation contributions, and synthetic
default bindings. An internal helper called by an exported declaration is not a
root. Multiple published aliases of one symbol are distinct roots.

The persisted projection contains exactly:

1. each published root binding;
2. members lexically contained by a published class, interface, enum, type, or
   namespace;
3. members of anonymous shapes at any depth below a root;
4. inherited authored members under each published derived type;
5. depth-zero members of the declared or inferred type of a published value root.

At depth zero, value-root members are enumerated even when the type is named. Below
depth zero only anonymous shapes expand; entering a named type terminates address
projection and makes its authored declarations reachable instead. Projection
follows compiler-resolved types, retains every distinct canonical path including
equal-depth paths, and never materializes parameters or locals.

Address edges are properties, methods, accessors, call signatures and their
parameters and returns, construct signatures and instance types, awaited payloads,
array/tuple elements, and inherited authored members. Type arguments of other
generic types are reachability edges, not projected addresses. Private and
ECMAScript `#` members are never projected; protected members remain part of the
type surface.

A type is expandable as an anonymous shape only when it has no authored named
class, interface, type-alias, enum, or namespace identity and no `aliasSymbol`
denoting one; `ts.ObjectFlags.Anonymous` alone is insufficient. Output traversal
uses path-local cycle detection so distinct equal-depth paths survive. A cycle
without a named terminal fails the candidate. Union and intersection
constituent-only declarations are reachable, not projected.

Reachability is a separate idempotent closure over every projection edge, named
type, base type and heritage clause, union/intersection constituent, generic type
argument, enum member and namespace export, `typeof` target, and index signature or
constraint. For each context, an importable binding is published when its address is
writable, a surface binding is published when its root is, a non-writable lexical
binding is reachable when marked by the closure, and the rest are internal.

Address count and reachability steps are bounded per root. Overrun fails the
candidate; incomplete facts are never published. The accepted ceilings are 2,000
surface addresses and 50,000 reachability steps per root, derived from measured
maxima with headroom; qualification runs may override them. Changing either is an
extractor change: bump the adapter version, which participates in the project
configuration identity, and rebuild. Projection also uses a 64-level depth guard,
and a depth-limited root makes the measurement partial.

### 4.3 External declarations and CommonJS

External declarations are never materialized as symbols, bindings, or occurrences.
Named external re-exports, `export {importedExternal}`, `export * as ns from 'ext'`,
and `export default importedExternal` each produce one authored, published alias
symbol. A bare `export * from 'ext'` produces only a dependency fact and a status
counter. Internal `export *` expands one wildcard binding per resolved exported
name using compiler conflict resolution. Authored augmentations store only their
authored declarations and members.

`external_target` stores the module specifier and `external_name` the imported name
(`*` for namespaces, `default` for default imports). References to external terminals
are dropped and counted. External-terminal filtering uses the terminal
declaration's file, so an authored property whose value type is external remains a
searchable authored declaration.

CommonJS `export =` publication is deferred. There is no defensible single binding
name across its identifier and expression forms, and `getExportsOfModule` exposes
no consumer-facing name for it. CommonJS files remain indexed with non-publication
semantics.

### 4.4 Publication qualification

TypeScript exposure gates run independently per project context:

- **G-A (published addresses):** emit declarations with the pinned compiler into a
  fresh temporary output, load them into an independent program, normalize module
  identity back to workspace-relative source paths, expand internal `export *`
  through the checker export table, independently compute the scoped projection,
  drop external terminals, ignore compatibility placeholders, and compare the
  multiset of canonical binding keys. Zero missing, zero extra, and equal
  multiplicities are required. Production classification must walk compiler types
  directly and must not invoke declaration emit.
- **G-A2 (reachability):** build source-associated truth from declaration maps plus
  independent resolution of inferred addresses, require unique association, and
  compare binding exposure. Missing or ambiguous mapping blocks the gate rather
  than weakening it.
- **G-B (cross-file exposure):** every indexed cross-file reference target must be
  published or reachable in its context. Only genuinely dynamic constructs are
  exceptions; each has a fixed name and aggregate count.
- **G-C (usage):** compiler-resolved fixtures for call, read, write, and type
  positions.
- **G-D (references):** 100% precision against the language truth source and recall
  over all visible symbols, including barrels and projected members.
- **G-F (structural):** every enforced invariant in
  [Architecture §7.4](./architecture.md#74-fact-finalization-and-validation)
  passes before publication.

Gate evidence is retained under `benchmark/publication-phase2/` and
`benchmark/publication-phase6/`.

### 4.5 Context-dependent classification

A source file can be a script in one project context and a module in another, so
the same location-derived symbol may have different binding keys and exposure per
context. Classification, projection, and ceilings are computed independently for
every context; facts are never merged across incompatible programs.

## 5. Dependency extraction

The adapter emits dependency edges and binding details for:

- static imports and side-effect imports;
- `import type` and other type-only positions;
- named, default, and namespace bindings;
- re-exports and `export *`;
- literal dynamic imports;
- literal CommonJS `require('specifier')` calls, including local variable and destructured bindings;
- `import x = require(...)`.

Module resolution runs with the effective project options. A specifier resolving
to authored source becomes an internal edge. TypeScript path aliases remain
authored edges and are not misreported as external packages. Other specifiers are
normalized to package identity.

Non-literal dynamic imports and non-literal `require()` calls are not indexed. Dependency
facts establish module relationships; they do not prove runtime loading or use of a
particular binding.

## 6. Query semantics

The adapter supplies facts used by:

| Tool | Adapter meaning |
| --- | --- |
| `outline` | Authored declarations in source order |
| `find_symbol` | Exact qualified, exact simple, then bounded prefix lookup |
| `find_references` | Definition/reference occurrences for one symbol ID or one resolved name query |
| `find_dependencies` | Direct target usage or authored-module dependency impact |
| `read_symbol` | Bounded source after current-file digest verification |

Direct dependency usage is the default. Dependency impact traverses authored imports,
is cycle-safe, keeps every direct root that begins a shortest path, and may return
one module under multiple roots. Top-level unique totals are therefore not the sum
of per-root totals.

Compact dependency items contain path, depth, and direct root. Evidence detail
adds locations, raw targets, edge kind, bindings, and equivalent-edge count.
For TypeScript, `target` is the normalized npm package name; authored module
targets are traversed through `targetPath`. `root` filters impact to one direct
target consumer. `context` restricts direct usage and impact traversal to one
project context; without it, results are the union across contexts. Cursors bind
generation, target, context, mode, root, detail level, and position.

Impact currently proves module reachability, not binding use through a façade.

## 7. Freshness and rebuild behavior

The watcher observes adapter source extensions, effective configuration files, and
directories containing known authored imports. Events are hints; deterministic
scanning is authoritative.

The current adapter performs full-program extraction and does not implement
fact-reuse proof, so every TypeScript refresh re-extracts. The core still applies
its per-path fact delta: unchanged paths are not rewritten, and the published
generation identifier is stable with a monotonic revision. There is no long-lived
incremental TypeScript builder program. A changed path is marked dirty immediately,
and `read_symbol` rejects it until matching content is published.

Incremental compiler state for this adapter is permitted only if measurements show
that full-program extraction misses the edit-to-fresh or resource gates. Any
incremental implementation must still publish an internally consistent revision.

## 8. Validation commands

```bash
pnpm verify
pnpm build
pnpm qualify:typescript
codeindex-cli benchmark --config ./codeindex.config.json
codeindex-cli benchmark --profile large --scenarios cold,warm,rebuild,deep
codeindex-cli benchmark --profile medium --scenarios cold,edit --edit-rounds 5
```

`qualify --extractor typescript` compares indexed occurrences with the
TypeScript language service using exact byte ranges, definition/reference roles,
and resolved symbol identity. It samples 200 symbols deterministically from the configured project and
enforces the production gate:

- at least 200 sampled symbols;
- at least three sampled, referenced symbols for every required construct;
- at least 99.5% recall using unrounded values;
- exactly 100% precision;
- no unlocated declarations, skipped samples, or unclassified mismatches.

A sample is only informative when the project exercises the required constructs:
direct references, named/default/namespace imports, named re-exports, barrels, path
aliases, JSX components, inheritance, overrides, declaration merging, type-only and
mixed type/value references, destructuring, shorthand properties, and JavaScript
with `allowJs`. The adapter's qualification corpus lives in
`test/fixtures/reference-corpus/`; its expected tags and pinned representatives are
recorded in `test/helpers/referenceCorpus.ts`.

Running the command against a project that does not supply all constructs fails the
coverage part of the gate even when recall and precision are perfect. That is
intentional: the command qualifies the adapter, not the health of an arbitrary
consumer index. Run it against the qualification corpus with:

```bash
pnpm qualify:typescript:fixture
```

Benchmark storage execution, core calls, MCP transport, client wrapping, and full
agent tasks separately. See [Maintainer guide](./maintainer-guide.md).

## 9. Production-pilot migration ledger

This ledger replaces the stale progress table in the original production-pilot
plan. Status meanings:

- **implemented:** code and automated tests exist in this repository;
- **partial:** useful implementation exists but one or more stated gates lack
  implementation or retained evidence;
- **superseded:** the standalone/public split changed the original deliverable;
- **open:** no sufficient implementation or evidence exists.

| Package | Status | Current implementation or remaining work |
| --- | --- | --- |
| WP0 — baselines and pilot gates | Implemented | Build stages, local analytics, offline reports, the version-2 model-free benchmark, deterministic large-project profiles, a versioned baseline, explicit gates, an evaluation sidecar, Markdown summaries, the final reference corpus, declarative suites for generated and pinned public-project benchmark runs, and retained reference-machine measurements exist. The retained record is [Reference-workstation baseline](./reference-baseline.md). |
| WP1 — native OpenCode exposure | Partial | MCP installation and current Code Mode behavior are documented and protocol-tested. Direct native MCP and Code Mode were compared with the same artifact, model, cases, tools, client, and tariff; Code Mode cost `1.307` direct with upper `1.473`, so direct MCP remains recommended; see [Exposure evidence](../evaluation/audits/exposure-eval-050.md). A formal normal-session smoke remains open. |
| WP2 — continuous freshness | Implemented | Coordinator, recursive watcher, 500 ms debounce, 60 s reconciliation, one follow-up build, query freshness, dirty-source rejection, and shutdown ownership are implemented and tested. |
| WP3 — persistence and writer coordination | Implemented | Persistent working-copy UUID, immutable content, extraction artifacts, renewable build lease, schema backup/recreation, bounded generation cleanup, and checkout move/copy/delete semantics exist. Multi-process contention, owner termination, reader isolation, and expired-lease takeover are evidenced by `test/leaseContention.test.ts`; move, copy, and delete are stated and verified in [Checkout move, copy, and delete semantics](./checkout-lifecycle.md). |
| WP4 — compiler/reference alignment | Implemented | Declared compiler identity, drift, TypeScript API extraction, and the ≥200-symbol, ≥99.5%-recall, 100%-precision gate with construct stratification and a checked-in corpus exist. |
| WP5 — edit-to-fresh and resources | Partial | Cached status, version-2 benchmark, build-stage timings, RSS/CPU/storage sampling, artifact-reuse reporting, deep-cursor plans, explicit gates, evaluation/report artifacts, analytics, worker builds, a resumable per-run evidence suite, the deterministic model-free E3 operational soak with declared-duration and idle-CPU gates, the paired direct/Code-Mode exposure comparison, and retained reference-machine measurements exist; multi-process contention, owner termination, reader isolation, and expired-lease takeover are evidenced by `test/leaseContention.test.ts`. Four-hour soak evidence remains incomplete. Incremental compiler state remains conditional. |
| WP6 — build separation | Superseded/partial | MCP, CLI, console server, and browser bundles are separate. The evaluation harness and public cases live under `evaluation/` and are not bundled; private corpora and restricted results remain outside this repository. |
| WP7 — OpenCode installation | Implemented | CLI install/uninstall, explicit MCP bundle/configuration paths, preservation of unrelated JSONC, external project configuration, and user documentation exist. A fresh consumer installed the released tag, started the CLI, MCP, and console, kept a second checkout on a separate database, opted out of analytics, and rolled back through configuration and cleanup; see [Fresh-consumer installation and rollback](./fresh-consumer-installation.md). |
| WP8 — interactive pilot | Superseded | The pilot was designed as a prospective gate before default enablement. The slice shipped in `v0.7.0` on 2026-10-24 and runs in a production consumer, so that decision no longer exists and a retrospective hosted campaign would not inform it. The model-free soak, startup-latency, and stream-integrity tooling remains available for ongoing operational assurance. |

Cross-cutting contracts and performance targets live in
[Maintainer guide](./maintainer-guide.md). Evaluation methodology lives in
[Evaluation harness](./evaluation-harness.md).

### 9.1 Remaining pilot TODOs by work package

- **WP0:** retain a new baseline when the reference machine, runtime, corpus, or
  artifact identity changes; the current record is
  [Reference-workstation baseline](./reference-baseline.md). The pinned public
  suite remains directional and VS Code is currently blocked by an unrepresentable
  empty-string member name.
- **WP1:** record a disposable normal OpenCode session invoking every tool without
  a bridge; the smoke needs no hosted-model call, so it can run against a local
  model or a deterministic client probe. The paired Code Mode and direct exposure
  comparison is retained in
  [Exposure evidence](../evaluation/audits/exposure-eval-050.md).
- **WP2:** no known feature TODO; retain regression coverage for add/change/delete,
  rename, configuration changes, events during builds, failure recovery, and
  shutdown on every supported platform.
- **WP3:** multi-process contention, owner termination, reader isolation, and
  expired-lease takeover are covered by `test/leaseContention.test.ts`; move, copy, and
  deletion semantics are covered by `test/checkoutLifecycle.test.ts` and
  [Checkout move, copy, and delete semantics](./checkout-lifecycle.md); prove later
  adapter contexts do not replace core identity concepts.
- **WP4:** no known feature TODO; keep the corpus representative when adding new
  syntax constructs and retain a focused fixture for every mismatch class.
- **WP5:** complete MCP call and idle CPU measurements and the four-hour
  edit/restart soak on the reference machine. `startup` now records the local MCP
  call p95 beside warm startup, and `soak` accepts `--duration-ms` and
  `--idle-sample-ms` with `soak.duration-completed` and `soak.idle-cpu` gates; the
  retained release-machine runs remain outstanding. Add incremental compiler
  state only if a measured gate fails.
- **WP6:** keep private evaluation orchestration outside the production bundle and
  verify that it launches the released `codeindex-mcp` artifact. Reintroducing a
  public evaluation bundle requires a separate scope decision.
- **WP7:** fresh-consumer installation, artifact startup, a second checkout on a
  separate database, analytics opt-out, and configuration-only rollback are
  retained in
  [Fresh-consumer installation and rollback](./fresh-consumer-installation.md).
  Both residual observations from that verification are resolved: `mcp
  install` no longer writes a `$schema` hint that uninstall would have to
  guess, and `clean` no longer scans the shared OpenCode temporary root or
  another workspace's database.
- **WP8:** superseded. The slice is released and deployed, so there is no pending
  enablement decision for a prospective pilot to inform, and no retrospective
  hosted campaign is planned. Operational assurance instead uses the model-free
  four-hour soak, the warm-startup and MCP call gates, and the complete
  event-stream contract; production monitoring of the shipped release is tracked
  in [#84](https://github.com/doberkofler/codeindex-mcp/issues/84).

## 10. Implemented dependency-query enhancements

The production pilot identified oversized and semantically unclear transitive
package results. The following enhancements are shipped:

1. compact defaults;
2. explicit direct usage versus dependency impact;
3. grouping and filtering by direct root;
4. unique top-level and per-root counts;
5. evidence as an opt-in detail level;
6. cursor binding to complete query semantics;
7. usage-first tool descriptions and server instructions;
8. byte-aware pagination and deterministic cycle-safe traversal.

Relevant implementation:

- [`extractDependencies.ts`](../src/adapters/typescript/extractDependencies.ts)
- [`dependencyQuery.ts`](../src/core/query/dependencyQuery.ts)
- [`queryService.ts`](../src/core/query/queryService.ts)
- [`toolSchemas.ts`](../src/transports/mcp/toolSchemas.ts)
- [`buildMcpServer.ts`](../src/transports/mcp/buildMcpServer.ts)

## 11. Enhancements and open work

Actionable work is tracked in GitHub issues labeled `enhancement`. This section
keeps only the reasoning and trigger conditions that must outlive an issue.
Resolved work is recorded in [Dependency decisions](./enhancements.md) or in the
issue itself.

### 11.1 Reference quality

Tracked in [#73](https://github.com/doberkofler/codeindex-mcp/issues/73).

Deterministic stratification remains a requirement for aliases, barrels, path
aliases, JSX, inheritance, declaration merging, and type/value usage. Every
mismatch becomes a fixture before extraction changes.

### 11.2 Binding-aware façade analysis

Not scheduled. Implementation requires a measured trigger: module reachability
must be shown insufficient for a real dependency-impact question, and compact
impact behavior must already be measured. No such failure exists today.

If the trigger fires, the contract is: trace binding identity through named
imports, aliases, named re-exports, and authored façade exports, distinguishing
“imports a façade module” from “uses the façade binding backed by this package.”
Namespace access, `export *`, computed exports, dynamic properties, and CommonJS
interoperability require explicit confidence or unknown states. Uncertain paths
remain module-impact evidence. Any implementation must use the existing TypeScript
program and checker and preserve 100% reviewed precision.

### 11.3 Information depth

Add facts only after observed follow-up calls justify them. No issue is created
until its trigger fires:

| Candidate | Trigger |
| --- | --- |
| Short display signature | Symbol lookup is repeatedly followed only to inspect the declaration signature |
| Export visibility | Public/private ambiguity causes incorrect navigation |
| Enclosing-symbol summary | Consumers repeatedly resolve opaque enclosing identifiers |
| Call/read/write/type/import roles | Impact work requires role-specific filtering |
| Source-oriented dependency query | Questions require dependencies of an authored source module |
| Non-literal dynamic import facts | Ranked unresolved sites show material retrieval loss |
| Fuzzy/full-text retrieval | Exact/prefix lookup plus bounded repository search shows measured recall loss |

### 11.4 Multiple TypeScript projects

Shipped: one generation may contain several TypeScript project contexts. Each
project retains its own effective compiler options and context digest. Shared
authored files use one declaration identity with multiple context associations;
occurrences retain per-context resolution. Facts from incompatible programs are
not merged merely because paths match.

Remaining work: per-context extraction-artifact reuse is currently keyed by the
combined configuration digest, so one changed project invalidates all per-file
artifacts. Artifacts are persisted but never consumed, so reuse buys nothing
today. Not scheduled: implement consumption and per-context keys only after a
measured rebuild or retention gate fails.

### 11.5 Performance and evaluation

- add a model-free edit-to-fresh benchmark; **done**
- retain machine-readable startup, build, query, CPU, memory, and storage results;
  **versioned baseline, gate evaluation, JSON artifacts, and reference-machine
  measurements are retained in [Reference-workstation baseline](./reference-baseline.md)**
- verify deep cursor query plans at production cardinalities; **done — production statements,
  plan captures at offset 0 and maximum depth, retained per-page latency, and the
  `find_symbol`/`outline` regression are recorded in
  [Query regression](./query-regression.md)**
- publish a Markdown summary while keeping JSON authoritative; **done**
- compare direct MCP and Code Mode wrapping; **done — the paired comparison on
  the EVAL-037 artifact under OpenCode 2.1.4 is recorded in
  [Exposure evidence](../evaluation/audits/exposure-eval-050.md)**
- complete two-process, lease takeover, and four-hour soak runs; **deterministic restart, unattended recovery, and retention evidence implemented by `soak`**;
- implement private controlled cases for direct dependency usage, grouped impact,
  binding-aware façades, and fallback behavior; façade cases wait on the §11.2
  trigger
- measure index-first adoption only from an approved complete client event stream;
  every attempt now carries a structural `streamComplete` proof, and a pilot
  trajectory is valid only when that proof holds. This contract is retained; it
  has no pending campaign behind it

Do not infer adoption from MCP analytics; MCP cannot observe repository search and
file-read tools.

## 12. Current limitations

- one built-in adapter in the current release;
- every configured TypeScript project is required for publication;
- full-generation compiler extraction;
- path/range-based symbol identity;
- definition/reference occurrence roles only;
- exact and prefix symbol lookup only;
- literal dynamic imports only;
- dependency impact is not binding-aware;
- no automatic import expansion, fuzzy search, full-text search, or embeddings;
- no TypeScript-to-Oracle/ORDS edges until those adapters and the graph model ship.

The [Roadmap](./roadmap.md) owns sequencing. This document owns the adapter's
behavior, validation, pilot status, and backlog.
