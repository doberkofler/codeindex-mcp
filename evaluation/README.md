# Evaluation

Controlled evaluation of the CodeIndex MCP server against retrieval baselines.
The method is specified in
[`documentation/evaluation-harness.md`](../documentation/evaluation-harness.md).

> **Hosted certification paused.** E3 remains historical `NOT PASSED`, but its
> total-token and cost interpretation is invalid. Request metering, the direct
> request-1 surface proof, external-state workspace isolation, corpus preflight,
> the frozen economic/statistical contract, the deterministic-plus-A/A validity
> calibration, and the budgeted development pilot are implemented. The point
> A/A label ratio passed its predeclared criterion; the observed variance implies
> 7 paired repetitions (378 executions), above the frozen 270-execution budget.
> The development pilot found a class-specific effect: the impact class met the
> cost target while the full six-case mix did not. The next step is a
> narrow-scope decision plus a revised budget, not a full certification claim.
> Read the [E3 erratum](audits/hosted-release-e3-erratum.md),
> [evaluation validity v2](../documentation/evaluation-validity-v2.md), the
> [frozen contract evidence](audits/economic-contract-eval-034.md), the
> [validity/A/A evidence](audits/validity-aa-eval-035.md), and the
> [development pilot evidence](audits/ab-development-eval-036.md).

| Directory | Contents |
| --- | --- |
| `harness/` | Runner, schemas, isolation, normalization, grading, and reporting code |
| `cases/` | Public synthetic and repository cases with exact ground truth |
| `fixtures/` | Reviewed disposable workspaces used by controlled cases |
| `suites/` | Public suite manifests |
| `corpora/` | Pinned corpus manifests, including the selected external repository |
| `routes/` | Declared complete-route plans for model-free E1 comparison |
| `references/` | Pinned hosted-model identities for release campaigns |
| `pilots/` | Frozen development-pilot designs and breadth-selection records |
| `audits/` | Recorded E0 case and truth review notes |
| `reports/` | Reviewed aggregate reports safe for publication |

Generated material is never committed:

- `artifacts/` — declared accepted, candidate, and canonical package sources;
- the external evaluation state root — staged artifacts, isolated workspaces,
  index databases, client stores, and raw results; select it with
  `EVALUATION_STATE_ROOT`, otherwise the harness uses a disposable directory
  outside the checkout.

The state root is never inside the primary checkout. A configured path that
resolves inside it is rejected before any workspace is created.

Private corpora, proprietary source, hidden cases, and restricted traces stay in
a separate private data repository. Only reviewed aggregate evidence from this
directory may be cited publicly.

## Gate responsibilities

| Gate | Variable under test | Authority |
| --- | --- | --- |
| Model-free route | Candidate artifact | Mandatory mechanical architecture precondition |
| Local-model qualification | Pinned local model only, against one fixed canonical artifact | Local model capability only; independent of release |
| Hosted release | Candidate artifact under the pinned frontier model | Authoritative architecture/release verdict |

The historical 162-slot local regression compared a moving candidate and remains
`NOT PASSED`. It is retained as evidence but is not the future local-model
qualification design and is not a hosted precondition.

## Commands

```bash
pnpm eval:list
pnpm eval:check --dry-run
pnpm eval:evaluate --case locate-schema-version --treatment candidate --repetitions 1
pnpm eval:report
pnpm eval:verify
```

The frozen release suite is listed and validated with:

```bash
node evaluation/harness/src/cli.ts list --suite suites/release.json
node evaluation/harness/src/cli.ts preflight --suite suites/release.json
node evaluation/harness/src/cli.ts evaluate --suite suites/release.json --dry-run
```

It contains 18 cases: four locate, six impact, six semantic, and two
implementation cases. Every case is pinned by SHA-256 in
[`suites/release.json`](suites/release.json). The freeze record, revision, corpus
manifests, pattern coverage, and expected runtime are in
[`audits/frozen-suite-e0.md`](audits/frozen-suite-e0.md).

The model-free complete-route comparison for the frozen release suite is run
with the published accepted and candidate artifacts staged:

```bash
node evaluation/harness/src/cli.ts route --suite suites/release.json --dry-run
node evaluation/harness/src/cli.ts route --suite suites/release.json
```

The route plan in [`routes/codeindex-release.json`](routes/codeindex-release.json)
declares the complete minimum no-index, accepted, and candidate route for every
case. The command starts no model, compares exact answers, records complete-route
calls, bytes, elapsed time, and server-reported core query time, and runs
pagination, truncation, stale-file, and failure probes against each artifact.
Its report is written under `results/route/`, which is never committed.

The frozen six-case calibration subset is listed and validated with:

```bash
node evaluation/harness/src/cli.ts list --suite suites/calibration.json
node evaluation/harness/src/cli.ts evaluate --suite suites/calibration.json --dry-run \
  --treatment no-index,accepted --repetitions 1
```

A local smoke run executes those six cases with `no-index` and `accepted`
treatments at one repetition, for 12 executions.

