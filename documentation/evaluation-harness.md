# Controlled Evaluation Harness

**Status:** proposed methodology
**Scope:** repeatable comparisons of agent work with and without the code index

This document describes an evaluation method, not a shipped component. The
public package contains no corpus, grading data, model transcripts, or runner.
A private harness may implement this method while launching the installed MCP
executable.

## 1. Decision

Use a case-oriented harness rather than ad-hoc prompts. Keep workspace
isolation, event capture, exact token accounting, grading, restoration, resume
support, and immutable result directories. Add declarative cases, individual
selection, per-case gates, configurable arms, and a fast diagnosis loop.

Do not build a second runner. The harness must invoke the production MCP entry,
not import implementation internals.

## 2. Goals

The harness must:

- add a use case without editing orchestration code;
- validate and list cases before starting a model run;
- run one case, a tagged subset, or a complete suite;
- compare the same prompt, model, revision, permissions, and repetition
  schedule across arms;
- capture exact model input/output tokens, wall time, tool calls, tool output
  bytes, errors, final answer, and correctness;
- enforce workflow gates such as maximum calls, forbidden broad searches,
  required first tool, or maximum index bytes;
- preserve raw events so every aggregate can be audited and recalculated;
- restore the dedicated checkout after every arm and repetition;
- resume interrupted runs without mixing incompatible suite, model, revision,
  arm, or harness versions;
- support one-case, one-repetition diagnosis before a full comparison.

The harness does not infer token counts from bytes. A run requiring token metrics
is invalid when the client does not emit usage. It also does not use MCP analytics
as a substitute for the full agent event stream, because MCP cannot observe
fallback tools or model turns.

## 3. Cases, suites, and arms

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
- arm definitions;
- harness and MCP artifact identities.

Frozen suites reference immutable case hashes. Changing a frozen case requires a
new suite version, not an in-place edit.

### 3.3 Arm

An arm defines one treatment. At minimum:

| Arm | Setup |
| --- | --- |
| baseline | Current tools and instructions, index tools denied |
| indexed | Baseline plus index tools allowed |

Additional arms may add a lexical-search adapter, a CLI-only treatment, or a
different instruction set. Arm definitions are data and must record every
difference that could affect the result.

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

## 5. Isolation

Each execution uses a dedicated checkout:

1. Resolve the suite revision.
2. Verify the checkout is clean and at exactly that revision.
3. Verify the MCP artifact and required dependencies.
4. Write one isolated agent configuration for the selected arm.
5. Run the agent with the case prompt.
6. Capture events, stderr, status, timeout, and wall time.
7. Grade correctness and workflow.
8. Persist the raw result atomically.
9. Restore tracked edits and remove non-ignored unversioned files.

If no VCS is available, use a disposable copy and a content manifest instead of a
revision. Record which isolation mode was used.

## 6. CLI shape

```bash
# Discover cases without model calls
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json --list

# Validate schemas, workspace, artifacts, and planned runs
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json \
	--case dependency-usage --dry-run

# Fast diagnosis: one case, one arm, one repetition
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json \
	--case dependency-usage --arm indexed --repetitions 1

# Controlled comparison
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json \
	--case dependency-usage --arm both --repetitions 5

# Tagged subset
node dist/evaluation.mjs evaluate --suite evaluation/suites/example.json \
	--tag compact-output --arm both
```

Selection rules:

- repeated `--case` values form an ordered union;
- repeated `--tag` values use intersection;
- case and tag filters combine by intersection;
- an empty selection is an error;
- `--list` and `--dry-run` start no model process;
- `--resume` matches the complete run identity, not only case/arm/repetition.

## 7. Result contract

Write one immutable JSON result per execution plus a run manifest.

The manifest records suite and case hashes, optional revision, model, agent
version, MCP artifact hash, Node/platform identity, selected arms, repetitions,
and harness schema version.

Each result records:

- raw agent events and bounded stderr;
- normalized tool-call sequence;
- exact input/output tokens and cost, with availability status;
- wall time and tool durations;
- output-byte totals by tool family;
- correctness assertions and evidence;
- workflow assertions and evidence;
- process exit, timeout, and post-run check result.

Reports provide per-run values and, when repetitions permit, median, p95, range,
and paired arm delta. Never report a percentile from one observation without the
sample count.

A case is promotable only when every correctness run passes and its configured
workflow gates pass at the declared statistic.

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

The primary success criterion is lower retrieval payload with no correctness loss.
Token reduction is secondary because provider context accounting cannot reliably
attribute tokens to individual retrieval calls.

## 9. Architecture

Split responsibilities while retaining one public command:

| Module | Responsibility |
| --- | --- |
| Suite loader | Load, validate, hash, and resolve suites and case references |
| Case schema | Case selection and versioning |
| Arms | Arm definitions and treatment-equivalence checks |
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
- top-level and nested tool normalization;
- exact token extraction and missing-token invalidation;
- every workflow predicate, including broad-search boundaries;
- correctness/workflow separation;
- paired comparison compatibility checks;
- version-1 result and report compatibility.

Integration tests use temporary fixture workspaces:

- one selected case invokes exactly the planned arm/repetition set;
- interruption followed by `--resume` neither repeats nor skips work;
- edits from one run cannot reach the next run;
- mismatched revision, model, prompt, bundle, or configuration is rejected;
- timeout and malformed events create inspectable failed results;
- `--list` and `--dry-run` start no MCP or agent process.

Acceptance requires one real draft case run through the production MCP entry. Do
not freeze a case from mocked event streams alone.

## 11. Adding a case

1. Create one draft case with a stable ID, focused prompt, scope, correctness checks, and
   explicit gates.
2. Add it to one draft suite at a pinned revision.
3. Run `--list` and `--dry-run`; resolve every validation warning.
4. Run the indexed arm once for diagnosis.
5. Fix the product, instructions, case, or checks according to the raw trace; do
   not weaken a gate to obtain green output.
6. Run both arms with the suite's repetition count.
7. Inspect raw traces and the paired report.
8. Freeze the case only when correctness and workflow results are stable and the
   baseline remains a fair comparison.

A case is complete when another developer can run it individually, reproduce its
result from a clean checkout, and explain every grade from retained evidence.

## 12. Privacy

- Never publish corpus content, prompts, transcripts, or stored results without
  explicit review.
- Keep result directories outside the public repository.
- Strip credentials, request values, and absolute user paths before persisting
  derived reports.
- Treat raw agent traces as sensitive: they may contain source excerpts.
