# Local-model qualification: validity-v2 path revalidation

Model-free revalidation of the fixed-artifact local-model qualification path
against the measurement-validity controls of
[`evaluation-validity-v2`](../contracts/evaluation-validity-v2.json). No model was
called, no qualification campaign was executed, and this document issues no
qualification verdict.

## Scope

- Claim class: `validity-only`; release authority: `false`.
- Frontier architecture/release gate: `unaffected`.
- Suite: `codeindex-qualification` version 1, hash
  `53586e43eb8e4882df2761244b0d5b9bd8537636315818e564585e131a4a223d`.
- Revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`.
- Canonical artifact: `codeindex-mcp-canonical` version `0.5.0`, digest
  `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0`.
- Plan: 18 cases × `no-index` and `canonical` × 3 paired repetitions = 108
  slots, plan hash
  `c2e4812557d2e928fe9f54a167a2e32369c9885e2f19f114f0e71b373f3f0351`.
- Contract: `evaluation-validity-v2` version 2, digest
  `179bb5df1bc96ee86c54da20f26034a59fe50671dfc9912d805ed4588204a22f`.
- Machine-readable record:
  [`local-model-qualification-v2-revalidation.json`](local-model-qualification-v2-revalidation.json).

Only the validity controls of the hosted contract apply here. Local
qualification keeps its own predeclared correctness, timeout, tool-use, and
efficiency criteria and does not adopt the hosted DeepSeek model, tariff, or
economic pins.

## Command

```bash
node evaluation/harness/src/cli.ts qualification \
  --suite suites/qualification.json \
  --canonical canonical-artifact.json \
  --revalidate
```

The canonical tree is provisioned from the released 0.5.0 package at the ignored
path `evaluation/artifacts/canonical/`; the command stages it outside the
checkout and recomputes its content digest before any surface or corpus probe.

## Gates

| Gate | Evidence | Result |
| --- | --- | --- |
| `contract` | `evaluation-validity-v2@2` | passed |
| `canonical-artifact` | `codeindex-mcp-canonical@aba08ea7…d6c0` | passed |
| `plan` | 108 unique slots, 2 treatments, 3 repetitions | passed |
| `request-1-surface` | 2/2 treatments exact across 20 cold starts each | passed |
| `corpus` | 18 cases; every expected path and semantic declaration indexed | passed |
| `metering` | 1 synthetic request, settled exactly once, claim `exact` | passed |
| `path-isolation` | state root outside the primary checkout | passed |

The surfaced treatments were exact and distinct:

- `no-index`: `glob, grep, read, shell`
- `canonical`: `codeindex_find_dependencies, codeindex_find_references,
  codeindex_find_symbol, codeindex_index_status, codeindex_outline,
  codeindex_read_symbol, codeindex_symbol_at, glob, grep, read, shell`

## Validity controls in the qualification report

`qualification.json` is now schema 2 and carries five validity checks beside the
local criteria:

- `validity.request-metering` — every execution has one settled, contiguous
  request ledger with exact token accounting and no path disclosure.
- `validity.request-1-surface` — agent request 1 equals the declared treatment
  surface in every execution.
- `validity.corpus-coverage` — the preflight covered every case path and semantic
  symbol probe, and every indexed treatment reported a ready, current index.
- `validity.workspace-isolation` — every execution had zero external-path
  attempts, zero provider path disclosures, and was restored to the pinned
  subject; the external state root stays outside the primary checkout.
- `validity.all-valid-run-aggregation` — all 108 slots are valid and aggregated
  across both treatments, including incorrect valid answers.

Fail-closed behavior is proven deterministically in
[`../harness/src/qualification.test.ts`](../harness/src/qualification.test.ts):
an unmetered or unsettled execution, a request-1 mismatch, an incomplete corpus,
a contaminated or unrestored workspace, a state root inside the checkout, or a
non-accepted contract disqualifies or rejects the campaign. The same test file
proves that an incorrect but valid answer stays in the denominator and is not
dropped from the sample.

## What this does not establish

- No model was qualified. The pinned local model was not run, and no
  `qualification.json` verdict exists for it.
- The 108-slot campaign remains unspent and available for a future qualification.
- The installed runtimes now differ from the calibration pins used by the last
  local campaign (Ollama `0.40.8` → `0.40.10`, OpenCode `2.1.2` → `2.1.4`). A real
  campaign must capture and pin a fresh environment manifest before it starts.
- This evidence neither authorizes nor blocks hosted release work.

## Historical evidence

The completed 162-slot v1 local regression in
[`local-regression-e4.md`](local-regression-e4.md) remains historical
`NOT PASSED` evidence. It is not rerun, regraded, pooled, or reinterpreted by
this revalidation.
