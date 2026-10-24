# Corpus indexing and workspace isolation: eval-033

Record for [EVAL-033 / #61](https://github.com/doberkofler/codeindex-mcp/issues/61),
under the frozen [validity-v2 contract](../contracts/evaluation-validity-v2.json).
Date: 2026-10-23.

## Change boundary

- Mutable evaluation state moves outside the primary checkout: staged artifacts,
  worktrees, index databases, client stores, preflight reports, and per-slot
  results.
- The generated index configuration carries three project contexts in one
  published generation: `tsconfig.json` (repository `src/`),
  `evaluation/fixtures/controlled-typescript/tsconfig.json` (the six semantic
  cases), and `tsconfig.test.json` (the `test/` files changed by the two
  implementation cases).
- `preflight` waits for `index_status.refresh === "current"`, validates
  `scope.root`, every configured project name and project file, and probes every
  expected file plus six known semantic declarations before model spend.
- Generated configuration and provider request bodies are scanned for the
  primary-checkout absolute path.
- Every `external_directory` denial in stdout or stderr is recorded with channel,
  line, count, and target. The slot is invalid and is not retried.

## Deterministic evidence

Commands run from the repository root:

```bash
pnpm run eval:typecheck
pnpm run eval:test
node evaluation/harness/src/cli.ts preflight --suite suites/release.json
```

`pnpm run eval:test` passed 252 tests across 35 files. The release preflight
report is `preflight.json` under the external state root's
`results/preflight/codeindex-release-073378fe3b9dc717/` directory:

| Treatment | Ready | Contexts | Files | Unindexed |
| --- | --- | --- | ---: | ---: |
| `accepted` | yes | `root`, `controlled-typescript`, `test` | 341 | 0 |
| `candidate` | yes | `root`, `controlled-typescript`, `test` | 341 | 0 |

All six semantic symbol probes passed:

| Case | Symbol | Path |
| --- | --- | --- |
| `semantic-renamed-reexport` | `createProfile` | `evaluation/fixtures/controlled-typescript/src/renamed/source.ts` |
| `semantic-barrel-chain` | `pipelineLimit` | `evaluation/fixtures/controlled-typescript/src/barrels/deep/value.ts` |
| `semantic-shadowed-name` | `Node` | `evaluation/fixtures/controlled-typescript/src/shadow/first.ts` |
| `semantic-interface-implementations` | `PaymentGateway` | `evaluation/fixtures/controlled-typescript/src/contracts/gateway.ts` |
| `semantic-type-only-import` | `InvoiceId` | `evaluation/fixtures/controlled-typescript/src/types/model.ts` |
| `semantic-default-export` | `default` | `evaluation/fixtures/controlled-typescript/src/defaults/clock.ts` |

## Path-disclosure proof

The generated `.opencode/opencode.jsonc` and `.opencode/codeindex.json` for both
staged treatments, and the preflight report itself, contain no occurrence of the
primary-checkout absolute path. The deterministic test also proves that:

- the MCP command points at the staged artifact under the external state root;
- the index database is outside the workspace and outside the primary checkout;
- a configured state root inside the primary checkout is rejected;
- a provider request body containing the primary path is counted, retains no
  request text, and invalidates the economic claim;
- agent request 1 fails with `path-disclosure` instead of passing.

## External-path detection

The runner test emits an `external_directory` denial and confirms one recorded
attempt, `defects: ["external-path-attempt"]`, `outcome: "failed"`, no retry, and
an inspectable invalid reason. This closes the E3 failure mode where 74 denials
across 36 runs were allowed to continue and only appeared in audit prose.

## Hosted validity pilot

No hosted request was made while implementing this change, so this record makes
no hosted-model claim. The pilot is the next gate and must use the corrected
harness: it must show zero `external_directory` attempts, both configured project
contexts in `index_status`, and a passing preflight before its first provider
request. The deterministic evidence above is the prerequisite, not a substitute.
