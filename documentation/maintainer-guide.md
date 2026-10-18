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
