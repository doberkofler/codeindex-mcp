# Local-model environment and smoke: E1 execution

Execution record for the first reproducible local-model environment and the
accepted-only harness smoke required by
[strategy §10](../../documentation/mcp-evaluation-strategy.md#10-local-model-strategy)
and [EVAL-021](https://github.com/doberkofler/codeindex-mcp/issues/29). The 8B
model is a harness smoke only: this record makes no quality claim and selects no
local reference.

- Date: 2026-10-21.
- Environment: `ollama-qwen3-8b-smoke`, hash
  `b118c3697c3aa85cab6478a4fbdd535ce3d27330589dcba95a1428510c3d37d3`.
- Suite: `codeindex-calibration` version 1, status `frozen`, hash
  `2dbf1e5bf80ece2ca414bed4e412d3e786f10fb18c8d9336c38a8e14bd35988a`.
- Subject revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`, detached
  worktree, content manifest `70403067fd91080b9949b26f3a68d632898586b019d53e1ee4291641e0bbb907`.
- Accepted artifact: `fed1b6e`, digest
  `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0`.
- Campaign identity: `3476d3a8249d0be933a728071b3dc38f0ce5876d3035872efd5a149e43712b44`.
- Result directory (generated, never committed):
  `evaluation/results/codeindex-calibration-3476d3a8249d0be9/`.

## Pinned environment

| Fact | Value |
| --- | --- |
| Reference machine | `apple-m5-max-64gb` |
| Host | Apple M5 Max, 18 CPUs, 68,719,476,736 memory bytes |
| OS | macOS, Darwin kernel 27.0.0 |
| Node | `v26.10.0` |
| OpenCode | `2.1.2` |
| Ollama | `0.40.7` at `http://127.0.0.1:11434` |
| Model | `ollama/qwen3:8b`, digest `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41` |
| Model artifact | `qwen3`, 8.2B, `Q4_K_M`, context 40,960, embedding 4,096 |
| Generation | temperature 0.6, top_p 0.95, top_k 20, repeat_penalty 1, stop `<|im_start|>`/`<|im_end|>` |

The committed manifest is
[`../environments/ollama-qwen3-8b-smoke.json`](../environments/ollama-qwen3-8b-smoke.json).
The harness measured the host, runtime versions, model digest, quantization,
context, and generation defaults before the first model call and rejected any
difference. The manifest hash participates in the campaign identity, and the run
manifest records the resolved model identity beside the measured host facts.

## Command

```bash
node evaluation/harness/src/cli.ts environment --check \
  --environment environments/ollama-qwen3-8b-smoke.json
node evaluation/harness/src/cli.ts smoke \
  --suite suites/calibration.json \
  --environment environments/ollama-qwen3-8b-smoke.json
```

`smoke` ran six cases × accepted × one repetition. Every execution used an
isolated detached worktree, the `evaluator` agent, and an `--standalone` OpenCode
server with an ephemeral client store. No normal OpenCode session was created.

## Results

| Case | Correctness | Workflow | Calls | Index calls | Bytes | Tokens | Cache read | Wall ms | Identity digest |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `locate-schema-version` | pass | pass | 1 | 0 | 7,639 | 15,350 | 6 | 39,679 | `f54839a16f4c9656db2bb09ccabdfad6bfc8613bf93ed495f5aecadcfb27d29c` |
| `impact-build-generation-references` | pass | pass | 1 | 0 | 808 | 3,128 | 12,454 | 32,856 | `c37a3c178a092979f5040ea813ec8734fcc8ee16e36cb0415bbd4dc9dfa2a852` |
| `impact-schema-version-references` | fail | pass | 1 | 0 | 2,045 | 3,648 | 12,454 | 46,512 | `c452930b2488ab9aa81c44b7c720cdfa8b29502e353cf3021a3f149e9ee6d59b` |
| `semantic-renamed-reexport` | pass | pass | 1 | 0 | 522 | 3,558 | 12,454 | 56,340 | `a49a562030893cb2e865121507adca412f405aae2bbe7322c9c19bf9795abbe5` |
| `semantic-interface-implementations` | fail | pass | 4 | 2 | 3,991 | 12,892 | 61,454 | 141,859 | `35e8952086a600923591711ca7ab0fb80d744eae73c887a9760aa7e1a9acc3b6` |
| `impl-default-result-bytes` | pass | pass | 0 | 0 | 0 | unavailable | unavailable | 26,395 | `fe2ed68c1c919200f56c82079eb9dfe3b049e3884cda49af99158397e82a79aa` |

Six of six executions completed and were valid; four of six answers were exact.
No execution timed out, retried, called generic `execute`, called a tool outside
the captured surface, or left an authored change in its workspace.

## Diagnosis

- `impact-schema-version-references` named two analytics files outside the
  bounded context in addition to every expected file. The over-inclusive answer
  is retained in the result's `finalText`.
- `semantic-interface-implementations` answered with the four default and shadow
  consumers instead of the two gateway implementations. It made two CodeIndex
  calls, so the failure is answer selection, not index availability.
- `impl-default-result-bytes` made no tool call and answered with unrelated
  configuration files. Its process completed, but the event stream contains no
  `step_finish` usage, so input, output, reasoning, cache, and cost telemetry are
  `unavailable`.

The failures are attributable to the 8B model's answer selection. They do not
invalidate the environment, isolation, or harness path, and they are not
correctness evidence for any capable local or hosted model.

## Telemetry

Five executions report exact input, output, reasoning, cache-read, cache-write,
and cost values from `step_finish`. `impl-default-result-bytes` reports no usage
at all; the fields remain `unavailable` with null values rather than being
estimated from bytes. The token gate is therefore invalid for this smoke, while
correctness, calls, bytes, and wall time remain usable.

## Reproduction

1. Restore the pinned environment and confirm
   `environment --check` reports a match.
2. Stage the accepted artifact at commit `fed1b6e` under
   `evaluation/artifacts/accepted`.
3. Point `evaluation/harness/harness.json` at a detached worktree of the suite
   revision.
4. Run the two commands above without `--dry-run`.

Generated results are gitignored and retained locally for inspection. A changed
model digest, quantization, runtime, context, generation setting, or host fact
requires a new environment manifest and a new smoke baseline.
