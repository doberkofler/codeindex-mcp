# Model-free route plans

A route plan declares the complete minimum route from one case question to its
exact answer for each treatment. It is the executable form of E1 in
[the evaluation strategy](../../documentation/mcp-evaluation-strategy.md#4-evidence-layers):

- `text` is the ordinary retrieval route used by `no-index`;
- `codeindex` is the route used by the accepted and candidate artifacts, and may
  mix native `codeindex_*` calls with ordinary reads when the index cannot answer;
- every step is ordered, bounded, and retained in the report;
- cursor pages, readiness polls, source reads used for filtering, and fallback
  searches all count toward the complete route.

No model is called. A plan is pinned to one suite identity and must cover exactly
that suite's cases, so changing a declared route changes the plan hash and cannot
reuse earlier evidence.

## Running

```bash
node evaluation/harness/src/cli.ts route --suite suites/release.json --dry-run
node evaluation/harness/src/cli.ts route --suite suites/release.json
```

`--treatment` accepts `all`, one treatment, or a comma-separated subset.
`--case` and `--tag` select a subset of the plan. `--plan` overrides the default
`routes/<suite-id>.json`. `--output` selects an explicit report directory; the
default is a new timestamped directory under `evaluation/results/route/`.

The command requires the subject checkout to be clean at the suite revision and
the accepted and candidate artifacts to be staged under `evaluation/artifacts/`.
A `--dry-run` validates the suite, plan, case coverage, and step syntax without
creating a workspace or starting an MCP process.

## Report

`report.json` records:

- every case's expected and observed answer set for each treatment;
- every complete-route call with its tool, page, status, response bytes,
  elapsed time, and server-reported core query time;
- per-treatment medians for calls, bytes, elapsed time, and core time;
- `G-E1a` exact answer equality, `G-E1b` complete measurement with separated
  core query time, and `G-E1c` pagination, truncation, stale-file, and failure
  probes for each artifact.

The stale-file probe mutates one indexed declaration, observes the refusal, and
restores the workspace before the command continues. Generated reports,
workspaces, and artifacts stay outside version control.

## Per-case project files

A route may declare `projectFile` when its case lives in a separate TypeScript
project, such as the controlled semantic fixture. The artifact is then started
with `CODE_INDEX_PROJECT_FILE` set to that file, so the compared CodeIndex route
indexes the project the case actually asks about.
