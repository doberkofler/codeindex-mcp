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

## 5. Dependency extraction

The adapter emits dependency edges and binding details for:

- static imports and side-effect imports;
- `import type` and other type-only positions;
- named, default, and namespace bindings;
- re-exports and `export *`;
- literal dynamic imports;
- `import x = require(...)`.

Module resolution runs with the effective project options. A specifier resolving
to authored source becomes an internal edge. TypeScript path aliases remain
authored edges and are not misreported as external packages. Other specifiers are
normalized to package identity.

Non-literal dynamic imports are not indexed. Dependency facts establish module
relationships; they do not prove runtime loading or use of a particular binding.

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

The current adapter performs full-program, full-generation extraction. Immutable
per-file artifacts may be reused, but there is no long-lived incremental TypeScript
builder program or affected-file delta publication. A changed path is marked dirty
immediately, and `read_symbol` rejects it until matching content is published.

Incremental compiler state is permitted only if measurements show that the current
full-generation approach misses the edit-to-fresh or resource gates. Any
incremental implementation must still publish an internally complete immutable
generation.

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
| WP0 — baselines and pilot gates | Partial | Build stages, local analytics, offline reports, the version-2 model-free benchmark, deterministic large-project profiles, a versioned baseline, explicit gates, an evaluation sidecar, Markdown summaries, the final reference corpus, and declarative suites for generated and pinned public-project benchmark runs exist. Missing retained reference-machine measurements. |
| WP1 — native OpenCode exposure | Partial | MCP installation and current Code Mode behavior are documented and protocol-tested. Retained direct-versus-Code-Mode benchmark and formal normal-session smoke evidence remain open. |
| WP2 — continuous freshness | Implemented | Coordinator, recursive watcher, 500 ms debounce, 60 s reconciliation, one follow-up build, query freshness, dirty-source rejection, and shutdown ownership are implemented and tested. |
| WP3 — persistence and writer coordination | Partial | Persistent working-copy UUID, immutable content, extraction artifacts, renewable build lease, schema backup/recreation, and bounded generation cleanup exist. Process-level contention/termination evidence and explicit checkout move/copy/delete semantics remain incomplete. |
| WP4 — compiler/reference alignment | Implemented | Declared compiler identity, drift, TypeScript API extraction, and the ≥200-symbol, ≥99.5%-recall, 100%-precision gate with construct stratification and a checked-in corpus exist. |
| WP5 — edit-to-fresh and resources | Partial | Cached status, version-2 benchmark, build-stage timings, RSS/CPU/storage sampling, artifact-reuse reporting, deep-cursor plans, explicit gates, evaluation/report artifacts, analytics, worker builds, a resumable per-run evidence suite, and the deterministic model-free E3 operational soak exist. Retained reference-machine measurements, Code Mode comparison, contention evidence, and four-hour soak evidence remain incomplete. Incremental compiler state remains conditional. |
| WP6 — build separation | Superseded/partial | MCP, CLI, console server, and browser bundles are separate. The evaluation harness and public cases live under `evaluation/` and are not bundled; private corpora and restricted results remain outside this repository. |
| WP7 — OpenCode installation | Implemented | CLI install/uninstall, explicit MCP bundle/configuration paths, preservation of unrelated JSONC, external project configuration, and user documentation exist. |
| WP8 — interactive pilot | Open | No retained public evidence proves the required representative-session count, adoption denominator, all latency/resource gates, or soak completion. |

Cross-cutting contracts and performance targets live in
[Maintainer guide](./maintainer-guide.md). Evaluation methodology lives in
[Evaluation harness](./evaluation-harness.md).

### 9.1 Remaining pilot TODOs by work package

- **WP0:** retain machine-readable reference-workstation baselines for startup,
  cold/warm builds, edit-to-fresh, query layers, RSS, CPU, and storage using
  `benchmark-suite`; generated and pinned public-project execution is automated.
- **WP1:** record a disposable normal OpenCode session invoking every tool without
  a bridge; compare Code Mode and direct exposure with the same model and task;
  retain client version and effective configuration with the result.
- **WP2:** no known feature TODO; retain regression coverage for add/change/delete,
  rename, configuration changes, events during builds, failure recovery, and
  shutdown on every supported platform.
- **WP3:** add real multi-process contention, owner-termination, and expired-lease
  takeover tests; document and verify checkout move, copy, and deletion behavior;
  prove later adapter contexts do not replace core identity concepts.
- **WP4:** no known feature TODO; keep the corpus representative when adding new
  syntax constructs and retain a focused fixture for every mismatch class.
- **WP5:** complete event-to-publication, MCP, startup, idle CPU, peak memory,
  storage, deep-cursor, contention, restart, and four-hour soak measurements. Add
  incremental compiler state only if a measured gate fails.
- **WP6:** keep private evaluation orchestration outside the production bundle and
  verify that it launches the released `codeindex-mcp` artifact. Reintroducing a
  public evaluation bundle requires a separate scope decision.
- **WP7:** retain a fresh-consumer installation smoke test, separate-database check
  for another checkout, analytics opt-out check, and configuration-only rollback
  test.
- **WP8:** run at least 20 representative normal sessions; retain qualitative
  failures, freshness/resource results, and correctly measured index-first
  adoption; obtain explicit user acceptance before default enablement.

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

## 11. Open enhancement backlog

### 11.1 Reference quality

- raise the verifier to the production sample and thresholds;
- preserve deterministic stratification for aliases, barrels, path aliases, JSX,
  inheritance, declaration merging, and type/value usage;
- turn every mismatch into a fixture before changing extraction;
- retain 100% precision while improving recall.

### 11.2 Binding-aware façade analysis

Trace binding identity through named imports, aliases, named re-exports, and
authored façade exports. Distinguish “imports a façade module” from “uses the
façade binding backed by this package.” Namespace access, `export *`, computed
exports, dynamic properties, and CommonJS interoperability require explicit
confidence or unknown states. Uncertain paths remain module-impact evidence.

This enhancement starts only after compact impact behavior is measured. It must
use the existing TypeScript program/checker and preserve 100% reviewed precision.

### 11.3 Information depth

Add facts only after observed follow-up calls justify them:

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
artifacts.

### 11.5 Performance and evaluation

- add a model-free edit-to-fresh benchmark; **done**
- retain machine-readable startup, build, query, CPU, memory, and storage results; **versioned baseline, gate evaluation, and JSON artifacts implemented; reference-machine measurements still need retention**
- verify deep cursor query plans at production cardinalities; **sampling and plan gates implemented; production-cardinality reference runs still need retention**
- publish a Markdown summary while keeping JSON authoritative; **done**
- compare direct MCP and Code Mode wrapping;
- complete two-process, lease takeover, and four-hour soak runs; **deterministic restart, unattended recovery, and retention evidence implemented by `soak`**;
- implement private controlled cases for direct dependency usage, grouped impact,
  binding-aware façades, and fallback behavior;
- measure index-first adoption only from an approved complete client event stream.

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
