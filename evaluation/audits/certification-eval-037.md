# EVAL-037 final cost-valid frontier certification

**Recorded:** 2026-10-23

**Issues:** #65, #58

**Design:** `impact-certification-v1`
(`5b3ab83fc4c006a4371c2e4ff77ef3f0e5d8c0d0e2e1a1f236f6aa4429da03f7`)

**Contract:** `evaluation-validity-v2@2`
(`179bb5df1bc96ee86c54da20f26034a59fe50671dfc9912d805ed4588204a22f`)

**Decision:** **RELEASE** — release authority `true`.

**Sanitized record:**
[`reports/certification-eval-037.json`](../reports/certification-eval-037.json),
SHA-256 `7d5dea9b07efbfa78f7321f2e5cd9e97f07a253699a10d6af2151b85f6bb9023`.

## Scope and pinned configuration

The claim is scoped to the impact-class population of `codeindex-release` plus a
descriptive, disjoint holdout block. It authorizes only the exact artifact,
subject, model, runtime, exposure, corpus, and tariff below.

| Fact | Value |
| --- | --- |
| Candidate artifact | `codeindex-mcp-candidate@ac846e44cf7c527f9d361ff7ca266e5e2bbdae4d2dd80f9c1e111ac124d4e205` |
| Accepted artifact | `codeindex-mcp-accepted@aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0` |
| Subject revision | `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516` |
| Subject manifest | `70403067fd91080b9949b26f3a68d632898586b019d53e1ee4291641e0bbb907` |
| Model | `deepseek/deepseek-flash` |
| OpenCode runtime | `2.1.3` |
| Generation settings | Provider defaults at the pinned runtime |
| Exposure | `direct-mcp`; Code Mode `absent` |
| Tariff | `deepseek-flash-2026-10-23`, retrieved `2026-10-23T00:00:00.000Z` |
| Claim class | `hosted-model-scoped` |

The accepted artifact was exercised only by the model-free route gate. The
sampled arms were `candidate` against `no-index`, as frozen before execution.

## Model-free route gate

The route report covered both staged artifacts, all 18 frozen cases, and four
contract probes per treatment.

| Fact | Value |
| --- | --- |
| Route report digest | `d843ba1d84bbb04e0653ca67effeac7b335ee57803b2051f8e08d119aeadc87c` |
| Route plan hash | `96dee1cb3fd17fcfa66ec0ac6917bffda737119fe019f10570bd66f6c85547e4` |
| Suite | `codeindex-release` v1, hash `073378fe3b9dc71710797a4a31a249d36363802f4347f87b73ff4fe6ae47f110` |
| Gates | `G-E1a`, `G-E1b`, `G-E1c` passed |
| Contract probes | 4 accepted, 4 candidate, all passed |

## Execution validity

| Block | Planned | Valid | Invalid | Exact metering | Request-1 exact |
| --- | ---: | ---: | ---: | ---: | ---: |
| Primary | 240 | 240 | 0 | 240 | 240 |
| Holdout | 56 | 56 | 0 | 56 | 56 |
| **Total** | **296** | **296** | **0** | **296** | **296** |

All 296 final executions are valid and exactly metered. Path checks are clean,
unknown-tool runs are zero, restoration failures are zero, and no execution
timed out.

Retries used the predeclared policy and never replaced a valid answer:

| Block | Attempts | Failed attempts | Retried slots | Invalid causes |
| --- | ---: | ---: | ---: | --- |
| Primary | 302 | 62 | 49 | 62 provider-metering failures |
| Holdout | 68 | 12 | 10 | 11 provider-metering failures; 1 late request-1 surface |

Failed attempts are retained and are not admitted as evidence; the scheduled
slot was retried until a valid attempt or the retry bound.

| Block | Campaign | Identity digest |
| --- | --- | --- |
| Primary | `codeindex-release-ee1f2eb36ff97d12` | `93b93d85b19e6e430708c5c351ff05343b9170b0f7b83f545a9db033e5033297` |
| Holdout | `codeindex-holdout-782c81e973585699` | `8d7bbdf07323bdb855676e63621694b8c2a0996bac8a452acd64097ea0abb1c8` |

## Primary verdict

Every frozen primary gate passed.

| Gate | Result | Observed |
| --- | --- | --- |
| Total task cost ratio and upper bound | PASS | `0.612`; upper `0.686` (target `<= 0.90`, upper `< 1.00`) |
| Paired correctness non-inferiority | PASS | degradation `-0.050`; upper `0.000`; margin `0.02` |
| False absence | PASS | 0 |
| Latency ceiling | PASS | 0 timeouts; max 27,121 ms; ceiling 180,000 ms |
| Exact provider vector | PASS | 240/240 |
| Complete output families | PASS | index, search, read, list, write, execute, task, other |

### Primary economics

| Treatment | Executions | Mean task cost | Total task cost | Correctness | Agent requests | Other requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `no-index` | 120 | $0.00102278 | $0.12273415 | 95.0% (114/120) | 300 | 120 |
| `candidate` | 120 | $0.00062628 | $0.07515407 | 100.0% (120/120) | 387 | 120 |

- Total user-visible task cost: **$0.197888220**.
- Agent-only cost: **$0.190950708**.
- Cost ratio: **0.6123**; one-sided 95% upper **0.6862**; two-sided interval
  **0.5438–0.7050**.
