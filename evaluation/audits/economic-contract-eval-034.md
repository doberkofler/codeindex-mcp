# Economic and statistical contract: EVAL-034 evidence

Date: 2026-10-23

Scope: implementation evidence for [EVAL-034 (#62)](https://github.com/doberkofler/codeindex-mcp/issues/62).
This freezes the validity-v2 measurement contract. It does not observe treatment
results, re-grade E3, or authorize a hosted campaign.

## Accepted contract

The accepted contract is `evaluation-validity-v2` version `2`, frozen at
`2026-10-23T00:00:00.000Z`.

- Digest: `179bb5df1bc96ee86c54da20f26034a59fe50671dfc9912d805ed4588204a22f`
- Machine-readable record: [`../contracts/evaluation-validity-v2.json`](../contracts/evaluation-validity-v2.json)
- Implementation: `evaluation/harness/src/economicContract.ts`

The digest participates in the campaign identity and every execution identity.
Changing a threshold, case weight, tariff, model, exposure mode, or budget changes
the digest, starts a new campaign identity, and rejects a mixed old/new report.

| Field | Frozen value |
| --- | --- |
| Population | Fixed 18-case `codeindex-release` suite, class-balanced case weights |
| Estimand | Ratio of preweighted mean total user-visible task cost, candidate / no-index |
| Cost target | `<= 0.90` |
| Confidence | Paired case-cluster percentile bootstrap, one-sided 95% upper bound below `1.00` |
| Correctness | Paired success-rate non-inferiority, one-sided 95% upper bound below `0.02` |
| False absence | Zero tolerance |
| Latency | 180,000 ms per-execution timeout ceiling; not an optimization target |
| Model | `deepseek/deepseek-flash`, DeepSeek-V4.1-Flash-1017 |
| Exposure | Native MCP tools, Code Mode absent |
| Budget | 18 cases × 3 treatments × 5 repetitions = 270 executions; 48,600,000 ms wall clock; 25 USD provider spend |
| Output | Every tool-output family, including shell/execute, task, write, and other |
| Case generalization | Separate uniform-case paired bootstrap, descriptive only |

Class-balanced weights are one quarter per class, split equally among that
class's cases. The primary interval resamples whole cases with those frozen
weights. The case-generalization interval uses the same draws with uniform case
weights and is never the primary gate.

## Cost vector

`taskCostVectorOf` prices every provider request caused by one user-visible task
from the retained non-overlapping components:

- non-cached input;
- cache read;
- every provider-named cache-write tier;
- visible output;
- reasoning.

Agent, title, compaction, and every other closed request kind participate in the
task total. Agent-only cost remains separate sensitivity evidence. An unsettled,
failed, or incompletely reported request makes the task total unavailable rather
than silently smaller. Every valid execution, including an incorrect answer,
enters the economic estimate; correctness is evaluated separately.

The primary vector is labelled `total-user-visible-task-cost-not-invoice`.
Alternative tariffs over the same retained vector are labelled
`static-tariff-arithmetic` / `sensitivity-not-invoice-time`. Neither is an
invoice-time cost.

## Tariff snapshot

The frozen snapshot is the official DeepSeek rate card retrieved at
`2026-10-23T00:00:00.000Z`:

- [`../tariffs/deepseek-flash-2026-10-23.json`](../tariffs/deepseek-flash-2026-10-23.json)
- Source: <https://api-docs.deepseek.com/quick_start/pricing>

`deepseek-flash` rates in USD per million tokens:

| Component | Off-peak | Peak |
| --- | ---: | ---: |
| Cache-hit input | 0.003 | 0.006 |
| Cache-miss input | 0.15 | 0.30 |
| Output | 0.60 | 1.20 |

Peak windows are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday,
excluding the listed holiday dates. The snapshot declares no separate cache-write
price; a provider without cache-write tiers therefore has an empty write vector,
not an inferred one.

## Ratio behavior

Every ratio carries an explicit state:

| Treatment | Baseline | State | Value |
| ---: | ---: | --- | --- |
| 0 | 0 | `both-zero` | 1 |
| positive | 0 | `positive-over-zero` | unbounded |
| 0 | positive | `zero-over-positive` | 0 |
| positive | positive | `finite` | treatment / baseline |

Positive over zero is never reported as a favorable zero. A lower-is-better
threshold sees positive infinity; a bootstrap interval that contains such a
draw is marked unbounded instead of silently dropping the draw.

## Sampling by simulation

`finalSampleSizeOf` accepts only paired pilot observations from campaign
identities disjoint from the final campaign. It estimates the per-case paired
log-ratio effect and within-case variance from the pilot, then simulates the
probability that the final fixed-suite estimate meets both the `0.90` point
target and the one-sided upper bound below `1.00`. The smallest repetition count
that reaches the frozen power is selected; failure to reach it within the frozen
maximum records a closed reason instead of weakening the target.

## Deterministic tests

`evaluation/harness/src/economicContract.test.ts` covers:

- the accepted contract digest, tariff snapshot, and machine-readable records;
- contract tampering with a threshold or weight;
- per-request vectors and agent, title, and compaction cost;
- peak, off-peak, and holiday tariff bands;
- separate cache-write tiers and a missing tier rate;
- missing components, failed settlements, and pending requests;
- tariff sensitivity labels and zero ratios;
- incorrect but valid executions included in the cost estimate;
- deterministic paired resampling and the separate case-generalization interval;
- disjoint-pilot sample-size simulation;
- report thresholds bound to the frozen contract and rejection of mixed
  pre-v2/v2 identities;
- every tool-output family, including shell/execute.

The existing report tests continue to verify the historical v1 `retrievalBytes`
contract. The legacy metric remains explicitly narrower and is never used as the
v2 economic claim.

## E3 boundary

E3 remains historical `NOT PASSED` evidence under its original contract. This
change does not rewrite its campaign, results, thresholds, or verdict, and it does
not turn any E3 value into total-cost evidence.
