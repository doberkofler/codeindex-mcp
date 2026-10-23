# Budgeted A/B development pilot: EVAL-036 evidence

Date: 2026-10-23

Scope: implementation and execution evidence for
[EVAL-036 (#64)](https://github.com/doberkofler/codeindex-mcp/issues/64), under
the [evaluation validity v2](../documentation/evaluation-validity-v2.md)
contract. This is development evidence. It does not authorize a release, does
not replace final certification, and does not reuse any development execution as
holdout evidence.

## Frozen design

The design was written and digested before the first provider request as
[`../pilots/ab-development-v1.json`](../pilots/ab-development-v1.json), digest
`76a1c8de068b5824a03825967bdc8ac255e86a41bd64251e880a95f074a7093d`.

| Fact | Frozen value |
| --- | --- |
| Contract | `evaluation-validity-v2`, digest `179bb5df1bc96ee86c54da20f26034a59fe50671dfc9912d805ed4588204a22f` |
| Suite | `codeindex-calibration` v2, hash `14d11804cd15ba6348549bdfb1600804c2e85167cb083aaa9edb746331a145b6` |
| Cases | `locate-schema-version`, `impact-build-generation-references`, `impact-schema-version-references`, `semantic-renamed-reexport`, `semantic-interface-implementations`, `impl-default-result-bytes` |
| Weights | Contract weights renormalized to the six selected cases and pinned in the design |
| Treatments | `no-index`, `candidate` |
| Repetitions | 2 paired repetitions per case = 24 executions |
| Budget | 32 executions, 10,800,000 ms wall clock, 5 USD provider spend |
| Model | `deepseek/deepseek-flash`, DeepSeek-V4.1-Flash-1017, OpenCode 2.1.3 |
| Exposure | Direct native MCP, Code Mode absent, selected explicitly before certification |
| Cost target | Candidate/no-index ratio `<= 0.90`, one-sided 95% upper bound below 1.00 |
| Correctness | Paired non-inferiority margin `0.02`, zero-tolerance false absence |

The final sample size from EVAL-035 remains seven paired repetitions (378
executions), above the frozen 270-execution budget. This pilot does not revise
that budget and does not claim certification power.

## Command

```bash
EVALUATION_STATE_ROOT=<external-root> DEEPSEEK_API_KEY=<key> \
  node evaluation/harness/src/cli.ts pilot \
  --suite suites/calibration.json \
  --design pilots/ab-development-v1.json \
  --hosted-reference references/deepseek-flash-validity-2026-10-23.json \
  --provider-auth-env DEEPSEEK_API_KEY
```

The recorded run used an external state root outside the primary checkout.

## Surface and validity repair

Two model-free surface proofs failed before any hosted request; both are retained
as closed causes rather than discarded.

| Attempt | Failure | Closed cause | Action |
| --- | --- | --- | --- |
| 1 | Candidate cold start 4/20 | `incomplete-surface` | 96 orphaned MCP processes from earlier evaluation runs were found and terminated; no hosted call was made |
| 2 | Candidate cold start 13/20 | `incomplete-surface` | OpenCode reported `connected` before its session tool registry was ready; the probe now waits a bounded 1,000 ms after `connected`, then still asserts the exact request-1 surface |
| 3 | Final | none | Candidate and no-index each passed 20/20 cold starts; no hosted call preceded the proof |

The settle interval does not relax the assertion. It only prevents admission of a
prompt before the registry catches up with `connected`; a missing, late,
duplicated, or unknown tool still fails the cold start. The repair is in
`evaluation/harness/src/surfaceProbe.ts`.

Corpus preflight passed before the pilot: three configured projects (`root`,
`controlled-typescript`, `test`), 341 indexed files, zero missing expected paths,
and a clean isolated workspace. All 24 final executions were valid, exactly
metered, path-clean, and restored. The run retained 17 failed provider requests
across 8 retried executions, all with the same closed cause
(`provider metering is invalid: 1 provider request(s) failed`); no final execution
was invalid and no failed attempt was discarded from the record.

## Result

The sanitized record is
[`../reports/ab-development-eval-036.json`](../reports/ab-development-eval-036.json).

| Fact | Observed |
| --- | --- |
| Campaign identity | `codeindex-calibration-e09e68cbe41c577e` |
| Candidate artifact | `codeindex-mcp-candidate`, digest `ac846e44cf7c527f9d361ff7ca266e5e2bbdae4d2dd80f9c1e111ac124d4e205` |
| Planned / stored / valid | 24 / 24 / 24 |
| Final invalid executions | 0 |
| Exact cost vectors | 24 / 24 |
| Preweighted mean cost, no-index | 0.0010096 USD |
| Preweighted mean cost, candidate | 0.0013117 USD |
| Candidate/no-index cost ratio | 1.299 |
| One-sided 95% upper bound | 1.723 |
| Two-sided descriptive interval | `[1.102, 1.785]` |
| Case-generalization mean ratio | 1.362 |
| Correctness | 100% both arms; paired difference 0; upper bound 0 |
| False absence | 0 |
| Latency | maximum 11,653 ms; 0 timeouts; timeout ceiling 180,000 ms |

## Request trajectories

All 24 final executions preserve ordered provider requests, request kinds, offered
tool names, request-1 classification, index contribution, authoritative stop
behavior, ordinary fallback, and complete per-request cost vectors.

| Observation | No-index | Candidate |
| --- | ---: | ---: |
| Agent request 1 exact | 12 / 12 | 12 / 12 |
| Index used | 0 / 12 | 12 / 12 |
| Authoritative index result | 0 / 12 | 9 / 12 |
| Authoritative stop | 0 / 12 | 5 / 12 |
| Fallback after authoritative | 0 | 14 |
| Runs with ordinary fallback after first index call | 0 / 12 | 7 / 12 |
| Exact task cost vectors | 12 / 12 | 12 / 12 |
| Agent requests | 40 | 46 |
| Other requests | 12 | 12 |
| Title / compaction requests | 0 / 0 | 0 / 0 |

No candidate execution lost correctness. The candidate therefore showed an
interface contribution but not a suite-wide cost benefit. The correction is not
an E3 artifact: every classification above comes from a fresh, exactly metered
trajectory written by the corrected harness.

## Class evidence

| Class | Candidate/no-index ratio | One-sided upper | Authoritative stops | Runs with fallback |
| --- | ---: | ---: | ---: | ---: |
| locate | 1.889 | 1.889 | 2 / 2 | 0 / 2 |
| impact | **0.848** | **0.938** | 3 / 4 | 1 / 4 |
| implementation | 1.144 | 1.144 | 0 / 2 | 2 / 2 |
| semantic | 1.798 | 2.346 | 0 / 4 | 4 / 4 |

The impact class met the frozen cost target with an upper bound below 1.00 while
remaining fully correct. The locate, implementation, and semantic classes did
not. Semantic and implementation trajectories in particular consumed extra turns
after non-authoritative or authoritative index results, without a correctness
defect.

## Decision

**Narrow scope.** Do not certify the full six-case mix on this pilot. Restrict any
next candidate claim to impact-class, reference-relationship tasks, where the
candidate produced a 0.848 cost ratio, a 0.938 one-sided upper bound, 3/4
authoritative stops, and no correctness loss.

No interface redesign is authorized by this pilot. The corrected trajectories
show an interface behavior worth a separate targeted diagnostic before any
redesign: semantic and implementation cases produced 0/6 authoritative stops and
6/6 runs with ordinary fallback. That observation is recorded here; it is not
converted into a redesign without a disjoint diagnostic and a new frozen
decision.

## Breadth and holdout

Breadth selection is recorded in
[`../pilots/breadth-selection-v1.json`](../pilots/breadth-selection-v1.json).
Material UI is retained as the larger external corpus by task ambiguity and
measured baseline lexical payload (341 matching lines / 38,166 bytes for
`createTheme`), not by repository size alone. VS Code is rejected because its
baseline payload is higher and its extra scale adds no needed semantic pattern;
TypeScript is rejected because one ambiguous name produces about one megabyte of
baseline output and little module-boundary coverage.

Four holdout cases were pinned after reading the corrected development
trajectories and before any holdout execution:

- `holdout-unique-identifier` — unique exported constant;
- `holdout-ambiguous-name` — exported type mentioned by ten source files;
- `holdout-semantic-relationship` — callers of one pagination helper;
- `holdout-baseline-payload` — common SQLite connection symbol with roughly 100
  baseline grep lines.

They are frozen in suite `codeindex-holdout` v1, hash
`5eb2106b709d1edfcd6a7539179f78dacb8e4e5de51dbc24b24b9ad09a1d8326`, and the
corpus preflight passed for all four. They were not executed. Evidence is
[`../reports/holdout-eval-036.json`](../reports/holdout-eval-036.json). A later
certification campaign must execute them independently; this pilot never reuses
its development observations as certification evidence.

## Exposure

Direct native MCP is selected as the production exposure for the next
certification step, matching the frozen contract (`native-mcp`, Code Mode
absent). A Code Mode arm was not compared because the contract's surface and
request-1 proof are defined for native MCP, and changing exposure would be a new
treatment identity. This is an explicit selection, not a claim that direct MCP
has lower overhead than Code Mode. The paired Code Mode comparison remains a
separate requirement under PROD-004 (#50); its result must be frozen before final
certification.

## Limitations

- Six development cases and two repetitions support a narrow scope decision, not
  a certification verdict. The pilot intervals are wide.
- The impact-class interval is based on two cases and four paired executions per
  arm; it is directional evidence for narrowing, not a release gate.
- The retained 17 failed provider requests were transient upstream failures.
  Final executions were complete and exactly metered; the failed attempts remain
  in the campaign record.
- The final certification budget still requires revision from 270 to at least 378
  executions if the EVAL-035 sample-size decision is retained.
- Holdout cases are pinned and preflighted but unexecuted.

## Claim boundary

Development-pilot evidence only. No release authority, no invoice-time cost
claim, no model-independent claim, no interface redesign, and no substitution
for the final cost-valid certification campaign.
