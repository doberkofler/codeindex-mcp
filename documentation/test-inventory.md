# Test Inventory and Ownership

Date: 2026-10-24

Status: accepted inventory for the cleanup sequence in
[Codebase testing strategy](./codebase-testing-strategy.md). This document classifies the
selected tests and records the MCP protocol split.

## 1. Scope and method

Scope is every Vitest test module selected by `vitest.config.ts`:

```text
test/**/*.test.ts(x)                  110 files
evaluation/harness/src/**/*.test.ts    42 files
                                      ---------
                                      152 files
```

Support files under `test/helpers/`, fixture trees under `test/fixtures/`, and non-test harness
modules are test data or implementation, not test files, and are excluded from the file count.
`.DS_Store` entries are ignored.

Each file is assigned exactly one class from the strategy, one interface under test, one data
class, and one primary claim. The primary claim is the behaviour the file owns; assertions that
merely wire that behaviour into another layer are recorded as overlap in section 4.

### Data vocabulary

The data column uses the strategy's data classes plus the controlled inputs described in its
class table.

| Data class | Meaning |
|---|---|
| Inline values | Literals, spies, fake timers; no filesystem |
| Handcrafted facts | Model rows or fact seeds built in the test |
| Micro fixture | One syntax, project, or failure class |
| Vertical fixture | Small complete build or query path |
| Temporary SQLite | Disposable index database |
| Temporary workspace | Copied fixture or synthetic workspace |
| Stub boundary | Injected database, service, session, process, or transport |
| Controlled fake index | Handcrafted `CodeIndex` implementation |
| Synthetic artifacts | Generated reports, results, events, or streams |
| Reference corpus | Differential corpus compared with compiler truth |
| Generated corpus | Generated benchmark project |
| Pinned corpus | Pinned public or external corpus |

## 2. Class totals

| Class | `test/` | `evaluation/harness/src/` | Total |
|---|---:|---:|---:|
| Module test | 61 | 36 | 97 |
| Adapter contract | 24 | 0 | 24 |
| Core integration | 11 | 0 | 11 |
| MCP protocol contract | 5 | 0 | 5 |
| Deterministic system test | 3 | 4 | 7 |
| Semantic qualification | 4 | 2 | 6 |
| Performance test | 2 | 0 | 2 |
| **Total** | **110** | **42** | **152** |

`referenceGrouping.test.ts` is classed as core integration rather than MCP protocol because its
claim is reference-grouping semantics; it calls `CodeIndex` directly.

## 3. Inventory

### 3.1 `test/`

