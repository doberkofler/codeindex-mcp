# EVAL-037 interrupted certification invalidation

**Recorded:** 2026-10-23

**Issue:** #65

**Design:** `impact-certification-v1`

**Decision:** `INVALID — DO NOT RESUME`

## Scope

The interrupted primary-block execution under campaign root
`codeindex-certification-final` is not certification evidence. It stopped after
149 of 240 planned primary slots. The preserved campaign data contains 184
attempt records, including retries; no holdout slots ran.

## Cause

Candidate executions left 82 detached CodeIndex MCP processes alive after their
private OpenCode servers exited. The processes were candidate-only and continued
to consume host resources. This created treatment-specific resource contention,
so execution latency, reliability, and provider behavior were not measured under
equivalent conditions.

The shared contamination cause invalidates every execution in this interrupted
campaign. Per-slot results, request records, and partial aggregate values must not
be used for cost, correctness, latency, reliability, or release evidence.

## Preservation and disposition

- The partial campaign remains preserved outside the repository for diagnosis.
- The 82 confirmed orphan processes were terminated with `SIGTERM`; none required
  `SIGKILL`, and a subsequent count found zero remaining processes.
- The invalid campaign must not be resumed, retried in place, merged, or
  cherry-picked into another campaign.
- Final certification must start from a fresh campaign root after the cleanup fix
  is committed and its process-lifecycle smoke passes with zero survivors.

## Remediation

The harness now calls OpenCode's MCP disconnect endpoint before terminating each
private server and keeps active-attempt tracking until server and meter cleanup
settle. A detached-child regression test and a real-process proof cover the leak:
`before=0`, `during=1`, `after=0`.
