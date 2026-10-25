# Controlled Evaluation Harness

**Status:** implemented methodology
**Scope:** repeatable comparisons of agent work without CodeIndex, with the accepted
CodeIndex artifact, and with a candidate artifact

> **Validity status:** the V1–V7 validity sequence is complete. Final certification
> EVAL-037 recorded **RELEASE** for the pinned impact-class primary population
> with native direct MCP, and made no Code Mode or generalization claim. The
> harness meters every provider request, asserts the direct agent request-1
> surface after actual MCP readiness, stages all mutable execution state outside
> the primary checkout, and preflights every case corpus before model spend.
> Provider metering, not `step_finish` events, is the cost ledger. The frozen
> economic contract is
> [`../evaluation/contracts/evaluation-validity-v2.json`](../evaluation/contracts/evaluation-validity-v2.json);
> the certification record is
> [`../evaluation/audits/certification-eval-037.md`](../evaluation/audits/certification-eval-037.md).
> The post-certification exposure comparison measured Code Mode at `1.307` direct
> cost (upper `1.473`), so native direct MCP remains recommended; see
> [`../evaluation/audits/exposure-eval-050.md`](../evaluation/audits/exposure-eval-050.md).
> Do not cite a new economic result outside the frozen contract and pinned
> configuration. See the [E3 erratum](../evaluation/audits/hosted-release-e3-erratum.md)
> and the [request-1 evidence](../evaluation/audits/request-1-surface-eval-032.md).

