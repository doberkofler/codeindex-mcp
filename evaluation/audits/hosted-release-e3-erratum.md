# Erratum: hosted release campaign E3

Date: 2026-10-23

This erratum corrects the interpretation of the historical
[`hosted-release-e3.md`](./hosted-release-e3.md) record. It does not rewrite the
campaign, change its predeclared gates, or re-grade its verdict.

## Disposition

- The historical verdict remains **`NOT PASSED`** under the original
  `retrievalBytes` contract.
- E3 is **not valid evidence of total tokens or monetary cost**. The sign and
  magnitude of candidate-versus-no-index total cost are unknown.
- E3 did not fairly test CodeIndex availability from the first agent request or
  semantic retrieval over the complete declared corpus.
- E3 must not authorize an interface redesign, release, or total-cost claim.
- Corrective work is tracked by
  [evaluation validity v2 (#58)](https://github.com/doberkofler/codeindex-mcp/issues/58).

## Audit findings

### Incomplete provider-request metering

The final event streams omit the terminal `step_finish` in 269 of 270 final
executions: 0/90 accepted, 0/90 candidate, and 1/90 no-index streams contain it.
The omitted event carries the final provider request's usage after the last tool
result and answer generation.

OpenCode also starts an asynchronous title-generation provider request. The E3
harness parsed only `step_finish` usage and did not meter title requests. Because
E3 used `OPENCODE_DB=:memory:` and retained no provider-request ledger, the
missing terminal and title usage cannot be recovered.

The recorded cost values are static tariff arithmetic over the incomplete
retained vector. They are neither complete task costs nor invoice-time costs.
Consequently, the E3 token table, token ratios, token gate, and any derived USD
comparison cannot support an economic conclusion.

### Request-1 treatment integrity was not established

First-request prompt-token totals are pairwise identical for all 90
accepted/no-index pairs and all 90 candidate/no-index pairs. Every indexed run
that used CodeIndex first used an ordinary tool; CodeIndex first appeared on a
later step.

Provider request bodies were not retained, so the exact request-1 tool list
cannot be reconstructed. The paired equality, observed trajectories, and
asynchronous MCP startup strongly support that CodeIndex was not offered on the
first agent request. Future evaluation must capture and assert that request
directly; an eventual union of observed tools is insufficient.

### Semantic corpus omission

All six semantic cases target
`evaluation/fixtures/controlled-typescript/src/**`. E3 indexed only the root
`tsconfig.json`, whose include is `src/**/*`; it did not configure the fixture's
own `tsconfig.json`. Those cases therefore measured fallback behavior rather
than CodeIndex semantic retrieval over their target project.

### Workspace-path contamination

The final records contain 74 `external_directory` denials across 36 executions:
17 no-index, 11 accepted, and 8 candidate runs. Sixty-eight denied requests
targeted the primary checkout or a descendant; six escaped relatively with
`../`. The affected runs usually continued, so the denials introduced
treatment-imbalanced trajectory and cost noise rather than simple process
failures.

### Metric defects

- `retrievalBytes` omitted shell/execute output.
- Efficiency aggregates excluded incorrect executions, causing survivor bias.
- Positive-over-zero ratios were represented as zero.
- Token components and cache categories were not sufficient to recover the
  omitted provider requests.

## What remains usable

The following facts remain historical evidence under the original campaign
identity:

- all 270 planned slots were attempted and retained;
- the original `retrievalBytes`-based policy produced `NOT PASSED`;
- recorded answers, tool trajectories, and correctly captured non-economic
  fields may support bounded diagnostics when their contamination is disclosed;
- candidate responses with `guidance.action="stop"` were followed by no grep in
  28/28 observed runs and by an ordinary read in only 2/28 runs.

The final observation argues against changing the response interface before a
valid request-1 A/B pilot demonstrates unnecessary fallback.

## Replacement evidence path

The normative replacement contract is
[`evaluation/contracts/evaluation-validity-v2.json`](../contracts/evaluation-validity-v2.json),
executed through EVAL-031 to EVAL-037 and recorded in
[`certification-eval-037.md`](./certification-eval-037.md). It requires complete
request-level metering, request-1 surface proof, corpus preflight, external
workspace isolation, corrected statistics, disjoint A/A calibration, a budgeted
A/B development pilot, and one final certification campaign.
