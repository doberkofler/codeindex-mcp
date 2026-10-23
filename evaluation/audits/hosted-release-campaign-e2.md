# Hosted release campaign: E2 record

> Historical precondition record. On 2026-10-23, the accepted gate split removed
> local regression as a hosted prerequisite and selected `deepseek/deepseek-flash`
> for the new campaign. The original 0-of-270 facts below are unchanged.

Record for the deferred hosted-model gate required by
[strategy §8.1](../../documentation/mcp-evaluation-strategy.md#81-execution-contract-tiers-order-invalidation-retry-and-stop-rules),
[strategy §10](../../documentation/mcp-evaluation-strategy.md#10-local-model-strategy), and
[EVAL-024](https://github.com/doberkofler/codeindex-mcp/issues/32).

- Date: 2026-10-22.
- Suite: `codeindex-release` version 1, status `frozen`, base hash
  `073378fe3b9dc71710797a4a31a249d36363802f4347f87b73ff4fe6ae47f110`.
- Hosted-bound suite hash for `deepseek/deepseek-v4-pro`:
  `e256ea3e387dba077025942110b07e3b80c1f46dba76c5fd1f58a9e5cf859877`.
- Subject revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`.
- Hosted reference: [`references/deepseek-v4-pro.json`](../references/deepseek-v4-pro.json),
  hash `12ff2e9cab0cc116765bacb0a7ce46531c46eb170b35e9c539af5a55161b079f`.
- Target metric predeclared before any execution: `retrievalBytes`.
- Release plan: 18 cases × 3 treatments × 5 paired repetitions = 270 slots.
  Dry-run plan hash `436f43278fa9c72c57dabc049e05ad36f5a2950a17e41206f22cfa0f924fb9b8`,
  campaign identity `b48c1154c5f60dc46830e5aabccb9238258cfb1775ec293a836e07c558f21e0f`.

## Selected hosted reference

| Fact | Value |
| --- | --- |
| Provider | `deepseek` |
| Model ID | `deepseek-v4-pro` |
| Provider release | `2026-08-13T00:00:00.000Z` |
| Client runtime | OpenCode `2.1.2` |
| Generation settings | Provider defaults at the pinned runtime |

`deepseek/deepseek-flash` remains the historical Q2 v4 configuration. It is not
reused as the release baseline. The release command binds the selected hosted
reference, so the reference hash participates in campaign identity. Changing the
provider, model ID, release, runtime, or generation setting starts a new campaign
and requires a new complete paired baseline.

## Precondition result

The campaign did not start. Both pre-release stages are required, and at least one
cannot pass for the current staged artifacts.

| Stage | Required evidence | Result | Cause |
| --- | --- | --- | --- |
| Model-free E1 | Passing `route-report` for the same suite, revision, and staged artifacts | Stale | The recorded passing report covers candidate digest `dce80664522731414642fc5d2df6b10048c2ddb10262be2bcd1e9aff9a21b354`; the current staged candidate is `558a58cdd8939c9f78d399c6f375141a814570da5ba1f70eff30210a0075f13c` |
| Local regression | Passing `local-regression` with 162 valid executions and an improved target metric | Blocked | The EVAL-023 targeted diagnostic was blocked: the candidate did not improve retrieval bytes and regressed retrieval bytes, tool calls, and tokens on one impact case. The full 162-execution local stage was not started, so no passing local record exists |

The local outcome is recorded in
[`local-regression-e2.md`](local-regression-e2.md). A local failure is a valid
stop, not a substitute for hosted evidence: no local result is promoted to the
hosted claim class, and no historical Q2 v4 result is used as the comparison.

## Execution status

`release --dry-run` validated the suite, hosted reference, treatments, and all 270
planned slots without starting a model. The pinned runtime was measured separately
as OpenCode `2.1.2`. The real command was not run:
without a passing model-free report and a passing local regression, the release
command refuses before the first hosted call. There are no release executions,
valid or invalid, because the stage never started.

- Planned slots: 270.
- Started slots: 0.
- Valid slots: 0.
- Invalid slots: 0.
- Hosted release verdict: not produced.

This record does not claim a release result. It records that the deferred gate is
implemented, the model identity is pinned, and the gate correctly refuses to
substitute stale model-free evidence or blocked local evidence for the hosted
campaign.

## Automation verification

The stage is verified without a model by:

- `release --dry-run`, which prints exactly 270 slots and starts no model;
- `evaluation/harness/src/releaseCampaign.test.ts`, which covers the 270-slot
  plan, missing-slot invalidation with cause, Q2 threshold and target-metric
  failure, class verdicts with paired bootstrap intervals, precondition
  validation, and the rejection of hosted claim authority for local evidence;
- `evaluation/harness/src/identity.test.ts`, which proves that a changed hosted
  reference changes both the execution identity and the comparison identity;
- `pnpm eval:typecheck`, `pnpm eval:test`, and the standard `pnpm verify` gate.

## Acceptance mapping

| Criterion | Status |
| --- | --- |
| Campaign runs only after model-free and local gates pass | Historical precondition: the recorded stage validated both; EVAL-030 (#57) removed local qualification as a hosted prerequisite |
| All 270 slots valid or explicitly invalidated with cause | Implemented: every declared slot is recorded as valid or invalid with a closed cause; a missing or invalid slot blocks the verdict |
| No historical run is used as a comparison | Implemented: the campaign runs one fresh three-treatment plan; a changed hosted reference changes identity and requires a new baseline |
| Local evidence is not substituted for the hosted result | Implemented: the release record carries `hosted-model-scoped` and `releaseAuthority: true`; local records carry `local-model-scoped` and `releaseAuthority: false` |

## Claim boundary

No hosted-model-scoped verdict is claimed. The selected reference is pinned and
the campaign automation is complete, but the current model-free evidence is stale
for the staged candidate and the local gate is blocked. The hosted campaign may
start only after both stages pass for the same suite version, revision, and
artifacts. This page is a gate record, not release evidence.

## 2026-10-23 supersession

The architecture/release campaign is now the authoritative frontier-model test and
must run from scratch with `deepseek/deepseek-flash`. Its new reference hash is
`e3d86f8914fe9b9d77e9048216acd1535a44cf98b7e69a35edb3a1cf19dae07e`.
The replacement dry run validated 270 slots with plan hash
`436f43278fa9c72c57dabc049e05ad36f5a2950a17e41206f22cfa0f924fb9b8` and
campaign identity
`dddc689346e6cf2c91c158e400f1f7db14b8db022ce23ae3844ae7e749d3c1ea`.
The old Pro reference, hosted-bound suite hash, and campaign identity above are
historical and cannot be reused. The plan hash is unchanged because the slot shape is
unchanged; it carries no execution evidence.

The current policy precondition is one passing model-free route report for the same
suite, revision, and staged artifacts. Independent local-model qualification neither
authorizes nor blocks the frontier campaign.

EVAL-030 (#57) removed the historical local-regression precondition described
above. The executable command now requires only current model-free evidence for the
same suite, revision, and staged artifacts and no longer reads a local-regression
argument. After staging current artifacts, re-run the model-free route and execute
EVAL-028 (#36) from scratch.
