# Provider-request metering evidence

Date: 2026-10-23

Scope: implementation evidence for [EVAL-031 (#59)](https://github.com/doberkofler/codeindex-mcp/issues/59).
This is deterministic proxy evidence, not a hosted campaign and not an economic
result. It does not re-grade E3 or authorize a release campaign.

## What was built

`evaluation/harness/src/providerMeter.ts` starts a loopback OpenAI-compatible
provider proxy. `providerMeterProxy.ts` records every request before reading its
body, forwards it to the configured upstream, and settles it from the terminal
response. `providerMeterCollector.ts` extracts provider-reported usage from JSON
and SSE responses. `providerMeterLedger.ts` reconciles requests and aggregates
the task total and the agent-only sensitivity vector.

The ledger records only:

- one-based request ordinal and closed kind (`agent`, `title`, `compaction`,
  `other`);
- actual provider, model, start time, completion time, request and response
  byte counts;
- offered tool names;
- provider-reported non-cached input, cache read, cache-write tiers, visible
  output, reasoning, and cost;
- exactly one settlement: completed usage or a closed failure cause.

It retains no prompts, source text, credentials, or provider envelopes.

## Deterministic evidence

`evaluation/harness/src/providerMeter.test.ts` runs against a loopback synthetic
upstream and covers:

- OpenAI- and Anthropic-compatible usage shapes with separate cache-write tiers;
- a synthetic sequence where `session.execution.succeeded` precedes
  `session.step.ended` and title generation starts asynchronously;
- agent, title, and compaction requests in one task;
- upstream HTTP failure, missing usage, and incomplete usage;
- an unsettled request that cannot reconcile as complete;
- static-tariff output labelled `sensitivity-not-invoice-time`;
- absence of prompt text, response text, and authorization values from the
  ledger.

Example reconciliation for the synthetic three-request task:

| Request | Kind | Status | Total tokens |
| --- | --- | --- | ---: |
| 1 | `agent` | completed | 140 |
| 2 | `title` | completed | 25 |
| 3 | `compaction` | completed | 70 |
| Task total | all kinds | exact | 235 |
| Agent-only sensitivity | `agent` | exact | 140 |

The corresponding sanitized ledger contains request ordinals, kinds, model
identity, timestamps, tool names, byte counts, and usage categories only. The
event stream in the same test has no `step_finish`, so event-derived telemetry is
`unavailable` while the proxy ledger remains exact. This is the separation that
prevents terminal and title usage from disappearing with event ordering.

## Claim boundary

The metering seam establishes capture and reconciliation. It does not establish
treatment integrity, corpus coverage, workspace isolation, statistical validity,
or a cost effect. Those remain with #60–#65. Static tariff arithmetic is
sensitivity analysis only; no value in this evidence is an invoice-time cost.
