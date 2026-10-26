# Oracle controlled qualification evidence

**Status:** historical PASS for the controlled 10-case corpus, under superseded
contract `oracle-o1@2`. It is retained unchanged and is not the current
contract. The authoritative evidence is
[`benchmark/oracle-production-20261026`](../oracle-production-20261026/README.md).

This bundle binds [`test/fixtures/oracle-qualification-corpus`](../../test/fixtures/oracle-qualification-corpus/README.md)
to contract `oracle-o1@2` and truth policy `v4`.

> **Requalification note (2026-10-26).** A controlled rerun under
> `oracle-o1@3` was attempted and failed. Recompiling the 10 `CIQ_` objects
> succeeded, but the live export selects every `PACKAGE`, `PACKAGE BODY`,
> `FUNCTION`, and `PROCEDURE` row in the schema. `LJ_UNITTEST` now also holds
> the 1,246 production objects, so qualification aborts on the first unmapped
> production object before writing `run.json`. The `CIQ_` objects and table were
> dropped afterwards. A controlled rerun needs an isolated schema or an export
> scoped to the plan's object list; neither is part of this evidence. Preflight
> rejects this bundle under the authoritative contract because its run record
> carries the `oracle-o1@2` identity, so the bundle is retained as historical
> evidence.

| Item | Value |
| --- | --- |
| Contract | `oracle-o1@2` |
| Contract hash | `77c0f1c462a298ded547230e8e85d3bc36dbedb84999160273663d03e62b1913` |
| Truth policy | `v4` |
| Parser | `structural@5` |
| Source files / units | 10 / 10 |
| Declarations | 41/41, 100% recall, 100% precision |
| References | 35/35, 100% recall, 100% precision |
| Dependencies | 7/7, 100% recall, 100% precision |
| Approval hash | `a6f2a5c78f10b5292fa7d3ad6bc8aadd0b93123addc638da7bc9925f31453adb` |
| External root | `${CODEINDEX_EVIDENCE_ROOT:-~/.local/share/codeindex-mcp}/oracle-live/ljs-ciq-20261025` |

## Files

- `corpus.json` — descriptor and identities.
- `corpus.sha256` — every frozen snapshot source file.
- `units.json` — path/object/source-hash mapping.
- `plscope.sha256` — every external artifact, including the plan, run, truth
  exports, compile log, and qualification report.
- `qualification.json` — bounded qualification report. Source text, symbol names,
  credentials, and absolute private paths are not retained here.

## Verify

```bash
pnpm build
node dist/cli.mjs oracle-preflight --bundle benchmark/oracle-controlled/corpus.json
node dist/cli.mjs oracle-replay --bundle benchmark/oracle-controlled/corpus.json
```

Under the authoritative contract both commands exit non-zero: the retained
`run.json` records the superseded `oracle-o1@2` identity and the adapter has
changed since. That rejection is the contract's safeguard against comparing
evidence from different contracts. The report remains reproducible only at the
code revision named by its identities.

Preflight is database-free and exits non-zero on a missing or mismatched
artifact. Replay reconstructs the live project-context layout and compares every
aggregate field with `qualification.json`, ignoring only the nondeterministic
`generationId`. It exits non-zero on any difference.

`units.json` is the committed digest map, not the `--units` input; replay uses
the retained `plan.json` mapping from the external root.

## Scope

This is a controlled substitute frozen after exact recovery of the historical
Phase 0 bundle failed. It proves the contract, parser, publication, exclusions,
and gates on synthetic cases. It does not prove production-corpus recall or
representativeness. ORA-004 completed against a live installed replacement
bundle; its current verdict is the
[2026-10-26 production evidence](../oracle-production-20261026/README.md), where
the reference gates pass and the dependency gate is owned by
[#101](https://github.com/doberkofler/codeindex-mcp/issues/101).
