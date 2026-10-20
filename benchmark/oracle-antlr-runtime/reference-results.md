# Reference Results

Run on 2026-10-19/20.

**Machine:** Apple M5 Max, 64 GB, macOS arm64, Docker Desktop `linux/arm64`.

**Corpus:** 15 files selected from 1,237 Oracle sources (20,817,931 bytes) by
size quantiles. Total sample size: 835,953 bytes.

**Configuration:** 3 isolated cold parses per file; 1 warmup and 5 samples per
file; one shared-DFA corpus pass.

- Go: `golang:1.23.12-bookworm`, ANTLR 4.13.1, SLL-first with LL fallback.
- Rust: `rust:1.95-bookworm`, `antlr-rust-runtime` 0.34.0, LL-only,
  generated-only mode.
- TypeScript: parser core only (`lexerMs + sllParseMs + llParseMs`), SLL-first
  with LL fallback.

Times are milliseconds. Rust is LL-only; Go and TypeScript are SLL-first. This
is not an identical prediction-mode comparison.

| File | Bytes | Go cold | Rust cold | TS core cold | Go warm | Rust warm | TS core warm | Go pass | Rust pass | TS core pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| units/0006-LAS_CR00900.pks | 148 | 11.315 | 6.512 | 21.876 | 0.012 | 0.085 | 0.224 | 12.560 | 6.292 | 22.191 |
| PACKAGES/las_mod_pm_teamoverview.pks | 1,033 | 11.179 | 6.140 | 22.189 | 0.025 | 0.168 | 0.217 | 0.846 | 0.526 | 1.226 |
| PACKAGES/tst_unittest_session.pks | 1,256 | 39.667 | 15.996 | 38.114 | 0.053 | 10.887 | 0.315 | 36.436 | 13.206 | 22.762 |
| PACKAGES/las_mod_pm_kanbanboard_page.pkb | 1,686 | 249.745 | 128.115 | 245.325 | 0.118 | 106.163 | 1.277 | 203.843 | 113.028 | 202.247 |
| PACKAGES/las_jsn_text.pks | 2,398 | 100.618 | 46.795 | 101.608 | 0.065 | 37.879 | 0.537 | 16.457 | 38.029 | 17.387 |
| PACKAGES/las_jsn_sdeb.pks | 3,275 | 68.166 | 54.689 | 71.844 | 0.111 | 43.657 | 0.715 | 9.888 | 43.887 | 11.799 |
| PACKAGES/las_mod_jobtemplategroup_data.pks | 5,204 | 44.195 | 11.853 | 46.473 | 0.121 | 3.137 | 0.804 | 0.758 | 3.699 | 1.213 |
| PACKAGES/las_sql_joblist.pks | 8,169 | 52.207 | 56.768 | 54.244 | 0.429 | 40.003 | 2.469 | 3.640 | 42.318 | 5.609 |
| PACKAGES/las_mod_region_json.pkb | 13,116 | 639.103 | 1,553.669 | 655.007 | 1.454 | 1,478.331 | 12.905 | 498.679 | 1,567.096 | 504.491 |
| PACKAGES/las_rep_accountingjournal.pkb | 21,311 | 550.979 | 2,410.534 | 550.255 | 1.974 | 2,319.585 | 16.626 | 277.733 | 2,375.464 | 328.487 |
| PACKAGES/las_uti_reportstore.pkb | 40,848 | 1,865.646 | 9,481.701 | 2,063.345 | 260.863 | 9,385.140 | 319.332 | 1,521.654 | 9,411.294 | 1,669.821 |
| PACKAGES/las_mod_storedreport_data.pkb | 68,924 | 1,511.292 | 12,774.994 | 2,324.858 | 7.026 | 12,604.986 | 711.465 | 633.932 | 13,287.936 | 1,372.301 |
| PACKAGES/las_sub_export_xrechnung.pkb | 127,299 | 2,905.591 | 47,510.282 | 3,060.893 | 14.046 | 46,868.852 | 92.274 | 1,778.506 | 47,118.048 | 1,916.030 |
| PACKAGES/las_sub_ciheader.pkb | 171,264 | 2,963.536 | 26,136.898 | 3,257.102 | 21.211 | 26,079.333 | 143.096 | 1,885.699 | 26,198.976 | 1,780.615 |
| PACKAGES/las_sql_jpos_job.pkb | 370,022 | 2,522.520 | 50,818.181 | 3,952.204 | 1,544.862 | 50,815.186 | 1,840.660 | 2,122.953 | 50,371.382 | 2,592.508 |

## Aggregate

| Language | Cold p50 | Cold p95 | Cold max | Warm p50 | Warm p95 | Warm max | One-pass | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Go | 249.745 | 2,905.591 | 2,963.536 | 0.429 | 260.863 | 1,544.862 | 9,003.584 | 1,431.8 MB |
| Rust | 128.115 | 47,510.282 | 50,818.181 | 106.163 | 46,868.852 | 50,815.186 | 150,591.181 | 85.5 MB |
| TS core | 245.325 | 3,257.102 | 3,952.204 | 2.469 | 711.465 | 1,840.660 | 10,448.687 | 913.2 MB |

| Comparison | Ratio |
| --- | ---: |
| Rust one-pass vs Go | 16.73× slower |
| Rust one-pass vs TypeScript core | 14.41× slower |
| TypeScript core one-pass vs Go | 1.16× slower |

The TypeScript full adapter one-pass total was 10,707.186 ms. Rust is LL-only;
Go and TypeScript use SLL-first. Rust therefore has lower fixed overhead on
small files but collapses on the large-file tail.
