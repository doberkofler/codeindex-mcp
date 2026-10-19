# Oracle ANTLR Phase 7 Performance Evidence

**Parser:** pinned ANTLR adapter (`parseWithAntlr`)

**Production binding:** structural parser; unchanged

**Corpus:** frozen Phase 0 LJS snapshot, 1,237 files
**Report:** `report.json`

Phase 7 measures the full ANTLR adapter against the frozen Phase 0 baseline.
It does not switch production and does not merge ANTLR and structural facts.

## Method

The standalone harness is `scripts/benchmarkOracleAntlr.mjs`. It bundles only
the ANTLR adapter with Vite, then imports that candidate bundle in worker
threads.

- Corpus paths come from `benchmark/oracle-phase0/units.json`.
- Every file is parsed with `parseWithAntlrProfiled`, which adds opt-in timers
  around tokenization, conditional-compilation preparation, lexing, SLL and LL
  prediction, declaration/reference/SQL/dependency visitors, recovery, and the
  total call.
- The harness runs the whole corpus with 1, 4, and 8 parser workers. Files are
  assigned greedily by descending byte size so the tail is distributed.
- Parallel wall time includes worker startup and bundle import.
- Peak RSS is sampled in the parent and in each worker.
- Warm one-file reconciliation parses a median-size and the largest file five
  times in a warmed process with the source already read.
- The candidate bundle is built separately from `dist/mcp.mjs` and
  `dist/cli.mjs`; no bundle contains both parsers.

The normal `parseWithAntlr` path does not install timers.

## Prediction strategy

The adapter uses two-stage prediction:

1. parse with `PredictionMode.SLL` and `BailErrorStrategy`;
2. reparse with `PredictionMode.LL` only when SLL bails.

A bailed SLL tree is never visited. Its diagnostics are discarded, so an SLL
attempt cannot leak parser warnings or partial facts into the result.

The report records `sllAttempts`, `llAttempts`, `prediction`, and
`recovered` per file.

## Results

Machine: Apple M5 Max, 64 GB, `darwin/arm64`, Node `v26.10.0`. Corpus: 1,237
files, 20.8 MB.

| Metric | Sequential | 4 workers | 8 workers |
| --- | ---: | ---: | ---: |
| Wall time | 148.0 s | 61.8 s | 46.2 s |
| Peak RSS | 4.67 GB | 8.27 GB | 11.47 GB |
| p50 file | 3.32 ms | 3.92 ms | 5.46 ms |
| p95 file | 539.7 ms | 830.4 ms | 1,192.8 ms |
| p99 file | 1,794 ms | 2,734 ms | 4,255 ms |
| Max file | 6,461 ms | 9,830 ms | 11,888 ms |

Eight workers improve wall time by 3.2× over sequential parsing, but still take
46.2 s. Peak RSS grows from 2.50 GB for the structural cold build to 4.67 GB for
one ANTLR worker and 11.47 GB for eight.

### Phase profile

Sequential totals:

| Phase | Time |
| --- | ---: |
| Tokenization | 1.24 s |
| Conditional preparation | 0.18 s |
| Conditional retokenization | 0.21 s |
| Lexer fill | 0.71 s |
| SLL prediction | 60.85 s |
| LL prediction | 81.18 s |
| Declaration visitor | 0.62 s |
| Reference visitor | 1.22 s |
| SQL-name visitor | 0.70 s |
| Dependency derivation | 0.05 s |
| Recovery span | 4.01 s |

Recovery overlaps its child SLL/LL and visitor phases; do not add the rows.
Prediction is 97% of the measured cost. Visitors are not the bottleneck.

Warm LL parses with and without parse-tree construction differ by about 1% on
three representative files (1.76 s vs 1.74 s, 2.70 s vs 2.68 s, and 0.60 s vs
0.59 s; median of three runs after one warmup). Parse-tree construction is not
the bottleneck; full-context prediction is.

### SLL fallback

| Metric | Value |
| --- | ---: |
| Files resolved by SLL | 1,106 |
| Files that fell back to LL | 131 |
| Time spent in failed SLL probes | 28.27 s |

The failed-probe cost is accepted because the successful SLL parses avoid full
LL prediction. A failed SLL tree is never visited and emits no diagnostics.

### One-file reconciliation

Warm process, source already read, parser only:

| File | Size | p50 |
| --- | ---: | ---: |
| Median-size corpus file | 5,204 B | 0.95 ms |
| Largest corpus file | 370,022 B | 1.89 s |

The sequential per-file p95 is 540 ms, which fits the 5 s edit warning gate. The
6.46 s maximum exceeds the warning and remains below the 15 s failure threshold.

### Baseline and bundle

| Comparison | Value |
| --- | ---: |
| Parser-only time / structural compiler stage | 50.86× |
| Sequential wall / cold build wall | 16.25× |
| Sequential wall / warm rebuild wall | 14.75× |
| Candidate bundle, raw / gzip | 9.54 MB / 1.50 MB |
| Baseline MCP bundle, raw / gzip | 2.04 MB / 0.31 MB |
| Baseline CLI bundle, raw / gzip | 2.21 MB / 0.35 MB |

## Decision

Full-build adoption is rejected on the measured evidence:

- parser cost is 50.86× the structural compiler stage;
- 8-worker parsing still exceeds the cold-build wall time by 5.1×;
- 8-worker peak RSS exceeds the memory failure ratio and the baseline bundle
  grows by 4.9× gzip;
- the grammar-subset option does not address the measured tail, which is in core
  name and expression decisions rather than unused DDL rules.

Incremental-only adoption remains a Phase 8 decision. One-file reconciliation
fits the edit gate at p95, but the largest-file tail is above the warning
threshold, and parser selection must change `compilerVersion` and `configHash`.
The structural parser stays in production.

## Integrity

| Artifact | SHA-256 |
| --- | --- |
| `report.json` | `9832993ecd86a64eb35a19a791f66edef41425faafcca8dcfb0aad92e965be15` |

## Reproduction

Build the repository first so baseline bundle sizes are available:

```bash
pnpm build
node scripts/benchmarkOracleAntlr.mjs --workers 1,4,8
```

Use a smaller corpus while iterating:

```bash
node scripts/benchmarkOracleAntlr.mjs --files 100 --workers 1,4
```

The evidence workspace defaults to
`${CODEINDEX_EVIDENCE_ROOT:-~/.local/share/codeindex-mcp}/oracle-live/2eb1e36f6ecdada4`.
Override it with `--evidence`.
