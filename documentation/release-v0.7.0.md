# Release verification: v0.7.0

Status: retained 2026-10-24 for tag `v0.7.0` (`13e5069c6531e2d0df9f5ccc6fc22445cf2616f3`).

The tag release workflow could not run: `.github/workflows/stable.yml` requires the
self-hosted runner labelled `codeindex-reference`, and the repository has no registered
runner. The queued `Release` run was cancelled and the same stable command set was
executed locally on the declared reference profile. Consequently no `stable-evidence-*`
Actions artifact exists for this release; this page is the retained record.

## 1. Profile

| Item | Value |
| --- | --- |
| Machine | Apple M5 Max |
| OS | macOS 27.0.1 |
| Architecture | darwin/arm64 |
| Node | v26.10.0 |
| pnpm | 12.15.0 |
| Source | `v0.7.0`, detached worktree, `pnpm install --frozen-lockfile` |

## 2. Static verification

`pnpm verify:release` — typecheck, Oxlint, Knip, Oxfmt, Vitest, build, and the release
banner check.

- 132 test files, 869 tests passed.
- `Release artifact reports codeindex-mcp 0.7.0`.

## 3. Retained-reference benchmarks

Two large-profile runs over the generated corpus (2,704 files, 28,212 symbols, 35,713
occurrences) with `--iterations 20 --edit-rounds 5`. Run 02 used run 01 as its reference.

| Run | Result |
| --- | --- |
| 01 | 15 pass, 2 warning, 0 failure, 1 skipped |
| 02 | 45 pass, 2 warning, 0 failure, 4 skipped |

Run 02 scenarios:

| Scenario | Wall | P95 / max | RSS peak | Database |
| --- | ---: | ---: | ---: | ---: |
| cold_build | 3,794 ms | — | 1.14 GiB | 301.28 MiB |
| warm_reuse | 222 ms | — | 830.05 MiB | 166.38 MiB |
| warm_rebuild | 4,172 ms | — | 1.39 GiB | 431.75 MiB |
| edit_to_fresh | 33,152 ms | 6,568 ms | 1.69 GiB | 562.88 MiB |
| deep_cursor | 2,024 ms | 6.5 ms | 952.08 MiB | 428.90 MiB |

Run 02 query p95: `status` 0 ms, `find_symbol` 7 ms, `outline` 0 ms, `find_references`
0 ms, `read_symbol` 1 ms.

Warnings, both pre-existing and documented in the
[reference baseline](./reference-baseline.md):

- `absolute.edit.p95` 6,568 ms exceeds the 5 s warning threshold and stays below the 15 s
  failure threshold;
- `hygiene.artifact_consumption` 4 — extraction artifacts are persisted but not consumed.

All relative gates passed against run 01; no deep-cursor sample used a temporary B-tree.

## 4. Operational soak

Small profile (34 files, 374 symbols), 8 rounds, 3 burst edits, 1 injected failure, 1
restart. Verdict: **pass**.

- events 10, p50 889 ms, p95 1,710 ms, max 1,710 ms;
- cold build 365 ms, final freshness current, burst overlap observed, restart reuse 2/2;
- injected failures 1, recovered 1, manual interventions 0, stale-source refusals 1;
- retention bounded: 2 generations, 36/68 content versions, 72/136 artifacts, peak
  database 6,168,576 bytes.

## 5. Deterministic system class

`pnpm test:system` — 5 files, 22 tests passed in 13.39 s, inside the 60 s budget.

## 6. Artifact caveat

EVAL-037 measured artifact `ac846e44cf7c527f9d361ff7ca266e5e2bbdae4d2dd80f9c1e111ac124d4e205`
at program version `0.5.0`. `v0.6.0` was behaviorally equivalent but not byte-identical.
`v0.7.0` contains source changes after `v0.6.0`, so its artifact is neither byte-identical
nor behaviorally equivalent to the measured artifact. No exact-artifact cost claim is made.

## 7. Release

Published: <https://github.com/doberkofler/codeindex-mcp/releases/tag/v0.7.0>.
