# Controlled TypeScript semantic cases: E0 review

E0 review note for the six `semantic` cases over the reviewed disposable fixture at
[`evaluation/fixtures/controlled-typescript`](../fixtures/controlled-typescript/README.md),
recorded as required by
[strategy §4 E0](../../documentation/mcp-evaluation-strategy.md#e0-case-and-truth-validation)
and [G-E0b/G-E0d](../../documentation/mcp-evaluation-strategy.md#818-gate-to-check-map).

- Suite: `controlled-typescript-semantic` version 1, status `draft`, declared revision `HEAD`.
  The suite stays unpinned until the final suite freeze pins a commit. Every case is
  repository-relative and independent of the current checkout.
- Truth authority: TypeScript language service 6.0.3, using
  `evaluation/fixtures/controlled-typescript/tsconfig.json`.
- Scope: every case declares
  `scope: ["evaluation/fixtures/controlled-typescript/src/**"]`. Each prompt states the
  same scope explicitly.

## Method

1. `evaluation/harness/src/semantic.test.ts` parses the fixture project file, creates one
   program, and confirms that it compiles without diagnostics.
2. For each case, the test locates the target declaration and queries the language service:
   `findReferences` for usage cases, filtered to references outside import and export
   declarations, and `getImplementationAtPosition` for the contract case.
3. The observed file set must equal `expectedFiles` exactly.
4. The test measures a model-free literal search for every identifier the case prompt makes
   plausible. A semantic case passes admission only when the best candidate search has
   file-set precision at most 0.5 or misses an expected file.
5. `loadSuite` validates the draft suite and confirms that it contains six semantic cases.

## Cases

| Case | Pattern | Expected files | Language-service result |
| --- | --- | --- | --- |
| `semantic-renamed-reexport` | Renamed re-export | `src/renamed/consumer.ts` | Pass: one usage of `createProfile` through the `createIdentity` alias |
| `semantic-barrel-chain` | Multi-hop barrel chain | `src/barrels/consumer.ts` | Pass: one usage of `pipelineLimit` through two barrel hops and the `maximumPipeline` rename |
| `semantic-shadowed-name` | Shadowed common name | `src/shadow/firstConsumer.ts` | Pass: references to `Node` from `first.ts` exclude the unrelated `Node` from `second.ts` |
| `semantic-interface-implementations` | Contract implementations | `src/contracts/invoiceGateway.ts`, `src/contracts/stripeGateway.ts` | Pass: exactly two implementing classes |
| `semantic-type-only-import` | Type-only import through a renamed type | `src/types/consumer.ts` | Pass: one usage of `InvoiceId` through the type-only `DocumentId` alias |
| `semantic-default-export` | Default export references | `src/defaults/firstConsumer.ts`, `src/defaults/secondConsumer.ts` | Pass: both consumers resolve to the one default export |

All six cases are `class: "semantic"` and carry a pattern-specific tag. Definition and
re-export files are listed in `forbiddenFiles` where they are the obvious lexical false
positive; `contextFiles` stays empty because no supporting file is an answer.

## Grep admission

Literal search was measured over `evaluation/fixtures/controlled-typescript/src/**/*.ts`.
`precision` is the count of expected files among the matches divided by the number of
matched files. `missing` is the number of expected files the search does not match.

| Case | Candidate identifier | Matched files | Precision | Missing | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| `semantic-renamed-reexport` | `createProfile` | 2 | 0.00 | 1 | Admitted: misses the consumer |
| `semantic-renamed-reexport` | `createIdentity` | 2 | 0.50 | 0 | Admitted: precision bound |
| `semantic-barrel-chain` | `pipelineLimit` | 3 | 0.00 | 1 | Admitted: misses the consumer |
| `semantic-barrel-chain` | `maximumPipeline` | 3 | 0.33 | 0 | Admitted: precision bound |
| `semantic-shadowed-name` | `Node` | 4 | 0.25 | 0 | Admitted: precision bound |
| `semantic-interface-implementations` | `PaymentGateway` | 4 | 0.50 | 0 | Admitted: precision bound |
| `semantic-type-only-import` | `InvoiceId` | 2 | 0.00 | 1 | Admitted: misses the consumer |
| `semantic-type-only-import` | `DocumentId` | 2 | 0.50 | 0 | Admitted: precision bound |
| `semantic-default-export` | `MonotonicClock` | 1 | 0.00 | 2 | Admitted: misses both consumers |

No candidate single-identifier search reaches precision above 0.5 without missing an
expected file.

## Verdict

All six cases pass G-E0b for the reviewed fixture and G-E0d by the recorded grep
measurement. The suite remains a draft until the final suite freeze pins a revision and
adds the remaining corpus. It does not change the retained Q2 verdict.
