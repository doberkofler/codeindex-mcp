# Model-free accepted-versus-candidate gate: E1 execution

Execution record for the stage-1 accepted-versus-candidate gate required by
[strategy §8.1.2](../../documentation/mcp-evaluation-strategy.md#812-mandatory-architecture-order)
and [G-E1a–G-E1c](../../documentation/mcp-evaluation-strategy.md#818-gate-to-check-map).
No model, agent, or prompt was involved.

- Date: 2026-10-21.
- Suite: `codeindex-release` version 1, status `frozen`, hash
  `073378fe3b9dc71710797a4a31a249d36363802f4347f87b73ff4fe6ae47f110`.
- Subject revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`, detached worktree,
  content manifest `70403067fd91080b9949b26f3a68d632898586b019d53e1ee4291641e0bbb907`.
- Route plan: `codeindex-release-model-free`, hash
  `07033f606eba89c158bc17b9612f62b6e1572273188d04b4e7a50f729bfb4c01`.

## Artifacts

| Treatment | Commit | Artifact digest |
| --- | --- | --- |
| `accepted` | `fed1b6e` (`feat(mcp): default outline and find_symbol to compact detail`) | `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0` |
| `candidate` | `45fc68d` (`chore: mark done: #27`) | `dce80664522731414642fc5d2df6b10048c2ddb10262be2bcd1e9aff9a21b354` |

`accepted` is the evaluated redesign at `fed1b6e`, not release tag `v0.5.0`. The
`v0.5.0` `find_symbol` response predates the compact `symbolId` field the frozen route
plan uses, so it cannot execute the declared accepted route. Both staged trees report
server version `0.5.0`; the artifact digest and commit identify the actual build.

## Command

```bash
node evaluation/harness/src/cli.ts route --suite suites/release.json \
  --treatment no-index,accepted,candidate
```

Each CodeIndex treatment indexed the subject and the controlled fixture project. The
run waited for `index_status`, followed every cursor page, and executed the pagination,
truncation, stale-file, and failure probes against both artifacts. The stale-file probe
edited one declaration, observed the refusal, and restored the workspace.

## Complete-route results

Values are `tool calls / response bytes`, with `exact` marking an exact expected file set.

| Case | Class | no-index | accepted | candidate |
| --- | --- | --- | --- | --- |
| `locate-schema-version` | locate | 1 / 35 exact | 2 / 6120 exact | 2 / 1134 exact |
| `locate-read-symbol-tool` | locate | 1 / 24 exact | 3 / 5920 exact | 3 / 934 exact |
| `locate-stale-file-error` | locate | 1 / 53 exact | 2 / 6131 exact | 2 / 1145 exact |
| `locate-result-size-guard` | locate | 1 / 58 exact | 2 / 6139 exact | 2 / 1153 exact |
| `impact-build-generation-references` | impact | 1 / 270 exact | 3 / 7824 exact | 3 / 3069 exact |
| `impact-hash-content-references` | impact | 1 / 702 exact | 3 / 10680 exact | 3 / 5926 exact |
| `impact-bounded-paged-result-references` | impact | 1 / 480 exact | 3 / 9637 exact | 3 / 4882 exact |
| `impact-schema-version-references` | impact | 1 / 765 exact | 3 / 11205 exact | 3 / 6235 exact |
| `impact-config-load-references` | impact | 1 / 1426 exact | 3 / 12373 exact | 3 / 7403 exact |
| `impact-codeindex-error-references` | impact | 1 / 4534 exact | 3 / 23128 exact | 3 / 18158 exact |
| `semantic-renamed-reexport` | semantic | 1 / 99 exact | 3 / 6829 exact | 3 / 3243 exact |
| `semantic-barrel-chain` | semantic | 1 / 93 exact | 3 / 7502 exact | 3 / 3916 exact |
| `semantic-shadowed-name` | semantic | 1 / 84 exact | 3 / 6164 exact | 3 / 2578 exact |
| `semantic-interface-implementations` | semantic | 1 / 111 exact | 10 / 9790 exact | 10 / 6204 exact |
| `semantic-type-only-import` | semantic | 1 / 134 exact | 3 / 6822 exact | 3 / 3236 exact |
| `semantic-default-export` | semantic | 1 / 69 exact | 3 / 7063 exact | 3 / 3477 exact |
| `impl-default-result-bytes` | implementation | 2 / 21755 exact | 4 / 27870 exact | 4 / 22874 exact |
| `impl-empty-relative-path` | implementation | 2 / 6716 exact | 4 / 12863 exact | 4 / 7867 exact |

| Treatment | Exact | Median calls | Median bytes | Median elapsed | Core query time |
| --- | ---: | ---: | ---: | ---: | --- |
| `no-index` | 18 / 18 | 1 | 122.5 | 17.8 ms | exact, 17.8 ms |
| `accepted` | 18 / 18 | 3 | 7663 | 4.1 ms | exact, 3 ms |
| `candidate` | 18 / 18 | 3 | 3696.5 | 3.8 ms | exact, 3 ms |

The candidate preserved the expected answer set on every case and the complete-route call
count. Median response bytes fell from 7663 to 3696.5 because `find_references` now returns
one grouped file result instead of the accepted occurrence payload. No accepted-versus-
candidate latency or token claim is made from this single run.

## Contract probes

| Probe | accepted | candidate |
| --- | --- | --- |
| Pagination | pass, 7 pages without duplicates | pass, 7 pages without duplicates |
| Truncation | pass, stable `response_too_large` within the 600-byte budget | pass, stable `response_too_large` within the 600-byte budget |
| Stale file | pass, `read_symbol` refused the changed file | pass, `read_symbol` refused the changed file |
| Failure | pass, stable `symbol_not_found` with no leaks | pass, stable `symbol_not_found` with no leaks |

## Verdict

| Gate | Result | Detail |
| --- | --- | --- |
| `G-E1a` | pass | Exact complete-route answers for 18 cases across all three treatments |
| `G-E1b` | pass | Calls, bytes, elapsed time, and separated core query time recorded for 54 routes |
| `G-E1c` | pass | Eight contract probes passed across both artifacts |

Stage 1 passes and stop rule S1 is not triggered. Stage 2 may run. The four locate cases
are contract and measurement checks, not evidence that CodeIndex beats literal search;
their routes are forced by the declared plan and are not a product-value claim. No
external case, model execution, or operational soak is included in this record.

## Reproduction

The staged artifacts are generated and never committed. Rebuild `fed1b6e` and the
candidate commit separately, stage each `dist` tree with its `package.json` and a
resolvable `node_modules`, point `evaluation/harness/harness.json` at a clean checkout
of revision `3b6b791`, then run the command above. The report is written under
`evaluation/results/route/` and is identified by the plan hash and artifact digests
recorded here.
