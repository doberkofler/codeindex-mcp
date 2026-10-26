# Oracle `structural@5` production performance baseline

**Status: PASS.** The retained production path passes all 45 gates. Cold build,
warm reuse, one-file edit-to-fresh, full rebuild, query, resource, storage, and
bundle gates pass. The thresholds are not relaxed and the summary is committed as
measured.

**Measured:** 2026-10-26T06:57:39Z to 2026-10-26T07:01:20Z (3.7 minutes)

**Aggregate:** [`summary.json`](./summary.json)

**Thresholds:** [`thresholds.json`](./thresholds.json), declared
2026-10-25T16:03:38Z, before the first measured run. Only the corpus bundle
reference moved to the current `oracle-o1@4` bundle, whose source hash,
configuration hash, and file count are identical; no warning or failure value
changed.

## Identities

| Item | Value |
|---|---|
| Runtime commit | `cee1cc5b04ffd58d465211b45c108b10662e9884` |
| Working tree at measurement | clean |
| Package | `codeindex-mcp@0.7.0` |
| Node / SQLite | `v26.10.0` / `3.53.4` |
| Machine | Apple M5 Max, 64 GB, `darwin/arm64` |
| Parser | `structural@5` with lexer `antlr4ng@3.0.16` |
| Corpus | 1,244 files / 1,244 objects, frozen 2026-10-25; re-qualified 2026-10-27 |
| Corpus bundle | `benchmark/oracle-production-20261027/corpus.json` |
| Corpus descriptor SHA-256 | `602640e416fb231927491b857218b6865654141c2a78167be0a621aa50cbba5e` |
| Source hash | `2bb0da1e8151410432cfe55d30607ed229976b7ccfd974a97027ebeb220f7f2a` |
| Plan/run config hash | `8ba026c038fe53224ab378d0e898589f0da818c4e32a3f98cf6957a493e24065` |
| Benchmark config hash | `d5433310f45bc69630d04d76b8b47b3cfc70119b0a8cd994d4c7ca8b164f74a1` |
| Database schema | `11` |
| MCP bundle raw / gzip | 2,228,621 B / 351,149 B |
| CLI bundle raw / gzip | 533,285 B / 134,208 B |
| MCP bundle SHA-256 | `c9bf23c02c5324970e80168d004f25cdd99bd518b4546f1892454e02624ff8b3` |
| CLI bundle SHA-256 | `a726be2c4503de1c9c266bedfbec77a29874209cbd032adc281aa9ac7c8ccc84` |
| Edit target | median-size source file, 5,204 B, SHA-256 `4100be68f69545b1a3ed091f6c45fa60b89d831794c41a1db80d2590e60b24a7` |

The plan/run configuration hash and the benchmark configuration hash are
different identities. The former belongs to the live qualification plan; the
latter is the benchmark manifest plus production parser binding. Both are
recorded, and the benchmark hash was stable across all five measured runs.

The frozen 2026-10-25 descriptor still carries the superseded `oracle-o1@2`
contract and no longer passes `oracle-preflight` at this commit. The 2026-10-27
descriptor was regenerated from the byte-identical snapshot and carries
`oracle-o1@4`; its source hash, configuration hash, and file count match the
declared corpus exactly.

## Method

`scripts/benchmarkOracleProduction.ts` verifies the frozen bundle with
`oracle-preflight` (no database, no Oracle connection), then runs the built
`dist/cli.mjs` benchmark command against a disposable copy of the frozen
workspace. Each repetition starts from a fresh copy and a fresh SQLite file. No
checkout is used as mutable test data.

Every repetition uses a fresh process per scenario:

1. `cold`: a new database, measured from an empty state.
2. `warm`: the same database, no changed source.
3. `rebuild`: the same database, forced full re-extraction; the preceding reuse
   is setup and is not the measured interval.
4. `deep`: deep cursor and 20 iterations of each query.
5. `edit`: five one-file edits through the real watcher, debounce, scan, and
   build worker; the file change is a trailing newline, which is valid in every
   source language and changes the content hash without changing facts.

One warmup repetition is discarded. Five measured repetitions supply the median,
p95, maximum, and coefficient of variation. Edit-to-fresh also retains its
per-round latency aggregate across the 25 measured edits. Raw reports,
workspace copies, and databases remain in the external evidence root.

