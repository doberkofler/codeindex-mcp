# Hosted release campaign: E3 record

> **Historical record — interpretation corrected.** The campaign remains
> `NOT PASSED` under its original `retrievalBytes` contract, but it is not valid
> total-token or total-cost evidence. The post-campaign audit found incomplete
> provider-request metering, likely request-1 treatment absence, omitted semantic
> corpus coverage, and workspace-path contamination. Read the
> [E3 erratum](./hosted-release-e3-erratum.md) before using any result below.

Authoritative frontier-model architecture and release record for
[EVAL-028 (#36)](https://github.com/doberkofler/codeindex-mcp/issues/36), run
from scratch under
[strategy §8.1](../../documentation/mcp-evaluation-strategy.md#81-execution-contract-tiers-order-invalidation-retry-and-stop-rules).

- Date: 2026-10-23.
- Campaign: `codeindex-release-dddc689346e6cf2c`.
- Campaign identity:
  `dddc689346e6cf2c91c158e400f1f7db14b8db022ce23ae3844ae7e749d3c1ea`.
- Plan hash:
  `436f43278fa9c72c57dabc049e05ad36f5a2950a17e41206f22cfa0f924fb9b8`.
- Comparison digest:
  `be28d8c9aa3b3984526cc5713262e6eb0007f67672ec82c24c7cab87c76aeae5`.
- Suite: `codeindex-release` version 1, hash
  `073378fe3b9dc71710797a4a31a249d36363802f4347f87b73ff4fe6ae47f110`.
- Subject revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`.
- Target metric, predeclared before any execution: `retrievalBytes`.
- Claim class: `hosted-model-scoped`; release authority: true.

## Hosted reference

| Fact | Value |
| --- | --- |
| Provider | `deepseek` |
| Model ID | `deepseek-flash` |
| Model reference | `deepseek/deepseek-flash` |
| Provider release | `2026-10-17T00:00:00.000Z` |
| Client runtime | OpenCode `2.1.2` |
| Generation settings | Provider defaults at the pinned runtime |
| Reference hash | `e3d86f8914fe9b9d77e9048216acd1535a44cf98b7e69a35edb3a1cf19dae07e` |

The campaign identity, reference hash, and measured OpenCode version were
verified before the first model call. No generation setting was overridden.

## Preconditions

| Stage | Evidence | Result |
| --- | --- | --- |
| Staged artifacts | Accepted `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0`; candidate `e016b65103b31126815b06e5baf232997ec6344ee5760a45bb701b9606137593` | Staged and verified |
| Model-free route | `route-report`, report digest `639bbc724baa31384820e50d3187b538f3d9e0509e7819ead8748f2b2f4e72aa`; plan hash `07033f606eba89c158bc17b9612f62b6e1572273188d04b4e7a50f729bfb4c01` | `G-E1a`, `G-E1b`, and `G-E1c` passed for the same suite, revision, and artifact digests |
| Local qualification | Not read | Neither authorizes nor blocks this campaign |

The model-free report covered all 18 frozen cases and both staged artifact
digests. It is the record that gated the hosted spend; no historical route
report was substituted.

## Execution

The fixed plan executed 18 cases × 3 treatments × 5 paired repetitions, exactly
270 slots:

| Fact | Value |
| --- | ---: |
| Planned slots | 270 |
| Executed slots | 270 |
| Valid slots | 270 |
| Invalid slots | 0 |

All 270 slots were executed from scratch for this campaign identity. No local or
hosted execution from an earlier campaign participates in the comparison. One
first-attempt timeout on `semantic-shadowed-name/candidate/rep-2` was retained
and replayed explicitly with `--resume --retry-timed-out`; the final attempt is
valid. No completed non-timeout answer was rerun.

## Verdict

**Hosted release: NOT PASSED.** Candidate correctness was non-inferior, and the
overall predeclared target improved, but two unchanged Q2 efficiency gates and
all four class-stratified verdicts blocked release.

### Overall treatment summary

| Treatment | Correctness | Median retrieval bytes | Median tool calls | Median tokens | p95 wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| `no-index` | 96.7% | 3,642 | 3.0 | 1,647 | 17.5 s |
| `accepted` | 98.9% | 6,508 | 4.0 | 2,856 | 17.5 s |
| `candidate` | 100.0% | 3,589.5 | 3.0 | 2,342 | 14.8 s |

### Overall candidate-versus-accepted pairing

| Metric | Accepted median | Candidate median | Candidate / accepted | Paired 95% interval |
| --- | ---: | ---: | ---: | ---: |
| `retrievalBytes` (target) | 6,119.5 | 4,172.5 | 0.682 | 0.353–1.398 |
| `toolCalls` | 4.0 | 3.0 | 0.750 | 0.600–1.000 |
| `tokens` | 2,647 | 2,326.5 | 0.879 | 0.556–1.642 |
| `wallTimeMs` | 8,414.5 | 7,911.5 | 0.940 | 0.781–1.102 |

Intervals are deterministic paired-by-case percentile-bootstrap 95% intervals
with 2,000 resamples. The target point estimate improves by 31.8%; the interval
does not exclude a null effect.

### Unchanged Q2 gates

| Gate | Result | Observed |
| --- | --- | --- |
| No case loses correctness against `no-index` | PASS | 0 regressed case(s) |
| Candidate success at least 90% | PASS | 100.0% (n=90) |
| Candidate false absence at most 2% and never above `no-index` | PASS | 0.00% vs 0.00% |
| Median retrieval bytes at least 10% lower than `no-index` | FAIL | 98.6% of `no-index` (n=90) |
| Median tool calls not higher than `no-index` | PASS | +0.0 calls (n=90) |
| Median tokens at most 1.05× `no-index` | FAIL | 142.2% of `no-index` (n=90) |
| p95 wall time at most 1.2× `no-index` | PASS | 84.4% of `no-index` (n=90) |
| No case loses correctness against `accepted` | PASS | 0 regressed case(s) |
| Generic `execute` absent from every execution | PASS | 0 run(s) |
| Every observed tool captured in its treatment surface | PASS | 0 run(s) with unknown tools |

### Class-stratified verdicts

| Class | Cases | Correctness (`no-index` / `accepted` / `candidate`) | Target ratio vs accepted | Paired 95% interval | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| `locate` | 4 | 100% / 100% / 100% | 1.422 | 0.339–2.842 | FAIL |
| `impact` | 6 | 93.3% / 96.7% / 100% | 0.439 | 0.183–2.228 | FAIL |
| `implementation` | 2 | 100% / 100% / 100% | 1.268 | 0.986–1.395 | FAIL |
| `semantic` | 6 | 96.7% / 100% / 100% | 0.351 | 0.113–1.863 | FAIL |

Every class also applies the same Q2 gates against `no-index`. The `impact`
class failed retrieval bytes (107.5%), tool calls (+1.0), and tokens (592.5%);
the `semantic` class failed retrieval bytes (117.7%) and tokens (159.4%). The
`locate` and `implementation` classes passed their class Q2 gates but did not
improve the target metric against `accepted`.

### Blocking findings

- Median retrieval bytes are 98.6% of `no-index`, short of the required 10%
  reduction.
- Median tokens are 142.2% of `no-index`, above the 1.05× ceiling.
- All four class verdicts fail: `locate` and `implementation` do not improve the
  target metric, and `impact` and `semantic` fail at least one class Q2 gate.

## Attribution

> **Superseded by the [E3 erratum](./hosted-release-e3-erratum.md).** The claim
> below that these were not harness defects is retained only as part of the
> original record and must not be cited as the current interpretation.

The failures are model-selection and interface-cost findings, not artifact or
harness defects. Every artifact surface matched its declaration, every slot was
valid, no generic `execute` was called, and no unknown tool appeared.

- The `locate` target regression is dominated by
  `locate-read-symbol-tool` (candidate/accepted retrieval-byte ratio 2.842);
  the other three locate cases are at or below parity.
- The `implementation` target regression is dominated by
  `impl-default-result-bytes` (ratio 1.395); `impl-empty-relative-path` is at
  parity.
- `impact` bytes and tokens are dominated by
  `impact-build-generation-references` (candidate/`no-index` ratios 9.077 and
  18.312) and `impact-hash-content-references`, where the model chose broad
  ordinary searches that returned large payloads. `accepted` and `candidate`
  both used CodeIndex on some repetitions; the excess is in ordinary search
  output.
- `semantic` bytes and tokens are dominated by
  `semantic-interface-implementations` (candidate/`no-index` ratios 3.740 and
  3.288) and `semantic-barrel-chain`.
- The overall token failure is the same uncached input cost: the two CodeIndex
  treatments add native tool schemas and additional bounded calls, and the
  candidate still exceeds `no-index` even though it is below `accepted`.

These observations explain the verdict but do not alter it. The campaign is not
retried for a more favorable sample.

## Acceptance mapping

| Criterion | Status |
| --- | --- |
| All 270 planned slots executed and valid or invalidated with a closed cause | Met: 270 valid, 0 invalid |
| Unchanged Q2 correctness and efficiency gates applied | Met: all ten gates evaluated; two efficiency gates failed |
| Candidate correctness non-inferior to both baselines and target improved | Correctness met; overall target improved (0.682); the release condition is not met because two Q2 gates and all class verdicts failed |
| No historical local or hosted execution reused as a comparison | Met: one fresh 270-slot campaign |
| Campaign identity and reference hash match `deepseek/deepseek-flash` | Met |
| Local evidence not substituted for the frontier result | Met |

## Claim boundary

This page is hosted-model-scoped release evidence for
`deepseek/deepseek-flash` under the pinned reference. It does not reuse the E2
`deepseek-v4-pro` dry-run identity, any historical Q2 execution, or any local
result. Local-model qualification is independent and is not substituted for this
verdict.

The publication decision is **not released**: the candidate improves the
overall target and preserves correctness, but it does not clear the unchanged
Q2 efficiency gates or the class-stratified release gates.
