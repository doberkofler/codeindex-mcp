# Local-model qualification plan: E0 record

Plan and predeclared criteria for the independent 108-slot local-model
qualification. No model was assessed here, so this document issues no
qualification verdict and contains no transcript.

## Policy contract

- Frozen 18-case release corpus, revision
  `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`.
- Exactly two treatments: `no-index` and one fixed `canonical` CodeIndex
  artifact.
- Three paired repetitions: 18 × 2 × 3 = 108 executions per model.
- Only the pinned model environment may change across comparable campaigns.
- Qualification is local-model-scoped, carries no release authority, and neither
  satisfies nor blocks the frontier architecture/release gate.

## Canonical artifact

The canonical reference is pinned in
[`../canonical-artifact.json`](../canonical-artifact.json):

| Field | Value |
| --- | --- |
| ID | `codeindex-mcp-canonical` |
| Version | `0.5.0` |
| Root | `artifacts/canonical` |
| Entry point | `mcp.mjs` |
| Content digest | `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0` |

The digest is the content identity of the released 0.5.0 artifact already
exercised by the frozen release suite and the completed 162-slot local
regression. It covers every artifact file except `node_modules` and `.git`, so it
is independent of a branch, build directory, tag, package-manager state, or
candidate change. Every comparable model campaign stages the same files and
therefore presents byte-identical MCP tools and responses. A changed file,
quantization-independent rebuild, or different artifact id changes the digest,
which starts a new qualification baseline for every model.

The canonical adaptation of the historical accepted artifact digest is deliberate:
it keeps the historical evidence interpretable while removing the moving candidate
that confounded the 162-slot regression. The historical record remains `NOT
PASSED` and is not regraded.

## Frozen plan

The plan is
[`../suites/qualification.json`](../suites/qualification.json), suite
`codeindex-qualification` version 1.

- Suite hash:
  `53586e43eb8e4882df2761244b0d5b9bd8537636315818e564585e131a4a223d`.
- Cases: the same four locate, six impact, six semantic, and two implementation
  cases, with the same pinned SHA-256 hashes as the release suite.
- Treatments: `no-index` and `canonical`, identical ordinary tool lists and
  native MCP configuration, no generic `execute`.
- Repetitions: 3.
- Slots: 108.

The qualification baseline, which excludes the model and environment, is
`47d30acfc60f84c54767c70565c0001ad5631e7cb08f9f238e11d07e04e2b0c5`.
Two campaigns with this baseline are directly comparable. A changed canonical
artifact digest, suite version, revision, case hash, treatment definition, or
harness version produces a different baseline.

## Predeclared criteria

These are frozen before the first campaign and are encoded in
`evaluation/harness/src/qualificationContract.ts`.

### Correctness

- Canonical success rate is at least 90% over valid slots.
- No case answers correctly less often than the `no-index` baseline.
- All 108 expected slots carry valid evidence. Missing, duplicated, or invalid
  slots disqualify the model instead of shrinking the sample.

### Timeout

- No execution ends `timed-out`.
- No execution ends `aborted`.

### Tool use

- No generic `execute` call.
- No call outside the captured treatment surface.
- Every canonical slot exercises the canonical artifact at least once.

### Efficiency

- Canonical median `retrievalBytes` is not above the `no-index` median.
- Canonical median `toolCalls` is not above the `no-index` median.
- Every case supplies one complete paired observation.

Token and wall-clock values are recorded beside these criteria. They are not
gates because this policy predeclares retrieval payload and calls as the
efficiency criterion.

## Dry-run evidence

Command:

```bash
node evaluation/harness/src/cli.ts qualification \
  --suite suites/qualification.json \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --canonical canonical-artifact.json \
  --dry-run
```

Sanitized output:

```text
run <evaluation-root>/results/codeindex-qualification-f4a1dad3891f7e84
plan 108 execution(s): 18 case(s) x 2 treatment(s) x 3 repetition(s)
plan-hash c2e4812557d2e928fe9f54a167a2e32369c9885e2f19f114f0e71b373f3f0351
identity f4a1dad3891f7e84dcab5385aa975c5db14c6b650d7ad78829e920dfcb6071e1
environment ollama-qwen3.8-27b-calibration ollama/qwen3.8:27b-mlx digest 5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e runtime ollama 0.40.8 / opencode 2.1.2
isolation detached-worktree, revision=3b6b791, standalone server, client store ephemeral
108 planned slot lines
```

The dry run starts no model, MCP server, or workspace process. The printed run
path is resolved under the operator's evaluation directory and is rewritten here
as `<evaluation-root>`.

## Result record

A real campaign writes `results/<campaign>/qualification.json` with:

- `claimClass: "local-model-scoped"`, `releaseAuthority: false`,
  `frontierReleaseGate: "unaffected"`;
- the pinned model identity and environment hash, harness version and result
  schema version, suite identity, subject revision and content hash, canonical
  artifact identity and manifest hash;
- the criteria, their observed values, and every one of the 108 slot outcomes;
- `qualification.status` plus `qualification.reasons`, and a separate
  `disqualification.reasons` list;
- a `productRelease` block that repeats the absence of release authority and
  describes the frontier gate as unaffected.

The record has no hosted claim, no Q2 verdict, and no `passed` release field. It
cannot be cited as production release evidence, and a failed or absent
qualification cannot block a valid hosted campaign.

## Validity-v2 revalidation

The qualification path was revalidated model-free against the validity-v2
measurement controls before any local campaign spends on 108 slots: complete
request metering, the agent request-1 surface, corpus coverage, external
workspace isolation, and all-valid-run aggregation. The result record and its
scope are in
[`local-model-qualification-v2-revalidation.md`](local-model-qualification-v2-revalidation.md).
The record remains validity-only and issues no qualification verdict.

## Historical evidence

The completed v1 local regression in
[`local-regression-e4.md`](local-regression-e4.md) used a moving candidate
artifact and remains historical `NOT PASSED` evidence. Its 162 slots and verdict
are not rerun, regraded, or pooled with any qualification campaign.