This document owns harness mechanics. The
[MCP evaluation strategy](./mcp-evaluation-strategy.md) owns product questions, test
data, metrics, gates, evaluation tiers, the stage order, stop rules, retry policy,
local-model use, and evaluation cadence. The strategy's
[execution contract](./mcp-evaluation-strategy.md#81-execution-contract-tiers-order-invalidation-retry-and-stop-rules)
is authoritative; [§13](#13-tier-gate-and-stop-rule-enforcement) lists where this harness
enforces it.

This document describes an evaluation method, not a shipped runtime component.
The harness, public synthetic cases, suites, and reviewed aggregate reports live
under [`evaluation/`](../evaluation/README.md). The published package contains no
corpus, grading data, model transcripts, or runner. Private corpora, hidden cases,
and restricted raw results remain outside this repository.

## Scope and claim boundary

The [MCP evaluation strategy](./mcp-evaluation-strategy.md) owns product questions,
test data, metrics, gates, evaluation tiers, the stage order, stop rules, retry policy,
claim authority, and evaluation cadence. This section repeats the strategy's scope
statement because it constrains every harness run.

The following statement is repeated verbatim from the strategy and is normative here:

> **Evaluation v1 scope.** Evaluation v1 covers only the TypeScript/JavaScript
> adapter, using the TypeScript language service or a reviewed source manifest as
> the ground-truth authority. Oracle, PL/SQL, ORDS, drift, cross-language impact,
> and every other adapter are out of scope. TypeScript evidence must not be
> pooled with, or generalized to, another adapter, language, or repository
> population.

Evaluation v1 harness runs use the TypeScript/JavaScript adapter only. External
database systems ([§5.2](#52-external-systems)) and the non-TypeScript rows in
[§8.2](#82-adapter-specific-case-classes) are deferred reference material; they are
not v1 acceptance evidence. Harness results carry the claim class defined in
[strategy §1.2](./mcp-evaluation-strategy.md#12-claim-authority): local qualification is
local-model-scoped, and only a hosted campaign can support a release claim. Per
[strategy §1.3](./mcp-evaluation-strategy.md#13-gate-responsibilities), local qualification
is independent of the hosted architecture sequence.

## 1. Decision

Use a case-oriented harness rather than ad-hoc prompts. Keep workspace
isolation, event capture, exact token accounting, grading, restoration, resume
support, and immutable result directories. Add declarative cases, individual
selection, per-case gates, configurable treatments, and a fast diagnosis loop.

Do not build a second runner. The harness must invoke the production MCP entry,
not import implementation internals.

## 2. Goals

The harness must:

- add a use case without editing orchestration code;
- validate and list cases before starting a model run;
- run one case, a tagged subset, or a complete suite;
- compare the same prompt, model, revision, permissions, and repetition
  schedule across treatments;
- capture exact model input/output tokens, wall time, tool calls, tool output
  bytes, errors, final answer, and correctness;
- enforce workflow gates such as maximum calls, forbidden broad searches,
  required first tool, or maximum index bytes;
- preserve raw events so every aggregate can be audited and recalculated;
- restore the dedicated checkout after every treatment and repetition;
- resume interrupted runs without mixing incompatible suite, model, revision,
  treatment, or harness versions;
- support one-case, one-repetition diagnosis before a full comparison.

The harness does not infer token counts from bytes. A run whose claim depends on
token metrics is invalid for that claim when the client does not emit usage; every
other metric of the same run stays valid
([§7.5](#75-telemetry-availability-states)). It also does not use MCP analytics
as a substitute for the full agent event stream, because MCP cannot observe
fallback tools or model turns.

## 3. Cases, suites, and treatments

### 3.1 Case

A case is the smallest independently runnable evaluation unit. It owns:

- stable ID, title, class, and tags;
- prompt and repository scope;
- correctness checks;
- workflow policy and quantitative gates;
- timeout and optional post-run check command.

Cases are data. Adding a conforming JSON case requires no TypeScript change.
Store one file per case so review history and focused execution do not contend on
one large corpus file.

### 3.2 Suite

A suite is a versioned manifest containing:

- suite ID and status (`draft` or `frozen`);
- optional VCS revision;
- default model and repetitions;
- ordered case-file references;
- treatment definitions;
- harness and MCP artifact identities.

Frozen suites reference immutable case hashes. Changing a frozen case requires a
new suite version, not an in-place edit.

Every identity field compared in [§7.3](#73-run-identity-and-resume-equality) must
be derivable from the suite, its case files, or the run manifest, so the suite
version and the case hashes are the suite's contribution to run identity.

### 3.3 Treatment

A treatment defines one controlled execution environment. Frontier evaluation of a
user-visible CodeIndex change uses three treatments:

| Treatment | Setup |
| --- | --- |
| no-index | Normal repository tools; index tools denied |
| accepted | Normal tools plus the currently accepted CodeIndex artifact |
| candidate | Normal tools plus the candidate CodeIndex artifact |

Every treatment inspects the same pinned subject revision. Accepted and candidate differ
only in the CodeIndex artifact and its resulting MCP interface. Treatment definitions are
data and record every difference that could affect the result.

Local-model qualification instead uses exactly two treatments: `no-index` and one fixed
canonical CodeIndex artifact. The canonical artifact has its own pinned identity and is
not rebound to a moving `accepted` or `candidate`. Across comparable qualification
campaigns, only the pinned model environment changes.

Workflow compliance and answer correctness are separate results. A correct answer
that exceeds a tool budget fails the workflow gate but keeps its correctness
score; reports must not collapse those outcomes into one boolean.

## 4. Case schema

A case file contains:

| Field | Meaning |
| --- | --- |
| `id` | Stable case identifier |
| `title` | Human-readable label |
| `class` | Grouping such as locate, impact, or implementation |
| `tags` | Selection labels |
| `prompt` | Exact prompt sent to the agent |
| `scope` | Repository paths and file patterns relevant to grading |
| `expectedFiles` | Files the answer should name |
| `contextFiles` | Files allowed as supporting evidence |
| `forbiddenFiles` | Files that must not be named |
| `workflow` | Tool budget, required first tool, forbidden searches |
| `timeoutMs` | Hard wall-clock bound |
| `check` | Optional post-run command |

Validate case files with a schema before execution. Reject an empty selection.
`expectedFiles` must be non-empty, and the expected, context, and forbidden sets must
be disjoint. Grading is exact: every expected file is required, no forbidden file may
appear, and a file outside the expected and bounded-context union fails the answer.
Context files are allowed supporting evidence, never a second expected set. A
post-run `check` is spawned without a shell in the workspace, with a hard timeout and
an explicit expected exit code, and its result stays separate from correctness,
workflow, and process outcome.

## 5. Isolation

All mutable execution state lives under an external `EVALUATION_STATE_ROOT`:
staged artifacts, worktrees, index databases, client stores, preflight reports,
and result records. The primary checkout contains only committed inputs. A state
root inside the primary checkout is a configuration error before any workspace
is created.

Each execution uses a dedicated checkout:

1. Resolve the suite revision.
2. Verify the checkout is clean and at exactly that revision.
3. Verify the MCP artifact and required dependencies.
4. Stage the artifact outside the primary checkout and configure the TypeScript
   extractor with the root, controlled-fixture, and test project contexts.
5. Run the corpus preflight against `index_status`, expected paths, and known
   semantic declarations.
6. Write one isolated agent configuration for the selected treatment.
7. Run the agent with the case prompt.
8. Capture events, stderr, status, timeout, and wall time.
9. Grade correctness and workflow.
10. Persist the raw result atomically ([§7.7](#77-atomic-persistence-and-partial-writes)).
11. Restore tracked edits, remove non-ignored unversioned files, and remove
    authored files that the repository ignores while keeping harness-owned support
    paths.

Generated instructions and configuration must contain no primary-checkout
absolute path. Provider requests are scanned at the request-1 surface proof and
by the optional provider meter; a disclosure is a closed failure, never a
warning or a retryable execution. Every `external_directory` denial in stdout or
stderr is recorded with its channel and line, invalidates the slot, and is never
retried. A campaign that records such an attempt cannot support a hosted validity
claim.

If no VCS is available, use a disposable copy and a content manifest instead of a
revision. Record which isolation mode was used.

### 5.1 OpenCode client state

Evaluation executions must never write to the operator's normal OpenCode session store.
Start every agent process with a private server and an ephemeral database:

```bash
OPENCODE_DB=:memory: opencode serve --hostname 127.0.0.1 --port 0
# wait until every expected MCP server reports connected through /api/mcp
OPENCODE_DB=:memory: OPENCODE_SERVER_PASSWORD=<printed> \
	opencode run --server <printed-url> \
	--model <pinned-model> --format json "<case prompt>"
```

- The private server keeps the execution off the shared background service, so it
  cannot observe or contend with an ordinary session.
- The prompt is admitted only after the configured MCP server is actually connected.
  Starting a process or registering a server in configuration is not readiness.
- `OPENCODE_DB=:memory:` keeps sessions, messages, and tool events out of
  `~/.local/share/opencode/opencode.db`. Every execution starts with no prior session
  and leaves no session for the operator to see or delete.
- The treatment configuration from step 4 supplies the MCP server and tool policy, so
  the isolated server needs no project-local `.opencode` edit.

These settings apply to every treatment, case, and repetition. Evidence must be captured
from the process stream before the private server exits, because an in-memory
database cannot be inspected afterwards.

Before the first model call, a model-free surface proof records the exact tools OpenCode
offers on agent request 1. The proof starts a loopback OpenAI-compatible endpoint, points
a private `surface-probe` provider at it through `OPENCODE_CONFIG_CONTENT`, and uses the
treatment's unchanged configuration, agent, artifact, and MCP server. It first requires
the exact configured MCP command to complete an `initialize`/`tools/list` handshake,
then requires OpenCode's `/api/mcp` status to report the configured server connected
before a prompt is admitted. The first agent request is answered and stopped; later
turns never contribute to the verdict.

The request-1 list must equal the declared surface exactly: `edit` presents `edit` and
`write`, `bash` is presented as `shell`, and the retired `list` tool is omitted. A
missing, late, duplicated, or undeclared tool aborts the campaign before any hosted
model process starts and records a closed cause. Every treatment must pass twenty
consecutive cold starts. The probe is not a model execution and contributes no result
record.

When a suite requires a persistent execution store for resume or post-run inspection,
use one campaign-local database outside the normal data directory, record its path in
the run manifest, and delete it when the campaign completes. Never point `OPENCODE_DB` at
the default location.

Deleting sessions after a run is not a substitute for isolation: a full campaign would
still expose every execution in the session list while it runs.

Sessions recorded before this rule are removed with `opencode session delete <sessionID>`
or `DELETE /api/session/{sessionID}` after filtering by the evaluation workspace
directory. Never edit the session database directly.

### 5.2 External systems

**Deferred beyond v1.** This section defines future adapter requirements. Evaluation v1
does not use databases, ORDS, PL/SQL, or cross-language cases.

Cases requiring a database or routing service use disposable development fixtures
or read-only snapshots. A suite records database/ORDS version, schema fixture
identity, adapter privilege mode, configuration digest, and PL/Scope settings.
All treatments must observe equivalent external state.

Never point evaluation at production. Restoration must remove fixture mutations
made by the task runner and verify object validity before the next run. The index
itself remains read-only.

## 6. CLI shape

```bash
# Discover cases without model calls
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json --list

# Validate schemas, workspace, artifacts, and planned runs
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json \
	--case dependency-usage --dry-run

# Fast diagnosis: one case, one treatment, one repetition
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json \
	--case dependency-usage --treatment candidate --repetitions 1

# Controlled comparison
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json \
	--case dependency-usage --treatment all --repetitions 5

# Tagged subset
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json \
	--tag compact-output --treatment all

# Independent local-model qualification: fixed 108-slot plan
node evaluation/harness/src/cli.ts qualification \
	--suite evaluation/suites/qualification.json \
	--environment evaluation/environments/ollama-qwen3.8-27b-calibration.json \
	--canonical evaluation/canonical-artifact.json --dry-run

# Model-free revalidation of the qualification path (validity-only)
node evaluation/harness/src/cli.ts qualification \
	--suite evaluation/suites/qualification.json \
	--canonical evaluation/canonical-artifact.json --revalidate

# Zero-spend validity gates, hosted smoke, and randomized A/A calibration
EVALUATION_STATE_ROOT=<external-root> DEEPSEEK_API_KEY=<key> \
node evaluation/harness/src/cli.ts validity \
	--suite evaluation/suites/calibration.json \
	--hosted-reference evaluation/references/deepseek-flash-validity-2026-10-23.json \
	--provider-auth-env DEEPSEEK_API_KEY --aa-repetitions 4
```

Selection rules:

- repeated `--case` values form an ordered union;
- repeated `--tag` values use intersection;
- case and tag filters combine by intersection;
- an empty selection is an error;
- `--list` and `--dry-run` start no model process;
- `--resume` matches the complete run identity defined in
  [§7.3](#73-run-identity-and-resume-equality), not only case/treatment/repetition;
- an identity difference never resumes into an existing result: the stored result is
  retained and the slot is planned as missing ([§7.3](#73-run-identity-and-resume-equality));
- a partial or unreadable result file is treated as absent, never as invalid evidence
  ([§7.7](#77-atomic-persistence-and-partial-writes));
- a complete, effectively valid result is never re-executed; a stored `aborted`
  attempt does not satisfy its slot
  ([strategy §8.1.5](./mcp-evaluation-strategy.md#815-failed-slot-only-retry));
- `--retry-timed-out` with `--resume` re-executes a slot whose highest attempt timed
  out and writes the next attempt ordinal; the timeout is retained, and no completed
  non-timeout result is ever rerun by this flag.

## 7. Result contract

Write one immutable JSON result per execution plus one run manifest per campaign.
This section defines the proposed field-level contract; it states what an
implementation must satisfy. No schema and no runner ship with this document.

Reports provide per-run values and, when repetitions permit, median, p95, range,
and paired treatment delta. Never report a percentile from one observation without the
sample count.

A case is promotable only when every correctness run passes and its configured
workflow gates pass at the declared statistic.

The contract separates four things that are often conflated: what an execution
measured ([7.1](#71-result-envelope)), what the campaign declared before it ran
([7.2](#72-run-manifest)), what makes two executions the same slot
([7.3](#73-run-identity-and-resume-equality)), and what may be retained or
published ([7.9](#79-redaction-retention-and-public-evidence)). Invalidity stays a
property of the evidence, not of the result
([strategy §8.1.4](./mcp-evaluation-strategy.md#814-invalidation-rules)). Every
record is TypeScript-adapter-scoped
([Scope and claim boundary](#scope-and-claim-boundary)); no field widens the adapter
or the claim class.

### 7.1 Result envelope

One result describes exactly one execution: one case, one treatment, one
repetition, one attempt. A result is a JSON object with the following top-level
fields. `yes` in the **Req.** column means the field is required; a document missing
a required field, or carrying a wrong type, is not a result
([7.7](#77-atomic-persistence-and-partial-writes)).

| Field | Type | Req. | Semantics |
| --- | --- | --- | --- |
| `recordType` | string, `result` | yes | Discriminates a result from a manifest. |
| `schemaVersion` | string, `MAJOR.MINOR` | yes | Record schema ([7.4](#74-schema-versioning-and-version-1-compatibility)). |
| `identity` | object | yes | Closed identity field set ([7.3](#73-run-identity-and-resume-equality)). |
| `identityDigest` | string, 64 lowercase hex | yes | SHA-256 over the canonical identity ([7.3](#73-run-identity-and-resume-equality)). |
| `campaignId` | string | yes | Equals the manifest `campaignId`. |
| `attempt` | integer, ≥ 1 | yes | Attempt ordinal within the identity; not part of identity ([7.7](#77-atomic-persistence-and-partial-writes)). |
| `timing` | object | yes | `{startedAt, completedAt, wallTimeMs}`; ISO 8601 UTC timestamps and integer milliseconds measured by the harness. |
| `outcome` | string enum | yes | `completed`, `failed`, `timed-out`, or `aborted` ([7.6](#76-execution-outcome-and-validity)). |
| `defects` | array of string enums | yes, may be empty | Harness-detected invalidity causes recorded at write time ([7.6](#76-execution-outcome-and-validity)). |
| `isolation` | object | yes | `{mode, checkoutClean, revisionMatch, restored, clientStore}`; `clientStore` is `ephemeral` or `campaign-local` ([§5.1](#51-opencode-client-state)). |
| `process` | object | yes | `{exitCode, signal, stderrPath, errorClass}`; stderr is bounded, `stderrPath` is result-directory-relative, and `exitCode` and `signal` may be `null` only with `outcome` `timed-out` or `aborted`. |
| `events` | object | yes | `{path, count, digest}` for the raw event stream; `path` is relative to the result directory ([7.9](#79-redaction-retention-and-public-evidence)). |
| `telemetry` | object of metric entries | yes | One entry per metric in [7.5](#75-telemetry-availability-states): `{value, state, unit, source}`. |
| `tools` | object | yes | `{path, count, normalizerVersion}` for the normalized call sequence. |
| `output` | object | yes | `{path, digest, finalMessageCount}` for the agent's final answer material. |
| `bytes` | object | yes | Integer totals for `total`, `index`, `search`, `read`, and `other`. |
| `checks` | object | yes | `{correctness, workflow, postRun}`, each `null` or `{result, assertions, evidenceRef}`. |
| `artifacts` | object | yes | `{accepted, candidate, loaded}`; each `{id, digest}` or `null` when the treatment uses no CodeIndex artifact. |
| `integrity` | object | yes | `{contentDigest, sizeBytes}`; `contentDigest` is SHA-256 over the canonical JSON of the record without this field, using the serialization rules in [7.3](#73-run-identity-and-resume-equality) ([7.7](#77-atomic-persistence-and-partial-writes)). |
| `notes` | string | no | Free text. Never identity and never a claim. |

`checks.<name>.result` is `pass`, `fail`, or `unevaluated`; `unevaluated` means the
evidence was insufficient, and it never becomes `pass`. Each assertion is
`{id, kind, expected, observed, result}`. Correctness, workflow compliance, process
outcome, and telemetry validity remain separate fields, so no field collapses them.

Raw events, the normalized sequence, and the final answer are stored as separate
files in the result directory and referenced by relative path. Every referenced path
is relative and POSIX-style.

### 7.2 Run manifest

The manifest is written once per campaign before the first execution. It records
what the campaign declared, so a reviewer can reconstruct the plan without reading
any result.

| Field | Type | Req. | Semantics |
| --- | --- | --- | --- |
| `recordType` | string, `manifest` | yes | Discriminator. |
| `schemaVersion` | string, `MAJOR.MINOR` | yes | Schema shared with the campaign's results. |
| `campaignId` | string | yes | Stable campaign identifier. |
| `createdAt` | string, ISO 8601 UTC | yes | Manifest creation time. |
| `claimClass` | string enum | yes | `none`, `local-model-scoped`, or `hosted-model-scoped` ([strategy §1.2](./mcp-evaluation-strategy.md#12-claim-authority)). No other value is permitted. |
| `suite` | object | yes | `{id, version, hash, status}`; status is `draft` or `frozen` ([§3.2](#32-suite)). |
| `cases` | array | yes | Ordered `{id, hash}` entries, exactly as declared. |
| `model` | object | yes | `{provider, modelId, digest, quantization, runtime, runtimeVersion, generationSettingsDigest}`. `digest` is the provider's immutable model version or artifact digest, never a floating alias; `generationSettingsDigest` is always a hex digest. |
| `agent` | object | yes | `{id, version, instructionsHash, toolListHash, permissionsHash, contextBudgetTokens}`. |
| `treatmentSet` | array | yes | Ordered `{id, kind, definitionHash, mcpSurfaceHash}` ([§3.3](#33-treatment)). |
| `artifacts` | object | yes | `{accepted, candidate, canonical}`, each `{id, digest, entryPoint}` or `null`. A qualification campaign records only `canonical`; the frontier campaigns record `accepted` and `candidate`. |
| `codeIndex` | object | yes | `{configDigest}`; the digest covers the effective CodeIndex configuration. |
| `subject` | object | yes | `{revision, isolationMode, contentManifestHash, projectFilesHash, lockFileHash, externalFixtureHash}`. `revision` is `null` only when `contentManifestHash` is present ([§5](#5-isolation)). |
| `environment` | object | yes | `{nodeVersion, platform, arch, cpuCount, memoryBytes, referenceMachine}`. |
| `components` | object | yes | `{harnessVersion, eventParserVersion, toolNormalizerVersion, workflowClassifierVersion, graderVersion}`. |
| `plan` | object | yes | `{repetitions, randomizationSeed, slotCount}`. |
| `truthAuthority` | object | yes | `{kind, reference}`; `kind` is `language-service` or `reviewed-manifest` in v1 ([strategy §4 E0](./mcp-evaluation-strategy.md#e0-case-and-truth-validation)). |
| `retention` | object | yes | `{privacyClass, rawUntil}` ([7.9](#79-redaction-retention-and-public-evidence)). |
| `campaignStore` | object | no | `{kind, path}` for a campaign-local client database ([§5.1](#51-opencode-client-state)). Restricted; never public evidence. |
| `notes` | string | no | Free text. |

The manifest is not a result. It carries no metric, no grade, and no validity
verdict. A manifest change that alters any identity field of
[7.3](#73-run-identity-and-resume-equality) defines a different campaign; it never
edits one.

A local model run supplies `model.digest`, `model.quantization`,
`model.runtime`, `model.runtimeVersion`, and `model.generationSettingsDigest`
from a validated environment manifest
([`evaluation/environments/`](../evaluation/environments/README.md)). The
manifest also records the environment identity and the measured host facts, so a
changed model artifact, quantization, runtime, context, generation setting, or
reference machine is visible without reading raw results. The `smoke` command
verifies the pin before the first model call and refuses a mismatch.

A `local-diagnostic` campaign serves the four-execution accepted-versus-candidate
stage. It selects exactly two predeclared impact cases, one repetition, and the
`accepted` and `candidate` treatments, and it writes `targeted-diagnostic.json`
beside the executions. The manifest, record, and claim class are
`local-model-scoped`. Continuation requires a clean execution contract, a correct
candidate answer on both cases, a strict improvement of the predeclared target
metric, and no regression of retrieval bytes or tool calls. Those are the
accepted-versus-candidate conditions of strategy §11. Token and wall-clock changes
are retained as observations, not verdicts: one repetition supports no interval, so
the record cannot separate them from model sampling and local runtime variation.

A `local-regression` campaign runs that diagnostic before the full suite and does
not start the 162 executions unless it passes. It then runs the frozen 18-case
suite with all three treatments and three paired repetitions, and writes both
`report.json` and `local-regression.json`. The local record carries
`claimClass: "local-model-scoped"` and `releaseAuthority: false`, reports the
overall and class-stratified target ratios, and sets `diagnosisRequired` when a
statistically supported regression, a failed gate, a correctness loss, or a
non-improving target metric appears. A claim class other than the local class is
rejected before the local record is written, so local evidence cannot be promoted
to a release claim and a hosted result cannot replace it.

This is the historical candidate-evaluation command, not the approved local-model
qualification gate. The completed v1 record keeps its original `NOT PASSED` verdict and
is never regraded.

A `qualification` campaign runs the independent 108-slot gate. It loads the frozen
18-case release corpus from [`evaluation/suites/qualification.json`](../evaluation/suites/qualification.json),
selects exactly `no-index` and one fixed `canonical` CodeIndex treatment, and runs three
paired repetitions. The canonical treatment must present exactly the artifact pinned by
[`evaluation/canonical-artifact.json`](../evaluation/canonical-artifact.json): identifier,
root, entry point, and content digest all participate in the campaign identity. A missing
digest, a different artifact id, or a staged tree whose digest differs from the pin
refuses the campaign before any model call.

The command writes `qualification.json` beside the executions. The record carries
`claimClass: "local-model-scoped"`, `releaseAuthority: false`, and
`frontierReleaseGate: "unaffected"`. It records the pinned model and environment, the
canonical artifact identity and manifest hash, the predeclared correctness, timeout,
tool-use, and efficiency criteria with their observed values, all 108 slot outcomes, and
the qualification and disqualification reasons in separate fields. `baseline` is a digest
over the suite, revision, case content, treatment definitions, harness version, and
canonical artifact. The model and environment are deliberately excluded, so two campaigns
with the same baseline are directly comparable; a changed canonical artifact, revision,
case, treatment, or harness digest starts a new baseline. The command never reads or
writes hosted release evidence, and neither satisfies nor blocks the frontier
architecture/release gate.

Schema 2 binds the record to `evaluation-validity-v2` and adds five validity checks: a
settled request ledger with exact token usage for every execution, the exact agent
request-1 surface, complete corpus and semantic coverage, external-workspace isolation,
and aggregation over every valid execution including incorrect answers. The pinned local
environment supplies the Ollama endpoint for the loopback meter, so local evidence carries
no hosted tariff or USD claim. `--revalidate` exercises these inputs, the canonical
artifact, twenty request-1 cold starts per treatment, the corpus preflight, the meter
self-check, and path isolation without calling a model, and writes a validity-only
`revalidation.json` with no qualification verdict.

A `release` campaign runs the hosted architecture/release gate after the model-free
stage passes. It loads a pinned hosted reference that records the exact
provider, model ID, provider release, client runtime, and generation settings; the
reference hash participates in campaign identity, so a changed model starts a new
paired baseline. The policy requires a passing `route-report` for the same frozen suite
and staged artifacts, rejects a non-passing or artifact-mismatched precondition, and
verifies the measured client runtime before the first call. The campaign executes
18 × 3 × 5 = 270 fresh slots and
writes `report.json` plus `release-campaign.json` carrying
`claimClass: "hosted-model-scoped"` and `releaseAuthority: true`. Every slot is
recorded as valid or invalid with a closed cause; the overall and class verdicts,
the unchanged Q2 gates, the predeclared target metric, and the paired bootstrap
intervals stay separate. Local evidence never fills a missing hosted execution.

The command does not read local qualification. A failed, blocked, or absent local
record neither authorizes nor blocks a hosted plan. `--local-regression` is no longer
part of the interface, so its value is never consulted. The model-free precondition,
hosted reference and runtime, 270-slot plan, Q2 gates, and identity checks remain
unchanged.

A `calibration` manifest serves the historical six-case environment screen.
`calibrate` verifies every eligible pinned environment, rebinds the frozen suite
to each environment's model without changing case hashes, and first runs the
diagnostic phase: three repetitions of `impl-default-result-bytes` and
`impact-schema-version-references` in `no-index` and `accepted`. Each anomaly is
attributed to the harness, model, CodeIndex, or integration; a harness,
integration, or CodeIndex anomaly or a missing structured answer blocks the
candidate and is recorded as a disqualification. Every declared slot must run
exactly once: a missing, duplicated, or undeclared execution is a blocking
harness anomaly, so a short diagnostic phase cannot pass as clean. A clean
diagnostic phase is
followed by six cases × `no-index` and `accepted` × one repetition. It caps every
execution at the remaining wall-clock budget and writes one decision per model
plus one selection record. `--exclude <environment-id>=<reason>` records an
operator-ruled-out candidate as a disqualification with zero executions instead
of dropping it. Its existing record calls a model `qualified` only when all 12
executions are valid, accepted correctness is never below `no-index`, no execution
needs an intervention, and the elapsed time is inside the budget. Under the
2026-10-23 policy this means the model passed the calibration screen; it does not
satisfy G-E2Q. The budget is a screening criterion, not a target to meet by
dropping cases or repetitions.

### 7.3 Run identity and resume equality

Run identity is a closed set of fields. It is the only basis for reuse: a result
whose identity differs is not a candidate for the same slot, no matter how similar
the rest of the record looks.

| Identity path | Type | Declared by |
| --- | --- | --- |
| `suite.id`, `suite.version`, `suite.hash` | string, string, hex | Suite manifest |
| `case.id`, `case.hash` | string, hex | Case file |
| `case.promptHash`, `case.timeoutMs` | hex, integer | Case file |
| `model.provider`, `model.modelId`, `model.digest`, `model.quantization`, `model.runtime`, `model.runtimeVersion`, `model.generationSettingsDigest` | strings, hex where noted | Manifest `model` |
| `agent.id`, `agent.version`, `agent.instructionsHash`, `agent.toolListHash`, `agent.permissionsHash`, `agent.contextBudgetTokens` | strings, hex, integer | Manifest `agent` |
| `treatment.id`, `treatment.kind`, `treatment.definitionHash`, `treatment.mcpSurfaceHash` | strings, hex | Manifest `treatmentSet` entry |
| `subject.revision`, `subject.isolationMode`, `subject.contentManifestHash`, `subject.projectFilesHash`, `subject.lockFileHash`, `subject.externalFixtureHash` | strings, hex or `null` | Manifest `subject` |
| `artifacts.accepted`, `artifacts.candidate` | `{id, digest}` or `null` | Manifest `artifacts` |
| `codeIndex.configDigest` | hex | Manifest `codeIndex` |
| `harness.schemaVersion`, `harness.version` | string, string | This document and `components.harnessVersion` |
| `repetitionIndex` | integer, 1-based, within `plan.repetitions` | Manifest `plan` |
| `randomizationSeed` | string | Manifest `plan`; paired order is derived deterministically from this seed and `repetitionIndex` |

`externalFixtureHash` is required but `null` in v1, because v1 uses no external
systems ([§5.2](#52-external-systems)); a non-null value is admissible only when a
future adapter defines it.

A qualification campaign has no accepted or candidate artifact. Its canonical
artifact identity enters the closed identity through the `canonical` treatment
definition hash and the manifest treatment record, and the record repeats the
pinned `{id, digest, root, entryPoint}`. It never occupies the `accepted` or
`candidate` field, so a moving product baseline cannot masquerade as canonical.

Canonical form and digest:

- serialize the identity object as UTF-8 JSON with keys sorted by Unicode code
  point, no insignificant whitespace, arrays in declared order, and integers in
  shortest round-trip form;
- normalize strings to Unicode NFC and record digests as lowercase hex;
- serialize an absent optional identity field as `null`, so absent and explicit
  `null` are one value and never two identities;
- `identityDigest` is the lowercase-hex SHA-256 of that canonical serialization.

Equality rule: two executions share an identity if and only if their
`identityDigest` values are equal. Equality is total. There is no relaxed match: no
case-only or model-only equality, no case-insensitive identifier or path comparison,
no digest prefix comparison, no path aliasing, and no "equivalent after rebuild"
exception.

`--resume` may reuse a stored result only when all of the following hold:

1. the stored `identityDigest` equals the planned identity digest;
2. the stored record is complete and readable ([7.7](#77-atomic-persistence-and-partial-writes));
3. the stored record's effective validity is `valid` ([7.6](#76-execution-outcome-and-validity));
4. no later attempt exists for the same identity.

`--retry-timed-out` is the one explicit exception to rule 3: a timed-out attempt is
otherwise valid evidence, so only that flag may send its slot back to execution. It
writes the next attempt ordinal and leaves the timeout in place for inspection.

One differing field satisfies none of these conditions. The stored result is
retained, is not reused, is not deleted, and is not evidence for the new identity. If
the difference contradicts a comparison predeclared before execution, the affected
slots are invalid under
[strategy §8.1.4](./mcp-evaluation-strategy.md#814-invalidation-rules); if the
difference was predeclared, it defines a new plan and a new campaign or stage.

Comparison identity. Two results may enter one paired comparison only when their
identities are equal after removing `treatment.id`, `treatment.kind`,
`treatment.definitionHash`, `treatment.mcpSurfaceHash`, `repetitionIndex`, and
`artifacts.candidate`. `artifacts.accepted` stays compared, because a paired
comparison requires one accepted baseline across every treatment ([strategy
§8](./mcp-evaluation-strategy.md#8-acceptance-gates)). Their `components` values and
`claimClass` must also be equal. A report that cannot establish this rejects the
pairing instead of merging the results.

### 7.4 Schema versioning and version-1 compatibility

`schemaVersion` is a string `MAJOR.MINOR`. The first version is `1.0`. A reader
implements one major version and every minor version of it.

Additive change, minor increment:

- adds an optional field with a documented default or documented absence semantics;
- adds metadata that no existing field's meaning, unit, or recomputation depends on;
- keeps every closed enum, identity path, canonicalization rule, and required field
  unchanged.

Breaking change, new major:

- removes, renames, or re-types a field, or changes a unit or the meaning of an
  existing value;
- adds a required field;
- adds a member to a closed enum (`outcome`, telemetry `state`, `defects`,
  `checks.*.result`, `claimClass`);
- changes the identity field set, the canonical serialization, or the digest
  algorithm;
- changes the inputs a derived value is recomputed from.

Reader rules:

- a reader ignores unknown fields, never fails on them, and never reinterprets them
  as a known concept;
- a reader accepts a record missing an optional field and applies the documented
  default; when no default is documented, every metric that depends on the field is
  `unavailable`, never guessed;
- a reader fails closed on a missing required field, a wrong type, an unknown enum
  member, an unknown major version, or a failed integrity check; a failed read is not
  evidence;
- a reader never rewrites, upgrades, patches, or re-serializes a stored result. An
  in-place migration is never permitted, and a schema change that would require
  rewriting stored results is breaking by definition.

Resume requires an equal major version. Minor differences are harmless only because
they cannot change identity; a minor change that did change identity would be
breaking under the rule above.

A new major version requires a new campaign directory. Results from different major
versions are retained read-only, are never re-graded, and never merge into one
report. Version-1 results remain readable and recomputable after any additive change
and are never converted to a later shape.

### 7.5 Telemetry availability states

Every entry in `telemetry` is `{value, state, unit, source}`. `state` is one of
three closed values, and the entry is present even when the value cannot exist.

| State | Meaning | Permitted use |
| --- | --- | --- |
| `exact` | The source reported the value and the harness recorded it without transformation or estimation. | Any claim that uses only `exact` values, reported with its sample count. |
| `unavailable` | The source did not report the value, or the reported value was unparseable. | Only claims that exclude this metric. The execution stays valid for every other metric. |
| `not-applicable` | The metric cannot exist for this execution by construction. | No claim. Excluded from the metric's set, and never counted as zero. |

The required metric keys are `inputTokens`, `outputTokens`, `reasoningTokens`,
`cacheReadTokens`, `cacheWriteTokens`, and `reportedCost` ([§8](#8-metrics)). Cache
reads and cache writes remain separate entries.

Rules:

- `not-applicable` covers structural absence, such as token metrics in a model-free
  execution or a post-run check the case does not declare. When a source was expected
  to report a value and did not, the state is `unavailable`.
- `unavailable` never invalidates the execution, the outcome, or any other metric. It
  invalidates the claim that needs the value, and nothing else. An execution is
  invalid rather than non-claimable only when it exists solely to produce that metric
  ([strategy §8.1.4](./mcp-evaluation-strategy.md#814-invalidation-rules),
  [§8.1.7](./mcp-evaluation-strategy.md#817-stop-rules) S3).
- Never estimate tokens or cost from bytes, characters, context windows, another
  repetition, another treatment, another model, or a local price table. A reported
  cost is `exact` only when the provider reported it.
- A sum of token components is claimable only when every component it includes is
  `exact`. The uncached input + output + reasoning total required by the Q2 token gate
  is one such sum ([strategy §8](./mcp-evaluation-strategy.md#8-acceptance-gates)).
- Harness-measured quantities, including `wallTimeMs` and `bytes`, need no state
  because the harness measures them directly. A missing harness measurement is an
  incomplete record ([7.7](#77-atomic-persistence-and-partial-writes)), never an
  `unavailable` metric.

### 7.6 Execution outcome and validity

`outcome` is a closed enum. Every outcome produces an inspectable record.

| Outcome | Meaning | Claimable | Retry |
| --- | --- | --- | --- |
| `completed` | The agent process ended per the declared success condition and grading ran. | Yes, per metric state. | No. |
| `failed` | Non-zero exit, execution error, or a harness-recorded failure class. Events captured before the failure are retained. | Yes, as a failure. | No; it triggers the matching stop rule ([strategy §8.1.5](./mcp-evaluation-strategy.md#815-failed-slot-only-retry)). |
| `timed-out` | The declared `case.timeoutMs` elapsed and the process was terminated. Events up to termination are retained. | Yes, as a failure of correctness and of the wall-clock budget. | No. |
| `aborted` | The harness or operator stopped the execution before evidence was complete, for example a recorded budget stop. | No. | Conditional; a new attempt requires a recorded cause under strategy §8.1.5. A stop-rule abort does not authorize a retry. |

`defects` is a closed list of harness-detected causes projected from
[strategy §8.1.4](./mcp-evaluation-strategy.md#814-invalidation-rules):
`artifact-mismatch`, `model-mismatch`, `prompt-agent-mismatch`,
`revision-case-mismatch`, `configuration-mismatch`, `treatment-mismatch`,
`missing-telemetry`, and `dirty-isolation`. The strategy table is
authoritative; this list only names the field values a record may carry. A result
with a non-empty `defects` array is never a pass.

`missing-telemetry` is recorded only when the execution exists solely to produce the
missing metric ([7.5](#75-telemetry-availability-states)). In every other case the
missing value is `unavailable`, no defect is recorded, and the affected claim alone
is withdrawn.

Validity is a property of the evidence, not of the result, so a stored result is
never edited to become invalid. A later invalidation is appended once to the
campaign's invalidation journal as an immutable entry keyed by `identityDigest` and
`attempt`, carrying the §8.1.4 cause and the decision context. The effective validity
is `valid` only when the outcome carries evidence (`completed`, `failed`, or
`timed-out`), the record has no defects, and the journal holds no entry for it.
Reports join the journal; they never rewrite a result.

### 7.7 Atomic persistence and partial writes

A result is atomic and append-only.

- Write to a temporary file in the destination directory, flush, then rename to the
  final name. Never write in place, never append, never truncate an existing result.
- A record is a valid result only when every required field is present, its types
  match, `identityDigest` recomputes from `identity`, and `integrity.contentDigest`
  recomputes from the canonical record without that field.
- Any record failing one of those checks is not a result and not evidence. It is not
  an invalid execution and receives no §8.1.4 cause. `--resume` treats its slot as
  missing, reports exclude it, and it may be quarantined for diagnosis only.
- A retry writes a new record at `attempt + 1` and retains the earlier attempt beside
  it. At most one attempt per identity may be effectively valid, because a valid
  execution is final ([strategy §8.1.5](./mcp-evaluation-strategy.md#815-failed-slot-only-retry));
  a retry is admissible only while no attempt is valid. `--resume` selects the highest
  attempt that is complete, readable, and effectively valid. `--retry-timed-out` makes
  a timed-out highest attempt pending retry without discarding it. When no attempt is
  valid, the slot is pending retry and needs a named cause before it runs. Two
  effectively valid attempts for one identity are a harness defect, invalid under
  `configuration-mismatch` for both.
- A second complete write for an existing `identityDigest` and `attempt` is a harness
  defect, handled as an isolation or artifact failure
  ([strategy §8.1.7](./mcp-evaluation-strategy.md#817-stop-rules) S5), not as a silent
  overwrite.
- An `aborted` record is complete and inspectable but carries no grade; it occupies
  its attempt ordinal and does not satisfy the slot.

### 7.8 Report recomputability

A derived report is recomputable when every number it states follows from the
campaign's retained results and frozen inputs under the recorded component versions,
with no model call, network access, or evaluation workspace.

The campaign therefore retains every result record with its referenced files, the raw
event streams, the frozen suite manifest and the case files it references, the
treatment definitions, and the recorded component versions. A `checks` entry retains
its `evidenceRef`; the post-run check retains its command identity and exit status.
Check output containing source text stays restricted
([7.9](#79-redaction-retention-and-public-evidence)).

Rules:

- a report states `campaignId`, the `identityDigest` values of its sources, the
  `schemaVersion` values it read, and the component versions it used; a document that
  cannot state them is not a report;
- recomputing under a changed component version produces a new labelled derived
  document; the earlier document is retained and is never silently corrected;
- a report never fills a gap by re-executing a model, imputing a value, or borrowing a
  value from another execution;
- when raw retention ends, the report remains valid as a historical statement but is
  marked as no longer independently recomputable
  ([7.9](#79-redaction-retention-and-public-evidence)).

### 7.9 Redaction, retention, and public evidence

Every persisted field carries one of three classes.

| Class | Rule |
| --- | --- |
| `open` | May appear in a derived report and in public evidence after review. |
| `restricted` | Retained only inside the private result directory. Never enters a derived report as text, and never public. |
| `never-persisted` | Must be removed or replaced before the record is written. A retained occurrence is a harness defect. |

| Material | Class |
| --- | --- |
| Identity digests, suite IDs/versions/hashes, case IDs/hashes, model identity, artifact identifiers and digests, schema and component versions, counts, metric values with state, sample counts, gate results, stop-rule IDs | `open` |
| Prompts, case titles, expected/context/forbidden file lists, grading fixtures | `restricted` |
| Raw agent events, normalized call sequences, final answer text, bounded stderr, source excerpts, tool-output text | `restricted` |
| Absolute paths, checkout root, campaign-local store path | `restricted`; rewritten to `<workspace>` at capture where possible |
| Hostname, operator account, session identifiers | `restricted`; stripped or replaced with a stable placeholder at capture; never public |
| Credentials, authorization headers, cookies, tokens, environment values | `never-persisted` |

Capture-time rules:

- rewrite the checkout root and any known absolute prefix to `<workspace>` before a
  record is written;
- strip authorization headers, cookies, and token-shaped values; replace environment
  values with their key names;
- treat a credential discovered after persistence as a recorded defect: delete the
  affected raw artifact and re-run the execution. Never publish or cite it.

Retention expectations:

- raw restricted material and the private result directory live outside the public
  repository and are retained while the claim they support is live, and until a newer
  complete campaign supersedes it or the claim is withdrawn;
- a campaign-local client database is deleted when the campaign completes
  ([§5.1](#51-opencode-client-state));
- sanitized derived reports and the identity digests they cite are retained after raw
  material is deleted, with the recomputability marker from
  [7.8](#78-report-recomputability) set accordingly;
- deletion is a policy action on private material only. It never edits a result.

Public evidence minimum. A public issue or report may state, and needs no more than:

- the campaign ID, suite ID/version/hash, and case IDs with their hashes;
- the pinned model identity, agent identity, treatment IDs, and artifact identifiers
  with digests;
- the harness, schema, and component versions, and the `claimClass`;
- per-case and per-class per-treatment values with their telemetry state and sample
  count, plus the declared statistic;
- gate results, stop-rule IDs, and the identity digests of the supporting results.

Public evidence must not contain credentials, prompts, corpus text, source excerpts,
transcripts, answer prose, absolute paths, hostnames, or operator identifiers. A
public claim remains bounded by the claim class of the evidence it cites
([strategy §1.2](./mcp-evaluation-strategy.md#12-claim-authority)); identity and
retention never widen it.

## 8. Metrics

Per run:

- correctness and test outcome;
- tool-output bytes by category;
- provider input/output/reasoning/cache tokens, without attributing them to one
  tool;
- wall time;
- search/load/index calls;
- files and source lines returned;
- duplicate exact-range reads;
- broad or whole-file reads;
- stale and error responses;
- intervention count.

Per index generation:

- build time, peak memory, database size;
- artifact reuse ratio;
- symbol and reference precision samples;
- edge precision by evidence class;
- unresolved and ambiguous ratios;
- drift-state counts, when applicable.

### 8.1 Workflow policy

Normalize nested and top-level tool calls into one ordered event sequence. Evaluate
policy against normalized tool identity, validated input, output bytes, duration,
status, and position.

Normalization admits the flat `{type: "tool_use", part}` envelope and the raw server
`{type: "message.part.updated", properties: {part}}` envelope, including tool parts
nested inside another tool part's `parts`. Every call retains its exact tool name,
family, status, validated input object, UTF-8 output bytes, reported duration, error
text, raw event line, and parent position. Unknown and failed calls stay in the
sequence. Lines that are not valid JSON events retain their line number, and a
truncated final line never discards the events that preceded it.

Supported predicates should include:

- required and forbidden tools;
- first retrieval tool;
- maximum total, index, search, read, and database calls;
- maximum output bytes by tool family;
- elapsed-time and token limits;
- required input fields and forbidden broad query shapes;
- duplicate source reads;
- fallback after a successful authoritative index result.

Classify broad searches structurally from their path/include scope, not from a
query-string heuristic. Version and test the classifier. Workflow compliance,
answer correctness, process success, and telemetry validity remain separate
results.

Every check exposes a `pass`, `fail`, or `unevaluated` result with auditable
assertions. A predicate whose measurement is unavailable is `unevaluated`, never a
pass and never a zero. A first-retrieval predicate ignores non-retrieval calls before
it. Duplicate reads compare one exact validated input, so distinct ranges are not
duplicates. A fallback predicate counts retrieval calls after a successful
authoritative index result with non-empty output. A broad search is one with no scope
or an unbounded effective scope; a bounded path or include narrows the search, so it
stays bounded even when the other scope is recursive.

### 8.2 Adapter-specific case classes

**v1 admits only the TypeScript language-navigation and dependency usage/impact rows.**
The remaining rows are deferred requirements for future adapters and must not be
presented as v1 coverage or pooled with TypeScript results.

The corpus should grow one independently runnable case at a time:

| Class | Required ground truth |
| --- | --- |
| Language navigation | Language-service or reviewed declaration/reference set |
| Dependency usage/impact | Reviewed direct edges and bounded transitive paths |
| SQL and PL/SQL source units | Exact byte ranges and expected unit kinds/names |
| Oracle live metadata | Disposable-schema dictionary snapshot and reviewed objects |
| PL/Scope | Known calls/statements plus explicit unavailable-coverage cases |
| Drift | Paired source/live fixtures for every state and ambiguous mapping |
| ORDS routing | Sanitized configuration/live metadata with expected route targets |
| Cross-language impact | Reviewed complete chains plus dynamic and ambiguous residue |

Exact/high confidence classes are graded for precision separately. Unresolved and
ambiguous sites are expected outputs, not automatic failures; a case fails when the
adapter hides or misclassifies them.

The primary success criterion is lower retrieval payload with no correctness loss.
Token reduction is secondary because provider context accounting cannot reliably
attribute tokens to individual retrieval calls.

## 9. Architecture

Split responsibilities while retaining one public command:

| Module | Responsibility |
| --- | --- |
| Suite loader | Load, validate, hash, and resolve suites and case references |
| Case schema | Case selection and versioning |
| Treatments | Treatment definitions and equivalence checks |
| Runner | Plan ordering, isolated execution, restoration, resume |
| Events | Parse agent events and expose token availability |
| Tool calls | Normalize top-level and nested calls |
| Workflow | Evaluate declarative workflow predicates |
| Checks | Correctness assertions and post-run checks |
| Results | Atomic persistence and complete run identity |
| Report | Aggregates, paired comparisons, compatibility reads |

Keep modules combined when the resulting interface remains deep.

## 10. Verification

Unit tests:

- schema acceptance and rejection for every version;
- deterministic case/tag selection and empty-selection errors;
- stable hashing and complete resume identity;
- canonical identity serialization yields one digest, and every identity field
  change yields a different digest;
- unknown result fields are ignored, and a missing optional field resolves to its
  documented default or to `unavailable`;
- each telemetry state admits only the claims documented for it, and a state outside
  the closed set is rejected;
- an unknown member of any closed enum is rejected;
- top-level and nested tool normalization;
- exact token extraction and missing-token invalidation;
- every workflow predicate, including broad-search boundaries;
- correctness/workflow separation;
- paired comparison compatibility checks;
- version-1 result and report compatibility.

Integration tests use temporary fixture workspaces:

- one selected case invokes exactly the planned treatment/repetition set;
- local qualification fixes `no-index`, one canonical artifact, three paired repetitions,
  rejects a model comparison when any non-model identity changes, and rejects a missing,
  unpinned, or digest-mismatched canonical artifact;
- interruption followed by `--resume` neither repeats nor skips work;
- edits from one run cannot reach the next run;
- mismatched revision, model, prompt, bundle, or configuration is rejected;
- a single identity field change prevents reuse and plans the slot as missing;
- a partial or digest-mismatched result file is treated as absent, never as invalid
  evidence, and a complete result is never overwritten;
- a failed-slot retry retains the invalid attempt beside its replacement;
- a derived report recomputes every value from retained events and frozen inputs;
- timeout and malformed events create inspectable failed results;
- `--list` and `--dry-run` start no MCP or agent process;
- a successful, failed, or timed-out execution leaves the normal OpenCode session
  database unchanged;
- an execution starts without a session inherited from a previous repetition;
- mismatched database/ORDS fixture identity is rejected;
- treatments observing different external-system snapshots are rejected;
- cleanup detects invalid or unexpected database objects.

Acceptance requires one real draft case run through the production MCP entry. Do
not freeze a case from mocked event streams alone.

## 11. Adding a case

1. Create one draft case with a stable ID, focused prompt, scope, correctness checks, and
   explicit gates.
2. Add it to one draft suite at a pinned revision.
3. Run `--list` and `--dry-run`; resolve every validation warning.
4. Run the candidate treatment once for diagnosis.
5. Fix the product, instructions, case, or checks according to the raw trace; do
   not weaken a gate to obtain green output.
6. Run all required treatments with the suite's repetition count.
7. Inspect raw traces and the paired report.
8. Freeze the case only when correctness and workflow results are stable and the
   baseline remains a fair comparison.

A case is complete when another developer can run it individually, reproduce its
result from a clean checkout, and explain every grade from retained evidence.

## 12. Privacy

Field classes, retention, and the minimum public evidence are defined in
[§7.9](#79-redaction-retention-and-public-evidence). This section states the rule a
reviewer applies.

- Never publish corpus content, prompts, transcripts, or stored results without
  explicit review.
- Keep result directories outside the public repository.
- Strip credentials, request values, and absolute user paths before persisting
  derived reports.
- Treat raw agent traces as sensitive: they may contain source excerpts.
- Retain raw material only as long as the claim it supports is live, and never treat
  deletion of raw material as a correction of a published number
  ([§7.8](#78-report-recomputability)).

## 13. Tier, gate, and stop-rule enforcement

The strategy's
[§8.1 execution contract](./mcp-evaluation-strategy.md#81-execution-contract-tiers-order-invalidation-retry-and-stop-rules)
owns tiers E0–E3, the mandatory stage order, gate results, invalidation rules,
failed-slot retry, gate immutability, and stop rules. This document supplies mechanics
only; it neither defines nor reinterprets a gate.

| Contract obligation | Harness mechanism |
| --- | --- |
| G-E0 case, suite, and planned-run validation | Case schema validation, `--list`, and `--dry-run` reject before any model process ([§4](#4-case-schema), [§6](#6-cli-shape)) |
| G-E1 complete-route comparison | The `route` command drives the published entry through the official MCP client with a declared complete-route plan. It records every call, exact-answer equality, complete-route bytes and time, separated core query time, and contract probes ([§8.1](#81-workflow-policy)) |
| Gate immutability | Frozen suites reference immutable case hashes; changing a frozen case requires a new suite version ([§3.2](#32-suite)) |
| Run identity and mismatch invalidation | Run manifest identity; `--resume` matches the complete identity; mismatched revision, model, prompt, bundle, or configuration is rejected ([§6](#6-cli-shape), [§7.3](#73-run-identity-and-resume-equality), [§10](#10-verification)) |
| Isolation and restoration | Dedicated checkout, ephemeral client state, atomic persistence, restoration after every execution ([§5](#5-isolation), [§5.1](#51-opencode-client-state)) |
| Treatment equivalence | Treatment definitions record every difference; equivalence checks reject non-equivalent treatments ([§3.3](#33-treatment), [§9](#9-architecture)) |
| Historical local diagnostic and regression | `local-diagnostic` and `local-regression` retain the old candidate-comparison mechanics and historical verdicts. They are not the model-qualification gate ([§7.2](#72-run-manifest)) |
| Local-model qualification | `qualification` runs the fixed 18 × 2 × 3 plan with `no-index`, the digest-pinned canonical artifact, and predeclared criteria. It fails closed on an identity or canonical-artifact mismatch, changes only the model environment across comparable campaigns, and writes a local-model-scoped record with no release authority ([§7.2](#72-run-manifest)) |
| Hosted release stage | Policy requires a passing same-suite, same-revision, same-artifact model-free report, the pinned hosted reference and runtime, the fixed 18 × 3 × 5 plan, and `release-campaign.json` with hosted authority. Local qualification is not a precondition ([§7.2](#72-run-manifest)) |
| Exposure comparison | The `exposure` command pins one artifact, model, client, tariff, ordinary tools, fixed cases, and core-query route; proves both request-1 surfaces; reconciles every provider request; and records a paired direct/Code-Mode decision without re-grading certification ([PROD-004 evidence](../evaluation/audits/exposure-eval-050.md)) |
| Telemetry validity | Exact token extraction with availability status; missing usage invalidates the affected metric, never estimated from bytes ([§2](#2-goals), [§7.5](#75-telemetry-availability-states)) |
| Failed-slot-only retry | One immutable result per execution identity; `--resume` neither repeats nor skips a completed slot; failed and invalid executions stay inspectable ([§6](#6-cli-shape), [§7.6](#76-execution-outcome-and-validity), [§7.7](#77-atomic-persistence-and-partial-writes)) |
| Stop rules | The harness records pass, fail, or invalid per execution with raw evidence. Applying a stop rule is a reviewer decision, not a harness verdict |

Harness behaviour that contradicts this table is a harness defect. Fix the harness; do not
relax the contract.
