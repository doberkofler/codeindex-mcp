# Test Fixture Catalogue

Date: 2026-10-24

Status: accepted catalogue for the fixture cleanup sequence in
[Codebase testing strategy](./codebase-testing-strategy.md#5-test-data). This document
describes existing fixtures; the consuming-test lists follow the current MCP seam split.
The four TypeScript adapter contract fixtures were added with the adapter contract
tests and are catalogued here.

## 1. Scope and method

Scope is every tracked file under `test/fixtures/`:

```text
fixture directories                   21
tracked fixture files                222
```

The parent issue cites 205 files. The tracked tree contains 222: 204 at catalogue
acceptance plus 18 in the four TypeScript adapter contract fixtures added with their
tests. The earlier extra directory entry was the ignored macOS `.DS_Store` metadata
file at the fixture root, which is not a fixture and is not catalogued. Every remaining
file is attributed to exactly one directory entry.

Each entry records the claim the fixture supports, the constructs and failure classes
it isolates, the authority for its expected result, the expected result itself, the
consuming tests, the mutation policy, known limitations, and the update procedure.

Consuming-test names are the test modules that copy the directory with
`createFixtureConfig` or read it directly. Tests never execute the checked-in tree in
place: `test/helpers/fixture.ts` copies the directory to a temporary workspace, and all
test-side edits happen there.

## 2. Authority rules

An expected result must come from a source independent of the implementation under
test. This catalogue uses exactly one primary authority per entry:

| Authority | Meaning |
|---|---|
| Reviewed source manifest | The source files, their import/export/declaration statements, and a hand-checked expectation list are the ground truth. Expected facts are derived by reading the fixture, not by recording implementation output. |
| Language service | The TypeScript language service computes reference locations and export truth independently of the indexer. |
| Compiler output | The TypeScript compiler's project graph, module resolution, and export table are the ground truth for resolution and publication facts. |

Cross-implementation parity (for example structural Oracle parser versus ANTLR) is
corroboration, never the sole authority. No entry uses a snapshot produced by the
indexer, parser, or publication pipeline as its expected result.

## 3. Entry index

| Entry | Fixture directory | Primary claim | Consuming tests |
|---|---|---|---|
| F01 | `test/fixtures/simple-project/` | Baseline TypeScript workspace for scan, query, paging, reads, and configuration | `test/indexStatus.test.ts`, `test/benchmarkEvaluation.test.ts`, `test/cli.test.ts`, `test/buildWorkerClient.test.ts`, `test/scanWorkspace.test.ts`, `test/config.test.ts`, `test/publicationReport.test.ts`, `test/publishedFiles.test.ts`, `test/benchmarkResources.test.ts`, `test/codeIndex.test.ts`, `test/benchmark.test.ts`, `test/buildWorker.test.ts`, `test/referenceGrouping.test.ts`, `test/soak.test.ts`, `test/builtProcess.test.ts`, `test/oracleQualificationRun.test.ts`, `test/publicationFacts.test.ts` |
| F02 | `test/fixtures/dependency-graph/` | Direct and transitive package dependency edges, evidence, bindings, and cycles | `test/codeIndex.test.ts` |
| F03 | `test/fixtures/dependency-impact/` | Non-additive impact roots over a wide fan-out | `test/codeIndex.test.ts` |
| F04 | `test/fixtures/dependency-cases/` | Reviewed dependency edge matrix with a checked-in ground-truth README | `test/dependencyCases.test.ts` |
| F05 | `test/fixtures/reference-grouping/` | Reference selectors, grouping, ordering, and ambiguity | `test/referenceGrouping.test.ts` |
| F06 | `test/fixtures/reference-edges/` | Language-service differential for hard reference edges | `test/referenceVerification.test.ts` |
| F07 | `test/fixtures/reference-corpus/` | Production reference gate with full construct-tag coverage | `test/referenceVerification.test.ts` |
| F08 | `test/fixtures/publication-project/` | TypeScript publication surface and exposure projection | `test/typescriptPublicationSurface.test.ts`, `test/publicationDefaultsAndEnforcement.test.ts`, `test/publicationReport.test.ts` |
| F09 | `test/fixtures/commonjs-project/` | CommonJS `export =` and `module.exports` classification | `test/publicationReport.test.ts` |
| F10 | `test/fixtures/external-reexport/` | Authored façade re-export of an external package | `test/codeIndex.test.ts`, `test/publicationReport.test.ts` |
| F11 | `test/fixtures/javascript-project/` | ESM JavaScript indexing under `allowJs` | `test/extractors.test.ts`, `test/typescriptPublicationSurface.test.ts` |
| F12 | `test/fixtures/large-symbol/` | UTF-8-safe byte-bounded source reads | `test/mcpSmoke.test.ts` |
| F13 | `test/fixtures/multi-project/` | Three project contexts in one generation | `test/multiProject.test.ts`, `test/multiProjectConfig.test.ts`, `test/referenceGrouping.test.ts` |
| F14 | `test/fixtures/oracle-project/` | Oracle parsing, references, dependencies, freshness, and live-plan inputs | `test/oracle.test.ts`, `test/oracleAntlr.test.ts`, `test/oracleAntlrDeclarations.test.ts`, `test/oracleAntlrDependencies.test.ts`, `test/oracleAntlrReferences.test.ts`, `test/oracleParserBinding.test.ts`, `test/oracleLiveSource.test.ts`, `test/oracleLivePlan.test.ts`, `test/oracleLiveApply.test.ts`, `test/oracleLiveCommand.test.ts`, `test/oracleRecompile.test.ts`, `test/oracleQualificationRun.test.ts`, `test/publicationFacts.test.ts` |
| F15 | `test/fixtures/oracle-publication-project/` | Oracle publication forms, pairing, diagnostics, and usage bits | `test/oraclePublicationSurface.test.ts`, `test/publicationReport.test.ts` |
| F16 | `test/fixtures/oracle-qualification-golden/` | Golden facts for constructs PL/Scope cannot confirm | `test/oracleGoldenFacts.test.ts` |
| F17 | `test/fixtures/oracle-grammar-gaps/` | Known grammar gaps report a diagnostic instead of succeeding silently | `test/oracleGrammarGaps.test.ts` |
| F22 | `test/fixtures/oracle-qualification-corpus/` | Controlled Oracle O1 semantic corpus | `test/oracleQualificationContract.test.ts`, `test/liveOraclePreflight.test.ts` |

## 4. Entries

### F01 `test/fixtures/simple-project/`

| Field | Value |
|---|---|
| Claim | A small complete TypeScript workspace exercises scanning, path aliases, declaration kinds, qualified names, references, outline ordering, cursor paging, bounded source reads, freshness status, and configuration resolution. |
| Constructs | `NodeNext` ESM project; `baseUrl` and `paths` alias `@app/*`; value and type-only imports; `export type` and value re-exports; interface, type alias, enum, class with readonly field and methods; `declare const` declaration file; generated subtree; a file outside `include` imported through a relative path. |
| Failure classes | Alias resolution, declaration kind or qualified-name drift, reference direction, outline order, malformed cursor acceptance, source-read overrun, declaration/generated file exclusion, configuration path escape. |
| Authority | Reviewed source manifest. The scanner file list and the hand-written symbol, reference, and exclusion expectations come from reading the four authored sources. |
| Expected result | Scan yields exactly `src/index.ts`, `src/models.ts`, `src/summary.ts` with two excluded files. `formatUser` is one `variable` in `src/models.ts`; `UserService.find` is a `method` with the qualified name `module["src/models.ts"]::UserService.find`; the class-kind outline is `['UserService']`; `formatUser` has five occurrences with one definition and references in `src/index.ts` and `src/models.ts`; two-item pages continue with distinct ids and reject `not-a-cursor`. |
| Consuming tests | `test/indexStatus.test.ts`, `test/benchmarkEvaluation.test.ts`, `test/cli.test.ts`, `test/buildWorkerClient.test.ts`, `test/scanWorkspace.test.ts`, `test/config.test.ts`, `test/publicationReport.test.ts`, `test/publishedFiles.test.ts`, `test/benchmarkResources.test.ts`, `test/codeIndex.test.ts`, `test/benchmark.test.ts`, `test/buildWorker.test.ts`, `test/referenceGrouping.test.ts`, `test/soak.test.ts`, `test/oracleQualificationRun.test.ts`, `test/publicationFacts.test.ts`. |
| Mutation policy | Ground truth; no fixture change for a test-only reason. Keep the authored file set at four files, because `fileCount: 4`, the exclusion count of two, and the reference totals are pinned. A semantic change requires updating this entry and every consuming expectation in the same commit. |
| Known limitations | Single project and single package name. It does not exercise `extends`, configured `exclude`, CommonJS, JSX, or multi-project resolution; those live in other fixtures. The generated and declaration files are asserted only through the exclusion count. |
| Update procedure | Edit the source, derive the new expectations by hand, update this entry, then run `pnpm vitest run test/scanWorkspace.test.ts test/codeIndex.test.ts test/referenceGrouping.test.ts` and `pnpm verify`. Never regenerate expected facts from the index. |
| Files (7) | See the manifest below. |

```text
test/fixtures/simple-project/shared/contracts.ts
test/fixtures/simple-project/src/__generated__/ignored.ts
test/fixtures/simple-project/src/globals.d.ts
test/fixtures/simple-project/src/index.ts
test/fixtures/simple-project/src/models.ts
test/fixtures/simple-project/src/summary.ts
test/fixtures/simple-project/tsconfig.json
```

### F02 `test/fixtures/dependency-graph/`

| Field | Value |
|---|---|
| Claim | Package dependency extraction distinguishes direct package usage, authored imports, re-export chains, dynamic imports, subpath imports, scoped packages, compile-time-only bindings, and cycles, and never treats a TypeScript path alias as a package. |
| Constructs | `lodash` default and named imports, `lodash/escape.js` subpath, `@scope/pkg` default plus type-only named import, path-alias import `@app/adapters/escape`, `export {default as escape}`, dynamic `import()`, two-file cycle, and a twelve-symbol file for paging. |
| Failure classes | Wrong edge kind, package-identifier normalization, subpath collapsing, compile-time-only binding loss, path-alias false positive, cycle duplication, transitive depth error, byte-bound overflow. |
| Authority | Reviewed source manifest. The expected consumer lists, binding records, depths, and summaries are hand-derived from the import statements and declarations in `external.d.ts`. |
| Expected result | Direct `lodash` consumers are exactly `src/adapters/escape.ts`, `src/adapters/lodash_api.ts`, and `src/cycle/a.ts`; the impact view has eight entries with `four.ts` at depth three, `dynamic.ts` marked `dynamic-import`, and the cycle entry appearing once. Scoped usage returns only `src/adapters/scoped.ts` with a default `measure` binding and a compile-time-only `Shape` binding. `@app/adapters` returns no package consumers. |
| Consuming tests | `test/codeIndex.test.ts`. |
| Mutation policy | Ground truth; the exact consumer lists and summaries are pinned. Adding a package import to any file changes expected results, so any edit must update this entry and `test/codeIndex.test.ts` in one commit. |
| Known limitations | External packages are declared in a local `external.d.ts`, so there is no real `node_modules` resolution. Only `lodash` and one scoped package are represented. |
| Update procedure | Edit the graph, re-derive each consumer list and depth by hand from the imports, update this entry and the test, then run `pnpm vitest run test/codeIndex.test.ts` and `pnpm verify`. |
| Files (13) | See the manifest below. |

```text
test/fixtures/dependency-graph/src/adapters/escape.ts
test/fixtures/dependency-graph/src/adapters/lodash_api.ts
test/fixtures/dependency-graph/src/adapters/scoped.ts
test/fixtures/dependency-graph/src/consumers/dynamic.ts
test/fixtures/dependency-graph/src/consumers/four.ts
test/fixtures/dependency-graph/src/consumers/one.ts
test/fixtures/dependency-graph/src/consumers/three.ts
test/fixtures/dependency-graph/src/consumers/two.ts
test/fixtures/dependency-graph/src/cycle/a.ts
test/fixtures/dependency-graph/src/cycle/b.ts
test/fixtures/dependency-graph/src/external.d.ts
test/fixtures/dependency-graph/src/manySymbols.ts
test/fixtures/dependency-graph/tsconfig.json
```

### F03 `test/fixtures/dependency-impact/`

| Field | Value |
|---|---|
| Claim | Impact grouping reports one row per direct root and path, preserves shortest depth, and keeps non-additive root counts when the same module is reachable from two roots. |
| Constructs | Two direct `lodash` roots: a narrow import and a star re-export. Ten consumers of each root, thirty consumers of a shared module that imports both roots, and one shared module that appears under both roots. |
| Failure classes | Distinct-consumer undercount, duplicate item keys across roots, depth drift, root-filter acceptance for a non-root, cursor reuse across group semantics, impact pagination. |
| Authority | Reviewed source manifest. Expected counts are hand-derived: 2 direct roots; 10 narrow consumers, 10 barrel consumers, 30 shared consumers, and 1 shared module; 42 rows per root; 84 grouped rows; 53 distinct consumers. |
| Expected result | Unfiltered impact reports `totalConsumers: 53`, `directConsumers: 2`, `transitiveConsumers: 51`, roots with 42 each, and 84 items. The shared module appears under both roots. Root filtering to `src/boundary/narrow.ts` reports 42 items and one root. A non-root filter and a filter in non-transitive mode both throw. |
| Consuming tests | `test/codeIndex.test.ts`. |
| Mutation policy | Ground truth; the arithmetic above is the contract. Any file addition or removal requires recomputing all four counts and the per-root totals by hand, then updating this entry and the test. |
| Known limitations | Proves authored-module reachability, not binding use: all thirty shared consumers are impacted even when they use an unrelated binding. The fan-out is larger than a human would review per file, so the counts are the primary expectation. |
| Update procedure | Change the graph, recompute the counts from the source manifest, update this entry and the test, then run `pnpm vitest run test/codeIndex.test.ts` and `pnpm verify`. |
| Files (55) | See the manifest below. |

```text
test/fixtures/dependency-impact/src/boundary/barrel.ts
test/fixtures/dependency-impact/src/boundary/narrow.ts
test/fixtures/dependency-impact/src/consumers/barrel01.ts
test/fixtures/dependency-impact/src/consumers/barrel02.ts
test/fixtures/dependency-impact/src/consumers/barrel03.ts
test/fixtures/dependency-impact/src/consumers/barrel04.ts
test/fixtures/dependency-impact/src/consumers/barrel05.ts
test/fixtures/dependency-impact/src/consumers/barrel06.ts
test/fixtures/dependency-impact/src/consumers/barrel07.ts
test/fixtures/dependency-impact/src/consumers/barrel08.ts
test/fixtures/dependency-impact/src/consumers/barrel09.ts
test/fixtures/dependency-impact/src/consumers/barrel10.ts
test/fixtures/dependency-impact/src/consumers/narrow01.ts
test/fixtures/dependency-impact/src/consumers/narrow02.ts
test/fixtures/dependency-impact/src/consumers/narrow03.ts
test/fixtures/dependency-impact/src/consumers/narrow04.ts
test/fixtures/dependency-impact/src/consumers/narrow05.ts
test/fixtures/dependency-impact/src/consumers/narrow06.ts
test/fixtures/dependency-impact/src/consumers/narrow07.ts
test/fixtures/dependency-impact/src/consumers/narrow08.ts
test/fixtures/dependency-impact/src/consumers/narrow09.ts
test/fixtures/dependency-impact/src/consumers/narrow10.ts
test/fixtures/dependency-impact/src/consumers/shared01.ts
test/fixtures/dependency-impact/src/consumers/shared02.ts
test/fixtures/dependency-impact/src/consumers/shared03.ts
test/fixtures/dependency-impact/src/consumers/shared04.ts
test/fixtures/dependency-impact/src/consumers/shared05.ts
test/fixtures/dependency-impact/src/consumers/shared06.ts
test/fixtures/dependency-impact/src/consumers/shared07.ts
test/fixtures/dependency-impact/src/consumers/shared08.ts
test/fixtures/dependency-impact/src/consumers/shared09.ts
test/fixtures/dependency-impact/src/consumers/shared10.ts
test/fixtures/dependency-impact/src/consumers/shared11.ts
test/fixtures/dependency-impact/src/consumers/shared12.ts
test/fixtures/dependency-impact/src/consumers/shared13.ts
test/fixtures/dependency-impact/src/consumers/shared14.ts
test/fixtures/dependency-impact/src/consumers/shared15.ts
test/fixtures/dependency-impact/src/consumers/shared16.ts
test/fixtures/dependency-impact/src/consumers/shared17.ts
test/fixtures/dependency-impact/src/consumers/shared18.ts
test/fixtures/dependency-impact/src/consumers/shared19.ts
test/fixtures/dependency-impact/src/consumers/shared20.ts
test/fixtures/dependency-impact/src/consumers/shared21.ts
test/fixtures/dependency-impact/src/consumers/shared22.ts
test/fixtures/dependency-impact/src/consumers/shared23.ts
test/fixtures/dependency-impact/src/consumers/shared24.ts
test/fixtures/dependency-impact/src/consumers/shared25.ts
test/fixtures/dependency-impact/src/consumers/shared26.ts
test/fixtures/dependency-impact/src/consumers/shared27.ts
test/fixtures/dependency-impact/src/consumers/shared28.ts
test/fixtures/dependency-impact/src/consumers/shared29.ts
test/fixtures/dependency-impact/src/consumers/shared30.ts
test/fixtures/dependency-impact/src/external.d.ts
test/fixtures/dependency-impact/src/shared/shared.ts
test/fixtures/dependency-impact/tsconfig.json
```

### F04 `test/fixtures/dependency-cases/`

| Field | Value |
|---|---|
| Claim | A controlled, documented dependency matrix pins package imports, package re-exports, named and star authored re-exports, binding names, impact paths, cycles, and reachability-based impact before traversal is tested elsewhere. |
| Constructs | Direct package import, package re-export, named re-export, star re-export, barrel and named consumers, a non-package binding through a barrel, twelve paged consumers, a two-file cycle, and a type-only `external.d.ts`. |
| Failure classes | Edge direction, binding import/export name mapping, re-export chain resolution, unused-binding filtering, duplicate impact rows, cycle safety, pagination. |
| Authority | Reviewed source manifest: the checked-in fixture README is the reviewed ground truth for every edge, binding, and impact path. |
| Expected result | Four direct package consumers (`cycle/a.ts` import, `roots/direct.ts` import, `roots/inner.ts` import, `roots/reexport.ts` export); the re-export edge carries `debounce` to `debounce`; authored re-exports into `inner.ts` are `barrel.ts` (export-all) and `named.ts` (named `work`); impact paths match the README table, including `unusedBinding.ts` at depth three. |
| Consuming tests | `test/dependencyCases.test.ts`. |
| Mutation policy | Ground truth. The in-directory README and the source graph must change together; every row in the README is an assertion source. Tests may edit only the temporary copy. |
| Known limitations | Current impact semantics prove authored-module reachability, not binding use; the README records that `unusedBinding.ts` is intentionally impacted. The fixture is intentionally independent of `dependency-graph` and `dependency-impact`. |
| Update procedure | Edit the graph and the README together, update this entry, then run `pnpm vitest run test/dependencyCases.test.ts` and `pnpm verify`. Never derive the README from a live index run. |
| Files (26) | See the manifest below. |

```text
test/fixtures/dependency-cases/README.md
test/fixtures/dependency-cases/src/consumers/page01.ts
test/fixtures/dependency-cases/src/consumers/page02.ts
test/fixtures/dependency-cases/src/consumers/page03.ts
test/fixtures/dependency-cases/src/consumers/page04.ts
test/fixtures/dependency-cases/src/consumers/page05.ts
test/fixtures/dependency-cases/src/consumers/page06.ts
test/fixtures/dependency-cases/src/consumers/page07.ts
test/fixtures/dependency-cases/src/consumers/page08.ts
test/fixtures/dependency-cases/src/consumers/page09.ts
test/fixtures/dependency-cases/src/consumers/page10.ts
test/fixtures/dependency-cases/src/consumers/page11.ts
test/fixtures/dependency-cases/src/consumers/page12.ts
test/fixtures/dependency-cases/src/consumers/shared.ts
test/fixtures/dependency-cases/src/consumers/unusedBinding.ts
test/fixtures/dependency-cases/src/consumers/viaBarrel.ts
test/fixtures/dependency-cases/src/consumers/viaNamed.ts
test/fixtures/dependency-cases/src/cycle/a.ts
test/fixtures/dependency-cases/src/cycle/b.ts
test/fixtures/dependency-cases/src/external.d.ts
test/fixtures/dependency-cases/src/roots/barrel.ts
test/fixtures/dependency-cases/src/roots/direct.ts
test/fixtures/dependency-cases/src/roots/inner.ts
test/fixtures/dependency-cases/src/roots/named.ts
test/fixtures/dependency-cases/src/roots/reexport.ts
test/fixtures/dependency-cases/tsconfig.json
```

### F05 `test/fixtures/reference-grouping/`

| Field | Value |
|---|---|
| Claim | `find_references` accepts exactly one selector and returns correct file, owner, and occurrence groups with stable ordering, usage counts, filters, bounds, and cursor continuity. |
| Constructs | One exported function referenced from two files and at top level; two declarations with the same name in different files for genuine query ambiguity; a path alias declared in `tsconfig.json` but unused by this fixture. |
| Failure classes | Selector validation, wrong group kind, wrong owner attribution, ordering drift, usage-count drift, ambiguity misclassification, cursor reuse. |
| Authority | Reviewed source manifest. The five occurrences, three files, five owner groups, and duplicate candidate set are hand-derived from the five tiny sources. |
| Expected result | A `symbolId` selector stays in occurrence mode with five occurrences. A `query: duplicate` defaults to file groups: `src/first.ts` count 2 usage 3, `src/second.ts` count 2 usage 3, `src/shared.ts` count 1 usage 1, with `groupsTotal: 3`, `occurrencesTotal: 5`, `definitionsTotal: 1`, `crossFileRefsObserved: true`. Owner mode returns five groups in the pinned order. A bare `repeated` query reports candidates `src/duplicateA.ts` and `src/duplicateB.ts`. |
| Consuming tests | `test/referenceGrouping.test.ts`. |
| Mutation policy | Ground truth; counts and order are pinned. Any source change requires recomputing the groups from the sources and updating this entry and the test. |
| Known limitations | Path aliases are configured but not used, so alias resolution is not proven here. Ambiguity coverage is limited to duplicate top-level names in two files. |
| Update procedure | Edit the sources, recompute the file/owner/occurrence groups by hand, update this entry and the test, then run `pnpm vitest run test/referenceGrouping.test.ts` and `pnpm verify`. |
| Files (6) | See the manifest below. |

```text
test/fixtures/reference-grouping/src/duplicateA.ts
test/fixtures/reference-grouping/src/duplicateB.ts
test/fixtures/reference-grouping/src/first.ts
test/fixtures/reference-grouping/src/second.ts
test/fixtures/reference-grouping/src/shared.ts
test/fixtures/reference-grouping/tsconfig.json
```

### F06 `test/fixtures/reference-edges/`

| Field | Value |
|---|---|
| Claim | The reference extractor matches the TypeScript language service for merged declarations, override and inheritance chains, destructuring, shorthand properties, JSX component use, and transient property reads. |
| Constructs | Merged interfaces and function/namespace declarations; base and derived classes with `override`; object and nested destructuring; shorthand properties; a JSX component and its props; a `.tsx` consumer. |
| Failure classes | False-positive reference locations, missing reference locations, wrong reference tag, JSX attribute misclassification, merged-symbol identity. |
| Authority | Language service. `verifyTypeScriptReferences` compares every indexed location with the compiler's reference locations; no expected result is recorded from the index. |
| Expected result | `sampledSymbols === locatedSymbols`, zero unlocated symbols, no skipped symbols, zero missing and extra locations, recall 1, precision 1, and the tag set contains `override`, `destructuring`, `jsx-component`, `inheritance`, `declaration-merging`, and `shorthand-property`. |
| Consuming tests | `test/referenceVerification.test.ts`. |
| Mutation policy | Ground truth; a source edit changes language-service truth automatically. Do not add per-location expected lists. Keep the fixture small and focused; move new constructs to F07. |
| Known limitations | One component and one props type. It does not cover path aliases, default exports, or JavaScript. |
| Update procedure | Prefer no change. If a construct is added, confirm it is a distinct tag not already covered by F07, then run `pnpm vitest run test/referenceVerification.test.ts` and `pnpm verify`. The gate is the authority, not a recorded snapshot. |
| Files (4) | See the manifest below. |

```text
test/fixtures/reference-edges/EdgePanel.tsx
test/fixtures/reference-edges/edges.ts
test/fixtures/reference-edges/tsconfig.json
test/fixtures/reference-edges/usage.tsx
```

### F07 `test/fixtures/reference-corpus/`

| Field | Value |
|---|---|
| Claim | The production reference gate passes with full construct-tag coverage, deterministic sampling, and every pinned representative sampled. |
| Constructs | Direct references at volume; named, default, and namespace imports; inheritance and override chains; declaration merging; type-only references; barrels and named re-exports; destructuring; shorthand properties; JSX components; path aliases; JavaScript under `allowJs`. |
| Failure classes | Recall or precision regression, extra or missing locations, tag-coverage loss, sampling drift, representative loss, alias or JSX resolution failure. |
| Authority | Language service. Expected coverage is the gate threshold plus the reviewed `REFERENCE_CORPUS_MANIFEST` tags and representatives; the manifest selects constructs, it does not record indexer output. |
| Expected result | At least the sample target indexed; sampled symbols equal the sample target; symbols with non-definition references equal the sample target; zero unlocated; no skipped symbols; recall at least 0.995; precision 1; zero missing and extra; gate `ok`; every required tag reaches the quota for declared and referenced symbols; every `mustSample` representative appears in the comparisons. |
| Consuming tests | `test/referenceVerification.test.ts`. The corpus path is also the documented qualification example and the default benchmark suite root, but those are not tests of the fixture. |
| Mutation policy | Ground truth. Layout may change only if selectors still resolve by path, name, and kind. A semantic change requires updating `test/helpers/referenceCorpus.ts` and this entry in the same commit, then proving the gate. Never regenerate the manifest from the adapter. |
| Known limitations | TypeScript only; external packages are not in the corpus. Renaming a declaration breaks a manifest selector by design. The quota forces volume, so files are repetitive by design. |
| Update procedure | Add or edit sources, update the manifest selectors, verify each `mustSample` selector still resolves, update this entry, then run `pnpm vitest run test/referenceVerification.test.ts` and `pnpm verify`. |
| Files (34) | See the manifest below. |

```text
test/fixtures/reference-corpus/aliases/default.ts
test/fixtures/reference-corpus/aliases/defaultAlt.ts
test/fixtures/reference-corpus/aliases/defaultOther.ts
test/fixtures/reference-corpus/aliases/defaultUsage.ts
test/fixtures/reference-corpus/aliases/named.ts
test/fixtures/reference-corpus/aliases/namedUsage.ts
test/fixtures/reference-corpus/aliases/namespace.ts
test/fixtures/reference-corpus/aliases/namespaceUsage.ts
test/fixtures/reference-corpus/barrels/index.ts
test/fixtures/reference-corpus/barrels/parts.ts
test/fixtures/reference-corpus/barrels/usage.ts
test/fixtures/reference-corpus/destructuring/consume.ts
test/fixtures/reference-corpus/destructuring/usage.ts
test/fixtures/reference-corpus/direct/declarations.ts
test/fixtures/reference-corpus/direct/usage.ts
test/fixtures/reference-corpus/inheritance/base.ts
test/fixtures/reference-corpus/inheritance/derived.ts
test/fixtures/reference-corpus/inheritance/usage.ts
test/fixtures/reference-corpus/javascript/library.js
test/fixtures/reference-corpus/javascript/usage.js
test/fixtures/reference-corpus/jsx/Panel.tsx
test/fixtures/reference-corpus/jsx/usage.tsx
test/fixtures/reference-corpus/merging/module.ts
test/fixtures/reference-corpus/merging/usage.ts
test/fixtures/reference-corpus/pathAliases/target.ts
test/fixtures/reference-corpus/pathAliases/usage.ts
test/fixtures/reference-corpus/reexports/index.ts
test/fixtures/reference-corpus/reexports/source.ts
test/fixtures/reference-corpus/reexports/usage.ts
test/fixtures/reference-corpus/shorthand/declarations.ts
test/fixtures/reference-corpus/shorthand/usage.ts
test/fixtures/reference-corpus/tsconfig.json
test/fixtures/reference-corpus/typeValue/model.ts
test/fixtures/reference-corpus/typeValue/usage.ts
```

### F08 `test/fixtures/publication-project/`

| Field | Value |
|---|---|
| Claim | Canonical publication projects the TypeScript surface correctly: object and class members, projected return members, default exports, aliases, star exports, namespace re-exports, external aliases, inherited members, parameter properties, computed property names, anonymous class expressions, and call/read/write/type usage bits. |
| Constructs | Interfaces, public and private classes, object literals with nested members, default-exported function returning an object, async return projection, array element projection, named and star re-exports, namespace re-export, external package alias, inheritance override, public and private constructor parameter properties, enum-keyed, hyphenated, and empty-string property names, anonymous class expression, and a usage file with call, read, write, and type-reference sites. |
| Failure classes | Surface projection errors, exposure misclassification, alias or external-target loss, binding identity collisions, invariant violations, usage-bit misclassification, default-exposure filtering. |
| Authority | Compiler output. The TypeScript export table and the language-service-based independent prototypes in `test/publicationReport.test.ts` are the truth; the expected binding list is reviewed against the sources. |
| Expected result | Fourteen named bindings are published including `api.run`, `api.nested.deep`, `hidden.m`, `load::return::awaited.ready`, `list::return::element.k`, `default::return.go`, `exposed`, `renamed`, `starValue`, `starFn`, `Derived.baseOnly`, `readValue.run`, `callValue::awaited.ready`, and `typed.x`; public `value` is published and private `hidden` is absent; namespace `helpers` and `helpers.starValue` are published; `externalAlias` carries `externalTarget: 'external-package'`; the empty-string property key in `property-names.ts` binds with terminal name `''` and qualified name `module["src/property-names.ts"]::EmptyKeyedAttributes[""]`, and persists and reads back unchanged; usage bits include call 1, type 8, write 4, read 2; `find_symbol` defaults to visible, `Supporting` is reachable, `internalOnly` is hidden unless `exposure: any`; the independent report passes G-A and G-A2 with zero missing or extra root exports and zero missing aliases. |
| Consuming tests | `test/typescriptPublicationSurface.test.ts`, `test/publicationDefaultsAndEnforcement.test.ts`, `test/publicationReport.test.ts`. |
| Mutation policy | Ground truth. Any source edit must update `EXPECTED_BINDINGS`, the exposure assertions, and the independent report expectations in the same commit. Do not add files that only increase counts without a named construct claim. |
| Known limitations | `property-names.ts` is exercised through the whole-fixture invariant that finalization reports no issues and through the empty-string member assertions; computed and hyphenated names still have no dedicated per-construct assertion. External packages are ambient `.d.ts` declarations, not installed packages. |
| Update procedure | Edit the source, re-derive exposures and usage bits from the compiler export table, update this entry and the three tests, then run `pnpm vitest run test/typescriptPublicationSurface.test.ts test/publicationDefaultsAndEnforcement.test.ts test/publicationReport.test.ts` and `pnpm verify`. |
| Files (11) | See the manifest below. |

```text
test/fixtures/publication-project/src/alias.ts
test/fixtures/publication-project/src/api.ts
test/fixtures/publication-project/src/external-package.d.ts
test/fixtures/publication-project/src/external.ts
test/fixtures/publication-project/src/helper.ts
test/fixtures/publication-project/src/inheritance.ts
test/fixtures/publication-project/src/namespace.ts
test/fixtures/publication-project/src/parameter-property.ts
test/fixtures/publication-project/src/property-names.ts
test/fixtures/publication-project/src/usage.ts
test/fixtures/publication-project/tsconfig.json
```

### F09 `test/fixtures/commonjs-project/`

| Field | Value |
|---|---|
| Claim | CommonJS `export =` in TypeScript and `module.exports` in JavaScript are classified as CommonJS without treating them as ESM exports. |
| Constructs | `module: CommonJS`, `allowJs`, a TypeScript object exported with `export =`, and a JavaScript file assigning `module.exports`. |
| Failure classes | Module-kind detection, export-assignment classification, JavaScript file count, export-identifier extraction. |
| Authority | Compiler output. The module kind and export assignments are defined by the compiler configuration and source statements; the report prototype independently enumerates them. |
| Expected result | JavaScript files and CommonJS files are both greater than zero; the independent prototype reports CommonJS modules, `export =` modules, and `export =` identifier names, each greater than zero. |
| Consuming tests | `test/publicationReport.test.ts`. |
| Mutation policy | Ground truth; both module forms must remain. Keep the project free of ESM syntax so the classification is unambiguous. |
| Known limitations | Report-only measurement; no query-level publication assertions. `checkJs` is disabled, so type-level JavaScript semantics are out of scope. |
| Update procedure | Edit the sources, confirm the compiler still classifies both files as CommonJS, update this entry, then run `pnpm vitest run test/publicationReport.test.ts` and `pnpm verify`. |
| Files (3) | See the manifest below. |

```text
test/fixtures/commonjs-project/src/index.ts
test/fixtures/commonjs-project/src/legacy.js
test/fixtures/commonjs-project/tsconfig.json
```

### F10 `test/fixtures/external-reexport/`

| Field | Value |
|---|---|
| Claim | An authored façade that re-exports an external package keeps its own authored alias as the definition; consumers resolve to the façade and no external declaration is materialized. |
| Constructs | External package re-exported under a local name; a consumer using both a named import and a namespace import of the façade; an ambient module declaration. |
| Failure classes | Dropping the authored alias, leaking an external declaration as a definition, wrong definition path, namespace-member resolution. |
| Authority | Compiler output. The compiler export table determines the façade symbol and the report prototype independently enumerates named external aliases. |
| Expected result | `debounce` is an `alias` in `src/facade.ts`; all definitions are in `src/facade.ts`; a reference exists in `src/consumer.ts`; the report sees named external aliases and a named entry in the missing-published-alias kinds. |
| Consuming tests | `test/codeIndex.test.ts`, `test/publicationReport.test.ts`. |
| Mutation policy | Ground truth; the ambient declaration must stay external to the workspace. Do not add a local implementation of the package, which would erase the claim. |
| Known limitations | One named alias only; default and star external re-exports are covered by other fixtures. |
| Update procedure | Edit the façade or consumer, confirm the compiler export table still names the façade, update this entry and the two tests, then run `pnpm vitest run test/codeIndex.test.ts test/publicationReport.test.ts` and `pnpm verify`. |
| Files (4) | See the manifest below. |

```text
test/fixtures/external-reexport/src/consumer.ts
test/fixtures/external-reexport/src/external-package.d.ts
test/fixtures/external-reexport/src/facade.ts
test/fixtures/external-reexport/tsconfig.json
```

### F11 `test/fixtures/javascript-project/`

| Field | Value |
|---|---|
| Claim | ESM JavaScript is indexed when the project enables `allowJs`: declarations are found, published, referenced across files, and read as source. |
| Constructs | `type: module` package, `module: NodeNext`, `allowJs`, two `.js` modules, a cross-file import, and JSDoc-annotated exports. |
| Failure classes | JavaScript exclusion, module-format misclassification, unpublished export, cross-file reference loss, source-read failure. |
| Authority | Compiler output. The compiler determines the two project files and the `allowJs` semantics; declarations and the cross-file reference follow from the sources. |
| Expected result | Two files indexed; `greet` is in `src/greet.js` with `symbolExposure: 'published'`; a reference exists in `src/index.js`; reading the symbol returns source containing `export const greet`. |
| Consuming tests | `test/extractors.test.ts`, `test/typescriptPublicationSurface.test.ts`. |
| Mutation policy | Ground truth; keep the package ESM and the project JavaScript-only. Adding TypeScript changes the claim. |
| Known limitations | No CommonJS JavaScript (F09) and no JSX in `.js` files. JSDoc types are not asserted. |
| Update procedure | Edit the JavaScript, update this entry and both tests, then run `pnpm vitest run test/extractors.test.ts test/typescriptPublicationSurface.test.ts` and `pnpm verify`. |
| Files (4) | See the manifest below. |

```text
test/fixtures/javascript-project/package.json
test/fixtures/javascript-project/src/greet.js
test/fixtures/javascript-project/src/index.js
test/fixtures/javascript-project/tsconfig.json
```

### F12 `test/fixtures/large-symbol/`

| Field | Value |
|---|---|
| Claim | `read_symbol` truncates a large source within the response byte budget without splitting a UTF-8 code point or emitting a replacement character. |
| Constructs | One exported string containing repeated four-byte emoji and three-byte CJK characters, long enough to exceed a 2000-byte envelope. |
| Failure classes | Byte-versus-character truncation, split code point, replacement character, envelope overflow, wrong truncation reason. |
| Authority | Reviewed source manifest plus the envelope contract. The literal source defines the byte content; the contract defines the bound. No expected snapshot is recorded. |
| Expected result | The serialized response is at most 2000 bytes; the source is non-empty; it contains no U+FFFD; `truncated` is true and `truncatedReason` is `bytes`. |
| Consuming tests | `test/mcpSmoke.test.ts`. |
| Mutation policy | Ground truth; preserve the emoji/CJK mix. Replacing it with ASCII removes the code-point claim. The content must stay large enough to truncate at the pinned bound. |
| Known limitations | A single symbol and a single bound. Line-based truncation and context-line behaviour are covered by module tests with inline values. |
| Update procedure | Edit only to strengthen the character mix, then run `pnpm vitest run test/mcpSmoke.test.ts` and `pnpm verify`. Re-derive the bound from the contract, never from the current output length. |
| Files (2) | See the manifest below. |

```text
test/fixtures/large-symbol/src/large.ts
test/fixtures/large-symbol/tsconfig.json
```

### F13 `test/fixtures/multi-project/`

| Field | Value |
|---|---|
| Claim | Three TypeScript project contexts index into one generation with context-tagged declarations, references, and dependency consumers, and a failing context does not replace the published generation. |
| Constructs | Root browser project with a path alias; contracts project; server project with NodeNext; a shared `ServiceRequest` type imported by root and server; an undeclared package import in two contexts; per-project `tsconfig.json` files. |
| Failure classes | Context attribution, duplicate declaration handling, union file count, context filter validation, dependency filter leakage, failed-rebuild publication, duplicate or ambiguous project configuration. |
| Authority | Compiler output for the project graph and module resolution, plus a reviewed source manifest for the three-file union and the pinned contexts. |
| Expected result | Three files indexed across contexts `browser`, `contracts`, and `server`; `ServiceRequest` is one type in `contracts/src/service.ts` with all three contexts; client references are tagged `browser`, server references `server`; `shared-package` consumers are `server/src/routes.ts` and `src/client.ts`, and the contracts filter returns none; a malformed server `tsconfig.json` throws while the published generation id is unchanged; duplicate context names and duplicate project files are rejected. |
| Consuming tests | `test/multiProject.test.ts`, `test/multiProjectConfig.test.ts`, `test/referenceGrouping.test.ts`. |
| Mutation policy | Ground truth; keep exactly three contexts and three authored files. Changing the project set requires updating both multi-project tests and this entry. |
| Known limitations | Projects do not use composite references or `extends`; the shared file is reached by relative import and alias, not by package boundary. |
| Update procedure | Edit the projects, confirm the compiler still loads all three, update this entry and the three tests, then run `pnpm vitest run test/multiProject.test.ts test/multiProjectConfig.test.ts test/referenceGrouping.test.ts` and `pnpm verify`. |
| Files (6) | See the manifest below. |

```text
test/fixtures/multi-project/contracts/src/service.ts
test/fixtures/multi-project/contracts/tsconfig.json
test/fixtures/multi-project/server/src/routes.ts
test/fixtures/multi-project/server/tsconfig.json
test/fixtures/multi-project/src/client.ts
test/fixtures/multi-project/tsconfig.json
```

### F14 `test/fixtures/oracle-project/`

| Field | Value |
|---|---|
| Claim | Oracle 19c sources exercise manifest scanning and freshness, declaration extraction, overload and spec/body identity, private forwards, nested routines, conditional compilation, reference scoping, dependency sites, parser binding, and live-qualification plan inputs. |
| Constructs | Package specification and body with record, collection, subtype, constant, variable, exception, overloads, default and `IN OUT` parameters, private members, nested routine, and forward declaration; a second package body calling the first with schema-qualified names and an unresolved external package; a standalone procedure; a package body with nested `CASE` expressions and `$IF` branches; an ANTLR/structural manifest. |
| Failure classes | Grammar gap, scope or member resolution, spec/body pairing, overload identity, forward-definition anchoring, conditional-compilation leakage, manifest freshness, source drift, live-plan ordering. |
| Authority | Reviewed source manifest. Every expected unit, declaration, parameter, reference, dependency target, hash transition, and plan ordering is hand-derived from the SQL and documented Oracle 19c semantics. ANTLR versus structural parity is corroborating evidence, not the authority. |
| Expected result | `hr_api.pks` yields one `APP.HR_API` unit with record, fields, collection, subtype, constant, variable, exception, function, two `FIND_EMPLOYEE` procedures, and parameter modes `IN OUT`, `IN`, `IN` with a default; `hr_api.pkb` yields a package body with private constant, private helper, nested routine, two forward declarations, and `HR_API.DELETE_EMPLOYEE` references; `qualification.pkb` recovers all five routines after nested `CASE`, emits no references at declaration sites, and skips literal-disabled branches while keeping unknown-condition branches; dependency sites resolve `HR_API` to `hr_api.pks` and leave `EXTERNAL_API` unresolved; scanning changes the source hash on add/edit/delete and the config hash on manifest change; the live plan snapshots more than five files and orders specification compilation before body compilation. |
| Consuming tests | `test/oracle.test.ts`, `test/oracleAntlr.test.ts`, `test/oracleAntlrDeclarations.test.ts`, `test/oracleAntlrDependencies.test.ts`, `test/oracleAntlrReferences.test.ts`, `test/oracleParserBinding.test.ts`, `test/oracleLiveSource.test.ts`, `test/oracleLivePlan.test.ts`, `test/oracleLiveApply.test.ts`, `test/oracleLiveCommand.test.ts`, `test/oracleRecompile.test.ts`, `test/oracleQualificationRun.test.ts`, `test/publicationFacts.test.ts`. |
| Mutation policy | Ground truth; the six database files are the shared parser, scanner, and live-plan input. Any edit must be reviewed against every consumer, and expectations must be re-derived from the SQL, never from parser output. Live tests stub the database and never reach a real Oracle instance. |
| Known limitations | No live Oracle execution; PL/Scope truth exports are empty or stubbed. The structural parser is retained, so parity tests compare two implementations and can hide a shared misunderstanding; the reviewed source manifest remains authoritative. |
| Update procedure | Edit SQL, re-derive declarations and references by hand, update this entry and the affected Oracle tests, then run `pnpm vitest run test/oracle.test.ts test/oracleAntlr.test.ts test/oracleAntlrDeclarations.test.ts test/oracleAntlrDependencies.test.ts test/oracleAntlrReferences.test.ts test/oracleParserBinding.test.ts test/oracleLivePlan.test.ts test/publicationFacts.test.ts` and `pnpm verify`. |
| Files (7) | See the manifest below. |

```text
test/fixtures/oracle-project/database/hr_api.pkb
test/fixtures/oracle-project/database/hr_api.pks
test/fixtures/oracle-project/database/maintenance_run.prc
test/fixtures/oracle-project/database/qualification.pkb
test/fixtures/oracle-project/database/sales_api.pkb
test/fixtures/oracle-project/database/sales_api.pks
test/fixtures/oracle-project/oracle-index.json
```

### F15 `test/fixtures/oracle-publication-project/`

| Field | Value |
|--------|-------|
| Claim | Oracle publication records declaration forms, call specs, polymorphic table functions, cursor and routine pairing, forward definitions, specification identity with body primary, diagnostics, and usage bits. |
| Constructs | Specification/body pairs; cursor declaration and body; call specification (`IS LANGUAGE JAVA NAME`); polymorphic table function; private forward declaration; missing body; parameter mismatch; private overloads; a usage procedure reading fields, writing members, and calling a call-spec routine. |
| Failure classes | Pairing mismatch, forward-definition primary drift, declaration-form counting, diagnostic code drift (9111 missing/mismatch, 9110 duplicate), usage aggregation, exposure. |
| Authority | Reviewed source manifest. Expected forms, pair counts, primary paths, diagnostic codes, and usage counts are hand-derived from the PL/SQL sources and Oracle semantics. The independent report measures the adapter but the asserted facts are source-derived. |
| Expected result | Specification, full-definition, body-forward, call-spec (1), polymorphic-table-function (1), cursor pair (1), routine pairs (>0), call specs (1), and polymorphic table functions (1) are counted. `WRITE_ITEM` is published, defined in both `feature_api.pks` and `feature_api.pkb`, with the body as primary path. `FORWARD_HELPER` and `HELPER` each have a forward and a full definition, with the full definition primary. A parameter-mode mismatch reports 9111, a missing body reports 9111, a duplicate public routine reports 9110, and private overloads report nothing. Usage bits in `feature_usage.prc` include `WRITE_ITEM` call 1, `EXTERNAL_PROC` call 1, `G_ITEM` 6, `G_NOTE` 4 and 2, and `ID` 8, 4, and 2. The report measures routine pairs, cursor pairs, call specs, polymorphic table functions, body forwards, and body-less specifications above zero, while independent prototypes are disabled. |
| Consuming tests | `test/oraclePublicationSurface.test.ts`, `test/publicationReport.test.ts`. |
| Mutation policy | Ground truth. Diagnostic fixtures are edited in temporary copies only; the checked-in source must stay syntactically valid. Any source change requires updating this entry and both tests. |
| Known limitations | No real Oracle compile; the report measures the adapter and explicitly disables the independent prototypes for Oracle. Overload identity is asserted only for the private case and the specification pair. |
| Update procedure | Edit the source, re-derive forms, pairs, diagnostics, and usages by hand, update this entry and both tests, then run `pnpm vitest run test/oraclePublicationSurface.test.ts test/publicationReport.test.ts` and `pnpm verify`. |
| Files (10) | See the manifest below. |

```text
test/fixtures/oracle-publication-project/database/feature_api.pkb
test/fixtures/oracle-publication-project/database/feature_api.pks
test/fixtures/oracle-publication-project/database/feature_usage.prc
test/fixtures/oracle-publication-project/database/hr_api.pkb
test/fixtures/oracle-publication-project/database/hr_api.pks
test/fixtures/oracle-publication-project/database/maintenance_run.prc
test/fixtures/oracle-publication-project/database/qualification.pkb
test/fixtures/oracle-publication-project/database/sales_api.pkb
test/fixtures/oracle-publication-project/database/sales_api.pks
test/fixtures/oracle-publication-project/oracle-index.json
```

### F16 `test/fixtures/oracle-qualification-golden/`

| Field | Value |
|---|---|
| Claim | Golden facts cover constructs PL/Scope does not record, and a pragma argument is classified as outside PL/Scope coverage rather than as a false positive. |
| Constructs | One package body with a function, an `IN` parameter, a recursive call, and a `PRAGMA INLINE` argument that names the routine. |
| Failure classes | Position drift, role or kind drift, pragma false positive, golden-file regeneration from the implementation, coverage misclassification. |
| Authority | Reviewed source manifest. The checked-in golden positions are hand-reviewed against the Oracle source; PL/Scope cannot confirm them. They are never regenerated from the extractor. |
| Expected result | Exactly four facts in source order: `RUN` function definition at 2:11, `P_VALUE` parameter definition at 2:15, `RUN` function reference at 5:10, `P_VALUE` parameter reference at 5:14. The pragma argument `RUN` at 4:17 classifies as `outside_plscope`. |
| Consuming tests | `test/oracleGoldenFacts.test.ts`. |
| Mutation policy | Ground truth. A source or golden edit requires two reviews: one for the SQL position, one for the expected fact. The test may never rewrite the golden file. The fixture is outside the qualification corpus. |
| Known limitations | One tiny package and one pragma form. It proves position and classification, not broad pragma coverage. |
| Update procedure | Edit the SQL, compute every line and column by hand, update this entry and the golden manifest together, then run `pnpm vitest run test/oracleGoldenFacts.test.ts` and `pnpm verify`. |
| Files (2) | See the manifest below. |

```text
test/fixtures/oracle-qualification-golden/golden-facts.json
test/fixtures/oracle-qualification-golden/golden.pkb
```

### F17 `test/fixtures/oracle-grammar-gaps/`

| Field | Value |
|---|---|
| Claim | Each documented grammar gap reports a parse diagnostic instead of silently succeeding, and the fixture is removed when the gap is fixed. |
| Constructs | Nine one-construct files: SQL*Plus `REM` with a tab, non-reserved keyword as identifier, constant expression in a type size, `XMLTABLE ... RETURNING SEQUENCE BY REF`, `IS JSON(STRICT)`, SQL*Plus `EXEC`, `DATE NULL` record field, record value in `INSERT ... VALUES`, and wrapped source. |
| Failure classes | Silent acceptance of an unsupported construct, over-broad diagnostic, gap-register drift, accidental grammar fix without fixture removal. |
| Authority | Reviewed source manifest: each file contains exactly one construct from the known-gap register in [`oracle-antlr.md`](./oracle-antlr.md#7-known-grammar-gaps). The expected result is "a parse diagnostic exists", not a recorded message or location. |
| Expected result | Every one of the nine files yields a diagnostic with code `ORACLE_DIAGNOSTIC.parse`. |
| Consuming tests | `test/oracleGrammarGaps.test.ts`. |
| Mutation policy | Ground truth; one construct per file. Never add a file without a matching gap-register row. When a gap is fixed, delete the file, delete its row from the in-directory README and this manifest, and update the gap register. Wrapped source is out of scope and must not become a grammar-fix target. |
| Known limitations | Asserts only that a parse diagnostic exists; it does not pin the message, location, or recovery shape. The fixtures are not part of the qualification corpus. |
| Update procedure | Add or remove a file only with a gap-register change, update the in-directory README and this entry, then run `pnpm vitest run test/oracleGrammarGaps.test.ts` and `pnpm verify`. |
| Files (10) | See the manifest below. |

```text
test/fixtures/oracle-grammar-gaps/README.md
test/fixtures/oracle-grammar-gaps/constant-size-type.pks
test/fixtures/oracle-grammar-gaps/json-strict.pkb
test/fixtures/oracle-grammar-gaps/keyword-identifier.pks
test/fixtures/oracle-grammar-gaps/nullable-field.pks
test/fixtures/oracle-grammar-gaps/record-insert.sql
test/fixtures/oracle-grammar-gaps/rem-comment.sql
test/fixtures/oracle-grammar-gaps/sqlplus-exec.sql
test/fixtures/oracle-grammar-gaps/wrapped.pkb
test/fixtures/oracle-grammar-gaps/xmltable-returning-sequence.sql
```

### F18 `test/fixtures/typescript-extends/`

| Field | Value |
|---|---|
| Claim | A relative `extends` array inherits compiler options, `include`, and `exclude`, applies root overrides over inherited values, and adds every inherited configuration file to the watch set. A package base inherits options and selection through package resolution. |
| Constructs | Root `extends: ["./tsconfig.base.json", "./tsconfig.extra.json"]`; base sets `target`, `module`, `moduleResolution`, `strict`, `noEmit`, `baseUrl`, `paths`, and `include`; extra sets `exclude`; root overrides `noUnusedLocals`; `src/entry.ts` imports the excluded `src/excluded/skip.ts`. |
| Failure classes | Inherited option or selection loss, array-order or override inversion, configured `exclude` confused with scanner exclusion, missing config-chain watch entry, package-base resolution loss. |
| Authority | Compiler output. Effective options, root names, and module resolution come from `ts.createProgram`; expected paths and the watch chain are reviewed from the checked-in configuration and source. |
| Expected result | Effective options are `strict: true`, `target: ES2022` (9), `noUnusedLocals: false`, and `paths["@base/*"] = ["src/*"]`. Program roots and scan files are exactly `src/entry.ts`; `src/excluded/skip.ts` is authored by scanner policy but removed by configured `exclude`. The published generation contains `src/entry.ts` and the imported `src/excluded/skip.ts`, and `find_symbol` resolves `skipped`. The watch set contains `package.json`, `tsconfig.json`, `tsconfig.base.json`, and `tsconfig.extra.json`. The separately constructed `@fixture/base` package base inherits `strict` and `target`, selects `src/main.ts` only, and watches both base `package.json` and `tsconfig.json`. |
| Consuming tests | `test/typescriptAdapterContracts.test.ts`. |
| Mutation policy | Ground truth for inheritance and selection. Any option, include, exclude, or import change requires updating this entry and the test together; the package-base case is synthesized in a temporary workspace, not stored here. |
| Known limitations | One relative chain depth and one package base. It does not exercise JavaScript configs, project references, or cyclic `extends`. |
| Update procedure | Edit the configuration or sources, re-derive options and roots with the compiler, update this entry and the test, then run `pnpm vitest run test/typescriptAdapterContracts.test.ts` and `pnpm verify`. |
| Files (6) | See the manifest below. |

```text
test/fixtures/typescript-extends/package.json
test/fixtures/typescript-extends/src/entry.ts
test/fixtures/typescript-extends/src/excluded/skip.ts
test/fixtures/typescript-extends/tsconfig.base.json
test/fixtures/typescript-extends/tsconfig.extra.json
test/fixtures/typescript-extends/tsconfig.json
```

### F19 `test/fixtures/typescript-files/`

| Field | Value |
|---|---|
| Claim | A `files` list selects the published roots, while an authored transitive import is published and an unrelated authored file is not. |
| Constructs | `files: ["src/selected.ts"]`; `src/selected.ts` imports `src/imported.ts`; `src/unused.ts` exists and is neither selected nor imported. |
| Failure classes | `include` semantics substituted for `files`, imported-outside-project file dropped, unrelated authored file published, scanner policy mistaken for configured selection. |
| Authority | Compiler output. The program root names and module resolution come from `ts.createProgram`; the published set is reviewed from the source graph. |
| Expected result | Scan files are exactly `src/selected.ts`. The published generation contains `src/imported.ts` and `src/selected.ts`. A symbol query for `unused` returns no items. |
| Consuming tests | `test/typescriptAdapterContracts.test.ts`. |
| Mutation policy | Ground truth. Changing the `files` list or the import edge requires updating this entry and the test together. |
| Known limitations | One root and one transitive import. It does not prove `files` plus `include` interaction or multi-context union. |
| Update procedure | Edit the configuration or sources, re-derive roots and the published set by hand, update this entry and the test, then run `pnpm vitest run test/typescriptAdapterContracts.test.ts` and `pnpm verify`. |
| Files (5) | See the manifest below. |

```text
test/fixtures/typescript-files/package.json
test/fixtures/typescript-files/src/imported.ts
test/fixtures/typescript-files/src/selected.ts
test/fixtures/typescript-files/src/unused.ts
test/fixtures/typescript-files/tsconfig.json
```

### F20 `test/fixtures/typescript-invalid/`

| Field | Value |
|---|---|
| Claim | A syntactically invalid construct produces one bounded compiler diagnostic, and extraction still publishes one complete generation carrying that diagnostic. |
| Constructs | One source with an invalid type annotation: `export const broken: = 1;`. |
| Failure classes | Silently empty diagnostics, partial or unpublished generation, diagnostic count drift, diagnostic path escaping the repository-relative form. |
| Authority | Compiler output. TypeScript reports parser diagnostic code 1110 at the invalid annotation; the fixture contains exactly that one error. |
| Expected result | Loading reports one diagnostic with `category: "error"`, `code: 1110`, and `path: "src/broken.ts"`; `diagnosticCount` is 1. Verification reports one file and one diagnostic with matching metadata, only one generation exists, it is `published`, and its file list is exactly `src/broken.ts`. |
| Consuming tests | `test/typescriptAdapterContracts.test.ts`. |
| Mutation policy | Ground truth. Keep exactly one invalid construct so the diagnostic count and code stay pinned; a compiler upgrade that changes the code requires updating this entry. |
| Known limitations | Proves diagnostic publication, not a hard extraction abort. Fatal project-configuration failures are covered by `test/loadProject.test.ts`. |
| Update procedure | Edit the invalid source, confirm the compiler diagnostic code and count, update this entry and the test, then run `pnpm vitest run test/typescriptAdapterContracts.test.ts` and `pnpm verify`. |
| Files (3) | See the manifest below. |

```text
test/fixtures/typescript-invalid/package.json
test/fixtures/typescript-invalid/src/broken.ts
test/fixtures/typescript-invalid/tsconfig.json
```

### F21 `test/fixtures/typescript-require/`

| Field | Value |
|---|---|
| Claim | Literal CommonJS `require()` calls emit authored and package dependency edges with variable and destructured bindings, no binding for a conditional bare call, and classified read and call usage bits. |
| Constructs | `const whole = require('./dep')`; `const {value, helper: renamed} = require('./dep')`; conditional bare `require('optional-package')`; `renamed(value)` and `export {renamed, value, whole}`. |
| Failure classes | Missing `require` edge, authored target reported as a package, binding or alias loss, synthetic binding for a bare call, compile-time-only misclassification, usage bit drift. |
| Authority | Reviewed source manifest. Edge targets, binding forms, and the read/call usage bits are derived from the checked-in source and the compiler's CommonJS resolution. |
| Expected result | Two authored edges from `src/requirer.ts` with `rawTarget: "./dep"`, `kind: "require"`, `targetPath: "src/dep.ts"`, `targetIdentifier: null`, and `compileTimeOnly: false`. Bindings are `whole`, destructured `value`, and destructured `helper` renamed to `renamed`, all `kind: "require"` and `compileTimeOnly: false`. One conditional package edge has `targetIdentifier: "optional-package"` and no bindings; direct usage reports the single consumer `src/requirer.ts`. Reference usage is read (2) for `value` and call (1) for `renamed`. |
| Consuming tests | `test/typescriptAdapterContracts.test.ts`. |
| Mutation policy | Ground truth. A change to the require forms or the use of a binding requires updating this entry and the test together. |
| Known limitations | Literal specifiers only; non-literal `require()` calls remain unindexed. Authored bindings are local aliases and are not resolved back to the required module's exported symbols. |
| Update procedure | Edit the source, re-derive edges, bindings, and usage bits by hand, update this entry and the test, then run `pnpm vitest run test/typescriptAdapterContracts.test.ts` and `pnpm verify`. |
| Files (4) | See the manifest below. |

```text
test/fixtures/typescript-require/package.json
test/fixtures/typescript-require/src/dep.ts
test/fixtures/typescript-require/src/requirer.ts
test/fixtures/typescript-require/tsconfig.json
```

### F22 `test/fixtures/oracle-qualification-corpus/`

| Field | Value |
|---|---|
| Claim | Ten synthetic Oracle PL/SQL cases exercise every supported O1 declaration class, usage mapping, internal dependency, and live exclusion under contract `oracle-o1@4`. |
| Constructs | Package specifications and bodies; public/private routines and variables; parameters; constants; cursors; records and fields; subtypes; exceptions; associative and varray collections; ref cursors; overloads; named arguments; nested routines and block scopes; standalone function/procedure; cross-package calls; ambiguity, unsupported types, and ephemeral declarations. |
| Failure classes | Missing `PROCEDURE` truth, truth-column misalignment, ephemeral declarations entering recall, missing internal package dependency, ambiguous-overload omission, unsupported-type classification, and any gate below its threshold. |
| Authority | The fixture source plus the semantic contract `oracle-o1@4` in [the qualification contract](./oracle-qualification-contract.md). Expected counts are never regenerated from the index. |
| Expected result | The fixture compiles only `CIQ_`-prefixed objects in an isolated schema; the contract gates are exercised by `test/oracleQualificationContract.test.ts` over synthetic truth rows, so no live export is required. |
| Consuming tests | `test/oracleQualificationContract.test.ts`; the replayable current bundle is `benchmark/oracle-production-20261027/`. |
| Mutation policy | Ground truth for the semantic-contract tests. A source change requires recompiling the `CIQ_` objects and rerunning `pnpm verify`. |
| Known limitations | Synthetic and small. It does not establish production-corpus recall or representativeness; the production bundle owns that claim. |
| Update procedure | Change source, compile the `CIQ_` objects with PL/SCOPE in an isolated schema, then run `pnpm verify`. A shared schema requires the export to be scoped to the plan's object list first. |
| Files (12) | See the fixture. |

## 5. Orphan register

No fixture directory is orphaned: all twenty-one directories are consumed by at least
one test named above. No fixture file was deleted or bound by this catalogue.

Two files are exercised only through a whole-fixture contract rather than a dedicated
assertion. Both are bound to a named test:

| File | Consuming test and binding |
|---|---|
| `property-names.ts` in F08 | `test/typescriptPublicationSurface.test.ts` asserts that finalization reports no issues and that the expected binding set is published; a regression in computed property names, hyphenated keys, or the anonymous class expression would surface there. |
| `qualification.pkb` in F15 | `test/publicationReport.test.ts` requires body-less specifications and the other pairing measurements to remain above zero, which depends on this body-only package. |

The ignored macOS metadata file that previously sat at the fixture root was removed;
it was never a fixture and never tracked.

## 6. Completeness check

Per-directory counts:

| Entry | Directory | Files |
|---|---|---:|
| F01 | `test/fixtures/simple-project/` | 7 |
| F02 | `test/fixtures/dependency-graph/` | 13 |
| F03 | `test/fixtures/dependency-impact/` | 55 |
| F04 | `test/fixtures/dependency-cases/` | 26 |
| F05 | `test/fixtures/reference-grouping/` | 6 |
| F06 | `test/fixtures/reference-edges/` | 4 |
| F07 | `test/fixtures/reference-corpus/` | 34 |
| F08 | `test/fixtures/publication-project/` | 11 |
| F09 | `test/fixtures/commonjs-project/` | 3 |
| F10 | `test/fixtures/external-reexport/` | 4 |
| F11 | `test/fixtures/javascript-project/` | 4 |
| F12 | `test/fixtures/large-symbol/` | 2 |
| F13 | `test/fixtures/multi-project/` | 6 |
| F14 | `test/fixtures/oracle-project/` | 7 |
| F15 | `test/fixtures/oracle-publication-project/` | 10 |
| F16 | `test/fixtures/oracle-qualification-golden/` | 2 |
| F17 | `test/fixtures/oracle-grammar-gaps/` | 10 |
| F18 | `test/fixtures/typescript-extends/` | 6 |
| F19 | `test/fixtures/typescript-files/` | 5 |
| F20 | `test/fixtures/typescript-invalid/` | 3 |
| F21 | `test/fixtures/typescript-require/` | 4 |
| F22 | `test/fixtures/oracle-qualification-corpus/` | 12 |
| **Total** | **22 directories** | **234** |

Every fixture path appears in exactly one manifest. Verify the set and the
uniqueness:

```bash
find test/fixtures -type f | sort > /tmp/fixture-paths.txt
grep -oE 'test/fixtures/[A-Za-z0-9_./-]+\.(ts|tsx|js|json|md|pks|pkb|prc|sql)' \
	documentation/test-fixtures.md | sort > /tmp/catalogued-paths.txt
diff -u /tmp/fixture-paths.txt /tmp/catalogued-paths.txt
uniq -d /tmp/catalogued-paths.txt
wc -l /tmp/fixture-paths.txt /tmp/catalogued-paths.txt
```

The `diff` and `uniq -d` commands must print nothing, and both counts must be 222.

Checks:

- [x] Every fixture path is catalogued exactly once.
- [x] Every entry names at least one consuming test.
- [x] No entry relies on a snapshot generated by the implementation under test.
- [x] The catalogue is documentation-only; fixture content is unchanged.

## 7. Maintenance

- A new fixture requires a new entry with all nine fields before or with the test that
  consumes it.
- A changed fixture requires re-deriving the expected result from its authority, not
  from a fresh run of the implementation.
- A deleted fixture requires deleting its entry and its manifest, and updating the
  consumer list.
- Arithmetic counts (F03), binding lists (F08), and golden positions (F16) are reviewed
  facts; a reviewer must be able to reproduce them from the sources alone.
