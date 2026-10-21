# Evaluation

Controlled evaluation of the CodeIndex MCP server against retrieval baselines.
The method is specified in
[`documentation/evaluation-harness.md`](../documentation/evaluation-harness.md).

| Directory | Contents |
| --- | --- |
| `harness/` | Runner, schemas, isolation, normalization, grading, and reporting code |
| `cases/` | Public synthetic and repository cases with exact ground truth |
| `fixtures/` | Reviewed disposable workspaces used by controlled cases |
| `suites/` | Public suite manifests |
| `corpora/` | Pinned corpus manifests, including the selected external repository |
| `audits/` | Recorded E0 case and truth review notes |
| `reports/` | Reviewed aggregate reports safe for publication |

Generated material is never committed:

- `artifacts/` — staged accepted and candidate packages;
- `workspaces/` — isolated subject checkouts;
- `results/` — raw events, transcripts, and per-run results.

Private corpora, proprietary source, hidden cases, and restricted traces stay in
a separate private data repository. Only reviewed aggregate evidence from this
directory may be cited publicly.

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
node evaluation/harness/src/cli.ts evaluate --suite suites/release.json --dry-run
```

It contains 18 cases: four locate, six impact, six semantic, and two
implementation cases. Every case is pinned by SHA-256 in
[`suites/release.json`](suites/release.json). The freeze record, revision, corpus
manifests, pattern coverage, and expected runtime are in
[`audits/frozen-suite-e0.md`](audits/frozen-suite-e0.md).

The frozen six-case calibration subset is listed and validated with:

```bash
node evaluation/harness/src/cli.ts list --suite suites/calibration.json
node evaluation/harness/src/cli.ts evaluate --suite suites/calibration.json --dry-run \
  --treatment no-index,accepted --repetitions 1
```

A local smoke run executes those six cases with `no-index` and `accepted`
treatments at one repetition, for 12 executions.

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
