# Local-model calibration and reference selection: E2 execution

Calibration record for the regression sentinel required by
[strategy §10](../../documentation/mcp-evaluation-strategy.md#10-local-model-strategy)
and [EVAL-026](https://github.com/doberkofler/codeindex-mcp/issues/34).

- Date: 2026-10-22.
- Suite: `codeindex-calibration` version 2, status `frozen`, hash
  `58248d2884715885cc74693464d619f7611c710bb319ba6ab769180db9a42291`.
- Subject revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`.
- Accepted artifact: `fed1b6e`, digest
  `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0`.
- Harness version: 11.
- Runtime: Ollama 0.40.8, OpenCode 2.1.2.
- Budget: 900,000 ms (15 minutes) per model for qualification.
- Diagnostic phase: `impl-default-result-bytes` and
  `impact-schema-version-references` × `no-index` and `accepted` × 3 repetitions
  = 12 executions per candidate.
- Qualification phase: 6 cases × `no-index` and `accepted` × 1 repetition =
  12 executions per candidate.

The suite adds the explicit `edit` tool to the ordinary surface, so the
implementation case can modify the repository instead of being scored on an
answer it cannot produce.

## Diagnostic results

`ollama/qwen3.8:27b-mlx` completed 12 of 12 diagnostic executions with no
contract anomaly: no dirty checkout, failed process, failed restoration, retry,
timeout, unknown tool, unstructured answer, correctness failure, workflow
failure, invalid tool input, or CodeIndex error. The diagnostic contract passed
before any qualification execution ran.

`ollama/devstral-small-2:latest` was excluded before execution and received no
diagnostic execution. The exclusion is an operator resource constraint, not a
model-quality result.

## Qualification results

| Model | Valid | Exact: no-index / accepted | Elapsed | Interventions | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `ollama/qwen3.8:27b-mlx` | 12/12 | 6/6 | 596,972 ms | 0 | Qualified and selected |
| `ollama/devstral-small-2:latest` | 0/12 | — | — | — | Excluded before execution |

The 27B accepted treatment had median wall time 55,842 ms, median retrieval
volume 7,511.5 bytes, and median 5 tool calls. All 12 executions used exactly one
attempt, completed normally, and recorded `checkoutClean: true`,
`revisionMatch: true`, and `restored: true`. Token telemetry was exact: 68,528
input tokens, 9,098 output tokens, and 604,370 cache-read tokens across the 12
executions.

`ollama/devstral-small-2:latest` was declared with
`--exclude "ollama-devstral-small-2-calibration=24B model exceeds the reference
machine's usable memory for unattended evaluation"`. The selection record keeps
that candidate as a disqualification with zero executions, so the candidate set
is not silently narrowed.

## Model identity

- 27B manifest: `ollama-qwen3.8-27b-calibration`; model digest
  `5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e`;
  NVFP4; context 262,144; generation temperature 1, top-p 0.95, top-k 20, repeat
  penalty 1, empty stop list; environment hash
  `a22d9f8a8b5e41b7c7bfffc0b1f123f34a77ca5715354618d682e53a4bff4690`.
- Devstral manifest: `ollama-devstral-small-2-calibration`; model digest
  `24277f07f62db8f9cb68e9dfc679ea1818a7fbac47a50eff0a701d3f645b63c8`;
  `Q4_K_M`; 24.0B parameters; context 393,216; generation temperature 0.15,
  top-p/top-k/repeat-penalty unset, empty stop list; environment hash
  `5429c4edfa7a48b1e608826c911452291248eb613036c02525a978866fe67118`.
- Ollama publishes the Devstral model only as the `:latest` tag on this machine.
  The digest, not the tag name, is the identity.

The EVAL-022 baseline pinned Ollama 0.40.7. The installed runtime moved to
0.40.8, so both committed manifests were recaptured at 0.40.8 before this
campaign; the previous pin and the E1 evidence remain in Git history. A changed
digest, quantization, runtime, generation setting, context, or reference machine
is a different environment identity and starts a new baseline.

## Tool surface and isolation checks

Before the first model call, a model-free probe captured the tool list OpenCode
actually sends to a provider. The observed surface was exactly the declared one:

- `no-index`: `edit`, `glob`, `grep`, `read`, `shell`, `write` (6 tools);
- `accepted`: those six plus `codeindex_find_dependencies`,
  `codeindex_find_references`, `codeindex_find_symbol`,
  `codeindex_index_status`, `codeindex_outline`, `codeindex_read_symbol`, and
  `codeindex_symbol_at` (13 tools).

`edit` presents `edit` and `write` because both share the `edit` permission;
`bash` is presented as `shell` and normalized back in the event stream; `list` is
retired in OpenCode 2 and is not presented. A missing declared tool or an
undeclared tool aborts a campaign before any model process starts.

Attempt isolation was verified, not assumed. Every execution began from a clean
checkout at the pinned revision, and every post-run verification found the
workspace restored. Authored ignored files are now rejected before an execution
and removed during restoration, while the harness-owned `node_modules` link and
`dist` tree survive. `SIGINT` and `SIGTERM` are forwarded to a running attempt's
detached process group, so an outer timeout cannot leave a model writing into a
workspace after the campaign stopped.

## Selection

`ollama/qwen3.8:27b-mlx` qualified and is the local regression sentinel under the
predeclared order: qualifiers only, then more exact accepted answers, then lower
accepted median wall time, then lower accepted median retrieval bytes. The
selection record contains `selected: "ollama/qwen3.8:27b-mlx"`, a one-entry
`qualified` list, and both decisions.

Retained evidence:

- `evaluation/results/codeindex-calibration-dfe36c8041210a36/diagnostics.json`
- `evaluation/results/codeindex-calibration-3b0d0acbae552948/calibration.json`
- `evaluation/results/codeindex-calibration-selection-23f189cf05cc9df9/selection.json`

Result directories are ignored by Git; this audit is the durable record.

## Recovery and exclusion notes

Result directories with a `-provisional-` or `-interrupted-` suffix predate the
harness repairs and contribute nothing to this decision. One provisional
diagnostic reported a `symbol_not_found` index error classified as
CodeIndex-attributed; the final diagnostic phase produced no anomaly. The
provisional campaign also exposed a queue timeout whose detached model process
survived, which the signal forwarding above now prevents.

The claim is local-model scoped: it applies only to the pinned model artifacts,
settings, runtime, subject revision, accepted artifact, and reference machine
above. It does not generalise to another model, and it makes no quality claim
about `ollama/devstral-small-2:latest`, which was not executed.