The budgeted development pilot runs the frozen two-arm design and writes
trajectory, class, and decision evidence:

```bash
EVALUATION_STATE_ROOT=<external-root> DEEPSEEK_API_KEY=<key> \
  node evaluation/harness/src/cli.ts pilot \
  --suite suites/calibration.json \
  --design pilots/ab-development-v1.json \
  --hosted-reference references/deepseek-flash-validity-2026-10-23.json \
  --provider-auth-env DEEPSEEK_API_KEY
```

The pinned holdout suite is validated without a model call:

```bash
node evaluation/harness/src/cli.ts preflight --suite suites/holdout.json
```

The hosted validity calibration runs every zero-spend gate, one hosted smoke,
and two identical no-index A/A arms in randomized paired order. The record is
validity evidence only:

```bash
EVALUATION_STATE_ROOT=<external-root> DEEPSEEK_API_KEY=<key> \
  node evaluation/harness/src/cli.ts validity \
  --suite suites/calibration.json \
  --hosted-reference references/deepseek-flash-validity-2026-10-23.json \
  --provider-auth-env DEEPSEEK_API_KEY \
  --aa-repetitions 4
```

The recorded result is in
[`audits/validity-aa-eval-035.md`](audits/validity-aa-eval-035.md) and
[`reports/validity-aa-eval-035.json`](reports/validity-aa-eval-035.json).

The reproducible local smoke pins the host, runtimes, model digest,
quantization, context, and generation settings in
[`environments/ollama-qwen3-8b-smoke.json`](environments/ollama-qwen3-8b-smoke.json).
It runs the six calibration cases with the accepted treatment only:

```bash
node evaluation/harness/src/cli.ts environment --check \
  --environment environments/ollama-qwen3-8b-smoke.json
node evaluation/harness/src/cli.ts smoke \
  --suite suites/calibration.json \
  --environment environments/ollama-qwen3-8b-smoke.json
```

The command refuses a changed digest, quantization, runtime, context, generation
setting, or host fact before the first model call. The 8B model is a harness
smoke only and makes no quality claim. The recorded execution is in
[`audits/local-model-smoke-e1.md`](audits/local-model-smoke-e1.md).

Local candidates are calibrated with the same frozen six cases, `no-index` and
`accepted`, and one repetition, for 12 executions per model. Each candidate first
runs the three-repetition diagnostic phase on `impl-default-result-bytes` and
`impact-schema-version-references`; an anomaly attributed to the harness,
CodeIndex, or integration blocks qualification:

```bash
node evaluation/harness/src/cli.ts calibrate \
  --suite suites/calibration.json \
  --budget-ms 900000 \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --environment environments/ollama-devstral-small-2-calibration.json \
  --exclude "ollama-devstral-small-2-calibration=<operator reason>"
```

`--exclude` records a candidate ruled out before execution as a disqualification
with zero executions. It is an operator constraint, not a model-quality result.
The command verifies each eligible pinned environment, enforces the budget per
model, and records a qualification decision and one selection. The selection is
local-model scoped; it is not evidence for a different model or a
model-independent claim. Execution records are in
[`audits/local-model-calibration-e2.md`](audits/local-model-calibration-e2.md);
the earlier v1 campaign is
[`audits/local-model-calibration-e1.md`](audits/local-model-calibration-e1.md).

Under the 2026-10-23 policy, this six-case result is a calibration screen despite
the historical `qualification` field name. It does not satisfy the independent
108-slot local-model qualification gate.

The selected historical regression sentinel is `ollama/qwen3.8:27b-mlx`. The
following commands implement the previous candidate-comparison policy and remain
available for reproduction and diagnosis:

```bash
# Four executions: two impact cases x accepted/candidate x one repetition.
node evaluation/harness/src/cli.ts local-diagnostic \
  --suite suites/release.json \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --target-metric retrievalBytes

# Diagnostic first, then 18 cases x 3 treatments x 3 paired repetitions = 162.
node evaluation/harness/src/cli.ts local-regression \
  --suite suites/release.json \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --target-metric retrievalBytes
```

`local-diagnostic` stops when a candidate answer is wrong, the target workflow
does not improve, or retrieval bytes or tool calls regress. Token and wall-clock
changes are recorded as observations. `local-regression` runs it
before the full suite, writes `report.json` and `local-regression.json`, reports
class-stratified trends, and sets `diagnosisRequired` when targeted diagnosis is
needed. Both commands require frozen case hashes and staged artifacts, accept
`--dry-run` without starting a model, and reject a plan-changing flag. Their
records carry `claimClass: "local-model-scoped"`; the full record also carries
`releaseAuthority: false`, so a hosted result cannot override local evidence or
vice versa. The diagnostic history is recorded in
[`audits/local-regression-e2.md`](audits/local-regression-e2.md) and
[`audits/local-regression-e3.md`](audits/local-regression-e3.md). The completed
162-slot verdict is recorded in
[`audits/local-regression-e4.md`](audits/local-regression-e4.md) as historical
`NOT PASSED` evidence; its valid wrong answer is not rerun for luck.