### Incremental revision

One generation is published per database. Each successful refresh revises it in
place inside one write transaction and increments `generation.revision`; readers
keep the previous WAL snapshot until commit, and every multi-statement query is
pinned to one snapshot.

The Oracle adapter persists a digest of each file's parser output. For a changed
file with the same parser output as the published version, the adapter proves
that the complete extraction result is unchanged, because extractor facts are a
pure function of the parse set and every other file's content is unchanged. The
refresh then writes only the new content and file rows. If any parser output
differs, extraction runs normally and the core rewrites only the path groups
whose persisted fact digest changed, expanding the set for cross-path cascades.

The first refresh of a database writes one fact digest per path. A no-fact edit
therefore performs no fact writes; a fact-changing edit writes the affected path
groups only.

## Baseline

Build and scenario metrics over five measured runs:

| Metric | Min | Median | p95 | Max | CV |
|---|---:|---:|---:|---:|---:|
| Cold wall | 14,919 ms | 14,998 ms | 15,150 ms | 15,150 ms | 0.64% |
| Cold build | 14,687 ms | 14,766 ms | 14,914 ms | 14,914 ms | 0.63% |
| Cold CPU (user + system) | 17,371 ms | 17,450 ms | 17,780 ms | 17,780 ms | 0.82% |
| Cold peak RSS | 1,791,148,032 B | 1,883,897,856 B | 2,055,897,088 B | 2,055,897,088 B | 5.66% |
| Cold database | 554,418,176 B | 554,418,176 B | 554,418,176 B | 554,418,176 B | 0.00% |
| Cold storage (DB + WAL + SHM) | 998,046,384 B | 998,046,384 B | 998,046,384 B | 998,046,384 B | 0.00% |
| Warm reuse wall | 234 ms | 236 ms | 242 ms | 242 ms | 1.13% |
| Warm reuse CPU | 315 ms | 319 ms | 328 ms | 328 ms | 1.34% |
| Warm reuse peak RSS | 372,113,408 B | 372,637,696 B | 374,423,552 B | 374,423,552 B | 0.21% |
| Warm reuse storage | 554,479,816 B | 554,479,816 B | 554,479,816 B | 554,479,816 B | 0.00% |
| Full rebuild wall | 9,129 ms | 9,216 ms | 9,299 ms | 9,299 ms | 0.62% |
| Full rebuild build | 8,900 ms | 8,994 ms | 9,077 ms | 9,077 ms | 0.66% |
| Full rebuild CPU | 11,483 ms | 11,660 ms | 11,857 ms | 11,857 ms | 1.04% |
| Full rebuild peak RSS | 2,445,639,680 B | 2,516,353,024 B | 2,542,698,496 B | 2,542,698,496 B | 1.40% |
| Full rebuild storage | 554,846,496 B | 554,846,496 B | 554,846,496 B | 554,846,496 B | 0.00% |
| Edit-to-fresh round | 1,516 ms | 1,531 ms | 1,553 ms | 1,587 ms | 0.95% |
| Edit-to-fresh run p50 | 1,524 ms | 1,530 ms | 1,540 ms | 1,540 ms | 0.35% |
| Edit-to-fresh run p95 | 1,539 ms | 1,550 ms | 1,587 ms | 1,587 ms | 1.06% |
| Deep cursor wall | 268 ms | 268 ms | 277 ms | 277 ms | 1.29% |
| Deep cursor peak RSS | 418,512,896 B | 418,807,808 B | 419,201,024 B | 419,201,024 B | 0.07% |

Query p95 over the five runs:

| Query | Median of run p95 | Maximum |
|---|---:|---:|
| `status` | 0 ms | 0 ms |
| `find_symbol` | 1 ms | 1 ms |
| `outline` | 1 ms | 1 ms |
| `find_references` | 0 ms | 0 ms |
| `read_symbol` | 0 ms | 0 ms |

Every measured deep-cursor sample used an intended index and no temporary
B-tree.

Bundle and runtime size:

| Artifact | Raw | Gzip |
|---|---:|---:|
| `dist/mcp.mjs` | 2,228,621 B | 351,149 B |
| `dist/cli.mjs` | 533,285 B | 134,208 B |
| Node runtime | `v26.10.0` | — |
| SQLite | `3.53.4` | — |

