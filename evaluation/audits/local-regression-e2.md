# Targeted diagnostic and local regression: E2 record

> Historical evidence. The 2026-10-23 gate split replaces moving-candidate local
> regression with independent fixed-artifact model qualification. This record and
> its blocked verdict are unchanged; see [`local-regression-e4.md`](local-regression-e4.md).

Record for the local development loop required by
[strategy §11](../../documentation/mcp-evaluation-strategy.md#11-evaluation-workflow) and
[EVAL-023](https://github.com/doberkofler/codeindex-mcp/issues/31).

- Date: 2026-10-22.
- Suite: `codeindex-release` version 1, status `frozen`, hash
  `073378fe3b9dc71710797a4a31a249d36363802f4347f87b73ff4fe6ae47f110`.
- Subject revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`.
- Environment: `ollama-qwen3.8-27b-calibration`, model
  `ollama/qwen3.8:27b-mlx`, digest
  `5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e`,
  environment hash
  `a22d9f8a8b5e41b7c7bfffc0b1f123f34a77ca5715354618d682e53a4bff4690`.
- Accepted artifact: `fed1b6e`, digest
  `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0`.
- Candidate artifact: current subject build, digest
  `558a58cdd8939c9f78d399c6f375141a814570da5ba1f70eff30210a0075f13c`.
- Target metric predeclared before the first execution: `retrievalBytes`.

## Commands

```bash
# Four executions: two impact cases x accepted/candidate x one repetition.
node evaluation/harness/src/cli.ts local-diagnostic \
  --suite suites/release.json \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --target-metric retrievalBytes \
  --budget-ms 1800000

# Diagnostic first, then 18 cases x 3 treatments x 3 repetitions = 162.
node evaluation/harness/src/cli.ts local-regression \
  --suite suites/release.json \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --target-metric retrievalBytes
```

Both commands started no model during `--dry-run`; the regression dry run printed
the four diagnostic slots and all 162 regression slots. `local-regression` runs
the diagnostic first and does not start the full suite when the diagnostic is
blocked.

## Targeted diagnostic result

All four declared slots executed exactly once and the execution contract passed:
no dirty checkout, failed process, failed restoration, retry, timeout, unknown
tool, unstructured answer, or CodeIndex error. Both candidate answers were
correct.

| Metric | Accepted median | Candidate median | Candidate / accepted |
| --- | ---: | ---: | ---: |
| `retrievalBytes` | 4,500 | 6,429.5 | 1.429 |
| `toolCalls` | 2.5 | 3 | 1.200 |
| `tokens` | 12,054 | 17,287 | 1.434 |
| `wallTimeMs` | 49,508 | 42,110 | 0.851 |

Per-case results:

| Case | Metric | Accepted | Candidate |
| --- | --- | ---: | ---: |
| `impact-build-generation-references` | retrieval bytes | 1,616 | 1,622 |
| `impact-build-generation-references` | tool calls | 2 | 2 |
| `impact-build-generation-references` | tokens | 13,331 | 21,386 |
| `impact-build-generation-references` | wall time (ms) | 56,663 | 46,718 |
| `impact-schema-version-references` | retrieval bytes | 7,384 | 11,237 |
| `impact-schema-version-references` | tool calls | 3 | 4 |
| `impact-schema-version-references` | tokens | 10,777 | 13,188 |
| `impact-schema-version-references` | wall time (ms) | 42,353 | 37,502 |

The candidate was correct and faster, but the predeclared target metric did not
improve and the candidate regressed retrieval bytes, tool calls, and tokens on
`impact-schema-version-references`. The diagnostic is therefore **blocked**. The
full 162-execution regression was not started, which is the required gate
behaviour rather than an interruption: a cheaper failed stage blocks every more
expensive stage.

## Automation verification

The completed diagnostic record is retained at
`evaluation/results/codeindex-release-dee14e427369674f/targeted-diagnostic.json`
(result directories are ignored by Git). The record carries
`claimClass: "local-model-scoped"`, the four retained executions, per-case and
overall metric deltas, and every blocking finding.

The full stage is verified without a model by:

- the `local-regression --dry-run` plan above, which prints exactly 162 slots;
- `evaluation/harness/src/localEvaluation.test.ts`, which covers the four-slot
  gate, the correct-answer and target-improvement requirements, observed metric
  regressions, class-stratified trends, and the rejection of hosted claim
  authority;
- `pnpm eval:typecheck`, `pnpm eval:test`, and the standard `pnpm verify` gate.

A completed 162-execution record is written to
`results/<campaign>/local-regression.json` only after a passing diagnostic. This
commit does not claim one: the current candidate artifact did not pass the
diagnostic, and no threshold, case, repetition, or target metric was changed
after seeing the result.

## Claim boundary

This is local-model-scoped evidence only. It applies to the pinned model,
quantization, runtime, subject revision, artifacts, environment, and reference
machine above. It is not hosted release evidence, it cannot satisfy a release
gate, and a hosted result cannot override it.
