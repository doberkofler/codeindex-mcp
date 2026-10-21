# Aggregate reports

Reviewed aggregate results live here. A report is publishable only when it
contains:

- the campaign ID, suite ID/version/hash, and case IDs with their hashes;
- the pinned model, agent, treatment, and artifact identities with digests;
- harness, schema, and component versions plus the claim class;
- per-case and per-class per-treatment values with telemetry state and sample
  counts;
- gate results, stop-rule IDs, and supporting result digests.

Raw event streams, prompts, model responses, and restricted material never
enter this directory. They remain under `evaluation/results/` while a claim is
live, or in the private data repository.
