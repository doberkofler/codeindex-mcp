# Oracle `structural@5` production performance baseline

**Status: FAIL.** The retained production path passes 41 gates, warns on 1, and
fails 3. Every failure is the one-file edit-to-fresh class; all build, reuse,
rebuild, query, resource, storage, and bundle gates pass. The thresholds are not
relaxed and the summary is committed as measured.

**Measured:** 2026-10-25T17:03:21Z to 2026-10-25T17:17:45Z (14.4 minutes)

**Aggregate:** [`summary.json`](./summary.json)

**Thresholds:** [`thresholds.json`](./thresholds.json), declared
2026-10-25T16:03:38Z, before the first measured run.

## Identities

| Item | Value |
|---|---|
| Runtime commit | `30dbed14d8e44339c5fafd4ed9af4c8a39ca1d4f` |
| Working tree at measurement | clean |
| Package | `codeindex-mcp@0.7.0` |
| Node / SQLite | `v26.10.0` / `3.53.4` |
| Machine | Apple M5 Max, 64 GB, `darwin/arm64` |
| Parser | `structural@5` with lexer `antlr4ng@3.0.16` |
| Corpus | 1,244 files / 1,244 objects, frozen 2026-10-25 |
| Corpus descriptor SHA-256 | `a72e1d13db4a93ad5f47a65670fdcc29221036478a462a456691c0504c544f4b` |
| Source hash | `2bb0da1e8151410432cfe55d30607ed229976b7ccfd974a97027ebeb220f7f2a` |
| Plan/run config hash | `8ba026c038fe53224ab378d0e898589f0da818c4e32a3f98cf6957a493e24065` |
| Benchmark config hash | `c297208b69152109b3fa659483cec50dedaaecd2272970bb213d069cf9e2b45e` |
| Database schema | `10` |
| MCP bundle raw / gzip | 2,212,226 B / 347,320 B |
| CLI bundle raw / gzip | 518,808 B / 130,848 B |
| MCP bundle SHA-256 | `c4c6cfa23a14d6aef650c9ceb296d456905cfce9657e5463c69be31abfc84f71` |
| CLI bundle SHA-256 | `05019a6ef44ee13d38071731ff6e8bec1343ee1126b5d196cbaed77e512105d9` |
| Edit target | median-size source file, 5,204 B, SHA-256 `4100be68f69545b1a3ed091f6c45fa60b89d831794c41a1db80d2590e60b24a7` |

The plan/run configuration hash and the benchmark configuration hash are
different identities. The former belongs to the live qualification plan; the
latter is the benchmark manifest plus production parser binding. Both are
recorded, and the benchmark hash was stable across all five measured runs.

## Method

`scripts/benchmarkOracleProduction.ts` verifies the frozen bundle with
`oracle-preflight` (no database, no Oracle connection), then runs the built
`dist/cli.mjs` benchmark command against a disposable copy of the frozen
workspace. Each repetition starts from a fresh copy and a fresh SQLite file. No
checkout is used as mutable test data.

Every repetition uses a fresh process per scenario:

1. `cold`: a new database, measured from an empty state.
2. `warm`: the same database, no changed source.
3. `rebuild`: the same database, forced full rebuild; the preceding reuse is
   setup and is not the measured interval.
4. `deep`: deep cursor and 20 iterations of each query.
5. `edit`: five one-file edits through the real watcher, debounce, scan, and
   build worker; the file change is a trailing newline, which is valid in every
   source language and changes the content hash without changing facts.

One warmup repetition is discarded. Five measured repetitions supply the median,
p95, maximum, and coefficient of variation. Edit-to-fresh also retains its
per-round latency aggregate across the 25 measured edits. Raw reports,
workspace copies, and databases remain in the external evidence root.

## Baseline

Build and scenario metrics over five measured runs:

