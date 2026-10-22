# Deterministic operational soak: E3 record

Record for the operational soak required by
[strategy §4 E3](../../documentation/mcp-evaluation-strategy.md#e3-operational-soak),
[strategy §8.1.8 G-E3](../../documentation/mcp-evaluation-strategy.md#818-gate-to-check-map),
and [EVAL-025](https://github.com/doberkofler/codeindex-mcp/issues/33).

- Date: 2026-10-22.
- Reference machine: `apple-m5-max-64gb`, Apple M5 Max, 18 CPUs, 64 GiB,
  `darwin/arm64`, Node `v26.10.0`.
- Subject: this commit, built with `pnpm build`; the soak command is
  `codeindex-cli soak`.
- Plan: generated `small` profile, 12 single edits, one 3-edit burst during an
  active build, one injected source-read failure, one clean restart.
- Plan hash: `148eca72600490176b21c96930703d6a7fb6b8d432633405c90db38e1917de29`.
- Edit-script hash: `122f83bc35938bdee575f23bd440982202d74b93349a7a9a751e185047e0225b`.
- Claim class: none. This is operational reliability evidence only; it is not
  E1 or E2 evidence and is never pooled with agent-task latency.

## Command

```bash
pnpm build
node dist/cli.mjs soak --profile small --rounds 12 --burst-edits 3 \
  --failures 1 --restarts 1 --output benchmark/results/soak.json
```

The command generated a disposable corpus, drove real files through the real
watcher and build worker, injected one source-read failure, restarted the index,
and removed the workspace and database after writing the report. It started no
model and performed no agent task.

## Reproducibility

Three consecutive runs produced the same plan hash and edit-script hash. Every
observed edit across all runs changed the file hash; the report records both
hashes before and after each write.

| Run | Plan hash | Edit hash | p50 | p95 | Cold build |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | `148eca72…` | `122f83bc…` | 876 ms | 1720 ms | 361 ms |
| 2 | `148eca72…` | `122f83bc…` | 876 ms | 1721 ms | 364 ms |
| 3 | `148eca72…` | `122f83bc…` | 876 ms | 1731 ms | 353 ms |

The 500 ms debounce dominates single-edit latency. The p95 sample is the burst
event, which includes the follow-up build after an edit arrived during the first
build.

## Freshness and during-build edits

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Events measured | 14 | 14 | 14 |
| Single-edit event-to-fresh p50 | 876 ms | 876 ms | 876 ms |
| Burst event-to-fresh | 1720 ms | 1721 ms | 1731 ms |
| Burst observed during active build | yes | yes | yes |
| Burst edits | 3 | 3 | 3 |
| Stale-source refusal | `stale_file` | `stale_file` | `stale_file` |
| Stale probe event-to-fresh | 877 ms | 857 ms | 925 ms |

The burst edit that arrived after the compiler read the file produced a closed
`source-changed` build failure. The refresh coordinator scheduled one debounced
follow-up from the pending event, so the index recovered without another edit or
an operator command. This is the required behaviour for repeated edits during a
build, and it is covered by
`test/refreshCoordinator.test.ts`.

## Build failures by closed cause

The soak records every observed build failure, not only the injected one. Both
causes are members of the closed `BUILD_FAILURE_CAUSES` set and are also written
to the `build_failed` analytics event.

| Cause | Runs | Injected | Recovered |
| --- | ---: | --- | --- |
| `source-changed` | 3 | no | automatic follow-up |
| `source-read` | 3 | yes | automatic watcher rebuild |

The injected source-read failure replaced one source file with a directory. The
published generation remained queryable while the build was failed, the command
restored the file, and the watcher published a fresh generation without a
manual rebuild. Recovery took 1211 ms, 1203 ms, and 1209 ms. No manual
intervention was recorded.

## Restart and generation reuse

Each run closed the index, reopened the same database, and called the normal
readiness path. Every restart reused the same published generation rather than
rebuilding it.

| Run | Reused | Same generation | Restart duration |
| --- | --- | --- | ---: |
| 1 | yes | yes | 159 ms |
| 2 | yes | yes | 164 ms |
| 3 | yes | yes | 163 ms |

## Resources and retention

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Peak RSS | 497,860,608 B | 499,990,528 B | 499,974,144 B |
| CPU user time | 11,175 ms | 11,195 ms | 11,144 ms |
| CPU system time | 687 ms | 694 ms | 685 ms |
| Peak database bytes | 5,799,936 | 5,820,416 | 5,791,744 |
| Max generations | 2 | 2 | 2 |
| Max content versions | 37 / 68 | 37 / 68 | 37 / 68 |
| Max extraction artifacts | 74 / 136 | 74 / 136 | 74 / 136 |

The declared policy is one published generation plus one superseded generation.
Content versions and extraction artifacts cascade from retained content, so the
observed counts stay inside the declared bounds and the database page count
stabilizes after the first publish. Database bytes are reported as directional
evidence; the gate is the row-count bound, not an arbitrary byte threshold.

## Gates

| Gate | Result | Detail |
| --- | --- | --- |
| `soak.edit-script-deterministic` | PASS | every edit changed file content |
| `soak.event-to-fresh` | PASS | 14 events measured in every run |
| `soak.edits-during-build` | PASS | burst overlap observed in every run |
| `soak.stale-refusal` | PASS | `read_symbol` returned `stale_file` |
| `soak.failure-cause-closed` | PASS | `source-changed`, `source-read` |
| `soak.recovery-unattended` | PASS | 1/1 injected failure recovered, 0 interventions |
| `soak.restart-reuse` | PASS | 1/1 restart reused the same generation |
| `soak.retention-policy` | PASS | generations 2/2, content 37/68, artifacts 74/136 |
| `soak.publication-preserved` | PASS | failed build kept the published generation |

## Acceptance mapping

| Criterion | Status |
| --- | --- |
| Every event changes content and the run is reproducible | Plan and edit-script hashes are stable across three runs; every write records a changed hash |
| Failure causes use the closed set and remain queryable | `BUILD_FAILURE_CAUSES` is enforced by type and by `analytics summary`; the soak records every cause with its recovery |
| Resource growth is bounded by the declared retention policy | Two-generation bound observed on every run; content and artifact maxima stay below the declared ceiling |
| No manual intervention is required for recovery | Both the burst-induced and injected failures recovered from watcher/follow-up builds with zero operator actions |

## Sanitization and claim boundary

The committed record contains aggregate counts, durations, hashes, and the
closed causes. It contains no source text, prompts, model output, absolute
paths, hostname, or operator identity. Raw reports and generated workspaces stay
outside Git under `benchmark/results/`.

This evidence measures watcher, build, freshness, restart, retention, and
recovery behaviour only. It does not measure agent correctness, model claims,
or any non-TypeScript adapter, and its latency values are not comparable with
agent-task latency.
