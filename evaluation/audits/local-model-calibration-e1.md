# Local-model calibration and reference selection: E1 execution

Calibration record for the two capable local models required by
[strategy §10](../../documentation/mcp-evaluation-strategy.md#10-local-model-strategy)
and [EVAL-022](https://github.com/doberkofler/codeindex-mcp/issues/30).

- Date: 2026-10-21.
- Suite: `codeindex-calibration` version 1, status `frozen`.
- Subject revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`.
- Accepted artifact: `fed1b6e`, digest
  `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0`.
- Budget: 900,000 ms (15 minutes) per model.
- Plan: 6 cases × `no-index` and `accepted` × 1 repetition = 12 executions per
  model.

## Qualification results

| Model | Valid | Exact: no-index / accepted | Elapsed | Interventions | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `ollama/qwen3.8:27b-mlx` | 12/12 | 6/6 | 951,585 ms | 2 | Disqualified: budget exceeded and retries required |
| `ollama/qwen3.6:35b-mlx` | 12/12 | 6/5 | 553,404 ms | 2 executions | Disqualified: correctness loss and retries required |

The 27B accepted treatment had median wall time 60,976.5 ms, median retrieval
volume 8,459 bytes, and median 4.5 tool calls. Its two implementation executions
each needed one retry. Exact correctness did not regress, but 951,585 ms exceeds
the frozen 900,000 ms budget and qualification requires zero interventions.

The 35B accepted treatment had median wall time 21,126.5 ms, median retrieval
volume 9,213 bytes, and median 5 tool calls. It lost the correct no-index answer
for `impact-schema-version-references`. The accepted implementation execution
needed three retries and the no-index implementation execution needed one retry.
Qualification requires zero correctness loss and zero interventions.

Token telemetry was exact for both models. The measurements and conclusions are
local-model-scoped: they apply only to the pinned model artifacts, settings,
runtime, subject revision, accepted artifact, and reference machine above.

## Model identity

- 27B manifest: `ollama-qwen3.8-27b-calibration`; model digest
  `5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e`;
  NVFP4; context 262,144; environment hash
  `ab1484c5483c24be2f086eb6fb59affb9109eff45b80746aa26e8d2193ead1be`.
- 35B manifest: `ollama-qwen3.6-35b-calibration`; model digest
  `e92a3e94bbca90a85491dc34e9257bfee2318cedaa16360828c4d8edf14295b9`;
  NVFP4; context 262,144; environment hash
  `71a389f05fc2305aedbf1a11c62fba6aa554d7fb933abcf4f1dfbc55fce2be7a`.
- Both manifests pin Ollama 0.40.7, OpenCode 2.1.2, temperature 1, top-p
  0.95, top-k 20, repeat penalty 1, and an empty stop list.

A changed digest, quantization, runtime, generation setting, context, or
reference machine is a different environment identity and starts a new
baseline.

## Selection

No model qualified. The selection record contains `selected: null`, an empty
`qualified` list, and both disqualification decisions. No local regression
sentinel is selected; selecting either candidate would weaken the frozen gate.

Retained evidence:

- `evaluation/results/codeindex-calibration-48bad352ecfd3b4b/calibration.json`
- `evaluation/results/codeindex-calibration-6cd8333a21f67091/calibration.json`
- `evaluation/results/codeindex-calibration-selection-e9f33b7cf47a54c7/selection.json`

## Recovery and isolation notes

Interrupted and invalid campaigns remain in suffixed result directories and do
not contribute to this decision. During the retained 35B campaign, one failed
accepted implementation retry supplied absolute paths to the main checkout
instead of the generated treatment workspace. Post-run isolation marked that
attempt `restored: false`; the resulting two main-checkout edits were removed,
and later valid evidence did not treat the attempt as a clean pass.

The harness now removes ambient `CODE_INDEX_*` variables from MCP and model
children, normalizes OpenCode 2.1.2's observed `shell` event alias to the
declared `bash` tool, and avoids ordinary paired-report generation during
calibration because the treatment tool surfaces intentionally differ. The queue
runner also forbids background jobs and rejects an observed background tool
call, preventing calibration work from outliving an agent session.
