# CodeIndex repository cases: E0 review

E0 review note for the `codeindex-repository` draft suite and its fourteen cases,
recorded as required by
[strategy §4 E0](../../documentation/mcp-evaluation-strategy.md#e0-case-and-truth-validation)
and [G-E0b/G-E0d](../../documentation/mcp-evaluation-strategy.md#818-gate-to-check-map).

- Suite: `codeindex-repository` version 1, status `draft`, pinned revision
  `3184f55d300144d208d0adef3273af3e5a1cb9b7`.
- Truth authority: TypeScript language service 6.0.3, using the subject's
  `tsconfig.json`.
- Scope: every locate, impact, and semantic case declares `scope: ["src/**"]`. Both
  implementation cases declare their exact source and test files. Every prompt states its
  scope explicitly.
- The pinned revision retains the same `src/` content as the earlier Q2 revision
  `9643b53`, so the inherited locate and impact ground truth is unchanged.

## Method

1. `evaluation/harness/src/repository.test.ts` parses the subject `tsconfig.json` and
   creates one language-service program.
2. For every impact and repository semantic case, the test locates the declaration or
   renamed re-export alias and calls `findReferences`, excluding definition, import, and
   export declarations.
3. The observed file set, restricted to `src/`, must equal `expectedFiles` exactly.
4. Locate cases must resolve their authoritative declaration or literal marker in the
   expected file.
5. Repository semantic cases measure a model-free literal search for every plausible
   identifier. A case is admitted only when the best candidate search has file-set
   precision at most 0.5 or misses an expected file.
6. Implementation cases must declare a deterministic post-run check and an exact
   changed-file set. The check runs the affected unit test with unrelated coverage
   thresholds disabled.

## Locate and implementation cases

| Case | Authoritative site at `3184f55` | Verification |
| --- | --- | --- |
| `locate-schema-version` | `src/core/storage/schema.ts`, the only `SCHEMA_VERSION` definition | Pass, inherited from Q2 v5 |
| `locate-read-symbol-tool` | `src/transports/mcp/buildMcpServer.ts`, the only `read_symbol` registration | Pass, inherited from Q2 v5 |
| `locate-stale-file-error` | `src/core/errors/staleFileError.ts`, the `StaleFileError` class | Pass, inherited from Q2 v5 |
| `locate-result-size-guard` | `src/core/query/querySupport.ts`, the `boundedPagedResult` helper | Pass, inherited from Q2 v5 |
| `impl-default-result-bytes` | `src/core/config/config.ts`, `test/config.test.ts` | Pass against a reference edit |
| `impl-empty-relative-path` | `src/core/query/querySupport.ts`, `test/querySupport.test.ts` | Pass against a reference edit |

Implementation checks:

| Case | Allowed changed files | Post-run check |
| --- | --- | --- |
| `impl-default-result-bytes` | `src/core/config/config.ts`, `test/config.test.ts` | `vitest run test/config.test.ts` |
| `impl-empty-relative-path` | `src/core/query/querySupport.ts`, `test/querySupport.test.ts` | `vitest run test/querySupport.test.ts` |

Both checks passed in a disposable worktree at the pinned revision after applying the
specified edit and its test assertion. The check fails when either the source or the test
still carries the old behavior. No reference patch is committed.

## Impact cases

The definition file is excluded as each prompt states. All sets are exact within `src/`.

| Case | Definition | Expected and observed files |
| --- | --- | --- |
| `impact-build-generation-references` | `src/core/generation/buildGeneration.ts` | `src/core/generation/buildWorker.ts`, `src/core/generation/codeIndex.ts` |
| `impact-hash-content-references` | `src/core/generation/sourceFiles.ts` | `src/core/qualification/oracle/live/oracleLiveCandidates.ts`, `src/core/qualification/oracle/live/oracleLiveSource.ts`, `src/core/query/readSymbolQuery.ts` |
| `impact-bounded-paged-result-references` | `src/core/query/querySupport.ts` | `src/core/query/outlineQuery.ts`, `src/core/query/queryService.ts`, `src/core/query/readSymbolQuery.ts`, `src/core/query/referenceQuery.ts` |
| `impact-schema-version-references` | `src/core/storage/schema.ts` | `src/core/storage/databaseIdentity.ts`, `src/core/storage/databaseOpen.ts`, `src/transports/console/service.ts`, `src/transports/mcp/runServer.ts` |
| `impact-config-load-references` | `src/core/config/config.ts` | `src/adapters/typescript/verifyReferences.ts`, `src/core/benchmark/runBenchmark.ts`, `src/core/qualification/oracle/runOracleQualification.ts`, `src/core/qualification/publication/publicationCommand.ts`, `src/entries/console.ts`, `src/transports/cli/analyticsCommand.ts`, `src/transports/cli/runCli.ts`, `src/transports/mcp/runServer.ts` |
| `impact-codeindex-error-references` | `src/core/errors/codeIndexError.ts` | `src/core/errors/errors.ts`, `src/core/errors/indexNotReadyError.ts`, `src/core/errors/staleFileError.ts`, `src/core/generation/codeIndex.ts`, `src/core/query/dependencyQuery.ts`, `src/core/query/outlineQuery.ts`, `src/core/query/queryService.ts`, `src/core/query/querySupport.ts`, `src/core/query/readSymbolQuery.ts`, `src/core/query/referenceQuery.ts`, `src/core/query/symbolAtQuery.ts`, `src/core/storage/database.ts` |

## Repository semantic cases

| Case | Pattern | Expected files | Language-service result |
| --- | --- | --- | --- |
| `semantic-repo-shadowed-projection-depth` | Shadowed constant name | `src/core/qualification/publication/projectionPrototype.ts`, `src/core/qualification/publication/projectionTraversal.ts` | Pass: exactly the consumers of the `projectionModel` declaration, not the same-named `surfaceCore` declaration |
| `semantic-repo-renamed-name-node` | Renamed re-export | `src/adapters/typescript/referenceLookup.ts` | Pass: only consumer of `candidateNameNode`, not the direct `nameNodeOf` consumers |

Forbidden files record the obvious lexical false positives: both declaration files for
the shadowed constant, and the re-export plus original name for the renamed helper.

### Grep admission

Literal search was measured over `src/**/*.ts`. `precision` is the count of expected files
among the matches divided by the number of matched files. `missing` is the number of
expected files the search does not match.

| Case | Candidate identifier | Matched files | Precision | Missing | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| `semantic-repo-shadowed-projection-depth` | `MAX_PROJECTION_DEPTH` | 5 | 0.40 | 0 | Admitted: precision bound |
| `semantic-repo-renamed-name-node` | `candidateNameNode` | 2 | 0.50 | 0 | Admitted: precision bound |
| `semantic-repo-renamed-name-node` | `nameNodeOf` | 4 | 0.00 | 1 | Admitted: misses the consumer |

No candidate single-identifier search reaches precision above 0.5 without missing an
expected file.

## Corpus position

This suite supplies the repository-snapshot portion of the frozen corpus: four locate
cases, six impact cases, and two bounded implementation cases. The controlled semantic
suite supplies the six mechanically admitted fixture cases. The two repository semantic
cases add E0 evidence for symbol identity on the real repository but are not required to
reach the eighteen-case target. No case in this suite depends on an external corpus,
private source, or a transcript.

## Verdict

All fourteen cases pass schema and dry-run validation, every expected path exists at the
pinned revision, every impact and semantic file set equals the language-service result,
and both implementation checks are deterministic and fail without the specified change.
The suite remains a draft until the final freeze pins case hashes.