| Metric | Min | Median | p95 | Max | CV |
|---|---:|---:|---:|---:|---:|
| Cold wall | 13,615 ms | 13,650 ms | 14,193 ms | 14,193 ms | 1.59% |
| Cold build | 13,372 ms | 13,409 ms | 13,948 ms | 13,948 ms | 1.61% |
| Cold CPU (user + system) | 15,936 ms | 16,018 ms | 16,566 ms | 16,566 ms | 1.41% |
| Cold peak RSS | 2,692,546,560 B | 2,711,207,936 B | 2,724,249,600 B | 2,724,249,600 B | 0.41% |
| Cold database | 553,168,896 B | 553,168,896 B | 553,168,896 B | 553,168,896 B | 0.00% |
| Cold storage (DB + WAL + SHM) | 969,799,128 B | 969,799,128 B | 969,799,128 B | 969,799,128 B | 0.00% |
| Warm reuse wall | 237 ms | 238 ms | 240 ms | 240 ms | 0.43% |
| Warm reuse CPU | 319 ms | 324 ms | 324 ms | 324 ms | 0.64% |
| Warm reuse peak RSS | 374,374,400 B | 374,964,224 B | 375,455,744 B | 375,455,744 B | 0.10% |
| Warm reuse storage | 553,230,536 B | 553,230,536 B | 553,230,536 B | 553,230,536 B | 0.00% |
| Full rebuild wall | 14,908 ms | 15,011 ms | 15,088 ms | 15,088 ms | 0.41% |
| Full rebuild build | 14,683 ms | 14,781 ms | 14,850 ms | 14,850 ms | 0.40% |
| Full rebuild CPU | 17,215 ms | 17,380 ms | 17,439 ms | 17,439 ms | 0.45% |
| Full rebuild peak RSS | 3,447,242,752 B | 3,639,017,472 B | 3,665,149,952 B | 3,665,149,952 B | 2.27% |
| Full rebuild storage | 1,386,010,240 B | 1,386,971,512 B | 1,386,971,512 B | 1,386,971,512 B | 0.03% |
| Edit-to-fresh round | 21,878 ms | 22,067 ms | 22,296 ms | 22,335 ms | 0.54% |
| Edit-to-fresh run p50 | 22,029 ms | 22,094 ms | 22,117 ms | 22,117 ms | 0.18% |
| Edit-to-fresh run p95 | 22,067 ms | 22,168 ms | 22,335 ms | 22,335 ms | 0.41% |
| Deep cursor wall | 271 ms | 273 ms | 276 ms | 276 ms | 0.68% |
| Deep cursor peak RSS | 421,134,336 B | 422,019,072 B | 423,264,256 B | 423,264,256 B | 0.18% |

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
| `dist/mcp.mjs` | 2,212,226 B | 347,320 B |
| `dist/cli.mjs` | 518,808 B | 130,848 B |
| Node runtime | `v26.10.0` | — |
| SQLite | `3.53.4` | — |

## Declared thresholds and results

| Metric | Statistic | Warn | Fail | Measured | Status |
|---|---|---:|---:|---:|---|
| `cold.wallMs` | median | 15,000 | 30,000 | 13,650 | pass |
| `cold.buildMs` | median | 15,000 | 30,000 | 13,409 | pass |
| `cold.cpuMs` | median | 20,000 | 40,000 | 16,018 | pass |
| `cold.rssPeakBytes` | median | 3,500,000,000 | 5,000,000,000 | 2,711,207,936 | pass |
| `cold.storageTotalBytes` | median | 1,500,000,000 | 2,500,000,000 | 969,799,128 | pass |
| `cold.databaseBytes` | median | 1,000,000,000 | 1,800,000,000 | 553,168,896 | pass |
| `warm.wallMs` | median | 1,000 | 3,000 | 238 | pass |
| `warm.cpuMs` | median | 2,000 | 5,000 | 324 | pass |
| `warm.rssPeakBytes` | median | 3,500,000,000 | 5,000,000,000 | 374,964,224 | pass |
| `warm.storageTotalBytes` | median | 1,500,000,000 | 2,500,000,000 | 553,230,536 | pass |
| `rebuild.wallMs` | median | 20,000 | 40,000 | 15,011 | pass |
| `rebuild.buildMs` | median | 20,000 | 40,000 | 14,781 | pass |
| `rebuild.cpuMs` | median | 25,000 | 50,000 | 17,380 | pass |
| `rebuild.rssPeakBytes` | median | 4,000,000,000 | 6,000,000,000 | 3,639,017,472 | pass |
| `rebuild.storageTotalBytes` | median | 2,000,000,000 | 3,500,000,000 | 1,386,971,512 | pass |
| `edit.p50Ms` | median | 5,000 | 15,000 | 22,094 | **failure** |
| `edit.p95Ms` | median | 5,000 | 15,000 | 22,168 | **failure** |
| `edit.maxMs` | max | 10,000 | 30,000 | 22,335 | warning |
| `edit.latencyMs` | p95 | 5,000 | 15,000 | 22,296 | **failure** |
| `deep.wallMs` | median | 2,000 | 5,000 | 273 | pass |
| `deep.rssPeakBytes` | median | 3,500,000,000 | 5,000,000,000 | 422,019,072 | pass |
| `queries.status.p95Ms` | median | 25 | 100 | 0 | pass |
| `queries.find_symbol.p95Ms` | median | 25 | 100 | 1 | pass |
| `queries.outline.p95Ms` | median | 25 | 100 | 1 | pass |
| `queries.find_references.p95Ms` | median | 25 | 100 | 0 | pass |
| `queries.read_symbol.p95Ms` | median | 25 | 100 | 0 | pass |
| `bundle.mcp.rawBytes` | median | 3,000,000 | 5,000,000 | 2,212,226 | pass |
| `bundle.mcp.gzipBytes` | median | 500,000 | 800,000 | 347,320 | pass |
| `bundle.cli.rawBytes` | median | 1,000,000 | 2,000,000 | 518,808 | pass |
| `bundle.cli.gzipBytes` | median | 250,000 | 500,000 | 130,848 | pass |

