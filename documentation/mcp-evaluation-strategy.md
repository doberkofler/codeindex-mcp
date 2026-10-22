# MCP Usefulness and Performance Evaluation Strategy

Date: 2026-10-21

Status: accepted evaluation plan. Existing accepted gates in
[the publication-policy redesign](./codeindex-publication-policy-redesign.md) remain
normative. This document defines how to produce the evidence needed to judge the MCP
server as a product.

The companion [controlled evaluation harness](./evaluation-harness.md) describes runner
mechanics. The separate [codebase testing strategy](./codebase-testing-strategy.md)
describes implementation tests. Passing codebase tests is necessary, but is not evidence
that the MCP server helps an agent.

## 1. Purpose

The evaluation must answer one question:

> Does access to CodeIndex let an agent complete realistic repository tasks at least as
> correctly, with less retrieval work, lower context cost, and acceptable latency?

The answer must remain explainable by task class, model, tool sequence, and MCP response.
Aggregate success alone is insufficient.

### 1.1 Evaluation scope

> **Evaluation v1 scope.** Evaluation v1 covers only the TypeScript/JavaScript
> adapter, using the TypeScript language service or a reviewed source manifest as
> the ground-truth authority. Oracle, PL/SQL, ORDS, drift, cross-language impact,
> and every other adapter are out of scope. TypeScript evidence must not be
> pooled with, or generalized to, another adapter, language, or repository
> population.