| File | Class | Interface under test | Data | Primary claim |
|---|---|---|---|---|
| `test/analytics.test.ts` | Module test | `events.ts`, `recorder.ts`, `report.ts` | Synthetic artifacts | Versioned events are schema-checked, prohibited fields rejected, and retention and rotation bounded. |
| `test/analyticsCommand.test.ts` | Module test | `runAnalyticsCommand` | Temporary workspace | Text, JSON, and HTML output, overrides, and invalid options follow the command contract. |
| `test/analyticsSummary.test.ts` | Module test | `summarizeAnalytics`, `formatAnalyticsHtml`, `formatAnalyticsText` | Synthetic artifacts | Every event family aggregates with invalid, duplicate, and expired counts and escaped rendering. |
| `test/benchmark.test.ts` | Performance test | `createBenchmarkCorpus`, `runBenchmarkReport`, cursor and edit scenarios | Generated corpus | Generated corpora are deterministic and the production build reports build, storage, reuse, and query metrics and plans. |
| `test/benchmarkEvaluation.test.ts` | Performance test | `evaluateBenchmark`, `buildBenchmarkSummary` | Synthetic artifacts | A report is compared with a compatible pinned baseline through pass, warning, and failure gates, including relative regressions. |
| `test/benchmarkResources.test.ts` | Module test | `startResourceSampler`, `readStorage` | Temporary SQLite | Storage sidecars count as bytes and process sampling reports and stops cleanly. |
| `test/benchmarkSuite.test.ts` | Module test | `loadBenchmarkSuite`, `runBenchmarkSuiteCommand`, suite progress, prepare command | Pinned corpus metadata | Suite definitions validate, progress estimates scale, and help and selection start no work. |
| `test/benchmarkSuiteReporting.test.ts` | Module test | `buildSuiteSummary`, suite command helpers | Synthetic artifacts | Suite reports, identity manifests, pinned checks, and bounded child output are correct. |
| `test/benchmarkSuiteRun.test.ts` | Module test | `runBenchmarkSuiteCommand`, `resolveStepPaths` | Temporary workspace | Steps expand, execute, and resume correctly; workspaces are retained and unsafe options rejected. |
| `test/benchmarkTiming.test.ts` | Module test | `measure`, `summarize`, `phaseOf` | Inline values | Percentiles are nearest-rank, empty samples are explicit, and phase failures preserve their causes. |
| `test/buildLeaseHeartbeat.test.ts` | Module test | `startBuildLeaseHeartbeat` | Inline values | Renewal failures stay inside the timer, are reported, and stop on request. |
| `test/buildWorker.test.ts` | Module test | `isBuildWorkerData`, `runBuildWorker` | Handcrafted facts | Only a complete build payload is accepted and worker failures are reported without a parent port. |
| `test/buildWorkerClient.test.ts` | Module test | `runBuildWorkerThread` | Micro fixture | Worker reports are validated, malformed fields rejected, and worker errors preserved over exit codes. |
| `test/builtProcess.test.ts` | Deterministic system test | Built `dist/mcp.mjs` over stdio | Temporary workspace | Initial publication, every tool, stream isolation, edits, stale refusal, watcher rebuilds, add/delete/rename, failed-build isolation, restart reuse, and clean shutdown hold in the built process. |
| `test/checkoutLifecycle.test.ts` | Core integration | `runCli`, `loadConfig`, `collectCleanupTargets` | Temporary workspaces + temporary SQLite | A copy or move gets its own database and generation, an explicitly shared database is rejected, and a deleted checkout stays cleanable. |
| `test/leaseContention.test.ts` | Deterministic system test | Two built `dist/mcp.mjs` processes over one database | Temporary workspace | One owner holds the lease, the reader serves the published generation, a killed owner never publishes, its heartbeat stops, and an expired lease is taken over. |
| `test/cleanup.test.ts` | Module test | `collectCleanupTargets`, `removeCleanupTargets`, `formatSize`, `executeCleanup`, `runCleanup` | Temporary workspace | Cleanup defaults to the current project's database, scopes `--all` to managed databases, enforces ownership, symlink, and root safety, presents empty/dry-run/removal summaries through injected sinks, and continues after failure. |
| `test/cli.test.ts` | Core integration | `runCli` | Vertical fixture + temporary SQLite | Update, status, verify, reuse, and force-rebuild operate one real index and map failures to exit codes. |
| `test/codeIndex.test.ts` | Core integration | `CodeIndex` queries | Vertical fixtures | Symbol search, outline, paging, references, dependencies, impact, and freshness obey the core query contract. |
| `test/config.test.ts` | Module test | `loadConfig`, `toRepositoryPath` | Temporary workspace | Configuration resolves roots and overrides, rejects database, tsconfig, and path escapes, and keeps storage bound to the checkout when the project id is pinned. |
| `test/consoleDashboard.test.ts` | Module test | `buildAnalyticsDashboard` | Synthetic artifacts | Tool, build, freshness, and watcher signals aggregate over a window without exposing raw events. |
| `test/consoleServer.test.ts` | Module test | `startConsoleServer` | Stub boundary | Bundle serving, token protection, loopback and host checks, and same-origin mutation policy hold. |
| `test/consoleService.test.ts` | Module test | `ConsoleService` | Stub boundary | Status, jobs, analytics, operations, installation, failure retention, and one-time close follow the service contract. |
| `test/database.test.ts` | Core integration | `IndexDatabase` | Temporary SQLite + handcrafted facts | One generation publishes, reopens, supersedes, and registers ownership; derived statistics columns follow their context/site/offset sources; a reader plans hot statements against another process's publication; and only emitted pages are hydrated. |
| `test/databaseFacts.test.ts` | Core integration | `IndexDatabase` fact rows | Handcrafted facts | Fact identifiers are deterministic, foreign keys enforced, and failed candidates isolated from the published generation. |
| `test/dependencyCases.test.ts` | Core integration | `CodeIndex` dependency queries | Vertical fixture | Import, export, dynamic, and re-export edges, impact roots, and pagination retain reviewed ground truth. |
| `test/errors.test.ts` | Module test | `IndexNotReadyError` | Inline values | Not-ready errors use the stable code and an optional specific message. |
| `test/externalBuild.test.ts` | Module test | `observeExternalBuild` | Stub boundary | External publication is observed and an unchanged generation times out. |
| `test/externalCorpus.test.ts` | Module test | `loadBenchmarkSuite`, corpus manifest schema | Pinned corpus | The external Material UI corpus is pinned to the public suite and rejects absolute checkout paths. |
| `test/extractors.test.ts` | Adapter contract | `availableExtractors`, `extractorFor` | Micro fixture | The registry exposes only known adapters and `allowJs` JavaScript declarations index. |
| `test/frozenSuite.test.ts` | Module test | `loadSuite`, `selectCases`, `caseHashOf` | Pinned corpus | Release and calibration suites are frozen with every required class, pattern, and case hash. |
| `test/indexStatus.test.ts` | Module test | `collectStatus`, `summaryStatusOf` | Stub boundary + temporary SQLite | Coordinator states map to freshness and bounded summaries preserve counts and the retained error. |
| `test/loadProject.test.ts` | Adapter contract | `loadTypeScriptProject` | Temporary workspace | Missing and unreadable projects are rejected, outside-workspace diagnostics map to null, and semantic diagnostics are opt-in. |
| `test/logger.test.ts` | Module test | `createLogger`, `debugFor`, `enableDebug` | Inline values | Levels write to stderr at the threshold, default to info, and namespaced debug channels toggle. |
| `test/mcp.test.ts` | MCP protocol contract | MCP tool surface through `buildMcpServer` | Controlled fake index | Exactly seven tools expose schemas, instructions, descriptions, argument rejection, envelopes, projections, stable error codes, and byte bounds. |
| `test/mcpCommand.test.ts` | Module test | `runMcpCommand` | Temporary workspace | The codeindex server entry is created and removed idempotently, surrounding config is preserved, and bundle and config paths are validated. |
| `test/mcpGuidance.test.ts` | MCP protocol contract | Result guidance through `buildMcpServer` | Controlled fake index | Guidance marks current results authoritative, requires the next page, and requires text search only without a stored match. |
| `test/mcpServerAnalytics.test.ts` | MCP protocol contract | `buildMcpServer` analytics | Controlled fake index | Every tool completion records tool, bytes, freshness, truncation, and error code; analytics remains optional. |
| `test/mcpSmoke.test.ts` | MCP protocol contract | MCP tool surface through `buildMcpServer` | Vertical fixture | One real TypeScript index proves all seven tools and the source byte bound are wired end to end; a deterministic medium index keeps `find_symbol` and `outline` pagination stable within a bounded work check. |
| `test/mcpStatus.test.ts` | MCP protocol contract | `index_status` tool | Controlled fake index | The protocol returns a bounded status summary and complete status only on request. |
| `test/multiProject.test.ts` | Adapter contract | `buildGeneration`, `CodeIndex` | Vertical fixture | All configured contexts index into one generation with context-tagged declarations, references, and dependency filters. |
| `test/multiProjectConfig.test.ts` | Module test | `loadConfig` | Temporary workspace | Multiple contexts load from one configuration and duplicate or ambiguous settings are rejected. |
| `test/oracle.test.ts` | Adapter contract | Structural Oracle lexer, parser, manifest, scan | Micro fixture | Structural parsing extracts units, declarations, and references and indexes a manifest with freshness. |
| `test/oracleAntlr.test.ts` | Adapter contract | `parseWithAntlr`, `parseWithAntlrProfiled` | Micro fixture | ANTLR emits unit facts and ranges, handles conditional compilation, recovers, and bounds diagnostics. |
| `test/oracleAntlrDeclarations.test.ts` | Adapter contract | `parseWithAntlr`, `parseOracleUnits` | Micro fixture | Declarations, overload identity, specification to body linking, and type anchors are emitted. |
| `test/oracleAntlrDependencies.test.ts` | Adapter contract | `extractOracleDependencies` | Micro fixture | Dependency sites resolve workspace packages while excluding local chains and SQL aliases. |
| `test/oracleAntlrReferences.test.ts` | Adapter contract | `resolveOracleReferences` | Micro fixture | Local, parameter, member, and type-anchor references resolve with scopes across recovered segments. |
| `test/oracleCodeFacts.test.ts` | Core integration | `loadCodeFacts`, `loadCodeDependencies` | Temporary SQLite | Qualification SQL returns definitions, references, and dependency edges for one generation. |
| `test/oracleCsv.test.ts` | Module test | `parseCsv`, `readCsv`, `writeCsvRows` | Inline values | Quoting, BOM, separators, header removal, and LF output follow the export format. |
| `test/oracleDependencies.test.ts` | Module test | `oracleDependentsOf` | Handcrafted facts | Dependents are ordered, deduplicated, typed, and cycle-safe. |
| `test/oracleDiagnostics.test.ts` | Module test | `OracleDiagnosticCollector` | Inline values | Messages and locations are bounded and one overflow marker is added. |
| `test/oracleGoldenFacts.test.ts` | Adapter contract | `extractOracleSymbols`, `resolveOracleReferences` | Reference corpus | ANTLR facts match the checked-in golden file and pragma arguments classify as outside PL/Scope coverage. |
| `test/oracleGrammar.test.ts` | Module test | Oracle grammar generation script | Synthetic artifacts | Checked-in parser artifacts reproduce byte for byte with no machine paths or timestamps. |
| `test/oracleGrammarGaps.test.ts` | Adapter contract | `parseWithAntlr` | Micro fixture | Each known unsupported construct reports a parse diagnostic instead of silently succeeding. |
| `test/oracleInventory.test.ts` | Module test | `readInstalledOracleSources`, `readInstalledOracleDependencies` | Stub boundary | Installed source and dependency rows are returned completely and malformed shapes rejected. |
| `test/oracleLiveApply.test.ts` | Module test | `applyOracleLivePlan` | Stub boundary | Backup, compile, validate, export, dependent restoration, and baseline comparison report counted progress. |
| `test/oracleLiveCommand.test.ts` | Module test | `runOracleLiveQualification`, `runCli` | Stub boundary | An approved plan applies from the frozen snapshot and output must stay outside the indexed workspace. |
| `test/oracleLivePlan.test.ts` | Module test | `createOracleLivePlan`, `readOracleLivePlan` | Vertical fixture | Plans freeze source, order SQL, bind dependents, require exact approval, and detect source drift. |
| `test/oracleLiveSource.test.ts` | Module test | `oracleSourceUnitsOf`, snapshot assertion | Stub boundary | Unit selection falls back to the file on header-only recovery and rejects missing or malformed sources. |
| `test/oracleOverloadResolution.test.ts` | Adapter contract | `resolveOracleReferences` | Inline values | Member chains, overloads, writes, SQL calls, and package initialization resolve to the correct declaration. |
| `test/oracleParserBinding.test.ts` | Adapter contract | Parser binding and identity, `buildGeneration` | Micro fixture | Parser selection is pinned and validated and the bound parser is injected into extraction. |
| `test/oracleProgress.test.ts` | Module test | `formatDuration`, `phaseProgressLine` | Inline values | Progress lines format durations and ETAs without object names. |
| `test/oracleQualification.test.ts` | Semantic qualification | Truth mapping, policy, and comparison | Handcrafted facts | PL/Scope truth maps to supported facts, policies classify exclusions, and comparisons are stratified. |
| `test/oracleQualificationRun.test.ts` | Semantic qualification | `runOracleQualification` | Vertical fixture | Qualification selects the ANTLR parser, requires both truth exports, and writes a failing report for empty truth. |
| `test/oracleRecompile.test.ts` | Module test | `recompileOracleObjects`, `recompileOracleDependents` | Stub boundary | Targets and dependents recompile with counted progress and dependent failures are logged without aborting all work. |
| `test/oracleSymbolIdentity.test.ts` | Module test | `createOracleId` | Inline values | Identity is stable, 32 characters, discriminator-aware, and field-sensitive. |
| `test/publicationFacts.test.ts` | Core integration | `finalizeFacts`, `collectBindings`, adapter bundles | Handcrafted facts | Finalization derives canonical addresses, identities, and exposure, enforces invariants, and rejects collisions. |
| `test/typescriptPublicationSurface.test.ts` | Adapter contract | TypeScript adapter through finalization and queries | Vertical fixture | Public constructor properties, namespace and alias re-exports, usage bits, and ESM JavaScript publish correctly. |
| `test/oraclePublicationSurface.test.ts` | Adapter contract | Oracle adapter through finalization and queries | Vertical fixture | Specification and body pairing, declaration forms, usage bits, and cross-file targets publish correctly. |
| `test/publicationDefaultsAndEnforcement.test.ts` | Core integration | Finalization defaults, analytics, query | Vertical fixture | `find_symbol` defaults to visible exposure, exact-name analytics aggregate, and measured invariants enforce candidates. |
| `test/publicationReport.test.ts` | Semantic qualification | `runPublicationReportCommand`, independent prototypes | Vertical fixture | Report-only qualification measures facts and independent prototypes without creating an index database. |
| `test/publishedFiles.test.ts` | Module test | `publishedFiles` | Temporary SQLite | No files resolve before publication and published paths resolve against the workspace root. |
| `test/qualifyCommand.test.ts` | Module test | `runQualifyCommand`, `parseCsv` | Inline values | Help is adapter-neutral and unknown extractors and missing Oracle truth exports are rejected. |
| `test/querySupport.test.ts` | Module test | `boundedPagedResult`, `decodeCursor` | Inline values | Cursor identity and binding are enforced and pages truncate by serialized byte size. |
| `test/readSymbolResult.test.ts` | Module test | `readSymbolResult` | Handcrafted facts | Source is included within the result budget or dropped when metadata alone exceeds it. |
| `test/readSymbolSource.test.ts` | Module test | `readSymbolSource` | Inline values | Truncation respects UTF-8 code points, serialized escape overhead, and whole lines. |
| `test/referenceGrouping.test.ts` | Core integration | `CodeIndex.findReferences` | Vertical fixture | Selectors, grouping order, filters, bounds, and cursors follow the one-call reference contract. |
| `test/referenceVerification.test.ts` | Semantic qualification | `verifyTypeScriptReferences`, reference sampling | Reference corpus | Location matching, sampling quotas, precision and recall, and constructed reference edges meet the compiler gate. |
| `test/refreshCoordinator.test.ts` | Module test | `RefreshCoordinator` | Inline values | Event bursts coalesce, one follow-up runs after a build, failures stay stale and retryable, and timing is recorded. |
| `test/routePlan.test.ts` | Module test | `loadRoutePlan`, `routePlanOf`, plan hash | Pinned corpus | Every frozen release case has a deterministic route and an omitted case invalidates comparison. |
| `test/runServer.test.ts` | Module test | `run` MCP composition root | Stub boundary | Startup builds the server, reports a missing working copy, and shuts down once with error handlers. |
| `test/scanWorkspace.test.ts` | Adapter contract | `scanProject`, `collectConfigFiles` | Micro fixture | Authored files exclude generated and declaration files, hashes track edits and additions, and config drift is watched. |
| `test/soak.test.ts` | Deterministic system test | `runSoak`, failure causes, soak report | Temporary workspace | Real edits, injected failures, restart reuse, stale refusal, and retention recover automatically within gates. |
| `test/sourceFiles.test.ts` | Module test | `createVerifiedSourceFileRecord`, source hashing | Temporary workspace | Compiler text is paired with exact read bytes and post-read content changes are rejected. |
| `test/storage.test.ts` | Core integration | `IndexDatabase`, lease, database open plans | Temporary SQLite | Working-copy identity, content deduplication, schema rebuild, single-owner lease, complete planner-statistics lifecycle and repair, and hot indexes persist correctly. |
| `test/suitePrepare.test.ts` | Module test | `runBenchmarkPrepareCommand` | Temporary workspace | Projects clone, reuse, and install idempotently and checkout, install, and suite failures are reported. |
| `test/toolGuidance.test.ts` | Module test | `toolGuidanceOf` | Inline values | Guidance decisions for stop, next page, text search, refinement, and non-authoritative results are exact. |
| `test/toolResponses.test.ts` | Module test | `toCallToolResult`, `errorEnvelope` | Inline values | Unexpected errors are hidden, expected index errors preserved, and envelopes bounded. |
| `test/vcs.test.ts` | Module test | `readVcsProvenance` | Temporary workspace | Unversioned workspaces omit provenance and injected provenance persists across inner database opens. |
| `test/version.test.ts` | Module test | `PROGRAM_VERSION` | Inline values | The compiled version equals the package manifest. |
| `test/workspaceWatcher.test.ts` | Module test | `WorkspaceWatcher` | Temporary workspace | Changed files, project-wide invalidation, atomic writes, deletion, recreation, and ignored segments are reported. |
| `test/consoleApi.test.tsx` | Module test | `readToken`, `storeToken`, `clearToken`, `useSnapshot`, `useAnalytics`, `useRunOperation` | Stub boundary | URL-fragment tokens are stored and stripped, request errors map to stable messages, analytics stays disabled until requested, and an operation posts JSON and invalidates the snapshot. |
| `test/consoleApp.test.tsx` | Module test | `App` composition | Stub boundary | Token entry, every page route, theme persistence, light, dark, and system color schemes with semantic palette tokens, refresh, operation dispatch, and a rejected connection compose through the console application. |
| `test/consoleComponents.test.tsx` | Module test | `BarList`, `MetricCard`, `StatusChip`, `TimeSeriesChart`, `ToolDialog`, `createConsoleTheme` | Inline values | Presentational components render empty and populated states, dialog open and close request trigger restoration once, and light and dark themes retain semantic palette tokens. |
| `test/consoleFormat.test.ts` | Module test | `format.ts` formatters | Inline values | Compact numbers, durations, bytes, percentages, timestamps, clocks, and shortened identities obey their boundaries. |
| `test/consoleMain.test.tsx` | Module test | Browser entry mounting | Stub boundary | The console mounts under `#root` and rejects a page without it. |
| `test/consoleOverlayFocus.test.ts` | Module test | `rememberOverlayTrigger`, `restoreOverlayTrigger` | Inline values | Fallback containers, body focus, blur, disconnected triggers, double restore, and non-element fallbacks are safe. |
| `test/consolePages.test.tsx` | Module test | Console pages and shell | Stub boundary | Overview, operations, analytics, configuration, token gate, and shell navigation render loading, empty, error, and interactive states. |
| `test/oracleConditionalCompilation.test.ts` | Adapter contract | `prepareConditionalSource` | Micro fixture | Literal and unknown conditions, nested blocks, branch selection, line preservation, and every unbalanced directive are classified. |
| `test/oracleLiveQualificationCoverage.test.ts` | Module test | `runOracleLiveQualification` | Stub boundary | Connected planning, generated and explicit manifests, invalid roots and manifests, unsafe output, apply reporting, metadata, and error exits are bounded. |
| `test/oracleNestedBlocks.test.ts` | Adapter contract | `parseNestedBlockDeclarations` | Micro fixture | Nested declarations, directives, pragmas, empty statements, missing `BEGIN`, and cursor bounds are parsed. |
| `test/oracleParserBase.test.ts` | Adapter contract | `PlSqlParserBase` | Inline values | Solidus placement, version toggles, unit flags, numeric-function tokens, and join keywords follow the parser predicates. |
| `test/oracleReferenceArguments.test.ts` | Adapter contract | Argument shapes, predicates, type references, BULK markers | Micro fixture | Literal and named arguments, index chains, statement and assignment positions, numeric ranges, type anchors, and BULK COLLECT markers are classified. |
| `test/oracleResolveCandidates.test.ts` | Adapter contract | `chooseCandidateOf` | Inline values | Candidate deduplication, arity, ambiguity diagnostics, callable fallback, same-file proximity, statement calls, and type filtering are exercised. |
| `test/oracleResolveTypes.test.ts` | Adapter contract | `filterByTypes` | Inline values | Literal, exact, family, JSON, alias, collection-element, recursive, anchored, OUT, and unresolved type paths are exercised. |
| `test/oracleScanProject.test.ts` | Adapter contract | `scanOracleProject`, `isOracleAuthoredSourceFile`, `collectOracleConfigFiles` | Temporary workspace | Include/exclude, extensions, ignored segments, duplicate contexts, snapshot manifest paths, and invalid manifests are handled. |
| `test/oracleSqlNames.test.ts` | Adapter contract | `collectAntlrSqlNames` | Micro fixture | Tables, aliases, column aliases, query names, qualified names, and identifier-less aliases are collected without leaking unrelated names. |
| `test/publicationDiagnostics.test.ts` | Module test | `createPublicationDiagnostics` | Synthetic artifacts | Empty classes, complete and truncated examples, the twenty-example cap, invariant order, incoming truncation, and bounded content are asserted. |
| `test/soakCommand.test.ts` | Module test | `addSoakCommand`, option parsers, report paths | Stub boundary | Numeric bounds, profile allow-list, paths, forwarding, debug, progress, success, retention, failure exit, and cleanup are exercised without a real soak. |
| `test/typescriptAdapterContracts.test.ts` | Adapter contract | Project loading, scanning, dependencies, diagnostics | Temporary workspace + micro fixture | Relative and package `extends`, inherited selection, excluded imports, `files` roots, CommonJS `require()` edges, and unsupported syntax diagnostics publish deterministically. |

