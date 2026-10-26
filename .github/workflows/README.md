# Verification workflows

Pull-request verification is `CI` (`.github/workflows/ci.yml`), which invokes only
`pnpm verify:pr`. It has a 10 min job budget including checkout, dependency install, and
commitlint. Nightly and stable/release checks are deliberately outside that gate, so a
scheduled-only failure can never block a pull request and no slow class runs twice in the
pull-request path.

`verify:pr` keeps its 2 min reference-machine budget locally. The hosted pull-request
runner is slower and more variable, so `ci.yml` declares a 5 min budget of its own through
`CODE_INDEX_TEST_BUDGET_MS`. The measured hosted run of 2026-10-22 took 217 s with all
743 tests passing, so the reference budget was the only failure. A hosted budget never
weakens a local or reference-machine check; it records that the measurement does not
transfer.

The test classes and failure interpretation are owned by
[Codebase testing strategy §6–§7](../../documentation/codebase-testing-strategy.md#6-target-workflows)
and the [maintainer guide](../../documentation/maintainer-guide.md#7-performance-verification).
This page records the operational contract beside the workflow definitions.

## Runner profiles

| Workflow | Runner | Reference platform |
| --- | --- | --- |
| `ci.yml` | `ubuntu-latest` | none; `CODE_INDEX_TEST_BUDGET_MS` declares a hosted budget |
| `stable.yml` | `ubuntu-24.04` | pinned GitHub-hosted image |
| `nightly.yml` | `self-hosted`, `macOS`, `ARM64`, `codeindex-reference` | Apple M5 Max, 64 GB, macOS 27.0.1 |
| `release.yml` | `ubuntu-latest` publish job; `stable.yml` for verification | as `stable.yml` |

Node.js 26 and pnpm 12 are installed by the workflow, not by the runner image.

`stable.yml` is pinned to `ubuntu-24.04` so a hosted image update cannot silently change
the reference platform. Absolute latency, memory, storage, plan, and correctness gates
always apply. Relative regression gates are capped to warnings whenever the retained
reference was produced on another platform or architecture, so the first Linux run
establishes the Linux reference and later runs compare Linux against Linux.

The nightly performance claims remain bounded to the declared self-hosted profile. Moving
that reference to other hardware requires new retained evidence.

## `nightly.yml`

**Trigger:** daily at 03:17 UTC and `workflow_dispatch` with a generated profile.

**Contents:** generated-corpus performance, pinned-public-corpus performance and
compatibility, and the TypeScript language-service differential.

**Commands:** `codeindex-cli benchmark`, `codeindex-cli benchmark-suite`,
`codeindex-cli benchmark-prepare`, and `qualify:typescript:fixture:built`. These are the
existing commands; the workflow adds no second harness.

**Budget:** 480 min total. The generated job is bounded at 120 min and the pinned-public
job at 360 min. Each job and long step declares `timeout-minutes`; an overrun fails the
workflow.

**Reference:** the generated job downloads the newest successful run of the same profile
as `--reference` when one exists. The pinned-public suite uses the committed external
baseline and its retained first run. A missing previous artifact is a warning, not a
failure.

**Artifacts:** `nightly-generated-<run-id>` and `nightly-public-<run-id>`, retained 30
days. Only the JSON report, evaluation sidecars, Markdown summaries, suite manifest,
qualification report, and run context are uploaded. Logs, generated corpora, databases,
dependency checkouts, and work directories are excluded.

**Failure meaning:**

| Failed observation | Class from strategy §7 | Interpretation |
| --- | --- | --- |
| Generated or pinned-public gate | **Performance gate** | Runtime or resource regression, corpus incompatibility, or an invalid deep-cursor plan |
| TypeScript differential | **Semantic qualification** | Adapter divergence from compiler truth |
| Checkout, prepare, install, or build | **Static verification** | Environment or build defect, not a benchmark result |

A failed nightly identifies its class in `$GITHUB_STEP_SUMMARY` and in `context.json`
inside the uploaded artifact.

## `stable.yml`

**Trigger:** `workflow_dispatch`, or `workflow_call` from `release.yml`.

**Contents:** retained-reference comparisons, operational soak, and the deterministic
system class that owns built-process and multi-process lifecycle evidence.

**Commands:** `pnpm verify:release`, `codeindex-cli benchmark` twice, `codeindex-cli soak`,
and `pnpm test:system`. The second benchmark run uses the first as its retained reference;
when a previous stable artifact exists, the first run also uses its last report. These are
the existing commands; the workflow adds no second harness.

**Budget:** 360 min. The job timeout fails the workflow when the budget is exceeded; the
benchmark, soak, and system steps have their own step budgets.

**Artifacts:** `stable-evidence-<run-id>`, retained 90 days. Only benchmark reports,
evaluation sidecars, Markdown summaries, soak reports, and run context are uploaded. Logs,
workspaces, and databases are excluded.

**Failure meaning:**

| Failed observation | Class from strategy §7 | Interpretation |
| --- | --- | --- |
| Retained-reference or absolute gate | **Performance gate** | Regression against the retained report or a violated absolute gate |
| Soak or built-process lifecycle | **Deterministic system** | Wiring, worker, watcher, restart, recovery, or process-lifecycle defect |
| Verify, build, or qualification | **Static verification** or **Semantic qualification** | Build/tool defect or adapter divergence |

A reference-platform or architecture mismatch downgrades relative gates to warnings, as
the maintainer guide specifies. Absolute gates and invalid deep-cursor plans still fail.

## `release.yml`

**Trigger:** push of a `v*` tag.

**Contents:** calls `stable.yml` first and publishes the GitHub release only after stable
verification passes.

**Budget:** 375 min total (360 min stable, 15 min publish).

**Artifacts:** stable evidence as declared above; the publish job uploads nothing.

**Failure meaning:** stable failures keep their class from the table above. A publish-step
failure is a release-packaging defect, not a test-class result.

## Artifact contract

Every uploaded artifact is bounded to the files listed above. The staging step replaces the
workspace root, runner temporary directory, and home directory with `<workspace>`,
`<runner-temp>`, and `<home>`. Benchmark, evaluation, soak, suite, and qualification
records contain measurements, relative paths, hashes, versions, and gate results; they do
not contain credentials, tokens, environment values, or source text.

Never upload an entire evidence directory: suite logs record command lines and working
directories, and generated workspaces and databases contain source and derived data.
