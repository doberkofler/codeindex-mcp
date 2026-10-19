# Maintainer Guide

## 1. Purpose

This document preserves operational and quality contracts needed to evolve the
index safely. Shipped behavior remains authoritative in code and tests; planned
adapter behavior is identified in the roadmap and adapter designs.

## 2. Startup contract

1. Validate configuration before opening transport or storage.
2. Open the derived database and enforce its schema version.
3. Read the published generation.
4. Open MCP transport without waiting for a rebuild.
5. Start watchers for adapter-declared source and configuration inputs.
6. Reconcile deterministic workspace state in a worker.
7. Reuse a matching generation or build and atomically publish a replacement.

With no generation, queries return `index_not_ready`. With an older published
generation, queries may continue during refresh but report non-current freshness.

## 3. Refresh contract

The coordinator permits one active build and one coalesced follow-up:

- an event marks state dirty;
- burst events are debounced;
- events during a build set one follow-up flag;
- successful publication returns to current or schedules the follow-up;
- failure retains the published generation and reports stale;
- periodic reconciliation repairs missed watcher events;
- shutdown rejects scheduling, closes watcher/timers, stops the worker, then closes
  SQLite.

Filesystem events are hints. Adapter scanning is authoritative. Exact debounce and
reconciliation intervals are measured configuration, not architectural constants.

## 4. Publication and concurrency

- lease acquisition/renewal is transactional;
- only the lease owner creates or publishes a generation;
- ownership uses a random owner token, never process ID alone;
- the owner renews the lease while its worker builds;
- takeover occurs only after expiry;
- non-owners remain readers and observe external publication;
- every query resolves one published token at start and keeps it for the call;
- failed private generations never replace the published generation.

Schema changes bump `SCHEMA_VERSION`. Move one incompatible database aside as a
`.schema-<version>.bak` file and rebuild. Never add in-place migrations to derived
index data.

## 5. Adapter acceptance

Every adapter must provide:

- deterministic project/configuration identity;
- exact included files and explicit exclusions;
- raw-content and context hashes;
- serializable facts without compiler/parser/database objects;
- bounded diagnostics and explicit coverage limitations;
- fixtures for supported and unsupported syntax;
- a validation authority: language service, parser corpus, dictionary, or reviewed
  mapping sample;
- freshness inputs and watchable configuration files;
- privacy classification for every persisted field.

Parser success is not semantic validity. Generated output must pass adapter-specific
precision, completeness, and consistency checks before publication.

## 6. Verification matrix

Unit tests cover:

- refresh transitions, debounce, follow-up, failure, and shutdown;
- path filtering and configuration invalidation;
- freshness mapping and dirty-source rejection;
- lease acquisition, renewal, expiry, and ownership;
- schema replacement and content deduplication;
- external publication observation;
- pagination/cursor binding and byte bounds;
- analytics privacy, rotation, retention, and opt-out;
- adapter extraction and unresolved/ambiguous cases;
- critical query plans.

Integration tests use temporary fixture workspaces, databases, and—when needed—a
disposable development Oracle schema. They never use a real checkout or production
database. Cover initial build, reuse, add/change/delete/rename, configuration
change, blocked build, failure recovery, two-process contention, lease-owner death,
responsive MCP transport, and every production bundle.

Oracle integration additionally proves read-only operation, dictionary privilege
modes, overload preservation, source/live mapping, and PL/Scope unavailable paths.
ORDS integration uses sanitized fixtures or disposable metadata and proves route
ambiguity and authorization-fact retention.

## 7. Performance verification

Measure these layers independently:

1. storage statement execution;
2. core method execution;
3. MCP serialization and transport;
4. client wrapping such as Code Mode;
5. complete agent task.

Measure warm/cold queries, deep cursors, bounded reads, cold build, no-change
refresh, one-file edit, configuration invalidation, event bursts, startup,
event-to-publication, memory, CPU, database growth, contention, takeover, and an
edit/restart soak.

Every hot query must have an intended bounded `EXPLAIN QUERY PLAN`. Replace offset
pagination when latency grows with cursor depth. Apply SQLite tuning only after a
benchmark proves benefit without weakening publication safety.

### 7.1 Model-free benchmark command

```bash
# Generated corpus; cold, no-change, forced rebuild, deep cursor, and queries
codeindex-cli benchmark --profile small --scenarios cold,warm,rebuild,deep

# Add one-file edit-to-fresh rounds (generated corpora only; source is mutated)
codeindex-cli benchmark --profile medium --scenarios cold,edit --edit-rounds 5

# External checkout; only non-mutating scenarios. Database stays temporary.
codeindex-cli benchmark --root /path/to/project --scenarios cold,warm,rebuild,deep

# Enforce gates, write an evaluation sidecar, and publish a Markdown summary.
codeindex-cli benchmark --profile large --scenarios cold,warm,rebuild,edit,deep \
  --baseline benchmark/baseline.json \
  --evaluation benchmark/results/nightly.evaluation.json \
  --summary benchmark/results/nightly.md

# Add --reference benchmark/reference.json when a retained reference exists.
```

The report schema is version 2 and is written to `benchmark/results/` by default.
Scenarios share one process. For process-cold RSS and allocator state, invoke one
scenario per process, for example `--scenarios cold`.
Each scenario records wall time, CPU user/system time, RSS start/peak/end,
database plus WAL/SHM bytes, content and extraction-artifact counts, build
stages, and generation/content reuse. Edit-to-fresh records every write-to-fresh
latency plus p50/p95/p99/max. Deep cursor samples record the exact production
statement's plan, whether the intended index was used, and whether SQLite built a
temporary B-tree.

### 7.2 Gates, baselines, and reporting