### 3.2 `evaluation/harness/src/`

| File | Class | Interface under test | Data | Primary claim |
|---|---|---|---|---|
| `evaluation/harness/src/artifact.test.ts` | Module test | Artifact identity and digest | Temporary workspace | Artifact identity hashes its own files, verifies declared digests, and rejects missing entries and dependencies. |
| `evaluation/harness/src/calibration.test.ts` | Module test | Calibration qualification and selection | Synthetic artifacts | Twelve valid runs qualify, interventions and overruns disqualify, and selection is deterministic. |
| `evaluation/harness/src/diagnostics.test.ts` | Module test | Diagnostic report | Synthetic artifacts | Harness, model, process, index, and timeout anomalies plus missing or duplicate executions are classified. |
| `evaluation/harness/src/environment.test.ts` | Module test | Environment capture and probe | Synthetic artifacts | Committed environments pin full identity, missing facts fail, and differences name every changed fact. |
| `evaluation/harness/src/events.test.ts` | Module test | `parseEvents`, `toolFamilyOf` | Synthetic artifacts | Token and cost telemetry and nested, unknown, and malformed tool events normalize without double counting. |
| `evaluation/harness/src/frozenSuite.test.ts` | Module test | `loadSuite`, `suiteWithModelOf`, case hashes | Pinned corpus | Release and calibration suites are frozen and model rebinding changes suite and model hashes but not case hashes. |
| `evaluation/harness/src/grade.test.ts` | Module test | `gradeOf` | Synthetic artifacts | Exact expected, forbidden, and extra files and absence claims grade with auditable failures. |
| `evaluation/harness/src/identity.test.ts` | Module test | `identityOf`, `hostedReferenceOf` | Synthetic artifacts | Execution identity is stable and every field, including the hosted reference, participates. |
| `evaluation/harness/src/isolation.test.ts` | Module test | Isolation and store helpers | Temporary workspace | The client store is in-memory, campaign stores resolve outside the data directory, and XDG and home fallbacks hold. |
| `evaluation/harness/src/localEvaluation.test.ts` | Module test | Local regression and diagnostic | Synthetic artifacts | Local claims require correct answers and targeted improvement and reject hosted or mismatched claims. |
| `evaluation/harness/src/postRun.test.ts` | Module test | `postRunOf` | Inline values | Exit-code match passes, mismatch fails without changing correctness, timeouts and spawn errors are inspectable, and skip is unevaluated. |
| `evaluation/harness/src/releaseCampaign.test.ts` | Module test | Release campaign verdict | Synthetic artifacts | Complete campaign verdicts, invalid executions, target and interval regressions, and evidence-tier rules hold. |
| `evaluation/harness/src/report.test.ts` | Module test | `compare`, `REPORT_CLASSES` | Synthetic artifacts | Reports retain runs and statistics, compute paired deterministic intervals, and reject incompatible result sets. |
| `evaluation/harness/src/repository.test.ts` | Semantic qualification | Repository suite and TypeScript language service | Reference corpus | Repository cases pin one revision and every declared path, exact file, and semantic claim matches the language service. |
| `evaluation/harness/src/result.test.ts` | Module test | Result read, write, and resume | Temporary workspace | Results are atomic, verified, never overwritten, and resume accepts only complete effective results with the same identity. |
| `evaluation/harness/src/route.test.ts` | Module test | Route plan, run, report, and client | Temporary workspace | Routes resolve symbols, pages, and paths, report medians and contracts, and read structured data from a stdio server. |
| `evaluation/harness/src/routeContractProbe.test.ts` | Module test | Route contract probes | Stub boundary | Pagination, truncation, failure, and stale-file probes accept only the declared contract and restore the workspace. |
| `evaluation/harness/src/runner.test.ts` | Deterministic system test | Runner execution and restoration | Temporary workspace | Executions isolate sessions and databases, enforce timeouts and process groups, and persist failed results. |
| `evaluation/harness/src/runnerRecovery.test.ts` | Deterministic system test | `withRestoration`, `terminateActiveAttempts` | Temporary workspace | Restoration preserves outcomes, retries start from restored workspaces, and signals reach detached groups. |
| `evaluation/harness/src/schema.test.ts` | Deterministic system test | Case and suite schema, hashing, selection | Synthetic artifacts | Schema versions, frozen hashes, canonical hashing, deterministic selection, and resume hold. |
| `evaluation/harness/src/semantic.test.ts` | Semantic qualification | Semantic suite cases and TypeScript compiler | Reference corpus | The controlled semantic fixture compiles and six semantic cases agree with the compiler. |
| `evaluation/harness/src/surface.test.ts` | Module test | Surface permission and presentation | Synthetic artifacts | Declared surfaces deny unnamed actions, the last rule wins, and differences and captures are exact. |
| `evaluation/harness/src/surfaceProbe.test.ts` | Deterministic system test | Surface probe | Stub boundary | Title-only requests differ from tools, captures union tool-bearing requests, and empty surfaces fail. |
| `evaluation/harness/src/treatment.test.ts` | Module test | Treatment definitions, equivalence, catalog, identity | Synthetic artifacts | Treatment hashing, equivalence, surface capture, catalog lookup, and run identity are exact. |
| `evaluation/harness/src/workflow.test.ts` | Module test | `workflowOf` | Synthetic artifacts | Call, byte, and token budgets, required and forbidden tools, first retrieval, duplicate reads, and fallback classify exactly. |
| `evaluation/harness/src/workspace.test.ts` | Module test | Workspace context and restoration | Temporary workspace | Checkouts are pinned, clean, and restorable, authored and ignored changes are rejected, and the manifest fallback holds. |
| `evaluation/harness/src/attemptContext.test.ts` | Module test | Attempt context request-1 surface | Synthetic artifacts | An admitted attempt is invalidated when its first request omits a declared tool and retained when complete. |
| `evaluation/harness/src/certification.test.ts` | Module test | Certification design, blocks, and verdicts | Synthetic artifacts | The frozen design drives paired blocks, metered evidence, and a deterministic certification verdict. |
| `evaluation/harness/src/corpusPreflight.test.ts` | Module test | Corpus preflight | Temporary workspace | Fixture and repository cases map to the controlled project or root and preflight the declared session. |
| `evaluation/harness/src/economicAnalysis.test.ts` | Module test | Paired correctness non-inferiority | Synthetic artifacts | A better candidate passes and an upper degradation bound beyond the margin fails. |
| `evaluation/harness/src/economicContract.test.ts` | Module test | Economic contract and tariff snapshot | Synthetic artifacts | Frozen thresholds and weights, request kinds, billing bands, and cache-write tiers are priced and change-protected. |
| `evaluation/harness/src/externalPath.test.ts` | Module test | External path evidence | Inline values | Every denial is recorded with channel and line, and a clean stream yields no evidence. |
| `evaluation/harness/src/mcpReadiness.test.ts` | Module test | MCP readiness handshake | Stub boundary | Native catalog handshake, delayed registration, reconnect, and closed startup causes are bounded. |
| `evaluation/harness/src/opencodeServer.test.ts` | Module test | Private server lifecycle | Stub boundary | MCP children disconnect before exit, registration completes, and failed reconnects retain a closed cause. |
| `evaluation/harness/src/pilot.test.ts` | Module test | Development pilot design and analysis | Synthetic artifacts | The frozen pilot design, case weights, holdout isolation, pairing, and analysis remain deterministic. |
| `evaluation/harness/src/providerMeter.test.ts` | Module test | Provider meter | Stub boundary | Agent, title, and compaction requests are metered with usage and response text retained. |
| `evaluation/harness/src/providerRequestKind.test.ts` | Module test | Request-kind classification | Inline values | Title, empty agent, tool-bearing agent, and explicit header kinds are classified in precedence order. |
| `evaluation/harness/src/qualification.test.ts` | Module test | Qualification campaign | Synthetic artifacts | The frozen qualification suite, canonical artifact, and environment produce deterministic campaign results. |
| `evaluation/harness/src/requestSurface.test.ts` | Module test | Request surface policy | Inline values | Exact indexed and ordinary surfaces are accepted while duplicates, unknown tools, late tools, and path disclosure are rejected. |
| `evaluation/harness/src/startupBaseline.test.ts` | Module test | Warm startup baseline | Inline values | Nearest-rank percentiles, empty samples, and the declared p95 budget are computed. |
| `evaluation/harness/src/stateRoot.test.ts` | Module test | State root and path disclosure | Temporary workspace | Defaults stay outside the checkout, configured unsafe roots are rejected, and literal checkout paths are counted without echoing unrelated text. |
| `evaluation/harness/src/validityCalibration.test.ts` | Module test | Validity calibration | Synthetic artifacts | The randomized A/A plan, labels, cost vectors, and calibration validity remain deterministic. |