The independent local-model qualification runs 18 cases × `no-index` and one
fixed canonical CodeIndex artifact × 3 paired repetitions = 108 executions. The
canonical artifact is pinned by content digest in
[`canonical-artifact.json`](canonical-artifact.json); the plan and frozen case
hashes are in [`suites/qualification.json`](suites/qualification.json). Only the
pinned model/environment changes between comparable campaigns. The canonical
artifact is staged at `artifacts/canonical/`, which is generated and ignored like
every other artifact tree:

```bash
node evaluation/harness/src/cli.ts qualification \
  --suite suites/qualification.json \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --canonical canonical-artifact.json \
  --dry-run
node evaluation/harness/src/cli.ts qualification \
  --suite suites/qualification.json \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --canonical canonical-artifact.json
```

The command verifies the pinned host and model, the frozen release case content,
and the canonical artifact digest before the first model call. It writes
`qualification.json` with `claimClass: "local-model-scoped"`,
`releaseAuthority: false`, and `frontierReleaseGate: "unaffected"`. The record
keeps qualification and disqualification reasons separate and contains no
product-release verdict. A failed, blocked, or absent record neither authorizes
nor blocks the hosted release gate. The plan and criteria are recorded in
[`audits/local-model-qualification-e0.md`](audits/local-model-qualification-e0.md).

The hosted release campaign pins an exact frontier model in
[`references/`](references/README.md) and runs from scratch after a passing
model-free route report covers the same suite and staged artifacts. Local-model
qualification is independent. The campaign executes the frozen 18-case suite
with all three treatments and five paired repetitions, exactly 270 slots:

The command below documents the historical v1 workflow. It is not authorized
for a new hosted campaign until the v2 metering, request-1 surface, corpus,
isolation, and statistical requirements are implemented.

```bash
node evaluation/harness/src/cli.ts release \
  --suite suites/release.json \
  --hosted-reference references/deepseek-flash.json \
  --target-metric retrievalBytes \
  --dry-run
```

The intended real run requires `--model-free <report.json>`, verifies the pinned
OpenCode runtime, and writes
`release-campaign.json` with `claimClass: "hosted-model-scoped"` and
`releaseAuthority: true`. Every one of the 270 slots is recorded as valid or
invalid with a closed cause; a missing or invalid slot, a failed Q2 gate, a
non-improving target metric, a statistically supported regression, or any
class-stratified failure blocks the release verdict. The selected reference and
the current gate status are recorded in
[`audits/hosted-release-campaign-e2.md`](audits/hosted-release-campaign-e2.md).

Local qualification is not a release precondition. A failed, blocked, or absent
local record neither authorizes nor blocks a valid hosted plan. The historical
`--local-regression` argument is no longer part of the interface, so its value is
never consulted. The real command requires current model-free evidence for the
same suite, revision, and staged artifacts before the first model call.

## Operational soak

The E3 operational soak is model-free and runs outside the agent harness. It
generates a deterministic TypeScript corpus, drives real files through the real
watcher and builder, records edit-to-fresh latency and edits during active
builds, injects a source-read failure, restarts the index, and checks the
declared retention policy:

```bash
pnpm build
node dist/cli.mjs soak --profile small --rounds 8 --burst-edits 3 \
  --failures 1 --restarts 1 --output benchmark/results/soak.json
```

Every edit changes the file content, and the report carries a plan hash and an
edit-script hash. Build failures use the closed cause set and are also written
to the `build_failed` analytics event. The sanitized report and Markdown summary
are written to the requested paths; generated workspaces and databases are
removed unless `--keep-workspace` is supplied. The reference-machine run is
recorded in [`audits/operational-soak-e3.md`](audits/operational-soak-e3.md).
Operational results stay separate from agent-task latency and are never used as
E1 or E2 evidence.

The draft controlled semantic suite is listed with:

```bash
node evaluation/harness/src/cli.ts list --suite suites/semantic.json
node evaluation/harness/src/cli.ts evaluate --suite suites/semantic.json --dry-run
```

The draft CodeIndex repository suite, including the bounded implementation cases and
their post-run checks, is listed with:

```bash
node evaluation/harness/src/cli.ts list --suite suites/repository.json
node evaluation/harness/src/cli.ts evaluate --suite suites/repository.json --dry-run
```

The selected external corpus is pinned in
[`corpora/external-material-ui.json`](corpora/external-material-ui.json). The
model-free comparison that selected it is recorded in
[`audits/external-corpus-pilot.md`](audits/external-corpus-pilot.md). A campaign
against it points `harness.json` at the prepared checkout at the pinned revision.
No external case is admitted to release suite version 1; the corpus manifest's
`caseHashes` stays empty until exact file sets and grep admission are recorded.

The subject defaults to this repository root. Override it with
`evaluation/harness/harness.json`:

```json
{"subjectRepo": "/path/to/another/checkout"}
```

`EVALUATION_ROOT` overrides the data directory, which is otherwise this
`evaluation/` directory.
