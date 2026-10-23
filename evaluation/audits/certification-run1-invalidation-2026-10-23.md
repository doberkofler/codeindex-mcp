# Certification run 1 invalidation

Date: 2026-10-23

Design: `impact-certification-v1`
(`5b3ab83fc4c006a4371c2e4ff77ef3f0e5d8c0d0e2e1a1f236f6aa4429da03f7`)

State root:
`/private/var/folders/cs/5lw8njjj1pjcz00wjnpx9nb80000gn/T/opencode/codeindex-certification-2026-10-23`

## Outcome

The campaign executed all 240 primary slots and stopped before the holdout
block. It wrote a `not-release` record from the primary block and exited 1.
That record is invalid and is not certification evidence.

- Primary executions: 240/240 stored, 303 attempt records.
- Holdout executions: 0/56.
- Final-attempt metered cost: `$0.1989`.
- Retained failed attempts: 63.
- Orphaned candidate MCP processes after exit: 0.

## Cause 1: the gates required an unexecuted arm

The certification campaign compares `candidate` against `no-index`. The
`accepted` artifact is exercised by the model-free route gate, not by the
sampled arms. Two checks nevertheless required `accepted` on every sampled run:

- `certificationTrajectoryOf` emitted `accepted-artifact-mismatch` for every
  run because `run.artifacts.accepted` was null.
- `manifestGateOf` required `manifest.artifacts.accepted.digest` to match the
  design, but the manifest records `accepted: null` for this campaign.

Consequently the record reported `0/240` valid executions, no paired cost or
correctness arm, and `not-release`. This was a harness defect, not an
observation about the candidate.

Remediation: per-run identity and the manifest now validate the candidate
artifact only. The accepted artifact identity remains a release gate through
the model-free route evidence, which requires both staged artifact digests.

## Cause 2: the resume route gate queried during an index rebuild

The first resume attempt stopped before any hosted spend. The model-free route
gate opened a published generation whose working copy was dirty, issued its
probes while freshness was still `updating`, and recorded the previous
generation as missing symbols. It then refused to overwrite the existing route
report. The stop is correct; the readiness condition was not.

Remediation: the route readiness loop now requires current freshness in addition
to a published generation, and waits through the rebuild before querying. Route
reports are regenerated from a clean route directory after the old model-free
evidence is archived.

## Cause 4: a route contract probe observed a partial rebuild

A second resume reached the model-free route cases successfully, but the
contract probes read a published generation containing 341 files and only 26
symbols. Pagination and truncation therefore observed empty results, and the
stale-file probe could not resolve its symbol. The route gate recorded
`E1 NOT PASSED`, but the campaign continued into cold starts because only a
thrown route error stopped execution. It was terminated before any primary slot
ran.

Remediation:

- A failed model-free route gate now stops the campaign before cold starts and
  before any hosted-model spend.
- The derived route databases are discarded and rebuilt from the clean
  workspaces before the next resume. They are disposable state, not evidence.
- No primary or holdout slot from the aborted attempt is retained.

## Cause 3: seven request-1 surface violations were admitted

Seven candidate-arm executions admitted an agent request 1 with only
`glob`, `grep`, `read`, and `shell`. The seven CodeIndex tools first appeared on
a later agent request. The harness recorded the mismatch but did not mark the
attempt invalid, so it consumed a planned slot instead of triggering the
existing retry policy.

Affected slots:

- `impact-build-generation-references/candidate/rep-3` (attempt 1)
- `impact-hash-content-references/candidate/rep-4` (attempt 2)
- `impact-hash-content-references/candidate/rep-14` (attempt 3)
- `impact-bounded-paged-result-references/candidate/rep-5` (attempt 1)
- `impact-schema-version-references/candidate/rep-9` (attempt 1)
- `impact-config-load-references/candidate/rep-9` (attempt 1)
- `impact-config-load-references/candidate/rep-13` (attempt 1)

Remediation: attempt validity now runs the direct request-1 surface assertion
whenever a provider meter exists. A mismatch marks the attempt invalid and the
ordinary retry policy applies, bounded at six attempts.

## Handling

- The run-1 certification record, route reports, and logs are retained under
  `audits/run-1/`.
- The aborted resume record and logs are retained under `audits/run-2/` and
  `audits/run-3/`.
- The seven slot directories are moved out of the result tree, with their raw
  streams, to `quarantine/request-1-surface/` under the state root.
- The invalid certification record and run-1 logs are retained under
  `audits/run-1/`.
- The campaign resumes with the same frozen design, suite, subject, artifact,
  and execution identity. The 233 primary slots that passed request-1 remain
  reused; the seven quarantined slots and the 56 holdout slots execute under the
  corrected admission check.
- No sample was selected by outcome. Quarantined executions failed the
  predeclared request-1 availability gate; correctness or cost never decides a
  retry.

## Residual limitation

The corrected check marks a mismatched request-1 attempt invalid after the
request is metered. It does not reject the request before it reaches the
provider. Request-1 availability is therefore enforced by retry rather than by
pre-spend admission. The certification record keeps every violated attempt, and
the retry bound prevents unbounded search for a passing trajectory.
