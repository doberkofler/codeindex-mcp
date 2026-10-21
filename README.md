# CodeIndex Q2 evaluation harness

Private, repeatable evaluation of the CodeIndex MCP server against a plain
retrieval baseline and against the currently accepted CodeIndex artifact,
implementing the method in
`codeindex-mcp/documentation/evaluation-harness.md`.

Everything here stays private: cases, prompts, transcripts, artifacts, and
results live outside the published package.

## Treatments

Every campaign declares exactly three treatments:

| Treatment | Tools and artifact |
| --- | --- |
| `no-index` | The same ordinary retrieval tools; no CodeIndex MCP server. |
| `accepted` | The same ordinary tools plus the accepted CodeIndex artifact. |
| `candidate` | The same ordinary tools plus the candidate CodeIndex artifact. |

The treatment definitions are data in the suite. They declare the exact
ordinary tool names, the generic `execute` policy, the artifact identity, and
the MCP server configuration. A treatment definition is hashed, and the
canonical treatment set participates in run identity.

All treatments run in detached worktrees of the same pinned revision, with the
same `node_modules`, the same built `dist` used to stage artifacts, and one
byte-identical agent definition. The generated `.opencode/opencode.jsonc`
differs only in whether a CodeIndex artifact is configured, and which artifact
it is. `accepted` and `candidate` differ only by artifact and the resulting
CodeIndex interface.

## Equivalence

Before a campaign starts, the harness validates the treatment set. It rejects a
stage when:

- a treatment is missing or duplicated;
- the ordinary tool list differs between treatments;
- the generic `execute` policy differs between treatments;
- the MCP server or `codemode` policy differs between CodeIndex treatments;
- a `no-index` treatment declares an artifact or MCP server;
- a CodeIndex treatment omits its artifact or MCP server.

Suite parsing rejects these mismatches before any workspace or process is
prepared. Run identity also includes model, revision, case prompts and
timeouts, shared configuration, repetitions, and the ordered plan, so a change
to any comparable field yields a different identity.

## Tool surface capture

Before the first model call, the harness captures the exact tool-name list
presented for each treatment:

- ordinary names come from the validated treatment definition;
- CodeIndex names come from the artifact's native `tools/list` response and are
  recorded under the server prefix OpenCode presents (`codeindex_*`);
- every name is sorted and hashed into the treatment's `toolSurface`.

The manifest and every result record the surface. Every observed tool call is
classified as ordinary, native CodeIndex, generic `execute`, or unknown. Any
tool outside the captured surface is recorded and makes the execution invalid.
Generic `execute` and `search` are disabled in every treatment; a call to either
is recorded and fails the report.

## Repository layout

```
harness.json                 subject repository path
evaluation/suites/q2.json    suite manifest (model, revision, reps, treatments, cases)
evaluation/cases/*.json      one case per file
artifacts/{accepted,candidate}/dist artifact trees, staged locally and ignored by Git
src/                         harness (Node 26 native TypeScript, no dependencies)
workspaces/{no-index,accepted,candidate}
results/<run-id>/            immutable per-run results plus report.json
```

## Case and suite schema

Cases require `schemaVersion: 1`. Suites require `schemaVersion: 2`. Both reject
unknown fields. Case IDs, suite IDs, tags, file lists, and treatment definitions
are validated before a workspace is prepared. Hashes use canonical JSON, so
object key order never changes an identity.

A suite starts as `draft`. A `frozen` suite must pin every referenced case with
`caseHashes`:

```json
{
	"schemaVersion": 2,
	"id": "q2-real-task",
	"version": 6,
	"status": "frozen",
	"revision": "fed1b6e",
	"model": "deepseek/deepseek-flash",
	"repetitions": 5,
	"treatments": [
		{
			"id": "no-index",
			"kind": "no-index",
			"ordinaryTools": ["bash", "glob", "grep", "list", "read"],
			"codeMode": "absent",
			"artifact": null,
			"mcp": null
		},
		{
			"id": "accepted",
			"kind": "codeindex",
			"ordinaryTools": ["bash", "glob", "grep", "list", "read"],
			"codeMode": "absent",
			"artifact": {
				"id": "codeindex-mcp-accepted",
				"root": "artifacts/accepted",
				"entryPoint": "mcp.mjs"
			},
			"mcp": {"server": "codeindex", "codemode": false}
		},
		{
			"id": "candidate",
			"kind": "codeindex",
			"ordinaryTools": ["bash", "glob", "grep", "list", "read"],
			"codeMode": "absent",
			"artifact": {
				"id": "codeindex-mcp-candidate",
				"root": "artifacts/candidate",
				"entryPoint": "mcp.mjs"
			},
			"mcp": {"server": "codeindex", "codemode": false}
		}
	],
	"cases": ["locate-schema-version"],
	"caseHashes": {
		"locate-schema-version": "<64-character lowercase hex>"
	}
}
```

Loading a frozen suite recomputes each case hash and refuses changed content.
Changing a frozen case requires a new suite version.

## Staging artifacts

Artifact roots are relative to this harness and must be complete runnable
packages: `package.json`, `mcp.mjs`, every chunk it imports, and resolvable
dependencies. A packaged release already has this shape. For a local build, stage
one build per side:

```bash
mkdir -p artifacts/accepted artifacts/candidate
cp -R <accepted-build>/dist/. artifacts/accepted/
cp <accepted-build>/package.json artifacts/accepted/
ln -s <accepted-build>/node_modules artifacts/accepted/node_modules
cp -R <candidate-build>/dist/. artifacts/candidate/
cp <candidate-build>/package.json artifacts/candidate/
ln -s <candidate-build>/node_modules artifacts/candidate/node_modules
```

