# Oracle controlled qualification evidence

**Status:** PASS for the controlled 10-case corpus. No production-scale claim.

This bundle binds [`test/fixtures/oracle-qualification-corpus`](../../test/fixtures/oracle-qualification-corpus/README.md)
to contract `oracle-o1@2` and truth policy `v4`.

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
```

Preflight is database-free and exits non-zero on a missing or mismatched
artifact. Replay qualification offline with `qualify --extractor oracle` against
the snapshot, identifiers, dependencies, and the `snapshot.units` mapping in
`<root>/plan.json` (pass it as `--units`; `units.json` is the committed digest
map, not the `--units` input).

## Scope

This is a controlled substitute frozen after exact recovery of the historical
Phase 0 bundle failed. It proves the contract, parser, publication, exclusions,
and gates on synthetic cases. It does not prove production-corpus recall or
representativeness; that remains ORA-004 work against a production replacement
bundle.
