# Oracle production qualification evidence (2026-10-27)

**Status: PASS.** Contract `oracle-o1@4` (truth policy `v5`) passes every gate on
the production corpus. Declarations, reference precision, reference recall, and
package-dependency recall and precision pass. This bundle resolves the
dependency-truth decision owned by
[#101](https://github.com/doberkofler/codeindex-mcp/issues/101).

This is a contract recomputation, not a new Oracle session. The retained source
snapshot and truth exports are unchanged; only the contract and the report were
regenerated. Replaying the retained snapshot is DB-free and reproduces every
number below.

## Identities

| Item | Value |
|---|---|
| Runtime commit | `b926b3e09a012abcef05f9980c0f59342d1f5d48` |
| Evidence commit | `b926b3e09a012abcef05f9980c0f59342d1f5d48` (bundle, replay command, and reconciled documentation) |
| Package | `codeindex-mcp@0.7.0` |
| Node | `v26.10.0` |
| Oracle | 19c Enterprise Edition 19.0.0.0.0, version 19.19.0.0.0 |
| Schema | `LJ_UNITTEST` |
| Parser | `structural@5` with lexer `antlr4ng@3.0.16` |
| Contract | `oracle-o1@4`, truth policy `v5` |
| Contract hash | `ee83f2ece96074969137447c773c42bfc6400261d1ccefd597bd830ed389e95f` |
| Approved plan | `97c796a2f6a3b228e8a5f34af1c0b6c3087a908deba7f2d14a513299cbdf7ce0` |
| Corpus | 1,244 files / 1,244 objects; 1,246 installed, 2 without usable source |
| Source hash | `2bb0da1e8151410432cfe55d30607ed229976b7ccfd974a97027ebeb220f7f2a` |
| Plan/run config hash | `8ba026c038fe53224ab378d0e898589f0da818c4e32a3f98cf6957a493e24065` |
| Report generation config hash | `b51a445cc2c6577116a19fb1614d79411fc8944cc2a161ef1df44a25b399e4ec` |
| Generation | `f7bcf467-8727-42be-bf4b-297b07531591` |
| Truth identifier rows | 931,686 |
| `user-identifiers.csv` SHA-256 | `4a980106361b7a336071a4265be22d512549c56b9af3475f2d7ed9b89ab9bc09` |
| `user-dependencies.csv` SHA-256 | `c6783fb689113c668f7075ffbf358f6f9f8a040bfe26fd1df060e146fd891ce8` |
| Committed report SHA-256 | `57cc9e50d8a878ca07f5c8e156eb7310b10f1d3f2342610cf82a26ff0a1626f1` |
| External raw report SHA-256 | `ba003cee4352f28324cace2249ce5f0b7c0a0a43023107c89f568a7697105dfb` |

The retained plan recompiled 1,244 target objects with
`PLSCOPE_SETTINGS='IDENTIFIERS:ALL'` and 189 dependents; it started with zero
invalid objects and left zero invalid objects. The plan records only
`ALTER SESSION` and `ALTER … COMPILE` statements; it replaces no source. Those
facts come from the retained live run because this bundle does not open a
database.

## Result

| Section | Truth | Actual | Matched | Missing | Extra | Recall | Precision | Gate |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Declarations | 37,170 | 37,151 | 37,151 | 19 | 0 | 99.9489% | 100.0000% | PASS |
| References | 188,287 | 187,665 | 187,665 | 622 | 0 | 99.6697% | 100.0000% | PASS |
| Package dependencies | 5,553 | 5,553 | 5,553 | 0 | 0 | 100.0000% | 100.0000% | **PASS** |

All three gates pass. Dependency truth is 5,553 included edges out of 5,656
exported rows:

```text
dependencies.rawTruth 5,656
  = dependencies.truth 5,553
  + dependencies.excluded 103

dependencies.excluded 103
  = 103 compiler_inferred_dependency
```

No reference or dependency extra of any class was emitted.

Truth denominators reconstruct exactly:

```text
931,686 rows
  = 37,170 included declarations
  + 188,287 included references
  + 706,229 excluded

706,229 excluded
  = 165,684 unsupported_identifier_type
  + 63,270 package_reference
  + 360,973 missing_group_declaration
  + 13,125 declaration_initializer
  + 3,548 duplicate_fact
  + 942 omitted_ambiguous_overload
  + 98,687 ephemeral_declaration
```

The run emitted 944 `ambiguous-overload` diagnostics; 942 truth `CALL` rows sit
at the exact diagnostic position and are omitted with the counted reason. Two
diagnostics describe calls that PL/Scope does not record, so they contribute no
truth row.

## Dependency decision

All 103 omitted rows share one cause: the authored file does not mention the
target package. Oracle recorded the edge because the compiler
expanded a referenced type, default expression, or nested record field whose
definition names that package. A static adapter that only reads authored source
cannot recover it.

The exclusion test is lexical, deterministic, and independent of the adapter:
the authored file is scanned for the target package name delimited by
non-identifier characters, case-insensitively. A mention anywhere in the file,
including a comment or string literal, keeps the edge in the denominator. An
adapter result is never consulted. On this corpus the test partitions truth
exactly:

| Truth edges | Matched | Excluded | Evidence |
|---|---:|---:|---|
| 5,656 | 5,553 | 103 | Every matched edge mentions its target as a whole identifier; none of the 103 excluded edges does |

The issue's earlier estimate of 17 authored edges was a prefix match, not an
authored reference to the target. Examples:

- `LAS_UTI_Report` matched inside the different package name
  `LAS_UTI_ReportStore`.
- `LAS_SQL_JPos` matched inside the different package name `LAS_SQL_JPos_Job`.
- `ODS_SYS_MailQueue` matched inside the table name `ODS_SYS_MailQueueTable`.

A whole-identifier scan finds zero authored references to the 103 targets.
Removing type expansion would require resolving every referenced package type
across the corpus, which is a compiler feature, not an authored-source
extraction. The contract therefore states the narrower, reproducible claim:
dependency recall measures edges the authored source can name.

## Reference strata

| Stratum | Truth | Matched | Missing | Extra |
|---|---:|---:|---:|---:|
| `procedural` | 50,698 | 50,555 | 143 | 0 |
| `static_sql` | 2,201 | 2,152 | 49 | 0 |
| `member_chain` | 135,353 | 134,944 | 409 | 0 |
| `iterator` | 21 | 0 | 21 | 0 |
| `pragma` | 7 | 7 | 0 | 0 |
| `type_anchor` | 7 | 7 | 0 | 0 |

The 622 missing references fall into five classified groups:

| Group | Rows | Reason |
|---|---:|---|
| Routine call in a file with more than 20 ambiguous sites | 475 | The per-file diagnostic bound retains 20 sites; the remaining `CALL` rows stay in the denominator and count as missing, by design (391 member-chain calls, 84 unqualified calls) |
| `SELECT … INTO <record>` field writes | 49 | The target record type or `%ROWTYPE` anchor is not in the corpus, so the field write cannot be named statically |
| Member chain on a function result or collection element | 18 | 17 reads through `f(x).field` or `collection(i).field` need the callee's record type, which is unknown or `%ROWTYPE`; one is a qualified type name in a nested-routine signature |
| Routine-local declaration inside an anonymous block | 59 + 19 | PL/Scope reports the declaration's `USAGE_CONTEXT_ID` as an anonymous block, which has no identifier row, so the ephemeral rule cannot see the enclosing routine |
| Loop iterator inside a routine | 21 | Routine-local iterators are intentionally ephemeral and never published |

The first three groups are bounded by the contract's exact-position and
ambiguity rules; the last two are publication-surface or truth-normalization
limitations recorded for follow-up.

## Replay

Preflight and replay are database-free:

```bash
pnpm build
node dist/cli.mjs oracle-preflight --bundle benchmark/oracle-production-20261027/corpus.json
node dist/cli.mjs oracle-replay --bundle benchmark/oracle-production-20261027/corpus.json
```

Replay reconstructs the live project-context layout because the generation
configuration hash includes the context name. It compares every aggregate
count, ratio, identity, and exclusion count with `qualification.json`, ignoring
only the nondeterministic `generationId` and the bounded disagreement samples.
Samples are retained in the external root but are not committed because they
contain symbol names and workspace paths.

The report was regenerated from the retained snapshot and truth with:

```bash
pnpm build
node dist/cli.mjs qualify --extractor oracle \
  --root <snapshot>/work \
  --project-file <snapshot>/work/qualification/0-oracle-index.json \
  --database <snapshot>/index.sqlite \
  --identifiers <evidence>/user-identifiers.csv \
  --dependencies <evidence>/user-dependencies.csv \
  --units <evidence>/plan.json \
  --output <evidence>/oracle-qualification.json
```

No Oracle session, DDL, or recompilation was performed.

## Contract identity

| Item | Value |
|---|---|
| Parser | `structural@5` |
| Contract | `@4` |
| Policy | `v5` |
| Corpus | Live installed, 1,244 files |
| Declarations | 99.9489% recall / 100% precision |
| References | 99.6697% recall / 100% precision |
| Dependencies | 100% recall / 100% precision |

A report under a different contract hash or dependency denominator is not
comparable with this one. The document
[`documentation/oracle-qualification-contract.md`](../../documentation/oracle-qualification-contract.md)
records the change control.

## Files

- `corpus.json` — descriptor and identities.
- `corpus.sha256` — every frozen source file.
- `units.json` — path/object/source-hash mapping.
- `plscope.sha256` — external plan, run, truth exports, logs, and raw report.
- `qualification.json` — bounded aggregate report; disagreement samples are
  retained only in the external root, so the committed projection has a
  different SHA-256 from the raw report.
