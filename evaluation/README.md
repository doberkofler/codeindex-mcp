# Evaluation

Controlled evaluation of the CodeIndex MCP server against retrieval baselines.
The method is specified in
[`documentation/evaluation-harness.md`](../documentation/evaluation-harness.md).

| Directory | Contents |
| --- | --- |
| `harness/` | Runner, schemas, isolation, normalization, grading, and reporting code |
| `cases/` | Public synthetic and repository cases with exact ground truth |
| `suites/` | Public suite manifests |
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

The subject defaults to this repository root. Override it with
`evaluation/harness/harness.json`:

```json
{"subjectRepo": "/path/to/another/checkout"}
```

`EVALUATION_ROOT` overrides the data directory, which is otherwise this
`evaluation/` directory.