## 4. Behaviour ownership and duplicate register

The owning file is the single place that owns the behaviour. Other files listed in the overlap
column keep only wiring evidence. Where a duplicate is not intentional, it is assigned to an
owner and left in place for the later cleanup sequence.

| Behaviour | Owning class | Owning file | Overlap | Resolution |
|---|---|---|---|---|
| Core symbol, outline, reference, dependency, impact, and freshness queries | Core integration | `test/codeIndex.test.ts` | `test/mcpSmoke.test.ts`, `test/referenceGrouping.test.ts`, `test/typescriptPublicationSurface.test.ts`, `test/oraclePublicationSurface.test.ts`, `test/publicationDefaultsAndEnforcement.test.ts` | Intentional overlap: the MCP smoke proves wiring, and the publication-surface tests prove adapter-to-query wiring. |
| Controlled dependency edge matrix | Core integration | `test/dependencyCases.test.ts` | `test/codeIndex.test.ts` | Intentional overlap: the controlled fixture isolates edge forms; `codeIndex` owns generic shape and paging. |
| Reference selectors, grouping, filters, and cursor continuity | Core integration | `test/referenceGrouping.test.ts` | `test/codeIndex.test.ts` | Intentional overlap: `referenceGrouping` owns grouping semantics; `codeIndex` owns generic query shape and paging. |
| Canonical finalization of bindings, addresses, and invariants | Core integration | `test/publicationFacts.test.ts` | `test/typescriptPublicationSurface.test.ts`, `test/oraclePublicationSurface.test.ts` | Intentional overlap: the adapter vertical slices must prove the finalization seam end to end. |
| TypeScript publication surface | Adapter contract | `test/typescriptPublicationSurface.test.ts` | `test/publicationDefaultsAndEnforcement.test.ts`, `test/publicationReport.test.ts` | No duplicate: the defaults-and-enforcement test owns enforcement defaults and the report owns independent truth. |
| Oracle publication surface | Adapter contract | `test/oraclePublicationSurface.test.ts` | `test/publicationReport.test.ts` | No duplicate: the report uses an independent prototype. |
| TypeScript reference truth and sampling | Semantic qualification | `test/referenceVerification.test.ts` | `test/publicationReport.test.ts` | No duplicate: the gate owns reference locations; the report owns root-export truth. |
| Structural and ANTLR Oracle parser parity | Adapter contract | `test/oracleAntlr.test.ts` and `test/oracleAntlrDependencies.test.ts` differentials | `test/oracle.test.ts` | Intentional overlap: both parsers remain production code and parity is the explicit claim. |
| Oracle golden fact aggregate | Adapter contract | `test/oracleGoldenFacts.test.ts` | `test/oracleAntlrDeclarations.test.ts`, `test/oracleAntlrReferences.test.ts` | Intentional overlap: the golden file is a frozen aggregate; the ANTLR tests own granular construct claims. |
| Oracle truth policy and comparison | Semantic qualification | `test/oracleQualification.test.ts` | `test/oracleQualificationRun.test.ts` | Intentional overlap: the run test owns orchestration and reporting only. |
| Build-lease ownership and renewal | Core integration | `test/storage.test.ts` | `test/database.test.ts` | Intentional overlap: `database` asserts ownership as a publication precondition; `storage` owns lease semantics. |
| Multi-process lease contention and takeover | Deterministic system test | `test/leaseContention.test.ts` | `test/storage.test.ts` | No duplicate: `storage` owns in-process lease semantics; `leaseContention` owns process death, reader isolation, and takeover. |
| Generation publication lifecycle | Core integration | `test/database.test.ts` | `test/databaseFacts.test.ts` | Intentional overlap: `databaseFacts` owns row-level integrity and failure isolation. |
| Page, source, and envelope byte bounds | Module test | `test/querySupport.test.ts` (pages), `test/readSymbolSource.test.ts` (source), `test/readSymbolResult.test.ts` (result) | `test/mcp.test.ts` | No duplicate: each file owns a distinct bound stage; MCP owns only the outer envelope bound. |
| Answer guidance rules | Module test | `test/toolGuidance.test.ts` | `test/mcpGuidance.test.ts` | Intentional overlap: MCP proves the guidance survives the envelope. |
| Error codes and envelopes | Module test | `test/toolResponses.test.ts` | `test/mcp.test.ts`, `test/errors.test.ts` | Intentional overlap: MCP checks every stable code through the fake index; `errors` owns the not-ready code. |
| Freshness status projection | Module test | `test/indexStatus.test.ts` | `test/mcpStatus.test.ts` | Intentional overlap: `mcpStatus` owns only the protocol projection and full-detail switch. |
| Analytics event schema and retention | Module test | `test/analytics.test.ts` | `test/mcpServerAnalytics.test.ts` | Intentional overlap: the MCP file owns only boundary recording and optionality. |
| Analytics aggregation | Module test | `test/analyticsSummary.test.ts` | `test/analytics.test.ts` | Intentional overlap: `analytics` keeps one recorder-to-summary wiring assertion; the summary owns aggregation. |
| Benchmark measurement and generated corpora | Performance test | `test/benchmark.test.ts` | `test/benchmarkEvaluation.test.ts` | No duplicate: measurement and pinned-baseline gating are separate claims. |
| Benchmark suite preparation | Module test | `test/suitePrepare.test.ts` | `test/benchmarkSuite.test.ts` | Duplicate: `benchmarkSuite` repeats clone, install, and prepare assertions. Owner is `suitePrepare`; the overlap is recorded for removal by the cleanup sequence. |
| Frozen suite inventory | Module test | `test/frozenSuite.test.ts` | `evaluation/harness/src/frozenSuite.test.ts` | Intentional overlap: the repository file guards the committed inventory; the harness file owns suite rebinding and hash semantics. |
| CLI command dispatch | Core integration | `test/cli.test.ts` | `test/analyticsCommand.test.ts`, `test/qualifyCommand.test.ts`, `test/mcpCommand.test.ts`, `test/oracleLiveCommand.test.ts` | Intentional overlap: `cli` proves dispatch and exit codes; each command test owns its command behaviour. |
| Refresh coalescing and follow-up | Module test | `test/refreshCoordinator.test.ts` | `test/soak.test.ts` | Intentional overlap: soak proves the composed lifecycle; the coordinator owns the mechanism. |
| Workspace event classification | Module test | `test/workspaceWatcher.test.ts` | `test/soak.test.ts`, `test/refreshCoordinator.test.ts` | Intentional overlap: the watcher owns event classification; soak owns composed recovery. |
| Failed-build isolation | Core integration | `test/database.test.ts` | `test/soak.test.ts` | Intentional overlap: `database` owns the publication boundary; soak owns operational recovery. |
| Evaluation route plan integrity | Module test | `test/routePlan.test.ts` | `evaluation/harness/src/route.test.ts` | Intentional overlap: the repository guard owns the committed plan; the harness owns route execution. |
| Evaluation runner process lifecycle | Deterministic system test | `evaluation/harness/src/runner.test.ts` | `evaluation/harness/src/runnerRecovery.test.ts` | No duplicate: recovery owns restoration and signal delivery after a run. |
| Multi-project configuration and indexing | Adapter contract | `test/multiProject.test.ts` | `test/multiProjectConfig.test.ts` | No duplicate: the config file owns loading and ambiguity; the index file owns context-tagged facts. |
| Worker payload and worker report | Module test | `test/buildWorker.test.ts` (payload) and `test/buildWorkerClient.test.ts` (report) | None | No duplicate: opposite sides of the worker boundary. |
| Source hashing | Module test | `test/sourceFiles.test.ts` | `test/scanWorkspace.test.ts` | Intentional overlap: `sourceFiles` owns byte pairing and hash stability; `scanWorkspace` owns scan, exclusion, and drift decisions. |
| Oracle pragma exclusion | Semantic qualification | `test/oracleQualification.test.ts` | `test/oracleGoldenFacts.test.ts` | Intentional overlap: the golden file marks pragma arguments outside coverage; the truth policy owns exclusion classes. |
| Analytics dashboard projection | Module test | `test/consoleDashboard.test.ts` | `test/analyticsSummary.test.ts` | Intentional overlap: the summary owns event-family aggregation; the dashboard owns windowing and signal projection. |
| Workspace restoration mechanics | Module test | `evaluation/harness/src/workspace.test.ts` | `evaluation/harness/src/runnerRecovery.test.ts` | Intentional overlap: the workspace file owns restore and verify; runner recovery owns composition after an attempt. |
| Oracle live source drift | Module test | `test/oracleLiveSource.test.ts` | `test/oracleLivePlan.test.ts` | Intentional overlap: the source file owns drift guards; the plan proves the pre-apply abort wiring. |

