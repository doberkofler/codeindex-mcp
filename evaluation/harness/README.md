# CodeIndex evaluation harness

Repeatable evaluation of the CodeIndex MCP server against a plain retrieval
baseline and against the currently accepted CodeIndex artifact, implementing the
method in
[`documentation/evaluation-harness.md`](../../documentation/evaluation-harness.md).

The harness, public cases, suites, and reviewed aggregate reports are part of
this repository. Raw event streams, transcripts, artifacts, workspaces,
generated results, and any private corpus stay outside the published package.
This package declares `private: true`, so it is never published to a registry.

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

All treatments run in isolated workspaces of the same pinned subject: detached
worktrees when the subject is a version-control checkout, and disposable content-
manifest copies otherwise. Every treatment uses the same `node_modules`, the same
built `dist` used to stage artifacts, and one byte-identical agent definition. The
generated `.opencode/opencode.jsonc` differs only in whether a CodeIndex artifact
is configured, and which artifact it is. `accepted` and `candidate` differ only by
artifact and the resulting CodeIndex interface.

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
src/                              harness (Node 26 native TypeScript, no dependencies)
harness.json                      optional subject override, ignored by Git
../suites/q2.json                 suite manifest (model, revision, reps, treatments, cases)
../cases/*.json                   one case per file
../artifacts/{accepted,candidate}/ staged artifact trees, ignored by Git
../workspaces/{no-index,accepted,candidate}
../results/<campaign-id>/         manifest.json, run state, report.json
../results/<campaign-id>/<case>/<treatment>/rep-<n>/
                                  attempt-<n>.json and its raw event streams
../reports/                       reviewed aggregate reports
```

Paths in a suite, including `artifact.root`, are relative to the evaluation
root (`evaluation/`). The subject defaults to the repository root and can be
overridden with `harness.json` or `EVALUATION_ROOT`.

## Case and suite schema

Cases require `schemaVersion: 1`. Suites require `schemaVersion: 2`. Both reject
unknown fields. Case IDs, suite IDs, tags, file lists, and treatment definitions
are validated before a workspace is prepared. Hashes use canonical JSON, so
object key order never changes an identity.

A case declares exact ground truth, a bounded context set, and optional
declarative workflow gates:

```json
{
	"schemaVersion": 1,
	"id": "locate-schema-version",
	"title": "Schema version constant",
	"class": "locate",
	"tags": ["locate"],
	"prompt": "Which file defines SCHEMA_VERSION?",
	"scope": ["src/**"],
	"expectedFiles": ["src/core/storage/schema.ts"],
	"contextFiles": [],
	"forbiddenFiles": [],
	"workflow": {
		"maxTotalCalls": 12,
		"maxOutputBytes": 200000,
		"requiredFirstTool": null,
		"requiredTools": [],
		"forbiddenTools": [],
		"maxCallsByFamily": {"search": 4},
		"maxOutputBytesByFamily": {"search": 120000},
		"maxDuplicateReads": 0,
		"maxFallbacksAfterAuthoritative": 0,
		"maxBroadSearches": 0,
		"maxDurationMs": 180000,
		"maxTokens": null
	},
	"check": {
		"command": "node",
		"args": ["--test", "test/example.test.ts"],
		"expectedExitCode": 0,
		"timeoutMs": 120000
	},
	"timeoutMs": 180000
}
```

`expectedFiles` must be non-empty. `contextFiles` are allowed supporting
evidence, not required answers. Expected, context, and forbidden sets are
disjoint. `check` is optional and runs only for cases that declare it. Every
optional workflow field defaults to no gate except the required
`maxTotalCalls` and `maxOutputBytes`.

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

Artifact roots are relative to the evaluation root and must be complete runnable
packages: `package.json`, `mcp.mjs`, every chunk it imports, and resolvable
dependencies. A packaged release already has this shape. For a local build, stage
one build per side from the repository root:

```bash
mkdir -p evaluation/artifacts/accepted evaluation/artifacts/candidate
cp -R <accepted-build>/dist/. evaluation/artifacts/accepted/
cp <accepted-build>/package.json evaluation/artifacts/accepted/
ln -s <accepted-build>/node_modules evaluation/artifacts/accepted/node_modules
cp -R <candidate-build>/dist/. evaluation/artifacts/candidate/
cp <candidate-build>/package.json evaluation/artifacts/candidate/
ln -s <candidate-build>/node_modules evaluation/artifacts/candidate/node_modules
```

`evaluation/artifacts/` is ignored by Git. The MCP entry point is `mcp.mjs`
inside each staged tree. `candidate` normally comes from the current subject
build; `accepted` comes from the released artifact under evaluation.

## Commands

From the repository root:

```bash
pnpm eval:check
pnpm eval:list
pnpm eval:evaluate --dry-run
pnpm eval:evaluate --case locate-schema-version --treatment candidate --repetitions 1
pnpm eval:evaluate --treatment all
pnpm eval:evaluate --campaign-store /tmp/codeindex-campaign/client.db
pnpm eval:report --run <run-id>
pnpm eval:test
pnpm eval:typecheck
```

From this directory, `node src/cli.ts` accepts the same flags with
`--suite suites/q2.json`.

### Model-free complete-route comparison

`route` implements E1 without a model. It loads a declared route plan, validates
that it covers exactly the suite cases, executes the `no-index`, `accepted`, and
`candidate` routes through the same workspaces, and writes one report:

```bash
node src/cli.ts route --suite suites/release.json --plan routes/codeindex-release.json --dry-run
node src/cli.ts route --suite suites/release.json --plan routes/codeindex-release.json
```

The ordinary route is a bounded search or read. The CodeIndex route uses the
published artifact through the official MCP client, waits for `index_status` to
report a published generation, follows every cursor page, and may mix a declared
fallback search or source read when the index cannot answer. Every call is
retained. Response bytes are the returned text bytes; elapsed time is the complete
request; core query time is the artifact's reported handler duration from its
stderr diagnostics, recorded as `unavailable` rather than estimated when absent.

`G-E1a` requires exact answer equality for every selected treatment, `G-E1b`
requires a complete call, byte, elapsed, and separated core-time record, and
`G-E1c` runs pagination, truncation, stale-file, and failure probes against each
artifact. The stale-file probe changes one declaration, observes `stale_file`,
and restores the workspace. Reports are written under `results/route/`, which is
never committed.

`--treatment` accepts `all`, one treatment, or a comma-separated subset.
`--list` and `--dry-run` validate schemas and print the plan without starting a
model or MCP process. `--resume` reuses a stored result only when its complete
execution identity digest equals the planned slot's digest; any suite, case,
prompt, timeout, model, agent, treatment, subject, artifact, configuration,
harness, repetition, or randomization change defines a different identity.
`--campaign-store` opts into one campaign-local client database; without it the
campaign is fully ephemeral. The path is resolved against the run directory, is
rejected inside OpenCode's normal data directory, and is recorded in the run
manifest.

### Result records and resume

Each execution attempt is one immutable JSON document at
`results/<campaign-id>/<case>/<treatment>/rep-<n>/attempt-<n>.json`. The document
carries the complete execution identity and its digest, the campaign id, the
attempt ordinal, timing, outcome, defects, isolation, process status, telemetry,
normalized calls, grades, artifacts, and an `integrity` block. Raw stdout,
stderr, and normalized material stay beside it.

Writing is atomic: the harness writes and flushes a same-directory temporary
file, then renames it to the final name. A complete write for an existing
attempt is rejected instead of overwritten. `integrity.contentDigest` covers the
canonical record without the integrity block, and `integrity.sizeBytes` is the
exact stored byte length, so a partial, truncated, extended, or re-serialized
document is never a result.

`--resume` scans a slot's attempts from the highest ordinal and reuses the first
complete, readable, effectively valid record whose identity digest matches.
Completed, failed, and timed-out executions all satisfy their slot; an `aborted`
execution, a record with defects, a corrupt file, and every identity mismatch do
not. Corrupt attempts are treated as absent, while a record for another identity
is retained untouched and the new identity receives the next attempt ordinal.
The campaign manifest is written once and is never rewritten in place.

Readers implement schema major version 1 and accept any minor version, ignore
unknown fields, and reject a failed integrity check. A document that is not a
valid result is never evidence and never receives an invalidation cause.

Each execution retries internally up to six times with jittered exponential
backoff, and 5 s of pacing separates executions (`EVAL_PACE_MS`). A hard timeout
is not retried: it is the recorded outcome of its slot. A retry is never a
repetition: every attempt is written as its own immutable record and raw event
stream in the slot directory, and the highest complete attempt decides what a
later resume reuses.

## Answer contract

Every prompt ends with the same contract, so grading is deterministic:

```json
{"files": ["<repo-relative path>", ...], "absent": false}
```

`absent` must be `true` only when the repository contains nothing that answers
the question.

## Grading

Correctness, workflow compliance, process success, and telemetry validity are
four separate outcomes. None is folded into another.

Correctness is exact:

- **pass** — every `expectedFiles` entry is named, no `forbiddenFiles` entry is
  named, and no file outside `expectedFiles ∪ contextFiles` is named.
- **extra file** — a named file outside the expected and bounded-context sets
  fails the answer; context is permission to cite evidence, never a second
  expected set.
- **false absence** — `absent` is true on a case with expected files.
- **malformed answer** — missing JSON, wrong types, and `absent` with named
  files fail and retain their reason instead of silently scoring zero.
- Paths are normalized to repository-relative POSIX form and matched exactly.
  A suffixed or absolute path does not satisfy an expected file.

Every check records `result` (`pass`, `fail`, or `unevaluated`), a list of
`{id, kind, expected, observed, result}` assertions, and a bounded reason. A
check is `unevaluated` when the measurement it needs is unavailable, and an
unevaluated check is never a pass.

Post-run checks are declarative and deterministic. The command is spawned
without a shell in the workspace after the agent exits, with a hard timeout and
its own process group. Its result is `postRun`, separate from `grade` and
`workflow`; a failing command does not rewrite a correct answer or an invalid
process outcome. Workspace restoration removes any mutation it makes.

Workflow predicates are declarative:

- total, per-family, and output-byte budgets;
- required and forbidden exact tool names;
- the first retrieval tool, ignoring write, execute, and task calls before it;
- duplicate reads of one exact validated input, ignoring distinct ranges;
- retrieval fallback after a successful authoritative CodeIndex result;
- structurally classified broad searches;
- wall-clock and exact-or-unavailable token budgets.

A broad search is classified from its effective path/include scope. A missing
scope, `.`, `**`, or a root-only include is broad; a bounded path or include
narrows the search, so it stays bounded even when the other scope is
recursive. Query text never decides breadth.

## Event normalization

Every attempt retains its raw line-delimited event stream. The harness derives
one ordered event model from it:

- text, step-start, step-finish, error, tool, and unrecognized events keep their
  raw one-based line number;
- tool calls are normalized from the flat `tool_use` envelope, the raw server
  `message.part.updated` envelope, and `parts` nested inside a tool part;
- every call records its exact tool name, family, status, validated input
  object, UTF-8 output bytes, reported duration, error text, and parent call;
- unknown and failed tools stay in the sequence and in observed routing;
- malformed lines are retained with their line number, and a truncated final
  line marks the stream as truncated without discarding earlier events.

Tool families are `index`, `search`, `read`, `list`, `write`, `execute`, `task`,
and `other`. CodeIndex names keep their native `codeindex_` prefix.

## Telemetry validity

A run is invalid, not failed, when it timed out, exited non-zero, called a tool
outside the captured surface, called generic `execute`, or the workspace
contained an authored change. Invalid runs are excluded from aggregates and
counted in the report.

Missing token usage does not invalidate the execution. Each required metric is
stored as `{value, state, unit, source}` with state `exact`, `unavailable`, or
`not-applicable`. Input, output, reasoning, cache-read, cache-write tokens, and
reported cost stay separately available. A missing component is `unavailable`
with a null value; it is never replaced with zero, a byte estimate, or another
run's value. The token gate fails when a successful run lacks exact usage, while
correctness, calls, bytes, and latency remain valid evidence.

## Metrics

Per run: normalized events and tool calls with per-call output bytes and
duration, summed output bytes overall and per tool family, exact-or-unavailable
input/output/reasoning/cache tokens and cost, wall time, exit status, the
captured tool surface, and observed routing including unknown tools.

Per treatment: success rate, index-usage rate, median output bytes, median tool
calls, median tokens, p95 wall time, invalid and retried runs, and counts of
`execute` and unknown-tool runs.

## Paired reports and statistics

`report.json` is derived only from stored results and the campaign manifest. It
states the campaign ID, the suite identity, the claim class, the component
versions it used, and every source `identityDigest`; a document that cannot state
those facts is not a report.

The report retains one entry per run, so every aggregate can be recomputed from
the results and their raw event streams. Each treatment summary carries median,
p95, minimum, maximum, and an explicit `sampleCount` for retrieval bytes, total
output bytes, tool calls, wall time, and exact tokens. A percentile from one
observation is reported with `sampleCount: 1`, never as a bare percentile.

Case-level correctness is paired against both `no-index` and `accepted`.
Retrieval bytes, tool calls, exact tokens, and wall time also carry paired
per-case deltas. Candidate-versus-baseline ratios get a deterministic
paired-by-case percentile-bootstrap 95% interval when at least two complete case
pairs exist; the seed is derived from the campaign and metric, so recomputing the
report yields the same interval. With one pair the point delta is reported and
the interval is `null`.

Locate, impact, implementation, and semantic classes are summarized beside the
overall verdict. A class report contains the same treatment summaries, paired
deltas, and gates as the overall report.

Reports group only by the three declared treatments. Results with an undeclared
treatment, a duplicate slot, an unknown case class, a different campaign
identity, or an incompatible per-case comparison identity are rejected instead
of pooled. A used-versus-not-used index grouping is therefore not expressible,
which is deliberate: routing is class-confounded.

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

## Artifact verification

Every CodeIndex artifact is verified before the first model call and its
identity is recorded in `run.json` and in every result.

- The entry point declared by the suite must exist.
- The artifact `package.json` must declare object-valued `dependencies`, and every
  declared dependency must resolve from the artifact root.
- The artifact tree is hashed as sorted `{path, digest}` pairs; `node_modules`,
  `.git`, and mtimes are excluded, so the same files always produce the same
  digest.
- When the suite declares `artifact.digest`, the computed digest must match it.
  A mismatch rejects the campaign before any model starts.
- When the suite declares no digest, the computed digest is still recorded as the
  artifact identity for the campaign.

The `check` command prints each artifact digest and file count. The manifest
stores the accepted and candidate `{id, digest}` references plus per-treatment
verification details, and each result stores `artifacts: {accepted, candidate,
loaded}`.

## Isolation and restoration

Every treatment is isolated in `workspaces/<treatment>`:

- `detached-worktree` (default): a detached git worktree of the subject
  repository at the pinned revision. The subject itself must be at that exact,
  clean revision.
- `disposable-copy`: used only when the subject is not a version-control
  checkout. The workspace is a copy of the subject tree, identified by a content
  manifest hash instead of a revision.

Before every execution the harness verifies that the workspace is a clean
checkout at the pinned subject: matching HEAD and no tracked, staged, or
untracked non-ignored change for a worktree, or a matching content manifest for a
copy. A dirty or mismatched workspace is rejected before the model starts; it is
never silently repaired.

After every execution the workspace is restored: `git reset --hard <revision>`
and `git clean -fd` for a worktree, or a fresh copy from the subject for a
disposable copy. Tracked edits, staged changes, and untracked non-ignored files
are discarded, so edits from one run cannot reach the next run. Ignored build
output, the generated `.opencode` configuration, and the shared `node_modules`
link are rebuilt rather than removed permanently. The restoration result is
recorded as `isolation.restored`.

A restoration failure is never thrown away: the affected result is written with
`outcome: "failed"`, `valid: false`, `isolation.restored: false`, and the
restoration reason, then the campaign stops so no later execution observes the
edited workspace. `run.json` is marked `failed` with the same reason.

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
grace period. A descendant that escaped the process group cannot hold the harness
open: the captured pipes are released and the child is detached before the result
is written. A timed-out execution is terminal for its slot and is written as
an inspectable result with `outcome: "timed-out"`, `timedOut: true`, a null exit
code, and the captured partial stream. Every result records `outcome`,
`isolation`, `artifacts`, `timeoutMs`, and the exit signal.

`isolation` records `{mode, clientStore, checkoutClean, revisionMatch, restored}`:
the subject isolation mode, the client-store mode, the verified pre-execution
checkout state, and whether the workspace was restored afterwards.

The run manifest records the subject identity (`subject.mode`, `subject.revision`,
`subject.declaredRevision`, `subject.contentManifestHash`, `subject.lockFileHash`),
the verified artifact references, `isolation`, and `campaignStore`, so a reviewer
can reconstruct the isolation and artifact identity without reading a result. A
failed, timed-out, or successful execution cannot replace the published generation
of the normal session database.

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
were verified against the pinned revision with the TypeScript language service;
the per-case review is recorded in
[`../audits/q2-v5-e0.md`](../audits/q2-v5-e0.md). The Q2 implementation cases
remain file-identification descriptors and are not selected for the final suite.

The draft repository suite [`../suites/repository.json`](../suites/repository.json)
adds fourteen cases over the same subject at the pinned revision
`3184f55d300144d208d0adef3273af3e5a1cb9b7`: four locate cases reused from Q2,
two additional impact cases, two renamed and shadowed repository semantic cases,
and two bounded implementation cases. Each implementation case declares an exact
changed-file set and a deterministic post-run unit-test check; the reference
edits were exercised in a disposable worktree. The per-case review is recorded in
[`../audits/repository-e0.md`](../audits/repository-e0.md). Treat the locate and
impact cases as the repository candidates when the final suite is assembled.

The frozen release suite [`../suites/release.json`](../suites/release.json) selects
twelve of those repository cases (four locate, six impact, and two implementation)
and the six controlled semantic cases for 18 cases total. The frozen six-case
calibration subset [`../suites/calibration.json`](../suites/calibration.json) uses
one locate, two impact, two semantic, and one implementation case at one
repetition. Both suites pin revision
`3b6b791d148ef6e96bcddd7850e1bc3c43cc4516` and every case hash. The freeze record,
pattern coverage, corpus manifests, and expected runtime are in
[`../audits/frozen-suite-e0.md`](../audits/frozen-suite-e0.md).

The selected external corpus is pinned in
[`../corpora/external-material-ui.json`](../corpora/external-material-ui.json) at
revision `28eadba9ec2899226ecbf4058b8fba1ddeab9e6d`, project
`packages/mui-material/tsconfig.json`, and the `pnpm-lock.yaml` hash recorded by
the benchmark preparation. The model-free pilot that selected it is recorded in
[`../audits/external-corpus-pilot.md`](../audits/external-corpus-pilot.md). A
campaign against it uses a checkout at that revision; the manifest records no
absolute path. No external case is admitted to release suite version 1, so the
corpus manifest's `caseHashes` remains empty until exact file sets and grep
admission are recorded.

The draft controlled semantic suite [`../suites/semantic.json`](../suites/semantic.json)
adds six `semantic` cases over the reviewed disposable fixture at
[`../fixtures/controlled-typescript`](../fixtures/controlled-typescript/README.md).
They cover renamed re-exports, a multi-hop barrel chain, shadowed common names,
contract implementations, a type-only import through a renamed type, and default
export consumers. The draft suite declares revision `HEAD`; the frozen release
suite pins the same six cases and their hashes at an immutable commit.
`src/semantic.test.ts` verifies each expected set against the TypeScript language
service and measures literal search admission. The review is recorded in
[`../audits/semantic-e0.md`](../audits/semantic-e0.md).

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
