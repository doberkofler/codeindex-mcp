# Multi-adapter edit-to-fresh gate

This gate measures the combined production shape: five TypeScript project contexts
and one Oracle context share one database, watcher, build worker, and publication
boundary. A checked-in corpus is copied to a temporary workspace before measurement,
so edits never mutate the repository.

## Reproduce from a clean checkout

```bash
pnpm install
pnpm benchmark:multi-adapter --output /tmp/multi-adapter.json --summary /tmp/multi-adapter.md
```

The command builds the bundles, copies
[`benchmark/multi-adapter-corpus`](multi-adapter-corpus) into a temporary
workspace, runs the real watcher and build worker, and evaluates
[`benchmark/baseline-multi-adapter.json`](baseline-multi-adapter.json). It exits
`1` when any blocking gate fails.

Useful overrides:

- `--rounds <n>`: measured one-file edits, alternating adapters (default `10`).
- `--workspace <path>`: populate an empty directory instead of a temporary one.
- `--keep-workspace`: retain the temporary workspace and database.
- `--no-churn`: skip the supersession churn probe.
- `--baseline <path>`: evaluate against another checked-in baseline.

## Gates

All gates are blocking. There is no advisory mode and no partial-metric pass.

| Gate | Requirement |
| --- | --- |
| `compatibility.report` | Every required metric is present and schema-valid. |
| `compatibility.corpus`, `compatibility.corpus_sha256` | The measured corpus matches the checked-in baseline. |
| `coverage.typescript_contexts`, `coverage.oracle_contexts` | At least five TypeScript and one Oracle project context participate. |
| `coverage.edit_samples`, `coverage.adapter_edits`, `coverage.edit_targets` | Enough one-file edits and one target per adapter exist. |
| `absolute.edit.p95` | Event-to-publication p95 is at most 15,000 ms. |
| `isolation.cross_adapter` | A TypeScript edit produces zero Oracle probes, scans, extractions, and fact writes; an Oracle edit produces zero TypeScript work. |
| `isolation.*_edit_cost` | Each adapter's own edit actually exercised that adapter. |
| `supersession.composition`, `absolute.superseded.attempts`, `absolute.superseded.discarded_duration` | Every discarded attempt records cause, stage, adapter, and duration; attempts and discarded time stay within the declared bounds. |
| `absolute.process_tree.rss_peak`, `absolute.process_tree.rss_idle` | Peak and idle process-tree RSS stay under the declared ceilings. |
| `hygiene.freshness` | The index is current and has no dirty files after the final edit. |

`eventToPublicationMs` comes from the refresh coordinator and covers filesystem
event, debounce, targeted scan, extraction, and publication. Process-tree RSS is
sampled across the whole run, including worker threads and compiler child
processes, and measured again after the run reaches idle.

## Evidence

The report records every edit sample, per-round isolation counters, the complete
superseded chain, peak and idle process-tree RSS, storage, and freshness. The
evaluation sidecar names each gate with its actual and expected value. Update the
baseline deliberately when the corpus changes; a corpus hash mismatch is a gate
failure, not a warning.
