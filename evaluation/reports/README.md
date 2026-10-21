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

A reviewed `report.json` has this shape (values abbreviated):

```json
{
	"recordType": "report",
	"schemaVersion": "1.0",
	"campaign": {"campaignId": "<id>", "schemaVersion": "1.0", "suite": {"id": "<id>", "version": 5, "hash": "<hex>", "status": "draft"}, "components": {"harnessVersion": 10}, "claimClass": "none"},
	"sources": {"identityDigests": ["<hex>"], "schemaVersions": ["1.0"], "resultCount": 270, "comparisonDigest": "<hex>"},
	"runs": [{"identityDigest": "<hex>", "caseId": "<id>", "caseClass": "locate", "treatment": "candidate", "repetition": 1, "correctness": "pass", "workflow": "pass", "retrievalBytes": 1200, "toolCalls": 3, "wallTimeMs": 21000, "tokens": {"value": 3400, "state": "exact"}}],
	"noIndex": {"successRate": 1, "statistics": {"retrievalBytes": {"median": 3268, "p95": 5100, "min": 900, "max": 5400, "sampleCount": 60}}},
	"candidate": {"successRate": 1, "statistics": {"retrievalBytes": {"median": 2100, "p95": 3300, "min": 700, "max": 3600, "sampleCount": 60}}},
	"paired": {"candidateVsNoIndex": {"pairCount": 12, "metrics": {"retrievalBytes": {"medianDelta": -1168, "medianRatio": 0.642, "deltaInterval95": {"low": -1500, "high": -800, "confidence": 0.95, "resamples": 2000, "sampleCount": 12, "method": "paired-by-case-percentile-bootstrap", "seed": "<hex>"}}}}},
	"classes": [{"class": "locate", "caseIds": ["<id>"], "passed": true}],
	"thresholds": [{"name": "median retrieval output bytes at least 10% lower than no-index", "passed": true, "detail": "64.2% of no-index (n=60)"}],
	"passed": true
}
```
