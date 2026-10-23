# Validity and A/A calibration: EVAL-035 evidence

Date: 2026-10-23

Scope: implementation and execution evidence for
[EVAL-035 (#63)](https://github.com/doberkofler/codeindex-mcp/issues/63), under
the [evaluation validity v2](../documentation/evaluation-validity-v2.md)
contract. This is hosted validity evidence only. It makes no candidate efficacy,
interface, invoice-time cost, or release-authority claim.

## What was built

- `evaluation/harness/src/executionMeter.ts` starts the loopback provider meter
  for every metered execution, injects the private provider configuration, and
  reconciles the complete task vector after the private server closes. A missing,
  failed, or incomplete request marks the attempt `metering-incomplete`.
- `evaluation/harness/src/aaPlan.ts` builds a deterministic randomized A/A plan.
  Both arms are the same `no-index` treatment. Every pair independently assigns
  its two repetitions to labels A and B and independently randomizes execution
  order, so neither a fixed label nor a fixed position is built into the design.
- `evaluation/harness/src/aaAnalysis.ts` retains missing and invalid executions
  with closed causes, estimates paired label variance, title and cache
  diagnostics, treatment-label invariance, and the final sample size.
- `evaluation/harness/src/validityGates.ts` composes the zero-spend contract,
  metering, request-1 surface, corpus, and path-isolation gates and labels the
  hosted smoke as validity evidence only.
- The `validity` command runs the deterministic gates first, then one hosted
  smoke, then the disjoint A/A calibration. It refuses hosted spend when a gate
  fails.

## Predeclared A/A criteria

The A/A equivalence criterion is the **absolute point ratio** `B/A` within
`[1/1.10, 1.10]`, tied to the frozen 10% economic effect. The paired bootstrap
interval is retained descriptively; it is not used to turn a small A/A into an
underpowered significance test. A/A passes only when every planned pair is
retained, valid, and completely metered.

The final sample-size design uses the observed paired variance, the frozen
one-sided 95% confidence and 80% power, the frozen 18-case suite, and a
predeclared design alternative of `0.85` (five percentage points below the
frozen `0.90` target). Using `0.90` itself would make the point-target condition
succeed only half the time even with unlimited repetitions. The between-case
variance used by the simulation is corrected for within-case sampling noise by
the method-of-moments estimate.

## Command

Run from the repository root with an external state root and a provider key in
an environment variable. The key is forwarded by the meter and is never retained:

```bash
EVALUATION_STATE_ROOT=<external-state-root> DEEPSEEK_API_KEY=<key> \
  node evaluation/harness/src/cli.ts validity \
  --suite suites/calibration.json \
  --hosted-reference references/deepseek-flash-validity-2026-10-23.json \
  --provider-auth-env DEEPSEEK_API_KEY \
  --aa-repetitions 4
```

The recorded run used six frozen calibration cases and four A/B pairs per case:
48 A/A executions plus one smoke execution. `EVALUATION_STATE_ROOT` was outside
the primary checkout.

## Deterministic gates

All gates passed before the first hosted call. The deterministic phase is
zero-spend.

| Gate | Evidence |
| --- | --- |
| Contract | `evaluation-validity-v2`, digest `179bb5df1bc96ee86c54da20f26034a59fe50671dfc9912d805ed4588204a22f` |
| Metering | One synthetic request settled exactly once with an exact economic claim |
| Request-1 surface | `no-index` 20/20 cold starts: `edit`, `glob`, `grep`, `read`, `shell`, `write`; `accepted` 20/20: the seven native `codeindex_*` tools plus the same ordinary tools |
| Corpus | Published index ready; all three configured projects (`root`, `controlled-typescript`, `test`); 341 files; zero missing or unindexed expected paths; selected semantic probe `createProfile` passed |
| Path isolation | State root and every mutable execution path stayed outside the primary checkout; zero denied external-path attempts and zero primary-path disclosures in provider requests |

The deterministic test suite also ran green: `pnpm run eval:typecheck`,
`pnpm run eval:test` (273 tests), `pnpm run lint`, `pnpm run knip`, and
`pnpm run format:check`.

## Hosted smoke

One `accepted` execution on `semantic-renamed-reexport`.

| Observation | Result |
| --- | --- |
| Executions | 1, valid |
| Provider metering | exact; every started request settled once |
| Request kinds | 5 `agent`, 1 `other`, 0 `title`, 0 `compaction` |
| Request-1 surface | passed before the prompt was admitted |
| Semantic fixture | indexed and probed before the call |
| Paths | clean |
| Claim | `validity-only`; no efficacy claim |

## A/A calibration

Two identical `no-index` arms over six calibration cases, four randomized pairs
per case, 48 planned executions. All 48 final executions were valid and exactly
metered. No execution was missing, contaminated, or discarded. The run recorded
65 attempts: 13 executions retried after a closed transient metering failure, and
17 invalid attempts were retained with cause `incomplete-metering` before the
accepted attempt. The final failure rate was zero.

| Fact | Value |
| --- | --- |
| Planned / stored / valid | 48 / 48 / 48 |
| Missing / invalid final executions | 0 / 0 |
| Paired label ratio `B/A` | 1.032 |
| Two-sided descriptive interval | `[0.689, 1.342]` |
| Within-case variance | 0.342 |
| Observed between-case variance | 0.122 |
| Corrected between-case variance | 0.0367 |
| Intraclass correlation | 0.263 |
| Design effect | 1.790 |
| Correctness difference | 0; one-sided upper 0; false absence 0 |
| Arm A title / cache | 0 title requests; 92.6% cache-read share |
| Arm B title / cache | 0 title requests; 91.6% cache-read share |
| Treatment labels identical | yes; one definition hash and one surface digest |

The calibration cases generated no title or compaction requests. One `other`
request was metered in the smoke run; the A/A arms used only agent requests.
Cache reads, non-cached input, and cache writes remained separate; no cache state
was inferred.

## Chosen sample size

Using the observed within-case variance `0.342`, corrected between-case variance
`0.0367`, 18 final cases, the predeclared `0.85` design alternative, 80% power,
one-sided 95% confidence, and 2,000 simulations, the smallest qualifying sample
is **7 paired repetitions**. That is 18 cases × 3 treatments × 7 repetitions =
**378 executions**, with simulated power `0.8255`. The result is neither the
historical five repetitions nor an assumed 540 runs. It exceeds the frozen
270-execution budget, so the budget must be revised before a final campaign; this
record does not silently adopt the larger budget.

## Limitations and claim boundary

- The A/A point ratio is within the 10% criterion, but the descriptive interval
  is wider than 10%. The final sample size is what addresses interval precision;
  the A/A is not promoted to an efficacy test.
- The validity executions used OpenCode 2.1.3 while the final-certification
  reference still pins 2.1.2. This is a validity-only client-runtime deviation;
  repin the runtime before #64/#65.
- Sanitized machine-readable evidence is in
  [`../reports/validity-aa-eval-035.json`](../reports/validity-aa-eval-035.json).
  Raw executions remain under the external state root and are not committed.
- No candidate, accepted-versus-candidate, or release decision is made here.
