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

Development commands and local checks are owned by
[`CONTRIBUTING.md`](../../CONTRIBUTING.md). This page owns the CI, nightly,
stable, and release operational contract beside the workflow definitions.

## Runner profiles

| Workflow | Runner | Reference platform |
| --- | --- | --- |
| `ci.yml` | `ubuntu-latest` | none; `CODE_INDEX_TEST_BUDGET_MS` declares a hosted budget |
| `stable.yml` | `ubuntu-24.04` | pinned GitHub-hosted image |
| `nightly.yml` | `ubuntu-24.04` | pinned GitHub-hosted image |
| `release.yml` | `ubuntu-latest` publish job; `stable.yml` for verification | as `stable.yml` |

Node.js 26 and pnpm 12 are installed by the workflow, not by the runner image. No
self-hosted runner is required.

`stable.yml` and `nightly.yml` are pinned to `ubuntu-24.04` so a hosted image update
cannot silently change the reference platform. Absolute latency, memory, storage, plan,
and correctness gates apply. Absolute edit-to-fresh latency is the one exception:
generated corpora concentrate shared surface types, and every workspace currently
republishes a full generation per edit, so the absolute p95 is advisory and only warns.
The retained-reference ratio remains the blocking regression guard for edit latency.
Pinned public projects run edit-to-fresh in place: the edit target is appended to and
restored byte-for-byte when the scenario ends, and each run restores it through git
first, so a killed run cannot move the next measurement. A missing edit target fails
the step instead of silently skipping the gate. Each project declares its own
`editTimeoutMs`; one publication bound cannot cover a 77-file corpus and a
5,000-file corpus at the same time.
`vscode` does not run edit-to-fresh. Its 1.37 million occurrences make the in-place
revision pass exceed any budget that fits the job, and a gate that can never finish is
not a gate. The scenario stays blocking on `typescript` and `material-ui` until the
revision pass stops scaling with occurrence count. Each public project declares
`requiredScenarios` when it intentionally differs from the baseline's list, so the
status is explicit rather than a silently missing measurement.
Relative regression gates are capped to warnings whenever the retained reference was produced on
another platform or architecture, so the first run on a new platform establishes that
platform's reference and later runs compare like against like.

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

The pinned-public measurement step declares an 8 GiB `NODE_OPTIONS` heap. The build
worker inherits the parent heap limit, and the pinned VS Code project needs more than the
default limit before it reaches persistence. The value is a declared budget for the
largest pinned project on a 16 GiB runner; it is not a product default and does not
change the generated-corpus job.

**Reference:** the generated job downloads the newest successful run of the same profile
as `--reference` when one exists. The pinned-public suite uses the committed external
baseline and its retained first run. A missing previous artifact is a warning, not a
failure.

**Artifacts:** `nightly-generated-<run-id>` and `nightly-public-<run-id>`, retained 30
days. Only the JSON report, evaluation sidecars, Markdown summaries, suite manifest,
qualification report, and run context are uploaded. Logs, generated corpora, databases,
dependency checkouts, and work directories are excluded.

**Failure meaning:**

| Failed observation | Failure class | Interpretation |
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

| Failed observation | Failure class | Interpretation |
| --- | --- | --- |
| Retained-reference or blocking absolute gate | **Performance gate** | Regression against the retained report or a violated blocking absolute gate |
| Soak or built-process lifecycle | **Deterministic system** | Wiring, worker, watcher, restart, recovery, or process-lifecycle defect |
| Verify, build, or qualification | **Static verification** or **Semantic qualification** | Build/tool defect or adapter divergence |

A reference-platform or architecture mismatch downgrades relative gates to warnings.
Blocking absolute gates and invalid deep-cursor plans still fail; edit p95 is advisory.

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