No test file appears in more than one inventory row. The only unresolved duplicate is the
benchmark-preparation overlap, which has a named owner and is out of scope for this item.

## 5. Unexercised contracts from the seam policy

The TypeScript adapter contracts that this inventory previously recorded as unexercised now have
direct tests. The MCP protocol rows were already resolved and remain covered.

| Seam | Contract | Direct test |
|---|---|---|
| TypeScript adapter | `tsconfig` `extends` inheritance | `test/typescriptAdapterContracts.test.ts` proves inherited options with a distinct root override, inherited `include`/`exclude`, resolved roots, package-base selection, and the complete watch chain. |
| TypeScript adapter | `tsconfig` `exclude` and `files` selection | `test/typescriptAdapterContracts.test.ts` proves scanner-authored paths removed only by configured `exclude`, `files` roots, and the imported-outside-project publication rule. |
| TypeScript adapter | CommonJS `require()` dependency edges | `test/typescriptAdapterContracts.test.ts` asserts authored and package edges, variable and destructured bindings, no binding for a conditional bare call, direct usage, and read/call usage bits through the core dependency model. |
| TypeScript adapter | Unsupported-construct diagnostics | `test/typescriptAdapterContracts.test.ts` asserts one bounded parser diagnostic with its stable code, one complete published generation, and no partial generation. |
| MCP protocol | A controlled fake index for protocol contracts | `test/helpers/fakeIndex.ts`; every protocol contract uses it, and only `test/mcpSmoke.test.ts` rebuilds a real fixture index. |
| MCP protocol | Exact tool input schemas and invalid-argument rejection | `test/mcp.test.ts` asserts every tool schema, required field, enum, default, and invalid-argument rejection. |
| MCP protocol | Tool descriptions for every tool | `test/mcp.test.ts` asserts every tool description and the server instructions. |

The built-process deterministic system contracts are covered by `test/builtProcess.test.ts`, and
multi-process lease contention by `test/leaseContention.test.ts`; the in-process mechanisms remain
with their module and core integration tests.

## 6. Completeness check

The inventory contains one row per test module selected by the Vitest include patterns.

```text
test/**/*.test.ts(x)                  110
evaluation/harness/src/**/*.test.ts    42
                                     ----
inventory rows                        152
```

Verification commands:

```bash
find test -type f -name '*.test.ts*' | wc -l
find evaluation/harness/src -type f -name '*.test.ts' | wc -l
```

Checks:

- [x] Every one of the 152 test files has exactly one class and one primary claim.
- [x] No file is unclassified.
- [x] No test file is listed in more than one inventory row.
- [x] Every duplicate has a named owner; the remaining overlaps state their wiring reason.
- [x] One duplicate is not intentional and is assigned to `test/suitePrepare.test.ts` for the
      later cleanup sequence.
- [x] The MCP protocol split is recorded here without changing production response shapes.
- [x] The console UI tests are selected by the `fast` workflow and the coverage report includes `src/ui/**`.
