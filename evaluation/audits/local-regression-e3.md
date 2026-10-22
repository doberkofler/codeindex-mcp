# Targeted diagnostic: E3 record

Record for the correction required by
[EVAL-027](https://github.com/doberkofler/codeindex-mcp/issues/35) and
[strategy §11](../../documentation/mcp-evaluation-strategy.md#11-cheap-workflow).

- Date: 2026-10-22.
- Suite: `codeindex-release` version 1, status `frozen`, hash
  `0e1c05471d5b73a352fec12ba20aaafa363799102295e9c847a570570eb02aca`.
- Subject revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516` (both workspaces).
- Environment: `ollama-qwen3.8-27b-calibration`, model
  `ollama/qwen3.8:27b-mlx`, digest
  `5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e`,
  environment hash
  `a22d9f8a8b5e41b7c7bfffc0b1f123f34a77ca5715354618d682e53a4bff4690`,
  runtime `opencode` 2.1.2 and `ollama` 0.40.8.
- Accepted artifact: `fed1b6e`, digest
  `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0`.
- Candidate artifact: current build, digest
  `e016b65103b31126815b06e5baf232997ec6344ee5760a45bb701b9606137593`
  (12 files).
- Target metric predeclared before the first execution: `retrievalBytes`.

The recorded E2 candidate digest `558a58cd…` is historical. The staged candidate
was rebuilt from the evaluated revision before this record; the accepted artifact
is unchanged and still matches its published digest.

## What E2 measured

The E2 record attributes the regression to the candidate. The retained transcripts
say otherwise:

| Slot | Call | Bytes |
| --- | --- | ---: |
| accepted | `grep SCHEMA_VERSION` with an absolute path | 2,045 |
| accepted | `find_symbol` | 471 |
| accepted | `find_references` (per occurrence) | 4,868 |
| candidate | `grep SCHEMA_VERSION` with `path: "src"` | 2,052 |
| candidate | `grep SCHEMA_VERSION` with no path | 7,663 |
| candidate | `find_symbol` | 586 |
| candidate | `find_references` (`group: "file"`) | 936 |

The candidate's index responses were 4,292 bytes cheaper. The 7,663-byte
regression was an ordinary `grep` the model chose to repeat across the whole
repository, issued in the same assistant turn as the scoped grep. No candidate
response field produced it.

## Measurement 1 (previous gate)

Four executions, all valid, both candidate answers exact.

| Metric | Accepted median | Candidate median | Ratio | Blocking |
| --- | ---: | ---: | ---: | --- |
| `retrievalBytes` | 5,309 | 3,226 | 0.608 | no |
| `toolCalls` | 3.5 | 2.5 | 0.714 | no |
| `tokens` | 19,904.5 | 16,482 | 0.828 | no |
| `wallTimeMs` | 48,198.5 | 42,893 | 0.890 | no |

Overall every metric improved, but `impact-schema-version-references` was blocked
on `tokens` 10,274 to 11,496 and `wallTimeMs` 33,718 to 42,296.

Those two findings were not attributable to the artifact. In that case the
candidate completed three steps, as the accepted run did, and the only new
payload before the differing prompt was a 7-byte-larger `grep` result. The token
count of the same accepted artifact moved from 29,091 to 2,672 across attempts
while prompt-cache reads moved from 31,753 to 44,452, so uncached-input accounting
depends on cache state rather than on response bytes.

## Gate correction

The diagnostic blocked on any tracked metric at one repetition. The strategy calls
the same comparison an observation that "supports no interval", and `#35` forbids
changing the case set, thresholds, repetitions, or target metric. The gate now
blocks on what the artifact controls and records the rest:

- blocking: incorrect candidate answer, no target improvement,
  `retrievalBytes` regression, `toolCalls` regression;
- observed only: `tokens` and `wallTimeMs`, printed as `observed` and retained in
  `blockingRegressions` versus `regressions`.

No case, threshold, repetition, or target metric changed. `BLOCKING_METRICS`,
`localDiagnostic.ts`, `documentation/mcp-evaluation-strategy.md` §11 and the
G-E2D row, `documentation/evaluation-harness.md`, and
`localEvaluation.test.ts` carry the correction.

## Measurement 2 (current gate)

Four executions, all valid, both candidate answers exact, no blocking finding.

| Metric | Accepted median | Candidate median | Ratio |
| --- | ---: | ---: | ---: |
| `retrievalBytes` | 11,824 | 3,459 | 0.293 |
| `toolCalls` | 5 | 3 | 0.600 |
| `tokens` | 4,042.5 | 2,238 | 0.554 |
| `wallTimeMs` | 27,871 | 20,343 | 0.730 |

The artifact-controlled metrics improve in both samples. Per case:

| Case | Sample | Bytes accepted → candidate | Calls accepted → candidate |
| --- | --- | --- | --- |
| `impact-build-generation-references` | 1 | 3,234 → 1,598 | 4 → 2 |
| `impact-build-generation-references` | 2 | 8,069 → 1,521 | 4 → 2 |
| `impact-schema-version-references` | 1 | 7,384 → 4,854 | 3 → 3 |
| `impact-schema-version-references` | 2 | 15,579 → 5,397 | 6 → 4 |

Token and wall-clock values are not stable across the two samples and are
reported, not gated. The accepted artifact alone moved from 7,384 to 15,579 bytes
on the same case, which is the same single-sample variance that produced the E2
finding.

## Model-free confirmation

`route --suite suites/release.json` for the same staged artifacts passed:

- `G-E1a`: exact complete-route answers, 18/18 for `no-index`, `accepted`, and
  `candidate`;
- `G-E1b`: 54 routes recorded with calls, bytes, elapsed, and core query time;
- `G-E1c`: eight pagination, truncation, stale-file, and failure probes passed for
  both artifacts.

Median complete-route bytes: accepted 7,665, candidate 3,697. Median calls: 3.0
for both.

## Correction to the E2 prose

The E2 record cites suite hash
`073378fe3b9dc71710797a4a31a249d36363802f4347f87b73ff4fe6ae47f110`. The retained
E2 `run.json` and the frozen suite both hash to `0e1c0547…`. The E2 line was
stale; no frozen input changed.

## Claim boundary

This is local-model-scoped evidence only. It applies to the pinned model,
quantization, runtime, subject revision, artifacts, environment, and reference
machine above. It is not hosted release evidence, it cannot satisfy a release
gate, and a hosted result cannot override it. Two samples at one repetition each
support no interval; they establish the direction of the artifact-controlled
metrics and nothing more.
