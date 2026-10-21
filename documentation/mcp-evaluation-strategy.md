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
state. Do not compare a candidate with historical model runs.

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

Prompts, grading data, raw traces, model responses, and private results stay outside this
public repository. Only reviewed aggregate evidence may be committed.

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
- `ollama/gemma4:31b-mlx`.

They may run the complete harness, but their results describe those models only. They do
not replace acceptance evidence for a different target model.

Use local models for:

- harness and case smoke tests;
- prompt and grading diagnosis;
- cheap one-repetition change diagnostics;
- frequent regression sentinels;
- identifying gross interface regressions before paid runs.

Calibrate the 27B and 35B models first. Use the 8B model only for harness smoke until it
proves adequate; evaluating every discovered model is unnecessary. A local model
qualifies for prechecks only when a frozen six-case, two-treatment calibration produces
12 valid executions, has no correctness loss, needs no intervention, and completes
within 15 minutes on the evaluation machine. Pin model digest, quantization, Ollama
version, OpenCode version, agent instructions, tool list, context, generation settings,
and hardware.

If exact token telemetry is unavailable, correctness, calls, bytes, and latency remain
usable, but the token gate is invalid. Never estimate missing usage from bytes.

The hosted reference model for the next suite remains open until local calibration is
complete. Select one capable hosted model, record the decision, and pin its exact identity
for that suite. Changing it requires a new complete paired baseline. Q2 v4's
`deepseek/deepseek-flash` result remains historical evidence, not an automatic selection.

## 11. Cheap workflow

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
