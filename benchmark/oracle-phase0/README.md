# Oracle ANTLR Phase 0 Baseline

**Baseline commit:** `f868d3c6e4cef3e5a21369e738409992d40cca62`  
**Parser:** structural production parser  
**Node:** `v26.10.0`  
**Package:** `0.5.0`

The baseline was rebuilt and benchmarked in a clean detached worktree at the
baseline commit. The qualification report is the approved live run executed at
the same commit. The development worktree contains the unwired ANTLR
implementation, so this record does not depend on it.

This directory freezes the Phase 0 evidence for the Oracle ANTLR adoption
decision. Source snapshots and PL/Scope exports are large; they remain outside
the repository. Their identity, per-file checksums, and reconstructed manifest
are checked in here.

## Corpus

| Item | Value |
| --- | --- |
| Repository kind | SVN |
| Revision | `78950` |
| Relative root | `^/ljs_app/trunk/ljs_db/LJS_DB` |
| Default schema | `LJ_UNITTEST` |
| Snapshot files | 1,237 |
| Package specifications | 609 |
| Package bodies | 605 |
| SQL files | 14 |
| Standalone functions | 9 |
| Installed objects | 1,240 |
| Excluded installed objects without usable source | 3 |
| Source hash | `dfae2b41a2595d3e83065b9c5807b596f1b43e7cf8fd634958e89e86cfebf2d7` |
| Config hash (live plan) | `0f790f4865d3929fdb651968b2558d9309ad49d552bd0f93f10119c7ab74f933` |
| Benchmark config hash | `af6fc137d94b1e5a88d963dca0b217d4844ade470aa9714bd7cad0712c7e27d0` |

- `corpus.json` records the frozen manifest, source identity, exclusions, and
  file/unit counts.
- `corpus.sha256` records every source path and SHA-256.
- `units.json` records the explicit path-to-object mapping used by live
  qualification. It is required because source filenames do not always match
  PL/Scope object names.

The external evidence root is
`${CODEINDEX_EVIDENCE_ROOT:-~/.local/share/codeindex-mcp}/oracle-live/2eb1e36f6ecdada4`.
It contains `workspace/`, `plan.json`, `run.json`, and the PL/Scope exports.

**Status 2026-10-25: NOT READY.** That root is absent and exact recovery failed.
The retained descriptor, checksums, and unit map are unchanged; no restoration is
claimed. Verify with
`node dist/cli.mjs oracle-preflight --bundle benchmark/oracle-phase0/corpus.json`.
The recovery record and replacement route are in
[`documentation/oracle-evidence-bundle.md`](../../documentation/oracle-evidence-bundle.md).

The current production verdict does not depend on this corpus. A replacement
bundle frozen from live installed source is retained at
[`benchmark/oracle-production-20261025`](../oracle-production-20261025/README.md);
it is **NOT READY** under contract `oracle-o1@2` and is not a recovery of SVN
revision `78950`.

The broader 1,632-file `.pks`/`.pkb` feasibility corpus has no matching
PL/Scope export. It is not the Phase 0 qualification corpus.

## Truth exports

| Export | SHA-256 | Rows |
| --- | --- | ---: |
| `user-identifiers.csv` | `3161b621ab798b124f84d03b6acf84bdcda45f902b695d16d253616820af7470` | 926,164 |
| `user-dependencies.csv` | `f84ee12ee1111c843876d9c999cbf2ba69facf45575003d014f822c5fc2d446f` | 12,333 |
| `user-source-backup.csv` | `47be9bd85e7fa6682d7b52fd268eea185496e6b6cd42021387476849c720ce7a` | — |

`plscope.sha256` also records the plan, run metadata, compile log, and dependent
log hashes.

## Qualification baseline

`qualification.json` is the frozen report from the approved live run under
historical truth policy `v1`
(`4c82485ae33d80a0c950f0b89a889461ab72092653ee817609eab2cc467b3173`).
The offline replay with `--units` reproduced every count and ratio below; only
the generation identifier changes.

| Metric | Truth | Actual | Matched | Missing | Extra | Recall | Precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Declarations | 123,162 | 121,227 | 121,186 | 1,976 | 41 | 98.3956% | 99.9662% |
| References | 465,511 | 273,993 | 272,420 | 193,091 | 1,573 | 58.5206% | 99.4259% |
| Package dependencies | 5,639 | 5,536 | 5,536 | 103 | 0 | 98.1734% | 100% |

