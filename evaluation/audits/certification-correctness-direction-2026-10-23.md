# Certification correctness-direction erratum

Date: 2026-10-23

Design: `impact-certification-v1`
(`5b3ab83fc4c006a4371c2e4ff77ef3f0e5d8c0d0e2e1a1f236f6aa4429da03f7`)

## Observation

Campaign run 6 completed every planned execution:

- primary: 240/240 valid, exact metering, request-1 surface exact;
- holdout: 56/56 valid;
- cost: `0.612` candidate/no-index, one-sided upper `0.686`;
- false absence: 0;
- correctness: candidate success `1.000`, no-index success `0.950`.

The record nevertheless returned `not-release` because the correctness gate
reported `paired difference 0.0500; one-sided upper 0.1500; margin 0.02`.

Per-case success rates show the candidate was never worse:

| Case | no-index | candidate |
|---|---:|---:|
| impact-build-generation-references | 20/20 | 20/20 |
| impact-hash-content-references | 20/20 | 20/20 |
| impact-bounded-paged-result-references | 20/20 | 20/20 |
| impact-schema-version-references | 20/20 | 20/20 |
| impact-config-load-references | 20/20 | 20/20 |
| impact-codeindex-error-references | 14/20 | 20/20 |

## Defect

The paired difference was computed as `candidate - baseline`, but the frozen
contract defines a non-inferiority upper bound: candidate **degradation**
(`baseline - candidate`) must remain below `0.02`. The implementation took the
95th percentile of the improvement direction and compared it with the positive
margin. A candidate that is better on every case can therefore fail, because its
improvement upper bound is positive.

This is an implementation-direction defect. It does not change the frozen
margin, confidence, metric, population, or design digest.

## Correction

The statistic is now the candidate degradation:

- paired difference: `baseline - candidate`;
- one-sided 95% upper bound: the 95th percentile of the paired degradation;
- gate: upper bound `< 0.02` and false absence `0`.

Two regression tests pin the direction: a better candidate passes, and a worse
candidate with an upper bound above the margin fails.

With the stored run-6 executions, the corrected statistic is:

- paired degradation: `-0.05`;
- one-sided upper bound: `0.0`;
- margin: `0.02`;
- false absence: `0`.

## Evidence handling

The correction re-analyzes the same 240 primary and 56 holdout executions. No
model call, prompt, sample, artifact, subject, suite, or threshold changes. The
run-6 `not-release` record and logs remain preserved under
`audits/run-6/`; the final record is regenerated from the same stored evidence.