`artifacts/` is ignored by Git. The MCP entry point is `mcp.mjs` inside each
staged tree. `candidate` normally comes from the current subject build; `accepted`
comes from the released artifact under evaluation.

## Commands

```bash
node src/cli.ts check    --suite evaluation/suites/q2.json
node src/cli.ts list     --suite evaluation/suites/q2.json
node src/cli.ts evaluate --suite evaluation/suites/q2.json --dry-run
node src/cli.ts evaluate --suite evaluation/suites/q2.json \
	--case locate-schema-version --treatment candidate --repetitions 1
node src/cli.ts evaluate --suite evaluation/suites/q2.json --treatment all
node src/cli.ts evaluate --suite evaluation/suites/q2.json \
	--campaign-store /tmp/codeindex-campaign/client.db
node src/cli.ts report   --run <run-id>
node --test src/*.test.ts
```

`--treatment` accepts `all`, one treatment, or a comma-separated subset.
`--list` and `--dry-run` validate schemas and print the plan without starting a
model or MCP process. `--resume` reuses a stored result only when its full
identity digest and treatment definition hash match the planned slot.
`--campaign-store` opts into one campaign-local client database; without it the
campaign is fully ephemeral. The path is resolved against the run directory, is
rejected inside OpenCode's normal data directory, and is recorded in the run
manifest.

Each execution retries internally up to six times with jittered exponential
backoff, and 5 s of pacing separates executions (`EVAL_PACE_MS`). A hard timeout
is not retried: it is the recorded outcome of its slot. A retry is never a
repetition: the accepted attempt is the recorded result, and every attempt is
retained with its raw event stream under `results/<run>/raw/`.

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
exited non-zero, called a tool outside the captured surface, called generic
`execute`, or the workspace contained an authored change. Invalid runs are
excluded from aggregates and counted in the report.

## Metrics

Per run: tool calls with per-call output characters, summed output characters,
input/output/reasoning/cache tokens, cost, wall time, exit status, the captured
tool surface, and observed routing including unknown tools.

Per treatment: success rate, index-usage rate, median output bytes, median tool
calls, median tokens, p95 wall time, invalid and retried runs, and counts of
`execute` and unknown-tool runs.

## Q2 thresholds

Taken verbatim from the publication policy and applied to candidate versus
no-index:

1. no case loses correctness against no-index;
2. candidate success at least 90%;
3. candidate false absence at most 2% and never above no-index;
4. median output bytes at least 10% lower than no-index;
5. median tool calls not higher than no-index;
6. median tokens at most 1.05x no-index;
7. p95 wall time at most 1.2x no-index.

The report also requires candidate correctness non-inferiority against accepted,
no generic `execute` call in any treatment, and no unknown tool in any
treatment. `report.json` records each threshold with its measured value and pass
state.

## Isolation and restoration

Every treatment is a detached git worktree of the subject repository at the
pinned revision. Before every execution the harness restores the treatment
workspace (`git checkout -- .`, `git clean -fd`), re-applies the generated
treatment configuration, and asserts no authored change remains.
`node_modules` is a symlink to the subject checkout's installed tree; `dist` is
copied from the subject build so the workspace can run repository commands.

`PWD` is set to the workspace for the child process because OpenCode resolves
project configuration from `PWD` rather than the spawn working directory.

### OpenCode client state

Every execution starts `opencode run --standalone` with an explicit
`OPENCODE_DB`, so it never contacts the shared background service and never
reads or writes `~/.local/share/opencode/opencode.db`:

- the default store is `OPENCODE_DB=:memory:`, which gives every execution an
  empty session database that disappears with the private server;
- `--campaign-store <path>` selects one campaign-local SQLite file for resume or
  post-run inspection, records it in `run.json`, and rejects any path inside
  OpenCode's data directory (`XDG_DATA_HOME/opencode` or
  `~/.local/share/opencode`);
- no execution passes `--continue`, `--session`, or `--fork`, so a repetition
  cannot inherit a prior session;
- stdout and stderr are captured from the process pipes until the private
  server exits; an in-memory database is never inspected afterwards.

The agent runs as a process-group leader. The hard timeout is
`case.timeoutMs`: the harness sends `SIGTERM` to the whole group, escalates to
`SIGKILL` after two seconds, and stops waiting for stdio close after a bounded
grace period. A timed-out execution is terminal for its slot and is written as
an inspectable result with `outcome: "timed-out"`, `timedOut: true`, a null exit
code, and the captured partial stream. Every result records `outcome`,
`isolationMode`, `clientStore`, `timeoutMs`, and the exit signal.

The run manifest records the same isolation decisions under `isolation` and
`campaignStore`, so a reviewer can reconstruct the client-store mode without
reading a result. A failed, timed-out, or successful execution cannot replace
the published generation of the normal session database.

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
token usage and cost, and calls tools. Every treatment uses the same model and
revision, as the policy requires.

The free `opencode/deepseek-v4.1-flash-free` variant was used for the first
campaign and then hit a provider-side quota (`provider.free-limit`, retry after
roughly 16 hours), so the suite moved to the paid endpoint.

## Native routing

The CodeIndex server is configured with `codemode: false`, so its tools are
presented directly as `codeindex_*` provider tools. Generic `execute` and
`search` are disabled in every treatment. The harness verifies the artifact's
native tool catalog before the first model call and records every observed tool
name, so a regression to Code Mode routing is visible as a report failure rather
than an unexplained payload increase.