## Declared thresholds and results

| Metric | Statistic | Warn | Fail | Measured | Status |
|---|---|---:|---:|---:|---|
| `cold.wallMs` | median | 15,000 | 30,000 | 14,998 | pass |
| `cold.buildMs` | median | 15,000 | 30,000 | 14,766 | pass |
| `cold.cpuMs` | median | 20,000 | 40,000 | 17,450 | pass |
| `cold.rssPeakBytes` | median | 3,500,000,000 | 5,000,000,000 | 1,883,897,856 | pass |
| `cold.storageTotalBytes` | median | 1,500,000,000 | 2,500,000,000 | 998,046,384 | pass |
| `cold.databaseBytes` | median | 1,000,000,000 | 1,800,000,000 | 554,418,176 | pass |
| `warm.wallMs` | median | 1,000 | 3,000 | 236 | pass |
| `warm.cpuMs` | median | 2,000 | 5,000 | 319 | pass |
| `warm.rssPeakBytes` | median | 3,500,000,000 | 5,000,000,000 | 372,637,696 | pass |
| `warm.storageTotalBytes` | median | 1,500,000,000 | 2,500,000,000 | 554,479,816 | pass |
| `rebuild.wallMs` | median | 20,000 | 40,000 | 9,216 | pass |
| `rebuild.buildMs` | median | 20,000 | 40,000 | 8,994 | pass |
| `rebuild.cpuMs` | median | 25,000 | 50,000 | 11,660 | pass |
| `rebuild.rssPeakBytes` | median | 4,000,000,000 | 6,000,000,000 | 2,516,353,024 | pass |
| `rebuild.storageTotalBytes` | median | 2,000,000,000 | 3,500,000,000 | 554,846,496 | pass |
| `edit.p50Ms` | median | 5,000 | 15,000 | 1,530 | pass |
| `edit.p95Ms` | median | 5,000 | 15,000 | 1,550 | pass |
| `edit.maxMs` | max | 10,000 | 30,000 | 1,587 | pass |
| `edit.latencyMs` | p95 | 5,000 | 15,000 | 1,553 | pass |
| `deep.wallMs` | median | 2,000 | 5,000 | 268 | pass |
| `deep.rssPeakBytes` | median | 3,500,000,000 | 5,000,000,000 | 418,807,808 | pass |
| `queries.status.p95Ms` | median | 25 | 100 | 0 | pass |
| `queries.find_symbol.p95Ms` | median | 25 | 100 | 1 | pass |
| `queries.outline.p95Ms` | median | 25 | 100 | 1 | pass |
| `queries.find_references.p95Ms` | median | 25 | 100 | 0 | pass |
| `queries.read_symbol.p95Ms` | median | 25 | 100 | 0 | pass |
| `bundle.mcp.rawBytes` | median | 3,000,000 | 5,000,000 | 2,228,621 | pass |
| `bundle.mcp.gzipBytes` | median | 500,000 | 800,000 | 351,149 | pass |
| `bundle.cli.rawBytes` | median | 1,000,000 | 2,000,000 | 533,285 | pass |
| `bundle.cli.gzipBytes` | median | 250,000 | 500,000 | 134,208 | pass |

Variance gates:

| Metric | Warn CV | Fail CV | Measured CV | Status |
|---|---:|---:|---:|---|
| `cold.wallMs` | 20% | 40% | 0.64% | pass |
| `warm.wallMs` | 30% | 60% | 1.13% | pass |
| `rebuild.wallMs` | 20% | 40% | 0.62% | pass |
| `edit.p95Ms` | 25% | 50% | 1.06% | pass |
| `deep.wallMs` | 25% | 50% | 1.29% | pass |

Ten integrity gates pass as well (corpus identity, plan identity, bundle
identity, and per-run storage and diagnostic counts), for 45 passes in total.

`cold.wallMs` passes by 2 ms. That is a real margin risk on a different machine,
not a weakened gate: the warning value is unchanged at 15,000 ms.

## Edit-to-fresh result

One-file edit-to-fresh is **1.53 s median** and **1.59 s maximum** on a 5,204 B
median-size Oracle source file. The declared gate warns above 5 s and fails above
15 s; all 25 measured rounds stay between 1,516 ms and 1,587 ms.