- Agent-only sensitivity: ratio **0.6008**, upper **0.6763**.
- Paired correctness degradation: **−0.0500**; upper **0.0000**; margin
  **0.02**; false absence **0**.
- All-tool output bytes: candidate mean **3,575.3**, no-index mean
  **10,588.1**; ratio **0.3377**.
- Tokens: no-index **4,557,432**; candidate **6,379,424**.
- Candidate used the index on **120/120** executions, with **105** authoritative
  results, **84** authoritative stops, **27** fallbacks after an authoritative
  result, and **36** runs with an ordinary fallback.

Candidate total tokens exceed no-index, while total task cost is lower. The
provider tariff prices cache reads far below uncached input and output, so the
cost result must be read with the token components, not as a token reduction.

### Primary per-case results

| Case | Cost ratio | No-index correctness | Candidate correctness |
| --- | ---: | ---: | ---: |
| `impact-build-generation-references` | 0.788 | 20/20 | 20/20 |
| `impact-hash-content-references` | 0.673 | 20/20 | 20/20 |
| `impact-bounded-paged-result-references` | 0.690 | 20/20 | 20/20 |
| `impact-schema-version-references` | 0.464 | 20/20 | 20/20 |
| `impact-config-load-references` | 0.656 | 20/20 | 20/20 |
| `impact-codeindex-error-references` | 0.559 | 14/20 | 20/20 |

The fixed-suite estimate and the paired-case-uniform case-generalization
estimate are both `0.6123` with upper `0.6862`; the weights are equal.
Correctness improved on the only case where no-index failed.

## Holdout verdict

The holdout block is descriptive. It does not enlarge the release population
and its cost result is not a release gate.

| Fact | Value |
| --- | --- |
| Executions | 56/56 valid, exact metering, request-1 exact |
| Cost ratio | **1.119**; one-sided upper **1.707**; two-sided interval **0.569–1.757** |
| Total task cost | **$0.021901932** |
| Agent-only cost | **$0.020196672**; ratio **1.132**, upper **1.769** |
| Correctness | 75% / 75%; degradation `0.000`, upper `0.000`; false absence 0 |
| Output bytes ratio | **0.775** |
| Tokens | no-index **835,515**; candidate **1,264,809** |
| Latency | 0 timeouts; max 12,355 ms |

`holdout-baseline-payload` failed for both treatments (0/7 each); the other
three holdout cases passed for both. The holdout therefore neither confirms the
primary cost reduction nor supplies a generalization claim. Case cost ratios
ranged from `0.513` to `1.901`.

Combined metered evidence across both blocks: **296** executions,
**$0.219790152** total user-visible task cost, and **13,037,180** tokens.

## Record correction

The first complete campaign record from the same stored executions returned
`not-release` because the correctness gate computed `candidate - baseline` and
compared its **upper** bound with the positive margin. The frozen contract
requires the **upper bound on candidate degradation** (`baseline - candidate`)
below `0.02`.

The direction was corrected before publication. The corrected analysis
produced degradation `-0.050` and upper `0.000`. No execution, sample, prompt,
artifact, subject, suite, weight, threshold, or design digest changed, and no
model call was made during re-analysis. The prior `not-release` record and its
logs remain preserved under `audits/run-6/` in the campaign state root. The
defect and evidence handling are recorded in
[`certification-correctness-direction-2026-10-23.md`](./certification-correctness-direction-2026-10-23.md).

Earlier campaign attempts remain invalid and are not evidence:

- The interrupted campaign is recorded in
  [`certification-interruption-eval-037.md`](./certification-interruption-eval-037.md).
- Run-1 invalidation and the seven quarantined request-1 slots are recorded in
  [`certification-run1-invalidation-2026-10-23.md`](./certification-run1-invalidation-2026-10-23.md).

E3 remains historical `NOT PASSED` evidence under its original
`retrievalBytes` contract and is not used here.

## Limitations

- The primary sample is underpowered at the frozen design alternative:
  simulated power `0.5225` for `0.8`. A wide interval is not evidence of no
  effect.
- The claim is scoped to the exact hosted model, adapter, corpus, artifact,
  exposure, and runtime pinned above.
- The primary population is the impact-class subset of `codeindex-release`;
  the holdout is descriptive and does not enlarge that population.
- Direct native MCP is selected. This record makes no Code Mode or
  exposure-overhead claim.
- Fixed-suite inference and paired-case-uniform case generalization carry
  different authority and are reported separately.
- Provider cost is static-tariff arithmetic over retained provider components,
  not invoice-time cost.

## Acceptance mapping

| Criterion | Status |
| --- | --- |
| Every planned execution valid or invalidated with a closed cause | Met: 296/296 valid |
| No incomplete metering, late surface, missing corpus, path contamination, or unknown tools in final evidence | Met: 296/296 exact and surface-exact; zero contamination |
| Cost ratio within target and upper bound excludes parity | Met: `0.612`, upper `0.686` |
| Correctness non-inferiority and zero false absence | Met: degradation `-0.050`, upper `0.000`; 0 false absence |
| No post-result threshold, weight, case, tariff, or valid-execution change | Met: design digest unchanged |
| Claim remains model-, adapter-, corpus-, and exposure-scoped | Met and documented above |
| One explicit decision for the exact configuration | Met: **RELEASE** for `ac846e44…` under the pinned configuration |