All gates fail. The baseline is therefore a comparison point, not an adoption
decision.

## Benchmark baseline

`benchmark.json` was produced from a detached worktree at the baseline commit.
No generated corpus was used; the external LJS snapshot was measured directly.

| Scenario | Wall | Build | Peak RSS | Storage |
| --- | ---: | ---: | ---: | ---: |
| Cold build | 9,109 ms | 8,884 ms | 2.50 GB | 916 MB |
| Warm reuse | 208 ms | reused | 1.83 GB | 627 MB |
| Warm rebuild | 10,037 ms | 9,829 ms | 2.87 GB | 1.34 GB |
| Deep cursor | 220 ms | — | 1.75 GB | 1.05 GB |

Machine: Apple M5 Max, 64 GB, `darwin/arm64`, Node `v26.10.0`. Index facts:
93,371 symbols, 395,220 occurrences, 78,951 dependency edges.

## Reproduction

Build first:

```bash
pnpm build
```

Replay qualification without an Oracle connection:

```bash
EVIDENCE="${CODEINDEX_EVIDENCE_ROOT:-$HOME/.local/share/codeindex-mcp}/oracle-live/2eb1e36f6ecdada4"
node dist/cli.mjs qualify --extractor oracle \
  --root "$EVIDENCE/workspace" \
  --project-file "$EVIDENCE/workspace/manifests/qualification-index.json" \
  --identifiers "$EVIDENCE/user-identifiers.csv" \
  --dependencies "$EVIDENCE/user-dependencies.csv" \
  --units "$EVIDENCE/plan.json" \
  --truth-policy v1 \
  --output /tmp/oracle-qualification.json
```

The command exits `1` because the baseline does not pass the gates.

Run the benchmark:

```bash
EVIDENCE="${CODEINDEX_EVIDENCE_ROOT:-$HOME/.local/share/codeindex-mcp}/oracle-live/2eb1e36f6ecdada4"
node dist/cli.mjs benchmark \
  --root "$EVIDENCE/workspace" \
  --project-file "$EVIDENCE/workspace/manifests/qualification-index.json" \
  --extractor oracle \
  --output /tmp/oracle-benchmark.json
```

The live workflow that produced the frozen report and exports is:

```bash
pnpm qualify:oracle:live \
  --root /path/to/ljs_db/LJS_DB \
  --manifest /path/to/oracle-index.json \
  --output "$EVIDENCE" \
  --approval 4c82485ae33d80a0c950f0b89a889461ab72092653ee817609eab2cc467b3173
```

It requires the approved Oracle connection and recompiles the installed
objects. It is not an offline check.

## Integrity

| Artifact | SHA-256 |
| --- | --- |
| `corpus.json` | `4ecd2301ca6eb86dfe4f5c05ed9c09829a2caf6c1b7af404f5c7006b900c91c9` |
| `corpus.sha256` | `da65b253ab67079daa86cb8c5e2779171d922cfe60d269a060ec314c511149b5` |
| `units.json` | `3c4d457a4fedda21c7694c859b050ea954a227950fb2e3b6822b294b8975ff0b` |
| `qualification.json` | `c01dba0f0e9cc5ead3b24d9ef19443ed215ed1eb7df3072f0c8912a0d78ac739` |
| `benchmark.json` | `ab8fa091c2822dc0e7d5601f4ba3aba1ae5b7924e8ea3e02d4f17f895322f8c5` |
| `plscope.sha256` | `220eac10beeecce5863ee1a503ac86b99712cedfaeddd7fa7bc32e15d15e427b` |

The checked-in JSON reports are normalized by the repository formatter. The
pre-format hashes are `6d25e4df4a6b501819e475e6654ebfbb1f3771a456a833999cdb1ec678919148`
for `qualification.json` and
`a9e214ff7a90b3aad09dc14ae4c19a16c327e18460fa2612a2e7e801adb7448c` for
`benchmark.json`.

## Exit criteria

- Baseline commit is recorded and was rebuilt in a clean detached worktree.
- Corpus manifest, per-file hashes, unit mapping, and exclusions are frozen.
- PL/Scope exports are frozen by hash and row count.
- Structural qualification and benchmark reports are checked in.
- Qualification and benchmark commands are documented and repeatable.

The grammar-gap fixture set is checked in under
`test/fixtures/oracle-grammar-gaps/`.