A representative measured edit (run 1) reused 1,243 of 1,244 content versions
and had these production build stages:

| Stage | Time |
|---|---:|
| Scan | 79 ms |
| Compiler / extraction | 0 ms (parser-output proof only) |
| Insertion | 60 ms |
| Verification | 537 ms |
| Publication | 155 ms |

The remaining wall time is the 500 ms watcher debounce plus event delivery. The
proof re-parses one 5,204 B file and compares its parser digest; no symbol,
reference, or dependency extraction runs. Verification is a foreign-key check
plus `quick_check`, and publication updates generation metadata and planner
statistics.

Database growth is bounded. After the five edits every measured repetition held
554,422,272 B of database pages (554.4 MB, unchanged from the cold publication),
1,244 content versions, and 3,730 extraction artifacts — one symbol artifact, one
dependency artifact, and one parser digest per content version. Total storage
including WAL and SHM was 555,575,712 B. The previous baseline grew to
2,368,754,184 B after five edits because the content-dependent artifact context
re-keyed every artifact and every edit rewrote the complete fact set.

A fact-changing edit still re-extracts the complete corpus; the forced-rebuild
scenario measures that path at **9.2 s median**, down from 15.0 s because the
fact write is now a per-path delta instead of a full generation copy.

## Comparison with the Phase 0 baseline

Phase 0 measured 1,237 files at a different commit and an earlier structural
parser revision. It is context, not a gate.

| Metric | Phase 0 | This baseline | Change |
|---|---:|---:|---:|
| Cold wall | 9,109 ms | 14,998 ms | +64.6% |
| Warm reuse | 208 ms | 236 ms | +13.5% |
| Warm rebuild | 10,037 ms | 9,216 ms | −8.2% |
| Cold peak RSS | 2.50 GB | 1.88 GB | −24.6% |
| Cold storage | 915,822,048 B | 998,046,384 B | +9.0% |

The corpus grew by seven files and the structural parser gained declaration and
reference precision, so cold build is not directly comparable across revisions.
The warm rebuild comparison is like-for-like: both perform full extraction, and
the revision delta removes the generation-copy cost.

## Integrity

| Artifact | SHA-256 |
|---|---|
| `summary.json` | `e6a54dab7745bdeb7a4f21d5bd2af4beaffa899a83817c50e75acc8d9ca89c02` |
| `thresholds.json` | `56c4d1283c4e8b02155ef3ad3f4022209c9f92aa26379212da735b256fb95f76` |
| Corpus descriptor | `602640e416fb231927491b857218b6865654141c2a78167be0a621aa50cbba5e` |
| External `manifest.json` | `7353d547d3dd573b3d94edc9039f15913961883d9d5208e1c9db21fcf44e48dd` |
| External `checksums.sha256` | `b3e5ed4121ff4732101f248ef07a1e05454e911e81b9b0da5aee47e34c3dfa2f` |

The external evidence root is
`${CODEINDEX_EVIDENCE_ROOT:-~/.local/share/codeindex-mcp}/oracle-performance/2026-10-26T065738Z`.
It contains `preflight.log`, `manifest.json`, `checksums.sha256`, five measured
run directories, one warmup directory, and per-process logs. The committed
summary contains no source text, symbol names, credentials, queries, or absolute
paths. Raw benchmark reports and logs stay external only.

## Reproduction

```bash
pnpm benchmark:oracle:production
```

The command builds `dist`, verifies the frozen 2026-10-27 bundle, and runs one
warmup plus five measured repetitions. Measured duration on the reference machine
is **3.7 minutes**; allow 5–10 minutes on a comparable machine. It needs the
frozen corpus at the evidence root, about 2 GB of free disk, and no Oracle
connection.

Useful overrides:

```bash
node --experimental-strip-types scripts/benchmarkOracleProduction.ts \
  --runs 3 --warmups 1 \
  --output "${CODEINDEX_EVIDENCE_ROOT:-$HOME/.local/share/codeindex-mcp}/oracle-performance/adhoc"
```

The summary and external evidence are written even when a gate fails.
`--keep-workspaces` retains the disposable source copies and databases for
inspection.
