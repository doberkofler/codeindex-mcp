# CodeIndex Q2 evaluation harness

Private, repeatable A/B evaluation of the CodeIndex MCP server against a plain
retrieval baseline, implementing the method in
`codeindex-mcp/documentation/evaluation-harness.md`.

Everything here stays private: cases, prompts, transcripts, and results live
outside the published package.

## What it measures

One controlled comparison per suite:

| Arm | Treatment |
| --- | --- |
| `baseline` | Same agent system prompt, same model, no `codeindex` MCP server configured. |
| `indexed` | Same agent system prompt plus the `codeindex` retrieval policy, MCP server configured. |

Both arms run in identical detached worktrees of the same pinned revision, with
the same `node_modules`, the same built `dist`, and the same agent definition.
Only one file differs:

- `.opencode/opencode.jsonc` — present in `indexed`, absent in `baseline`.

The agent prompt and the user prompt are byte-identical across arms, so the
treatment is exactly the availability of the codeindex server.

The indexed server sets `codemode: false` so its tools are exposed directly as
`codeindex_*` provider tools. OpenCode's default Code Mode routes every call
through `execute` plus a `search` discovery helper, which added 6-11 KiB per run
and made the earlier campaign a measurement of that wrapper rather than of the
index.

## Repository layout

```
harness.json                 subject repository path
evaluation/suites/q2.json    suite manifest (model, revision, reps, arms, cases)
evaluation/cases/*.json      one case per file
src/                         harness (Node 26 native TypeScript, no dependencies)
workspaces/{baseline,indexed}
results/<run-id>/            immutable per-run results plus report.json
```

## Case and suite schema

Both document types require `schemaVersion: 1` and reject unknown fields. Case
IDs, suite IDs, tags, and file lists are validated before a workspace is
prepared. Hashes use canonical JSON, so object key order never changes an
identity.

A suite starts as `draft`. A `frozen` suite must pin every referenced case with
`caseHashes`:

```json
{
	"schemaVersion": 1,
	"id": "q2-real-task",
	"version": 5,
	"status": "frozen",
	"revision": "fed1b6e",
	"model": "deepseek/deepseek-flash",
	"repetitions": 5,
	"arms": ["baseline", "indexed"],
	"cases": ["locate-schema-version"],
	"caseHashes": {
		"locate-schema-version": "<64-character lowercase hex>"
	}
}
```

Loading a frozen suite recomputes each case hash and refuses changed content.
Changing a frozen case requires a new suite version.

## Commands

```bash
node src/cli.ts check    --suite evaluation/suites/q2.json
node src/cli.ts list     --suite evaluation/suites/q2.json
node src/cli.ts evaluate --suite evaluation/suites/q2.json --dry-run
node src/cli.ts evaluate --suite evaluation/suites/q2.json \
	--case locate-schema-version --repetitions 1
node src/cli.ts evaluate --suite evaluation/suites/q2.json
node src/cli.ts report   --run <run-id>
node --test src/*.test.ts
```

`--list` and `--dry-run` validate schemas and print the plan without starting a
model or MCP process. `--resume` skips executions whose result file already
exists and matches the run identity (suite hash, selected cases, plan hash,
model, revision, arms, repetitions, harness version).

Each execution retries internally up to six times with jittered exponential
backoff, and 5 s of pacing separates executions (`EVAL_PACE_MS`). A retry is
never a repetition: the accepted attempt is the recorded result, and every
attempt is retained with its raw event stream under `results/<run>/raw/`.

## Answer contract

Every prompt ends with the same contract, so grading is deterministic:

```json
{"files": ["<repo-relative path>", ...], "absent": false}
```

`absent` must be `true` only when the repository contains nothing that answers
the question.

## Grading

- **success** — every `expectedFiles` entry is named, no `forbiddenFiles` entry
  is named, and `absent` is false.
- **false absence** — `absent` is true on a case with expected files.
- Malformed or missing JSON is a failure, and an unparseable answer is recorded
  with its reason rather than silently scoring zero.

Correctness and workflow are reported separately. Workflow gates are
`maxTotalCalls`, `maxOutputBytes`, and optional `requiredFirstTool`.

## Telemetry validity

A run is invalid, not failed, when the agent emitted no token usage, timed out,
exited non-zero, or the workspace contained an authored change. Invalid runs are
excluded from aggregates and counted in the report.

## Metrics

Per run: tool calls with per-call output characters, summed output characters,
input/output/reasoning/cache tokens, cost, wall time, and exit status.

Per arm: success rate, index-usage rate, median output bytes, median tool calls,
median tokens, and p95 wall time over valid runs.

`indexCalls` counts direct `codeindex_*` tool calls and code-mode calls whose
script references `codeindex.`.

## Q2 thresholds

Taken verbatim from the publication policy:

1. no case loses correctness against baseline;
2. indexed success at least 90%;
3. indexed false absence at most 2% and never above baseline;
4. median output bytes at least 10% lower than baseline;
5. median tool calls not higher than baseline;
6. median tokens at most 1.05x baseline;
7. p95 wall time at most 1.2x baseline.

`report.json` records each threshold with its measured value and pass state.

## Isolation and restoration

Both arms are detached git worktrees of the subject repository at the pinned
revision. Before every execution the harness restores the arm workspace
(`git checkout -- .`, `git clean -fd`) and asserts no authored change remains.
`node_modules` is a symlink to the subject checkout's installed tree; `dist` is
copied from the subject build so the indexed MCP entry runs the same artifact.

`PWD` is set to the workspace for the child process because OpenCode resolves
project configuration from `PWD` rather than the spawn working directory.

## Corpus

Twelve cases over the subject repository at the pinned revision, four per class:

| Case | Class |
| --- | --- |
| `locate-schema-version` | locate |
| `locate-read-symbol-tool` | locate |
| `locate-stale-file-error` | locate |
| `locate-result-size-guard` | locate |
| `impact-build-generation-references` | impact |
| `impact-hash-content-references` | impact |
| `impact-bounded-paged-result-references` | impact |
| `impact-schema-version-references` | impact |
| `impl-result-limit-default` | implementation |
| `impl-analytics-append` | implementation |
| `impl-worker-dispatch` | implementation |
| `impl-generation-publish` | implementation |

The four impact cases ask for consumers of one symbol, because direct
`find_dependencies` usage covers external package targets only. Expected files
were verified against the pinned revision with `find_symbol` and
`find_references`.

## Model

`deepseek/deepseek-flash`: paid endpoint of the same model family, reports exact
token usage and cost, and calls tools. Both arms use the same model and
revision, as the policy requires.

The free `opencode/deepseek-v4.1-flash-free` variant was used for the first
campaign and then hit a provider-side quota (`provider.free-limit`, retry after
roughly 16 hours), so the suite moved to the paid endpoint.

OpenCode exposes MCP tools only through its code-mode `execute` tool. That
wrapper duplicates each result inside its envelope and the model often calls the
`search` discovery helper, which alone returns 8-11 KiB. The harness measures
that cost rather than correcting it, because it is what the agent actually
consumes.