The same statement is normative in the
[evaluation harness](./evaluation-harness.md#scope-and-claim-boundary). A future
adapter requires its own cases, truth source, corpus manifest, and campaign; it
does not inherit TypeScript evidence.

### 1.2 Claim authority

Evidence supports only the claim class it was designed to test. A result inherits
the weakest claim class among its evidence.

| Claim class | Required evidence | v1 status |
|---|---|---|
| Local-model-scoped | Frozen suite; pinned local model digest, quantization, runtime, artifact, harness, hardware, and settings; the declared statistic; no pooling across models or configurations | Produced by calibration, targeted diagnostics, and local regression. Describes only the pinned local configuration. |
| Hosted-model-scoped | Frozen 18-case suite; pinned hosted model identity; all three treatments; five paired repetitions; every accepted Q2 gate; paired-by-case 95% intervals | Deferred release authority. Describes only the pinned hosted configuration and the evaluated artifact. |
| Model-independent | Hosted-model-scoped evidence replicated on at least two independently selected model families, each with a pinned identity and its own paired baseline, with the same gates passing | Not produced by v1. No v1 document may assert it. |

Claim rules:

- Adapter scope and model scope are independent: every claim class remains
  TypeScript-only in v1.
- Local evidence may reject an interface or detect a regression. It cannot satisfy
  a hosted release gate or support a model-independent claim.
- A hosted campaign evaluates one pinned model, agent, artifact, prompt set, and
  tool surface. Changing any of them requires a new paired baseline.
- Never pool models, treatments, task classes, or historical runs to manufacture a
  broader claim. Report the overall verdict and class-stratified verdicts
  separately.
- Missing required telemetry invalidates the affected metric, not the remaining
  measurements. Limit the claim to the metrics that remain valid.
- Run identity, evidence retention, and the sanitized evidence a public claim may
  cite are defined by the
  [harness result contract](./evaluation-harness.md#7-result-contract). Resume
  requires identical run identity; a paired comparison requires the comparison
  identity defined there.
- The Q2 v4 result remains evidence only for its recorded configuration.

## 2. Non-goals

This evaluation does not:

- prove implementation correctness through line or branch coverage;
- use unit tests as evidence of agent usefulness;
- treat tool adoption as success;
- treat model preference as semantic correctness;
- infer agent behavior from MCP analytics, which cannot observe fallback tools;
- use replay or simulation to pass a live-agent gate;
- weaken a failed gate after seeing results.

## 3. Evaluation dimensions

Keep these outcomes separate:

| Dimension | Question |
|---|---|
| Correctness | Did the answer contain the exact required result without false claims? |
| Retrieval usefulness | Did CodeIndex provide evidence that directly answered the task? |
| Workflow efficiency | How many searches, index calls, reads, and fallbacks were needed? |
| Payload efficiency | How many tool-output bytes, source lines, and duplicate ranges were returned? |
| Model cost | How many uncached input, output, reasoning, and cache tokens were consumed? |
| Latency | How long did the full task and each retrieval step take? |
| Reliability | Were tools available, fresh, bounded, and free of unstable errors? |
| Adoption | Did the agent select CodeIndex when it was useful, and stop when the answer was complete? |

A correct but inefficient run passes correctness and fails efficiency. Reports must never
collapse those outcomes into one boolean.

## 4. Evidence layers

### E0: case and truth validation

No model calls.

- validate every case schema and referenced workspace revision;
- verify exact expected, allowed-context, and forbidden file sets;
- verify required symbols and references against the TypeScript language service or a
  reviewed source manifest;
- run the grader against known passing and failing answers;
- reject subjective or incomplete ground truth.

### E1: model-free MCP measurements

Invoke the released MCP entry through the official client, not implementation internals.
For every claimed MCP use case, compare the complete minimum route from question to
answer. Count every grep/search/read command and every MCP call required; never compare
one isolated call while hiding setup or follow-up work. Report individual call timing
only as diagnostic detail.

Measure:

- exact answer equality for the compared routes;
- complete-route call count, response bytes, and elapsed time;
- core query time separately from MCP serialization and transport;
- response bytes and source lines;
- call count required by the interface for each known question;
- pagination and truncation;
- cold build, warm reuse, edit-to-fresh, RSS, CPU, and storage;
- stale-file and failure behavior.

These measurements explain server cost. They do not predict whether a model will choose
or use the tools correctly.

Forced comparisons are limited to capabilities where CodeIndex claims an advantage. Do
not force CodeIndex onto obvious unique-literal lookups where grep is intentionally the
right tool.

### E2: controlled agent evaluation

For a user-visible MCP change, run three treatments:

| Treatment | Tools and artifact |
|---|---|
| No index | Normal grep, glob, and read tools; no CodeIndex |
| Accepted | Identical normal tools plus the currently accepted CodeIndex artifact |
| Candidate | Identical normal tools plus the candidate CodeIndex artifact |

The no-index versus candidate comparison establishes product value. The accepted versus
candidate comparison isolates the effect of the change. Agents may choose the cheapest
available tool; MCP use is not required on tasks where ordinary search is better.

All three treatments inspect exactly the same pinned subject-repository revision. Model,
agent, prompt, permissions, context, timeout, and repetition schedule match. Only
CodeIndex availability or the selected CodeIndex artifact differs. Run all treatments in
one campaign with fresh agent sessions, randomized paired order, and restored workspace
state. Do not compare a candidate with historical model runs: only an equal
[run identity](./evaluation-harness.md#73-run-identity-and-resume-equality) permits
reuse or comparison.

Use direct native MCP with `codemode: false`. Remove generic `execute` from every
treatment, or keep it identical and report every failed or unknown-tool invocation. Do
not introduce an LSP treatment unless the client exposes a documented LSP tool.

Every execution must run against isolated OpenCode client state. Launch the agent with a
private server and an ephemeral database, for example
`OPENCODE_DB=:memory: opencode run --standalone ...`. The shared background service and
the operator's normal session database are prohibited for evaluation: each repetition
would otherwise become a visible persisted session, and later runs would inherit
unrelated history. Apply the identical isolation to every treatment; the database
setting must not differ between arms. See the
[harness isolation rules](./evaluation-harness.md#51-opencode-client-state).

### E3: operational soak

Use deterministic edit scripts and real watcher/build behavior without a model. Measure:

- event-to-fresh latency;
- repeated edits during builds;
- restart and generation reuse;
- build failures by closed cause;
- stale-source refusals;
- memory, CPU, and database growth;
- recovery without manual intervention.

Report this separately from agent-task latency.

## 5. Evaluation data

Use five complementary data classes:

| Data | Purpose | Location |
|---|---|---|
| Controlled TypeScript workspace | Exact semantic cases that lexical search handles poorly | Private evaluation workspace or reviewed disposable fixture |
| CodeIndex repository snapshot | Realistic implementation and impact tasks | Dedicated checkout at an immutable revision |
| One pinned external repository | Generalization beyond CodeIndex naming and architecture | External cache at an immutable revision |
| Private real repository | Supplementary realism and blind-spot discovery; never the reproducible release gate | Private harness only |
| Generated corpus | Repeatable scale and performance stress | Generated from a versioned profile and seed |

Every corpus manifest records:

- repository or generator identity;
- exact revision, project file, and lock hash;
- TypeScript, Node, MCP, OpenCode, and harness versions;
- case hashes;
- expected result authority;
- preparation steps;
- privacy classification;
- whether source may be mutated;
- known limitations.

Select the first external repository through a model-free pilot of TypeScript, VS Code,
and Material UI. Compare setup cost, usable semantic cases, build time, fixture stability,
and distinct evidence. Choose the cheapest repository that adds material coverage; do not
select by reputation or size alone.

The harness, public synthetic cases, suites, and grading rules may be committed
under `evaluation/`. Private corpora, proprietary source, hidden cases, raw traces,
model responses, and restricted results stay outside this public repository. Only
reviewed aggregate evidence may be committed.

## 6. Task corpus

### Classes

| Class | Required answer |
|---|---|
| Locate | Exact declaration or implementation location |
| Impact | Complete set of affected files or owners |
| Implementation | Correct source evidence needed to make a bounded change |
| Semantic | Result requiring symbol identity rather than a simple text match |

The next frozen suite should contain at least 18 cases, including at least 6 semantic
cases. Cover:

- renamed re-exports;
- multi-hop barrel chains;
- shadowed common names;
- implementations of an interface;
- type-only imports;
- references through default exports;
- multi-project context differences;
- direct dependency usage versus transitive module impact.

### Case admission

Each case owns:

- one exact prompt;
- one repository revision and scope;
- exact `expectedFiles`;
- bounded `contextFiles`;
- `forbiddenFiles` where false positives are meaningful;
- factual answer assertions;
- workflow limits;
- timeout;
- task class and semantic tags.

Locate and impact cases require an exact expected file set. `contextFiles` is a separate,
bounded allow-list; every other extra or missing file fails. Implementation cases also
require an exact allowed changed-file set and a deterministic post-run check. Prose alone
does not establish implementation correctness.

A semantic case qualifies when the best single-identifier grep has file-set precision at
most 0.5 or misses an expected file. This prevents relabeling easy lexical cases as
semantic wins.

A case is complete only when another developer can run it independently and explain every
grade from retained evidence.

## 7. Metrics

Record per execution:

- correctness assertions and exact file-set precision/recall;
- false-absence claims;
- normalized tool-call sequence;
- CodeIndex, search, glob, and read call counts;
- tool-output bytes by family;
- returned source lines and duplicate exact-range reads;
- broad or whole-file searches;
- fallback after an authoritative non-empty index result;
- uncached input, output, and reasoning tokens;
- cache-read and cache-write tokens separately;
- task wall time and tool durations;
- MCP errors, stale responses, timeouts, and interventions;
- whether CodeIndex was used and whether its result contributed to the answer.

For model-free comparisons, totals cover the complete route from the question to the
answer, not one selected command.

Record server measurements separately:

- scan, compiler, extraction, finalization, insertion, verification, and publication
  duration;
- peak RSS and CPU;
- database and artifact size;
- edit-to-fresh latency;
- generation reuse and build-failure cause.

Hard model-free latency and resource gates run on one stable reference machine. Hosted
CI performance is directional because shared-runner variance is not a precise regression
authority.

Do not compare pooled “used CodeIndex” and “did not use CodeIndex” runs. Tool routing is
confounded by task class and difficulty.

## 8. Acceptance gates

The accepted Q2 gates remain unchanged:

- at least 12 independently runnable locate, impact, and implementation cases;
- 5 paired repetitions per arm;
- identical model, prompt, revision, permissions, and external fixtures;
- no case loses correctness, and indexed success is at least 90%;
- indexed false-absence claims are at most 2% and never exceed baseline;
- median retrieval output bytes per successful case are at least 10% below baseline;
- median tool calls per successful case are not above baseline;
- median uncached input + output + reasoning tokens are at most 1.05x baseline;
- indexed p95 wall time is at most 1.2x baseline.

For candidate evaluation, apply those gates to candidate versus no index. In addition,
the candidate must:

- preserve correctness versus the accepted CodeIndex artifact;
- improve the predeclared target metric for the change;
- introduce no statistically supported regression in other metrics;
- remain inside every accepted Q2 gate.

A run with unavailable required token usage, mismatched artifacts, or fewer than five
repetitions is invalid rather than a pass. Retry only failed execution slots. Never
discard a valid execution because its result is inconvenient.

The next frozen suite contains 18 cases. With three treatments and five repetitions, one
complete hosted campaign contains 270 valid executions. Report the overall verdict and
class-stratified verdicts. Add paired-by-case bootstrap 95% intervals for every ratio.

### 8.1 Execution contract: tiers, order, invalidation, retry, and stop rules

This subsection is the authoritative execution contract. It binds the evidence layers of
[§4](#4-evidence-layers), the cheap workflow of [§11](#11-cheap-workflow), and the
accepted Q2 gates above. It adds no metric, threshold, adapter, or gate; the identifiers
below name obligations already defined in §4, §8, §10, and §11. Where §4 states what a
tier measures, this subsection states what the tier authorizes, in which order it runs,
when its evidence is invalid, and what a failure blocks.

Normative sources, in precedence order:

1. the accepted Q2 gates in
   [the publication-policy redesign](./codeindex-publication-policy-redesign.md#real-task-evaluation),
   recorded on 2026-10-20 and retained verbatim in §8 above;
2. the scope and claim authority of [§1.1](#11-evaluation-scope) and
   [§1.2](#12-claim-authority);
3. this subsection, for tier order, invalidation, retry, and stop rules;
4. the [harness](./evaluation-harness.md) for mechanics.

Every tier remains TypeScript-only per §1.1. A result inherits the weakest claim class
among its evidence per §1.2.

#### 8.1.1 Tiers

| Tier | Purpose | Cost | Allowed claim class | Normative source |
|---|---|---|---|---|
| E0 | Prove that cases, exact truth, graders, and the pinned revision are admissible before any model call | No model calls; local CPU only | None. E0 authorizes execution only and supports no product claim | §4 E0 |
| E1 | Prove that the interface can produce the exact expected answer and measure the complete minimum route | No model calls; local CPU. Latency and resource gates only on the stable reference machine | None. Measurements explain server cost and do not predict agent choice | §4 E1, §7 |
| E2 | Measure the effect of the artifact on correctness, workflow, payload, tokens, and latency with three treatments | Stage 2: four local executions. Stage 3: suite × 3 treatments × 3 repetitions, 162 executions for the 18-case suite. Stage 4: 270 hosted executions | Stages 2–3: local-model-scoped only. Stage 4: hosted-model-scoped release authority. Never model-independent | §1.2, §8, §11 |
| E3 | Measure operational reliability without a model: watcher and build, freshness, restart, generation reuse, stale refusal, resource growth, recovery | No model calls; dedicated reference machine | None alone; supplies the reliability facts a hosted claim must not contradict | §4 E3 |

| Tier | Mandatory exit gate | Failure blocks |
|---|---|---|
| E0 | G-E0 (§8.1.8) | Every model tier and every corpus change; a failed E0 rejects the campaign |
| E1 | G-E1 (§8.1.8) | Stage 2 and every later stage for the affected routes; an interface miss triggers S1 |
| E2 | G-E2D, then G-E2L, then G-E2H (§8.1.8) | Each stage blocks the next; stage 4 blocks the release claim and any statement that the change improves agent work |
| E3 | G-E3 (§8.1.8) | Stage 4 when the change touches build, watcher, publication, storage, or isolation; and any reliability claim about the artifact |

#### 8.1.2 Mandatory stage order

Stages run in this order once per suite version, case-hash set, artifact pair, model
identity, revision, and configuration. None may be reordered, merged, or run
speculatively.

| Stage | Tier | Scope | Exit gate |
|---|---|---|---|
| 0 | E0 | Case and truth validation (§4 E0) | G-E0 |
| 1 | E1, plus E3 when the change touches build, watcher, publication, storage, or isolation | Complete-route comparison for every claimed question (§4 E1) | G-E1, G-E3 |
| 2 | E2 | Two predeclared impact cases, one repetition, accepted and candidate treatments | G-E2D |
| 3 | E2 | Full suite, one fixed local model, three treatments, three paired repetitions | G-E2L |
| 4 | E2 | Frozen 18-case suite, pinned hosted model, three treatments, five paired repetitions (deferred release authority, §1.2) | G-E2H |

Rules:

- A cheaper failure blocks every more expensive stage. No aggregate, anecdote, or partial
  success at stage 3 or 4 overturns a failed stage 0, 1, or 2 (§2, §11 Before any model
  call, step 5).
- Stage 0 and stage 1 are never skipped. A change that alters no MCP response is exempt
  from stages 2–4 under §11 Release evaluation, and only after stage 1 shows the affected
  responses are unchanged. Any user-visible MCP change always requires stages 2–4.
- Changing the suite, a case hash, an artifact, the model identity, the revision, or the
  configuration creates a new comparison. Earlier stage results do not carry over
  (§1.2, §8.1.4).
- Stage 1 uses the released MCP entry through the official client. Implementation
  internals and MCP analytics are not evidence (§2, §4 E1).

#### 8.1.3 Gate results

Every gate returns exactly one of three results:

| Result | Meaning | Authorizes |
|---|---|---|
| pass | Evidence is complete and the predeclared criterion is met | The next stage only |
| fail | Evidence is valid and the predeclared criterion is not met | Nothing; it triggers the matching stop rule (§8.1.7) |
| invalid | Evidence is unusable for a cause recorded under §8.1.4 | A failed-slot retry (§8.1.5) and nothing else |

An invalid gate is never recorded as a pass. A fail is never converted to invalid by
re-measuring. A stage verdict is `pass` only when every gate in the stage passes; any
`fail` gate fails the stage, and any `invalid` gate leaves the verdict incomplete until its
slots are retried. If an invalid cause cannot be repaired inside the stage, the verdict is
not `pass`, and only the claims permitted by §1.2 may be reported.

#### 8.1.4 Invalidation rules

An execution, slot, case, metric, or stage is invalid when any condition in this table
holds. Invalidity is a property of the evidence, not of the result.

| Condition | Invalid scope | Normative source |
|---|---|---|
| Artifact mismatch: MCP artifact hash, accepted-artifact identity, or candidate-artifact identity differs from the manifest, or the two artifacts are swapped | Every slot using the affected artifact | §8, harness §7 |
| Model mismatch: model identity, digest, quantization, runtime version, or generation settings differ from the predeclaration | Every slot using the affected model | §1.2, §10 |
| Prompt or agent mismatch: case prompt, agent instructions, permissions, or context budget differ from the frozen case and treatment definition | Affected case, all treatments | §4 E2, §8 |
| Revision or case mismatch: subject revision, checkout content, case hash, suite version, or truth authority differs | Affected case or stage | §4 E0, harness §3.2 |
| Configuration mismatch: CodeIndex configuration, timeout, harness schema, Node or platform identity differs between compared executions | Affected comparison | harness §7, §8 |
| Non-equivalent treatments or tool-list mismatch: ordinary tool set, tool names presented to the model, generic `execute` availability, randomization, or external fixtures differ between treatments | Affected stage | §4 E2, harness §3.3 |
| Missing required telemetry: exact token usage for a token claim, tool-name list, normalized call sequence, wall time, or exit status is absent or unparseable | The affected metric, and the slots that carry only that metric | §1.2, harness §2 |
| Insufficient repetitions: fewer than the stage's declared repetitions | Affected slot set | §8 |
| Dirty isolation: checkout not clean or not at revision, inherited or persisted session state, shared background service used, `OPENCODE_DB` not ephemeral or campaign-local, incomplete restoration, or edits from a prior run visible | Affected execution; the stage when equivalence is broken | §4 E2, harness §5.1 |

Scope rule: invalidate the smallest unit whose evidence is defective — one execution, one
slot, one case, one measured quantity, then the stage. A shared cause invalidates every slot
that shares it. Never invalidate a whole stage for a defect confined to one slot, and never
keep a slot whose cause is shared.

#### 8.1.5 Failed-slot-only retry

A slot is the tuple (suite version, case hash, treatment, repetition index). A stage is an
ordered slot set.

- A valid execution is final. Never discard, replace, or re-run it because its result is
  inconvenient, off-trend, or contradicts the hypothesis (§2, §8).
- Retry only a slot recorded invalid under §8.1.4, and only after the exact cause is named
  and corrected. Record the cause with the retry.
- Correcting a shared cause invalidates every slot that shares it. Retry all of them or
  abandon the stage. Do not splice results produced under different preconditions into one
  stage.
- Retain the invalid record beside its replacement and report the invalidity cause. When a
  retry contradicts a valid execution, the valid execution stands and the retry is
  recorded as additional evidence.
- A failed (valid) execution is never retried; it triggers the matching stop rule. An
  uncorrected repeat of an invalid attempt is prohibited.

#### 8.1.6 Gate immutability

Gates, thresholds, cases, expected file sets, treatments, repetition counts, statistics,
and stop rules are fixed and recorded before the first execution of a stage.

- Seeing results never justifies relaxing a threshold, adding an exclusion, dropping a
  case or class, redefining a metric, raising a repetition count to average away a failure,
  or changing the declared statistic (§2, §8, harness §11 step 5).
- A defective gate is replaced only by a new predeclared policy that states the defect, the
  replacement, and the reason. The new policy governs future stages only, and it
  invalidates comparison with every result produced under the old one. Those results are
  retained as historical evidence and are not re-graded.
- Re-running a failing stage unchanged to obtain a different sample is optional stopping
  and is prohibited. A re-run requires a cause recorded before it starts: a product fix, a
  case-truth fix, or a harness fix.
- The accepted Q2 gates are retained verbatim in §8 and are not restated with any
  tolerance; §8.1.8 copies them only to map each item to its check. Changing any of them
  requires the new-policy path in this subsection.

#### 8.1.7 Stop rules

Each trigger is closed. No other observation authorizes a stop, and no trigger authorizes
advancing to a more expensive stage.

| Stop rule | Trigger | Next permitted action | Source |
|---|---|---|---|
| S1 interface miss | A stage 1 complete route for a claimed case fails exact answer equality, requires an undeclared setup call, or violates the pagination, truncation, stale-file, or error contract | Stop before any model call. Fix the interface. Re-run stage 1 for the affected routes only | §4 E1, §11, §12 |
| S2 correctness loss | Any execution loses correctness against its baseline, any case misses its exact expected file set, or an indexed run claims absence after an authoritative non-empty index result | Stop the stage. Fix the product, or return to E0 for a truth defect. Re-run from the cheapest failed stage | §8, §11 |
| S3 telemetry invalidity | A required metric lacks exact token usage, tool-name list, normalized call sequence, wall time, or exit status | Invalidate only the affected metric and slots, limit the claim to the valid metrics, re-run those slots after the harness fix. Never estimate a missing value | §1.2, §10, harness §2 |
| S4 budget overrun | A local calibration or diagnostic exceeds its declared wall-clock budget, or a stage exceeds its declared execution or spend budget | Abandon that configuration for prechecks, record no result, and select another candidate local model or abandon prechecks for this change. Do not reduce cases or repetitions to fit the budget | §10, §11 |
| S5 isolation or artifact failure | Dirty checkout, inherited or persisted session state, incomplete restoration, artifact or harness version mismatch, or non-equivalent treatments | Invalidate every affected slot, or the stage when equivalence was broken. Repair isolation and re-run the stage | §4 E2, §8.1.4, harness §5 |
| S6 statistically supported regression | A paired-by-case 95% interval for a candidate effect excludes parity in the harmful direction, or any accepted Q2 gate fails | Fail the stage. Fix or abandon the change. Do not drop the regressed metric, class, or case | §8, §11 Local regression |

#### 8.1.8 Gate-to-check map

`executable` means a named check the harness or a model-free script performs and a
reviewer can re-run. `manual review` means a named reviewer decision over retained
evidence. The harness is a proposed method and no runner ships in this repository, so an
`executable` gate without an implemented check cannot pass.

| Gate | Criterion | Kind | Enforced at |
|---|---|---|---|
| G-E0a | Case and suite schemas validate; hashes, revision, and planned runs resolve | executable | Harness case and suite validation with `--list` and `--dry-run`; starts no model process (harness §4, §6) |
| G-E0b | Exact `expectedFiles`, bounded `contextFiles`, and `forbiddenFiles` agree with the TypeScript language service or a reviewed source manifest | manual review | Recorded E0 review note per case against the language service or reviewed manifest (§4 E0) |
| G-E0c | The grader accepts known passing answers and rejects known failing answers | executable | Harness check run over retained fixture answers; repeated on every grader change (§4 E0) |
| G-E0d | A semantic case admits: best single-identifier grep precision at most 0.5 or an expected file missed | executable | Model-free grep measurement stored with the case (§6 Case admission) |
| G-E1a | Exact answer equality for the complete no-index, accepted, and candidate routes | executable | Model-free route comparison through the official client (§4 E1) |
| G-E1b | Complete-route call count, response bytes, and elapsed time, with core query time separated | executable | Model-free measurement; latency and resource comparison only on the reference machine (§7) |
| G-E1c | Pagination, truncation, stale-file, and failure behaviour match the tool contract | executable | Model-free checks against the published MCP entry (§4 E1) |
| G-E1d | Comparisons cover only cases where CodeIndex claims an advantage, with no forced unique-literal lookup | manual review | Case list reviewed before stage 1 (§4 E1) |
| G-E2D | Two impact cases, one repetition, accepted versus candidate: every candidate answer correct, target workflow improved, no observed metric regressed | executable and manual review | Harness runs exactly four executions; a reviewer judges improvement and regression from raw traces, because one repetition supports no interval (§11) |
| G-E2L | Full suite, three treatments, three paired repetitions: no correctness loss, target metric improved, no statistically supported regression in any tracked metric, no gate moved backward | executable | Harness report with per-run values, medians, and paired-by-case bootstrap 95% intervals (harness §7) |
| G-E2H | The retained Q2 gates plus the candidate-versus-accepted conditions, at five paired repetitions over 18 cases | executable and manual review | Harness campaign and report; a reviewer audits the predeclaration and confirms the named target metric before execution (§8, §11) |
| G-E3 | Closed build-failure causes, time-to-fresh, restart and generation reuse, stale refusal, resource growth, unattended recovery | executable and manual review | Scripted edit run and soak outside the harness; harness generation metrics supply build time, memory, and database size (harness §8). A reviewer confirms no manual intervention and no unrecovered failure. No numeric E3 threshold is accepted, so E3 numbers are directional |

In the retained Q2 wording, `arm` means `treatment`. The accepted Q2 thresholds are
enumerated as Q2-1 to Q2-9 for mapping only. The bullet wording and values in §8 remain
authoritative; this table adds no tolerance and no reinterpretation.

| Item | Retained threshold | Stage 4 check |
|---|---|---|
| Q2-1 | at least 12 independently runnable cases | Suite manifest and case count |
| Q2-2 | 5 paired repetitions per arm | Repetition count and slot completeness |
| Q2-3 | identical model, prompt, revision, permissions, and external fixtures | Run-manifest identity comparison (§8.1.4) |
| Q2-4 | no case loses correctness, and indexed success is at least 90% | Per-case correctness assertions and overall success ratio |
| Q2-5 | indexed false-absence claims are at most 2% and never exceed baseline | False-absence counter over truthful runs, including the authoritative-non-empty rule |
| Q2-6 | median retrieval output bytes per successful case are at least 10% below baseline | Per-case median retrieval bytes over successful cases |
| Q2-7 | median tool calls per successful case are not above baseline | Normalized call-count median over successful cases |
| Q2-8 | median uncached input + output + reasoning tokens are at most 1.05x baseline | Exact usage; cache reads reported separately; invalid without usage |
| Q2-9 | indexed p95 wall time is at most 1.2x baseline | Wall-time p95 with its sample count |

## 9. Current baseline

Q2 v4 used `deepseek/deepseek-flash`, direct native MCP, 12 cases, 5 repetitions, and 120
valid executions. Both arms were 100% correct with no false-absence claims. The indexed
arm failed every efficiency gate:

| Metric | Baseline | Indexed | Result |
|---|---:|---:|---|
| Median retrieval output | 3,268 bytes | 6,969 bytes | Fail: 2.132x |
| Median tool calls | 2 | 3 | Fail: +1 |
| Median uncached tokens | 985 | 2,508 | Fail: 2.547x |
| p95 wall time | 10.2 s | 13.8 s | Fail: 1.351x |

Only 29 of 60 indexed runs used CodeIndex. Impact cases exposed the primary interface
cost: name resolution followed by detailed references, while the expected answer was
usually a unique path set. Future work must improve that workflow before another full
campaign.

## 10. Local-model strategy

OpenCode currently discovers these local Ollama models on the evaluation machine:

- `ollama/qwen3:8b`;
- `ollama/qwen3.8:27b-mlx`;
- `ollama/qwen3.6:35b-mlx`;
- `ollama/gemma4:31b-mlx`;
- `ollama/devstral-small-2:latest` (a 24B model, pinned by digest).

They may run the complete harness, but their results describe those models only. They do
not replace acceptance evidence for a different target model.

Use local models for:

- harness and case smoke tests;
- prompt and grading diagnosis;
- cheap one-repetition change diagnostics;
- frequent regression sentinels;
- identifying gross interface regressions before paid runs.

Calibrate the 27B and 35B models first. Use the 8B model only for harness smoke until it
proves adequate; evaluating every discovered model is unnecessary. EVAL-026 replaced the
35B candidate with `ollama/devstral-small-2:latest` and records an operator exclusion when
a candidate cannot run unattended on the reference machine. An exclusion is a resource
constraint, never a model-quality conclusion. A local model qualifies for prechecks only
when a frozen six-case, two-treatment calibration produces 12 valid executions, has no
correctness loss, needs no intervention, and completes within 15 minutes on the evaluation
machine. Pin model digest, quantization, Ollama version, OpenCode version, agent
instructions, tool list, context, generation settings, and hardware.

The first pinned environment is
[`evaluation/environments/ollama-qwen3-8b-smoke.json`](../evaluation/environments/ollama-qwen3-8b-smoke.json).
The harness verifies it before the first smoke model call and refuses a changed
host, runtime, model digest, quantization, context, or generation setting. The
accepted-only smoke record is
[`evaluation/audits/local-model-smoke-e1.md`](../evaluation/audits/local-model-smoke-e1.md).

If exact token telemetry is unavailable, correctness, calls, bytes, and latency remain
usable, but the token gate is invalid. Never estimate missing usage from bytes.

When more than one model qualifies, select the regression sentinel in this fixed order:
qualifiers only, then more exact accepted answers, then lower accepted median wall time,
then lower accepted median retrieval bytes, then the model reference for a stable
tie-break. Record the decision beside the calibration decisions. A changed model artifact,
quantization, runtime, context, generation setting, host fact, or budget starts a new
calibration baseline; no earlier qualification carries over.

The hosted reference model for the next suite is pinned by
[`evaluation/references/deepseek-v4-pro.json`](../evaluation/references/deepseek-v4-pro.json):
`deepseek/deepseek-v4-pro`, provider release `2026-08-13`, OpenCode `2.1.2`, and
provider-default generation settings. The reference hash participates in campaign
identity, so changing the reference requires a new complete paired baseline. Q2 v4's
`deepseek/deepseek-flash` result remains historical evidence, not an automatic selection.

## 11. Cheap workflow

[§8.1](#81-execution-contract-tiers-order-invalidation-retry-and-stop-rules) is the
authoritative contract for tier order, gates, invalidation, retry, and stop rules. This
section describes the cheap stages that contract orders; it defines no additional gate.

### Before any model call

1. Validate suite, case hashes, revision, artifacts, tools, and graders.
2. Build a current index before task evaluation; measure cold build and edit-to-fresh in
   the separate operational workflow.
3. Run complete model-free grep, accepted-MCP, and candidate-MCP routes for the expected
   questions.
4. Confirm answer equality, complete-route size, call count, and latency.
5. Reject the campaign if the interface itself misses the expected result.

### After an interface change

Run only four local-model executions first: two impact cases, one repetition, accepted and
candidate treatments. Continue only when every candidate answer is correct, the targeted
workflow improves, and no observed metric regresses. Model-free comparison already
establishes the no-index route before these calls.

### Local smoke

Run the frozen six-case calibration with no-index and accepted treatments, one repetition,
before adopting a local model. For candidate smoke, use accepted and candidate treatments.
Use these runs for rapid regression detection, not statistical acceptance.

### Local regression

Run the full suite with a fixed local model, all three treatments, and three paired
repetitions. Track trends by class. A changed model artifact starts a new baseline. A
local regression triggers targeted diagnosis; the hosted reference remains the release
authority.

### Release evaluation

Run the frozen suite with all three treatments, the pinned hosted reference model, and
five paired repetitions before merging a user-visible MCP change. Run it only after the
model-free, targeted local, and full local checks pass. Pure refactors with unchanged MCP
responses do not require this campaign.

The `release` command implements this stage. It refuses to start a model unless a passing
model-free route report and a passing local regression cover the same frozen suite and
staged artifacts, and it refuses a runtime that differs from the pinned hosted reference.
It runs exactly 270 slots and writes a hosted-model-scoped record that accounts for every
slot as valid or invalid with a closed cause. A changed hosted reference changes the
campaign identity and requires a new paired baseline.

## 12. Change interpretation

For each MCP interface change:

1. state the expected task-level improvement before implementation;
2. name the cases and metrics expected to move;
3. pin one subject-repository revision for every treatment;
4. compare complete model-free no-index, accepted, and candidate routes;
5. run the four-execution accepted-versus-candidate diagnostic;
6. inspect raw traces before aggregating;
7. run the full three-treatment campaign only when the diagnostic passes;
8. accept the change only when correctness remains non-inferior and the targeted cost
   decreases without moving another gate backward.

A feature that increases internal semantic richness but does not improve a task is not an
evaluation win. A smaller interface that loses semantic correctness is also not a win.

## 13. Immediate priorities

1. Inventory and validate the current private Q2 cases and exact ground truth.
2. Build the three-source, 18-case suite with at least 6 mechanically admitted semantic
   cases.
3. Pilot TypeScript, VS Code, and Material UI and select one external corpus.
4. Freeze the six-case local-model calibration suite.
5. Calibrate the local 27B and 35B models under the 15-minute budget.
6. Select and pin the hosted reference model.
7. Implement and model-free-test one-call grouped reference results.
8. Run the four-execution accepted-versus-candidate impact diagnostic.
9. Run the full three-treatment campaign only after every cheaper stage passes.