`benchmark/baseline.json` is versioned independently (`schemaVersion: 1`). It
declares the accepted report schema version, workspace compatibility, required
scenarios, thresholds, and an optional reference. `--reference` accepts a previous
benchmark report and overrides the embedded reference, so an accepted nightly
report can be compared without editing the baseline. Only machine, workspace,
scenario, and query measurements are retained. Relative gates activate only when a
reference is present.

Every gate has `status: pass | warning | failure | skipped`. The CLI writes
`<report>.evaluation.json` by default when `--baseline` is supplied. Only
`failure` produces exit code 1; warnings remain successful. Nightly gates should
therefore fail on major regressions, incompatible corpora, or invalid deep-cursor
plans, not on advisory debt.

The committed baseline applies absolute gates for edit-to-fresh p95 (warning
above 5 s, failure above 15 s) and query p95 (warning above 25 ms, failure above
100 ms). Deep-cursor samples fail when an intended index is missing and warn when
SQLite uses a temporary B-tree. Relative build, edit, query, RSS, CPU, and storage
gates use the configured ratios and slack values. Workspace file and symbol
counts must stay within the compatibility tolerance. Reference-machine mismatches
warn, and relative gate failures are downgraded to warnings because hosted CI
numbers are not authoritative. Absolute gates and invalid plans still fail on any
machine.

`--summary <path>` writes GitHub-flavoured Markdown derived from the same JSON
report and evaluation. The report and evaluation JSON remain authoritative. The
scheduled workflow writes both artifacts and appends the summary to
`$GITHUB_STEP_SUMMARY`.

Generated workspaces and temporary databases are deleted after the run. Pass
`--keep-workspace` to retain both paths for inspection; an explicit `--workspace`
already persists the corpus without that flag.

A generated corpus carries a `.codeindex-benchmark.json` marker recording its
profile and expected counts. `--workspace` reuses a directory only when that
marker is present and matches `--profile`; a directory that merely contains a
`tsconfig.json` is rejected so measurements cannot be attributed to an unrelated
project.

Artifact reuse is currently measured as zero because extraction artifacts are
persisted but never consumed. This produces a warning, not a failure; implement
artifact consumption only when a measured gate requires it.

Generated profiles are deterministic and disposable: `small`, `medium`, `large`,
and `xl`. Real-project runs use a pinned public checkout, recorded revision,
project file, dependency-lock hash, and Node identity. Edit-to-fresh refuses an
external root so a benchmark never modifies a user checkout.

Run small profiles in ordinary development. Run `large` or `xl` and pinned public
projects in the nightly job with broad order-of-magnitude bounds. Hard latency and
resource gates use a stable reference machine; hosted CI numbers are directional.

Nightly public-project set:

| Project | Selected project file | Coverage |
| --- | --- | --- |
| `microsoft/TypeScript` | compiler project discovered during qualification | compiler-heavy, dense references |
| `microsoft/vscode` | `src/tsconfig.json` | large application graph |
| `mui/material-ui` | `packages/mui-material/tsconfig.json` | TSX, re-exports, package boundaries |

Each run records the repository URL, exact revision, project file, dependency-lock
hash, and Node identity. Checkouts and dependency setup happen outside the measured
scenario. Do not commit checkouts, installed dependencies, or derived databases.

The scheduled [benchmark workflow](../.github/workflows/benchmark.yml) runs the
generated corpus nightly, enforces the committed gates, uploads the report and
evaluation JSON, and publishes the Markdown summary. Absolute gates and invalid
plans fail nightly; relative gates require a reference report, and
reference-machine gates remain authoritative.

Reference-machine targets:

| Dimension | Gate |
| --- | --- |
| Stale source | Zero stale source returned |
| Reference quality | ≥99.5% recall and 100% precision on ≥200 stratified symbols |
| One-file freshness | p95 ≤15 s |
| Warm SQLite query | p95 ≤25 ms with intended plan |
| Bounded source read | p95 ≤50 ms |
| Local MCP call | p95 ≤100 ms excluding model scheduling |
| Cached status | p95 ≤25 ms without workspace scan |
| Warm startup | transport available ≤500 ms with reusable database |
| Build queue | one active build and one coalesced follow-up |
| Idle CPU | average <1% after reconciliation |
| Reliability | four-hour edit/restart soak without manual repair |

Hardware-sensitive gates may be recalibrated only with the prior baseline,
replacement value, machine identity, and reason recorded. CI may use broader
regression bounds but must detect order-of-magnitude regressions.

## 8. Analytics and privacy

Analytics are local, versioned, bounded, and optional. Record tool, duration,
bytes, counts, truncation, freshness, stable error code, build stages, watcher
coalescing, lease events, storage size, and bounded resource samples.

Never record source, snippets, prompts, model responses, queries, symbol names,
credentials, request values, SQL values, headers, cookies, IP addresses, or
absolute paths. Rotate by size, count, and age. Analytics cannot infer tool
adoption because MCP cannot observe fallback tools; use an explicitly approved
client event export for that denominator.

## 9. Release discipline

- run `pnpm verify`, `pnpm verify:references`, and `pnpm build`;
- keep stdout reserved for MCP framing;
- inspect bundle contents for accidental evaluation/private code;
- update architecture, adapter limitations, roadmap status, and changelog;
- pin evaluation to the production MCP artifact;
- smoke-test connection, one navigation chain, edit freshness, and reconnect after
  upgrade;
- never weaken TypeScript, lint, format, Knip, or test checks to ship.

## 10. Rollback

Rollback is configuration-only: disconnect or remove the MCP registration and use
normal repository tools. The index is derived data. Cleanup may remove bounded
cache and analytics locations but never source, build artifacts, or retained
evaluation evidence unless separately requested.
