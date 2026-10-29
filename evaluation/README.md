# Evaluation

Controlled evaluation of CodeIndex against no-index and accepted-artifact
baselines. The normative mechanics are in the
[evaluation harness contract](../documentation/evaluation-harness.md); the
frozen economic and validity requirements are in
[`evaluation-validity-v2.json`](contracts/evaluation-validity-v2.json).

## Current result

EVAL-037 records **RELEASE** for the pinned impact-class population under native
direct MCP. The primary sample is underpowered at the frozen design alternative;
the holdout is descriptive and does not enlarge the release population.
PROD-004 measured Code Mode at `1.307` direct cost (upper `1.473`), so native
direct MCP remains recommended.

Authoritative evidence:

- [certification report](reports/certification-eval-037.json);
- [exposure report](reports/exposure-eval-050.json);
- [frozen certification design](certifications/impact-certification-v1.json);
- [frozen exposure design](exposures/direct-vs-code-mode-v1.json);
- [frozen validity contract](contracts/evaluation-validity-v2.json).

## Repository contents

| Directory | Classification | Current purpose |
| --- | --- | --- |
| `harness/` | Executable harness | Runner, isolation, metering, grading, and reporting |
| `cases/`, `fixtures/`, `suites/` | Executable fixtures | Frozen tasks, truth, workspaces, and suite composition |
| `routes/` | Current contract | Complete model-free routes |
| `contracts/`, `certifications/`, `exposures/`, `pilots/` | Current contracts | Frozen validity and campaign designs |
| `references/`, `environments/`, `tariffs/` | Executable fixtures | Pinned model, runtime, host, and price identities |
| `reports/` | Current evidence | Reviewed reports backing current claims |
| `audits/` | Integrity-pinned evidence | Inputs whose paths and digests are embedded in current frozen records |
| `corpora/` | Current fixtures | Pinned external-corpus manifests |

Git is the archive for completed campaign narratives, interruption records,
superseded policies, and obsolete identities. Generated artifacts, workspaces,
raw results, prompts, and model responses are never committed.

## Gate responsibilities

| Gate | Variable under test | Authority |
| --- | --- | --- |
| Model-free route | Candidate artifact | Mandatory mechanical architecture precondition |
| Local-model qualification | Pinned local model and fixed canonical artifact | Local model capability only |
| Hosted release | Candidate artifact under the pinned frontier model | Authoritative architecture/release verdict |

Evidence supports only its declared adapter, population, model, artifact, and
claim class. Local qualification neither authorizes nor blocks a hosted release.

## Commands

Model-free validation:

```bash
pnpm eval:list
pnpm eval:check --dry-run
pnpm eval:verify
node evaluation/harness/src/cli.ts preflight --suite suites/release.json
node evaluation/harness/src/cli.ts route --suite suites/release.json --dry-run
```

Local smoke and qualification dry runs:

```bash
node evaluation/harness/src/cli.ts smoke \
  --suite suites/calibration.json \
  --environment environments/ollama-qwen3-8b-smoke.json \
  --dry-run

node evaluation/harness/src/cli.ts qualification \
  --suite suites/qualification.json \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --canonical canonical-artifact.json \
  --dry-run
```

The post-certification exposure command uses the frozen direct-versus-Code-Mode
design and requires a matching model-free route report:

```bash
node evaluation/harness/src/cli.ts exposure \
  --suite suites/exposure.json \
  --design exposures/direct-vs-code-mode-v1.json \
  --hosted-reference references/deepseek-flash-exposure-2026-10-25.json \
  --route-report <results/route/.../report.json> \
  --provider-auth-env DEEPSEEK_API_KEY
```

Any command that starts a hosted model requires explicit approval of an effort
forecast before its first provider request. Complete all model-free checks first,
reuse valid retained evidence, resume interrupted campaigns, and rerun only
invalid executions. See
[hosted-model spend approval](../documentation/evaluation-harness.md#14-hosted-model-spend-approval).

## Storage and privacy

The external state root contains staged artifacts, isolated workspaces, index
databases, and raw results. Select it with `EVALUATION_STATE_ROOT`; otherwise the
harness uses a disposable directory outside the checkout. A path inside the
primary checkout is rejected.

Private corpora, proprietary source, hidden cases, raw traces, prompts,
credentials, and restricted results stay outside this repository. Only bounded,
reviewed aggregate evidence supporting a current claim is committed.