Variance gates:

| Metric | Warn CV | Fail CV | Measured CV | Status |
|---|---:|---:|---:|---|
| `cold.wallMs` | 20% | 40% | 1.59% | pass |
| `warm.wallMs` | 30% | 60% | 0.43% | pass |
| `rebuild.wallMs` | 20% | 40% | 0.41% | pass |
| `edit.p95Ms` | 25% | 50% | 0.41% | pass |
| `deep.wallMs` | 25% | 50% | 0.68% | pass |

## Edit-to-fresh failure

One-file edit-to-fresh is **22.1 s median** and **22.3 s maximum** on a 5,204 B
median-size Oracle source file. The declared gate warns above 5 s and fails
above 15 s. Every one of the 25 measured edit rounds is between 21.9 s and
22.3 s; this is not a first-round or cache-warming artifact.

The changed file is extracted once, but insertion, verification, and publication
still scale with the complete corpus. A representative measured edit (run 1)
reused 1,243 of 1,244 content versions and had these production build stages:

| Stage | Time |
|---|---:|
| Scan | 87 ms |
| Compiler / extraction | 6,648 ms |
| Insertion | 5,658 ms |
| Verification | 4,116 ms |
| Publication | 4,255 ms |

The changed file is extracted once, but insertion, verification, and publication
still scale with the complete corpus. After five edits the database reached
2,368,754,184 B total including WAL, with 14,920 extraction artifact rows.
Extraction artifacts are persisted but never consumed; the existing
`artifactConsumption: not_implemented` limitation therefore leaves the insertion
path with no incremental reuse.

This is a production performance defect, not a harness artifact. ORA-005 retains
the measurement; it does not change the gate or optimize the pipeline. Improving
incremental publication, or replacing the edit gate with evidence, requires a
separate issue and a new declared threshold.

## Comparison with the Phase 0 baseline

Phase 0 measured 1,237 files at a different commit and an earlier structural
parser revision. It is context, not a gate.

| Metric | Phase 0 | This baseline | Change |
|---|---:|---:|---:|
| Cold wall | 9,109 ms | 13,650 ms | +49.8% |
| Warm reuse | 208 ms | 238 ms | +14.4% |
| Warm rebuild | 10,037 ms | 15,011 ms | +49.6% |
| Cold peak RSS | 2.50 GB | 2.71 GB | +8.4% |
| Cold storage | 915,822,048 B | 969,799,128 B | +5.9% |

The corpus grew by seven files, so the build delta is not explained by corpus
size alone. Phase 7 ANTLR measurements remain parser-only evidence and are not a
production comparison.

## Integrity

| Artifact | SHA-256 |
|---|---|
| `summary.json` | `b538ccec84885879bc79ca32fbf9cf1ab3c814a1ad286522ffd287769caae3a2` |
| `thresholds.json` | `955ffca99c99f74c99b501e3e3e095c24ffb7628d30502e7c6f3d7cf5ab2ce59` |
| Corpus descriptor | `a72e1d13db4a93ad5f47a65670fdcc29221036478a462a456691c0504c544f4b` |
| External `manifest.json` | `02a47189d02b9f5583da45ef6e94b4df122af0e72a34d53d87636a08795c721e` |
| External `checksums.sha256` | `5bdb046c94368d95859bdcdb5fed8a48585f9d2d4e17e54b5f81bc713e577b25` |

The external evidence root is
`${CODEINDEX_EVIDENCE_ROOT:-~/.local/share/codeindex-mcp}/oracle-performance/2026-10-25T170321Z`.
It contains `preflight.log`, `manifest.json`, `checksums.sha256`, five measured
run directories, one warmup directory, and per-process logs. The committed
summary contains no source text, symbol names, credentials, queries, or absolute
paths. Raw benchmark reports and logs stay external only.

## Reproduction

```bash
pnpm benchmark:oracle:production
```

The command builds `dist`, verifies the frozen bundle, and runs one warmup plus
five measured repetitions. Expected duration on the reference machine is
**15 minutes** (measured: 14.4 minutes); allow 15–25 minutes on a comparable
machine. It needs the frozen corpus at the evidence root, about 5 GB of free disk
(near 2.4 GB during the edit scenario), and no Oracle connection.

Useful overrides:

```bash
node --experimental-strip-types scripts/benchmarkOracleProduction.ts \
  --runs 3 --warmups 1 \
  --output "${CODEINDEX_EVIDENCE_ROOT:-$HOME/.local/share/codeindex-mcp}/oracle-performance/adhoc"
```

The command exits `1` while the edit-to-fresh gate fails; the summary and
external evidence are still written. `--keep-workspaces` retains the disposable
source copies and databases for inspection.
