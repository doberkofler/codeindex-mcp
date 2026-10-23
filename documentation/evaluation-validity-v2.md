# Evaluation validity v2

Date: 2026-10-23

Status: accepted remediation plan. This document governs new hosted evaluation
until its requirements are incorporated into the harness and evaluation
strategy. It does not re-grade historical campaigns.

Tracking milestone:
[`Evaluation validity v2 — cost and treatment integrity`](https://github.com/doberkofler/codeindex-mcp/milestone/4),
master [#58](https://github.com/doberkofler/codeindex-mcp/issues/58).

## Decision objective

Determine whether CodeIndex reduces total frontier-model task cost while
correctness remains within a frozen paired non-inferiority margin. Latency is a
secondary operational constraint, not the optimization target.

E3 remains historical `NOT PASSED` evidence under its original
`retrievalBytes` contract. Its total token and cost interpretation is withdrawn;
see the [E3 erratum](../evaluation/audits/hosted-release-e3-erratum.md).

No interface redesign or new full hosted campaign is permitted until metering,
request-1 availability, corpus indexing, workspace isolation, and statistical
validity pass the gates below.

## Required evidence order

### V1. Complete request-level metering

Track [#59](https://github.com/doberkofler/codeindex-mcp/issues/59).

- Capture every provider request caused by one user-visible task through a
  provider boundary independent of event-stream ordering.
- Classify at least agent, title, and compaction requests; retain request
  ordinal, timestamp, actual provider/model, and offered tool names.
- Preserve provider-reported non-cached input, cache read, each cache-write tier,
  visible output, and reasoning as separate components.
- Reconcile every started request with exactly one completed usage record or one
  closed failure cause.
- Report total task cost as primary and agent-only cost as sensitivity evidence.
- Never infer cache behavior or missing usage from neighboring requests, bytes,
  or a local model of provider behavior.

### V2. Request-1 treatment integrity

Track [#60](https://github.com/doberkofler/codeindex-mcp/issues/60).

- Await actual MCP readiness before admitting the task prompt.
- Assert the exact declared tool set on agent request 1 for every treatment.
- Reject late, missing, duplicate, or unknown tools before hosted-model spend.
- Pass 20 consecutive model-free cold starts per treatment.

The request-1 assertion inspects the request directly. An eventual union of tool
lists or the first selected tool does not establish availability.

### V3. Corpus and workspace validity

Track [#61](https://github.com/doberkofler/codeindex-mcp/issues/61).

- Configure every project needed by the frozen cases, including the root
  `tsconfig.json` and
  `evaluation/fixtures/controlled-typescript/tsconfig.json`.
- Probe known symbols and paths in every project before model calls.
- Stage workspaces, artifacts, databases, and client state outside the primary
  checkout hierarchy.
- Reject provider requests that disclose the primary-checkout absolute path.
- Record every denied external-path attempt; never retry until a favorable clean
  trajectory appears.

### V4. Economic and statistical contract

Track [#62](https://github.com/doberkofler/codeindex-mcp/issues/62).

Status: **frozen** as `evaluation-validity-v2` version 2 on 2026-10-23. The
machine-readable contract is
[`../evaluation/contracts/evaluation-validity-v2.json`](../evaluation/contracts/evaluation-validity-v2.json)
and the evidence is
[`../evaluation/audits/economic-contract-eval-034.md`](../evaluation/audits/economic-contract-eval-034.md).

Frozen before A/B sampling:

- the suite population and class-balanced case weights;
- provider, model, runtime, generation settings, and exposure mode;
- official tariff snapshot and timestamp;
- primary cost target and confidence method;
- paired correctness non-inferiority margin and zero-tolerance false-absence
  rule;
- timeout ceiling, execution budget, invalidation policy, and sample size.

The primary fixed-suite estimand is the ratio of preweighted mean total
user-visible task cost, candidate/no-index. The economic gate is a ratio at most
`0.90` with a one-sided 95% upper bound below `1.00`. Any change to a threshold,
weight, tariff, model, exposure mode, or budget changes the contract digest and
therefore the campaign identity.

Include every valid execution regardless of answer correctness. Keep correctness,
cost, reliability, and latency separate. Report fixed-suite inference separately
from any case-population generalization interval.

Economic claims use provider-reported components and the frozen official tariff.
Tariff-sensitivity results use the same retained vectors and are labelled as
sensitivity analysis, not invoice-time cost. Cached input, non-cached input,
cache writes, output, and reasoning must not be collapsed into an undifferentiated
token count for the primary claim.

### V5. Deterministic validity and disjoint A/A

Track [#63](https://github.com/doberkofler/codeindex-mcp/issues/63).

1. Pass V1-V4 without hosted-model spend where possible.
2. Run a small hosted smoke only to prove complete metering, request-1 surface,
   semantic fixture hits, and clean workspace behavior.
3. Run two identical no-index arms on disjoint calibration slots.
4. Estimate paired variance and failure behavior.
5. Determine later sample size by simulation under the frozen estimand, effect,
   power, margin, and clustering structure.

The smoke and A/A calibration are validity evidence, not candidate efficacy
evidence.

### V6. Budgeted A/B development and breadth

Track [#64](https://github.com/doberkofler/codeindex-mcp/issues/64).

- Compare no-index and the unchanged candidate using the corrected harness.
- Inspect request-1 availability, index contribution, authoritative stop
  behavior, fallback, and complete provider-cost trajectories.
- Redesign the interface only if corrected trajectories demonstrate an interface
  defect.
- Add pinned holdout cases selected by ambiguity, semantic relationships, result
  cardinality, and observed baseline retrieval cost—not repository size alone.
- Resolve direct MCP versus Code Mode exposure before certification.

### V7. Final certification

Track [#65](https://github.com/doberkofler/codeindex-mcp/issues/65).

Run the final frontier campaign once after all identities, thresholds, weights,
budgets, and sample sizes are frozen. Do not reuse development or historical E3
executions. Publish one model-, adapter-, corpus-, artifact-, and exposure-scoped
release decision.

## Invalidation and stop rules

A slot cannot support the affected claim when any of these conditions holds:

- a provider request lacks required usage or classification;
- the declared surface is absent from agent request 1;
- a case's target project or source is absent from the published index;
- the primary checkout path reaches a provider request or an external-path
  denial contaminates the trajectory;
- the treatment, model, tariff, suite, weights, or frozen statistical contract
  differs from the campaign identity.

Retain the record and closed cause. Correct shared causes before resampling every
affected slot. Never discard a valid inconvenient result or weaken a gate after
observing treatment outcomes.

## Service-request dependency order

1. [#59](https://github.com/doberkofler/codeindex-mcp/issues/59) metering.
2. [#60](https://github.com/doberkofler/codeindex-mcp/issues/60) request-1 readiness,
   [#61](https://github.com/doberkofler/codeindex-mcp/issues/61) corpus/isolation,
   and [#62](https://github.com/doberkofler/codeindex-mcp/issues/62) metrics.
3. [#63](https://github.com/doberkofler/codeindex-mcp/issues/63) deterministic
   validity and A/A calibration.
4. [#64](https://github.com/doberkofler/codeindex-mcp/issues/64) A/B development
   and breadth validation.
5. [#65](https://github.com/doberkofler/codeindex-mcp/issues/65) final
   certification.
